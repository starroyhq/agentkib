import { agentName } from "@agentkib/agent-identity";
import { SessionInteractionDock as SharedSessionInteractionDock } from "@agentkib/session-ui";
import { codexReason } from "../sessions/codex-copy";
import { useSession } from "../sessions/session-context";

export function SessionInteractionDock() {
  const session = useSession();
  return (
    <SharedSessionInteractionDock
      session={session}
      agent={agentName(session.current?.agent)}
      explainReason={(reason) => codexReason(session.locale, reason).text}
    />
  );
}
