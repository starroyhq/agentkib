import type { WorkspaceSummary } from "@/core/types";

export interface WorkspaceTreeRow {
  workspace: WorkspaceSummary;
  /** Linked worktrees of this main checkout, listed under it. */
  worktrees: WorkspaceSummary[];
}

/**
 * Lists each git worktree under its repository's main checkout. A worktree whose main
 * checkout is not in the list stays a row of its own, so filtering never hides it.
 */
export function workspaceTree(workspaces: readonly WorkspaceSummary[]): WorkspaceTreeRow[] {
  const key = (workspace: WorkspaceSummary) =>
    workspace.checkout
      ? JSON.stringify([workspace.remote?.host_id ?? "", workspace.checkout.repository_group_id])
      : null;
  const primaries = new Map<string, WorkspaceTreeRow>();
  const rows: WorkspaceTreeRow[] = workspaces.map((workspace) => ({ workspace, worktrees: [] }));
  for (const row of rows) {
    const group = key(row.workspace);
    if (!group || row.workspace.checkout?.kind !== "primary") continue;
    const existing = primaries.get(group);
    if (!existing || row.workspace.path.length < existing.workspace.path.length)
      primaries.set(group, row);
  }
  return rows.filter((row) => {
    const group = key(row.workspace);
    const primary = group && row.workspace.checkout?.kind === "worktree" && primaries.get(group);
    if (!primary) return true;
    primary.worktrees.push(row.workspace);
    return false;
  });
}

/** The repository a worktree belongs to, named after its main checkout's folder. */
export function primaryName(workspace: WorkspaceSummary, primary?: WorkspaceSummary): string {
  if (primary) return primary.name;
  const path = workspace.checkout?.primary_path;
  return (path && path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()) || workspace.name;
}
