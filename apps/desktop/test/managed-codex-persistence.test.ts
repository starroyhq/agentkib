import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import {
  ManagedCodexEventBridge,
  ManagedCodexState,
} from "../../../packages/backend/src/managed-codex-state";
import {
  createManagedSnapshotWriter,
  readManagedRecord,
  saveManagedRecord,
} from "../../../packages/backend/src/managed-ledger";

const record = {
  id: "managed",
  workspace_id: "workspace",
  workspace: "/fixture",
  home: "/fixture/home",
  native_id: "thread",
  snapshot: { revision: 0 },
};
function fixture(
  persist = vi.fn((_state: ManagedCodexState, _event?: Record<string, unknown>) => {}),
) {
  const session = Object.assign(new EventEmitter(), {
    connected: true,
    respond: vi.fn(),
    respondError: vi.fn(),
    close: vi.fn(async () => {}),
  });
  const state = new ManagedCodexState(record);
  const publish = vi.fn();
  const bridge = new ManagedCodexEventBridge(
    session as unknown as CodexAppServerSession,
    state,
    persist,
    publish,
  );
  const notify = (method: string, params = {}) =>
    session.emit("notification", {
      method,
      params: { threadId: "thread", turnId: "turn", ...params },
    });
  const start = () => notify("turn/started", { turn: { id: "turn", status: "inProgress" } });
  const delta = (text = "token ") => notify("item/agentMessage/delta", { delta: text });
  return { session, state, persist, publish, bridge, notify, start, delta };
}
afterEach(() => vi.useRealTimers());

describe("managed Codex stream checkpoints", () => {
  it("publishes each delta immediately while checkpointing only once per 250 ms", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    for (let i = 0; i < 4000; i += 1) f.delta("x");
    expect((await f.bridge.snapshot("boot", true)).streamText).toHaveLength(4000);
    expect(f.publish).toHaveBeenCalledTimes(4001);
    expect(f.persist).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(f.persist).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.persist).toHaveBeenCalledTimes(2);
    await f.bridge.close();
    expect(f.persist).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "failed", "interrupted"])(
    "persists %s immediately with preceding stream text",
    async (status) => {
      vi.useFakeTimers();
      const persisted: Record<string, unknown>[] = [];
      const f = fixture(
        vi.fn((state) => {
          persisted.push(state.snapshot("", false));
        }),
      );
      f.start();
      f.delta("answer");
      f.notify("turn/completed", { turn: { id: "turn", status } });
      await f.bridge.snapshot("boot", true);
      expect(persisted).toHaveLength(2);
      expect(persisted.at(-1)).toMatchObject({ streamText: "answer" });
      expect(persisted.at(-1)?.status).not.toBe("running");
      expect(vi.getTimerCount()).toBe(0);
      await f.bridge.close();
    },
  );

  it("persists approval and disconnect boundaries without waiting for the timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    f.delta();
    f.session.emit("serverRequest", {
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "command",
        command: "pwd",
        cwd: "/fixture",
      },
    });
    expect(await f.bridge.snapshot("boot", true)).toMatchObject({ status: "awaiting-approval" });
    expect(f.persist).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    f.session.emit("close");
    await f.bridge.snapshot("boot", true);
    expect(f.persist).toHaveBeenCalledTimes(3);
    await f.bridge.close();
  });

  it("flushes queued deltas when closed and ignores later native events", async () => {
    vi.useFakeTimers();
    const persisted: Record<string, unknown>[] = [];
    const f = fixture(
      vi.fn((state) => {
        persisted.push(state.snapshot("", false));
      }),
    );
    f.start();
    f.delta("before-close");
    await f.bridge.close();
    expect(persisted.at(-1)).toMatchObject({ streamText: "before-close" });
    expect(vi.getTimerCount()).toBe(0);
    f.delta("late");
    await f.bridge.flush();
    expect(f.state.snapshot("", false).streamText).toBe("before-close");
    expect(f.session.close).toHaveBeenCalledOnce();
  });

  it("never overwrites a newer identity when a delayed checkpoint loses CAS", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(tmpdir(), "agentkib-stream-cas-"));
    try {
      saveManagedRecord(dir, record);
      const f = fixture(vi.fn(createManagedSnapshotWriter(dir, record)));
      f.start();
      f.delta("pending");
      await f.bridge.snapshot("boot", true);
      const replacement = { ...record, native_id: "other-thread", snapshot: { revision: 100 } };
      saveManagedRecord(dir, replacement);
      await vi.advanceTimersByTimeAsync(250);
      expect(readManagedRecord(dir, record.id)).toEqual(replacement);
      await f.bridge.close();
      expect(readManagedRecord(dir, record.id)).toEqual(replacement);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the UTF-8 preview bound, including split surrogate pairs, without redundant updates", () => {
    const state = new ManagedCodexState(record);
    const apply = (delta: string) =>
      state.apply({
        method: "item/agentMessage/delta",
        params: { threadId: "thread", turnId: "turn", delta },
      });
    state.apply({
      method: "turn/started",
      params: { threadId: "thread", turn: { id: "turn", status: "inProgress" } },
    });
    apply("x".repeat(128 * 1024 - 4));
    apply("\ud83d");
    apply("\ude00");
    const text = state.snapshot("", true).streamText as string;
    expect(Buffer.byteLength(text, "utf8")).toBe(128 * 1024);
    expect(text.endsWith("😀")).toBe(true);
    expect(apply("").changed).toBe(false);
    expect(apply("x").changed).toBe(false);
  });
});
