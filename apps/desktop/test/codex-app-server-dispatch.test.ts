// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerReader,
  CodexAppServerSession,
  CodexAppServerError,
  codexWriterBusy,
} from "../../../packages/backend/src/agents/codex/codex-app-server";

const { spawn, tree } = vi.hoisted(() => ({
  spawn: vi.fn(),
  tree: { terminate: vi.fn(), close: vi.fn() },
}));
vi.mock("cross-spawn", () => ({ default: spawn }));
vi.mock("../../../packages/backend/src/native-process", () => ({
  windowsProcessTree: () => tree,
}));

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  spawn.mockReset();
  tree.terminate.mockReset();
  tree.close.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: new PassThrough(),
    pid: 42,
    kill: vi.fn(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  spawn.mockReturnValue(child);
  const frames: Array<Record<string, unknown>> = [];
  let respond = true;
  child.stdin.on("data", (chunk: Buffer) => {
    const frame = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
    frames.push(frame);
    if (typeof frame.id === "number" && respond)
      child.stdout.write(JSON.stringify({ id: frame.id, result: { accepted: true } }) + "\n");
  });
  cleanups.push(() => {
    child.exitCode = 0;
    child.emit("close", 0);
    child.stdout.destroy();
    child.stdin.destroy();
  });
  return {
    child,
    frames,
    setRespond: (value: boolean) => (respond = value),
    finish: () => {
      child.exitCode = 0;
      child.emit("close", 0);
    },
  };
}

async function fixture() {
  const f = childFixture();
  const session = await CodexAppServerSession.start(
    "/synthetic/codex",
    "/synthetic/workspace",
    "/synthetic/home",
    {},
  );
  f.frames.splice(0);
  return { session, ...f };
}

function useWindows() {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32" });
  cleanups.push(() => {
    Object.defineProperty(process, "platform", descriptor);
  });
}

