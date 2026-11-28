import { REMOTE_CONTROL_OUTCOMES } from "@agentkib/runtime-protocol";

export type ControlOutcomeFence = {
  requestId: string;
  sessionId: string;
  operation: string;
  deviceId: string;
  createdAt: number;
};

type OutcomeReceipt = {
  found: boolean;
  requestId: string;
  sessionId?: string;
  operation?: string;
  workspaceId?: string;
  status?: string;
  executionMode?: string;
  completionObserved?: unknown;
  ack?: unknown;
};

const MAX_LATE_RECONCILE_RECEIPTS = 8;

/** The ledger has already scoped this receipt read to the caller's device. */
export function receiptSettlesOutcomeFence(
  receipt: OutcomeReceipt,
  fence: ControlOutcomeFence | undefined,
  requestId: string,
  deviceId: string,
): fence is ControlOutcomeFence {
  if (
    receipt.found !== true ||
    receipt.requestId !== requestId ||
    !fence ||
    fence.requestId !== requestId ||
    fence.deviceId !== deviceId ||
    receipt.sessionId !== fence.sessionId ||
    receipt.operation !== fence.operation
  )
    return false;

  if (receipt.status === "accepted" || receipt.status === REMOTE_CONTROL_OUTCOMES.notDispatched)
    return true;
  if (receipt.status !== REMOTE_CONTROL_OUTCOMES.unknown) return false;

  // Retiring an orphaned command releases its transport fence. Its result stays unknown.
  const value = receipt.ack;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ack = value as Record<string, unknown>;
  return (
    receipt.executionMode === "claude-managed" &&
    typeof receipt.workspaceId === "string" &&
    receipt.workspaceId.length > 0 &&
    receipt.completionObserved === false &&
    ack.recovery === "orphaned-claude-command" &&
    ack.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown &&
    ack.accepted === false &&
    ack.completed === false &&
    ack.requestId === requestId &&
    ack.sessionId === fence.sessionId
  );
}

type LateReconcile = {
  sessionId: string;
  requestId: string;
  workspaceId: string;
  fences: ReadonlySet<ControlOutcomeFence> | undefined;
  timedOut: (error: unknown) => boolean;
  current: (fence: ControlOutcomeFence) => boolean;
  receipt: (scope: { requestId: string; deviceId: string }) => Promise<unknown>;
  settle: (fence: ControlOutcomeFence) => void;
};

/** The backend can finish after HTTP has timed out and the original browser has gone away. */
export function observeLateClaudeReconcile(
  response: Promise<unknown>,
  pending: Promise<unknown>,
  options?: LateReconcile,
): Promise<unknown> {
  if (!options?.fences?.size) return response;
  const fences: ControlOutcomeFence[] = [];
  for (const fence of options.fences) {
    if (fence.operation !== "send" && fence.operation !== "stop") continue;
    fences.push(fence);
    if (fences.length === MAX_LATE_RECONCILE_RECEIPTS) break;
  }
  return response.catch((error: unknown) => {
    if (options.timedOut(error)) {
      void pending
        .then(async (result) => {
          if (!result || typeof result !== "object") return;
          const ack = result as Record<string, unknown>;
          if (
            ack.requestId !== options.requestId ||
            ack.sessionId !== options.sessionId ||
            ack.accepted !== true ||
            ack.completed !== true ||
            ack.controlOutcome !== "accepted" ||
            ack.reconciled !== true
          )
            return;

          // Observe a bounded batch once. A later receipt read can still settle a missed fence.
          await Promise.allSettled(
            fences.map(async (fence) => {
              if (!options.current(fence)) return;
              const { requestId, deviceId } = fence;
              const value = await options.receipt({ requestId, deviceId });
              if (!value || typeof value !== "object") return;
              const receipt = value as OutcomeReceipt;
              if (
                receipt.status === REMOTE_CONTROL_OUTCOMES.unknown &&
                receipt.workspaceId === options.workspaceId &&
                receiptSettlesOutcomeFence(receipt, fence, requestId, deviceId) &&
                options.current(fence)
              )
                options.settle(fence);
            }),
          );
        })
        .catch(() => undefined);
    }
    throw error;
  });
}

/** Transport uncertainty fences one operation. The Provider still owns native authority. */
export class ControlOutcomeFences {
  readonly sessions = new Set<string>();
  readonly #requests = new Map<string, ControlOutcomeFence>();
  readonly #bySession = new Map<string, Set<ControlOutcomeFence>>();

  record(entry: Omit<ControlOutcomeFence, "createdAt">): void {
    if (this.#requests.has(entry.requestId)) return;
    const fence = { ...entry, createdAt: Date.now() };
    const entries = this.#bySession.get(entry.sessionId) ?? new Set<ControlOutcomeFence>();
    entries.add(fence);
    this.#bySession.set(entry.sessionId, entries);
    this.#requests.set(entry.requestId, fence);
    this.sessions.add(entry.sessionId);
  }

  get(requestId: string): ControlOutcomeFence | undefined {
    return this.#requests.get(requestId);
  }

  forSession(sessionId: string): ReadonlySet<ControlOutcomeFence> | undefined {
    return this.#bySession.get(sessionId);
  }

  blocks(sessionId: string, operation: string, exceptRequestId?: string): boolean {
    const entries = this.#bySession.get(sessionId);
    if (!entries) return false;
    for (const entry of entries) {
      if (entry.requestId === exceptRequestId) continue;
      if (entry.operation === operation) return true;
    }
    return false;
  }

  settle(sessionId: string, requestId: string): boolean {
    const fence = this.#requests.get(requestId);
    if (fence?.sessionId !== sessionId) return false;
    this.#requests.delete(requestId);
    const entries = this.#bySession.get(sessionId);
    entries?.delete(fence);
    if (!entries?.size) {
      this.#bySession.delete(sessionId);
      this.sessions.delete(sessionId);
    }
    return true;
  }
}
