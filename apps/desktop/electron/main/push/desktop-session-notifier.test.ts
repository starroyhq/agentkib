import { expect, it, vi } from "vitest";
import type { HomeSession } from "@agentkib/session-catalog";
import { DesktopSessionNotifier } from "./desktop-session-notifier";

const session = (status: string, extra: Partial<HomeSession> = {}): HomeSession => ({
  id: "session",
  title: "  Workspace conversation\n ",
  notificationTitle: "  Workspace conversation\n ",
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

it("suppresses delivery for the displayed conversation and uses a minimal card elsewhere", async () => {
  const { notifier, platform, state } = fixture();
  state.watching = "session";
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await notifier.observeInteractions("session", { approval: ["a"] });
  expect(platform.show).not.toHaveBeenCalled();
  state.watching = "another-session";
  notifier.update([session("running")]);
  notifier.update([session("waiting-input")]);
  await notifier.observeInteractions("session", { question: ["q"] });
  expect(platform.show.mock.calls[0]?.[0]).toEqual({
    sessionId: "session",
    title: "Workspace conversation",
    body: "等待回答",
    silent: true,
  });
  notifier.update([session("waiting-input")]);
  await notifier.observeInteractions("session", { question: ["q"] });
  expect(platform.show).toHaveBeenCalledOnce();
});

it("dismisses confirmed interaction clearance and retains the card when evidence is missing", async () => {
  const { notifier, platform } = fixture();
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await notifier.observeInteractions("session", { approval: ["a"] });
  expect(platform.show).toHaveBeenCalledOnce();
  notifier.update(undefined);
  notifier.update([session("unavailable")]);
  notifier.update([
    session("idle", { continuation: { status: "idle", reason: "control-outcome-unconfirmed" } }),
  ]);
  expect(platform.dismiss).not.toHaveBeenCalled();
  await notifier.update([session("running")]);
  expect(platform.dismiss).not.toHaveBeenCalled();
  await notifier.observeInteractions("session", { approval: [] });
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});

it("waits for a fresh result, then clears only the matching acknowledgement", async () => {
  const { notifier, platform } = fixture();
  notifier.update([session("running", { readState: result("old") })]);
  notifier.update([session("idle", { readState: result("old") })]);
  notifier.update([session("idle", { readState: result("new", "unread", "stale") })]);
  await notifier.refresh();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([session("idle", { readState: result("new"), indexedSessionId: "native" })]);
  await notifier.refresh();
  expect(platform.show.mock.calls[0]?.[0]?.body).toBe("已完成");
  notifier.acknowledge("native", "old");
  expect(platform.dismiss).not.toHaveBeenCalled();
  notifier.acknowledge("native", "new");
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
  notifier.update([session("idle", { readState: result("new") })]);
  await notifier.refresh();
  expect(platform.show).toHaveBeenCalledOnce();
});

it("drops quiet notices and honors the desktop toggle without waiting for a phone", async () => {
  const { notifier, platform, state } = fixture();
  notifier.update([session("running")]);
  state.deliver = false;
  notifier.update([session("waiting-input")]);
  await notifier.observeInteractions("session", { question: ["q"] });
  state.deliver = true;
  notifier.refresh();
  await notifier.refresh();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([session("running")]);
  notifier.update([session("awaiting-approval")]);
  await notifier.observeInteractions("session", { approval: ["a"] });
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
  await notifier.refresh();
  expect(platform.show).not.toHaveBeenCalled();
  workerStatus.mockResolvedValue({ worker: true, delegated: true });
  notifier.update([session("waiting-input")]);
  await notifier.observeInteractions("session", { question: ["q"] });
  expect(platform.show).not.toHaveBeenCalled();
  workerStatus.mockResolvedValue({ worker: true, delegated: false });
  notifier.refresh();
  await notifier.refresh();
  expect(platform.show.mock.calls[0]?.[0]?.body).toBe("等待回答");
  state.workerResults = true;
  await notifier.observeInteractions("session", { question: [] });
  notifier.update([session("running", { readState: result("one") })]);
  notifier.update([
    session("idle", {
      readState: { ...result("two"), latestResult: { id: "two", outcome: "failed" } },
    }),
  ]);
  await notifier.refresh();
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
  const delivery = notifier.observeInteractions("session", { approval: ["a"] });
  state.watching = "session";
  notifier.refresh();
  resolve({ worker: false, delegated: false });
  await delivery;
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
  await notifier.refresh();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([
    { ...lead, orchestration: { role: "lead", reports: 1 } },
    { ...worker, continuation: { status: "idle" } },
  ]);
  await notifier.refresh();
  expect(platform.show).not.toHaveBeenCalled();
  notifier.update([lead, { ...worker, continuation: { status: "idle" } }]);
  await notifier.refresh();
  expect(platform.show.mock.calls[0]?.[0]?.sessionId).toBe("session");
  notifier.update([{ ...lead, readState: result("lead-result", "read") }]);
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});

it.each([
  ["approval", "awaiting-approval", "等待审批"],
  ["question", "waiting-input", "等待回答"],
] as const)(
  "replaces a cleared %s with the next request even when the catalog state stays the same",
  async (kind, status, body) => {
    const { notifier, platform } = fixture();
    await notifier.update([session(status)]);
    await notifier.observeInteractions("session", { [kind]: ["old"] });
    await notifier.observeInteractions("session", { [kind]: ["old", "new"] });
    expect(platform.show).toHaveBeenCalledOnce();
    expect(platform.dismiss).not.toHaveBeenCalled();

    await notifier.observeInteractions("session", { [kind]: ["new"] });
    expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
    expect(platform.show.mock.calls.map(([notice]) => notice.body)).toEqual([body, body]);
    expect(platform.dismiss.mock.invocationCallOrder[0]).toBeLessThan(
      platform.show.mock.invocationCallOrder[1]!,
    );
    await notifier.observeInteractions("session", { [kind]: ["new"] });
    expect(platform.show).toHaveBeenCalledTimes(2);
  },
);

it("retains the card while the transcript is temporarily unreadable", async () => {
  const { notifier, platform } = fixture();
  await notifier.update([session("awaiting-approval")]);
  await notifier.observeInteractions("session", { approval: ["a"] });
  expect(platform.show).toHaveBeenCalledOnce();

  await notifier.update([session("awaiting-approval", { availability: "metadata-only" })]);
  await notifier.observeInteractions("session", {});
  expect(platform.dismiss).not.toHaveBeenCalled();
  await notifier.update([session("awaiting-approval")]);
  await notifier.observeInteractions("session", { approval: ["a"] });
  expect(platform.show).toHaveBeenCalledOnce();

  await notifier.observeInteractions("session", { approval: [] });
  expect(platform.dismiss).toHaveBeenCalledExactlyOnceWith("session");
});

it("announces a new ledger result even when a short turn never appears running", async () => {
  const { notifier, platform } = fixture();
  await notifier.update([session("idle", { readState: result("old") })]);
  expect(platform.show).not.toHaveBeenCalled();
  await notifier.update([session("idle", { readState: result("new") })]);
  expect(platform.show.mock.calls.map(([notice]) => notice.body)).toEqual(["已完成"]);
  await notifier.update([session("idle", { readState: result("new") })]);
  expect(platform.show).toHaveBeenCalledOnce();
});

it("uses the Agent and workspace for a title derived from the first message", async () => {
  const { notifier, platform } = fixture();
  await notifier.update([
    session("awaiting-approval", {
      agent: "claude-code",
      title: "private synthetic first message",
      notificationTitle: undefined,
      workspaceName: "Test Workspace",
    }),
  ]);
  await notifier.observeInteractions("session", { approval: ["a"] });
  expect(platform.show.mock.calls[0]?.[0]).toMatchObject({
    title: "Claude Code · Test Workspace",
    body: "等待审批",
  });
});
