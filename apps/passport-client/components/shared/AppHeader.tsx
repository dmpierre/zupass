import { useCallback, useContext } from "react";
import styled from "styled-components";
import { DispatchContext } from "../../src/dispatch";
import { ZuState } from "../../src/state";
import { CircleButton } from "../core/Button";
import { icons } from "../icons";

export function AppHeader() {
  const [_, dispatch] = useContext(DispatchContext);
  const setModal = useCallback(
    (modal: ZuState["modal"]) =>
      dispatch({
        type: "set-modal",
        modal,
      }),
    [dispatch]
  );
  const openInfo = useCallback(() => setModal("info"), [setModal]);
  const openSettings = useCallback(() => setModal("settings"), [setModal]);

  return (
    <AppHeaderWrap>
      <CircleButton diameter={34} padding={8} onClick={openInfo}>
        <img src={icons.infoAccent} width={34} height={34} />
      </CircleButton>
      <CircleButton diameter={34} padding={8} onClick={openSettings}>
        <img src={icons.settingsAccent} width={34} height={34} />
      </CircleButton>
    </AppHeaderWrap>
  );
}

const AppHeaderWrap = styled.div`
  width: 100%;
  padding: 0;
  display: flex;
  justify-content: space-between;
`;
