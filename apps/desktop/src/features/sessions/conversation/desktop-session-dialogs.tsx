import { agentName } from "@agentkib/agent-identity";
import { SessionDialogs as SharedSessionDialogs } from "@agentkib/session-ui";
import { Dialog } from "./components/dialog";
import { useSession } from "./desktop-session-context";

export function SessionDialogs() {
  return <SharedSessionDialogs session={useSession()} Dialog={Dialog} agentName={agentName} />;
}
