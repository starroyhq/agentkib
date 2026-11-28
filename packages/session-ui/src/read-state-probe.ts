const COALESCE_MS = 100;
const REUSE_MS = 350;
const FIRST_RETRY_MS = 400;
const MAX_RETRY_MS = 8_000;
const RECOVERY = { attempts: 11, windowMs: 70_000 };
const RETRY_LIMIT = {
  read: RECOVERY,
  update: RECOVERY,
  reconcile: { attempts: 3, windowMs: 10_000 },
};
type RetryKind = keyof typeof RETRY_LIMIT;
type Budget = { attempts: number; until: number; delay: number };
type Retry = { kind: RetryKind; budget: Budget; at: number };

export function createReadStateProbe({
  canRead,
  canRetry,
  read,
}: {
  canRead: () => boolean;
  canRetry: () => boolean;
  read: (
    signal: AbortSignal,
    retrying: boolean,
  ) => Promise<"ready" | "retry" | "reconcile" | "discarded">;
}) {
  const budgets = new Map<RetryKind, Budget>();
  let active: { controller: AbortController; retry?: Retry } | undefined;
  let pending: Retry | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let nextReadAt = 0;
  let queued = false;
  let closed = false;

  function eligibleRetry(): Retry | undefined {
    if (pending && Date.now() >= pending.budget.until) pending = undefined;
    return pending && canRetry() ? pending : undefined;
  }

  function schedule() {
    if (active?.retry && !canRetry()) active.controller.abort();
    const retry = eligibleRetry();
    if (closed || active || !canRead() || (!queued && !retry)) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    const next = Math.max(nextReadAt, retry?.at ?? 0);
    if (timer !== undefined && next === dueAt) return;
    clearTimeout(timer);
    dueAt = next;
    timer = setTimeout(() => void probe(), Math.max(0, next - Date.now()));
  }

  function backOff(kind: RetryKind): boolean {
    if (closed) return false;
    const now = Date.now();
    const limit = RETRY_LIMIT[kind];
    const budget = budgets.get(kind) ?? {
      attempts: 0,
      until: now + limit.windowMs,
      delay: FIRST_RETRY_MS,
    };
    budgets.set(kind, budget);
    const at = now + Math.min(MAX_RETRY_MS, budget.delay * (1 + 0.2 * Math.random()));
    if (budget.attempts >= limit.attempts || at >= budget.until) return false;
    if (!pending) {
      pending = { kind, budget, at };
      budget.delay = Math.min(MAX_RETRY_MS, budget.delay * 2);
    }
    schedule();
    return true;
  }

  function reset(kind: RetryKind) {
    budgets.delete(kind);
    if (pending?.kind === kind) pending = undefined;
  }

  async function probe() {
    timer = undefined;
    const retry = eligibleRetry();
    if (closed || active || !canRead() || (!queued && !retry)) return;
    if (retry && Date.now() < retry.at) {
      schedule();
      return;
    }
    queued = false;
    if (retry) {
      pending = undefined;
      retry.budget.attempts++;
    }
    const controller = new AbortController();
    active = { controller, retry };
    const deadline = retry && setTimeout(() => controller.abort(), retry.budget.until - Date.now());
    try {
      const result = await read(controller.signal, !!retry);
      if (controller.signal.aborted) {
        if (retry && budgets.get(retry.kind) === retry.budget) backOff(retry.kind);
      } else if (result === "retry") backOff("read");
      else if (result === "reconcile") backOff("reconcile");
      else if (result === "ready") reset("read");
    } finally {
      clearTimeout(deadline);
      // Keep the flight until the transport settles, including IPC that cannot abort the host.
      active = undefined;
      nextReadAt = Date.now() + REUSE_MS;
      schedule();
    }
  }

  return {
    refresh() {
      if (!queued && !active) nextReadAt = Math.max(nextReadAt, Date.now() + COALESCE_MS);
      queued = true;
      schedule();
    },
    retryUpdate: () => backOff("update"),
    retryReconcile: () => backOff("reconcile"),
    canFinishUpdate: () => Date.now() < (budgets.get("update")?.until ?? Infinity),
    updateCompleted: () => reset("update"),
    reconciliationCompleted: () => reset("reconcile"),
    resetRetryBudget() {
      budgets.clear();
      pending = undefined;
      if (active?.retry) active.controller.abort();
    },
    schedule,
    close() {
      closed = true;
      active?.controller.abort();
      clearTimeout(timer);
    },
  };
}
