// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { NotificationActivitySnapshot } from "@agentkib/runtime-protocol";
import type { HomeSession } from "@agentkib/session-catalog";
import type { PushSendInput, PushSendResult } from "../web/relay/manager";
import { projectNotificationActivity } from "./activity";
import { openPushEnvelope } from "./envelope-fixture";
import {
  PushNotifier,
  type PushAlertContext,
  type PushNotifierOptions,
  type PushTarget,
} from "./notifier";

const DEVICE = "0123456789abcdef0123456789abcdef";
const MINUTE = 60_000;
const START = 1_762_900_000_000;
const seconds = (ms: number) => Math.floor(ms / 1000);
const phone = generateKeyPairSync("x25519");
const target: PushTarget = {
  session: "c".repeat(36),
  publicKey: phone.publicKey.export({ format: "jwk" }).x!,
  ref: "phone-ref-1",
  alerts: true,
  liveActivity: true,
  updatedAt: 1,
};

type State = "running" | "approval" | "question" | "completed" | "failed";
function session(id: string, state?: State, title = `Task ${id}`): HomeSession {
  const base = {
    id,
    agent: "codex",
    title,
    availability: "readable",
    workspace_id: "w",
    updated_at: "2026-11-11T10:00:00.000Z",
  };
  if (state === "running") return { ...base, continuation: { status: "running" } };
  if (state === "approval") return { ...base, continuation: { status: "awaiting-approval" } };
  if (state === "question") return { ...base, continuation: { status: "waiting-input" } };
  if (state === "completed" || state === "failed")
    return {
      ...base,
      readState: {
        status: "unread",
        firstUnread: { type: "agentMessage" },
        latestResult: { outcome: state },
      },
    };
  return base;
}

function requiringSupervision(
  session: HomeSession,
  role: "lead" | "worker" = "worker",
): HomeSession {
  const orchestration = { role, requiresUser: true };
  return { ...session, orchestration };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness(
  terminalSummary?: PushNotifierOptions["terminalSummary"],
  options: Partial<PushNotifierOptions> = {},
) {
  let clock = START;
  const context = {
    present: false,
    targets: [target] as PushTarget[],
    deviceId: DEVICE as string | undefined,
    answers: [] as PushSendResult[],
    sent: [] as PushSendInput[],
  };
  const send = vi.fn(async (input: PushSendInput) => {
    context.sent.push(input);
    return context.answers.shift() ?? { delivered: true as const };
  });
  const notifier = new PushNotifier({
    targets: () => context.targets,
    deviceId: () => context.deviceId,
    send,
    terminalSummary,
    activitySnapshot: async (_target, sessions) =>
      projectNotificationActivity(
        sessions,
        { workspaceIds: ["w"], versionScope: "fixture" },
        clock,
      ),
    computerName: async () => "Studio",
    present: () => context.present,
    now: () => clock,
    // Tests drive every check through update and refresh.
    tickMs: 24 * 60 * MINUTE,
    ...options,
  });
  return {
    ...context,
    context,
    notifier,
    send,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
    },
    /** Sends made since the last call. */
    take() {
      return context.sent.splice(0);
    },
  };
}

function alertOf(input: PushSendInput) {
  if (input.kind !== "alert") throw new Error("not an alert");
  return openPushEnvelope(input.envelope, phone.privateKey, target.publicKey, DEVICE);
}

const approval: PushAlertContext = {
  interaction: {
    version: 1,
    kind: "approval",
    binding: {
      sessionId: "a",
      runtimeBootId: "runtime-boot",
      turnId: "turn-a",
      requestId: 8,
      revision: 3,
    },
    summary: "Runs the requested check",
    risk: { level: "high", reason: "unknown-operation" },
    decisions: [
      { id: "choice:allow", kind: "allow", scope: "once", available: true, lockScreen: true },
    ],
  },
  action: {
    requestId: "receipt-a",
    bootId: "host-boot",
    expiresAt: START + 10 * MINUTE,
    choices: { "choice:allow": "token-a" },
  },
};

