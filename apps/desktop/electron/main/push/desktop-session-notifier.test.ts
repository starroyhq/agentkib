import { expect, it, vi } from "vitest";
import type { HomeSession } from "@agentkib/session-catalog";
import { DesktopSessionNotifier } from "./desktop-session-notifier";

const session = (status: string, extra: Partial<HomeSession> = {}): HomeSession => ({
  id: "session",
  title: "  Workspace conversation\n ",
  workspace_id: "work",
  agent: "codex",
  availability: "readable",
  updated_at: "2026-11-28T10:00:00Z",
  continuation: { status },
  ...extra,
});

function result(id: string, status = "unread", freshness = "current") {
  return {
    status,
    freshness,
    latestResult: { id, outcome: "completed" },
    firstUnread: status === "unread" ? { type: "result" } : null,
  };
}

function fixture() {
  const platform = {
    show: vi.fn(
      async (
        _notice: { title: string; body: string; sessionId: string; silent: boolean },
        valid?: () => boolean,
      ) => valid?.() ?? true,
    ),
    dismiss: vi.fn(async (_id: string) => {}),
  };
  const state = {
    enabled: true,
    watching: undefined as string | undefined,
    deliver: true,
    workerResults: false,
  };
  const workerStatus = vi.fn(async (_ids: readonly string[], _kind: string) => ({
    worker: false,
    delegated: false,
  }));
  const notifier = new DesktopSessionNotifier({
    platform,
    enabled: () => state.enabled,
    delivery: () => state.deliver,
    workerResults: () => state.workerResults,
    workerStatus,
    isViewing: (id) => id === state.watching,
    silent: () => true,
    locale: () => "zh-CN",
  });
  return { notifier, platform, state, workerStatus };
}

async function deliver() {
  // Let the worker verification and the presentation settle without an OS notification.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

it("suppresses delivery for the displayed conversation and uses a minimal card elsewhere", async () => {
  const { notifier, platform, state } = fixture();
  state.watching = "session";
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  state.watching = "another-session";
  notifier.update([session("running")]);
  notifier.update([session("waiting-input")]);
  await deliver();
  expect(platform.show.mock.calls[0]?.[0]).toEqual({
    sessionId: "session",
    title: "Workspace conversation",
    body: "等待回答",
    silent: true,
  });
  notifier.update([session("waiting-input")]);
  await deliver();
  expect(platform.show).toHaveBeenCalledOnce();
});

it("dismisses confirmed interaction clearance and retains the card when evidence is missing", async () => {
  const { notifier, platform } = fixture();
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await deliver();
  expect(platform.show).toHaveBeenCalledOnce();
  notifier.update(undefined);
  notifier.update([session("unavailable")]);
  notifier.update([
    session("idle", { continuation: { status: "idle", reason: "control-outcome-unconfirmed" } }),
  ]);
  expect(platform.dismiss).not.toHaveBeenCalled();
  notifier.update([session("running")]);
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});

it("waits for a fresh result, then clears only the matching acknowledgement", async () => {
  const { notifier, platform } = fixture();
  notifier.update([session("running", { readState: result("old") })]);
  notifier.update([session("idle", { readState: result("old") })]);
  notifier.update([session("idle", { readState: result("new", "unread", "stale") })]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([session("idle", { readState: result("new"), indexedSessionId: "native" })]);
  await deliver();
  expect(platform.show.mock.calls[0]?.[0]?.body).toBe("已完成");
  notifier.acknowledge("native", "old");
  expect(platform.dismiss).not.toHaveBeenCalled();
  notifier.acknowledge("native", "new");
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
  notifier.update([session("idle", { readState: result("new") })]);
  await deliver();
  expect(platform.show).toHaveBeenCalledOnce();
});

it("drops quiet notices and honors the desktop toggle without waiting for a phone", async () => {
  const { notifier, platform, state } = fixture();
  notifier.update([session("running")]);
  state.deliver = false;
  notifier.update([session("waiting-input")]);
  state.deliver = true;
  notifier.refresh();
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await deliver();
  expect(platform.show).toHaveBeenCalledOnce();
  state.enabled = false;
  notifier.refresh();
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});

it("honors verified Worker role, personal questions and the shared result opt-in", async () => {
  const { notifier, platform, state, workerStatus } = fixture();
  workerStatus.mockResolvedValue({ worker: true, delegated: false });
  notifier.update([session("running")]);
  notifier.update([session("idle", { readState: result("one") })]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  workerStatus.mockResolvedValue({ worker: true, delegated: true });
  notifier.update([session("waiting-input")]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  workerStatus.mockResolvedValue({ worker: true, delegated: false });
  notifier.refresh();
  await deliver();
  expect(platform.show.mock.calls[0]?.[0]?.body).toBe("等待回答");
  state.workerResults = true;
  notifier.update([session("running", { readState: result("one") })]);
  notifier.update([
    session("idle", {
      readState: { ...result("two"), latestResult: { id: "two", outcome: "failed" } },
    }),
  ]);
  await deliver();
  expect(platform.show.mock.calls[1]?.[0]?.body).toBe("失败");
});

it("drops a notice when the session is brought to the foreground during verification", async () => {
  const { notifier, platform, state, workerStatus } = fixture();
  let resolve!: (role: { worker: boolean; delegated: boolean }) => void;
  workerStatus.mockReturnValueOnce(
    new Promise((res) => {
      resolve = res;
    }),
  );
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  state.watching = "session";
  notifier.refresh();
  resolve({ worker: false, delegated: false });
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
});

it("holds the lead's result while a Worker runs or reports are pending", async () => {
  const { notifier, platform } = fixture();
  const worker = session("running", {
    id: "worker",
    orchestration: { role: "worker", leadId: "session" },
  });
  notifier.update([session("running", { orchestration: { role: "lead" } }), worker]);
  const lead = session("idle", {
    orchestration: { role: "lead" },
    readState: result("lead-result"),
  });
  notifier.update([lead, worker]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([
    { ...lead, orchestration: { role: "lead", reports: 1 } },
    { ...worker, continuation: { status: "idle" } },
  ]);
  await deliver();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([lead, { ...worker, continuation: { status: "idle" } }]);
  await deliver();
  expect(platform.show.mock.calls[0]?.[0]?.sessionId).toBe("session");
  notifier.update([{ ...lead, readState: result("lead-result", "read") }]);
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});
