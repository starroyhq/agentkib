import { claudeModelOption } from "@agentkib/runtime-protocol";
import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

export const validateClaudeControl: ProviderControlValidator = (request, context) => {
  const { operation, legacyCodex, settings } = request;
  if (legacyCodex) return { available: false };

  if (context.executionMode === "claude-follower") {
    // A connected terminal accepts inbox operations and can open its own model selector.
    if (operation === "open-model-picker")
      return {
        available: context.verifiedClaudeManaged,
        publicReceipt: true,
        idleExecutionMode: "claude-follower",
      };
    if (operation === "queue-delete")
      return { available: true, publicReceipt: true, queueItem: "pending-or-unknown" };
    const sendingToInbox = operation === "steer" || operation === "queue-add";
    return { available: sendingToInbox, publicReceipt: sendingToInbox };
  }
  if (context.executionMode !== "claude-managed" || operation === "open-model-picker")
    return { available: false };

  return {
    available: true,
    publicReceipt: true,
    inputFormat: "claude",
    ...(operation === "queue-steer" ? { requiresSend: true } : {}),
    ...(["queue-update", "queue-delete", "queue-steer"].includes(operation)
      ? { queueItem: "pending" }
      : {}),
    ...(operation === "settings" && settings
      ? {
          settings: validateProviderSettings(
            settings.body,
            settings.state,
            {
              clearEffort: true,
              resolvedModel: true,
              permissionModes: ["default", "plan", "acceptEdits"],
              matchModel: (name, models) =>
                claudeModelOption(
                  models.flatMap((model) => (model.id ? [{ ...model, value: model.id }] : [])),
                  name,
                )?.value ?? name,
            },
            context.requireFullAccess,
          ),
        }
      : {}),
  };
};
