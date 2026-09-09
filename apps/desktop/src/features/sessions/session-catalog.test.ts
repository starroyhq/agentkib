// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { filterSessions, groupSessions, sessionCatalogStats, sortSessions } from "./session-catalog";
import { filterSessions as sharedFilterSessions, groupSessions as sharedGroupSessions } from "@agentkib/session-catalog";

const workspaces = [
  { id: "one", name: "Shared project" },
  { id: "two", name: "Shared project" },
] as WorkspaceSummary[];
const sessions: ConversationSessionSummary[] = [
  {
    id: "readable",
    workspace_id: "one",
    agent: "codex",
    title: "Review sidebar",
    archived: false,
    sidechain: false,
    availability: "readable",
    updated_at: "2026-09-01T00:00:00Z",
  },
  {
    id: "archived",
    workspace_id: "two",
    agent: "claude-code",
    title: "Review sidebar",
    archived: true,
    sidechain: false,
    availability: "readable",
    updated_at: "2026-09-02T00:00:00Z",
  },
  {
    id: "metadata",
    workspace_id: "two",
    agent: "codex",
    title: "Investigate build",
    archived: false,
    sidechain: false,
    availability: "metadata-only",
  },
];

describe("session catalog", () => {
  beforeAll(() => initializeI18n("en-US"));

  it("uses current, archived, metadata and all record semantics", () => {
    const select = (filter: "current" | "archived" | "metadata" | "all") =>
      filterSessions(sessions, workspaces, { query: "", agent: "all", filter }).map(({ id }) => id);
    expect(select("current")).toEqual(["readable"]);
    expect(select("archived")).toEqual(["archived"]);
    expect(select("metadata")).toEqual(["metadata"]);
    expect(select("all")).toEqual(["archived", "readable", "metadata"]);
  });

  it("keeps auxiliary records hidden independently of record filters until opted in", () => {
    const auxiliary = {
      ...sessions[0],
      id: "auxiliary",
      origin: "auxiliary" as const,
      spawned_by_session_id: sessions[0].id,
    };
    const unknown = { ...sessions[0], id: "unknown", origin: undefined };
    expect(
      filterSessions([sessions[0], auxiliary, unknown], workspaces, {
        query: "",
        agent: "all",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["readable", "unknown"]);
    expect(
      filterSessions([sessions[0], auxiliary, unknown], workspaces, {
        query: "",
        agent: "all",
        filter: "all",
        showAuxiliary: true,
      }).map(({ id }) => id),
    ).toEqual(["readable", "auxiliary", "unknown"]);
  });

  it("combines title and workspace name search with Agent filters, without conflating names", () => {
    expect(
      filterSessions(sessions, workspaces, {
        query: "  SHARED PROJECT  ",
        agent: "codex",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["readable", "metadata"]);
    expect(
      filterSessions(sessions, workspaces, {
        query: "sidebar",
        agent: "claude-code",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["archived"]);
    expect(
      filterSessions(sessions, [workspaces[0]], { query: "", agent: "all", filter: "all" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["readable"]);
  });

  it("does not search hidden internal wrapper titles", () => {
    const internal = { ...sessions[0], title: "<path>secret-internal-file</path>" };
    expect(
      filterSessions([internal], workspaces, {
        query: "secret-internal-file",
        agent: "all",
        filter: "all",
      }),
    ).toEqual([]);
  });

  it("sorts recent first without mutating input and preserves ties and invalid timestamps", () => {
    const input = [
      { ...sessions[0], id: "invalid", updated_at: "not-a-date" },
      { ...sessions[0], id: "equal-a" },
      { ...sessions[0], id: "equal-b" },
      { ...sessions[0], id: "missing", updated_at: undefined },
    ];
    expect(sortSessions(input).map(({ id }) => id)).toEqual([
      "equal-a",
      "equal-b",
      "invalid",
      "missing",
    ]);
    expect(input[0].id).toBe("invalid");
  });

  it("calculates overview metrics from only the supplied filtered records", () => {
    expect(sessionCatalogStats(sessions)).toEqual({
      total: 3,
      readable: 2,
      archived: 1,
      metadata: 1,
    });
    expect(sessionCatalogStats([])).toEqual({ total: 0, readable: 0, archived: 0, metadata: 0 });
  });

  it("keeps desktop and Web structural records on identical shared rules", () => {
    const filters = { query: "", agent: "all" as const, filter: "all" as const };
    const desktop = filterSessions(sessions, workspaces, filters);
    const web = sharedFilterSessions(sessions, workspaces, filters, "Untitled session");
    expect(desktop).toEqual(web);
    expect(groupSessions(desktop, workspaces)).toEqual(sharedGroupSessions(web, workspaces));
  });

  it("groups by identity, disambiguates project names and uses creation time fallback", () => {
    const projects = [
      { id: "one", name: "app", path: "/work/personal/app" },
      { id: "two", name: "app", path: "/work/company/app" },
    ];
    const records = [
      { ...sessions[0], updated_at: undefined },
      { ...sessions[1], updated_at: "invalid", created_at: "2026-09-03T00:00:00Z" },
    ];
    const groups = groupSessions(records, projects);
    expect(groups.map(({ workspace, label }) => [workspace.id, label])).toEqual([
      ["two", "app · company/app"], ["one", "app · personal/app"],
    ]);
    expect(groups[0].sessions.map(({ id }) => id)).toEqual(["archived"]);
  });

  it("keeps remote host groups contiguous and equal timestamps stable", () => {
    const projects = [
      { id: "one", name: "One", path: "/one" },
      { id: "two", name: "Two", path: "/two" },
      { id: "remote", name: "Remote", path: "/remote", remote: { host_id: "z", online: true } },
    ];
    const records = [
      { ...sessions[0], updated_at: undefined },
      { ...sessions[0], id: "other", workspace_id: "two", updated_at: undefined },
      { ...sessions[0], id: "remote", workspace_id: "remote" },
    ];
    expect(groupSessions(records, projects).map(({ workspace }) => workspace.id)).toEqual(["one", "two", "remote"]);
    expect(groupSessions(records, projects)[2].workspace.remote?.online).toBe(true);
  });
});
