import {
  CodexComposerControls,
  SessionComposer as SharedSessionComposer,
  SessionContextUsageGauge,
  type SessionComposerProps,
} from "@agentkib/session-ui";
import { ManagedTurnNotice } from "./features/sessions/managed-turn-notice";
import { useSession } from "./features/sessions/session-context";
import { sessionDisplayState } from "./features/sessions/session-display-state";
import { useSessionPanels } from "./features/sessions/session-panels";

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
      display={sessionDisplayState(session, "web")}
      connectionStatusInBanner={connectionStatusInBanner}
      connectionNoticeInToolbar={connectionNoticeInToolbar}
      Controls={CodexComposerControls}
      ContextUsage={SessionContextUsageGauge}
      TurnNotice={ManagedTurnNotice}
    />
  );
}
