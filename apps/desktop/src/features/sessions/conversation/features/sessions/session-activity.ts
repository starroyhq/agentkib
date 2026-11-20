import { isSessionSettingsAction, type SessionAction } from "@agentkib/web-client";

export function blockedWhileCompacting(action: SessionAction) {
  return (
    action === "steer" ||
    action === "compact" ||
    action === "delete" ||
    isSessionSettingsAction(action) ||
    action === "resume" ||
    action === "queue-start" ||
    action === "queue-resume" ||
    action.startsWith("goal-")
  );
}
