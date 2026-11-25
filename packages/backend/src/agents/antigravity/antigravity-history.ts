import { AntigravitySessions } from "./antigravity-sessions";
import { AntigravityLocalStore, type AntigravityLocalRecord } from "./antigravity-local-store";
import { AntigravityLocalRuntime } from "./antigravity-local-runtime";
import type { NativeSession } from "../../session-store";
import type { NativeListing, SessionListingIssue } from "../../sessions/history-provider";
import { pathIdentity } from "../../paths";
import { readEventDocument } from "../../session-document-providers";
import { ANTIGRAVITY_ACP_DISABLED, antigravityAcpEnabled } from "./acp-enabled";

const PREFIX = "antigravity-local-v1-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function antigravityLocalRef(surface: "app" | "ide", id: string): string {
  return `${PREFIX}${surface}-${id.toLowerCase()}`;
}
function parseRef(ref: string) {
  const match =
    /^antigravity-local-v1-(app|ide)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      ref,
    );
  if (!match) throw new Error("Invalid Antigravity local reference");
  return { surface: match[1] as "app" | "ide", id: match[2]! };
}
/** Prefer more recent local metadata, then App when migration left equivalent copies. */
function preferLocalRecord(record: AntigravityLocalRecord, previous?: AntigravityLocalRecord) {
  if (!previous) return true;
  const at = record.updated_at ? Date.parse(record.updated_at) : 0;
  const previousAt = previous.updated_at ? Date.parse(previous.updated_at) : 0;
  return at > previousAt || (at === previousAt && record.surface === "app");
}

export class AntigravityHistory {
  #acp: AntigravitySessions;
  #acpEnabled: boolean;
  #local: AntigravityLocalStore;
  #runtime: AntigravityLocalRuntime;
  constructor(env: NodeJS.ProcessEnv) {
    this.#acp = new AntigravitySessions(env);
    this.#acpEnabled = antigravityAcpEnabled(env);
    this.#local = new AntigravityLocalStore(env);
    this.#runtime = new AntigravityLocalRuntime(env);
  }
  close() {
    this.#acp.close();
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
    const document = await readEventDocument(source, (cursor, count) =>
      this.readEvents(ref, cursor, count, workspace),
    );
    // App/IDE history exposes visible text. A source loss requires the ordinary import review.
    if (!document.losses.some(({ code }) => code === "source-content-truncated"))
      document.losses.push({ code: "source-content-truncated", count: 1 });
    return document;
  }
  async #records(workspace: string) {
    const listing = this.#local.list(workspace);
    const issues: SessionListingIssue[] = [...(listing.issues ?? [])];
    for (const surface of ["app", "ide"] as const) {
      try {
        const live = this.#runtime.available(surface);
        if (!live) continue;
        const native = await this.#runtime.list(surface);
        listing.records = listing.records.filter((record) => {
          if (record.surface !== surface) return true;
          const current = native.filter((row) => row.id === record.id);
          if (
            current.length &&
            !current.some((row) => pathIdentity(row.workspace) === pathIdentity(record.workspace))
          )
            return false;
          record.availability = "readable";
          return true;
        });
        const keys = new Set(
          listing.records.map(
            (record) => `${record.surface}:${record.id}:${pathIdentity(record.workspace)}`,
          ),
        );
        for (const record of native)
          if (
            pathIdentity(record.workspace) === pathIdentity(workspace) &&
            !keys.has(`${record.surface}:${record.id}:${pathIdentity(record.workspace)}`)
          )
            listing.records.push(record);
      } catch {
        listing.incomplete = true;
        issues.push({ code: "antigravity-native-list", scope: "source", surface });
      }
    }
    return { ...listing, issues };
  }
  async list(workspace: string, matches?: (nativeRef: string) => boolean): Promise<NativeListing> {
    const listing = await this.#records(workspace);
    const unique = new Map<string, AntigravityLocalRecord>();
    for (const record of listing.records) {
      const key = `${record.id}:${pathIdentity(record.workspace)}`;
      const previous = unique.get(key);
      if (preferLocalRecord(record, previous)) unique.set(key, record);
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
    const prefixed = ref.startsWith(PREFIX);
    if (!prefixed && this.#acpEnabled) return this.#acp.readEvents(ref, cursor, limit);
    if (!workspace) throw new Error("Antigravity local workspace is required");
    if (!prefixed && !UUID.test(ref)) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    const identity = prefixed ? parseRef(ref) : { id: ref.toLowerCase(), surface: undefined };
    let record: AntigravityLocalRecord | undefined;
    for (const candidate of (await this.#records(workspace)).records) {
      if (
        candidate.id === identity.id &&
        (!this.#acpEnabled || candidate.surface === identity.surface) &&
        preferLocalRecord(candidate, record)
      )
        record = candidate;
    }
    if (!record)
      throw new Error(
        prefixed ? "Antigravity local session workspace changed" : ANTIGRAVITY_ACP_DISABLED,
      );
    const { surface, id } = record;
    if (cursor?.startsWith("antigravity-local-v1-"))
      return this.#local.events(surface, id, workspace, cursor, limit);
    try {
      const native = await this.#runtime.events(record, cursor, limit);
      if (native) {
        const stillOwned = (await this.#records(workspace)).records.some(
          (row) => row.surface === surface && row.id === id,
        );
        if (!stillOwned) throw new Error("Antigravity local session workspace changed");
        return native;
      }
      if (cursor) throw new Error("Antigravity native history snapshot is unavailable");
    } catch {
      // A failed native read never fabricates complete history. An existing cursor cannot change source.
      if (
        cursor ||
        !this.#local
          .list(workspace)
          .records.some(
            (value) =>
              value.surface === surface && value.id === id && value.availability === "readable",
          )
      )
        throw new Error("Antigravity native history could not be read");
    }
    return this.#local.events(surface, id, workspace, cursor, limit);
  }
}
