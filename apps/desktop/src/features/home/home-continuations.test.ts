import { projectManagedSessionAliases } from "@/features/sessions/session-catalog";
import { describe, expect, it } from "vitest";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  continuationIndexingEnabled,
  recentContinuationWorkspaces,
  selectRecentContinuations,
} from "./home-continuations";

const workspaces = ["first", "second", "third", "fourth"].map(
  (id) => ({ id, name: id }) as WorkspaceSummary,
);

const readableSession = {
  id: "session-1",
  availability: "readable",
  agent: "codex",
  updated_at: "2026-09-01T12:00:00.000Z",
} as ConversationSessionSummary;

describe("selectRecentContinuations", () => {
  it("retains a managed native execution in recent history through the verified catalog projection", () => {
    const native = {
      ...readableSession,
      id: "native",
      workspace_id: "first",
      origin: "execution" as const,
    };
    const owner = {
      ...native,
      id: "managed",
      origin: "interactive" as const,
      indexedSessionIds: [native.id],
    };
    const records = projectManagedSessionAliases([native], [owner]);
    expect(
      selectRecentContinuations(workspaces, [records]).map(({ session }) => session.id),
    ).toEqual(["native"]);
  });

  it("hides auxiliary and execution records without merging same-title forks or hiding unknown sources", () => {
    const sessions: ConversationSessionSummary[] = [
      { ...readableSession, id: "aux", title: "Same", origin: "auxiliary" },
      { ...readableSession, id: "exec", title: "Same", origin: "execution" },
      {
        ...readableSession,
        id: "fork",
        title: "Same",
        origin: "interactive",
        forked_from_session_id: "main",
      },
      { ...readableSession, id: "unknown", title: "Same", origin: "unknown" },
    ];
    expect(
      selectRecentContinuations(workspaces, [sessions]).map(({ session }) => session.id),
    ).toEqual(["fork", "unknown"]);
  });

  it("waits for the runtime preference before enabling session indexing", () => {
    expect(continuationIndexingEnabled()).toBe(false);
    expect(continuationIndexingEnabled({ session_index_enabled: false })).toBe(false);
    expect(continuationIndexingEnabled({ session_index_enabled: true })).toBe(true);
  });

  it("reads the sessions of the five most recently active workspaces again", () => {
    const values = Array.from({ length: 7 }, (_, index) => ({
      id: `workspace-${index}`,
      last_active_at: `2026-09-0${index + 1}T00:00:00.000Z`,
    })) as WorkspaceSummary[];

    expect(recentContinuationWorkspaces(values).map(({ id }) => id)).toEqual([
      "workspace-6",
      "workspace-5",
      "workspace-4",
      "workspace-3",
      "workspace-2",
    ]);
  });

  it("takes the limit after filtering workspaces without readable sessions", () => {
    const result = selectRecentContinuations(workspaces, [[], [], [], [readableSession]], 3);

    expect(result.map((item) => item.workspace.id)).toEqual(["fourth"]);
  });

  it("sorts individual readable sessions globally and excludes metadata-only sessions", () => {
    const result = selectRecentContinuations(
      workspaces,
      [
        [
          readableSession,
          {
            ...readableSession,
            id: "session-2",
            agent: "claude-code",
            updated_at: "2026-09-03T12:00:00.000Z",
          },
        ],
        [
          {
            ...readableSession,
            id: "metadata-session",
            availability: "metadata-only",
            updated_at: "2026-09-04T12:00:00.000Z",
          },
          { ...readableSession, id: "session-3", updated_at: "2026-09-02T12:00:00.000Z" },
        ],
      ],
      2,
    );

    expect(result.map((item) => item.session.id)).toEqual(["session-2", "session-3"]);
  });
});
