import { opendirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDirectory } from "./paths";
import { isFile } from "./files";
import { userHome } from "./mcp-config-read";
import { isReparseOrSymlink } from "./native-files";
import { sessionTitle } from "./codex-sessions";
import { Sql } from "./sql";
import { finiteJson } from "./config-merge";
import {
  belongsToWorkspace,
  historyOrder,
  jsonTimestamp,
  MAX_DISCOVERY_FILES,
  readHeadTail,
  readableHistory,
  stableNativeRef,
  type NativeHistorySource,
} from "./session-history";
export interface HermesSource extends NativeHistorySource {
  source: { type: "jsonl"; path: string } | { type: "sqlite"; path: string; sessionId: string };
}
const first = (row: any, a: string, b: string) =>
  row && Object.hasOwn(row, a) ? row[a] : row?.[b];
const text = (value: unknown) => (typeof value === "string" ? value : null);
function messageText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return (
    value
      .filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
      .map((block) => text(block?.text))
      .filter((value) => value !== null)
      .join("\n") || null
  );
}
export function textTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^[+-]?\d+$/.test(value)) return jsonTimestamp(Number(value));
  if (value.trim() === value && value.length) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0 && number < Number(9223372036854775807n))
      return jsonTimestamp(Math.trunc(number));
  }
  return jsonTimestamp(value);
}
function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set(new Sql(db).rows(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
}
export function hermesMessagesSupported(file: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const names = columns(db, "messages");
    if (
      ![
        ["session_id", "sessionId", "session", "conversation_id", "conversationId"],
        ["role", "speaker"],
        ["content", "text", "message"],
      ].every((group) => group.some((name) => names.has(name)))
    )
      return false;
    db.prepare("SELECT rowid FROM messages LIMIT 1");
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
export class HermesSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  home(): string | null {
    const home = userHome(this.environment);
    return this.environment.HERMES_HOME ?? (home ? path.join(home, ".hermes") : null);
  }
  list(workspace: string | null) {
    const base = this.home(),
      sessions: HermesSource[] = [],
      budget = { visited: 0, incomplete: false };
    if (base === null) return { sessions, incomplete: false };
    const homes: [string, string][] = [["default", base]],
      profiles = path.join(base, "profiles");
    let directory;
    try {
      directory = opendirSync(profiles);
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const home = path.join(profiles, entry.name);
        if (entry.isDirectory() && !isReparseOrSymlink(home, entry)) homes.push([entry.name, home]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") budget.incomplete = true;
    } finally {
      directory?.closeSync();
    }
    for (const [profile, home] of homes) {
      if (!isDirectory(home)) continue;
      const database = this.database(home, profile);
      budget.incomplete ||= database.incomplete;
      for (const source of this.jsonl(home, profile, budget)) {
        const previous = database.sessions.find(
          (value) => value.session.native_ref === source.session.native_ref,
        );
        if (!previous) database.sessions.push(source);
        else {
          previous.cwd ??= source.cwd;
          previous.session.title ??= source.session.title;
          if (
            previous.source.type === "sqlite" &&
            previous.session.availability === "metadata-only"
          ) {
            previous.source = source.source;
            previous.transcript = source.transcript;
            previous.session.availability = source.session.availability;
          }
        }
      }
      sessions.push(
        ...database.sessions.filter(
          (value) =>
            workspace === null ||
            (value.cwd !== null &&
              belongsToWorkspace(value.cwd, workspace, userHome(this.environment))),
        ),
      );
    }
    sessions.sort(historyOrder);
    const seen = new Set<string>();
    return {
      sessions: sessions.filter(({ session }) => {
        if (seen.has(session.native_ref)) return false;
        seen.add(session.native_ref);
        return true;
      }),
      incomplete: budget.incomplete,
    };
  }
  database(home: string, profile: string) {
    const file = path.join(home, "state.db"),
      sessions: HermesSource[] = [];
    if (!isFile(file)) return { sessions, incomplete: false };
    let db: DatabaseSync | undefined,
      incomplete = false;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const names = columns(db, "sessions");
      if (!names.has("id")) return { sessions, incomplete: true };
      const expr = (candidates: string[]) => {
        const found = candidates
          .filter((name) => names.has(name))
          .map((name) => `CAST("${name}" AS TEXT)`);
        const expression = found.length > 1 ? `COALESCE(${found.join(",")})` : (found[0] ?? "NULL");
        return `substr(CAST((${expression}) AS TEXT),1,1024)`;
      };
      const rows = new Sql(db).rows(
          `SELECT rowid, ${[
            ["id"],
            ["title", "name", "summary"],
            ["cwd", "directory", "project_dir"],
            ["started_at", "created_at"],
            ["ended_at", "updated_at", "last_active_at"],
          ]
            .map((group, index) => `${expr(group)} AS k${index}`)
            .join(",")} FROM sessions ORDER BY rowid DESC LIMIT 501`,
        ),
        readable = hermesMessagesSupported(file);
      incomplete = rows.length > 500;
      for (const row of rows.slice(0, 500)) {
        const id = text(row.k0);
        if (!id?.trim()) {
          incomplete = true;
          continue;
        }
        const created = textTimestamp(row.k3),
          cwd = text(row.k2);
        sessions.push({
          cwd: cwd?.trim() ? cwd : null,
          transcript: file,
          source: { type: "sqlite", path: file, sessionId: id },
          session: this.summary(
            stableNativeRef("hermes", [home, profile, id]),
            sessionTitle(row.k1),
            created,
            textTimestamp(row.k4) ?? created,
            readable,
          ),
        });
      }
    } catch {
      incomplete = true;
    } finally {
      db?.close();
    }
    return { sessions, incomplete };
  }
  jsonl(
    home: string,
    profile: string,
    budget: { visited: number; incomplete: boolean },
  ): HermesSource[] {
    const root = path.join(home, "sessions"),
      sessions: HermesSource[] = [];
    if (!isDirectory(root)) return sessions;
    let directory;
    try {
      directory = opendirSync(root);
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        if (budget.visited >= MAX_DISCOVERY_FILES) {
          budget.incomplete = true;
          break;
        }
        budget.visited++;
        const file = path.join(root, entry.name);
        if (
          !entry.isFile() ||
          ![".jsonl", ".json"].includes(path.extname(file)) ||
          isReparseOrSymlink(file, entry)
        )
          continue;
        try {
          const { head, tail } = readHeadTail(file);
          let id: string | null = null,
            cwd: string | null = null,
            title: string | null = null,
            created: string | null = null,
            updated: string | null = null,
            firstUser: string | null = null;
          const parse = (line: string) => {
            try {
              const value = JSON.parse(line);
              finiteJson(value);
              return value;
            } catch {
              if (line.trim()) budget.incomplete = true;
              return undefined;
            }
          };
          for (const line of head) {
            const row = parse(line);
            if (row === undefined) continue;
            created ??= jsonTimestamp(first(row, "timestamp", "ts"));
            if (["session", "init"].includes(row?.type)) {
              id ??= text(first(row, "id", "sessionId"));
              title ??= text(row.title);
              cwd ??= text(first(row, "cwd", "directory"));
            }
            const message =
              row?.type === "message" && Object.hasOwn(row, "message") ? row.message : row;
            if (firstUser === null && message?.role === "user")
              firstUser = sessionTitle(messageText(message.content));
          }
          for (const line of tail.reverse()) {
            const row = parse(line);
            updated ??= jsonTimestamp(first(row, "timestamp", "ts"));
          }
          id ??= path.basename(file, path.extname(file));
          sessions.push({
            cwd,
            transcript: file,
            source: { type: "jsonl", path: file },
            session: this.summary(
              stableNativeRef("hermes", [home, profile, id]),
              sessionTitle(title) ?? firstUser ?? (cwd ? path.basename(cwd) || null : null),
              created,
              updated ?? created,
              readableHistory(file),
            ),
          });
        } catch {
          budget.incomplete = true;
        }
      }
    } catch {
      budget.incomplete = true;
    } finally {
      directory?.closeSync();
    }
    return sessions;
  }
  summary(
    nativeRef: string,
    title: string | null,
    created: string | null,
    updated: string | null,
    readable: boolean,
  ): NativeHistorySource["session"] {
    return {
      native_ref: nativeRef,
      agent: "hermes",
      title,
      created_at: created,
      updated_at: updated,
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: readable ? "readable" : "metadata-only",
      origin: "unknown",
      spawned_by_session_id: null,
      forked_from_session_id: null,
    };
  }
  resolve(nativeRef: string): HermesSource {
    const source = this.list(null).sessions.find((value) => value.session.native_ref === nativeRef);
    if (!source) throw new Error("Hermes session is no longer available");
    return source;
  }
}
