import {
  SessionComposerControls,
  SessionComposer as SharedSessionComposer,
  SessionContextUsageGauge,
  type SessionComposerProps,
} from "@agentkib/session-ui";
import { ManagedTurnNotice } from "./desktop-session-display";
import { useSession } from "./desktop-session-context";
import { sessionDisplayState } from "./desktop-session-display";
import { useSessionPanels } from "@agentkib/session-ui";

export function SessionComposer({
  connectionStatusInBanner,
  connectionNoticeInToolbar,
}: Pick<SessionComposerProps, "connectionStatusInBanner" | "connectionNoticeInToolbar">) {
  const session = useSession();
  const panels = useSessionPanels();
  return (
    <SharedSessionComposer
      session={session}
      panels={panels}
      display={sessionDisplayState(session, "desktop")}
      connectionStatusInBanner={connectionStatusInBanner}
      connectionNoticeInToolbar={connectionNoticeInToolbar}
      Controls={SessionComposerControls}
      ContextUsage={SessionContextUsageGauge}
      TurnNotice={ManagedTurnNotice}
    />
  );
}
