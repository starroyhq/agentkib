import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  REMOTE_MANAGED_ACTION_OPERATIONS,
  RUNTIME_METHODS,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import {
  localRuntimeTraceReason,
  type LocalRuntimeTraceContext,
  type LocalRuntimeTraceResult,
} from "./local-runtime-trace";

const stage = "runtime-dispatch";
const validationErrors = new Map<number, RemoteErrorCode>([
  [REMOTE_ERROR_CONTRACT.rpcInvalidRequest.ipc.rpcCode, REMOTE_ERROR_CODES.rpcInvalidRequest],
  [REMOTE_ERROR_CONTRACT.rpcInvalidParams.ipc.rpcCode, REMOTE_ERROR_CODES.rpcInvalidParams],
  [REMOTE_ERROR_CONTRACT.rpcMethodNotFound.ipc.rpcCode, REMOTE_ERROR_CODES.rpcMethodNotFound],
]);
const sessionWrites = new Set([
  ...REMOTE_MANAGED_ACTION_OPERATIONS.filter((operation) => operation !== "inspect"),
  "send",
  "stop",
  "approve",
  "answer",
  "create",
  "devin-create",
  "devin-terminal",
  "dsh-create",
  "provider-create",
  "read-state-update",
  "release",
  "session-pin",
  "session-pin-set",
]);
const sourceProgress = new Set([
  "not-scanned",
  "refreshing",
  "classification-pending",
  "index-disabled",
  "antigravity-acp-disabled",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function catalogReason(result: Record<string, unknown>) {
  if (result.complete !== false) return;
  const coverage = record(result.taskSummarySourceCoverage);
  // A source being scanned or turned off does not explain a read failure.
  let unavailable = coverage?.managedComplete === false || coverage === undefined;
  let sourceUnavailable = false;
  if (coverage?.indexEnabled !== false && Array.isArray(coverage?.sources))
    for (const source of coverage.sources) {
      const info = record(source);
      if (info?.complete !== false) continue;
      if (!Array.isArray(info.reasons) || info.reasons.length === 0) {
        unavailable = true;
        continue;
      }
      for (const reason of info.reasons) {
        if (typeof reason === "string" && sourceProgress.has(reason)) continue;
        const code = localRuntimeTraceReason(reason);
        // Prefer a more specific code when a source provides one.
        if (code === REMOTE_ERROR_CODES.sourceUnavailable) {
          sourceUnavailable = true;
          continue;
        }
        if (code) return code;
        unavailable = true;
      }
    }
  if (sourceUnavailable) return REMOTE_ERROR_CODES.sourceUnavailable;
  if (unavailable) return REMOTE_ERROR_CODES.requestFailed;
}

export type LocalRuntimeRequestObservation = "cancelled" | "not-dispatched";

export function localRuntimeRequestResult(
  context: Pick<LocalRuntimeTraceContext, "method" | "operation">,
  response: unknown,
  observation?: LocalRuntimeRequestObservation,
): LocalRuntimeTraceResult {
  const reply = record(response);
  const error = record(reply?.error);
  const write = context.operation !== undefined && sessionWrites.has(context.operation);
  if (observation === "cancelled")
    return write
      ? { stage, outcome: "unknown", reason: REMOTE_ERROR_CODES.outcomeUnknown }
      : { stage, outcome: "cancelled", reason: REMOTE_ERROR_CODES.historyRequestCancelled };
  if (error || !reply || !Object.hasOwn(reply, "result")) {
    const validation =
      error?.code === REMOTE_ERROR_CONTRACT.rpcIncompatibleProtocol.ipc.rpcCode &&
      context.method === RUNTIME_METHODS.handshake
        ? REMOTE_ERROR_CODES.rpcIncompatibleProtocol
        : typeof error?.code === "number"
          ? validationErrors.get(error.code)
          : undefined;
    if (validation) return { stage, outcome: "refused", reason: validation };
    const reason =
      localRuntimeTraceReason(record(error?.data)?.detail) ?? REMOTE_ERROR_CODES.requestFailed;
    if (observation === "not-dispatched") return { stage, outcome: "refused", reason };
    if (!write && reason === REMOTE_ERROR_CODES.historyRequestCancelled)
      return { stage, outcome: "cancelled", reason };
    // Generic application failures may occur after dispatch. They do not prove a write was refused.
    return { stage, outcome: write ? "unknown" : "failed", reason };
  }

  const body = record(reply.result);
  const result =
    context.operation && body?.operation === context.operation
      ? (record(body.result) ?? body)
      : body;
  if (!result) return { stage, outcome: "completed" };
  const reason =
    localRuntimeTraceReason(result.reason) ??
    localRuntimeTraceReason(result.error) ??
    REMOTE_ERROR_CODES.requestFailed;
  // The disposition wins over any success flag or the retry policy of its reason code.
  if (result.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown)
    return { stage, outcome: "unknown", reason };
  if (result.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched)
    return { stage, outcome: "refused", reason };
  if (
    result.accepted === false ||
    (context.operation === "provider-validate-control" && result.error)
  )
    return {
      stage,
      outcome: result.accepted === false && write ? "unknown" : "refused",
      reason,
    };
  if (result.controlOutcome === "accepted" || result.accepted === true)
    return { stage, outcome: "accepted" };
  if (context.operation === "catalog") {
    const incomplete = catalogReason(result);
    if (incomplete) return { stage, outcome: "partial", reason: incomplete };
  }
  if (context.method === RUNTIME_METHODS.sessionSourceCapability && result.status === "unavailable")
    return { stage, outcome: "failed", reason };
  return { stage, outcome: "completed" };
}
