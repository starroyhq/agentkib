import { serialQueueAdmission } from "./serial-queue";
import { validateProviderSettings } from "./settings";
import type { ProviderControlValidator } from "./types";

/** These settings apply to a whole turn. */
export const DEVIN_PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"] as const;

export const validateDevinControl: ProviderControlValidator = (request, context) => {
  const { operation, legacyCodex, settings } = request;
  if (legacyCodex || context.executionMode !== "devin-print") return { available: false };

  const queued = context.verifiedSerialQueue ? serialQueueAdmission(operation) : undefined;
  if (queued) return queued;

  return {
    available:
      operation === "settings" ||
      // Devin's permission requests over ACP, answered while its turn waits.
      operation === "approve" ||
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
