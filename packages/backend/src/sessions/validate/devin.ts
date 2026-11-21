import { serialQueueAdmission } from "./serial-queue";
import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

/** These settings apply to the entire non-interactive print turn. */
export const DEVIN_PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"] as const;

export const validateDevinControl: ProviderControlValidator = (request, context) => {
  const { operation, legacyCodex, settings } = request;
  if (legacyCodex || context.executionMode !== "devin-print") return { available: false };

  const queued = context.verifiedSerialQueue ? serialQueueAdmission(operation) : undefined;
  if (queued) return queued;

  return {
    available:
      operation === "settings" ||
      operation === "usage-limit-cancel" ||
      operation === "usage-limit-continue",
    ...(operation === "settings" && settings
      ? {
          settings: validateProviderSettings(
            settings.body,
            settings.state,
            {
              clearEffort: true,
              clearServiceTier: true,
              permissionModes: DEVIN_PERMISSION_MODES,
              fullAccessPermissionModes: ["smart", "dangerous"],
            },
            context.requireFullAccess,
          ),
        }
      : {}),
  };
};
