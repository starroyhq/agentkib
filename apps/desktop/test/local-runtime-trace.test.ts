// @vitest-environment node
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMOTE_ERROR_CODES, RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, expect, it, vi } from "vitest";
import {
  LOCAL_RUNTIME_TRACE_FILE_BYTES,
  LOCAL_RUNTIME_TRACE_HOST_METHOD,
  LocalRuntimeTrace,
  localRuntimeTracePaths,
  parseLocalRuntimeTraceRow,
  type LocalRuntimeTraceEvent,
} from "../../../packages/backend/src/local-runtime-trace";

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "agentkib-runtime-trace-"));
  roots.push(root);
  return { root, files: localRuntimeTracePaths(root), trace: new LocalRuntimeTrace(root) };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.mocked(open).mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function rows(contents: string) {
  return contents
    .trim()
    .split("\n")
    .map((line) => parseLocalRuntimeTraceRow(JSON.parse(line)));
}

it("bounds foreground enqueue work without touching the filesystem and preserves a stall on overflow", async () => {
  const { files, trace } = await fixture();
  const request: LocalRuntimeTraceEvent = {
    kind: "request",
    method: RUNTIME_METHODS.sessionRequest,
    session: "0123456789abcdef",
    operation: "send",
    durationMs: 12,
  };
  trace.record({ kind: "runtime", state: "started" });
  const start = performance.now();
  for (let index = 0; index < 100_000; index++) trace.record(request);
  trace.record({ kind: "stall", durationMs: 2_100, active: [request], activeCount: 1 });
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(250);
  expect(existsSync(path.dirname(files[0]!))).toBe(false);

  const closed = trace.close();
  expect(trace.close()).toBe(closed);
  await closed;
  trace.record(request);
  const stored = rows(await readFile(files[0]!, "utf8"));
  expect(stored).toHaveLength(257);
  expect(stored.filter((row) => row?.kind === "request")).toHaveLength(254);
  expect(stored).toContainEqual(expect.objectContaining({ kind: "dropped", count: 99_746 }));
  expect(stored).toContainEqual(expect.objectContaining({ kind: "runtime", state: "started" }));
  expect(stored.at(-1)).toMatchObject({
    kind: "stall",
    durationMs: 2_100,
    active: [
      { method: RUNTIME_METHODS.sessionRequest, session: "0123456789abcdef", operation: "send" },
    ],
  });
});

it("persists only bounded diagnostic metadata and validates exported rows again", async () => {
  const { trace, files } = await fixture();
  trace.record({
    kind: "request",
    method: RUNTIME_METHODS.sessionRequest,
    operation: "not-an-operation",
    session: "/private/conversation",
    durationMs: 15,
    params: { text: "do not log this" },
  } as LocalRuntimeTraceEvent);
  trace.record({ kind: "request", method: "untrusted-method", durationMs: 1 });
  trace.record({
    kind: "stall",
    durationMs: 2_001,
    active: Array.from({ length: 9 }, () => ({
      method: RUNTIME_METHODS.sessionEvents,
      session: "0000000000000001",
    })),
    activeCount: 9,
  });
  await trace.close();
  const output = await readFile(files[0]!, "utf8");
  expect(output).not.toMatch(/private|do not log|untrusted|not-an-operation|params/);
  const [request, stall] = rows(output);
  expect(request).toEqual({
    v: 1,
    at: expect.any(Number),
    kind: "request",
    method: RUNTIME_METHODS.sessionRequest,
    durationMs: 15,
  });
  expect(stall).toMatchObject({ kind: "stall", activeCount: 9, active: expect.any(Array) });
  if (stall?.kind !== "stall") throw new Error("Missing stall");
  expect(stall.active).toHaveLength(8);
  expect(
    parseLocalRuntimeTraceRow({ v: 1, at: 1, kind: "request", method: "arbitrary" }),
  ).toBeUndefined();
  if (process.platform !== "win32") {
    expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(files[0]!))).mode & 0o777).toBe(0o700);
  }
});

