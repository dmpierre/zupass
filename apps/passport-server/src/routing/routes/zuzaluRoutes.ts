import {
  LoadE2EERequest,
  LoadE2EEResponse,
  SaveE2EERequest,
  ZuParticipant,
} from "@pcd/passport-interface";
import { serializeSemaphoreGroup } from "@pcd/semaphore-group-pcd";
import express, { NextFunction, Request, Response } from "express";
import { PoolClient } from "pg";
import { ParticipantRole } from "../../database/models";
import {
  getEncryptedStorage,
  setEncryptedStorage,
} from "../../database/queries/e2ee";
import { fetchPretixParticipant } from "../../database/queries/fetchParticipant";
import { fetchStatus } from "../../database/queries/fetchStatus";
import { insertParticipant } from "../../database/queries/insertParticipant";
import { saveCommitment } from "../../database/queries/saveCommitment";
import { setParticipantToken } from "../../database/queries/setParticipantToken";
import { semaphoreService } from "../../services/semaphore";
import { ApplicationContext } from "../../types";
import { sendEmail } from "../../util/email";
import { normalizeEmail } from "../../util/util";

// API for Passport setup, Zuzalu IDs, and semaphore groups.
export function initZuzaluRoutes(
  app: express.Application,
  context: ApplicationContext
): void {
  console.log("[INIT] Initializing zuzalu routes");
  const { dbPool } = context;

  // Check that email is on the list. Send email with the login code, allowing
  // them to create their passport.
  app.post("/zuzalu/send-login-email", async (req: Request, res: Response) => {
    const email = normalizeEmail(decodeString(req.query.email, "email"));
    const commitment = decodeString(req.query.commitment, "commitment");
    const force = decodeString(req.query.force, "force") === "true";

    console.log(
      `[ZUID] send-login-email ${JSON.stringify({ email, commitment, force })}`
    );

    // Generate a 6-digit random token.
    const token = (((1 + Math.random()) * 1e6) | 0).toString().substring(1);
    if (token.length !== 6) throw new Error("Unreachable");

    // Save the token. This lets the user prove access to their email later.
    const devBypassEmail =
      process.env.BYPASS_EMAIL_REGISTRATION === "true" &&
      process.env.NODE_ENV !== "production";
    if (devBypassEmail) {
      await insertParticipant(dbPool, {
        email: email,
        email_token: "",
        name: "Test User",
        order_id: "",
        residence: "atlantis",
        role: ParticipantRole.Resident,
      });
    }

    const participant = await setParticipantToken(dbPool, { email, token });

    if (participant == null) {
      throw new Error(`${email} doesn't have a ticket.`);
    } else if (
      participant.commitment != null &&
      participant.commitment !== commitment &&
      !force
    ) {
      throw new Error(`${email} already registered.`);
    }
    const stat = participant.commitment == null ? "NEW" : "EXISTING";
    console.log(
      `Saved login token for ${stat} email=${email} commitment=${commitment}`
    );

    // Send an email with the login token.
    if (devBypassEmail) {
      console.log("[DEV] Bypassing email, returning token");
      res.json({ token });
    } else {
      const { name } = participant;
      console.log(
        `[ZUID] Sending token=${token} to email=${email} name=${name}`
      );
      await sendEmail(context, email, name, token);
      res.sendStatus(200);
    }
  });

  // Check the token (sent to user's email), add a new participant.
  app.get(
    "/zuzalu/new-participant",
    async (req: Request, res: Response, next: NextFunction) => {
      let dbClient = undefined as PoolClient | undefined;
      try {
        const token = decodeString(req.query.token, "token");
        const email = normalizeEmail(decodeString(req.query.email, "email"));
        const commitment = decodeString(req.query.commitment, "commitment");
        console.log(
          `[ZUID] new-participant ${JSON.stringify({
            token,
            email,
            commitment,
          })}`
        );

        // Look up participant record from Pretix
        dbClient = await dbPool.connect();
        const pretix = await fetchPretixParticipant(dbClient, { email });
        if (pretix == null) {
          throw new Error(`Ticket for ${email} not found`);
        } else if (pretix.email_token !== token) {
          throw new Error(
            `Wrong token. If you got more than one email, use the latest one.`
          );
        } else if (pretix.email !== email) {
          throw new Error(`Email mismatch.`);
        }

        // Save commitment to DB.
        console.log(`[ZUID] Saving new commitment: ${commitment}`);
        const uuid = await saveCommitment(dbClient, {
          email,
          commitment,
        });

        // Reload Merkle trees
        await semaphoreService.reload();
        const participant = semaphoreService.getParticipant(uuid);
        if (participant == null) {
          throw new Error(`${uuid} not found`);
        } else if (participant.commitment !== commitment) {
          throw new Error(`Commitment mismatch`);
        }

        // Return participant, including UUID, back to Passport
        const zuParticipant = participant as ZuParticipant;
        const jsonP = JSON.stringify(zuParticipant);
        console.log(`[ZUID] Added new Zuzalu participant: ${jsonP}`);

        res.json(zuParticipant);
      } catch (e: any) {
        e.message = "Can't add Zuzalu Passport: " + e.message;
        next(e);
      } finally {
        if (dbClient != null) dbClient.release();
      }
    }
  );

  // Fetch service status.
  app.get("/zuzalu/status", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const db = await fetchStatus(dbPool);
    const db_pool = {
      total: dbPool.totalCount,
      idle: dbPool.idleCount,
      waiting: dbPool.waitingCount,
    };
    const semaphore = {
      n_participants: semaphoreService.groupParticipants().members.length,
      n_residents: semaphoreService.groupResidents().members.length,
      n_visitors: semaphoreService.groupVisitors().members.length,
    };
    const time = new Date().toISOString();

    const status = { time, db, db_pool, semaphore };

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(status, null, 2));
  });

  // Fetch a specific participant, given their public semaphore commitment.
  app.get("/zuzalu/participant/:uuid", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const uuid = req.params.uuid;
    console.log(`[ZUID] Fetching participant ${uuid}`);
    const participant = semaphoreService.getParticipant(uuid);
    if (!participant) res.status(404);
    res.json(participant || null);
  });

  // Fetch a semaphore group.
  app.get("/semaphore/:id", async (req: Request, res: Response) => {
    const semaphoreId = decodeString(req.params.id, "id");

    const namedGroup = semaphoreService.getNamedGroup(semaphoreId);
    if (namedGroup == null) {
      res.sendStatus(404);
      res.json(`Missing semaphore group ${semaphoreId}`);
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(serializeSemaphoreGroup(namedGroup.group, namedGroup.name));
  });

  app.get(
    "/semaphore/historic/:id/:root",
    async (req: Request, res: Response) => {
      const id = decodeString(req.params.id, "id");
      const root = decodeString(req.params.root, "root");

      const historicGroup = await semaphoreService.getHistoricSemaphoreGroup(
        id,
        root
      );

      if (historicGroup === undefined) {
        res.status(404);
        res.send("not found");
        return;
      }

      res.json(JSON.parse(historicGroup.serializedGroup));
    }
  );

  app.get("/semaphore/latest-root/:id", async (req: Request, res: Response) => {
    const id = decodeString(req.params.id, "id");

    const latestGroups = await semaphoreService.getLatestSemaphoreGroups();
    const matchingGroup = latestGroups.find((g) => g.groupId.toString() === id);

    if (matchingGroup === undefined) {
      res.status(404).send("not found");
      return;
    }

    res.json(matchingGroup.rootHash);
  });

  // Load E2EE storage for a given user.
  app.post(
    "/sync/load/",
    async (req: Request, res: Response, next: NextFunction) => {
      const request = req.body as LoadE2EERequest;

      if (request.blobKey === undefined) {
        throw new Error("Can't load e2ee: missing blobKey");
      }

      console.log(`[E2EE] Loading ${request.blobKey}`);

      try {
        const storageModel = await getEncryptedStorage(
          context,
          request.blobKey
        );

        if (!storageModel) {
          console.log(
            `can't load e2ee: never saved sync key ${request.blobKey}`
          );
          res.sendStatus(404);
          return;
        }

        const result: LoadE2EEResponse = {
          encryptedStorage: JSON.parse(storageModel.encrypted_blob),
        };

        res.json(result);
      } catch (e) {
        console.log(e);
        next(e);
      }
    }
  );

  app.post(
    "/sync/save",
    async (req: Request, res: Response, next: NextFunction) => {
      const request = req.body as SaveE2EERequest;
      console.log(`[E2EE] Saving ${request.blobKey}`);

      try {
        await setEncryptedStorage(
          context,
          request.blobKey,
          request.encryptedBlob
        );

        res.send("ok");
      } catch (e) {
        next(e);
      }
    }
  );
}

function decodeString(
  s: any,
  name: string,
  predicate?: (s: string) => boolean
): string {
  if (s == null) {
    throw new Error(`Missing ${name}`);
  }
  if (typeof s !== "string" || (predicate && !predicate(s))) {
    throw new Error(`Invalid ${name}`);
  }
  return decodeURIComponent(s);
}
