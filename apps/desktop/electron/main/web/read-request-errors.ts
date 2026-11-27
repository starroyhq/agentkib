import {
  parseRemoteErrorCode,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { RuntimeRequestError } from "../runtime-host";
import { snapshotField } from "./catalog-stream";

// A missing or unrecognized operation keeps the mutation's unknown-outcome timeout.
const runtimeReads = new Set([
  "capabilities",
  "catalog",
  "catalog-scope",
  "context",
  "desktop-events",
  "devin-options",
  "diff",
  "dsh-options",
  "events",
  "goal",
  "live",
  "provider-options",
  "provider-validate-control",
  "provider-workspace-resources",
  "queue-list",
  "read-state",
  "receipt",
  "resources",
  "resume-command",
  "session-directory",
  "session-image",
  "settings-state",
  "subagent-events",
  "subagents",
  "usage",
]);

export function runtimeRequestDeadline(operation: unknown, error: RemoteErrorCode) {
  if (
    error === REMOTE_ERROR_CODES.outcomeUnknown &&
    typeof operation === "string" &&
    runtimeReads.has(operation)
  ) {
    const timeout = REMOTE_ERROR_CONTRACT.runtimeReadTimeout;
    return { status: timeout.http.status, error: timeout.http.reasonFor, reason: timeout.code };
  }
  return {
    status: REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseTimedOut,
    error,
  };
}

const historyFailures = new Map<RemoteErrorCode, number>(
  [
    REMOTE_ERROR_CONTRACT.historySourceStale,
    REMOTE_ERROR_CONTRACT.historySearchCursorStale,
    REMOTE_ERROR_CONTRACT.historySourceChanged,
    REMOTE_ERROR_CONTRACT.historySourceOwnerChanged,
    REMOTE_ERROR_CONTRACT.historyOwnerChanged,
    REMOTE_ERROR_CONTRACT.historySourceUnavailable,
    REMOTE_ERROR_CONTRACT.historySearchDisabled,
    REMOTE_ERROR_CONTRACT.historySearchCacheUnavailable,
    REMOTE_ERROR_CONTRACT.historySearchCursorInvalid,
    REMOTE_ERROR_CONTRACT.historyReferenceRangeInvalid,
    REMOTE_ERROR_CONTRACT.historyReferencesTooLarge,
    REMOTE_ERROR_CONTRACT.historySearchInputInvalid,
  ].map(({ code, http }) => [code, http.status]),
);

export function historyReadFailure(error: unknown) {
  const detail =
    error instanceof RuntimeRequestError ? snapshotField(error.data, "detail") : undefined;
  const code = parseRemoteErrorCode(detail ?? (error instanceof Error ? error.message : undefined));
  const status = code ? historyFailures.get(code) : undefined;
  return code && status !== undefined ? { status, code } : undefined;
}
