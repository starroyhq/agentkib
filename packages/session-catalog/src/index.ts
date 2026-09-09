/** Browser-safe presentation rules shared by desktop and Web. */
export interface CatalogSession {
  id: string;
  workspace_id: string;
  agent: string;
  availability: string;
  title?: string | null;
  archived?: boolean;
  origin?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

export interface CatalogWorkspace {
  id: string;
  name: string;
  path: string;
  remote?: { host_id: string };
}

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";
export interface SessionCatalogFilter {
  query: string;
  agent: string;
  filter: SessionRecordFilter;
  showAuxiliary?: boolean;
}

const internalTitlePrefixes = [
  "<path>",
  "<content>",
  "<recommended_plugins>",
  "<available_skills>",
  "<app-context>",
  "<skills_instructions>",
  "<environment_context>",
  "# AGENTS.md instructions",
  "# Files mentioned by the user",
  "# Applications mentioned by the user",
];

export function displaySessionTitle(title: string | null | undefined, untitled: string): string {
  const value = title?.trim();
  if (!value) return untitled;
  if (!internalTitlePrefixes.some((prefix) => value.startsWith(prefix))) return value;
  // Only a known wrapper with an explicit request boundary is safe to unwrap.
  const marker = /(?:^|\s)## My request:\s*/.exec(value);
  if (!marker) return untitled;
  const request = value
    .slice(marker.index + marker[0].length)
    .split(/<image(?:\s|>)/, 1)[0]
    .trim();
  return request && !internalTitlePrefixes.some((prefix) => request.startsWith(prefix))
    ? request
    : untitled;
}

export function isAuxiliarySession(session: Pick<CatalogSession, "origin">): boolean {
  return session.origin === "auxiliary";
}

export function isSessionVisible(
  session: Pick<CatalogSession, "origin">,
  showAuxiliary = false,
): boolean {
  return showAuxiliary || !isAuxiliarySession(session);
}

function timestamp(session: Pick<CatalogSession, "updated_at" | "created_at">): number {
  for (const source of [session.updated_at, session.created_at]) {
    const value = Date.parse(source ?? "");
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function sortSessions<S extends CatalogSession>(sessions: readonly S[]): S[] {
  // Stable sort retains input order for ties and missing timestamps.
  return [...sessions].sort((left, right) => timestamp(right) - timestamp(left));
}

export function filterSessions<S extends CatalogSession>(
  sessions: readonly S[],
  workspaces: readonly CatalogWorkspace[],
  { query, agent, filter, showAuxiliary = false }: SessionCatalogFilter,
  untitled: string,
): S[] {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const search = query.trim().toLocaleLowerCase();
  return sortSessions(
    sessions.filter((session) => {
      if (!isSessionVisible(session, showAuxiliary) || !names.has(session.workspace_id))
        return false;
      if (agent !== "all" && session.agent !== agent) return false;
      if (filter === "current" && (session.archived || session.availability !== "readable"))
        return false;
      if (filter === "archived" && !session.archived) return false;
      if (filter === "metadata" && session.availability !== "metadata-only") return false;
      return (
        !search ||
        [displaySessionTitle(session.title, untitled), names.get(session.workspace_id) ?? ""].some(
          (value) => value.toLocaleLowerCase().includes(search),
        )
      );
    }),
  );
}

function workspaceLabel<W extends CatalogWorkspace>(
  workspace: W,
  workspaces: readonly W[],
): string {
  const peers = workspaces.filter(
    (candidate) =>
      candidate.name === workspace.name &&
      (candidate.remote?.host_id ?? "") === (workspace.remote?.host_id ?? ""),
  );
  if (peers.length < 2) return workspace.name;
  const parts = (path: string) => (path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const own = parts(workspace.path);
  for (let count = 2; count <= own.length; count++) {
    const suffix = own.slice(-count).join("/");
    if (
      peers.every(
        (candidate) =>
          candidate.id === workspace.id || parts(candidate.path).slice(-count).join("/") !== suffix,
      )
    ) {
      return `${workspace.name} · ${suffix}`;
    }
  }
  return workspace.path ? `${workspace.name} · ${workspace.path}` : workspace.name;
}

export function groupSessions<S extends CatalogSession, W extends CatalogWorkspace>(
  sessions: readonly S[],
  workspaces: readonly W[],
): { workspace: W; sessions: S[]; label: string }[] {
  const buckets = new Map<string, S[]>();
  for (const session of sortSessions(sessions)) {
    const bucket = buckets.get(session.workspace_id) ?? [];
    bucket.push(session);
    buckets.set(session.workspace_id, bucket);
  }
  return workspaces
    .map((workspace) => ({
      workspace,
      sessions: buckets.get(workspace.id) ?? [],
      label: workspaceLabel(workspace, workspaces),
    }))
    .filter((group) => group.sessions.length > 0)
    .sort(
      (left, right) =>
        (left.workspace.remote?.host_id ?? "").localeCompare(
          right.workspace.remote?.host_id ?? "",
        ) || timestamp(right.sessions[0]) - timestamp(left.sessions[0]),
    );
}