describe("Codex app-server dispatch cleanup", () => {
  it("preserves native rejection code, message and data separately from transport errors", async () => {
    const f = await fixture();
    f.setRespond(false);
    const pending = f.session.request("thread/resume", {});
    const rejection = expect(pending).rejects.toMatchObject({
      code: -32600,
      message: "thread already has an active writer",
      data: { threadId: "thread" },
    });
    const frame = f.frames.at(-1)!;
    f.child.stdout.write(
      JSON.stringify({
        id: frame.id,
        error: {
          code: -32600,
          message: "thread already has an active writer",
          data: { threadId: "thread" },
        },
      }) + "\n",
    );
    await rejection;
    expect(
      codexWriterBusy(
        new CodexAppServerError({ code: -32600, message: "thread already has an active writer" }),
      ),
    ).toBe(true);
    expect(
      codexWriterBusy(
        new CodexAppServerError({ code: -32603, message: "thread already has an active writer" }),
      ),
    ).toBe(false);
    expect(codexWriterBusy(new Error("thread already has an active writer"))).toBe(false);
  });
  it("rejects before writing and releases the response timer without an unhandled rejection", async () => {
    const f = await fixture();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    cleanups.push(() => {
      process.off("unhandledRejection", unhandled);
    });
    await expect(
      f.session.request("turn/start", {}, () => {
        throw new Error("session-compacting");
      }),
    ).rejects.toThrow("session-compacting");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(unhandled).not.toHaveBeenCalled();
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not exhaust pending request capacity after repeated dispatch rejections", async () => {
    const f = await fixture();
    for (let index = 0; index < 129; index++)
      await expect(
        f.session.request("turn/start", {}, () => {
          throw new Error("session-compacting");
        }),
      ).rejects.toThrow("session-compacting");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });

  it("runs the admission callback immediately before a successful native write", async () => {
    const f = await fixture();
    const dispatch = vi.fn(() => expect(f.frames).toEqual([]));
    await expect(f.session.request("turn/start", {}, dispatch)).resolves.toEqual({
      accepted: true,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.frames).toMatchObject([{ method: "turn/start" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still rejects a dispatched request at the native response timeout", async () => {
    const f = await fixture();
    f.setRespond(false);
    const rejection = expect(f.session.request("turn/start", {})).rejects.toThrow(
      "Codex app-server request timed out",
    );
    expect(f.frames).toMatchObject([{ method: "turn/start" }]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    f.setRespond(true);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });

  it("cleans up an unwritten request when stdin.write throws", async () => {
    const f = await fixture();
    vi.spyOn(f.child.stdin, "write").mockImplementationOnce(() => {
      throw new Error("fixture-write-failure");
    });
    await expect(f.session.request("turn/start", {})).rejects.toThrow("fixture-write-failure");
    expect(f.frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(f.session.request("thread/read", {})).resolves.toEqual({ accepted: true });
  });
});

describe("Codex app-server frame limits", () => {
  const mebibyte = 1024 * 1024;
  const responseLimit = 64 * mebibyte;

  it("decodes a large fragmented response and the small response that follows it", async () => {
    const f = await fixture();
    f.setRespond(false);
    const textBytes = 5 * mebibyte;
    const resumed = f.session.request("thread/resume", {}).then((result) => {
      const text = (result as { text: string }).text;
      return { length: text.length, lastCharacters: text.slice(-2) };
    });
    const next = f.session.request("thread/read", {});
    const received = Promise.all([
      expect(resumed).resolves.toEqual({ length: textBytes + 1, lastCharacters: "x续" }),
      expect(next).resolves.toEqual({ small: true }),
    ]);
    const [resume, read] = f.frames;

    f.child.stdout.write(Buffer.from(`{"id":${resume!.id},"result":{"text":"`));
    const padding = Buffer.alloc(64 * 1024, "x");
    for (let written = 0; written < textBytes; written += padding.length)
      f.child.stdout.write(padding);
    const utf8 = Buffer.from("续");
    f.child.stdout.write(utf8.subarray(0, 2));
    f.child.stdout.write(
      Buffer.concat([
        utf8.subarray(2),
        Buffer.from(`"}}\n{"id":${read!.id},"result":{"small":true}}\n`),
      ]),
    );

    await received;
    expect(f.session.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a terminated response above 64 MiB and clears all pending requests", async () => {
    const f = await fixture();
    f.setRespond(false);
    const first = f.session.request("thread/resume", {});
    const second = f.session.request("thread/read", {});
    const rejected = Promise.all([
      expect(first).rejects.toThrow(/^Codex response exceeds the frame limit$/),
      expect(second).rejects.toThrow(/^Codex response exceeds the frame limit$/),
    ]);
    const prefix = Buffer.from(`{"id":${f.frames[0]!.id},"result":"`);
    const padding = Buffer.alloc(mebibyte, "x");
    f.child.stdout.write(prefix);
    for (let written = prefix.length; written < responseLimit; written += padding.length)
      f.child.stdout.write(padding.subarray(0, Math.min(padding.length, responseLimit - written)));
    const connectedAtLimit = f.session.connected;
    f.child.stdout.write(Buffer.from('"}\n'));

    await rejected;
    expect(connectedAtLimit).toBe(true);
    expect(f.session.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an oversized unterminated tail immediately after a valid response", async () => {
    const f = await fixture();
    f.setRespond(false);
    const first = f.session.request("thread/read", {});
    const second = f.session.request("thread/resume", {});
    const received = Promise.all([
      expect(first).resolves.toEqual({ small: true }),
      expect(second).rejects.toThrow(/^Codex response exceeds the frame limit$/),
    ]);
    const valid = Buffer.from(`{"id":${f.frames[0]!.id},"result":{"small":true}}\n`);
    const batch = Buffer.allocUnsafe(valid.length + responseLimit + 1);
    valid.copy(batch);
    batch.fill(0x78, valid.length);
    f.child.stdout.write(batch);

    const connectedAfterBatch = f.session.connected;
    await Promise.all([received, vi.advanceTimersByTimeAsync(12_000)]);
    expect(connectedAfterBatch).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the outgoing request limit at 4 MiB", async () => {
    const f = await fixture();
    const text = "x".repeat(4 * mebibyte);
    await expect(f.session.request("turn/start", { text })).rejects.toThrow(
      /^Codex request exceeds the frame limit$/,
    );
    expect(f.frames).toEqual([]);
    expect(f.session.connected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Codex app-server shutdown completion", () => {
  it("shares concurrent close completion and clears the graceful timer after real close", async () => {
    const f = await fixture();
    const first = f.session.close();
    const second = f.session.close();
    expect(second).toBe(first);
    const settled = vi.fn();
    void second.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    await expect(f.session.request("thread/read", {})).rejects.toThrow("session closed");
    f.finish();
    await Promise.all([first, second]);
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for stdio close after the exit code becomes available", async () => {
    const f = await fixture();
    f.child.exitCode = 0;
    const settled = vi.fn();
    const closing = f.session.close().then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    f.finish();
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not miss a close emitted synchronously while ending stdin", async () => {
    const f = await fixture();
    vi.spyOn(f.child.stdin, "end").mockImplementationOnce(() => {
      f.finish();
      return f.child.stdin;
    });
    const settled = vi.fn();
    const closing = f.session.close().then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    await closing;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps Windows termination pending until the command tree closes", async () => {
    useWindows();
    const f = await fixture();
    const settled = vi.fn();
    const closing = f.session.close().then(settled);
    await vi.advanceTimersByTimeAsync(2999);
    expect(tree.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tree.terminate).toHaveBeenCalledOnce();
    expect(tree.close).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    f.finish();
    await closing;
    expect(tree.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an unconfirmed termination after the bounded kill confirmation", async () => {
    useWindows();
    const f = await fixture();
    const closing = f.session.close();
    const rejection = expect(closing).rejects.toThrow(
      "Codex app-server process did not close after termination",
    );
    await vi.advanceTimersByTimeAsync(4000);
    await rejection;
    expect(tree.terminate).toHaveBeenCalledOnce();
    expect(tree.close).toHaveBeenCalledOnce();
    expect(f.session.close()).toBe(closing);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits a reader session already closing after its metadata response", async () => {
    const f = childFixture();
    const reader = new CodexAppServerReader({});
    const reading = reader.readThread("/synthetic/codex", "/workspace", "/home", "thread");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames).toMatchObject([
      { method: "initialize" },
      { method: "initialized" },
      { method: "thread/read" },
    ]);
    reader.close();
    const closing = reader.closeAsync();
    expect(reader.closeAsync()).toBe(closing);
    const settled = vi.fn();
    void closing.then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    f.finish();
    await Promise.all([reading, closing]);
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes a reader session whose initialize response is still pending", async () => {
    const f = childFixture();
    f.setRespond(false);
    const reader = new CodexAppServerReader({});
    const reading = reader.readThread("/synthetic/codex", "/workspace", "/home", "thread");
    const rejection = expect(reading).rejects.toThrow("Codex app-server session closed");
    const settled = vi.fn();
    const closing = reader.closeAsync().then(settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    expect(f.frames).toMatchObject([{ method: "initialize" }]);
    f.finish();
    await Promise.all([closing, rejection]);
    expect(settled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a reader shutdown failure when synchronous close starts it first", async () => {
    useWindows();
    childFixture();
    const reader = new CodexAppServerReader({});
    const reading = reader.readThread("/synthetic/codex", "/workspace", "/home", "thread");
    const readFailure = expect(reading).rejects.toThrow(
      "Codex app-server process did not close after termination",
    );
    await vi.advanceTimersByTimeAsync(0);
    reader.close();
    const closeFailure = expect(reader.closeAsync()).rejects.toThrow(
      "Codex app-server process did not close after termination",
    );
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all([readFailure, closeFailure]);
    await expect(
      reader.readThread("/synthetic/codex", "/workspace", "/home", "thread"),
    ).rejects.toThrow("reader is closed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
