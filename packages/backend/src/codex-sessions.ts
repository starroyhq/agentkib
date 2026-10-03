import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SessionCollection } from "@agentkib/runtime-protocol";
import { CodexSessionOwnership } from "./codex-session-ownership";
import { homedir } from "node:os";
import path from "node:path";
import { Sql } from "./sql";
import { within } from "./files";
import { compareUtf8 } from "./workspaces";
import { timestamp } from "./timestamps";
import type { NativeSession } from "./session-store";
function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
export function sessionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = [
    ...value
      .replace(/\p{Cc}/gu, " ")
      .split(/\p{White_Space}+/u)
      .filter(Boolean)
      .join(" "),
  ]
    .slice(0, 200)
    .join("");
  return !text ||
    [
      "<path>",
      "<content>",
      "<recommended_plugins>",
      "<available_skills>",
      "<app-context>",
      "<skills_instructions>",
      "<environment_context>",
      "# AGENTS.md instructions",
    ].some((prefix) => text.startsWith(prefix))
    ? null
    : text;
}
function integerTime(value: unknown): string | null {
  if (typeof value !== "bigint" && typeof value !== "number") return null;
  const integer = BigInt(value);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) return null;
  const milliseconds =
    integer <= -10000000000n || integer >= 10000000000n ? integer : integer * 1000n;
  try {
    return timestamp(new Date(Number(milliseconds)).toISOString());
  } catch {
    return null;
  }
}
function metadata(
  source: unknown,
  threadSource: unknown,
  parent: unknown,
  fork: unknown,
  malformed = false,
) {
  let evidence: "interactive" | "auxiliary" | "unknown" | "malformed" = "unknown",
    spawned: string | null = null;
  if (typeof source === "string") {
    evidence = ["cli", "vscode"].includes(source)
      ? "interactive"
      : source === "subagent"
        ? "auxiliary"
        : ["{", "["].some((prefix) => source.trimStart().startsWith(prefix))
          ? "malformed"
          : "unknown";
  } else if (source !== undefined && source !== null) {
    if (typeof source === "object" && !Array.isArray(source) && "subagent" in source) {
      const sub = source.subagent;
      if (typeof sub === "string" && sub.trim()) evidence = "auxiliary";
      else if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        if ("thread_spawn" in sub) {
          const spawn = sub.thread_spawn;
          if (spawn && typeof spawn === "object" && !Array.isArray(spawn)) {
            if (!("parent_thread_id" in spawn) || nonempty(spawn.parent_thread_id)) {
              evidence = "auxiliary";
              spawned = "parent_thread_id" in spawn ? nonempty(spawn.parent_thread_id) : null;
            } else evidence = "malformed";
          } else evidence = "malformed";
        } else evidence = Object.keys(sub).length ? "auxiliary" : "malformed";
      } else evidence = "malformed";
    } else evidence = "malformed";
  }
  const details =
    source &&
    typeof source === "object" &&
    "subagent" in source &&
    source.subagent &&
    typeof source.subagent === "object" &&
    "thread_spawn" in source.subagent
      ? source.subagent.thread_spawn
      : null;
  return {
    origin: (evidence === "interactive" || evidence === "auxiliary"
      ? evidence
      : evidence === "unknown" && !malformed && threadSource === "user"
        ? "interactive"
        : "unknown") as NativeSession["origin"],
    authoritative: evidence === "interactive" || evidence === "auxiliary",
    spawned_by_session_id: nonempty(parent) ?? spawned,
    forked_from_session_id: nonempty(fork),
    agent_path:
      details && typeof details === "object" && "agent_path" in details
        ? nonempty(details.agent_path)
        : null,
    agent_nickname:
      details && typeof details === "object" && "agent_nickname" in details
        ? nonempty(details.agent_nickname)
        : null,
  };
}
function sourceValue(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return { source: undefined, malformed: false };
  try {
    return { source: JSON.parse(value.trim()) as unknown, malformed: false };
  } catch {
    return {
      source: value.trim(),
      malformed: !["cli", "vscode", "subagent", "exec", "mcp", "unknown", "appServer"].includes(
        value.trim(),
      ),
    };
  }
}
function regularOpen(value: string): number {
  if (!lstatSync(value).isFile()) throw new Error("TRANSCRIPT_UNREADABLE");
  const fd = openSync(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new Error("TRANSCRIPT_UNREADABLE");
  }
  return fd;
}
function readable(value: string): boolean {
  try {
    const fd = regularOpen(value);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}
function header(value: string): ReturnType<typeof metadata> | null {
  let fd: number | undefined;
  try {
    fd = regularOpen(value);
    const data = Buffer.allocUnsafe(256 * 1024),
      size = readSync(fd, data, 0, data.length, 0),
      newline = data.indexOf(10, 0);
    if (newline < 0 || newline >= size) return null;
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, newline)),
    );
    if (parsed?.type !== "session_meta" || !parsed.payload || typeof parsed.payload !== "object")
      return null;
    const p = parsed.payload;
    return metadata(p.source, p.thread_source, p.parent_thread_id, p.forked_from_id);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export interface NativeSessionSource {
  collection?: SessionCollection | null;
  session: NativeSession;
  transcript: string;
  cwd: string;
}
/** Query metadata before bounded header enrichment so unrelated workspaces never trigger transcript reads. */
export class CodexSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  home(): string {
    return this.environment.CODEX_HOME ?? path.join(homedir(), ".codex");
  }
  databases(directory: string): string[] {
    try {
      return readdirSync(directory)
        .filter((name) => name.startsWith("state_") && name.endsWith(".sqlite"))
        .sort(compareUtf8)
        .map((name) => path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  verifiedControlIds(nativeRefs: Iterable<string>): Set<string> {
    const expected = new Set(
      [...nativeRefs].flatMap((value) => {
        const id = uuid(value);
        return id ? [id] : [];
      }),
    );
    if (!expected.size) return new Set();

    const home = this.home();
    const current = this.databases(home);
    const databases = current.length ? current : this.databases(path.join(home, "sqlite"));
    const verified = new Set<string>();
    for (const file of databases) {
      if (verified.size === expected.size) break;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const sql = new Sql(db);
        db.exec("PRAGMA busy_timeout=5000");
        const columns = new Set(
          sql.rows("PRAGMA table_info(threads)").map((row) => String(row.name)),
        );
        if (!["id", "rollout_path"].every((column) => columns.has(column))) continue;
        const pending = [...expected].filter((id) => !verified.has(id));
        for (let start = 0; start < pending.length; start += 500) {
          const ids = pending.slice(start, start + 500);
          const rows = sql.rows(
            `SELECT id, rollout_path FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`,
            ...ids,
          );
          for (const row of rows) {
            const id = uuid(String(row.id));
            if (!id || !expected.has(id)) continue;
            const rawPath = String(row.rollout_path);
            const transcript = path.isAbsolute(rawPath) ? rawPath : path.join(home, rawPath);
            if (verifiedCodexControlId(transcript, id)) verified.add(id);
          }
        }
      } finally {
        db.close();
      }
    }
    return verified;
  }
  list(
    workspace: string | null,
    selection: { collection?: SessionCollection; matches?: (nativeRef: string) => boolean } = {},
  ) {
    const home = this.home(),
      current = this.databases(home),
      databases = current.length ? current : this.databases(path.join(home, "sqlite")),
      sessions = new Map<string, NativeSessionSource>();
    const ownership = new CodexSessionOwnership(home, this.environment);
    let incomplete = false;
    for (const file of databases) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const sql = new Sql(db);
        db.exec("PRAGMA busy_timeout=5000");
        const columns = new Set(
          sql.rows("PRAGMA table_info(threads)").map((row) => String(row.name)),
        );
        if (["id", "cwd", "rollout_path"].some((column) => !columns.has(column))) {
          incomplete = true;
          continue;
        }
        const first = (names: string[], fallback = "NULL") =>
            names.find((name) => columns.has(name)) ?? fallback,
          titleColumns = ["name", "title", "preview"]
            .filter((name) => columns.has(name))
            .map((name) => `NULLIF(TRIM(${name}), '')`),
          title =
            titleColumns.length > 1
              ? `COALESCE(${titleColumns.join(",")})`
              : (titleColumns[0] ?? "NULL");
        const expressions = [
          "id",
          "rollout_path",
          "cwd",
          title,
          first(["created_at_ms", "created_at"]),
          first(["recency_at_ms", "updated_at_ms", "recency_at", "updated_at"]),
          first(["git_branch"]),
          first(["archived"], "0"),
          first(["source"]),
          first(["parent_thread_id"]),
          first(["forked_from_id"]),
          first(["thread_source"]),
          first(["agent_path"]),
          first(["agent_nickname"]),
          first(["project_id"]),
        ];
        for (const row of sql.rows(
          `SELECT ${expressions.map((expression, index) => `${expression} AS k${index}`).join(",")} FROM threads`,
        )) {
          const cwd = String(row.k2);
          const collection = ownership.collection(String(row.k0), cwd, row.k14);
          if (workspace !== null && (collection !== null || !within(cwd, workspace))) continue;
          if (selection.collection && collection !== selection.collection) continue;
          if (selection.matches && !selection.matches(String(row.k0))) continue;
          let transcript = String(row.k1);
          if (!path.isAbsolute(transcript)) transcript = path.join(home, transcript);
          const parsed = sourceValue(row.k8),
            p = nonempty(row.k9),
            f = nonempty(row.k10);
          let m = metadata(parsed.source, row.k11, p, f, parsed.malformed),
            agentPath = nonempty(row.k12) ?? m.agent_path,
            nickname = nonempty(row.k13) ?? m.agent_nickname;
          const needsOrigin = !nonempty(row.k8),
            needsSpawned = !p && !m.spawned_by_session_id,
            needsForked = !f && !m.forked_from_session_id,
            needsDetails =
              m.origin === "auxiliary" && !agentPath && (!sessionTitle(row.k3) || !nickname);
          if (needsOrigin || needsSpawned || needsForked || needsDetails) {
            const h = header(transcript);
            if (h) {
              if (
                needsOrigin &&
                ((h.origin === "auxiliary" && !m.authoritative) || m.origin === "unknown")
              )
                m = { ...m, origin: h.origin, authoritative: h.authoritative };
              if (needsSpawned) m.spawned_by_session_id = h.spawned_by_session_id;
              if (needsForked) m.forked_from_session_id = h.forked_from_session_id;
              agentPath ??= h.agent_path;
              nickname ??= h.agent_nickname;
            }
          }
          const title =
              sessionTitle(row.k3) ??
              (m.origin === "auxiliary"
                ? ((agentPath
                    ? sessionTitle(
                        agentPath.replace(/\/+$/, "").split("/").at(-1) === "root"
                          ? null
                          : agentPath.replace(/\/+$/, "").split("/").at(-1),
                      )
                    : null) ?? sessionTitle(nickname))
                : null),
            native_ref = String(row.k0);
          sessions.set(native_ref, {
            collection,
            cwd,
            transcript,
            session: {
              native_ref,
              agent: "codex",
              title,
              origin: m.origin,
              spawned_by_session_id: m.spawned_by_session_id,
              forked_from_session_id: m.forked_from_session_id,
              created_at: integerTime(row.k4),
              updated_at: integerTime(row.k5),
              message_count: null,
              git_branch: sessionTitle(row.k6),
              archived: Boolean(row.k7),
              sidechain: false,
              availability: readable(transcript) ? "readable" : "metadata-only",
            },
          });
        }
      } finally {
        db.close();
      }
    }
    return {
      sessions: [...sessions.entries()]
        .sort(([a], [b]) => compareUtf8(a, b))
        .map(([, value]) => value),
      incomplete,
    };
  }
}

function uuid(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function verifiedCodexControlId(transcript: string, expectedId: string): boolean {
  let fd: number | undefined;
  try {
    fd = regularOpen(transcript);
    const bytes = Buffer.allocUnsafe(64 * 1024);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.indexOf(10, 0);
    if (newline < 0 || newline >= size) return false;
    const firstLine = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline));
    const value: unknown = JSON.parse(firstLine);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as { type?: unknown; payload?: unknown };
    if (row.type !== "session_meta" || !row.payload || typeof row.payload !== "object")
      return false;
    const id = (row.payload as { id?: unknown }).id;
    return typeof id === "string" && uuid(id) === expectedId;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
