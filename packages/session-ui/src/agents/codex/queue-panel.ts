import type { QueuePanelDescriptor } from "../session-queue";

export const codexQueuePanel = {
  connection: "native-app",
  surface: "operations",
  serial: false,
  pendingWithoutStatus: true,
  legacyRead: "approved",
  runningSteer: true,
  // Codex starts queued messages automatically. The old host still advertises queue-start.
  automatic: true,
} as const satisfies QueuePanelDescriptor;
