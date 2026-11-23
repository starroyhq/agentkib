import type { QueuePanelDescriptor } from "../session-queue";

/** The Harness queue sits above the composer and offers per-message steering. */
export const deepSeekHarnessQueuePanel = {
  connection: "plugin-bridge",
  match: "steer",
  surface: "managed",
  serial: false,
  pendingWithoutStatus: true,
  runningSteer: true,
} as const satisfies QueuePanelDescriptor;
