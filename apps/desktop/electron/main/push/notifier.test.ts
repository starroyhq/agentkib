// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { HomeSession } from "@agentkib/session-catalog";
import type { PushSendInput, PushSendResult } from "../web/relay/manager";
import { openPushEnvelope } from "./envelope-fixture";
import { PushNotifier, type PushTarget } from "./notifier";

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
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
    computerName: async () => "Studio",
    present: () => context.present,
    now: () => clock,
    // Tests drive every check through update and refresh.
    tickMs: 24 * 60 * MINUTE,
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

describe("push alerts", () => {
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
  function activities(sent: PushSendInput[]) {
    return sent.filter((input) => input.kind === "activity");
  }

  it("starts once work lasts, follows it, and ends after it stops", async () => {
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
        contentState: { running: 1, waiting: 0, title: "Task a", startedAt },
        staleDate: seconds(test.now() + 20 * MINUTE),
      },
    ]);

    // Two sessions: counts only, and no sooner than 30 seconds after the last send.
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
    test.notifier.update([session("a", "running")]);
    test.advance(61_000);
    test.notifier.refresh();
    await settle();
    expect(activities(test.take())).toEqual([expect.objectContaining({ event: "start" })]);
  });

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
