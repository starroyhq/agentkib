import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES as codes,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { readControlReceipt } from "./control-receipt";
import { addLeadRecord, type Lead, type LeadRegistry } from "./orchestration-registry";
import type { EndpointResult } from "./orchestration-endpoint";
import { isObject } from "./orchestration-worker-state";

type WorkerControlOutcome = "accepted" | "not-dispatched" | "unknown";
type Response = {
  accepted: boolean;
  requestId?: string;
  controlOutcome: WorkerControlOutcome;
  outcome?: "unknown";
  reason?: RemoteErrorCode;
};
type ControlRequest = { operation: string; sessionId: string; requestId: string; deviceId: string };

const registered = new Set<string>(Object.values(codes));

export function workerToolReason(value: unknown): RemoteErrorCode | undefined {
  const code = value instanceof Error ? value.message : value;
  return typeof code === "string" && registered.has(code) ? (code as RemoteErrorCode) : undefined;
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
      reason: workerToolReason(value) ?? codes.workerActionFailed,
      controlOutcome: unknown
        ? REMOTE_CONTROL_OUTCOMES.unknown
        : REMOTE_CONTROL_OUTCOMES.notDispatched,
    }),
  };
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
      ? { reason: reason ?? (unknown ? codes.controlOutcomeUnconfirmed : codes.workerActionFailed) }
      : {}),
  };
}

export function workerControlText(
  result: Response,
  fields?: Record<string, unknown>,
): EndpointResult {
  return { text: JSON.stringify({ ...result, ...fields }), isError: !result.accepted };
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
  try {
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
  } catch {
    // Local bookkeeping cannot undo an acknowledgement from the native owner.
  }
}
