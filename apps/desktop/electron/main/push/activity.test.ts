// @vitest-environment node
import { describe, expect, it } from "vitest";
import { homeSessionGroups } from "@agentkib/session-catalog";
import {
  NotificationActivityWork,
  projectNotificationActivity,
  type NotificationActivitySession,
} from "./activity";

const NOW = 1_795_516_200_000;
const EARLIER = "2026-11-24T07:00:00.000Z";
const LATER = "2026-11-24T08:00:00.000Z";
const scope = { workspaceIds: ["visible"], versionScope: "scoped-host" };

function session(
  id: string,
  status: string,
  overrides: Partial<NotificationActivitySession> = {},
): NotificationActivitySession {
  return {
    id,
    workspace_id: "visible",
    agent: "codex",
    availability: "readable",
    continuation: { status },
    updated_at: EARLIER,
    ...overrides,
  };
}

it("uses explicit native turn identity and does not substitute catalog timestamps", () => {
  const tracker = new NotificationActivityWork();
  const native = (turnId: string, updated_at = EARLIER) =>
    session("native", "idle", {
      externalTurn: { status: "running", turnId },
      updated_at,
    });
  const observe = (rows: NotificationActivitySession[]) => {
    tracker.observe(rows, homeSessionGroups(rows, { recent: 0 }), NOW);
    return projectNotificationActivity(rows, scope, NOW).work;
  };
  observe([native("turn-one")]);
  const boundary = tracker.sequence;
  observe([]);
  expect(tracker.startAfter(observe([native("turn-one", LATER)]), boundary)).toBeUndefined();
  expect(tracker.startAfter(observe([native("turn-two", LATER)]), boundary)).toEqual({
    sequence: boundary + 1,
    at: NOW,
  });
  expect(
    tracker.startAfter(observe([session("first-seen-running", "running")]), boundary),
  ).toBeUndefined();
});

