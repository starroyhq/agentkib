import { assignmentProjectKeys } from "@agentkib/runtime-protocol";
import { managedRecordInWorkspace } from "./agents/codex/managed-records";
import { GitCheckouts, type CheckoutWorkspace } from "./git-checkouts";
import type { BackendStore } from "./store";

export type AssignmentProject = {
  projectKey: string;
  leadWorkspaceId: string;
  workers: { sessionId: string; workspaceId: string }[];
};

/** Recheck just the selected conversations with the same worktree grouping as the directory. */
export function currentAssignmentProjectKey(input: {
  participants: AssignmentProject["workers"];
  authorizedWorkspaceIds: readonly string[];
  store: BackendStore;
  dataDir: string;
  codexHome: string;
  claudeIndexId: (sessionId: string) => string | undefined;
}): string | undefined {
  const { participants, store, dataDir, codexHome } = input;
  const allowed = new Set(input.authorizedWorkspaceIds);
  const registered = (store.listWorkspaces() as CheckoutWorkspace[]).filter(({ id }) =>
    allowed.has(id),
  );
  const checkouts = new GitCheckouts(0).snapshot(registered, codexHome);
  const workspaces = registered.map((row) => ({
    ...row,
    checkout: checkouts.workspace(row.id),
  }));
  const sources = participants.map(({ sessionId }) => {
    if (store.sessions.get(sessionId)) return { source: sessionId };
    const codex = managedRecordInWorkspace(dataDir, store, sessionId);
    const source = codex?.native_id
      ? store.sessions.id("codex", codex.native_id)
      : (input.claudeIndexId(sessionId) ?? sessionId);
    return { source, cwd: codex?.cwd };
  });
  const directories = store.sessions.directories(sources.map(({ source }) => source));
  const rows = participants.map(({ sessionId, workspaceId }, index) => {
    const { cwd, source } = sources[index]!;
    const directory = directories.get(source);
    return {
      id: sessionId,
      workspace_id: workspaceId,
      worktree: directory
        ? checkouts.session(directory.cwd, directory.git_origin_url)
        : cwd
          ? checkouts.session(cwd, null)
          : undefined,
    };
  });
  const keys = assignmentProjectKeys(rows, workspaces);
  return keys.size === participants.length && new Set(keys.values()).size === 1
    ? keys.values().next().value
    : undefined;
}
