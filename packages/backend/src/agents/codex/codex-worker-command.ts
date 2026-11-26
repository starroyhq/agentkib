/** Counts a native command's observed start and completion once, even between supervision polls. */
export function recordWorkerCommand(
  commands: Map<string, number | null | undefined> | undefined,
  id: string,
  completed: boolean,
): boolean {
  if (!commands) return false;
  const prior = commands.get(id);
  if (prior === null || (!completed && prior !== undefined)) return false;
  commands.set(id, completed ? null : Date.now());
  return true;
}
