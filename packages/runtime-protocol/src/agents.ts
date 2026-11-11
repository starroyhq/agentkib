/**
 * Agents AgentKib starts and controls through the host's managed APIs: create a session, send,
 * approve, answer and stop. Views and host checks that concern managed sessions read this list,
 * and maps keyed by `ManagedAgent` stop compiling until they cover an Agent added here. Each
 * Agent still needs its own host adapter; see docs/development/adding-an-agent.md.
 */
export const MANAGED_AGENTS = ["codex", "claude-code", "deepseek-harness"] as const;
export type ManagedAgent = (typeof MANAGED_AGENTS)[number];

/** The managed Agent named by `agent`, or null for an Agent AgentKib only reads. */
export function managedAgentOf(agent: unknown): ManagedAgent | null {
  return typeof agent === "string" && (MANAGED_AGENTS as readonly string[]).includes(agent)
    ? (agent as ManagedAgent)
    : null;
}

/**
 * Agents whose sessions AgentKib opens live, following their turns and offering a composer: the
 * managed ones, and Antigravity, which it continues through ACP.
 */
export const LIVE_SESSION_AGENTS: readonly string[] = [...MANAGED_AGENTS, "antigravity"];

export function isLiveSessionAgent(agent: unknown): boolean {
  return typeof agent === "string" && LIVE_SESSION_AGENTS.includes(agent);
}
