/** Browser-safe presentation rules shared by desktop and Web. */
export type CheckoutStatus = "present" | "deleted" | "unknown";

/** A workspace's git checkout; every worktree of one repository shares the group ID. */
export interface CatalogCheckout {
  repository_group_id: string;
  kind: "primary" | "worktree";
  primary_path: string | null;
  name: string | null;
  branch: string | null;
  status: CheckoutStatus;
}

/** The linked git worktree a session ran in; sessions in a main checkout carry none. */
export interface CatalogWorktree {
  repository_group_id: string | null;
  name: string;
  path: string;
  branch: string | null;
  status: CheckoutStatus;
}

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
  worktree?: CatalogWorktree | null;
}

export interface CatalogWorkspace {
  id: string;
  name: string;
  path: string;
  remote?: { host_id: string };
  checkout?: CatalogCheckout | null;
}

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";
export interface SessionCatalogFilter {
  query: string;
  agent: string;
  filter: SessionRecordFilter;
  /** Also list sessions a program started (SDK and `-p` runs, Codex `exec`). */
  execution?: boolean;
}
export interface SessionVisibility {
  execution?: boolean;
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

export function isSessionVisible(session: Pick<CatalogSession, "origin">): boolean {
  return session.origin !== "auxiliary" && session.origin !== "execution";
}

/** Auxiliary records never list; program-started ones only when the directory asks for them. */
export function isSessionListed(
  session: Pick<CatalogSession, "origin">,
  visibility: SessionVisibility = {},
): boolean {
  return isSessionVisible(session) || (session.origin === "execution" && !!visibility.execution);
}

export function isExecutionSession(session: Pick<CatalogSession, "origin">): boolean {
  return session.origin === "execution";
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
  { query, agent, filter, execution }: SessionCatalogFilter,
  untitled: string,
): S[] {
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const search = query.trim().toLocaleLowerCase();
  return sortSessions(
    sessions.filter((session) => {
      if (!isSessionListed(session, { execution }) || !names.has(session.workspace_id))
        return false;
      if (agent !== "all" && session.agent !== agent) return false;
      if (filter === "current" && (session.archived || session.availability !== "readable"))
        return false;
      if (filter === "archived" && !session.archived) return false;
      if (filter === "metadata" && session.availability !== "metadata-only") return false;
      return (
        !search ||
        [
          displaySessionTitle(session.title, untitled),
          names.get(session.workspace_id) ?? "",
          session.worktree?.name ?? "",
        ].some((value) => value.toLocaleLowerCase().includes(search))
      );
    }),
  );
}

interface GroupIdentity {
  id: string;
  name: string;
  path: string;
  host: string;
}

function groupLabel(group: GroupIdentity, groups: readonly GroupIdentity[]): string {
  const peers = groups.filter(
    (candidate) => candidate.name === group.name && candidate.host === group.host,
  );
  if (peers.length < 2) return group.name;
  const parts = (path: string) => (path ?? "").replace(/\\/g, "/").split("/").filter(Boolean);
  const own = parts(group.path);
  for (let count = 2; count <= own.length; count++) {
    const suffix = own.slice(-count).join("/");
    if (
      peers.every(
        (candidate) =>
          candidate.id === group.id || parts(candidate.path).slice(-count).join("/") !== suffix,
      )
    ) {
      return `${group.name} · ${suffix}`;
    }
  }
  return group.path ? `${group.name} · ${group.path}` : group.name;
}

export interface SessionGroup<S extends CatalogSession, W extends CatalogWorkspace> {
  /** Stable key for collapse and ordering: the main checkout's workspace ID when it is registered. */
  id: string;
  /** The workspace that names the group; for a repository, its main checkout when registered. */
  workspace: W;
  name: string;
  path: string;
  label: string;
  sessions: S[];
  /** Workspaces merged into this group because they are checkouts of one repository. */
  workspaceIds: string[];
  /** Distinct worktrees the group's sessions ran in, by name. */
  worktrees: string[];
  /** The group is itself a linked worktree whose main checkout is unknown. */
  worktree: boolean;
}

function basename(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
}

interface Repository<W extends CatalogWorkspace> {
  identity: GroupIdentity;
  workspace: W;
  members: W[];
  worktree: boolean;
}

/**
 * Checkouts of one repository share a group, named by the main checkout. A session that ran
 * in a worktree joins its repository's group when the repository has a registered checkout.
 */
export function groupSessions<S extends CatalogSession, W extends CatalogWorkspace>(
  sessions: readonly S[],
  workspaces: readonly W[],
  visibility: SessionVisibility = {},
): SessionGroup<S, W>[] {
  const host = (workspace: CatalogWorkspace) => workspace.remote?.host_id ?? "";
  const repositoryKey = (workspaceHost: string, group: string) =>
    JSON.stringify([workspaceHost, group]);
  const repositories = new Map<string, Repository<W>>();
  for (const workspace of workspaces) {
    const group = workspace.checkout?.repository_group_id;
    if (!group) continue;
    const key = repositoryKey(host(workspace), group);
    const repository = repositories.get(key);
    if (repository) repository.members.push(workspace);
    else
      repositories.set(key, {
        identity: { id: "", name: "", path: "", host: host(workspace) },
        workspace,
        members: [workspace],
        worktree: false,
      });
  }
  for (const [key, repository] of repositories) {
    const primaries = repository.members
      .filter((member) => member.checkout?.kind === "primary")
      .sort((left, right) => left.path.length - right.path.length);
    const primary = primaries[0];
    const known = repository.members.find((member) => member.checkout?.primary_path)?.checkout
      ?.primary_path;
    repository.workspace = primary ?? repository.members[0]!;
    repository.worktree = !primary && !known;
    repository.identity = primary
      ? { id: primary.id, name: primary.name, path: primary.path, host: host(primary) }
      : {
          id: `repository:${key}`,
          name: (known && basename(known)) || repository.workspace.name,
          path: known ?? repository.workspace.path,
          host: host(repository.workspace),
        };
  }
  const identities = new Map<string, GroupIdentity>();
  const ownGroup = new Map<string, GroupIdentity>();
  for (const workspace of workspaces) {
    const group = workspace.checkout?.repository_group_id;
    const identity = group
      ? repositories.get(repositoryKey(host(workspace), group))!.identity
      : { id: workspace.id, name: workspace.name, path: workspace.path, host: host(workspace) };
    ownGroup.set(workspace.id, identity);
    identities.set(identity.id, identity);
  }
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const buckets = new Map<string, S[]>();
  for (const session of sortSessions(
    sessions.filter((session) => isSessionListed(session, visibility)),
  )) {
    const owner = byId.get(session.workspace_id);
    if (!owner) continue;
    const worktreeGroup = session.worktree?.repository_group_id;
    const identity =
      (worktreeGroup && repositories.get(repositoryKey(host(owner), worktreeGroup))?.identity) ||
      ownGroup.get(owner.id)!;
    const bucket = buckets.get(identity.id) ?? [];
    bucket.push(session);
    buckets.set(identity.id, bucket);
  }
  const all = [...identities.values()];
  const repositoryById = new Map(
    [...repositories.values()].map((repository) => [repository.identity.id, repository]),
  );
  const groups: SessionGroup<S, W>[] = [];
  for (const identity of all) {
    const rows = buckets.get(identity.id);
    if (!rows?.length) continue;
    const repository = repositoryById.get(identity.id);
    const worktrees = new Map<string, string>();
    for (const session of rows)
      if (session.worktree) worktrees.set(session.worktree.path, session.worktree.name);
    groups.push({
      id: identity.id,
      workspace: repository?.workspace ?? byId.get(identity.id)!,
      name: identity.name,
      path: identity.path,
      label: groupLabel(identity, all),
      sessions: rows,
      workspaceIds: repository ? repository.members.map((member) => member.id) : [identity.id],
      worktrees: [...new Set(worktrees.values())].sort((left, right) => left.localeCompare(right)),
      worktree: repository?.worktree ?? false,
    });
  }
  return groups.sort(
    (left, right) =>
      (left.workspace.remote?.host_id ?? "").localeCompare(right.workspace.remote?.host_id ?? "") ||
      timestamp(right.sessions[0]!) - timestamp(left.sessions[0]!),
  );
}

/** The directory group a session appears in, for revealing it. */
export function sessionGroupId<S extends CatalogSession, W extends CatalogWorkspace>(
  session: S,
  workspaces: readonly W[],
): string | undefined {
  return groupSessions([{ ...session, origin: "interactive" }], workspaces)[0]?.id;
}
