import { homeTaskGroups, type HomeSession } from "@agentkib/session-catalog";
import { describe, expect, it } from "vitest";

function session(id: string, extra: Partial<HomeSession> = {}): HomeSession {
  return { id, workspace_id: "workspace", agent: "codex", availability: "readable", ...extra };
}

function readState(
  outcome: string,
  extra: Partial<NonNullable<HomeSession["readState"]>> = {},
): HomeSession["readState"] {
  return {
    status: "unread",
    freshness: "current",
    firstUnread: { type: "result" },
    latestResult: { outcome },
    ...extra,
  };
}

const ids = (entries: readonly { session: HomeSession }[]) =>
  entries.map(({ session }) => session.id);

describe("homeTaskGroups", () => {
  it("uses current activity before previous results across Providers", () => {
    const previous = readState("completed");
    const groups = homeTaskGroups([
      session("claude-approval", {
        agent: "claude-code",
        continuation: { status: "awaiting-approval" },
        externalTurn: { status: "running" },
        readState: previous,
      }),
      session("dsh-question", {
        agent: "deepseek-harness",
        continuation: { status: "waiting-input" },
        readState: previous,
      }),
      session("codex-external", { externalTurn: { status: "running" }, readState: previous }),
      session("devin-running", {
        agent: "devin",
        continuation: { status: "starting" },
        updated_at: "2026-11-23T12:00:00Z",
      }),
      session("verify", { continuation: { status: "outcome-unknown" }, readState: previous }),
      session("delegation", {
        orchestration: { role: "lead", paused: true, reason: "auto-turn-limit" },
        readState: previous,
      }),
    ]);

    expect(ids(groups.pendingApproval)).toEqual(["claude-approval"]);
    expect(ids(groups.pendingAnswer)).toEqual(["dsh-question"]);
    expect(groups.running.map(({ session, place }) => [session.id, place])).toEqual([
      ["devin-running", "agentkib"],
      ["codex-external", "external"],
    ]);
    expect(groups.needsReview).toEqual([]);
    expect(groups.failed).toEqual([]);
    expect(groups.completed).toEqual([]);
  });

  it("keeps known outcomes and counts only current unread results for review", () => {
    const groups = homeTaskGroups([
      session("newest-failed", {
        updated_at: "2026-11-24T12:00:00Z",
        readState: readState("failed"),
      }),
      session("unread-completed", { readState: readState("completed") }),
      session("read-completed", { readState: readState("completed", { status: "read" }) }),
      session("stale", { readState: readState("failed", { freshness: "stale" }) }),
      session("manual-unread", {
        readState: readState("completed", { firstUnread: { type: "threadStart" } }),
      }),
      session("no-result", { readState: readState("completed", { latestResult: null }) }),
      session("ended", { readState: readState("ended") }),
      session("cancelled", { readState: readState("cancelled") }),
      session("unknown"),
    ]);

    expect(ids(groups.completed)).toEqual(["unread-completed", "read-completed", "manual-unread"]);
    expect(ids(groups.failed)).toEqual(["newest-failed", "stale"]);
    expect(groups.needsReview.map(({ session, outcome }) => [session.id, outcome])).toEqual([
      ["newest-failed", "failed"],
      ["unread-completed", "completed"],
    ]);
  });

  it("keeps all visible tasks without applying the desktop recent limit", () => {
    const closed = { readState: readState("completed", { status: "read" }) };
    const visible = Array.from({ length: 12 }, (_, index) => session(`session-${index}`, closed));
    const groups = homeTaskGroups([
      ...visible,
      session("archived", { ...closed, archived: true }),
      session("metadata", { ...closed, availability: "metadata-only" }),
      session("program", { ...closed, origin: "execution" }),
      session("auxiliary", { ...closed, origin: "auxiliary" }),
      session("remote", { ...closed, remote: { host_id: "host" } }),
    ]);

    expect(ids(groups.completed)).toEqual(visible.map(({ id }) => id));
  });
});
