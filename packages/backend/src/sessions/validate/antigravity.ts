import { serialQueueAdmission } from "./serial-queue";
import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

/** Antigravity's own session modes; `auto` also runs commands it judges safe. */
export const ANTIGRAVITY_PERMISSION_MODES = ["default", "accept-edits", "auto", "plan"] as const;

export const validateAntigravityControl: ProviderControlValidator = (request, context) => {
  const { operation, legacyCodex, settings } = request;
  if (legacyCodex || context.executionMode !== "acp-managed") return { available: false };
  // A session's model, thought level and mode are its own ACP options, set between turns.
  if (operation === "settings")
    return {
      available: true,
      ...(settings
        ? {
            settings: validateProviderSettings(
              settings.body,
              settings.state,
              {
                clearEffort: false,
                clearServiceTier: true,
                permissionModes: ANTIGRAVITY_PERMISSION_MODES,
                fullAccessPermissionModes: ["auto"],
              },
              context.requireFullAccess,
            ),
          }
        : {}),
    };
  if (!context.verifiedSerialQueue) return { available: false };
  return serialQueueAdmission(operation) ?? { available: false };
};