describe("push alerts", () => {
  it.each(["device", "targets"])(
    "delivers a held alert once after recovering the relay %s",
    async (missing) => {
      let recovering = true;
      const test = harness(undefined, { recoveringTargets: () => (recovering ? [target] : []) });
      test.context.deviceId = missing === "device" ? undefined : DEVICE;
      test.context.targets = missing === "targets" ? [] : [target];
      test.notifier.update([session("a", "running")]);
      test.notifier.update([session("a", "approval")]);
      await settle();
      expect(test.take()).toEqual([]);

      recovering = false;
      test.context.deviceId = DEVICE;
      test.context.targets = [target, { ...target, session: "d".repeat(36) }];
      test.notifier.refresh();
      test.notifier.refresh();
      await settle();
      expect(test.take().map((input) => input.session)).toEqual([target.session]);
      test.notifier.update([session("a", "approval")]);
      await settle();
      expect(test.take()).toEqual([]);
    },
  );

  it("does not forward a held alert to a replaced subscription", async () => {
    let recovering = true;
    const test = harness(undefined, { recoveringTargets: () => (recovering ? [target] : []) });
    test.context.targets = [];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);

    recovering = false;
    test.context.targets = [{ ...target, updatedAt: target.updatedAt + 1 }];
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("reauthorizes only unsent recipients when the relay recovers during an authorization read", async () => {
    const second = { ...target, session: "d".repeat(36) };
    let finish: (value: PushAlertContext | undefined) => void = () => {};
    const reading = new Promise<PushAlertContext | undefined>((resolve) => (finish = resolve));
    let recovering = false;
    const authorize = vi.fn<NonNullable<PushNotifierOptions["alertContext"]>>(async () => ({}));
    authorize.mockImplementationOnce(async () => ({})).mockImplementationOnce(() => reading);
    const test = harness(undefined, {
      recoveringTargets: () => (recovering ? [target, second] : []),
      alertContext: authorize,
    });
    test.context.targets = [target, second];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    expect(test.take().map((input) => input.session)).toEqual([target.session]);

    recovering = true;
    test.context.deviceId = undefined;
    test.context.targets = [];
    test.notifier.refresh();
    recovering = false;
    test.context.deviceId = DEVICE;
    test.context.targets = [target, second];
    test.notifier.refresh();
    finish(undefined);
    await settle();
    test.notifier.refresh();
    await settle();
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(test.take().map((input) => input.session)).toEqual([second.session]);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("seals the R25 interaction and direct decision only for an opted-in phone", async () => {
    const context = vi.fn(async () => approval);
    const test = harness(undefined, { alertContext: context });
    test.context.targets = [
      { ...target, approvalActions: 1, liveActivity: false },
      { ...target, session: "d".repeat(36), ref: "legacy-phone", liveActivity: false },
    ];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    const sent = test.take();
    expect(sent).toHaveLength(2);
    expect(alertOf(sent[0]!)).toMatchObject({
      kind: "approval",
      interaction: approval.interaction,
      action: approval.action,
    });
    expect(alertOf(sent[1]!)).toEqual({
      v: 1,
      kind: "approval",
      ref: "legacy-phone",
      sessionId: "a",
      agent: "codex",
      title: "Task a",
      computer: "Studio",
      at: START,
    });
    expect(JSON.stringify(sent)).not.toContain("token-a");
  });

  it("rechecks changed delivery policy, then sends held work without repeating a sent notification", async () => {
    let delivery: "send" | "hold" | "drop" = "send";
    let finish: (value: PushAlertContext) => void = () => {};
    const secondRead = new Promise<PushAlertContext>((resolve) => (finish = resolve));
    const second = { ...target, session: "d".repeat(36), ref: "another-phone" };
    const context = vi.fn(async (recipient: PushTarget) =>
      recipient.session === second.session ? secondRead : approval,
    );
    const test = harness(undefined, { alertContext: context, delivery: () => delivery });
    test.context.targets = [target, second];
    test.context.present = true;
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    expect(test.take().map(({ session }) => session)).toEqual([target.session]);
    delivery = "hold";
    finish(approval);
    await settle();
    expect(test.take()).toEqual([]);
    delivery = "send";
    test.notifier.refresh();
    await settle();
    expect(test.take().map(({ session }) => session)).toEqual([second.session]);
    test.notifier.update([session("a", "running")]);
    delivery = "drop";
    test.notifier.update([session("a", "question")]);
    delivery = "send";
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("suppresses the entire notification if access fails or the subscription changes during its read", async () => {
    let finish: (value: PushAlertContext | undefined) => void = () => {};
    const pending = new Promise<PushAlertContext | undefined>((resolve) => (finish = resolve));
    const removed = { ...target, session: "d".repeat(36), ref: "removed-device" };
    const test = harness(undefined, {
      alertContext: async (recipient) =>
        recipient.session === removed.session ? pending : undefined,
    });
    test.context.targets = [target, removed];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    test.context.targets = [target];
    test.notifier.refresh();
    finish(approval);
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("uses a bounded legacy alert if optional interaction data exceeds the APNs envelope budget", async () => {
    const test = harness(undefined, {
      alertContext: async () => ({
        ...approval,
        interaction: { ...approval.interaction!, summary: "🧪".repeat(2_000) },
      }),
    });
    test.context.targets = [{ ...target, approvalActions: 1 }];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    const sent = test.take();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "alert" });
    expect(sent[0]?.kind === "alert" && sent[0].envelope.length).toBeLessThanOrEqual(3_000);
    expect(alertOf(sent[0]!)).toMatchObject({ kind: "approval", title: "Task a" });
    expect(alertOf(sent[0]!)).not.toHaveProperty("action");
  });

  it("falls back to the terminal summary for authorized legacy alerts and skips revoked subscriptions", async () => {
    const denied = { ...target, session: "d".repeat(36), ref: "denied-phone" };
    const revoked = { ...target, session: "e".repeat(36), ref: "revoked-phone" };
    let finish: (summary: string) => void = () => {};
    const pending = new Promise<string>((resolve) => (finish = resolve));
    const summary = vi.fn<NonNullable<PushNotifierOptions["terminalSummary"]>>(async (recipient) =>
      recipient === revoked ? pending : "Which output?",
    );
    const test = harness(summary, {
      alertContext: async (recipient) => (recipient === denied ? undefined : {}),
    });
    test.context.targets = [target, denied, revoked];
    const terminal = (state: "running" | "question") => {
      const base = session("terminal", state);
      return {
        ...base,
        agent: "claude-code",
        continuation: { ...base.continuation!, executionLocation: "terminal" },
      };
    };
    test.notifier.update([terminal("running")]);
    test.notifier.update([terminal("question")]);
    await settle();
    expect(summary.mock.calls).toEqual([
      [target, "terminal", "question"],
      [revoked, "terminal", "question"],
    ]);
    const encrypted = test.take();
    expect(encrypted.map(({ session }) => session)).toEqual([target.session]);
    expect(encrypted.map(alertOf)).toEqual([
      expect.objectContaining({ kind: "question", readOnly: true, summary: "Which output?" }),
    ]);
    test.context.targets = [target, denied];
    test.notifier.refresh();
    finish("Must not be sent");
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("distinguishes a missing terminal preview from access lost during the fallback read", async () => {
    let allowed = true;
    let finish: (summary: undefined) => void = () => {};
    const pending = new Promise<undefined>((resolve) => (finish = resolve));
    const test = harness(async () => pending, {
      alertContext: async () => (allowed ? {} : undefined),
    });
    const terminal = {
      ...session("terminal", "question"),
      agent: "claude-code",
      continuation: { status: "waiting-input", executionLocation: "terminal" },
    };
    test.notifier.update([session("terminal", "running")]);
    test.notifier.update([terminal]);
    await settle();
    allowed = false;
    finish(undefined);
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("encrypts terminal wait summaries, opens the original session and deduplicates snapshots", async () => {
    const lookup = vi.fn<NonNullable<PushNotifierOptions["terminalSummary"]>>(
      async (_target, _id, kind) => (kind === "question" ? "Which output?" : "Edit the test file"),
    );
    const test = harness(lookup);
    const terminal = (state: "running" | "approval" | "question"): HomeSession => {
      const base = session("terminal-session", state);
      return {
        ...base,
        agent: "claude-code",
        continuation: { ...base.continuation!, executionLocation: "terminal" },
      };
    };
    test.notifier.update([terminal("running")]);
    test.notifier.update([terminal("approval")]);
    test.notifier.update([terminal("approval")]);
    await settle();
    expect(lookup).not.toHaveBeenCalled();
    test.advance(8_000);
    test.notifier.refresh();
    await settle();
    expect(test.take().map(alertOf)).toEqual([
      expect.objectContaining({
        kind: "approval",
        sessionId: "terminal-session",
        summary: "Edit the test file",
        readOnly: true,
      }),
    ]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(target, "terminal-session", "approval");
    test.notifier.update([terminal("question")]);
    await settle();
    expect(test.take().map(alertOf)).toEqual([
      expect.objectContaining({ kind: "question", summary: "Which output?", readOnly: true }),
    ]);
  });

  it("uses the existing verification alert for new supervision incidents", async () => {
    const test = harness();
    const worker = session("worker", "failed");
    const lead = session("lead");
    const supervised = [requiringSupervision(worker), requiringSupervision(lead, "lead")];
    test.notifier.update([session("worker", "running"), lead]);
    test.notifier.update(supervised);
    await settle();
    expect(test.take().map((input) => alertOf(input))).toEqual([
      expect.objectContaining({ v: 1, kind: "verify", sessionId: "worker" }),
      expect.objectContaining({ v: 1, kind: "verify", sessionId: "lead" }),
    ]);

    test.notifier.update(supervised);
    await settle();
    expect(test.take()).toEqual([]);
    test.notifier.update([worker, lead]);
    test.notifier.update([requiringSupervision(worker), lead]);
    await settle();
    expect(test.take().map((input) => alertOf(input))).toEqual([
      expect.objectContaining({ kind: "verify", sessionId: "worker" }),
    ]);
  });

  it("keeps approval alerts and cancels a resolved supervision incident before sending", async () => {
    const test = harness();
    test.context.present = true;
    test.notifier.update([session("worker"), session("approval")]);
    test.notifier.update([
      requiringSupervision(session("worker")),
      requiringSupervision(session("approval", "approval")),
      requiringSupervision({ ...session("hidden"), origin: "auxiliary" }),
      requiringSupervision({ ...session("remote"), remote: true }),
    ]);
    await settle();
    expect(test.take()).toEqual([]);

    test.notifier.update([
      session("worker"),
      requiringSupervision(session("approval", "approval")),
      requiringSupervision({ ...session("hidden"), origin: "auxiliary" }),
      requiringSupervision({ ...session("remote"), remote: true }),
    ]);
    test.context.present = false;
    test.notifier.refresh();
    await settle();
    expect(test.take().map((input) => alertOf(input))).toEqual([
      expect.objectContaining({ kind: "approval", sessionId: "approval" }),
    ]);
  });

  it("alerts when a session starts waiting or a turn seen working ends", async () => {
    const test = harness();
    test.notifier.update([session("a", "running"), session("b"), session("c", "completed")]);
    await settle();
    // What was already so when the notifier started alerts nothing.
    expect(test.take()).toEqual([]);

    test.notifier.update([session("a", "approval"), session("b"), session("c", "completed")]);
    await settle();
    const [waiting] = test.take();
    expect(waiting).toMatchObject({ session: target.session, kind: "alert" });
    expect(waiting.collapseId).toMatch(/^s[0-9a-f]{32}$/);
    expect(alertOf(waiting)).toEqual({
      v: 1,
      ref: "phone-ref-1",
      kind: "approval",
      sessionId: "a",
      agent: "codex",
      title: "Task a",
      computer: "Studio",
      at: test.now(),
    });

    test.notifier.update([session("a", "running"), session("b"), session("c", "completed")]);
    test.notifier.update([session("a", "completed"), session("b"), session("c", "completed")]);
    await settle();
    const [ended] = test.take();
    expect(alertOf(ended)).toMatchObject({ kind: "completed", sessionId: "a" });
    // A later alert for the session replaces the earlier one on the phone.
    expect(ended.collapseId).toBe(waiting.collapseId);

    // A result that appears without the turn being seen, as when marking a session unread.
    test.notifier.update([session("a", "completed"), session("b", "failed")]);
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("waits while someone uses the computer and drops what moved on", async () => {
    const test = harness();
    test.context.present = true;
    test.notifier.update([
      session("a", "running"),
      session("b", "running"),
      session("c", "running"),
    ]);
    test.notifier.update([
      session("a", "question"),
      session("b", "failed"),
      session("c", "running"),
    ]);
    await settle();
    expect(test.take()).toEqual([]);
    // Someone answered the question at the computer.
    test.notifier.update([
      session("a", "running"),
      session("b", "failed"),
      session("c", "running"),
    ]);
    test.context.present = false;
    test.notifier.refresh();
    await settle();
    const sent = test.take();
    expect(sent.map((input) => alertOf(input))).toEqual([
      expect.objectContaining({ kind: "failed", sessionId: "b" }),
    ]);

    // An unseen result is not worth an alert after the person sat at the computer for long.
    test.context.present = true;
    test.notifier.update([
      session("a", "running"),
      session("b", "failed"),
      session("c", "completed"),
    ]);
    test.advance(16 * MINUTE);
    test.context.present = false;
    test.notifier.refresh();
    await settle();
    expect(test.take().filter((input) => input.kind === "alert")).toEqual([]);
  });

  describe("a Project Agent and its Workers", () => {
    const lead = (state?: State, role: Record<string, unknown> = {}, backgroundTasks = 0) => {
      const base = session("lead", state, "Release");
      return {
        ...base,
        agent: "claude-code",
        ...(backgroundTasks
          ? { continuation: { status: base.continuation?.status ?? "idle", backgroundTasks } }
          : {}),
        orchestration: {
          role: "lead",
          workers: 2,
          paused: false,
          reason: null,
          reports: 0,
          ...role,
        },
      };
    };
    const worker = (id: string, state?: State) => ({
      ...session(id, state),
      orchestration: { role: "worker", leadId: "lead", name: id },
    });
    // Live Activity updates aside.
    const alerts = (test: ReturnType<typeof harness>) =>
      test
        .take()
        .filter((input) => input.kind === "alert")
        .map((input) => {
          const { kind, sessionId } = alertOf(input) as { kind: string; sessionId: string };
          return `${kind}:${sessionId}`;
        });

    it("alerts once the Project Agent and all it set going stop; never for a Worker's turn", async () => {
      const test = harness();
      test.notifier.update([lead("running"), worker("w1"), worker("w2")]);
      // Its turn ends with both Workers running.
      test.notifier.update([lead("completed"), worker("w1", "running"), worker("w2", "running")]);
      // A Worker ends; its report is on its way, then starts a turn of the Project Agent.
      test.notifier.update([
        lead("completed", { reports: 1 }),
        worker("w1", "completed"),
        worker("w2", "running"),
      ]);
      test.notifier.update([lead("running"), worker("w1", "completed"), worker("w2", "running")]);
      test.notifier.update([lead("completed"), worker("w1", "completed"), worker("w2", "running")]);
      await settle();
      expect(alerts(test)).toEqual([]);
      // A Worker waiting for the person alerts as any session does.
      test.notifier.update([
        lead("completed"),
        worker("w1", "completed"),
        worker("w2", "approval"),
      ]);
      await settle();
      expect(alerts(test)).toEqual(["approval:w2"]);
      // The Project Agent waits as long as that takes.
      test.advance(30 * MINUTE);
      test.notifier.update([lead("completed"), worker("w1", "completed"), worker("w2", "running")]);
      test.notifier.update([
        lead("completed", { reports: 1 }),
        worker("w1", "completed"),
        worker("w2", "completed"),
      ]);
      test.notifier.update([lead("running"), worker("w1", "completed"), worker("w2", "completed")]);
      // Its own background task still runs after this turn.
      test.notifier.update([
        lead("completed", {}, 1),
        worker("w1", "completed"),
        worker("w2", "completed"),
      ]);
      await settle();
      expect(alerts(test)).toEqual([]);
      test.advance(20 * MINUTE);
      test.notifier.update([
        lead("completed"),
        worker("w1", "completed"),
        worker("w2", "completed"),
      ]);
      await settle();
      expect(alerts(test)).toEqual(["completed:lead"]);
    });

    it("alerts when delegation pauses for the person, not when they paused it", async () => {
      const test = harness();
      test.notifier.update([lead("running"), worker("w1", "running")]);
      test.notifier.update([
        lead(undefined, { paused: true, reason: "user-paused" }),
        worker("w1", "running"),
      ]);
      await settle();
      expect(alerts(test)).toEqual([]);
      test.notifier.update([
        lead(undefined, { paused: true, reason: "auto-turn-limit" }),
        worker("w1", "running"),
      ]);
      await settle();
      expect(alerts(test)).toEqual(["delegation:lead"]);
    });
  });

  it("sends nothing without a relay device or to a phone that wants no alerts", async () => {
    const test = harness();
    test.context.deviceId = undefined;
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    expect(test.take()).toEqual([]);
    test.context.deviceId = DEVICE;
    test.context.targets = [{ ...target, alerts: false, liveActivity: false }];
    test.notifier.update([session("a", "running")]);
    test.notifier.update([session("a", "question")]);
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("stops alerting a phone the relay no longer reaches, and tries again later", async () => {
    const test = harness();
    test.context.targets = [{ ...target, liveActivity: false }];
    test.notifier.update([session("a", "running"), session("b", "running")]);
    test.context.answers.push({ delivered: false, error: "push_target_gone" });
    test.notifier.update([session("a", "approval"), session("b", "running")]);
    await settle();
    expect(test.take()).toHaveLength(1);
    test.notifier.update([session("a", "approval"), session("b", "question")]);
    await settle();
    expect(test.take()).toEqual([]);
    test.advance(61 * MINUTE);
    test.notifier.update([session("a", "running"), session("b", "question")]);
    test.notifier.update([session("a", "approval"), session("b", "question")]);
    await settle();
    expect(test.take()).toHaveLength(1);
  });
});

describe("push Live Activity", () => {
  it("keeps the same Live Activity if the relay pauses while its start is in flight", async () => {
    let recovering = false;
    let finish: () => void = () => {};
    const started = new Promise<PushSendResult>((resolve) => {
      finish = () => resolve({ delivered: true });
    });
    const send = vi.fn(async (): Promise<PushSendResult> => ({ delivered: true }));
    send.mockImplementationOnce(() => started);
    const test = harness(undefined, {
      send,
      recoveringTargets: () => (recovering ? [target] : []),
      activityDelayMs: 0,
    });
    test.notifier.update([session("a", "running")]);
    await settle();
    expect(send).toHaveBeenCalledOnce();

    recovering = true;
    test.context.targets = [];
    test.context.deviceId = undefined;
    test.notifier.refresh();
    finish();
    await settle();
    expect(send).toHaveBeenCalledOnce();

    recovering = false;
    test.context.targets = [target];
    test.context.deviceId = DEVICE;
    test.notifier.refresh();
    await settle();
    expect(send).toHaveBeenCalledOnce();
  });

  function activities(sent: PushSendInput[]) {
    return sent.filter((input) => input.kind === "activity");
  }

  it("sends legacy counts only for authorized sessions and never seals details", async () => {
    let workspaceIds = ["w"];
    const test = harness(undefined, {
      activityDelayMs: 0,
      activityEndDelayMs: 0,
      activitySnapshot: async (_target, sessions) =>
        projectNotificationActivity(sessions, { workspaceIds, versionScope: "fixture" }),
    });
    test.context.targets = [{ ...target, alerts: false }];
    const hidden = { ...session("private", "running"), workspace_id: "other" };
    test.notifier.update([hidden]);
    await settle();
    expect(test.take()).toEqual([]);

    test.notifier.update([hidden, session("visible", "running")]);
    await settle();
    const startedAt = seconds(test.now());
    expect(activities(test.take())).toEqual([
      expect.objectContaining({
        event: "start",
        contentState: { running: 1, waiting: 0, startedAt },
      }),
    ]);
    test.advance(31_000);
    test.notifier.update([hidden, session("visible", "approval")]);
    await settle();
    expect(activities(test.take())).toEqual([
      expect.objectContaining({
        event: "update",
        contentState: { running: 0, waiting: 1, need: "approval", startedAt },
      }),
    ]);

    workspaceIds = [];
    test.notifier.refresh();
    await settle();
    expect(activities(test.take())).toEqual([
      expect.objectContaining({
        event: "end",
        contentState: { running: 0, waiting: 0, startedAt, endedAt: seconds(test.now()) },
      }),
    ]);
  });

  it("seals scoped ActivityKit details and uses a stable version to suppress unchanged updates", async () => {
    let scope: "allowed" | "busy" | "revoked" = "allowed";
    let snapshot: NotificationActivitySnapshot = {
      version: "scoped-one",
      observedAt: START,
      running: 1,
      waiting: 1,
      priority: {
        sessionId: "authorized-private-session",
        title: "Visible only inside encryption",
        agent: "codex",
        category: "approval",
        count: 1,
      },
    };
    const test = harness(undefined, {
      activitySnapshot: async () => {
        if (scope === "busy") throw new Error("operation_busy");
        return scope === "allowed" ? { snapshot, work: new Map() } : undefined;
      },
    });
    test.context.targets = [{ ...target, activityDetails: 1, alerts: false }];
    test.notifier.update([session("a", "running"), session("global-only", "running")]);
    await settle();
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    const [start] = activities(test.take());
    expect(start).toMatchObject({
      event: "start",
      contentState: { running: 1, waiting: 1, need: "approval", version: snapshot.version },
    });
    expect(start?.contentState).not.toHaveProperty("title");
    expect(JSON.stringify(start)).not.toContain("authorized-private-session");
    expect(JSON.stringify(start)).not.toContain("Visible only inside encryption");
    const bytes = start?.kind === "activity" ? start.contentState.activityEnvelope : undefined;
    expect(typeof bytes).toBe("string");
    const envelope = openPushEnvelope(String(bytes), phone.privateKey, target.publicKey, DEVICE);
    expect(envelope).toEqual({ v: 1, activity: snapshot });
    expect(envelope).toHaveProperty("activity.priority.title", "Visible only inside encryption");

    snapshot = { ...snapshot, observedAt: START + MINUTE };
    test.advance(31_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([expect.objectContaining({ event: "update" })]);
    // The first update confirms registration even with unchanged content.
    test.advance(31_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    scope = "busy";
    snapshot = { ...snapshot, version: "scoped-two", running: 2 };
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    scope = "allowed";
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      expect.objectContaining({
        event: "update",
        contentState: expect.objectContaining({ running: 2, version: "scoped-two" }),
      }),
    ]);
    scope = "revoked";
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      expect.objectContaining({
        event: "end",
        dismissalDate: seconds(test.now()),
        contentState: {
          running: 0,
          waiting: 0,
          startedAt: seconds(START),
          endedAt: seconds(test.now()),
        },
      }),
    ]);
  });

  it("defers an alerting ActivityKit start in quiet hours and ends on policy disable", async () => {
    let quiet = true;
    let enabled = true;
    const test = harness(undefined, {
      activityStartAllowed: () => !quiet,
      enabled: () => enabled,
    });
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    quiet = false;
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([expect.objectContaining({ event: "start" })]);
    quiet = true;
    test.advance(31_000);
    test.notifier.update([session("a", "running"), session("b", "running")]);
    await settle();
    expect(test.take()).toEqual([expect.objectContaining({ event: "update" })]);
    enabled = false;
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      expect.objectContaining({ event: "end", dismissalDate: seconds(test.now()) }),
    ]);
  });

  it("starts without sharing the session title, follows work, and ends after it stops", async () => {
    const test = harness();
    const startedAt = seconds(START);
    test.notifier.update([session("a", "running")]);
    await settle();
    expect(test.take()).toEqual([]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      {
        session: target.session,
        kind: "activity",
        event: "start",
        contentState: { running: 1, waiting: 0, startedAt },
        priority: 10,
        staleDate: seconds(test.now() + 20 * MINUTE),
      },
    ]);

    // Report the new count no sooner than 30 seconds after the last send.
    test.advance(10_000);
    test.notifier.update([session("a", "running"), session("b", "running")]);
    await settle();
    expect(test.take()).toEqual([]);
    test.advance(20_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      expect.objectContaining({
        event: "update",
        contentState: { running: 2, waiting: 0, startedAt },
        priority: 5,
      }),
    ]);

    // Someone waiting goes out at once on the phone.
    test.advance(31_000);
    test.notifier.update([session("a", "running"), session("b", "approval")]);
    await settle();
    expect(activities(test.take())).toEqual([
      expect.objectContaining({
        event: "update",
        contentState: { running: 1, waiting: 1, need: "approval", startedAt },
        priority: 10,
      }),
    ]);

    // An unchanged activity is refreshed so it does not turn stale.
    test.advance(15 * MINUTE);
    test.notifier.update([session("a", "running"), session("b", "approval")]);
    await settle();
    expect(test.take()).toEqual([expect.objectContaining({ event: "update", priority: 5 })]);

    // The gap between turns keeps it; a lasting stop ends it and shows the outcome a while.
    test.notifier.update([session("a"), session("b")]);
    test.advance(20_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    test.advance(11_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      {
        session: target.session,
        kind: "activity",
        event: "end",
        contentState: { running: 0, waiting: 0, startedAt, endedAt: seconds(test.now()) },
        priority: 10,
        dismissalDate: seconds(test.now() + 5 * MINUTE),
      },
    ]);
    test.advance(MINUTE);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("leaves short work alone", async () => {
    const test = harness();
    test.notifier.update([session("a", "running")]);
    test.advance(40_000);
    test.notifier.update([session("a")]);
    test.advance(MINUTE);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
  });

  it("traces relay results and the reasons a start is skipped without logging its input", async () => {
    const trace = vi.fn<NonNullable<PushNotifierOptions["trace"]>>();
    let quiet = true;
    const test = harness(undefined, { trace, activityStartAllowed: () => !quiet });
    test.notifier.update([session("private-session")]);
    test.notifier.update([session("private-session", "running")]);
    await settle();
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    quiet = false;
    test.context.answers.push({ delivered: false, error: "push_target_unavailable" });
    test.notifier.refresh();
    await settle();
    test.notifier.refresh();
    await settle();
    const retryAt = test.now() + 60 * MINUTE;
    const events = trace.mock.calls.map(([event]) => event);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "start",
          outcome: "skipped",
          reason: "no_active_sessions",
        }),
        expect.objectContaining({ operation: "start", outcome: "skipped", reason: "quiet_hours" }),
        expect.objectContaining({
          operation: "start",
          outcome: "refused",
          reason: "push_target_unavailable",
          retryAt,
        }),
        expect.objectContaining({
          operation: "start",
          outcome: "skipped",
          reason: "activity_cooldown",
          retryAt,
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain("private-session");
    expect(activities(test.take())).toHaveLength(1);
  });

  it("gives the phone time to report the token, then treats the activity as removed", async () => {
    const test = harness();
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(activities(test.take())).toHaveLength(1);
    // The phone has not reported the update token yet: tried again later.
    test.context.answers.push({ delivered: false, error: "activity_unknown" });
    test.advance(31_000);
    test.notifier.update([session("a", "running"), session("b", "running")]);
    await settle();
    expect(activities(test.take())).toHaveLength(1);
    test.context.answers.push({ delivered: false, error: "activity_unknown" });
    test.advance(3 * MINUTE);
    test.notifier.update([
      session("a", "running"),
      session("b", "running"),
      session("c", "running"),
    ]);
    await settle();
    expect(activities(test.take())).toHaveLength(1);
    // Removed: nothing more this time, not even a new start.
    test.advance(MINUTE);
    test.notifier.update([session("a", "running")]);
    test.advance(MINUTE);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    // Once work stopped, the next work starts one again.
    test.notifier.update([session("a")]);
    test.advance(31_000);
    test.notifier.refresh();
    await settle();
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(activities(test.take())).toEqual([expect.objectContaining({ event: "start" })]);
  });

  it.each([false, true])(
    "starts again for new work within scope after a lost update token (confirmed=%s)",
    async (confirmed) => {
      const trace = vi.fn<NonNullable<PushNotifierOptions["trace"]>>();
      const test = harness(undefined, { trace });
      const lead = { ...session("lead", "running"), agent: "claude-code" };
      test.context.targets = [{ ...target, alerts: false }];
      const waiting = session("waiting", "question");
      const outside = { ...session("outside", "running"), workspace_id: "private" };
      const idle = session("next");
      const ready = session("next", "running");
      test.notifier.update([lead, waiting, idle]);
      await settle();
      test.advance(61_000);
      test.notifier.refresh();
      await settle();
      expect(activities(test.take()).map((input) => input.event)).toEqual(["start"]);

      test.advance(31_000);
      if (!confirmed) test.context.answers.push({ delivered: false, error: "activity_unknown" });
      test.notifier.update([lead, session("waiting", "approval"), idle]);
      await settle();
      expect(activities(test.take()).map((input) => input.event)).toEqual(["update"]);
      test.advance(3 * MINUTE);
      test.context.answers.push({ delivered: false, error: "activity_unknown" });
      test.notifier.update([lead, waiting, idle, session("other-wait", "approval")]);
      await settle();
      expect(activities(test.take()).map((input) => input.event)).toEqual(["update"]);

      test.advance(61_000);
      test.notifier.update([lead, waiting, idle, outside]);
      await settle();
      expect(activities(test.take())).toEqual([]);
      expect(trace).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "start",
          outcome: "skipped",
          reason: confirmed ? "activity_token_lost" : "activity_token_unconfirmed",
        }),
      );
      // Waiting → running is still the same work the user might have dismissed.
      test.notifier.update([lead, session("waiting", "running"), idle, outside]);
      await settle();
      test.advance(61_000);
      test.notifier.refresh();
      await settle();
      expect(activities(test.take())).toEqual([]);

      test.notifier.update([lead, waiting, ready, outside]);
      await settle();
      expect(activities(test.take())).toEqual([]);
      test.advance(61_000);
      test.notifier.refresh();
      await settle();
      expect(activities(test.take())).toEqual([
        expect.objectContaining({
          event: "start",
          contentState: expect.objectContaining({ running: 2, waiting: 1 }),
        }),
      ]);
    },
  );

  it("does not retry a phone without Live Activities for an hour", async () => {
    const test = harness();
    test.context.answers.push({ delivered: false, error: "push_target_unavailable" });
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toHaveLength(1);
    test.advance(30 * MINUTE);
    test.notifier.update([session("a", "running")]);
    await settle();
    expect(test.take()).toEqual([]);
    test.advance(31 * MINUTE);
    test.notifier.update([session("a", "running")]);
    await settle();
    expect(activities(test.take())).toEqual([expect.objectContaining({ event: "start" })]);
  });

  it("sends nothing from stale snapshots, and ends at once for a phone that stopped asking", async () => {
    const test = harness();
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    test.take();
    // The catalog could not be read for a while: no refresh the phone could take as current.
    test.notifier.update(undefined);
    test.advance(16 * MINUTE);
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([]);
    test.context.targets = [];
    test.notifier.refresh();
    await settle();
    expect(test.take()).toEqual([
      expect.objectContaining({ event: "end", dismissalDate: seconds(test.now()) }),
    ]);
  });

  it("replaces an activity before iOS ends it after eight hours", async () => {
    const test = harness();
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    test.take();
    for (let elapsed = 0; elapsed < 8 * 60; elapsed += 10) {
      test.advance(10 * MINUTE);
      test.notifier.update([session("a", "running")]);
      await settle();
    }
    const events = activities(test.take()).map((input) => input.kind === "activity" && input.event);
    expect(events).toContain("end");
    expect(events.slice(events.indexOf("end"))).toEqual(["end", "start"]);
  });

  it("ends the Live Activities on quit", async () => {
    const test = harness();
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    test.take();
    await test.notifier.stop();
    expect(test.take()).toEqual([
      expect.objectContaining({ event: "end", dismissalDate: seconds(test.now()) }),
    ]);
    test.notifier.update([session("a", "approval")]);
    await settle();
    expect(test.take()).toEqual([]);
  });
});
