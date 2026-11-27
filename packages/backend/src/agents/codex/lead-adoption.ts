import { REMOTE_ERROR_CODES, parseRemoteErrorCode } from "@agentkib/runtime-protocol";
import { codexWriterBusy } from "./codex-app-server";

export type CodexLeadReadiness = {
  canDesignate: boolean;
  toolsReady: boolean;
  requiresAdoption: boolean;
  workspaceId?: string;
  reason?: ReturnType<typeof codexLeadAdoptionReason>;
};

export function codexLeadAdoptionReason(error: unknown) {
  if (codexWriterBusy(error)) return REMOTE_ERROR_CODES.codexOwnerBusy;
  const reason = error instanceof Error ? error.message : null;
  if (reason === "session-workspace-mismatch" || reason === "codex-context-outside-workspace")
    return REMOTE_ERROR_CODES.codexWorkspaceMismatch;
  // A runner startup failure still means the Project Agent is unavailable.
  if (reason === REMOTE_ERROR_CODES.codexAppServerUnavailable)
    return REMOTE_ERROR_CODES.leadUnavailable;
  return parseRemoteErrorCode(reason) ?? REMOTE_ERROR_CODES.leadUnavailable;
}
