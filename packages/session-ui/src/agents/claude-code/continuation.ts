import type { SessionContinuationRegistration } from "../session-continuation";

export const claudeContinuation: SessionContinuationRegistration = {
  busyActor: "Claude Code",
  refreshOccupancy: true,
  forkEntry: true,
  loadResumeCommand: (client, sessionId, signal) => client.claudeResumeCommand(sessionId, signal),
};
