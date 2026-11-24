import type { ConversationSessionSummary } from "@agentkib/web-client";
import { describe, expect, it } from "vitest";
import { projectTaskSummary } from "./task-summary";

function completed(
  id: string,
  completedAt: string,
  overrides: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  return {
    id,
    title: "验收\n  示例",
    workspace_id: "visible",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    readState: {
      source: "codex-native",
      status: "unread",
      freshness: "current",
      version: "read-state",
      firstUnread: { type: "result", resultId: id, turnId: null },
      latestResult: { id, turnId: null, itemId: null, outcome: "completed", completedAt },
    },
    ...overrides,
  };
}

describe("projectTaskSummary", () => {
  it("uses result time and a single-line title and only counts the authorized visible sessions", () => {
    const earlier = completed("earlier", "2026-11-20T01:00:00Z", {
      updated_at: "2026-11-25T01:00:00Z",
    });
    const later = completed("later", "2026-11-23T01:00:00Z");
    const scoped = projectTaskSummary(
      {
        sessions: [
          earlier,
          later,
          { ...later, id: "archived", archived: true },
          { ...later, id: "child", sidechain: true },
          { ...later, id: "private", workspace_id: "private" },
        ],
      },
      ["visible"],
      false,
      "binding",
    )!;

    expect(scoped.groups.completed).toEqual({
      count: 2,
      entries: [later, earlier].map((session) => ({
        sessionId: session.id,
        agent: "codex",
        workspaceId: "visible",
        time: session.readState!.latestResult!.completedAt,
        outcome: "completed",
        summary: "验收 示例",
      })),
    });
    expect(scoped.groups.needsReview).toEqual(scoped.groups.completed);
    expect(scoped.groups.pendingApproval).toEqual({ count: 0, entries: [] });
  });

  it("versions visible state independently of row order or changes in other workspaces", () => {
    const time = "2026-11-20T01:00:00Z";
    const first = completed("first", time);
    const second = completed("second", time);
    const project = (sessions: ConversationSessionSummary[], scope = "current-device") =>
      projectTaskSummary({ sessions }, ["visible"], false, scope)!;
    const initial = project([first, second]);
    expect(project([second, { ...second, id: "hidden", workspace_id: "hidden" }, first])).toEqual(
      initial,
    );
    expect(project([first, second], "new-device").version).not.toBe(initial.version);
    expect(
      project([{ ...first, readState: { ...first.readState!, status: "read" } }, second]).version,
    ).not.toBe(initial.version);
  });
});
