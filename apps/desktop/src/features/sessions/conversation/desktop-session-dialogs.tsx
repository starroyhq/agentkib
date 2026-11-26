import { agentName } from "@agentkib/agent-identity";
import { SessionDialogs as SharedSessionDialogs } from "@agentkib/session-ui";
import { useSession } from "./desktop-session-context";

export function SessionDialogs() {
  return <SharedSessionDialogs session={useSession()} agentName={agentName} />;
}
