import { serialQueueAdmission } from "./serial-queue";
import type { ProviderControlValidator } from "./types";

export const validateAntigravityControl: ProviderControlValidator = (request, context) => {
  if (
    request.legacyCodex ||
    context.executionMode !== "acp-managed" ||
    !context.verifiedSerialQueue
  )
    return { available: false };
  return serialQueueAdmission(request.operation) ?? { available: false };
};
