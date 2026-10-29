import { tr as defaultTranslate } from "@/core/i18n";
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

/** Rows in display order: each main checkout followed by its worktrees. */
export function workspaceTreeEntries(workspaces: readonly WorkspaceSummary[]) {
  return workspaceTree(workspaces).flatMap((row) => [
    { workspace: row.workspace, primary: undefined as WorkspaceSummary | undefined },
    ...row.worktrees.map((workspace) => ({ workspace, primary: row.workspace })),
  ]);
}

/** Says which repository a worktree belongs to; deleted and unknown states are spelled out. */
export function workspaceWorktreeLabel(
  workspace: WorkspaceSummary,
  primary: WorkspaceSummary | undefined,
  tr = defaultTranslate,
): string | null {
  const checkout = workspace.checkout;
  if (checkout?.kind !== "worktree") return null;
  const name = checkout.name ?? workspace.name;
  if (checkout.status === "deleted") return tr("workspace.worktree.deleted", { name });
  if (checkout.status === "unknown") return tr("workspace.worktree.unknown", { name });
  const values = { name, primary: primaryName(workspace, primary) };
  return checkout.branch
    ? tr("workspace.worktree.present", { ...values, branch: checkout.branch })
    : tr("workspace.worktree.presentNoBranch", values);
}
