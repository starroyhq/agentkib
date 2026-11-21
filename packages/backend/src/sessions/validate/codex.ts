import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

export const validateCodexControl: ProviderControlValidator = (request, context) => {
  const { operation, settings } = request;
  const follower = context.executionMode === "codex-follower";
  if (
    operation === "open-model-picker" ||
    (context.executionMode !== "codex-managed" &&
      !(follower && (operation === "fork" || operation === "settings")))
  )
    return { available: false };

  return {
    available: true,
    inputFormat: "codex",
    ...(operation === "queue-update" || operation === "queue-steer"
      ? { queueItem: "pending" }
      : {}),
    ...(operation === "settings" && settings
      ? {
          settings: validateProviderSettings(
            settings.body,
            settings.state,
            follower
              ? { requireWriteScope: true }
              : { clearEffort: true, clearMode: true, clearServiceTier: true },
            context.requireFullAccess,
          ),
        }
      : {}),
  };
};
