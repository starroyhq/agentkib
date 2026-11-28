import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES as codes,
  parseRemoteErrorCode,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { readControlReceipt } from "./control-receipt";
import { recordLocalRuntimeTrace } from "./local-runtime-activity";
import { isTraceWorkerWrite, LOCAL_RUNTIME_TRACE_WORKER_METHOD } from "./local-runtime-trace";
import { addLeadRecord, type Lead, type LeadRegistry } from "./orchestration-registry";
import type { EndpointResult } from "./orchestration-endpoint";
import type { LaneHost } from "./orchestration-service";
import { workerToolReadOnly } from "./orchestration-tools";
import { isObject } from "./orchestration-worker-state";
import { ProjectAgentCommandRefusal } from "./project-agent-refusal";

type WorkerControlOutcome = "accepted" | "not-dispatched" | "unknown";
type Response = {
  accepted: boolean;
  requestId?: string;
  controlOutcome: WorkerControlOutcome;
  outcome?: "unknown";
  reason?: RemoteErrorCode;
  reasonDetail?: RemoteErrorCode;
};
type ControlRequest = { operation: string; sessionId: string; requestId: string; deviceId: string };

export type WorkerStopResult = Omit<Response, "controlOutcome"> & {
  controlOutcome?: WorkerControlOutcome;
  cancelled?: true;
  dismissed?: true;
  rpcReason?: RemoteErrorCode;
};

export function workerToolReason(value: unknown): RemoteErrorCode | undefined {
  return parseRemoteErrorCode(value instanceof Error ? value.message : value);
}

export function traceWorkerFailure(
  stage: "worker-live-read" | "worker-history-read" | "worker-turn-scan" | "worker-bookkeeping",
  started: number,
  reason: RemoteErrorCode,
): void {
  recordLocalRuntimeTrace({
    kind: "request",
    method: LOCAL_RUNTIME_TRACE_WORKER_METHOD,
    durationMs: performance.now() - started,
    stage,
    outcome: "failed",
    reason,
  });
}

function traceWorkerControl(
  operation: string,
  stage: "worker-control" | "worker-transport",
  started: number,
  result: EndpointResult,
): void {
  let body: unknown;
  try {
    body = JSON.parse(result.text);
  } catch {
    // An unexpected reply cannot establish whether a write took effect.
  }
  const ack = isObject(body) ? body : {};
  const trace = {
    kind: "request" as const,
    method: LOCAL_RUNTIME_TRACE_WORKER_METHOD,
    operation,
    durationMs: performance.now() - started,
    stage,
  };
  const reason = workerToolReason(ack.reasonDetail) ?? workerToolReason(ack.reason);
  if (ack.controlOutcome === "unknown" || ack.outcome === "unknown") {
    recordLocalRuntimeTrace({
      ...trace,
      outcome: "unknown",
      reason: reason ?? codes.controlOutcomeUnconfirmed,
    });
  } else if (ack.controlOutcome === "not-dispatched") {
    recordLocalRuntimeTrace({
      ...trace,
      outcome: "refused",
      reason: reason ?? codes.requestFailed,
    });
  } else if (ack.accepted === true) {
    recordLocalRuntimeTrace({ ...trace, outcome: "accepted" });
  } else {
    recordLocalRuntimeTrace({
      ...trace,
      outcome: "unknown",
      reason: codes.controlOutcomeUnconfirmed,
    });
  }
}

export async function observeWorkerTool(
  name: string,
  input: Record<string, unknown>,
  call: () => Promise<EndpointResult>,
): Promise<EndpointResult> {
  if (!isTraceWorkerWrite(name) || workerToolReadOnly(name, input)) return call();
  const started = performance.now();
  const result = await call();
  traceWorkerControl(name, "worker-control", started, result);
  return result;
}

export function workerToolTransportFailure(
  name: string,
  input: Record<string, unknown>,
  started: number,
  phase: "not-dispatched" | "unknown",
  notDispatchedReason: RemoteErrorCode = codes.leadUnavailable,
): EndpointResult {
  const readOnly = workerToolReadOnly(name, input);
  const result =
    phase === "not-dispatched"
      ? workerRefusal(notDispatchedReason)
      : readOnly
        ? workerRefusal(codes.workerProbeFailed)
        : workerRefusal(codes.controlOutcomeUnconfirmed, { outcome: "unknown" });
  if (isTraceWorkerWrite(name) && !readOnly)
    traceWorkerControl(name, "worker-transport", started, result);
  return result;
}

export function preserveWorkerOutcome(record: () => void): void {
  const started = performance.now();
  try {
    record();
  } catch {
    traceWorkerFailure("worker-bookkeeping", started, codes.workerControlRecordFailed);
  }
}

export async function readWorkerState(
  lanes: Pick<LaneHost, "live" | "observe">,
  sessionId: string,
  intent?: "supervision" | "send",
) {
  const started = performance.now();
  try {
    const live = await (intent === "supervision"
      ? (lanes.observe?.(sessionId) ?? lanes.live(sessionId))
      : intent === "send"
        ? lanes.live(sessionId, intent)
        : lanes.live(sessionId));
    return isObject(live) ? { live } : { live: null, reason: codes.workerStateUnavailable };
  } catch (error) {
    const reason = workerToolReason(error) ?? codes.workerProbeFailed;
    traceWorkerFailure("worker-live-read", started, reason);
    return { live: null, reason };
  }
}

export function workerRefusal(
  value: unknown,
  details: Record<string, unknown> = {},
): EndpointResult {
  const unknown = details.outcome === "unknown";
  return {
    isError: true,
    text: JSON.stringify({
      ...details,
      accepted: false,
      reason:
        workerToolReason(value) ??
        (unknown ? codes.controlOutcomeUnconfirmed : codes.requestFailed),
      controlOutcome: unknown
        ? REMOTE_CONTROL_OUTCOMES.unknown
        : REMOTE_CONTROL_OUTCOMES.notDispatched,
    }),
  };
}

