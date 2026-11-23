import type { Live } from "@agentkib/web-client";

export function nativeAppControlsSession(live: Live | undefined, sessionId: string): boolean {
  if (live?.sessionId !== sessionId) return false;
  return live.execution
    ? live.execution.owner === "native-app"
    : live.executionMode === "codex-follower";
}
