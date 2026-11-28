import {
  LOCAL_RUNTIME_TRACE_FILE_BYTES,
  localRuntimeTracePaths,
  parseLocalRuntimeTraceRow,
  type LocalRuntimeTraceRow,
} from "@agentkib/backend/local-runtime-trace";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const RECENT_STALLS = 50;
const RECENT_FAILURES = 50;
const RECENT_DELEGATION_PAUSES = 50;
const REQUEST_GROUPS = 32;
const REQUEST_OUTCOME_GROUPS = 128;

type Stall = Extract<LocalRuntimeTraceRow, { kind: "stall" }>;
type DelegationPause = Extract<LocalRuntimeTraceRow, { kind: "delegation-pause" }>;
type Request = Extract<LocalRuntimeTraceRow, { kind: "request" }>;
type Sqlite = Extract<LocalRuntimeTraceRow, { kind: "sqlite" }>;
type RequestSummary = Pick<Request, "method" | "operation"> & {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
};
type RequestOutcome = NonNullable<Request["outcome"]> | "unclassified";
type FailureOutcome = Extract<RequestOutcome, "refused" | "failed" | "unknown" | "partial">;
type RequestOutcomeFields = Pick<Request, "method" | "operation" | "stage" | "reason">;
type RequestOutcomeSummary = RequestOutcomeFields & { outcome: RequestOutcome; count: number };
type FailureSample = RequestOutcomeFields & { outcome: FailureOutcome; at: number };
type SqliteSummary = Pick<Sqlite, "database" | "operation"> & {
  count: number;
  totalWaitMs: number;
  maxWaitMs: number;
  busy: number;
  locked: number;
};

async function traceFile(filePath: string) {
  try {
    const entry = await lstat(filePath, { bigint: true });
    if (!entry.isFile()) return;
    const file = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const snapshot = await file.stat({ bigint: true });
      if (
        !snapshot.isFile() ||
        entry.ino !== snapshot.ino ||
        entry.dev !== snapshot.dev ||
        snapshot.size > LOCAL_RUNTIME_TRACE_FILE_BYTES
      )
        return;
      const bytes = Buffer.allocUnsafe(Number(snapshot.size));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      return {
        identity: `${snapshot.dev}:${snapshot.ino}`,
        text: bytes.subarray(0, length).toString("utf8"),
      };
    } finally {
      await file.close();
    }
  } catch {
    // Rotation can move a file between lstat and open. The remaining slots are still useful.
    return;
  }
}

function traceRow(line: string) {
  try {
    const value: unknown = JSON.parse(line);
    return parseLocalRuntimeTraceRow(value);
  } catch {
    return;
  }
}

function isFailureOutcome(outcome: RequestOutcome): outcome is FailureOutcome {
  return (
    outcome === "refused" || outcome === "failed" || outcome === "unknown" || outcome === "partial"
  );
}

function isGenericReason(reason: Request["reason"]) {
  return (
    reason === REMOTE_ERROR_CODES.requestFailed ||
    reason === REMOTE_ERROR_CODES.controlPreflightRejected
  );
}

function outcomePriority(summary: RequestOutcomeSummary) {
  if (isGenericReason(summary.reason)) return 2;
  return Number(isFailureOutcome(summary.outcome));
}

function keepRecent<T extends { at: number }>(samples: T[], sample: T, limit: number) {
  const index = samples.findIndex(({ at }) => at < sample.at);
  if (index === -1) {
    if (samples.length < limit) samples.push(sample);
  } else {
    samples.splice(index, 0, sample);
    if (samples.length > limit) samples.pop();
  }
}

