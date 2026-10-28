import type { SessionAction } from "@agentkib/web-client";

export function blockedWhileCompacting(action: SessionAction) {
  return (
    action === "steer" ||
    action === "compact" ||
    action === "delete" ||
    action === "settings" ||
    action === "resume" ||
    action === "queue-start" ||
    action === "queue-resume" ||
    action.startsWith("goal-")
  );
}
