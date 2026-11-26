import { AntigravitySessions } from "./antigravity-sessions";
import type { AntigravityLocalRecord } from "./antigravity-local-store";
import {
  PREFIX,
  antigravityLocalRef,
  parseRef,
  preferLocalRecord,
} from "./antigravity-local-history";
import { AntigravityHistoryWorker } from "./antigravity-history-worker";
import type { NativeSession } from "../../session-store";
import type { NativeListing } from "../../sessions/history-provider";
import { ANTIGRAVITY_ACP_DISABLED, antigravityAcpEnabled } from "./acp-enabled";

export { antigravityLocalRef };

export class AntigravityHistory {
  #acp: AntigravitySessions;
  #acpEnabled: boolean;
  #history: AntigravityHistoryWorker;
  constructor(env: NodeJS.ProcessEnv, options: { workerFilename?: string } = {}) {
    this.#acp = new AntigravitySessions(env);
    this.#acpEnabled = antigravityAcpEnabled(env);
    this.#history = new AntigravityHistoryWorker(env, options.workerFilename);
  }
  close() {
    this.#acp.close();
    return this.#history.close();
  }
  controlExecutable() {
    if (!this.#acpEnabled) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    return this.#acp.controlExecutable();
  }
  readHandoff(ref: string) {
    if (!this.#acpEnabled) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    if (ref.startsWith(PREFIX)) throw new Error("Antigravity local history is read-only");
    return this.#acp.readHandoff(ref);
  }
  async readDocument(
    ref: string,
    source: Parameters<AntigravitySessions["readDocument"]>[1],
    workspace?: string,
  ) {
    if (this.#acpEnabled) {
      if (ref.startsWith(PREFIX))
        throw new Error("Antigravity local history cannot be exported as complete history");
      return this.#acp.readDocument(ref, source);
    }
    const document = await this.#history.read("readDocument", [ref, source, workspace]);
    // App/IDE history exposes visible text. A source loss requires the ordinary import review.
    if (!document.losses.some(({ code }) => code === "source-content-truncated"))
      document.losses.push({ code: "source-content-truncated", count: 1 });
    return document;
  }
  async list(workspace: string, matches?: (nativeRef: string) => boolean): Promise<NativeListing> {
    const listing = await this.#history.read("records", [workspace]);
    const unique = new Map<string, AntigravityLocalRecord>();
    for (const record of listing.records) {
      const previous = unique.get(record.id);
      if (preferLocalRecord(record, previous)) unique.set(record.id, record);
    }
    const sessions: NativeSession[] = [...unique.values()].map((record) => ({
      native_ref: this.#localReference(record, matches),
      agent: "antigravity",
      title: record.title,
      origin: "interactive",
      spawned_by_session_id: null,
      forked_from_session_id: null,
      created_at: record.created_at,
      updated_at: record.updated_at,
      message_count: record.message_count,
      git_branch: null,
      archived: false,
      sidechain: false,
      cwd: record.workspace,
      availability: record.availability,
    }));
    if (!this.#acpEnabled)
      return {
        sessions,
        incomplete: listing.incomplete,
        ...(listing.issues.length ? { issues: listing.issues } : {}),
      };
    try {
      const acp = await this.#acp.list(workspace);
      const issues = [...listing.issues, ...(acp.issues ?? [])];
      // The CLI's `agy acp` shares the Antigravity App's sessions: one it lists is the same
      // conversation, controlled through ACP, so its read-only App copy is not listed twice.
      const served = new Set(acp.sessions.map((session) => session.native_ref.toLowerCase()));
      return {
        sessions: [
          ...sessions.filter((session) => !served.has(parseRef(session.native_ref).id)),
          ...acp.sessions,
        ],
        incomplete: listing.incomplete || acp.incomplete,
        ...(issues.length ? { issues } : {}),
      };
    } catch {
      return {
        sessions,
        incomplete: true,
        issues: [...listing.issues, { code: "antigravity-acp-list", scope: "source" }],
      };
    }
  }
  #localReference(
    record: AntigravityLocalRecord,
    matches?: (nativeRef: string) => boolean,
  ): string {
    const current = antigravityLocalRef(record.surface, record.id);
    if (this.#acpEnabled || !matches) return current;
    // Legacy ACP IDs and already indexed App/IDE IDs must resolve to the same local history.
    const previousSurface = record.surface === "app" ? "ide" : "app";
    return (
      [record.id, current, antigravityLocalRef(previousSurface, record.id)].find(matches) ?? current
    );
  }
  async readEvents(ref: string, cursor: string | null, limit: number, workspace?: string) {
    if (!ref.startsWith(PREFIX) && this.#acpEnabled)
      return this.#acp.readEvents(ref, cursor, limit);
    return this.#history.read("readEvents", [ref, cursor, limit, workspace, this.#acpEnabled]);
  }
}
