import { describe, expect, it } from "vitest";
import type { ConversationSessionSummary } from "@/core/types";
import { workStoppedByQuit } from "@agentkib/session-catalog";
import { formatRunningTime, homeSessionGroups } from "./home-sessions";

let clock = 0;
function session(
  id: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  clock += 1;
  return {
    id,
    workspace_id: "workspace",
    agent: "codex",
    title: id,
    updated_at: new Date(Date.UTC(2026, 10, 9, 0, clock)).toISOString(),
    archived: false,
    sidechain: false,
    availability: "readable",
    ...extra,
  };
}
const unread = (
  outcome?: "completed" | "failed" | "cancelled" | "ended",
): ConversationSessionSummary["readState"] => ({
  source: "agentkib",
  status: "unread",
  freshness: "current",
  version: "1",
  firstUnread: outcome ? { type: "result", resultId: "r", turnId: "t" } : { type: "threadStart" },
  latestResult: outcome ? { id: "r", turnId: "t", itemId: null, outcome, completedAt: null } : null,
});
const ids = (items: { session: ConversationSessionSummary }[]) =>
  items.map(({ session }) => session.id);

describe("homeSessionGroups", () => {
  it("puts requests and unconfirmed outcomes under needs you, newest first", () => {
    const groups = homeSessionGroups([
      session("approval", { continuation: { status: "awaiting-approval" } }),
      session("question", { continuation: { status: "waiting-input" } }),
      session("unknown", { continuation: { status: "outcome-unknown" } }),
      session("unconfirmed", {
        continuation: { status: "idle", reason: "control-outcome-unconfirmed" },
      }),
    ]);
    expect(groups.needsYou.map(({ session, need }) => [session.id, need])).toEqual([
      ["unconfirmed", "verify"],
      ["unknown", "verify"],
      ["question", "question"],
      ["approval", "approval"],
    ]);
    expect(groups.running).toEqual([]);
  });

  it("lists a session whose decision may not have arrived as to verify, never to answer again", () => {
    const groups = homeSessionGroups(
      [
        session("answered", { continuation: { status: "awaiting-approval" } }),
        session("running", { continuation: { status: "running", executionLocation: "agentkib" } }),
        session("other", { continuation: { status: "waiting-input" } }),
      ],
      { unconfirmed: new Set(["answered", "running"]) },
    );
    expect(groups.needsYou.map(({ session, need }) => [session.id, need])).toEqual([
      ["other", "question"],
      ["running", "verify"],
      ["answered", "verify"],
    ]);
    expect(groups.running).toEqual([]);
  });

  it("names where each turn runs and keeps a waiting session out of in progress", () => {
    const groups = homeSessionGroups([
      session("agentkib", { continuation: { status: "running", executionLocation: "agentkib" } }),
      session("starting", { continuation: { status: "starting", executionLocation: null } }),
      session("terminal", {
        agent: "claude-code",
        continuation: { status: "running", executionLocation: "terminal" },
      }),
      session("dsh", {
        agent: "deepseek-harness",
        continuation: { status: "running", executionLocation: "external" },
      }),
      session("codex-app", {
        externalTurn: { status: "running", startedAt: "2026-11-09T00:00:00.000Z" },
      }),
      session("waiting", {
        continuation: { status: "awaiting-approval", executionLocation: "agentkib" },
        externalTurn: { status: "running", startedAt: null },
      }),
    ]);
    expect(
      groups.running.map(({ session, place, startedAt }) => [session.id, place, startedAt]),
    ).toEqual([
      ["codex-app", "external", "2026-11-09T00:00:00.000Z"],
      ["dsh", "external", undefined],
      ["terminal", "terminal", undefined],
      ["starting", "agentkib", undefined],
      ["agentkib", "agentkib", undefined],
    ]);
    expect(ids(groups.needsYou)).toEqual(["waiting"]);
  });

  it("lists unread results of sessions that are not running, by outcome", () => {
    const groups = homeSessionGroups([
      session("completed", { readState: unread("completed") }),
      session("failed", { readState: unread("failed") }),
      session("cancelled", { readState: unread("cancelled") }),
      session("ended", { readState: unread("ended") }),
      session("manual", { readState: unread() }),
      session("running", {
        readState: unread("completed"),
        continuation: { status: "running", executionLocation: "agentkib" },
      }),
    ]);
    expect(groups.review.map(({ session, result }) => [session.id, result])).toEqual([
      ["manual", "unread"],
      ["ended", "ended"],
      ["cancelled", "cancelled"],
      ["failed", "failed"],
      ["completed", "completed"],
    ]);
    expect(ids(groups.running)).toEqual(["running"]);
  });

  it("keeps the eight newest other sessions as recent and leaves out what the home never lists", () => {
    const others = Array.from({ length: 10 }, (_, index) => session(`recent-${index}`));
    const groups = homeSessionGroups([
      ...others,
      session("archived", { archived: true, continuation: { status: "awaiting-approval" } }),
      session("metadata", { availability: "metadata-only" }),
      session("program", { origin: "execution", readState: unread("completed") }),
      session("auxiliary", { origin: "auxiliary" }),
      session("remote", {
        remote: { host_id: "host", host_name: "Host", read_only: true } as never,
        continuation: { status: "running" },
      }),
      session("waiting", { continuation: { status: "waiting-input" } }),
    ]);
    expect(groups.recent.map(({ id }) => id)).toEqual(
      ["9", "8", "7", "6", "5", "4", "3", "2"].map((index) => `recent-${index}`),
    );
    expect(ids(groups.needsYou)).toEqual(["waiting"]);
    expect(groups.review).toEqual([]);
    expect(groups.running).toEqual([]);
  });
});

describe("formatRunningTime", () => {
  const now = Date.parse("2026-11-09T02:00:00.000Z");
  it("counts whole minutes, then hours", () => {
    expect(formatRunningTime("2026-11-09T01:56:10.000Z", "en-US", now)).toBe("4 minutes");
    expect(formatRunningTime("2026-11-09T01:59:50.000Z", "en-US", now)).toBe("1 minute");
    expect(formatRunningTime("2026-11-08T23:00:00.000Z", "en-US", now)).toBe("3 hours");
    expect(formatRunningTime("2026-11-09T01:56:00.000Z", "zh-CN", now)).toBe("4分钟");
  });

  it("gives nothing for a start time it cannot read", () => {
    expect(formatRunningTime("soon", "en-US", now)).toBeUndefined();
  });
});

describe("workStoppedByQuit", () => {
  it("names turns running or waiting in processes AgentKib started, and nothing elsewhere", () => {
    const work = workStoppedByQuit([
      session("managed-running", {
        continuation: { status: "running", executionLocation: "agentkib" },
      }),
      session("managed-approval", { continuation: { status: "awaiting-approval" } }),
      session("terminal-running", {
        continuation: { status: "running", executionLocation: "terminal" },
      }),
      session("desktop-question", {
        continuation: { status: "waiting-input", executionLocation: "external" },
      }),
      session("external-turn", { externalTurn: { status: "running", startedAt: null } }),
      session("unconfirmed", { continuation: { status: "outcome-unknown" } }),
      session("idle", { continuation: { status: "idle" } }),
      session("archived", {
        archived: true,
        continuation: { status: "running", executionLocation: "agentkib" },
      }),
    ]);
    expect(work.map((item) => item.id)).toEqual(["managed-approval", "managed-running"]);
  });
});
