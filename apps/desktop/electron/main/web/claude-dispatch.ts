import { REMOTE_ERROR_CODES, REMOTE_ERROR_CONTRACT } from "@agentkib/runtime-protocol";
import { RuntimeRequestError } from "../runtime-host";

// These runtime errors can be raised before any native command is claimed.
const PRE_DISPATCH_ERRORS = new Set([
  "web-busy",
  "stale-Claude-revision",
  "session-busy",
  "session-managed-by-another-runtime",
  "session-already-bridged",
  "claude-bridge-disconnected",
  "claude-follower-attachments-unavailable",
  "unverified-session-identity",
]);

const terminalForeground = REMOTE_ERROR_CONTRACT.claudeTerminalForegroundUnconfirmed;

export function terminalHandoverRefusal(reason: unknown) {
  if (reason === terminalForeground.code || reason === REMOTE_ERROR_CODES.claudeTerminalExitRefused)
    return reason;
}

function preDispatchReason(error: unknown, operation: unknown): string | undefined {
  if (!(error instanceof RuntimeRequestError)) return;
  if (operation === "handover-terminal") {
    const data = error.data;
    if (
      error.code === terminalForeground.ipc.rpcCode &&
      data &&
      typeof data === "object" &&
      "detail" in data &&
      data.detail === terminalForeground.ipc.detail
    )
      return terminalForeground.code;
    return;
  }
  if (error.code === -32000 && PRE_DISPATCH_ERRORS.has(error.message)) return error.message;
}

/** A preflight rejection describes this attempt, not necessarily the original request. */
export async function dispatchClaude(
  invoke: (params: unknown) => Promise<unknown>,
  receipt: (params: { requestId: string; deviceId: string }) => Promise<unknown>,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(params);
  } catch (error) {
    const reason = preDispatchReason(error, params.operation);
    if (!reason) throw error;
    if (typeof params.requestId !== "string" || typeof params.deviceId !== "string") throw error;
    // The authoritative ledger must also have no claim for this request. A
    // repeat attempt rejected at preflight cannot override an execution it found.
    const prior = await receipt({ requestId: params.requestId, deviceId: params.deviceId });
    if (
      !prior ||
      typeof prior !== "object" ||
      !("found" in prior) ||
      prior.found !== false ||
      !("requestId" in prior) ||
      prior.requestId !== params.requestId
    )
      throw error;
    return {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId: params.requestId,
      sessionId: params.sessionId,
      runtimeBootId: params.runtimeBootId,
      reason,
      error: reason,
    };
  }
}
