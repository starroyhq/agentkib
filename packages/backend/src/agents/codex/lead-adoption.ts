import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
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
  return (
    Object.values(REMOTE_ERROR_CODES).find((code) => code === reason) ??
    REMOTE_ERROR_CODES.leadUnavailable
  );
}
