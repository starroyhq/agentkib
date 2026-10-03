import path from "node:path";
import { userHome } from "./mcp-config-read";
import { readText } from "./files";
import { finiteJson } from "./config-merge";
import { sessionTitle } from "./codex-sessions";
import { compareUtf8 } from "./workspaces";
import {
  belongsToWorkspace,
  historyOrder,
  jsonTimestamp,
  MAX_METADATA_BYTES,
  readableHistory,
  scanHistory,
  stableNativeRef,
  type NativeHistorySource,
} from "./session-history";
const first = (row: Record<string, any>, keys: string[]) => {
  for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
};
export class GrokSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  home(): string {
    return this.environment.GROK_HOME ?? path.join(userHome(this.environment), ".grok");
  }
  list(workspace: string | null) {
    const home = this.home(),
      sessions: NativeHistorySource[] = [],
      budget = { visited: 0, incomplete: false };
    for (const [name, archived] of [
      ["sessions", false],
      ["archived_sessions", true],
    ] as const)
      scanHistory(path.join(home, name), 8, budget, (file) => {
        if (path.basename(file) !== "summary.json") return;
        try {
          const value = JSON.parse(readText(file, MAX_METADATA_BYTES)),
            id = value?.info?.id;
          finiteJson(value);
          if (typeof id !== "string" || !id.trim()) throw new Error("Missing Grok session ID");
          const transcript = path.join(path.dirname(file), "chat_history.jsonl"),
            created = jsonTimestamp(first(value, ["created_at", "createdAt"])),
            cwd = value?.info?.cwd;
          sessions.push({
            cwd: typeof cwd === "string" && cwd.trim() ? cwd : null,
            transcript,
            session: {
              native_ref: stableNativeRef("grok-build", [home, id]),
              agent: "grok-build",
              title: sessionTitle(
                first(value, [
                  "generated_title",
                  "generatedTitle",
                  "session_summary",
                  "sessionSummary",
                ]),
              ),
              created_at: created,
              updated_at:
                jsonTimestamp(
                  first(value, ["last_active_at", "lastActiveAt", "updated_at", "updatedAt"]),
                ) ?? created,
              message_count: null,
              git_branch: null,
              archived,
              sidechain: false,
              availability: readableHistory(transcript) ? "readable" : "metadata-only",
              origin: "unknown",
              spawned_by_session_id: null,
              forked_from_session_id: null,
            },
          });
        } catch {
          budget.incomplete = true;
        }
      });
    // Resolve duplicate identities before ownership so archive copies cannot resurrect another workspace.
    sessions.sort(
      (a, b) =>
        Number(a.session.archived) - Number(b.session.archived) ||
        compareUtf8(a.transcript, b.transcript),
    );
    const seen = new Set<string>();
    const selected = sessions.filter(({ session, cwd }) => {
      if (seen.has(session.native_ref)) return false;
      seen.add(session.native_ref);
      return (
        workspace === null ||
        (cwd !== null && belongsToWorkspace(cwd, workspace, userHome(this.environment)))
      );
    });
    selected.sort(historyOrder);
    return { sessions: selected, incomplete: budget.incomplete };
  }
  resolve(nativeRef: string): NativeHistorySource {
    const source = this.list(null).sessions.find((value) => value.session.native_ref === nativeRef);
    if (!source) throw new Error("Grok Build session is no longer available");
    return source;
  }
}
