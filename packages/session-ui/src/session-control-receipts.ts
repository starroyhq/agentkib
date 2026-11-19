import {
  ApiError,
  isLegacyPreparedReceipt,
  isSessionSettingsAction,
  managedAgentOf,
  matchesSettingsAck,
  settledReceipt,
  type ControlReceipt,
  type SessionAction,
  type SessionActionBody,
  type SessionActionResult,
  type WebClient,
} from "@agentkib/web-client";
import type { SessionControlPending } from "./session-control";

export function settingsNoticeGroup(
  fields: Partial<SessionActionBody>,
): "model" | "permissions" | "settings" {
  const model = ["model", "effort", "serviceTierId", "restoreDefaults"].some((key) =>
    Object.hasOwn(fields, key),
  );
  const permission = ["policyId", "permissionMode", "mode"].some((key) =>
    Object.hasOwn(fields, key),
  );
  return model === permission ? "settings" : model ? "model" : "permissions";
}

export function dispatchSessionAction(
  client: WebClient,
  agent: string | undefined,
  action: SessionAction,
  body: SessionActionBody,
): Promise<SessionActionResult> {
  const managed = managedAgentOf(agent);
  if (!managed) return Promise.reject(new ApiError(409, "operation_unavailable", "not-dispatched"));
  return client.sessionAction(action, body, managed);
}

export async function readPendingControlReceipt(client: WebClient, entry: SessionControlPending) {
  const receipt = await client.receipt(entry.requestId).catch((error: unknown) => {
    // Access loss is a session error. An unavailable settings receipt can be read again.
    if (
      !isSessionSettingsAction(entry.kind) ||
      (error instanceof ApiError && [401, 403].includes(error.status))
    )
      throw error;
    return undefined;
  });
  if (receipt?.found && settledReceipt(receipt, entry)) return receipt;
}

export function completedForkReceipt(
  receipt: Extract<ControlReceipt, { found: true }>,
  entry: SessionControlPending,
  runtimeBootId?: string,
) {
  if (
    isLegacyPreparedReceipt(receipt, entry.requestId) ||
    receipt.ack?.accepted !== true ||
    receipt.ack.completed !== true ||
    receipt.ack.requestId !== entry.requestId ||
    typeof receipt.ack.sessionId !== "string" ||
    !receipt.ack.sessionId ||
    receipt.ack.sessionId === entry.sessionId ||
    (runtimeBootId !== undefined && receipt.runtimeBootId !== runtimeBootId)
  )
    return undefined;
  return receipt.ack.sessionId;
}

type SettingsWriteProof =
  | { status: "accepted"; result: SessionActionResult }
  | { status: "not-dispatched"; reasons: (string | undefined)[]; error: ApiError }
  | { status: "unknown"; error: unknown };

/** A missing response can trigger a receipt read. The mutation is never replayed. */
export async function verifySettingsWrite({
  client,
  action,
  body,
  runtimeBootId,
  perform,
  stillCurrent,
  allowReceiptWithoutRuntime = false,
}: {
  client: WebClient;
  action: SessionAction;
  body: SessionActionBody;
  runtimeBootId?: string;
  perform: (body: SessionActionBody) => Promise<SessionActionResult>;
  stillCurrent: () => boolean;
  /** Compatibility with desktop hosts whose stored receipts lack runtime metadata. */
  allowReceiptWithoutRuntime?: boolean;
}): Promise<SettingsWriteProof> {
  const { requestId, sessionId, expectedRevision } = body;
  let failure: unknown;
  try {
    const result = await perform(body);
    if (matchesSettingsAck(result, requestId, sessionId, runtimeBootId))
      return { status: "accepted", result };
    failure = new ApiError(502, "outcome_unknown", "unknown");
  } catch (error) {
    if (error instanceof ApiError && error.controlOutcome === "not-dispatched")
      return { status: "not-dispatched", reasons: [error.code], error };
    failure = error;
  }
  if (!stillCurrent()) return { status: "unknown", error: failure };
  const receipt = await client.receipt(requestId).catch(() => undefined);
  if (!receipt?.found) return { status: "unknown", error: failure };
  if (isLegacyPreparedReceipt(receipt, requestId))
    return {
      status: "not-dispatched",
      reasons: [],
      error: new ApiError(409, "request-interrupted", "not-dispatched"),
    };
  if (
    (runtimeBootId !== undefined &&
      receipt.runtimeBootId !== runtimeBootId &&
      !(allowReceiptWithoutRuntime && !receipt.runtimeBootId)) ||
    (receipt.expectedRevision != null && receipt.expectedRevision !== expectedRevision)
  )
    return { status: "unknown", error: failure };
  const status = settledReceipt(receipt, { requestId, sessionId, kind: action });
  if (status === "accepted" && matchesSettingsAck(receipt.ack, requestId, sessionId))
    return { status, result: receipt.ack };
  if (status === "not-dispatched") {
    const reason = receipt.ack?.reason ?? receipt.ack?.error;
    return {
      status,
      reasons: [receipt.ack?.reason, receipt.ack?.error],
      error: new ApiError(409, reason ?? "request_failed", "not-dispatched"),
    };
  }
  return { status: "unknown", error: failure };
}
