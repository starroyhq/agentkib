import type { AttachmentStore } from "./attachments";

/** Validate the original semantic input without re-opening files already eligible for deletion. */
export async function replayClaudeAttachments(
  store: AttachmentStore,
  receipt: Record<string, unknown> | undefined,
  input: {
    deviceId: string;
    sessionId: string;
    requestId: string;
    expectedRevision: unknown;
    attachmentIds: unknown;
    text: string;
  },
): Promise<Record<string, unknown> | undefined> {
  if (
    receipt?.found !== true ||
    (receipt.executionMode !== "claude-managed" && receipt.executionMode !== "claude-follower") ||
    receipt.sessionId !== input.sessionId ||
    receipt.requestId !== input.requestId
  )
    return;
  if (receipt.operation !== "send" || receipt.expectedRevision !== input.expectedRevision)
    throw new Error("request_conflict");
  if (
    !(await store.verifyReplay(
      input.deviceId,
      input.sessionId,
      input.attachmentIds,
      input.text,
      receipt.executionMode === "claude-managed" ? "claude" : "claude-terminal",
      input.requestId,
    ))
  )
    return;
  if (receipt.ack && typeof receipt.ack === "object" && !Array.isArray(receipt.ack))
    return receipt.ack as Record<string, unknown>;
  return {
    accepted: false,
    completed: false,
    controlOutcome: "unknown",
    requestId: input.requestId,
    sessionId: input.sessionId,
  };
}

/** A generic idle snapshot is not evidence that a particular input finished. */
export async function settleClaudeAttachments(
  store: AttachmentStore,
  receipt: (params: { requestId: string; deviceId: string }) => Promise<unknown>,
  sessionId: string,
): Promise<void> {
  for (const pending of await store.pendingRequests(sessionId)) {
    const value = await receipt(pending);
    if (!value || typeof value !== "object") continue;
    const result = value as Record<string, unknown>;
    if (
      result.found !== true ||
      result.sessionId !== sessionId ||
      result.requestId !== pending.requestId
    )
      continue;
    if (
      result.status === "not-dispatched" ||
      (result.status === "accepted" && result.completionObserved === true)
    ) {
      await store.settle(pending.deviceId, sessionId, pending.requestId);
    }
  }
}
