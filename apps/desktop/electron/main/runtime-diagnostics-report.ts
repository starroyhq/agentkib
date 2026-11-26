import {
  LOCAL_RUNTIME_TRACE_FILE_BYTES,
  localRuntimeTracePaths,
  parseLocalRuntimeTraceRow,
  type LocalRuntimeTraceRow,
} from "@agentkib/backend/local-runtime-trace";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const RECENT_STALLS = 50;
const REQUEST_GROUPS = 32;

type Stall = Extract<LocalRuntimeTraceRow, { kind: "stall" }>;
type Request = Extract<LocalRuntimeTraceRow, { kind: "request" }>;
type Sqlite = Extract<LocalRuntimeTraceRow, { kind: "sqlite" }>;
type RequestSummary = Pick<Request, "method" | "operation"> & {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
};
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

export async function readRuntimeDiagnostics(dataDir: string) {
  const recentStalls: Stall[] = [];
  const requests = new Map<string, RequestSummary>();
  const sqlite = new Map<string, SqliteSummary>();
  const seenFiles = new Set<string>();
  const counts = { runtime: 0, stall: 0, request: 0, sqlite: 0, dropped: 0 };
  let ignoredLines = 0;
  let droppedRecords = 0;
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
      const lines = snapshot.text.split("\n");
      // The runtime can be appending the last line while the export reads.
      lines.pop();
      for (let index = lines.length - 1; index >= 0; index--) {
        const row = traceRow(lines[index]!);
        if (!row) {
          ignoredLines++;
          continue;
        }
        counts[row.kind]++;
        oldestAt = Math.min(oldestAt ?? row.at, row.at);
        newestAt = Math.max(newestAt ?? row.at, row.at);
        if (row.kind === "stall" && recentStalls.length < RECENT_STALLS) recentStalls.push(row);
        if (row.kind === "dropped") droppedRecords += row.count;
        if (row.kind === "request") {
          const { method, operation, durationMs } = row;
          const key = `${method}\0${operation ?? ""}`;
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
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    recentStalls,
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
      sqlite: [...sqlite.values()],
    },
  };
}
