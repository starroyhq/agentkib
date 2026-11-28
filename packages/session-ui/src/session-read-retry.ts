import { ApiError, REMOTE_ERROR_CODES, type Live } from "@agentkib/web-client";

export function checkLiveSession(live: Live, sessionId: string): void {
  if (live.sessionId !== sessionId) throw new ApiError(409, "session-state-unavailable");
}

export function isBusyRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
  const code = error instanceof ApiError ? error.code : error.message.replace(/^Error: /, "");
  return code === REMOTE_ERROR_CODES.operationBusy || code === REMOTE_ERROR_CODES.queueFull;
}

export function shouldRetryBusyRead(attempt: number, error: unknown): boolean {
  return attempt < 2 && isBusyRead(error);
}

export function busyReadBackoffMs(attempt: number): number {
  return 150 * (attempt + 1);
}

// A busy live read cannot schedule a new refresh until the selected history
// read settles. Its sibling may have a definite history failure.
export function readHistoryAndLive<T>(history: Promise<T>, live: Promise<Live>) {
  return Promise.all([
    history,
    live.catch((error: unknown) => {
      if (error instanceof ApiError && isBusyRead(error)) return error;
      throw error;
    }),
  ]);
}

/** Admission contention only retries observation, never a scan or command. */
export async function retryBusyRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (!shouldRetryBusyRead(attempt, error) || signal?.aborted) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, busyReadBackoffMs(attempt));
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
}
