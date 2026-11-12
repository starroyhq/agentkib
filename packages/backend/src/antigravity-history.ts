import { AntigravitySessions } from "./antigravity-sessions";
import { AntigravityLocalStore, type AntigravityLocalRecord } from "./antigravity-local-store";
import { AntigravityLocalRuntime } from "./antigravity-local-runtime";
import type { NativeSession } from "./session-store";
import { pathIdentity } from "./paths";

const PREFIX = "antigravity-local-v1-";
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
/** Local App/IDE records have separate read-only identities from ACP sessions. */
export class AntigravityHistory {
  #acp: AntigravitySessions;
  #local: AntigravityLocalStore;
  #runtime: AntigravityLocalRuntime;
  constructor(env: NodeJS.ProcessEnv) {
    this.#acp = new AntigravitySessions(env);
    this.#local = new AntigravityLocalStore(env);
    this.#runtime = new AntigravityLocalRuntime(env);
  }
  close() {
    this.#acp.close();
  }
  controlExecutable() {
    return this.#acp.controlExecutable();
  }
  readHandoff(ref: string) {
    if (ref.startsWith(PREFIX)) throw new Error("Antigravity local history is read-only");
    return this.#acp.readHandoff(ref);
  }
  readDocument(ref: string, source: Parameters<AntigravitySessions["readDocument"]>[1]) {
    if (ref.startsWith(PREFIX))
      throw new Error("Antigravity local history cannot be exported as complete history");
    return this.#acp.readDocument(ref, source);
  }
  async #records(workspace: string) {
    const listing = this.#local.list(workspace);
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
      }
    }
    return listing;
  }
  async list(workspace: string): Promise<{ sessions: NativeSession[]; incomplete: boolean }> {
    const listing = await this.#records(workspace);
    const unique = new Map<string, AntigravityLocalRecord>();
    for (const record of listing.records) {
      const key = `${record.id}:${pathIdentity(record.workspace)}`;
      const previous = unique.get(key);
      // Migration may copy a trajectory into both directories. Prefer newer metadata, then App.
      const at = record.updated_at ? Date.parse(record.updated_at) : 0;
      const previousAt = previous?.updated_at ? Date.parse(previous.updated_at) : 0;
      if (!previous || at > previousAt || (at === previousAt && record.surface === "app"))
        unique.set(key, record);
    }
    const sessions: NativeSession[] = [...unique.values()].map((record) => ({
      native_ref: antigravityLocalRef(record.surface, record.id),
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
    try {
      const acp = await this.#acp.list(workspace);
      return {
        sessions: [...sessions, ...acp.sessions],
        incomplete: listing.incomplete || acp.incomplete,
      };
    } catch {
      if (!sessions.length) throw new Error("Antigravity configured source could not be read");
      return { sessions, incomplete: true };
    }
  }
  async readEvents(ref: string, cursor: string | null, limit: number, workspace?: string) {
    if (!ref.startsWith(PREFIX)) return this.#acp.readEvents(ref, cursor, limit);
    if (!workspace) throw new Error("Antigravity local workspace is required");
    const { surface, id } = parseRef(ref);
    const record = (await this.#records(workspace)).records.find(
      (record) => record.surface === surface && record.id === id,
    );
    if (!record) throw new Error("Antigravity local session workspace changed");
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