describe("notification activity snapshot", () => {
  it("excludes Worker turns from activity counts, priority, and the lead's activity version", () => {
    const worker = (id: string, status: string) =>
      session(id, status, { orchestration: { role: "worker", leadId: "lead" } });
    const workers = [worker("working", "running"), worker("approval", "awaiting-approval")];
    const onlyWorkers = projectNotificationActivity(workers, scope, NOW);
    expect(onlyWorkers.snapshot).toMatchObject({ waiting: 0, running: 0 });
    expect(onlyWorkers.snapshot).not.toHaveProperty("priority");
    expect(onlyWorkers.work.size).toBe(0);

    const lead = session("lead", "waiting-input", { orchestration: { role: "lead" } });
    const active = projectNotificationActivity([lead, ...workers], scope, NOW);
    const finished = projectNotificationActivity([lead, worker("working", "idle")], scope, NOW);
    expect(active).toEqual(finished);
    expect(active.snapshot).toMatchObject({
      waiting: 1,
      running: 0,
      priority: { sessionId: "lead", category: "question" },
    });
    expect([...active.work]).toEqual([["lead", "waiting"]]);
  });

  it("chooses the newest approval ahead of a later question and counts each active session once", () => {
    const { snapshot } = projectNotificationActivity(
      [
        session("old-approval", "awaiting-approval", { pinned: true }),
        session("recent-approval", "awaiting-approval", {
          title: "   Check\n the new file   ",
          agent: "claude-code",
          updated_at: LATER,
          externalTurn: { status: "running" },
        }),
        session("question", "waiting-input", { updated_at: "2026-11-24T09:00:00.000Z" }),
        session("running", "running"),
        session("starting", "starting"),
        session("external", "idle", { externalTurn: { status: "running" } }),
        session("finished", "idle", { readState: { status: "unread" } }),
      ],
      scope,
      NOW,
    );
    expect(snapshot).toMatchObject({
      observedAt: NOW,
      waiting: 3,
      running: 3,
      priority: {
        sessionId: "recent-approval",
        agent: "claude-code",
        title: "Check the new file",
        time: LATER,
        category: "approval",
        count: 2,
      },
    });
    expect(snapshot.version).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not expose or count any out-of-scope, unreadable, auxiliary, child, archived or remote session", () => {
    const sessions = [
      session("private-approval", "awaiting-approval", { workspace_id: "private" }),
      session("private-running", "running", { workspace_id: "private" }),
      session("sidechain", "running", { sidechain: true }),
      session("archived", "awaiting-approval", { archived: true }),
      session("auxiliary", "awaiting-approval", { origin: "auxiliary" }),
      session("execution", "awaiting-approval", { origin: "execution" }),
      session("unreadable", "running", { availability: "unreadable" }),
      session("remote", "awaiting-approval", { remote: { host: "another host" } }),
      session("visible-running", "running"),
    ];
    const scoped = projectNotificationActivity(sessions, scope, NOW);
    expect(scoped).toEqual(projectNotificationActivity([sessions[8]!], scope, NOW));
    expect(scoped.snapshot).toMatchObject({ observedAt: NOW, waiting: 0, running: 1 });
    expect(scoped.snapshot).not.toHaveProperty("priority");
    expect([...scoped.work]).toEqual([["visible-running", "running"]]);
    expect(
      projectNotificationActivity(sessions, { ...scope, workspaceIds: [] }, NOW).snapshot,
    ).toMatchObject({ waiting: 0, running: 0 });
  });

  it("keeps unknown outcomes in the waiting group without offering them as approvals", () => {
    const awaiting = session("same-decision", "awaiting-approval");
    const paused = session("lead", "idle", {
      orchestration: { role: "lead", paused: true, reason: "report-undelivered" },
    });
    const unconfirmed = new Set([awaiting.id]);
    expect(
      projectNotificationActivity([awaiting, paused], { ...scope, unconfirmed }, NOW).snapshot,
    ).toMatchObject({
      waiting: 2,
      running: 0,
      priority: { sessionId: awaiting.id, category: "verify", count: 1 },
    });
    expect(projectNotificationActivity([paused], scope, NOW).snapshot).toMatchObject({
      waiting: 1,
      priority: { sessionId: paused.id, category: "delegation", count: 1 },
    });
  });

  it("keeps a stable version across order and read times, while scope and task state changes update it", () => {
    const first = session("a", "waiting-input");
    const second = session("b", "waiting-input");
    const hidden = session("hidden", "awaiting-approval", { workspace_id: "private" });
    const initial = projectNotificationActivity([second, first], scope, NOW).snapshot;
    const later = projectNotificationActivity(
      [first, hidden, second],
      scope,
      NOW + 60_000,
    ).snapshot;
    expect(initial.priority?.sessionId).toBe("a");
    expect(later).toEqual({ ...initial, observedAt: NOW + 60_000 });
    expect(projectNotificationActivity([first], scope, NOW).snapshot.version).not.toBe(
      initial.version,
    );
    expect(
      projectNotificationActivity(
        [first, second],
        { ...scope, versionScope: "new-connection" },
        NOW,
      ).snapshot.version,
    ).not.toBe(initial.version);
    expect(
      projectNotificationActivity(
        [first, second],
        { ...scope, workspaceIds: ["visible", "new"] },
        NOW,
      ).snapshot.version,
    ).not.toBe(initial.version);
  });

  it("bounds the display title without splitting a Unicode character and omits unknown times", () => {
    const first = session("long", "waiting-input", {
      title: "🧪".repeat(140),
      updated_at: "unknown",
    });
    const { snapshot: projected } = projectNotificationActivity([first], scope, NOW);
    expect(projected.priority?.title).toBe("🧪".repeat(99) + "…");
    expect(projected.priority).not.toHaveProperty("time");
    expect(
      projectNotificationActivity([{ ...first, created_at: EARLIER }], scope, NOW).snapshot.priority
        ?.time,
    ).toBe(EARLIER);
  });
});
