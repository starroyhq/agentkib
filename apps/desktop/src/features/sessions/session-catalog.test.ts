// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { sessionSourceDetails } from "./session-labels";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  filterSessions,
  groupSessions,
  sessionCatalogStats,
  projectManagedSessionAliases,
  sortSessions,
} from "./session-catalog";
import {
  filterSessions as sharedFilterSessions,
  groupSessions as sharedGroupSessions,
} from "@agentkib/session-catalog";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";

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

  it("always hides auxiliary and execution records while retaining unknown sources", () => {
    const records: ConversationSessionSummary[] = [
      sessions[0],
      { ...sessions[0], id: "auxiliary", origin: "auxiliary", archived: true },
      { ...sessions[0], id: "execution", origin: "execution", availability: "metadata-only" },
      { ...sessions[0], id: "unknown", origin: "unknown" },
      { ...sessions[0], id: "untitled", title: undefined },
      { ...sessions[0], id: "managed", origin: "interactive" },
      { ...sessions[0], id: "fork", origin: "interactive", forked_from_session_id: "main" },
    ];
    expect(
      filterSessions(records, workspaces, { query: "", agent: "all", filter: "all" }).map(
        ({ id }) => id,
      ),
    ).toEqual(["readable", "unknown", "untitled", "managed", "fork"]);
    for (const filter of ["current", "archived", "metadata", "all"] as const) {
      expect(
        filterSessions(records, workspaces, { query: "execution", agent: "all", filter }),
      ).toEqual([]);
    }
    expect(groupSessions(records, workspaces)[0].sessions.map(({ id }) => id)).toEqual([
      "readable",
      "unknown",
      "untitled",
      "managed",
      "fork",
    ]);
  });

  it.each(["auxiliary", "execution"] as const)(
    "does not turn a hidden %s parent into a source navigation link",
    (origin) => {
      const hidden = { ...sessions[0], id: "hidden-parent", title: "Hidden parent name", origin };
      const fork = {
        ...sessions[0],
        id: "fork",
        origin: "interactive" as const,
        forked_from_session_id: hidden.id,
      };
      const [detail] = sessionSourceDetails(fork, [fork, hidden]);
      expect(detail.session).toBeUndefined();
      expect(detail.label).not.toContain(hidden.title);
    },
  );

  it("preserves native IDs for verified managed execution aliases and deduplicates ownership", () => {
    const execution = { ...sessions[0], id: "native", origin: "execution" as const };
    const duplicate = { ...execution, id: "native-alias" };
    const owner = {
      ...sessions[0],
      id: "managed",
      origin: "interactive" as const,
      indexedSessionIds: [execution.id, duplicate.id],
    };
    const records = [execution, duplicate, { ...execution, id: "unowned" }];
    expect(projectManagedSessionAliases(records, [owner])).toEqual([
      { ...execution, origin: "interactive" },
      { ...execution, id: "unowned" },
    ]);
    expect(projectManagedSessionAliases(records, [owner], duplicate.id)).toEqual([
      { ...duplicate, origin: "interactive" },
      { ...execution, id: "unowned" },
    ]);
    expect(execution.origin).toBe("execution");
    expect(
      filterSessions(projectManagedSessionAliases(records, [owner]), workspaces, {
        query: "",
        agent: "all",
        filter: "all",
      }).map(({ id }) => id),
    ).toEqual(["native"]);
    for (const invalidOwner of [
      { ...owner, agent: "claude-code" as const },
      { ...owner, workspace_id: "another" },
      { ...owner, origin: "unknown" as const },
      { ...owner, indexedSessionIds: undefined },
    ])
      expect(projectManagedSessionAliases([execution], [invalidOwner])).toEqual([execution]);
    expect(
      projectManagedSessionAliases([execution], [owner, { ...owner, id: "other-owner" }]),
    ).toEqual([execution]);
    const auxiliary = { ...execution, origin: "auxiliary" as const };
    expect(projectManagedSessionAliases([auxiliary], [owner])).toEqual([auxiliary]);
  });

  it("shows five conversations when the native index also contains thirty-six executions", () => {
    const ordinary = Array.from({ length: 5 }, (_, index) => ({
      ...sessions[0],
      id: `ordinary-${index}`,
      origin: "interactive" as const,
    }));
    const executions = Array.from({ length: 36 }, (_, index) => ({
      ...sessions[0],
      id: `exec-${index}`,
      origin: "execution" as const,
      title: undefined,
    }));
    const records = [...ordinary, ...executions];
    expect(filterSessions(records, workspaces, { query: "", agent: "all", filter: "all" })).toEqual(
      ordinary,
    );
    expect(sessionCatalogStats(records)).toEqual({
      total: 5,
      readable: 5,
      archived: 0,
      metadata: 0,
    });
  });

  it.each(Object.values(SESSION_COLLECTIONS))(
    "applies ordinary directory filtering and statistics to %s",
    (workspaceId) => {
      const collection = { ...workspaces[0], id: workspaceId, name: "Collection", path: "" };
      const ordinary = { ...sessions[0], workspace_id: workspaceId, origin: "unknown" as const };
      const records = [
        ordinary,
        { ...ordinary, id: "execution", origin: "execution" as const },
        { ...ordinary, id: "auxiliary", origin: "auxiliary" as const },
      ];
      expect(
        filterSessions(records, [collection], { query: "", agent: "all", filter: "all" }),
      ).toEqual([ordinary]);
      expect(groupSessions(records, [collection])[0].sessions).toEqual([ordinary]);
      expect(sessionCatalogStats(records)).toEqual({
        total: 1,
        readable: 1,
        archived: 0,
        metadata: 0,
      });
    },
  );

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
      ["two", "app · company/app"],
      ["one", "app · personal/app"],
    ]);
    expect(groups[0].sessions.map(({ id }) => id)).toEqual(["archived"]);
  });

  describe("git worktrees", () => {
    const checkout = (
      kind: "primary" | "worktree",
      extra: Partial<NonNullable<WorkspaceSummary["checkout"]>> = {},
    ) => ({
      repository_group_id: "repo",
      kind,
      primary_path: "/work/app",
      name: kind === "worktree" ? "feature" : null,
      branch: "main",
      status: "present" as const,
      ...extra,
    });
    const worktree = (name: string, status: "present" | "deleted" | "unknown" = "present") => ({
      repository_group_id: "repo",
      name,
      path: `/worktrees/${name}/app`,
      branch: `codex/${name}`,
      status,
    });
    const at = (id: string, workspace_id: string, day: number, extra = {}) => ({
      ...sessions[0],
      id,
      workspace_id,
      updated_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00Z`,
      ...extra,
    });

    it("merges a repository's checkouts under its main checkout and marks worktree sessions", () => {
      const projects = [
        { id: "main", name: "app", path: "/work/app", checkout: checkout("primary") },
        {
          id: "wt",
          name: "app",
          path: "/worktrees/feature/app",
          checkout: checkout("worktree"),
        },
        { id: "home", name: "home", path: "/home" },
        { id: "other", name: "other", path: "/other" },
      ] as WorkspaceSummary[];
      const records = [
        at("primary", "main", 1),
        at("registered", "wt", 2, { worktree: worktree("feature") }),
        at("deleted", "home", 3, { worktree: worktree("h2", "deleted") }),
        at("plain", "home", 4),
        at("foreign", "other", 5, { worktree: { ...worktree("x"), repository_group_id: "else" } }),
      ];
      const groups = groupSessions(records, projects);
      expect(groups.map((group) => [group.id, group.sessions.map(({ id }) => id)])).toEqual([
        ["other", ["foreign"]],
        ["home", ["plain"]],
        ["main", ["deleted", "registered", "primary"]],
      ]);
      const repository = groups[2];
      expect(repository).toMatchObject({
        label: "app",
        path: "/work/app",
        workspaceIds: ["main", "wt"],
        worktrees: ["feature", "h2"],
        worktree: false,
      });
      expect(repository.workspace.id).toBe("main");
    });

    it("names a repository without a registered main checkout after its main folder", () => {
      const projects = [
        {
          id: "wt",
          name: "app",
          path: "/worktrees/feature/app",
          checkout: checkout("worktree", { primary_path: "/work/app-main" }),
        },
      ] as WorkspaceSummary[];
      const [group] = groupSessions([at("one", "wt", 1)], projects);
      expect(group).toMatchObject({
        name: "app-main",
        path: "/work/app-main",
        worktree: false,
        workspaceIds: ["wt"],
      });
      expect(group.id).not.toBe("wt");
      const [bare] = groupSessions(
        [at("one", "wt", 1)],
        [{ ...projects[0], checkout: checkout("worktree", { primary_path: null }) }],
      );
      expect(bare).toMatchObject({ name: "app", path: "/worktrees/feature/app", worktree: true });
    });

    it("keeps sessions of another host or an unregistered repository where they are", () => {
      const projects = [
        { id: "main", name: "app", path: "/work/app", checkout: checkout("primary") },
        {
          id: "remote-home",
          name: "home",
          path: "/home",
          remote: { host_id: "mac", online: true },
        },
      ] as WorkspaceSummary[];
      const groups = groupSessions(
        [at("remote", "remote-home", 1, { worktree: worktree("feature") })],
        projects,
      );
      expect(groups.map(({ id }) => id)).toEqual(["remote-home"]);
    });

    it("lists program-started sessions only when asked and searches worktree names", () => {
      const projects = [{ id: "one", name: "app", path: "/app" }] as WorkspaceSummary[];
      const records = [
        at("ordinary", "one", 1, { worktree: worktree("app-h1a") }),
        at("pen", "one", 2, { origin: "execution" as const }),
        at("helper", "one", 3, { origin: "auxiliary" as const }),
      ];
      const ids = (execution?: boolean) =>
        filterSessions(records, projects, {
          query: "",
          agent: "all",
          filter: "all",
          execution,
        }).map(({ id }) => id);
      expect(ids()).toEqual(["ordinary"]);
      expect(ids(true)).toEqual(["pen", "ordinary"]);
      expect(groupSessions(records, projects)[0].sessions.map(({ id }) => id)).toEqual([
        "ordinary",
      ]);
      expect(
        groupSessions(records, projects, { execution: true })[0].sessions.map(({ id }) => id),
      ).toEqual(["pen", "ordinary"]);
      expect(
        filterSessions(records, projects, { query: "H1A", agent: "all", filter: "all" }).map(
          ({ id }) => id,
        ),
      ).toEqual(["ordinary"]);
    });
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
    expect(groupSessions(records, projects).map(({ workspace }) => workspace.id)).toEqual([
      "one",
      "two",
      "remote",
    ]);
    expect(groupSessions(records, projects)[2].workspace.remote?.online).toBe(true);
  });
});
