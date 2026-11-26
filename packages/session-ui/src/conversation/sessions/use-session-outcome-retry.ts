import { useEffect, useState } from "react";
import { SESSION_OUTCOME_GRACE_MS } from "@agentkib/web-client";
import type { PendingControl } from "./pending-controls";

export { SESSION_OUTCOME_GRACE_MS };
const FIRST_RECEIPT_RETRY_MS = 1_000;
const MAX_RECEIPT_RETRY_MS = 30_000;

/** Poll receipt reads until the caller's request or scope is no longer active. */
export function startSessionOutcomeRetry(check: () => Promise<void>): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  let delay = FIRST_RECEIPT_RETRY_MS;
  const read = async () => {
    try {
      await check();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void read(), delay);
        delay = Math.min(delay * 2, MAX_RECEIPT_RETRY_MS);
      }
    }
  };
  void read();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Only receipt reads are polled. Leaving the access scope cancels future polling. */
export function useSessionOutcomeRetry(
  scope: string | undefined,
  entries: readonly PendingControl[],
  check: () => Promise<void>,
): number {
  const [clock, setClock] = useState(Date.now);
  const nextDeadline = entries.reduce<number | undefined>((earliest, entry) => {
    if (entry.createdAt === undefined) return earliest;
    const deadline = entry.createdAt + SESSION_OUTCOME_GRACE_MS;
    if (deadline <= clock) return earliest;
    return earliest === undefined ? deadline : Math.min(earliest, deadline);
  }, undefined);
  useEffect(() => {
    if (nextDeadline === undefined) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, nextDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [nextDeadline]);
  const pending = entries.length > 0;
  useEffect(() => {
    if (!scope || !pending) return;
    return startSessionOutcomeRetry(check);
  }, [scope, pending, check]);
  return clock;
}
