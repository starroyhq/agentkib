import type { Live } from "@agentkib/web-client";
export { claudeTerminalPermission } from "./agents/claude-code/permission-observation";

export function claudeTerminalInteraction(live: Live | null | undefined, sessionId: string) {
  if (live?.sessionId !== sessionId || live.executionMode !== "claude-follower") return;
  if (live.reason === "claude-terminal-approval" && live.status === "awaiting-approval")
    return "approval";
  if (live.reason === "claude-terminal-question" && live.status === "waiting-input")
    return "question";
}
