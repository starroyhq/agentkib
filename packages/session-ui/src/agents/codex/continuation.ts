import type { SessionContinuationRegistration } from "../session-continuation";

export const codexContinuation: SessionContinuationRegistration = {
  busyActor: "Codex",
  refreshOccupancy: true,
  forkEntry: true,
  loadResumeCommand: (client, sessionId, signal) => client.codexResumeCommand(sessionId, signal),
};
