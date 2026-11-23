import { sessionAgentCopy } from "../../conversation/sessions/session-agent-copy";
import type { QueuePanelDescriptor } from "../session-queue";

export const claudeCodeQueuePanel = {
  connection: "terminal-bridge",
  surface: "operations",
  serial: false,
  pendingWithoutStatus: false,
  legacyRead: "features",
  runningSteer: true,
  title: (locale) => sessionAgentCopy[locale].queue,
} as const satisfies QueuePanelDescriptor;
