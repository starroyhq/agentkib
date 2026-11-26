// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_RUNTIME_TRACE_FILE_BYTES,
  localRuntimeTracePaths,
} from "@agentkib/backend/local-runtime-trace";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
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
