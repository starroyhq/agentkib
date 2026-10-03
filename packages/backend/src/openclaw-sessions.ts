import { existsSync, opendirSync } from "node:fs";
import { userHome } from "./mcp-config-read";
import path from "node:path";
import { isDirectory } from "./paths";
import { readText } from "./files";
import { finiteJson } from "./config-merge";
import { compareUtf8 } from "./workspaces";
import { isReparseOrSymlink } from "./native-files";
import {
  listOpenClawSqlite,
  safeOpenClawSqliteAuthority,
  type OpenClawSqliteSession,
} from "./openclaw-sqlite-sessions";
import { sessionTitle } from "./codex-sessions";
import {
  belongsToWorkspace,
  historyOrder,
  jsonTimestamp,
  MAX_DISCOVERY_FILES,
  MAX_METADATA_BYTES,
  readHeadTail,
  readableHistory,
  stableNativeRef,
  type NativeHistorySource,
} from "./session-history";
export interface OpenClawSource extends NativeHistorySource {
  sqlite?: OpenClawSqliteSession;
}
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
export class OpenClawSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  home(): string {
    return (
      this.environment.OPENCLAW_STATE_DIR ?? path.join(userHome(this.environment), ".openclaw")
    );
  }
  list(workspace: string | null) {
    const home = this.home(),
      agents = path.join(home, "agents"),
      sources: OpenClawSource[] = [],
      budget = { visited: 0, incomplete: false };
    function* entries(root: string) {
      if (!isDirectory(root)) return;
      let directory;
      try {
        directory = opendirSync(root);
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (budget.visited >= MAX_DISCOVERY_FILES) {
            budget.incomplete = true;
            break;
          }
          budget.visited++;
          yield entry;
        }
      } catch {
        budget.incomplete = true;
      } finally {
        directory?.closeSync();
      }
    }
    for (const agent of entries(agents)) {
      const agentRoot = path.join(agents, agent.name);
      if (!agent.isDirectory() || isReparseOrSymlink(agentRoot, agent)) continue;
      const database = path.join(agentRoot, "agent", "openclaw-agent.sqlite");
      if (safeOpenClawSqliteAuthority(database)) {
        try {
          const listing = listOpenClawSqlite(database, home, agent.name, workspace);
          budget.incomplete ||= listing.incomplete;
          for (const sqlite of listing.sessions)
            sources.push({
              cwd: sqlite.cwd,
              transcript: sqlite.file,
              session: sqlite.session,
              sqlite,
            });
        } catch {
          budget.incomplete = true;
        }
        // SQLite is authoritative even when it cannot be read; do not surface stale JSONL checkpoints.
        continue;
      }
      const sessionRoot = path.join(agentRoot, "sessions"),
        names = new Map<string, string>(),
        nameFile = path.join(sessionRoot, "sessions.json");
      if (existsSync(nameFile)) {
        try {
          const value = JSON.parse(readText(nameFile, MAX_METADATA_BYTES));
          finiteJson(value);
          if (value && typeof value === "object" && !Array.isArray(value))
            for (const item of Object.keys(value)
              .sort(compareUtf8)
              .map((key) => value[key]) as any[])
              if (
                typeof item?.sessionId === "string" &&
                typeof item?.displayName === "string" &&
                item.displayName.trim()
              )
                names.set(item.sessionId, item.displayName);
        } catch {
          budget.incomplete = true;
        }
      }
      for (const entry of entries(sessionRoot)) {
        const file = path.join(sessionRoot, entry.name);
        if (path.extname(file) !== ".jsonl" || !entry.isFile() || isReparseOrSymlink(file, entry))
          continue;
        try {
          const { head, tail } = readHeadTail(file);
          let id: string | null = null,
            cwd: string | null = null,
            created: string | null = null,
            firstUser: string | null = null,
            updated: string | null = null;
          for (const line of head) {
            let row;
            try {
              row = JSON.parse(line);
            } catch {
              continue;
            }
            created ??= jsonTimestamp(row?.timestamp);
            if (row?.type === "session") {
              id ??= text(Object.hasOwn(row, "id") ? row.id : row.sessionId);
              cwd ??= text(row.cwd);
            }
            if (row?.type === "message" && row.message?.role === "user" && firstUser === null)
              firstUser = sessionTitle(messageText(row.message.content));
          }
          for (const line of tail.reverse()) {
            try {
              updated = jsonTimestamp(JSON.parse(line)?.timestamp);
            } catch {}
            if (updated !== null) break;
          }
          id ??= path.basename(file, ".jsonl");
          if (cwd === null || !path.isAbsolute(cwd)) throw new Error("Missing session workspace");
          if (workspace !== null && !belongsToWorkspace(cwd, workspace, userHome(this.environment)))
            continue;
          sources.push({
            cwd,
            transcript: file,
            session: {
              native_ref: stableNativeRef("openclaw", [
                home,
                agent.name,
                id,
                path.relative(home, file),
              ]),
              agent: "open-claw",
              title: sessionTitle(names.get(id)) ?? firstUser ?? (path.basename(cwd) || null),
              created_at: created,
              updated_at: updated ?? created,
              message_count: null,
              git_branch: null,
              archived: false,
              sidechain: false,
              availability: readableHistory(file) ? "readable" : "metadata-only",
              origin: "unknown",
              spawned_by_session_id: null,
              forked_from_session_id: null,
            },
          });
        } catch {
          budget.incomplete = true;
        }
      }
    }
    const seen = new Set<string>();
    const sessions = sources.filter(({ session }) => {
      if (seen.has(session.native_ref)) return false;
      seen.add(session.native_ref);
      return true;
    });
    sessions.sort(historyOrder);
    return { sessions, incomplete: budget.incomplete };
  }
  resolve(nativeRef: string): OpenClawSource {
    const source = this.list(null).sessions.find((value) => value.session.native_ref === nativeRef);
    if (!source) throw new Error("OpenClaw session is no longer available");
    return source;
  }
}