it("keeps registered outcomes and projects unknown failure reasons without request data", async () => {
  const { trace, files } = await fixture();
  const base = { kind: "request", method: LOCAL_RUNTIME_TRACE_HOST_METHOD, durationMs: 2 } as const;
  trace.record({
    ...base,
    operation: "handover-terminal",
    stage: "host-admission",
    outcome: "refused",
    reason: REMOTE_ERROR_CODES.permissionDenied,
    session: "0123456789abcdef",
  });
  trace.record({
    ...base,
    operation: "/requests/private-receipt",
    stage: "host-dispatch",
    outcome: "unknown",
    reason: "untrusted reason at /private/home",
    input: { text: "do not write the body" },
    session: "abcdef0123456789",
  } as unknown as LocalRuntimeTraceEvent);
  trace.record({
    ...base,
    operation: "managedAction",
    stage: "host-response",
    outcome: "accepted",
  });
  await trace.close();

  const contents = await readFile(files[0]!, "utf8");
  expect(contents).not.toMatch(/private|untrusted|0123456789|do not write|session/);
  expect(rows(contents)).toEqual([
    expect.objectContaining({
      operation: "handover-terminal",
      stage: "host-admission",
      outcome: "refused",
      reason: REMOTE_ERROR_CODES.permissionDenied,
    }),
    expect.objectContaining({
      stage: "host-dispatch",
      outcome: "unknown",
      reason: REMOTE_ERROR_CODES.requestFailed,
    }),
    expect.objectContaining({
      operation: "managedAction",
      stage: "host-response",
      outcome: "accepted",
    }),
  ]);
  const old = { ...base, v: 1, at: 1 };
  expect(parseLocalRuntimeTraceRow(old)).toEqual(old);
  expect(
    parseLocalRuntimeTraceRow({ ...old, stage: "untrusted", outcome: "accepted" }),
  ).toBeUndefined();
  expect(
    parseLocalRuntimeTraceRow({ ...old, stage: "runtime-dispatch", outcome: "untrusted" }),
  ).toBeUndefined();
  expect(
    parseLocalRuntimeTraceRow({
      ...old,
      stage: "host-response",
      outcome: "accepted",
      reason: REMOTE_ERROR_CODES.requestFailed,
    }),
  ).not.toHaveProperty("reason");
});

it("writes only allowlisted push metadata to the trace", async () => {
  const { trace, files } = await fixture();
  trace.record({
    kind: "push",
    operation: "start",
    outcome: "refused",
    reason: "push_target_unavailable",
    count: 1,
    retryAt: 1_762_900_060_000,
    title: "private title",
    session: "private session",
    token: "private token",
    envelope: "private body",
  } as LocalRuntimeTraceEvent);
  await trace.close();
  const output = await readFile(files[0]!, "utf8");
  expect(output).not.toContain("private");
  expect(rows(output)).toEqual([
    {
      v: 1,
      at: expect.any(Number),
      kind: "push",
      operation: "start",
      outcome: "refused",
      reason: "push_target_unavailable",
      retryAt: 1_762_900_060_000,
      count: 1,
    },
  ]);
});

it("serializes the host and runtime writers across a shared rotation", async () => {
  const { root, files, trace: runtime } = await fixture();
  const [active, rotated] = files;
  await mkdir(path.dirname(active!), { mode: 0o700 });
  const old = JSON.stringify({ v: 1, at: 1, kind: "runtime", state: "started" });
  await writeFile(active!, old.padEnd(LOCAL_RUNTIME_TRACE_FILE_BYTES - 1) + "\n", {
    mode: 0o600,
  });
  const host = new LocalRuntimeTrace(root);
  for (let index = 0; index < 64; index++) {
    runtime.record({
      kind: "request",
      method: RUNTIME_METHODS.sessionRequest,
      durationMs: index,
      operation: "send",
      stage: "runtime-dispatch",
      outcome: "accepted",
    });
    host.record({
      kind: "request",
      method: LOCAL_RUNTIME_TRACE_HOST_METHOD,
      durationMs: index,
      operation: "send",
      stage: "host-admission",
      outcome: "refused",
      reason: REMOTE_ERROR_CODES.permissionDenied,
    });
  }
  await Promise.all([runtime.close(), host.close()]);

  const rotations = await readFile(rotated!, "utf8");
  const contents = await readFile(active!, "utf8");
  expect(rows(rotations)).toEqual([JSON.parse(old)]);
  expect(rows(contents)).toHaveLength(128);
  expect(contents).not.toContain('"kind":"dropped"');
  expect(Buffer.byteLength(contents) + Buffer.byteLength(rotations)).toBeLessThanOrEqual(
    files.length * LOCAL_RUNTIME_TRACE_FILE_BYTES,
  );
  for (const stage of ["runtime-dispatch", "host-admission"]) {
    expect(
      rows(contents).flatMap((row) =>
        row?.kind === "request" && row.stage === stage ? [row.durationMs] : [],
      ),
    ).toEqual(Array.from({ length: 64 }, (_, index) => index));
  }
});

