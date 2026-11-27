import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerSession } from "../../../packages/backend/src/agents/codex/codex-app-server";
import {
  CodexExternalTurns,
  type EndedTurn,
} from "../../../packages/backend/src/agents/codex/codex-external-turns";
import {
  verifyCodexWorkerCompletion,
  workerCompletionSnapshot,
} from "../../../packages/backend/src/agents/codex/codex-worker-completion";
import {
  ManagedCodexEventBridge,
  ManagedCodexState,
} from "../../../packages/backend/src/agents/codex/managed-codex-state";

const threadId = "01234567-89ab-cdef-0123-456789abcdef";
const terminal: EndedTurn = {
  turnId: "turn-one",
  outcome: "completed",
  startedAt: "2026-11-26T08:14:00.000Z",
  endedAt: "2026-11-26T08:14:00.235Z",
};
const completed = {
  id: terminal.turnId,
  status: "completed",
  completedAt: Date.parse(terminal.endedAt!) / 1000,
  durationMs: 235,
};

async function workerFixture() {
  const session = Object.assign(new EventEmitter(), {
    connected: true,
    request: vi.fn<CodexAppServerSession["request"]>(),
  });
  const persist = vi.fn();
  const onApplied = vi.fn();
  const endedTurns = vi.fn<(nativeId: string) => Promise<EndedTurn[]>>();
  const state = new ManagedCodexState({
    id: "managed",
    workspace_id: "workspace",
    workspace: "/fixture",
    native_id: threadId,
  });
  const bridge = new ManagedCodexEventBridge(
    session as unknown as CodexAppServerSession,
    state,
    persist,
    onApplied,
  );
  const notify = (method: string, turn: Record<string, unknown>) =>
    session.emit("notification", { method, params: { threadId, turn } });
  notify("turn/started", { id: "turn-one", status: "inProgress" });
  await bridge.flush();
  persist.mockClear();
  onApplied.mockClear();
  return {
    bridge,
    request: session.request,
    endedTurns,
    persist,
    onApplied,
    notify,
    observe: (now: number, owner = () => true) =>
      workerCompletionSnapshot(bridge, "boot", owner, endedTurns, now),
  };
}

describe("Codex managed Worker completion verification", () => {
  it("recovers a missing completion once through the live bridge and coalesces simultaneous reads", async () => {
    const worker = await workerFixture();
    const home = await mkdtemp(path.join(tmpdir(), "codex-worker-completion-"));
    const transcript = path.join(home, "rollout-fixture.jsonl");
    try {
      const rows = [
        {
          timestamp: terminal.startedAt,
          type: "event_msg",
          payload: { type: "task_started", turn_id: terminal.turnId },
        },
        {
          timestamp: terminal.endedAt,
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: terminal.turnId,
            last_agent_message: "Finished fixture",
          },
        },
      ];
      await writeFile(transcript, rows.map((row) => JSON.stringify(row) + "\n").join(""));
      const reader = new CodexExternalTurns(() => home);
      worker.endedTurns.mockImplementation((id) => reader.endedTurns(id, Date.now(), transcript));
      await expect(worker.observe(0)).resolves.toMatchObject({ status: "running" });
      await expect(worker.observe(19_999)).resolves.toMatchObject({ status: "running" });
      expect(worker.endedTurns).not.toHaveBeenCalled();

      const recovered = await Promise.all([worker.observe(20_000), worker.observe(20_001)]);
      expect(recovered).toEqual([
        expect.objectContaining({ status: "idle" }),
        expect.objectContaining({ status: "idle" }),
      ]);
    } finally {
      await rm(home, { recursive: true });
    }
    expect(worker.endedTurns).toHaveBeenCalledExactlyOnceWith(threadId);
    expect(worker.request).not.toHaveBeenCalled();
    expect(worker.persist).toHaveBeenCalledExactlyOnceWith(
      worker.bridge.state,
      expect.objectContaining({
        turn_id: completed.id,
        turn_meta: { outcome: "completed", duration_ms: 235 },
      }),
    );
    expect(worker.onApplied).toHaveBeenCalledExactlyOnceWith(
      { method: "turn/completed", params: { threadId, turn: completed } },
      expect.objectContaining({ changed: true, turnReply: "Finished fixture" }),
      worker.bridge.state,
    );
    worker.notify("turn/completed", completed);
    await worker.bridge.flush();
    expect(worker.onApplied).toHaveBeenCalledTimes(1);
  });

  it("leaves a stuck, active or unverified turn alone and spaces its read attempts", async () => {
    const worker = await workerFixture();
    worker.endedTurns
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...terminal, turnId: "turn-other" }])
      .mockResolvedValueOnce([{ ...terminal, endedAt: null }])
      .mockResolvedValueOnce([{ ...terminal, outcome: "cancelled", endedAt: "invalid date" }])
      .mockResolvedValueOnce([{ ...terminal, superseded: true }])
      .mockResolvedValueOnce([{ ...terminal, outcome: "cancelled" }]);
    for (const now of [0, 20_000, 20_001, 39_999, 40_000, 60_000, 80_000, 100_000]) {
      await expect(worker.observe(now)).resolves.toMatchObject({ status: "running" });
    }
    expect(worker.endedTurns).toHaveBeenCalledTimes(5);
    expect(worker.request).not.toHaveBeenCalled();
    expect(worker.onApplied).not.toHaveBeenCalled();

    await expect(worker.observe(120_000)).resolves.toMatchObject({ status: "idle" });
    expect(worker.onApplied).toHaveBeenCalledTimes(1);
  });

  it("discards a read which finishes after the resident writer changed", async () => {
    const worker = await workerFixture();
    let resolve!: (value: EndedTurn[]) => void;
    worker.endedTurns.mockReturnValue(
      new Promise((accept) => {
        resolve = accept;
      }),
    );
    let current = true;
    await worker.observe(0);
    const checking = worker.observe(20_000, () => current);
    current = false;
    resolve([terminal]);
    await expect(checking).resolves.toMatchObject({ status: "running" });
    expect(worker.onApplied).not.toHaveBeenCalled();
  });

  it("verifies an explicit recovery through the same reader and skips a revoked owner", async () => {
    const worker = await workerFixture();
    worker.endedTurns.mockResolvedValue([{ ...terminal, outcome: "cancelled" }]);
    await verifyCodexWorkerCompletion(worker.bridge, () => false, worker.endedTurns);
    expect(worker.bridge.state.turnId).toBe(terminal.turnId);
    expect(worker.endedTurns).not.toHaveBeenCalled();

    await verifyCodexWorkerCompletion(worker.bridge, () => true, worker.endedTurns);
    expect(worker.bridge.state.turnId).toBeNull();
    expect(worker.endedTurns).toHaveBeenCalledExactlyOnceWith(threadId);
    expect(worker.request).not.toHaveBeenCalled();
  });
});
