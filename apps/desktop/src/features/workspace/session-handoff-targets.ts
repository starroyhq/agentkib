import { AGENT_KINDS, AGENT_LABELS } from "@/core/agents";
import type { AgentKind } from "@/core/types";

export const sessionHandoffTargets: Array<[AgentKind, string]> = AGENT_KINDS.map((agent) => [
  agent,
  AGENT_LABELS[agent],
]);