it("retains no more than four size-bounded files across runtime restarts", async () => {
  const { root, files } = await fixture();
  const [active, ...archives] = files;
  await mkdir(path.dirname(active!), { mode: 0o700 });
  for (let generation = 1; generation <= 5; generation++) {
    const row = JSON.stringify({ v: 1, at: generation, kind: "runtime", state: "started" });
    await writeFile(active!, row.padEnd(LOCAL_RUNTIME_TRACE_FILE_BYTES - 1) + "\n", {
      mode: 0o600,
    });
    const trace = new LocalRuntimeTrace(root);
    trace.record({ kind: "runtime", state: "started" });
    await trace.close();
  }
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  expect(
    contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0),
  ).toBeLessThanOrEqual(files.length * LOCAL_RUNTIME_TRACE_FILE_BYTES);
  expect(
    await Promise.all(archives.map(async (file) => rows(await readFile(file, "utf8"))[0]?.at)),
  ).toEqual([5, 4, 3]);
  expect(existsSync(`${active}.4`)).toBe(false);
});

it("ends shutdown within its budget and does not start another write after slow I/O", async () => {
  const { trace, files } = await fixture();
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    started.resolve();
    await released.promise;
    const handle = await fs.open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      closed.resolve();
    };
    return handle;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  trace.record({ kind: "runtime", state: "started" });
  for (let index = 0; index < 160; index++)
    trace.record({ kind: "request", method: RUNTIME_METHODS.sessionEvents, durationMs: 1 });

  await vi.advanceTimersByTimeAsync(250);
  await started.promise;
  await vi.advanceTimersByTimeAsync(2_000);
  expect(open).toHaveBeenCalledTimes(1);
  const shutdown = trace.close();
  await vi.advanceTimersByTimeAsync(500);
  await shutdown;
  released.resolve();
  await closed.promise;

  expect(open).toHaveBeenCalledTimes(1);
  expect((await stat(files[0]!)).size).toBe(0);
});

it("separates a previously incomplete line from the first new record", async () => {
  const { trace, files } = await fixture();
  const file = files[0]!;
  await mkdir(path.dirname(file), { mode: 0o700 });
  await writeFile(file, '{"v":1,"kind":"req', { mode: 0o600 });
  trace.record({ kind: "runtime", state: "started" });
  await trace.close();
  const [incomplete, valid] = (await readFile(file, "utf8")).split("\n");
  expect(incomplete).toBe('{"v":1,"kind":"req');
  expect(rows(valid!)).toEqual([expect.objectContaining({ kind: "runtime", state: "started" })]);
});

it.skipIf(process.platform === "win32")(
  "fails open without appending through a trace symlink",
  async () => {
    const { root, trace, files } = await fixture();
    const target = path.join(root, "unrelated");
    await writeFile(target, "unrelated contents", { mode: 0o600 });
    await mkdir(path.dirname(files[0]!), { mode: 0o700 });
    await symlink(target, files[0]!);

    trace.record({ kind: "runtime", state: "started" });
    await trace.close();
    expect(await readFile(target, "utf8")).toBe("unrelated contents");
  },
);

it.skipIf(process.platform === "win32")("does not open a hard-linked trace lease", async () => {
  const { root, trace, files } = await fixture();
  const directory = path.dirname(files[0]!);
  const target = path.join(root, "unrelated");
  await writeFile(target, "unrelated contents");
  await chmod(target, 0o644);
  await mkdir(directory, { mode: 0o700 });
  await link(target, path.join(directory, "runtime-trace.lock"));

  trace.record({ kind: "runtime", state: "started" });
  await trace.close();
  expect(existsSync(files[0]!)).toBe(false);
  expect(await readFile(target, "utf8")).toBe("unrelated contents");
  expect((await stat(target)).mode & 0o777).toBe(0o644);
});
