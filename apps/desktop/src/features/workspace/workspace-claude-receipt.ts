import { isLegacyPreparedReceipt, type ControlReceipt } from "@agentkib/web-client";
import { api } from "@/core/api";
import { desktopConversationRequest } from "@/core/conversation-bridge";

const operations = new Set([
  "create",
  "adopt",
  "release",
  "reconcile",
  "send",
  "stop",
  "approve",
  "answer",
  "fork",
]);

/** Recover a saved request from the removed Claude panel using its original receipt owner. */
export async function recoverWorkspaceClaudeSession(workspaceId: string, signal: AbortSignal) {
  const key = `agentkib:claude-owner-pending:v1:${workspaceId}`;
  const saved = localStorage.getItem(key);
  if (saved === null) return;
  const value: unknown = JSON.parse(saved);
  if (!value || typeof value !== "object") throw new Error("pending_control_storage_invalid");
  const {
    requestId,
    operation,
    sessionId,
    workspaceId: owner,
    transport,
  } = value as Record<string, unknown>;
  if (
    typeof requestId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(requestId) ||
    typeof operation !== "string" ||
    !operations.has(operation) ||
    owner !== workspaceId ||
    (transport !== undefined && transport !== "conversation") ||
    (operation === "fork" && transport !== "conversation") ||
    (operation !== "create" &&
      (typeof sessionId !== "string" || !sessionId || sessionId.length > 256))
  )
    throw new Error("pending_control_storage_invalid");

  const receipt =
    transport === "conversation"
      ? await desktopConversationRequest<ControlReceipt>(`requests/${requestId}`, undefined, signal)
      : ((await api.claudeRequest({ operation: "receipt", requestId })) as ControlReceipt);
  signal.throwIfAborted();
  if (localStorage.getItem(key) !== saved) throw new Error("control_outcome_unconfirmed");
  if (isLegacyPreparedReceipt(receipt, requestId)) {
    localStorage.removeItem(key);
    return;
  }
  if (
    receipt.found !== true ||
    receipt.requestId !== requestId ||
    receipt.operation !== operation ||
    (receipt.workspaceId != null && receipt.workspaceId !== workspaceId) ||
    (sessionId !== undefined && receipt.sessionId !== sessionId) ||
    (receipt.status !== "accepted" && receipt.status !== "not-dispatched")
  )
    throw new Error("control_outcome_unconfirmed");

  const opensSession = receipt.status === "accepted" && ["create", "fork"].includes(operation);
  const recoveredId = operation === "fork" ? receipt.ack?.sessionId : receipt.sessionId;
  if (
    opensSession &&
    (typeof recoveredId !== "string" ||
      !recoveredId ||
      recoveredId.length > 256 ||
      recoveredId === sessionId)
  )
    throw new Error("control_outcome_unconfirmed");
  localStorage.removeItem(key);
  return opensSession ? recoveredId : undefined;
}
