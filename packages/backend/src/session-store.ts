import { createHmac, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { RUNTIME_METHODS, sessionCollection } from "@agentkib/runtime-protocol";
import { agentSchema, parameters, type AGENTS } from "./rpc";
import { Sql, positive, type Row } from "./sql";
import { canonicalize, isDirectory, pathIdentity } from "./paths";
import { exists, withinLexical } from "./files";
import { timestamp } from "./timestamps";
import { compareUtf8, storedTime, utcNow } from "./workspaces";
type Agent = (typeof AGENTS)[number];
export function sessionIdentity(salt: string, agent: Agent, nativeRef: string): string {
  return createHmac("sha256", salt)
    .update(`conversation:${agent === "open-claw" ? "openclaw" : agent}:${nativeRef}`)
    .digest("hex");
}
export interface SessionOwner {
  id: string;
  aliases: string[];
}
const columns =
  "id,workspace_id,agent,title,created_at,updated_at,message_count,git_branch,archived,sidechain,availability,origin,spawned_by_session_id,forked_from_session_id";
const supported = [
  "codex",
  "claude-code",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "cursor",
];
export interface NativeSession {
  native_ref: string;
  agent: Agent;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number | null;
  git_branch: string | null;
  archived: boolean;
  sidechain: boolean;
  availability: "readable" | "metadata-only";
  origin: "interactive" | "auxiliary" | "execution" | "unknown";
  spawned_by_session_id?: string | null;
  forked_from_session_id?: string | null;
  /** The session's working directory; the catalog derives its git worktree from it. */
  cwd?: string | null;
  /** Codex records the origin remote, which places a deleted Codex worktree's sessions. */
  git_origin_url?: string | null;
}
export interface SessionDirectory {
  cwd: string | null;
  git_origin_url: string | null;
}
function time(value: unknown): string | null {
  if (value === null) return null;
  const parsed = timestamp(value);
  if (parsed === null) throw new Error("Invalid conversation timestamp");
  return parsed;
}
/** Shared with normalized providers so a root and its nested aliases own one stable session ID. */
export function sessionWorkspaceRoot(
  value: string,
  home: string | null = homedir(),
): string | null {
  if (!path.isAbsolute(value)) return null;
  let cwd: string;
  try {
    cwd = canonicalize(value);
  } catch {
    return null;
  }
  let resolvedHome: string | null = null;
  try {
    if (home) resolvedHome = canonicalize(home);
  } catch {}
  if (!isDirectory(cwd) || path.dirname(cwd) === cwd || cwd === resolvedHome) return null;
  for (
    let current = cwd;
    path.dirname(current) !== current && current !== resolvedHome;
    current = path.dirname(current)
  )
    if (
      [
        ".agentkib",
        ".git",
        "AGENTS.md",
        "CLAUDE.md",
        ".codex",
        ".claude",
        ".cursor",
        ".opencode",
        "opencode.json",
        "opencode.jsonc",
        ".grok",
        ".dsh",
      ].some((marker) => exists(path.join(current, marker)))
    )
      return current;
  return cwd;
}
export class SessionStore {
  constructor(
    readonly sql: Sql,
    readonly workspacePath: (id: string) => string,
  ) {}
  request(method: string, value: unknown) {
    const { workspaceId } = parameters(z.object({ workspaceId: z.string() }), value);
    return method === RUNTIME_METHODS.workspaceSessions
      ? this.list(workspaceId)
      : this.status(workspaceId);
  }
  list(id: string) {
    return this.sql
      .rows(
        `SELECT ${columns} FROM ${sessionTable(id)} WHERE workspace_id=?
         AND (agent!='codex' OR NOT EXISTS (
           SELECT 1 FROM schema_meta WHERE key='codex_session_classification_stale:' || ${sessionTable(id)}.id
         )) ORDER BY COALESCE(updated_at,created_at) DESC,id DESC`,
        id,
      )
      .map(sessionRow);
  }
  /** Working directories for catalog presentation; listings never expose them directly. */
  directories(ids: Iterable<string>): Map<string, SessionDirectory> {
    const wanted = JSON.stringify([...new Set(ids)]);
    return new Map(
      this.sql
        .rows(
          `SELECT id,cwd,git_origin_url FROM conversation_sessions
             WHERE cwd IS NOT NULL AND id IN (SELECT value FROM json_each(?))
           UNION ALL SELECT id,cwd,git_origin_url FROM conversation_collection_sessions
             WHERE cwd IS NOT NULL AND id IN (SELECT value FROM json_each(?))`,
          wanted,
          wanted,
        )
        .map((row) => [
          String(row.id),
          {
            cwd: row.cwd as string | null,
            git_origin_url: row.git_origin_url as string | null,
          },
        ]),
    );
  }
  codexClassificationPending(id: string): boolean {
    return !!this.sql.one(
      "SELECT 1 FROM schema_meta WHERE key=?",
      `codex_session_classification_pending:${id}`,
    );
  }
  get(id: string) {
    const row =
      this.sql.one(`SELECT ${columns} FROM conversation_sessions WHERE id=?`, id) ??
      this.sql.one(`SELECT ${columns} FROM conversation_collection_sessions WHERE id=?`, id);
    return row ? sessionRow(row) : null;
  }
  status(id: string) {
    const now = Date.now();
    return this.sql
      .rows(
        `SELECT workspace_id,agent,session_count,last_attempt_at,last_success_at,error_key,error_detail FROM ${statusTable(id)} WHERE workspace_id=? ORDER BY agent`,
        id,
      )
      .map((row) => {
        const success = time(row.last_success_at),
          attempt = time(row.last_attempt_at);
        return {
          workspace_id: String(row.workspace_id),
          agent: agentSchema.parse(row.agent),
          freshness: success
            ? Math.trunc((now - Date.parse(success)) / 60000) < 5 && row.error_key === null
              ? "fresh"
              : "stale"
            : "unavailable",
          session_count: positive(row.session_count),
          last_attempt_at: attempt,
          last_success_at: success,
          error_key: row.error_key as string | null,
          error_detail: row.error_detail as string | null,
        };
      });
  }
  clear(workspace: string | null): void {
    this.sql.transaction(() => {
      if (workspace === null)
        this.sql.run(
          "DELETE FROM schema_meta WHERE key GLOB 'codex_session_classification_pending:*' OR key GLOB 'codex_session_classification_stale:*'",
        );
      else
        this.sql.run(
          `DELETE FROM schema_meta WHERE key=? OR (
            key GLOB 'codex_session_classification_stale:*' AND (
              EXISTS (SELECT 1 FROM (${cachedSessionOwners}) AS session
                WHERE schema_meta.key='codex_session_classification_stale:' || session.id AND session.workspace_id=?)
              OR (value=? AND NOT EXISTS (SELECT 1 FROM (${cachedSessionOwners}) AS session
                WHERE schema_meta.key='codex_session_classification_stale:' || session.id))
            )
          )`,
          `codex_session_classification_pending:${workspace}`,
          workspace,
          workspace,
        );
      for (const table of [
        "conversation_sessions",
        "conversation_index_status",
        "conversation_collection_sessions",
        "conversation_collection_status",
      ]) {
        if (workspace !== null)
          this.sql.run(`DELETE FROM ${table} WHERE workspace_id=?`, workspace);
        else this.sql.run(`DELETE FROM ${table}`);
      }
    });
  }
  id(agent: Agent, nativeRef: string): string {
    return sessionIdentity(this.identitySalt(), agent, nativeRef);
  }
  identitySalt(): string {
    let salt = this.sql.one("SELECT value FROM schema_meta WHERE key='conversation_salt'")?.value;
    if (!salt) {
      this.sql.run(
        "INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('conversation_salt',?)",
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      );
      salt = this.sql.one("SELECT value FROM schema_meta WHERE key='conversation_salt'")!.value;
    }
    return String(salt);
  }
  owner(workspace: string): SessionOwner {
    const root = sessionWorkspaceRoot(this.workspacePath(workspace));
    if (!root) return { id: workspace, aliases: [] };
    const rootIdentity = pathIdentity(root);
    const candidates = this.sql
      .rows("SELECT canonical_path,id FROM workspaces ORDER BY length(canonical_path) DESC")
      .map((row) => ({ path: String(row.canonical_path), id: String(row.id) }))
      .filter((value) => {
        if (!withinLexical(pathIdentity(value.path), rootIdentity)) return false;
        const candidate = sessionWorkspaceRoot(value.path);
        return candidate !== null && pathIdentity(candidate) === rootIdentity;
      });
    candidates.sort((a, b) => {
      const rootA = pathIdentity(a.path) === pathIdentity(root),
        rootB = pathIdentity(b.path) === pathIdentity(root);
      return (
        Number(!rootA) - Number(!rootB) ||
        a.path.split(path.sep).filter(Boolean).length -
          b.path.split(path.sep).filter(Boolean).length ||
        compareUtf8(pathIdentity(a.path), pathIdentity(b.path)) ||
        compareUtf8(a.id, b.id)
      );
    });
    return { id: candidates[0]?.id ?? workspace, aliases: candidates.map((value) => value.id) };
  }
  sync(
    workspace: string,
    agent: Agent,
    sessions: NativeSession[],
    complete = true,
    normalizedOwner?: SessionOwner,
  ): void {
    if (!supported.includes(agent))
      throw new Error("Conversation indexing is not supported for this Agent");
    const collection = sessionCollection(workspace);
    if (collection && agent !== "codex") throw new Error("Collection provider is unavailable");
    if (!collection && !this.sql.one("SELECT id FROM workspaces WHERE id=?", workspace))
      throw new Error("Workspace does not exist");
    const table = sessionTable(workspace),
      status = statusTable(workspace);
    // Prepare opaque IDs and validate the entire batch before replacing any cache.
    const prepared = sessions.map((session) => {
      if (session.agent !== agent) throw new Error("Conversation batch contains a different Agent");
      const parent = (ref: string | null | undefined) =>
        ref && ref !== session.native_ref ? this.id(agent, ref) : null;
      return {
        ...session,
        id: this.id(agent, session.native_ref),
        created_at: time(session.created_at),
        updated_at: time(session.updated_at),
        spawned_by_session_id: parent(session.spawned_by_session_id),
        forked_from_session_id: parent(session.forked_from_session_id),
      };
    });
    const indexed = storedTime(utcNow());
    this.sql.transaction(() => {
      const owner = ["open-claw", "hermes", "grok-build"].includes(agent)
        ? (normalizedOwner ?? this.owner(workspace))
        : { id: workspace, aliases: [] };
      // The deepest registered workspace owns a session. An enclosing workspace (such as the
      // home folder) lists the same sessions, but must not take rows a nested one already holds.
      const nested = JSON.stringify(collection ? [] : this.#nestedWorkspaces(workspace, owner));
      for (const alias of owner.aliases.filter((id) => id !== owner.id)) {
        this.sql.run(
          "UPDATE conversation_sessions SET workspace_id=? WHERE workspace_id=? AND agent=?",
          owner.id,
          alias,
          agent,
        );
        this.sql.run(
          "UPDATE conversation_index_status SET session_count=0 WHERE workspace_id=? AND agent=?",
          alias,
          agent,
        );
      }
      if (complete && owner.id === workspace)
        this.sql.run(`DELETE FROM ${table} WHERE workspace_id=? AND agent=?`, workspace, agent);
      for (const session of prepared) {
        // Moving into/out of a collection retains the stable opaque ID and removes
        // the old cached ownership, including records created by earlier releases.
        this.sql.run(
          `DELETE FROM ${collection ? "conversation_sessions" : "conversation_collection_sessions"} WHERE id=?`,
          session.id,
        );
        this.sql.run(
          `INSERT INTO ${table}(${columns},cwd,git_origin_url,last_indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,agent=excluded.agent,title=excluded.title,created_at=excluded.created_at,updated_at=excluded.updated_at,message_count=excluded.message_count,git_branch=excluded.git_branch,archived=excluded.archived,sidechain=excluded.sidechain,availability=excluded.availability,origin=excluded.origin,spawned_by_session_id=excluded.spawned_by_session_id,forked_from_session_id=excluded.forked_from_session_id,cwd=excluded.cwd,git_origin_url=excluded.git_origin_url,last_indexed_at=excluded.last_indexed_at WHERE ${table}.workspace_id NOT IN (SELECT value FROM json_each(?))`,
          session.id,
          owner.id,
          agent,
          session.title,
          session.created_at === null ? null : storedTime(session.created_at),
          session.updated_at === null ? null : storedTime(session.updated_at),
          session.message_count === null ? null : BigInt(Math.max(0, session.message_count)),
          session.git_branch,
          Number(session.archived),
          Number(session.sidechain),
          session.availability,
          session.origin,
          session.spawned_by_session_id,
          session.forked_from_session_id,
          typeof session.cwd === "string" && path.isAbsolute(session.cwd) ? session.cwd : null,
          typeof session.git_origin_url === "string" && session.git_origin_url.trim()
            ? session.git_origin_url.trim()
            : null,
          indexed,
          nested,
        );
        // A row kept by a nested workspace was not rewritten, so its marker stays.
        if (agent === "codex")
          this.sql.run(
            `DELETE FROM schema_meta WHERE key=? AND EXISTS (SELECT 1 FROM ${table} WHERE id=? AND workspace_id=?)`,
            `codex_session_classification_stale:${session.id}`,
            session.id,
            owner.id,
          );
      }
      if (owner.id !== workspace)
        this.sql.run(
          "UPDATE conversation_index_status SET session_count=(SELECT COUNT(*) FROM conversation_sessions WHERE workspace_id=? AND agent=?) WHERE workspace_id=? AND agent=?",
          owner.id,
          agent,
          owner.id,
          agent,
        );
      const count = positive(
        this.sql.one(
          `SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=? AND agent=?`,
          workspace,
          agent,
        )?.count,
      );
      this.sql.run(
        `INSERT INTO ${status}(workspace_id,agent,session_count,last_attempt_at,last_success_at,error_key,error_detail) VALUES (?,?,?,?,?,NULL,NULL) ON CONFLICT(workspace_id,agent) DO UPDATE SET session_count=excluded.session_count,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error_key=NULL,error_detail=NULL`,
        workspace,
        agent,
        count,
        indexed,
        indexed,
      );
      if (agent === "codex") {
        if (complete)
          this.sql.run(
            "DELETE FROM schema_meta WHERE key=? OR (key GLOB 'codex_session_classification_stale:*' AND value=?)",
            `codex_session_classification_pending:${workspace}`,
            workspace,
          );
        else
          this.sql.run(
            `DELETE FROM schema_meta WHERE key=? AND NOT EXISTS (
              SELECT 1 FROM ${table} AS session JOIN schema_meta AS stale
                ON stale.key='codex_session_classification_stale:' || session.id
              WHERE session.workspace_id=? AND session.agent='codex'
            )`,
            `codex_session_classification_pending:${workspace}`,
            workspace,
          );
      }
    });
  }
  /** Registered workspaces strictly inside this one, except those merged into its owner. */
  #nestedWorkspaces(workspace: string, owner: SessionOwner): string[] {
    let base: string;
    try {
      base = pathIdentity(this.workspacePath(workspace));
    } catch {
      return [];
    }
    const merged = new Set([workspace, owner.id, ...owner.aliases]);
    return this.sql
      .rows("SELECT id,canonical_path FROM workspaces")
      .filter((row) => {
        if (merged.has(String(row.id))) return false;
        const candidate = pathIdentity(String(row.canonical_path));
        return candidate !== base && withinLexical(candidate, base);
      })
      .map((row) => String(row.id));
  }
  /** Drop the cached rows of conversations deleted at their source; the next scan agrees. */
  forget(ids: readonly string[]): void {
    this.sql.transaction(() => {
      for (const id of new Set(ids)) {
        const owners = this.sql.rows(
          `SELECT workspace_id,agent FROM (${cachedSessionAgents}) WHERE id=?`,
          id,
        );
        this.sql.run("DELETE FROM conversation_sessions WHERE id=?", id);
        this.sql.run("DELETE FROM conversation_collection_sessions WHERE id=?", id);
        this.sql.run(
          "DELETE FROM schema_meta WHERE key=?",
          `codex_session_classification_stale:${id}`,
        );
        for (const owner of owners) {
          const workspace = String(owner.workspace_id);
          const agent = String(owner.agent);
          this.sql.run(
            `UPDATE ${statusTable(workspace)} SET session_count=(SELECT COUNT(*) FROM ${sessionTable(workspace)} WHERE workspace_id=? AND agent=?) WHERE workspace_id=? AND agent=?`,
            workspace,
            agent,
            workspace,
            agent,
          );
        }
      }
    });
  }
  failure(workspace: string, agent: Agent, detail: string): void {
    this.sql.run(
      `INSERT INTO ${statusTable(workspace)}(workspace_id,agent,session_count,last_attempt_at,last_success_at,error_key,error_detail) VALUES (?,?,0,?,NULL,?,?) ON CONFLICT(workspace_id,agent) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error_key=excluded.error_key,error_detail=excluded.error_detail`,
      workspace,
      agent,
      storedTime(utcNow()),
      "errors.conversations.sourceUnavailable",
      detail,
    );
  }
}
const cachedSessionOwners =
  "SELECT id,workspace_id FROM conversation_sessions UNION ALL SELECT id,workspace_id FROM conversation_collection_sessions";
const cachedSessionAgents =
  "SELECT id,workspace_id,agent FROM conversation_sessions UNION ALL SELECT id,workspace_id,agent FROM conversation_collection_sessions";
function sessionTable(id: string): string {
  return sessionCollection(id) ? "conversation_collection_sessions" : "conversation_sessions";
}
function statusTable(id: string): string {
  return sessionCollection(id) ? "conversation_collection_status" : "conversation_index_status";
}
function sessionRow(row: Row) {
  const origin = z.enum(["interactive", "auxiliary", "execution", "unknown"]).safeParse(row.origin);
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    agent: agentSchema.parse(row.agent),
    title: row.title as string | null,
    created_at: time(row.created_at),
    updated_at: time(row.updated_at),
    message_count: row.message_count === null ? null : positive(row.message_count),
    git_branch: row.git_branch as string | null,
    archived: Boolean(row.archived),
    sidechain: Boolean(row.sidechain),
    availability: z.enum(["readable", "metadata-only"]).parse(row.availability),
    origin: origin.success ? origin.data : "unknown",
    spawned_by_session_id: row.spawned_by_session_id as string | null,
    forked_from_session_id: row.forked_from_session_id as string | null,
  };
}
