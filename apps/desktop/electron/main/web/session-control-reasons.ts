import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  parseRemoteErrorCode,
  type SessionPendingInteraction,
} from "@agentkib/runtime-protocol";
import { isSerialQueueMode } from "@agentkib/backend/session-control-validation";
import { correlatedControlOutcome } from "./conversation-transport";
import { snapshotField } from "./catalog-stream";

export function stopRefusal(snapshot: { turnId?: string; status?: string }, turnId: unknown) {
  if (snapshot.status === "idle") return REMOTE_ERROR_CODES.turnEnded;
  if (snapshot.turnId === turnId) return REMOTE_ERROR_CODES.stopUnavailable;
  if (typeof snapshot.turnId === "string" && snapshot.turnId) return REMOTE_ERROR_CODES.turnChanged;
  return REMOTE_ERROR_CODES.stopUnavailable;
}

export function pendingInteractionRefusal(
  snapshot: unknown,
  field: "approvals" | "questions",
  id: unknown,
  turnId: unknown,
) {
  const rows = snapshotField(snapshot, field);
  return Array.isArray(rows) &&
    rows.some(
      (row) => snapshotField(row, "requestId") === id && snapshotField(row, "turnId") === turnId,
    )
    ? REMOTE_ERROR_CODES.interactionNotActionable
    : REMOTE_ERROR_CODES.interactionNoLongerPending;
}

export function nativeApprovalOffered(
  approval: { availableDecisions: string[]; decisionOptions?: { decision: unknown }[] } | undefined,
  params: { decision?: unknown; nativeDecision?: unknown },
) {
  return (
    approval &&
    (params.nativeDecision !== undefined
      ? approval.decisionOptions?.some(
          (option) => JSON.stringify(option.decision) === JSON.stringify(params.nativeDecision),
        )
      : Array.isArray(approval.availableDecisions) &&
        approval.availableDecisions.includes(String(params.decision)))
  );
}

/** The owner-wait receipt marker is host routing metadata. */
export function projectQueueActionAck(ack: unknown): unknown {
  if (snapshotField(ack, "ownerWaitOnly") !== true) return ack;
  const { ownerWaitOnly: _ownerWaitOnly, ...publicAck } = ack as Record<string, unknown>;
  return publicAck;
}

export function interactionFor(
  interactions: readonly SessionPendingInteraction[] | undefined,
  kind: SessionPendingInteraction["kind"],
  requestId: unknown,
  turnId: unknown,
) {
  return interactions?.find(
    (item) =>
      item.kind === kind && item.binding.requestId === requestId && item.binding.turnId === turnId,
  );
}

export function hasPendingRows(snapshot: unknown, field: "approvals" | "questions"): boolean {
  const rows = snapshotField(snapshot, field);
  return (
    Array.isArray(rows) && rows.some((item) => typeof snapshotField(item, "turnId") === "string")
  );
}

export function expiredInteractionRefusal(result: unknown): boolean {
  const reason = snapshotField(result, "reason") ?? snapshotField(result, "error");
  return (
    typeof reason === "string" &&
    new Set([
      "stale-runtime-boot",
      "stale-or-disabled-control",
      "stale-turn",
      REMOTE_ERROR_CODES.staleClaudeRevision,
      "stale Claude revision",
      "stale Claude turn",
      "stale Claude question",
      "stale-dsh-revision",
      "stale Antigravity revision",
      "stale Antigravity turn",
      "missing-approval",
      "missing-question",
      "approval-unavailable",
      "question-unavailable",
      "interaction-answered-elsewhere",
    ]).has(reason)
  );
}

/** The caller has already checked the receipt's device, operation and input binding. */
export function refusedReceiptReason(
  receipt: Record<string, unknown>,
  requestId: unknown,
  sessionId: unknown,
) {
  const { ack } = receipt;
  if (
    typeof requestId !== "string" ||
    typeof sessionId !== "string" ||
    receipt.requestId !== requestId ||
    receipt.sessionId !== sessionId ||
    receipt.status !== REMOTE_CONTROL_OUTCOMES.notDispatched ||
    snapshotField(ack, "completed") !== false ||
    correlatedControlOutcome(ack, requestId, sessionId, receipt.runtimeBootId) !==
      REMOTE_CONTROL_OUTCOMES.notDispatched
  )
    return undefined;
  return (
    parseRemoteErrorCode(snapshotField(ack, "reason")) ??
    parseRemoteErrorCode(snapshotField(ack, "error"))
  );
}

/** Only validations inside the AgentKib-owned serial queue transaction can issue these receipts. */
export function serialQueueTransactionReason(
  operation: string,
  executionMode: unknown,
  reason: unknown,
) {
  if (!isSerialQueueMode(executionMode)) return undefined;
  if (operation === "queue-add" && reason === REMOTE_ERROR_CODES.queueLimit) return reason;
  if (operation === "queue-reorder" && reason === REMOTE_ERROR_CODES.staleQueueOrder) return reason;
  if (
    (operation === "queue-update" || operation === "queue-delete") &&
    reason === REMOTE_ERROR_CODES.queueItemUnavailableDetail
  )
    return reason;
}
