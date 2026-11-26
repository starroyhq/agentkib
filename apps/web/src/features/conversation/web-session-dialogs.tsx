import { agentName } from "@agentkib/agent-identity";
import { SessionDialogs as SharedSessionDialogs } from "@agentkib/session-ui";
import { useSession } from "./web-session-context";

export function SessionDialogs() {
  return <SharedSessionDialogs session={useSession()} agentName={agentName} />;
}