export async function readRuntimeDiagnostics(dataDir: string) {
  const recentStalls: Stall[] = [];
  const recentFailures: FailureSample[] = [];
  const recentDelegationPauses: DelegationPause[] = [];
  const requests = new Map<string, RequestSummary>();
  const requestOutcomes = new Map<string, RequestOutcomeSummary>();
  const sqlite = new Map<string, SqliteSummary>();
  const seenFiles = new Set<string>();
  const counts = { runtime: 0, stall: 0, request: 0, sqlite: 0, dropped: 0, "delegation-pause": 0 };
  let ignoredLines = 0;
  let droppedRecords = 0;
  let unclassifiedRequests = 0;
  let genericReasonRequests = 0;
  let partialRequests = 0;
  let oldestAt: number | undefined;
  let newestAt: number | undefined;
  const resolved = await realpath(dataDir).catch(() => undefined);
  const files = resolved ? localRuntimeTracePaths(resolved) : [];
  // Only the runtime's own directory and fixed sequence of file names are eligible.
  const directory = files[0] && path.dirname(files[0]);
  if (directory && (await realpath(directory).catch(() => undefined)) === directory) {
    for (const filePath of files) {
      const snapshot = await traceFile(filePath);
      if (!snapshot || seenFiles.has(snapshot.identity)) continue;
      seenFiles.add(snapshot.identity);
      // Scan complete lines in reverse without copying the whole trace into a line array.
      let end = snapshot.text.lastIndexOf("\n");
      while (end >= 0) {
        const start = end === 0 ? -1 : snapshot.text.lastIndexOf("\n", end - 1);
        const row = start + 1 === end ? undefined : traceRow(snapshot.text.slice(start + 1, end));
        end = start;
        if (!row) {
          ignoredLines++;
          continue;
        }
        counts[row.kind]++;
        oldestAt = Math.min(oldestAt ?? row.at, row.at);
        newestAt = Math.max(newestAt ?? row.at, row.at);
        if (row.kind === "stall" && recentStalls.length < RECENT_STALLS) recentStalls.push(row);
        if (row.kind === "delegation-pause")
          keepRecent(recentDelegationPauses, row, RECENT_DELEGATION_PAUSES);
        if (row.kind === "dropped") droppedRecords += row.count;
        if (row.kind === "request") {
          const { method, operation, durationMs, stage, reason } = row;
          const key = `${method}\0${operation ?? ""}`;
          // Preserve the runtime-only timing totals in reports that now also contain host traces.
          if (stage === undefined || stage === "runtime-dispatch") {
            const summary = requests.get(key) ?? {
              method,
              operation,
              count: 0,
              totalDurationMs: 0,
              maxDurationMs: 0,
            };
            summary.count++;
            summary.totalDurationMs += durationMs;
            summary.maxDurationMs = Math.max(summary.maxDurationMs, durationMs);
            requests.set(key, summary);
          }

          const outcome = row.outcome ?? "unclassified";
          const dimensions = { method, operation, stage, reason };
          const outcomeKey = `${key}\0${stage ?? ""}\0${outcome}\0${reason ?? ""}`;
          const outcomeSummary = requestOutcomes.get(outcomeKey) ?? {
            ...dimensions,
            outcome,
            count: 0,
          };
          outcomeSummary.count++;
          requestOutcomes.set(outcomeKey, outcomeSummary);
          if (outcome === "unclassified") unclassifiedRequests++;
          if (outcome === "partial") partialRequests++;
          if (isGenericReason(reason)) genericReasonRequests++;
          if (isFailureOutcome(outcome))
            keepRecent(recentFailures, { at: row.at, ...dimensions, outcome }, RECENT_FAILURES);
        } else if (row.kind === "sqlite") {
          const { database, operation, waitMs, outcome } = row;
          const key = `${database}\0${operation}`;
          const summary = sqlite.get(key) ?? {
            database,
            operation,
            count: 0,
            totalWaitMs: 0,
            maxWaitMs: 0,
            busy: 0,
            locked: 0,
          };
          summary.count++;
          summary.totalWaitMs += waitMs;
          summary.maxWaitMs = Math.max(summary.maxWaitMs, waitMs);
          if (outcome === "busy" || outcome === "locked") summary[outcome]++;
          sqlite.set(key, summary);
        }
      }
    }
  }
  const reportedOutcomes = [...requestOutcomes.values()]
    .sort((a, b) => outcomePriority(b) - outcomePriority(a) || b.count - a.count)
    .slice(0, REQUEST_OUTCOME_GROUPS);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    recentStalls,
    recentFailures,
    recentDelegationPauses,
    trace: {
      filesRead: seenFiles.size,
      counts,
      oldestAt,
      newestAt,
      ignoredLines,
      droppedRecords,
      requestGroups: requests.size,
      requests: [...requests.values()]
        .sort((a, b) => b.totalDurationMs - a.totalDurationMs)
        .slice(0, REQUEST_GROUPS),
      requestOutcomeGroups: requestOutcomes.size,
      requestOutcomes: reportedOutcomes,
      omittedRequestOutcomes:
        counts.request - reportedOutcomes.reduce((sum, row) => sum + row.count, 0),
      unclassifiedRequests,
      genericReasonRequests,
      partialRequests,
      sqlite: [...sqlite.values()],
    },
  };
}
