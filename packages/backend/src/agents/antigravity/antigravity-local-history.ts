import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { AntigravityLocalStore, type AntigravityLocalRecord } from "./antigravity-local-store";
import { AntigravityLocalRuntime } from "./antigravity-local-runtime";
import type { SessionListingIssue } from "../../sessions/history-provider";
import { pathIdentity } from "../../paths";
import { readEventDocument, type DocumentSource } from "../../session-document-providers";
import { ANTIGRAVITY_ACP_DISABLED } from "./acp-enabled";

export const PREFIX = "antigravity-local-v1-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function antigravityLocalRef(surface: "app" | "ide", id: string): string {
  return `${PREFIX}${surface}-${id.toLowerCase()}`;
}
export function parseRef(ref: string) {
  const match =
    /^antigravity-local-v1-(app|ide)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
      ref,
    );
  if (!match) throw new Error("Invalid Antigravity local reference");
  return { surface: match[1] as "app" | "ide", id: match[2]! };
}
/** Prefer more recent local metadata, then App when migration left equivalent copies. */
export function preferLocalRecord(
  record: AntigravityLocalRecord,
  previous?: AntigravityLocalRecord,
) {
  if (!previous) return true;
  const at = record.updated_at ? Date.parse(record.updated_at) : 0;
  const previousAt = previous.updated_at ? Date.parse(previous.updated_at) : 0;
  return at > previousAt || (at === previousAt && record.surface === "app");
}

/** A read-only snapshot of Antigravity's App and IDE sources. */
export class AntigravityLocalHistory {
  #local: AntigravityLocalStore;
  #runtime: AntigravityLocalRuntime;
  constructor(env: NodeJS.ProcessEnv) {
    this.#local = new AntigravityLocalStore(env);
    this.#runtime = new AntigravityLocalRuntime(env);
  }
  async records(workspace: string, id?: string) {
    const listing = this.#local.list(workspace, id);
    const workspaceKey = pathIdentity(workspace);
    const issues: SessionListingIssue[] = [...(listing.issues ?? [])];
    for (const surface of ["app", "ide"] as const) {
      try {
        const live = this.#runtime.available(surface);
        if (!live) continue;
        const snapshots = await this.#runtime.list(surface);
        const native = id ? snapshots.filter((record) => record.id === id) : snapshots;
        const nativeScopes = new Map<string, Set<string>>();
        for (const row of native) {
          const scopes = nativeScopes.get(row.id) ?? new Set<string>();
          scopes.add(pathIdentity(row.workspace));
          nativeScopes.set(row.id, scopes);
        }
        listing.records = listing.records.filter((record) => {
          if (record.surface !== surface) return true;
          const current = nativeScopes.get(record.id);
          if (current && !current.has(pathIdentity(record.workspace))) return false;
          record.availability = "readable";
          return true;
        });
        const keys = new Set(
          listing.records.map(
            (record) => `${record.surface}:${record.id}:${pathIdentity(record.workspace)}`,
          ),
        );
        for (const record of native) {
          const scope = pathIdentity(record.workspace);
          const key = `${record.surface}:${record.id}:${scope}`;
          if (scope !== workspaceKey || keys.has(key)) continue;
          keys.add(key);
          listing.records.push(record);
        }
      } catch {
        listing.incomplete = true;
        issues.push({ code: REMOTE_ERROR_CODES.antigravityNativeList, scope: "source", surface });
      }
    }
    return { ...listing, issues };
  }
  async #resolveRecord(ref: string, workspace: string, acpEnabled: boolean) {
    const prefixed = ref.startsWith(PREFIX);
    if (!prefixed && !UUID.test(ref)) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    const identity = prefixed ? parseRef(ref) : { id: ref.toLowerCase(), surface: undefined };
    let record: AntigravityLocalRecord | undefined;
    for (const candidate of (await this.records(workspace, identity.id)).records) {
      if (
        candidate.id === identity.id &&
        (!acpEnabled || candidate.surface === identity.surface) &&
        preferLocalRecord(candidate, record)
      )
        record = candidate;
    }
    if (!record)
      throw new Error(
        prefixed ? "Antigravity local session workspace changed" : ANTIGRAVITY_ACP_DISABLED,
      );
    return record;
  }
  async #verifyOwner(record: AntigravityLocalRecord, workspace: string) {
    const candidates = await this.records(workspace, record.id);
    if (!candidates.records.some((row) => row.surface === record.surface && row.id === record.id))
      throw new Error("Antigravity local session workspace changed");
  }
  #offlineReadable(record: AntigravityLocalRecord, workspace: string) {
    return this.#local
      .list(workspace, record.id)
      .records.some(
        (value) =>
          value.surface === record.surface &&
          value.id === record.id &&
          value.availability === "readable",
      );
  }
  async readDocument(ref: string, source: DocumentSource, workspace?: string) {
    if (!workspace) throw new Error("Antigravity local workspace is required");
    const record = await this.#resolveRecord(ref, workspace, false);
    let native;
    try {
      native = await this.#runtime.documentEvents(record);
      if (native) await this.#verifyOwner(record, workspace);
    } catch {
      if (!this.#offlineReadable(record, workspace))
        throw new Error("Antigravity native history could not be read");
      native = null;
    }
    return readEventDocument(
      source,
      async (cursor, count) =>
        native ?? this.#local.events(record.surface, record.id, workspace, cursor, count),
    );
  }
  async readEvents(
    ref: string,
    cursor: string | null,
    limit: number,
    workspace: string | undefined,
    acpEnabled: boolean,
  ) {
    if (!workspace) throw new Error("Antigravity local workspace is required");
    const record = await this.#resolveRecord(ref, workspace, acpEnabled);
    const { surface, id } = record;
    if (cursor?.startsWith("antigravity-local-v1-"))
      return this.#local.events(surface, id, workspace, cursor, limit);
    try {
      const native = await this.#runtime.events(record, cursor, limit);
      if (native) {
        await this.#verifyOwner(record, workspace);
        return native;
      }
      if (cursor) throw new Error("Antigravity native history snapshot is unavailable");
    } catch {
      // A failed native read never fabricates complete history. An existing cursor cannot change source.
      if (cursor || !this.#offlineReadable(record, workspace))
        throw new Error("Antigravity native history could not be read");
    }
    return this.#local.events(surface, id, workspace, cursor, limit);
  }
}