export function workerCallRefusal(error: unknown): EndpointResult {
  return error instanceof ProjectAgentCommandRefusal && error.rpcReason
    ? workerRefusal(error.rpcReason, { reasonDetail: workerToolReason(error) })
    : workerRefusal(error);
}

export function workerControlUnavailable(reasonDetail?: RemoteErrorCode): EndpointResult {
  return workerRefusal(codes.workerNotControllable, { reasonDetail });
}

export function workerControlResult(
  dataDir: string,
  request: ControlRequest,
  reply: unknown,
): Response {
  const ack = isObject(reply) ? reply : {};
  let phase: WorkerControlOutcome;
  let reason =
    workerToolReason(ack.error) ?? workerToolReason(ack.reason) ?? workerToolReason(reply);
  if (ack.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown || ack.outcome === "unknown") {
    phase = REMOTE_CONTROL_OUTCOMES.unknown;
  } else if (ack.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched) {
    phase = REMOTE_CONTROL_OUTCOMES.notDispatched;
  } else if (ack.accepted === true) {
    phase = "accepted";
  } else {
    phase = REMOTE_CONTROL_OUTCOMES.unknown;
    try {
      const receipt = readControlReceipt(dataDir, {
        requestId: request.requestId,
        deviceId: request.deviceId,
      });
      if (
        receipt.found &&
        "sessionId" in receipt &&
        receipt.sessionId === request.sessionId &&
        receipt.operation === request.operation &&
        (receipt.status === "accepted" ||
          receipt.status === REMOTE_CONTROL_OUTCOMES.notDispatched ||
          receipt.status === REMOTE_CONTROL_OUTCOMES.unknown) &&
        isObject(receipt.ack)
      ) {
        phase = receipt.status;
        reason =
          workerToolReason(receipt.ack.error) ?? workerToolReason(receipt.ack.reason) ?? reason;
      }
    } catch {
      // A missing or unreadable receipt cannot prove that the original call was refused.
    }
  }
  const accepted = phase === "accepted";
  const unknown = phase === REMOTE_CONTROL_OUTCOMES.unknown;
  return {
    accepted,
    requestId: request.requestId,
    controlOutcome: phase,
    ...(unknown ? { outcome: "unknown" as const } : {}),
    ...(!accepted
      ? { reason: reason ?? (unknown ? codes.controlOutcomeUnconfirmed : codes.requestFailed) }
      : {}),
  };
}

export function workerControlText(
  result: Response,
  fields?: Record<string, unknown>,
): EndpointResult {
  const missingReason = !result.accepted && !result.reason && !fields?.reason;
  const defaultReason =
    result.controlOutcome === "unknown" ? codes.controlOutcomeUnconfirmed : codes.requestFailed;
  return {
    text: JSON.stringify({ ...result, ...fields, ...(missingReason && { reason: defaultReason }) }),
    isError: !result.accepted,
  };
}

export function workerStopRefusal(
  reason: RemoteErrorCode,
  rpcReason: RemoteErrorCode,
  delegated: boolean,
): WorkerStopResult {
  return delegated
    ? { accepted: false, reason: rpcReason, ...(reason !== rpcReason && { reasonDetail: reason }) }
    : { accepted: false, reason, ...(reason !== rpcReason && { rpcReason }) };
}

export function workerStopCancellationUnknown(
  requestId: string,
  result: { error: unknown } | "dismissed",
  delegated: boolean,
): WorkerStopResult {
  const dismissed = result === "dismissed";
  return {
    // Removing the queued item cannot settle the original native send.
    accepted: dismissed,
    ...(dismissed && { dismissed }),
    requestId,
    controlOutcome: "unknown",
    outcome: "unknown",
    reason: codes.controlOutcomeUnconfirmed,
    ...(!delegated &&
      !dismissed && {
        rpcReason: workerToolReason(result.error) ?? codes.projectAgentFailed,
      }),
  };
}

export function workerStopPanelResult(raw: unknown, result: Response, delegated: boolean) {
  if (delegated || result.accepted) return result;
  const reportedReason = workerToolReason(
    raw instanceof Error ? raw.message : isObject(raw) ? raw.reason : undefined,
  );
  // This pre-dispatch refusal was unregistered in the original panel IPC.
  const legacyPanelStopReason =
    reportedReason === codes.sessionRunnerUnavailable ? codes.projectAgentFailed : reportedReason;
  const rpcReason =
    isObject(raw) && raw.controlOutcome === "unknown"
      ? codes.controlOutcomeUnconfirmed
      : (legacyPanelStopReason ?? codes.projectAgentFailed);
  return rpcReason === result.reason ? result : { ...result, rpcReason };
}

export async function workerControl(
  dataDir: string,
  request: ControlRequest,
  call: () => Promise<unknown>,
) {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    raw = error;
  }
  return { raw, result: workerControlResult(dataDir, request, raw) };
}

export function recordWorkerControl(
  registry: LeadRegistry,
  leadId: string,
  laneId: string,
  operation: Parameters<typeof addLeadRecord>[1],
  requestId: string,
  outcome: WorkerControlOutcome | string,
  change?: (current: Lead) => void,
) {
  preserveWorkerOutcome(() => {
    registry.update(leadId, (current) => {
      change?.(current);
      addLeadRecord(
        current,
        operation,
        laneId,
        requestId,
        outcome === "not-dispatched" ? "refused" : outcome,
      );
    });
  });
}
