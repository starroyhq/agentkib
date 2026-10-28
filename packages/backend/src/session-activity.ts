/** Compaction is independent of turn status and does not invalidate native approvals or stop. */
export function activityBlocks(snapshot: Record<string, unknown>, operation: string): boolean {
  return (
    snapshot.activity === "compacting" &&
    ([
      "send",
      "compact",
      "steer",
      "settings",
      "release",
      "fork",
      "adopt",
      "resume",
      "queue-start",
      "worktree-create",
      "branch-switch",
    ].includes(operation) ||
      operation.startsWith("goal-"))
  );
}
export function assertActivityAllows(snapshot: Record<string, unknown>, operation: string): void {
  if (activityBlocks(snapshot, operation)) throw new Error("session-compacting");
}
