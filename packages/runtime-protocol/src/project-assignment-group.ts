type CheckoutGroup = { repository_group_id: string | null };

/** The execution project used by desktop, paired requests and the final backend admission. */
export function assignmentProjectKeys(
  sessions: readonly {
    id: string;
    workspace_id: string;
    worktree?: CheckoutGroup | null;
  }[],
  workspaces: readonly { id: string; checkout?: CheckoutGroup | null }[],
): Map<string, string> {
  const owners = new Map(
    workspaces.map(({ id, checkout }) => [id, checkout?.repository_group_id ?? null]),
  );
  const registeredRepositories = new Set(owners.values());
  const keys = new Map<string, string>();
  for (const session of sessions) {
    const owner = owners.get(session.workspace_id);
    if (owner === undefined) continue;
    const worktree = session.worktree?.repository_group_id;
    const group = worktree && registeredRepositories.has(worktree) ? worktree : owner;
    keys.set(session.id, group ? `repository:${group}` : `workspace:${session.workspace_id}`);
  }
  return keys;
}
