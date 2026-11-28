import { busyReadBackoffMs, shouldRetryBusyRead } from "@agentkib/session-ui";

/** Add to idempotent query keys backed by runtime reads. */
export const busyReadQueryOptions = {
  retry: shouldRetryBusyRead,
  retryDelay: busyReadBackoffMs,
};
