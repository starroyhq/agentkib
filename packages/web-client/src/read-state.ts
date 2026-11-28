import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_REQUEST_PATH,
  type ConversationReadState,
  type ConversationReadStateMark,
} from "@agentkib/runtime-protocol";
import { ApiError } from "./api-error";
import type { WebClient } from "./index";

/** A readback must start after an earlier probe actually finishes, without reusing its snapshot. */
export function serializeReadStateReads<T>(
  request: (sessionId: string, signal?: AbortSignal) => Promise<T>,
) {
  const reads = new Map<string, Promise<T>>();
  return (sessionId: string, signal?: AbortSignal) => {
    const previous = reads.get(sessionId);
    const start = async () => {
      signal?.throwIfAborted();
      return request(sessionId, signal);
    };
    const next = previous ? previous.then(start, start) : start();
    reads.set(sessionId, next);
    const settled = () => {
      if (reads.get(sessionId) === next) reads.delete(sessionId);
    };
    void next.then(settled, settled);
    return next;
  };
}

/** Only for reads. A timed-out write can already have advanced the cursor. */
export function isTemporaryReadStateError(error: unknown): boolean {
  if (error instanceof ApiError)
    return (
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      [500, 502, 503, 504].includes(error.status) ||
      (error.status === 409 && error.code === REMOTE_ERROR_CODES.operationBusy)
    );
  return (
    error instanceof TypeError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

/** A refusal before the host sent the read-state update to the authority. */
export function isRetryableReadStateUpdateError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.controlOutcome !== REMOTE_CONTROL_OUTCOMES.unknown &&
    ((error.status === 429 && error.code === REMOTE_ERROR_CODES.rateLimited) ||
      (error.status === 409 && error.code === REMOTE_ERROR_CODES.operationBusy) ||
      (error.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched &&
        isTemporaryReadStateError(error)))
  );
}

export class ReadStateReconciliationError extends Error {
  constructor(
    cause: unknown,
    readonly conflict: boolean,
  ) {
    super("Could not reconcile the read-state update", { cause });
    this.name = "ReadStateReconciliationError";
  }
}

/** A lost ACK is resolved by a GET, never by replaying the write. */
export async function updateReadState(
  client: Pick<WebClient, "request" | "readState">,
  sessionId: string,
  expectedVersion: string,
  seenResultId: string | null,
  mark?: ConversationReadStateMark,
  signal?: AbortSignal,
) {
  try {
    const result = await client.request<{ readState: ConversationReadState }>(
      REMOTE_REQUEST_PATH.readState,
      { sessionId, expectedVersion, seenResultId, ...(mark !== undefined ? { mark } : {}) },
      signal,
    );
    return { ...result, acknowledged: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (mark === undefined && isRetryableReadStateUpdateError(error)) throw error;
    if (
      error instanceof ApiError &&
      error.controlOutcome !== REMOTE_CONTROL_OUTCOMES.unknown &&
      error.status !== 409 &&
      error.status > 0 &&
      error.status < 500
    )
      throw error;
    const conflict =
      error instanceof ApiError &&
      error.controlOutcome !== REMOTE_CONTROL_OUTCOMES.unknown &&
      error.status === 409 &&
      error.code === REMOTE_ERROR_CODES.readStateConflict;
    try {
      const result = await client.readState(sessionId, signal);
      return { ...result, acknowledged: false, ...(conflict ? { conflict: true as const } : {}) };
    } catch (cause) {
      if (mark !== undefined) throw cause;
      throw new ReadStateReconciliationError(cause, conflict);
    }
  }
}
