import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

const FOLLOWER_OPERATIONS = [
  "steer",
  "queue-add",
  "queue-update",
  "queue-delete",
  "queue-steer",
  "rename",
  "archive",
  "unarchive",
  "fork",
  "settings",
  "goal-set",
  "goal-pause",
  "goal-resume",
  "goal-clear",
  "compact",
];

export const validateDeepSeekHarnessControl: ProviderControlValidator = (request, context) => {
  const { operation, legacyCodex, settings } = request;
  if (
    legacyCodex ||
    context.executionMode !== "dsh-follower" ||
    !FOLLOWER_OPERATIONS.includes(operation)
  )
    return { available: false };

  return {
    available: true,
    publicReceipt: true,
    inputFormat: "dsh",
    // Editing a queued entry leaves it as a message.
    useCommandAccess: operation === "steer" || operation === "queue-add",
    ...(operation === "queue-steer" ? { requiresSend: true } : {}),
    ...(["queue-update", "queue-delete", "queue-steer"].includes(operation)
      ? { queueItem: "pending" }
      : {}),
    ...(operation === "settings" && settings
      ? {
          settings: validateProviderSettings(
            settings.body,
            settings.state,
            {},
            context.requireFullAccess,
          ),
        }
      : {}),
  };
};
