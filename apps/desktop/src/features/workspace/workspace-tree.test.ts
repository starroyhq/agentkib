import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@/core/types";
import { primaryName, workspaceTree } from "./workspace-tree";

const workspace = (
  id: string,
  path: string,
  checkout?: Partial<NonNullable<WorkspaceSummary["checkout"]>>,
): WorkspaceSummary => ({
  id,
  name: path.split("/").pop()!,
  path,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
  ...(checkout
    ? {
        checkout: {
          repository_group_id: "repo",
          kind: "primary",
          primary_path: "/work/app",
          name: null,
          branch: "main",
          status: "present",
          ...checkout,
        },
      }
    : {}),
});

describe("workspace tree", () => {
  it("lists worktrees under their main checkout and keeps everything else in order", () => {
    const main = workspace("main", "/work/app", {});
    const one = workspace("one", "/codex/one/app", { kind: "worktree", name: "one" });
    const two = workspace("two", "/codex/two/app", { kind: "worktree", name: "two" });
    const other = workspace("other", "/work/other");
    const rows = workspaceTree([one, other, main, two]);
    expect(rows.map((row) => [row.workspace.id, row.worktrees.map(({ id }) => id)])).toEqual([
      ["other", []],
      ["main", ["one", "two"]],
    ]);
  });

  it("keeps a worktree whose main checkout is absent or on another host as its own row", () => {
    const orphan = workspace("orphan", "/codex/one/app", { kind: "worktree", name: "one" });
    const remoteMain = {
      ...workspace("remote", "/work/app", {}),
      remote: {
        host_id: "mac",
        host_name: "Mac",
        original_id: "main",
        online: true,
        last_synced_at: "2026-10-01T00:00:00Z",
      },
    };
    expect(workspaceTree([orphan, remoteMain]).map((row) => row.worktrees.length)).toEqual([0, 0]);
    expect(primaryName(orphan)).toBe("app");
    expect(primaryName(orphan, workspace("main", "/elsewhere/main", {}))).toBe("main");
  });
});
