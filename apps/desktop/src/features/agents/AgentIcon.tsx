import { AgentMark } from "@agentkib/agent-identity";
import type { AgentKind } from "@/core/types";

export function AgentIcon({ agent, compact = false }: { agent: AgentKind; compact?: boolean }) {
  return (
    <div className={compact ? "grid size-5 place-items-center overflow-hidden" : "grid size-9 place-items-center overflow-hidden"} aria-hidden="true">
      <AgentMark agent={agent} size={compact ? 16 : 32} />
    </div>
  );
}
