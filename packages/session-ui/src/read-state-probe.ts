const COALESCE_MS = 100;
const REUSE_MS = 350;
const RETRY_MS = 400;
const MAX_RETRY_MS = 8_000;

export function createReadStateProbe({
  canRead,
  canRetry,
  read,
}: {
  canRead: () => boolean;
  canRetry: () => boolean;
  read: (signal: AbortSignal) => Promise<"ready" | "retry" | "discarded">;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let nextReadAt = 0;
  let retryAt = 0;
  const retryDelay = { read: RETRY_MS, update: RETRY_MS };
  let queued = false;
  let inFlight = false;

  function shouldRead() {
    return (
      !controller.signal.aborted &&
      !inFlight &&
      canRead() &&
      (queued || (retryAt !== 0 && canRetry()))
    );
  }

  function schedule() {
    if (!shouldRead()) {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    const next = Math.max(nextReadAt, retryAt);
    if (timer !== undefined && dueAt === next) return;
    clearTimeout(timer);
    dueAt = next;
    timer = setTimeout(() => void probe(), Math.max(0, next - Date.now()));
  }

  function backOff(operation: keyof typeof retryDelay) {
    if (!retryAt) {
      const delay = retryDelay[operation];
      retryAt = Date.now() + Math.min(MAX_RETRY_MS, delay * (1 + 0.2 * Math.random()));
      retryDelay[operation] = Math.min(MAX_RETRY_MS, delay * 2);
    }
    schedule();
  }

  async function probe() {
    timer = undefined;
    if (!shouldRead()) return;
    queued = false;
    retryAt = 0;
    inFlight = true;
    try {
      const result = await read(controller.signal);
      if (result === "retry") backOff("read");
      else if (result === "ready") retryDelay.read = RETRY_MS;
    } finally {
      inFlight = false;
      // Wait for the actual transport promise, even if its deadline or view has changed.
      nextReadAt = Date.now() + REUSE_MS;
      schedule();
    }
  }

  return {
    refresh() {
      if (!queued && !inFlight) nextReadAt = Math.max(nextReadAt, Date.now() + COALESCE_MS);
      queued = true;
      schedule();
    },
    retryUpdate: () => backOff("update"),
    retryRead: () => backOff("read"),
    updateCompleted: () => {
      retryDelay.update = RETRY_MS;
    },
    schedule,
    close() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
