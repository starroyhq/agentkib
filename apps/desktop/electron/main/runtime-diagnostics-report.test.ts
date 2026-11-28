// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_RUNTIME_TRACE_FILE_BYTES,
  localRuntimeTracePaths,
} from "@agentkib/backend/local-runtime-trace";
import { REMOTE_ERROR_CODES, RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { readRuntimeDiagnostics } from "./runtime-diagnostics-report";

const AT = Date.UTC(2026, 10, 26);
const SESSION = "7da27114edc50cde";
const context = { method: RUNTIME_METHODS.runtimeInfo, session: SESSION };
const row = (kind: string, fields: Record<string, unknown>) => ({ v: 1, at: AT, kind, ...fields });
const ndjson = (...rows: unknown[]) => rows.map((entry) => JSON.stringify(entry) + "\n").join("");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agentkib-runtime-diagnostics-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("local runtime diagnostics report", () => {
  it("counts push outcomes without passing through relay error text", async () => {
    const [current, previous] = localRuntimeTracePaths(directory);
    await mkdir(path.dirname(current!), { recursive: true });
    const start = { operation: "start", outcome: "refused", reason: "push_target_unavailable" };
    await writeFile(
      current!,
      ndjson(
        row("push", { ...start, count: 1, retryAt: AT + 1_000, session: "private session" }),
        row("push", {
          operation: "start",
          outcome: "skipped",
          count: 4,
          reason: "activity_cooldown",
        }),
        row("push", { operation: "update", outcome: "refused", count: 1, reason: "private error" }),
      ),
    );
    await writeFile(previous!, ndjson(row("push", { ...start, count: 1, retryAt: AT + 500 })));
    const result = await readRuntimeDiagnostics(directory);
    expect(result.trace.counts.push).toBe(4);
    expect(result.trace.push).toEqual(
      expect.arrayContaining([
        { ...start, count: 2, retryAt: AT + 1_000 },
        { operation: "start", outcome: "skipped", count: 4, reason: "activity_cooldown" },
        { operation: "update", outcome: "refused", count: 1, reason: "request_failed" },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reads rotated traces, strips extraneous fields and omits incomplete lines", async () => {
    const [current, previous] = localRuntimeTracePaths(directory);
    const privatePath = "/private/project";
    const privatePrompt = "private user prompt";
    await mkdir(path.dirname(current!), { recursive: true });
    await writeFile(
      current!,
      ndjson(
        row("request", { ...context, durationMs: 42, path: privatePath }),
        row("stall", {
          at: AT + 2,
          durationMs: 2080,
          active: [{ ...context, prompt: privatePrompt }],
          activeCount: 1,
        }),
        row("sqlite", {
          database: "shared-store",
          operation: "begin-immediate",
          outcome: "busy",
          waitMs: 250,
          statement: privatePrompt,
        }),
        row("request", { method: privatePath, durationMs: 100 }),
      ) + '{"unfinished":',
    );
    await writeFile(
      previous!,
      ndjson(
        row("runtime", { state: "started" }),
        row("request", { ...context, durationMs: 2 }),
        row("stall", { durationMs: 2200, active: [], activeCount: 0 }),
        row("sqlite", {
          database: "shared-store",
          operation: "begin-immediate",
          outcome: "acquired",
          waitMs: 4,
        }),
        row("dropped", { count: 7 }),
      ),
    );
    const result = await readRuntimeDiagnostics(directory);
    expect(result.recentStalls).toHaveLength(2);
    expect(result.recentStalls[0]).toMatchObject({
      durationMs: 2080,
      active: [context],
    });
    expect(result.recentStalls[1]?.durationMs).toBe(2200);
    expect(result.trace).toMatchObject({
      filesRead: 2,
      counts: { runtime: 1, stall: 2, request: 2, sqlite: 2, dropped: 1 },
      ignoredLines: 1,
      droppedRecords: 7,
      oldestAt: AT,
      newestAt: AT + 2,
      requests: [
        {
          method: RUNTIME_METHODS.runtimeInfo,
          count: 2,
          totalDurationMs: 44,
          maxDurationMs: 42,
        },
      ],
      sqlite: [
        {
          database: "shared-store",
          count: 2,
          totalWaitMs: 254,
          maxWaitMs: 250,
          busy: 1,
          locked: 0,
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain(privatePrompt);
    expect(serialized).not.toContain(directory);
  });

  it("bounds stalls and skips oversized or non-regular files", async () => {
    const [current, previous, third] = localRuntimeTracePaths(directory);
    await mkdir(path.dirname(current!), { recursive: true });
    await writeFile(
      current!,
      ndjson(
        ...Array.from({ length: 60 }, (_, i) =>
          row("stall", { at: AT + i, durationMs: 2200, active: [], activeCount: 0 }),
        ),
      ),
    );
    await writeFile(previous!, Buffer.alloc(LOCAL_RUNTIME_TRACE_FILE_BYTES + 1, "a"));
    await mkdir(third!);
    const report = await readRuntimeDiagnostics(directory);
    expect(report.trace.filesRead).toBe(1);
    expect(report.trace.counts.stall).toBe(60);
    expect(report.recentStalls).toHaveLength(50);
    expect(report.recentStalls[0]?.at).toBe(AT + 59);
    expect(report.recentStalls.at(-1)?.at).toBe(AT + 10);
  });

  it("counts request outcomes by operation, stage and reason without exposing private data", async () => {
    const [current, previous] = localRuntimeTracePaths(directory);
    const method = RUNTIME_METHODS.sessionRequest;
    const send = { method, operation: "send", durationMs: 5 };
    const catalog = { method, operation: "catalog", durationMs: 7 };
    const refused = {
      ...send,
      stage: "host-admission",
      outcome: "refused",
      reason: REMOTE_ERROR_CODES.permissionDenied,
    };
    const secret = "private payload for account and request";
    await mkdir(path.dirname(current!), { recursive: true });
    await writeFile(
      current!,
      ndjson(
        row("request", { ...refused, at: AT + 9 }),
        row("request", {
          ...send,
          at: AT + 10,
          stage: "host-dispatch",
          outcome: "unknown",
          reason: REMOTE_ERROR_CODES.outcomeUnknown,
          session: SESSION,
          requestId: secret,
          account: secret,
          input: secret,
        }),
        row("request", {
          ...send,
          at: AT + 16,
          stage: "runtime-dispatch",
          outcome: "accepted",
        }),
        row("request", {
          ...catalog,
          at: AT + 5,
          stage: "host-dispatch",
          outcome: "failed",
          reason: REMOTE_ERROR_CODES.catalogReadTimeout,
        }),
        row("request", {
          ...catalog,
          at: AT + 17,
          stage: "runtime-dispatch",
          outcome: "completed",
        }),
        row("request", {
          ...catalog,
          at: AT + 15,
          stage: "host-response",
          outcome: "cancelled",
          reason: REMOTE_ERROR_CODES.historyRequestCancelled,
        }),
      ),
    );
    await writeFile(
      previous!,
      ndjson(
        row("request", { ...refused, at: AT + 11 }),
        row("request", {
          ...send,
          at: AT + 8,
          stage: "runtime-dispatch",
          outcome: "failed",
          reason: secret,
        }),
        row("request", {
          ...catalog,
          at: AT + 7,
          stage: "runtime-dispatch",
          outcome: "partial",
          reason: REMOTE_ERROR_CODES.catalogStale,
        }),
        row("request", { ...send, at: AT + 12 }),
        row("request", {
          ...send,
          at: AT + 4,
          stage: "host-admission",
          outcome: "refused",
          reason: REMOTE_ERROR_CODES.controlPreflightRejected,
        }),
      ),
    );

    const report = await readRuntimeDiagnostics(directory);
    expect(report.trace).toMatchObject({
      requests: [
        { method, operation: "send", count: 3, totalDurationMs: 15 },
        { method, operation: "catalog", count: 2, totalDurationMs: 14 },
      ],
      requestOutcomeGroups: 10,
      omittedRequestOutcomes: 0,
      unclassifiedRequests: 1,
      genericReasonRequests: 2,
      partialRequests: 1,
      requestOutcomes: expect.arrayContaining([
        {
          method,
          operation: "send",
          stage: "host-admission",
          outcome: "refused",
          reason: REMOTE_ERROR_CODES.permissionDenied,
          count: 2,
        },
        {
          method,
          operation: "send",
          stage: "runtime-dispatch",
          outcome: "failed",
          reason: REMOTE_ERROR_CODES.requestFailed,
          count: 1,
        },
        {
          method,
          operation: "catalog",
          stage: "host-response",
          outcome: "cancelled",
          reason: REMOTE_ERROR_CODES.historyRequestCancelled,
          count: 1,
        },
        { method, operation: "send", outcome: "unclassified", count: 1 },
      ]),
    });
    expect(report.recentFailures.map(({ at }) => at - AT)).toEqual([11, 10, 9, 8, 7, 5, 4]);
    expect(report.recentFailures[1]).toEqual({
      at: AT + 10,
      method,
      operation: "send",
      stage: "host-dispatch",
      outcome: "unknown",
      reason: REMOTE_ERROR_CODES.outcomeUnknown,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SESSION);
    expect(serialized).not.toContain(secret);
  });

  it("keeps only the 50 most recent failures even when file order differs from time order", async () => {
    const [current, previous] = localRuntimeTracePaths(directory);
    const failures = (offset: number) =>
      Array.from({ length: 55 }, (_, i) =>
        row("request", {
          at: AT + offset + i,
          method: RUNTIME_METHODS.sessionRequest,
          operation: "send",
          durationMs: 10,
          stage: "runtime-dispatch",
          outcome: "refused",
          reason: REMOTE_ERROR_CODES.permissionDenied,
        }),
      );
    await mkdir(path.dirname(current!), { recursive: true });
    await writeFile(current!, ndjson(...failures(0)));
    await writeFile(previous!, ndjson(...failures(100).reverse()));

    const report = await readRuntimeDiagnostics(directory);
    expect(report.recentFailures.map(({ at }) => at - AT)).toEqual(
      Array.from({ length: 50 }, (_, i) => 154 - i),
    );
    expect(report.trace.requestOutcomes).toMatchObject([{ count: 110 }]);
  });

  it("bounds the reported groups and counts the requests omitted from their breakdown", async () => {
    const [current] = localRuntimeTracePaths(directory);
    const reasons = [
      REMOTE_ERROR_CODES.requestFailed,
      ...Object.values(REMOTE_ERROR_CODES)
        .filter((code) => code !== REMOTE_ERROR_CODES.requestFailed)
        .slice(0, 130),
    ];
    await mkdir(path.dirname(current!), { recursive: true });
    await writeFile(
      current!,
      ndjson(
        ...reasons.map((reason) =>
          row("request", {
            method: RUNTIME_METHODS.sessionRequest,
            operation: "send",
            durationMs: 1,
            stage: "runtime-dispatch",
            outcome: "refused",
            reason,
          }),
        ),
      ),
    );
    const { trace } = await readRuntimeDiagnostics(directory);
    expect(trace.requestOutcomes).toHaveLength(128);
    expect(trace.requestOutcomeGroups).toBe(131);
    expect(trace.omittedRequestOutcomes).toBe(3);
    expect(trace.genericReasonRequests).toBeGreaterThanOrEqual(1);
    expect(trace.requestOutcomes).toContainEqual(
      expect.objectContaining({ reason: REMOTE_ERROR_CODES.requestFailed, count: 1 }),
    );
  });

  it.skipIf(process.platform === "win32")("never reads traces through symlinks", async () => {
    const [current] = localRuntimeTracePaths(directory);
    const diagnosticDir = path.dirname(current!);
    const unrelated = path.join(directory, "unrelated");
    await mkdir(unrelated, { recursive: true });
    const privateFile = path.join(unrelated, path.basename(current!));
    await writeFile(privateFile, ndjson(row("runtime", { state: "started" })));
    await symlink(unrelated, diagnosticDir, "dir");
    expect((await readRuntimeDiagnostics(directory)).trace.filesRead).toBe(0);
    await rm(diagnosticDir);
    await mkdir(diagnosticDir);
    await symlink(privateFile, current!);
    expect((await readRuntimeDiagnostics(directory)).trace.filesRead).toBe(0);
  });
});
