import { assignmentProjectKeys } from "@agentkib/runtime-protocol";
import { homedir } from "node:os";
import { join } from "node:path";
import { managedRecordInWorkspace } from "./agents/codex/managed-records";
import { GitCheckouts, type CheckoutWorkspace } from "./git-checkouts";
import type { BackendStore } from "./store";

export type AssignmentProject = {
  projectKey: string;
  leadWorkspaceId: string;
  workers: { sessionId: string; workspaceId: string }[];
};

export type AssignWorkersInput = {
  sessionId: string;
  deviceId: string;
  workspaceId: string;
  workers: string[];
  authorizedWorkspaceIds?: readonly string[];
  assignmentProject?: AssignmentProject;
  mayDelegateApprovals?: boolean;
  admission?: AbortSignal;
  beforeRegistration?: () => void;
  prepareLead?: (register: () => { designated: boolean }) => Promise<{ designated: boolean }>;
};

/** Recheck just the selected conversations with the same worktree grouping as the directory. */
export function assignmentProjectLookup(
  store: BackendStore,
  dataDir: string,
  environment: NodeJS.ProcessEnv,
  claudeIndexId: (sessionId: string) => unknown,
) {
  return (participants: AssignmentProject["workers"], authorizedWorkspaceIds: readonly string[]) =>
    currentAssignmentProjectKey({
      participants,
      authorizedWorkspaceIds,
      store,
      dataDir,
      codexHome: environment.CODEX_HOME ?? join(homedir(), ".codex"),
      claudeIndexId,
    });
}

function currentAssignmentProjectKey(input: {
  participants: AssignmentProject["workers"];
  authorizedWorkspaceIds: readonly string[];
  store: BackendStore;
  dataDir: string;
  codexHome: string;
  claudeIndexId: (sessionId: string) => unknown;
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
    if (codex?.native_id)
      return { source: store.sessions.id("codex", codex.native_id), cwd: codex.cwd };
    const indexedId = input.claudeIndexId(sessionId);
    const source = typeof indexedId === "string" ? indexedId : sessionId;
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
