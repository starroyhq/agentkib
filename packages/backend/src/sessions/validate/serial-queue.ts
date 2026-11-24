import type { ProviderValidation } from "./types";

const TEXT_QUEUE_OPERATIONS = [
  "queue-add",
  "queue-update",
  "queue-delete",
  "queue-reorder",
  "queue-pause",
  "queue-resume",
];

export function serialQueueMode(mode: unknown): boolean {
  return ["devin-print", "acp-managed", "antigravity-acp-managed"].includes(String(mode));
}

export function serialQueueRequiresSend(operation: string): boolean {
  return ["queue-add", "queue-update", "queue-resume"].includes(operation);
}

export function serialQueueAdmission(operation: string): ProviderValidation | undefined {
  if (!TEXT_QUEUE_OPERATIONS.includes(operation)) return;
  return {
    available: true,
    publicReceipt: true,
    textOnlyQueue: true,
    requiresSend: serialQueueRequiresSend(operation),
    ...(operation === "queue-delete"
      ? { queueItem: "pending-or-unknown" }
      : operation === "queue-update"
        ? { queueItem: "pending" }
        : {}),
  };
}
