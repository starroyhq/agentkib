import type { Live } from "@agentkib/web-client";
import type { SessionTurnControlRegistration } from "../session-turn-controls";

/** Older hosts identify a terminal follower by mode, including when its bridge disconnects. */
export function isLegacyClaudeFollower(live: Live): boolean {
  return live.executionMode === "claude-follower";
}

export const claudeTurnControls: SessionTurnControlRegistration = {
  allowsSendStatus: (live) => live.status === "released",
  stopRequiresCapability: (live) => live.execution?.owner === "terminal",
};
