import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  HISTORY_SEARCH_METHODS,
  SESSION_COLLECTIONS,
  sessionCollection,
  type HistorySearchStatus,
} from "@agentkib/runtime-protocol";
import type { BackendStore } from "./store";
import type { CursorBridge } from "./cursor-bridge";
import type { DshBridge } from "./dsh-bridge";
import { dshSearchRecords } from "./dsh-document";
import { resolveWorkspaceIdentity } from "./workspace-identity";
import { readPreferences, writePreference } from "./preferences";
import { HistorySearchWorker } from "./history-search-worker";
import {
  CONTENT_SEARCH_BUDGET,
  contentHash,
  emptySearchStatus,
  historyLocationSchema,
  historyQuerySchema,
  historyReferenceSchema,
  type SearchSession,
} from "./history-search-store";
import {
  HistorySourceInvalidatedError,
  type HistorySourceInput,
} from "./history-search-source-types";
import { sanitizeSessionText } from "./session-handoff";

type Entry = { session: SearchSession; source: HistorySourceInput };
/** The running DSH, which content search reads DSH sessions from. */
export type DshSearchSource = Pick<
  DshBridge,
  "nativeId" | "documentStatus" | "conversation" | "running"
>;
const reads = new Set<string>([
  HISTORY_SEARCH_METHODS.query,
  HISTORY_SEARCH_METHODS.locate,
  HISTORY_SEARCH_METHODS.references,
  HISTORY_SEARCH_METHODS.status,
]);
const scopeSchema = z.array(z.string().min(1).max(256)).max(20_000);

/** Owns only derived data. Native histories and the business database are never written here. */
export class HistorySearch {
  readonly filename: string;
  #writer?: HistorySearchWorker;
  #reader?: HistorySearchWorker;
  #initializing?: Promise<void>;
  #generation = 0;
  #stopping = false;
  #updating?: Promise<void>;
  #dirty = false;
  #clearing = false;
  #maintenance: Promise<void> = Promise.resolve();
  #requests = new Map<string, AbortController>();
  #scanAbort?: AbortController;
  #force = new Set<string>();
  #withdrawn = new Set<string>();
  #withdrawals = new Set<Promise<void>>();
  /** What DSH listed for each DSH session when it was last indexed in this run. */
  #dshIndexed = new Map<string, string>();
  constructor(
    readonly store: BackendStore,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly bridge: Pick<CursorBridge, "profiles">,
    readonly options: {
      workerFilename?: string;
      limitBytes?: number;
      timeoutMs?: number;
      dsh?: () => DshSearchSource | undefined;
    } = {},
  ) {
    this.filename = path.join(dataDir, "session-search.sqlite");
  }
  enabled() {
    const preferences = readPreferences(this.dataDir);
    return (
      preferences.session_index_enabled !== false &&
      preferences.session_content_search_enabled === true
    );
  }
  #entries(): Map<string, Entry> {
    const entries = new Map<string, Entry>();
    const workspaces = this.store.sql
      .rows("SELECT id FROM workspaces")
      .map((row) => String(row.id));
    for (const id of [...workspaces, ...Object.values(SESSION_COLLECTIONS)]) {
      let workspacePath: string;
      try {
        workspacePath = sessionCollection(id)
          ? id
          : resolveWorkspaceIdentity(this.store, id).project;
      } catch {
        continue;
      }
      const profiles = sessionCollection(id) ? [] : this.bridge.profiles(workspacePath);
      for (const summary of this.store.sessions.list(id)) {
        if (["auxiliary", "execution"].includes(summary.origin) || summary.sidechain) continue;
        // A revoked Cursor profile must become invisible before asynchronous deletion finishes.
        const source: HistorySourceInput = {
          sessionId: summary.id,
          summary,
          workspacePath,
          environment: this.environment,
          profiles: summary.agent === "cursor" ? profiles : [],
          identitySalt: this.store.sessions.identitySalt(),
        };
        const ownerKey = contentHash(
          JSON.stringify([id, workspacePath, summary.agent, source.profiles]),
        );
        entries.set(summary.id, {
          source,
          session: {
            sessionId: summary.id,
            workspaceId: id,
            agent: summary.agent,
            title: summary.title === null ? null : sanitizeSessionText(summary.title, { value: 0 }),
            updatedAt: summary.updated_at ?? summary.created_at,
            archived: summary.archived,
            ownerKey,
          },
        });
      }
    }
    return entries;
  }
  #current(entry: Entry, epoch: number) {
    if (this.#stopping || !this.enabled() || epoch !== this.#generation) return false;
    try {
      const current = this.store.sessions.get(entry.session.sessionId);
      if (JSON.stringify(current) !== JSON.stringify(entry.source.summary)) return false;
      const id = entry.session.workspaceId;
      const project = sessionCollection(id) ? id : resolveWorkspaceIdentity(this.store, id).project;
      const profiles =
        entry.session.agent === "cursor" && !sessionCollection(id)
          ? this.bridge.profiles(project)
          : [];
      return (
        contentHash(JSON.stringify([id, project, entry.session.agent, profiles])) ===
        entry.session.ownerKey
      );
    } catch {
      return false;
    }
  }
  async #workers() {
    if (this.#stopping || !this.enabled()) throw new Error("history-search-disabled");
    if (this.#initializing) return this.#initializing;
    if (this.#reader && this.#writer) return;
    const epoch = this.#generation;
    const writer = (this.#writer = new HistorySearchWorker(
      this.filename,
      true,
      this.options.limitBytes ?? CONTENT_SEARCH_BUDGET,
      this.options,
    ));
    let reader: HistorySearchWorker | undefined;
    const initializing = (async () => {
      await writer.request("init", {});
      if (epoch !== this.#generation || this.#stopping || !this.enabled())
        throw new Error("history-search-disabled");
      reader = this.#reader = new HistorySearchWorker(
        this.filename,
        false,
        this.options.limitBytes ?? CONTENT_SEARCH_BUDGET,
        this.options,
      );
      await reader.request("init", {});
    })();
    this.#initializing = initializing;
    try {
      await initializing;
    } catch (error) {
      await Promise.allSettled([writer.close(), reader?.close()]);
      if (this.#writer === writer) this.#writer = undefined;
      if (this.#reader === reader) this.#reader = undefined;
      throw error;
    } finally {
      if (this.#initializing === initializing) this.#initializing = undefined;
    }
  }
  /** Coalesced at directory refresh / completed turn boundaries, never for token deltas. */
  refresh(sessionId?: string): void {
    if (this.#stopping || !this.enabled()) return;
    if (sessionId) this.#force.add(sessionId);
    this.#dirty = true;
    if (this.#updating || this.#clearing) return;
    const update = (async () => {
      await this.#maintenance;
      while (this.#dirty && !this.#clearing && !this.#stopping && this.enabled()) {
        this.#dirty = false;
        const epoch = this.#generation;
        const controller = (this.#scanAbort = new AbortController());
        await this.#workers();
        const writer = this.#writer!;
        const entries = this.#entries();
        const force = new Set(this.#force);
        this.#force.clear();
        // Managed IDs may be aliases of a native source. In that case calibrate all entries.
        const unknownAlias = [...force].some((id) => !entries.has(id));
        await writer.request("prune", {
          owners: [...entries.values()].map((entry) => entry.session),
        });
        for (const entry of entries.values()) {
          if (epoch !== this.#generation || this.#stopping || this.#clearing) break;
          if (!this.#current(entry, epoch)) continue;
          const forced = unknownAlias || force.has(entry.session.sessionId);
          const dsh =
            entry.session.agent === "deepseek-harness"
              ? await this.#dshRecords(entry, forced)
              : null;
          if (dsh === "unchanged" || !this.#current(entry, epoch)) continue;
          try {
            await writer.request(
              "index",
              {
                ...entry,
                source: dsh ? { ...entry.source, dsh: dsh.records } : entry.source,
                force: forced,
              },
              {
                signal: controller.signal,
                verify: () => this.#current(entry, epoch),
              },
            );
            if (this.#current(entry, epoch)) {
              this.#withdrawn.delete(entry.session.sessionId);
              if (dsh) this.#dshIndexed.set(entry.session.sessionId, dsh.key);
            }
          } catch {
            // Worker records partial/unavailable state; one damaged provider must not suppress others.
            if (this.#stopping || epoch !== this.#generation) break;
            if (writer.failed) break;
          }
        }
      }
    })();
    this.#updating = update;
    void update
      .catch(() => undefined)
      .finally(() => {
        if (this.#updating === update) this.#updating = undefined;
        if (this.#dirty && !this.#stopping && this.enabled()) this.refresh();
      });
  }
  /**
   * A DSH session's records, read from the running DSH. A session DSH lists as it was when last
   * indexed in this run is not read again, nor is one in a turn: each record of a turn reports a
   * change, and the turn's end reports one more. One no DSH can read now is indexed without
   * records, which keeps what was indexed before and reports it unavailable.
   */
  async #dshRecords(
    entry: Entry,
    force: boolean,
  ): Promise<
    "unchanged" | { key: string; records: NonNullable<HistorySourceInput["dsh"]> } | null
  > {
    const { summary } = entry.source;
    const key = JSON.stringify([summary.updated_at, summary.title, summary.archived]);
    if (!force && this.#dshIndexed.get(entry.session.sessionId) === key) return "unchanged";
    const dsh = this.options.dsh?.();
    const nativeId = dsh?.nativeId(entry.session.sessionId);
    if (!dsh || !nativeId || dsh.documentStatus(nativeId).status !== "supported") return null;
    if (dsh.running(nativeId)) return "unchanged";
    try {
      const { revision, records } = await dsh.conversation(nativeId);
      return { key, records: { revision: String(revision), records: dshSearchRecords(records) } };
    } catch {
      return null;
    }
  }
  /** Immediately fences results and in-flight publications; physical deletion is serialized. */
  invalidate(): void {
    this.#generation++;
    this.#scanAbort?.abort();
    for (const request of this.#requests.values()) request.abort();
    this.refresh();
  }
  async #withdraw(entry: Entry): Promise<void> {
    const sessionId = entry.session.sessionId;
    if (this.#withdrawn.has(sessionId)) return;
    // Quarantine before awaiting disk work. The epoch also fences requests without
    // a cancellation ID and results already received from the query worker.
    this.#withdrawn.add(sessionId);
    this.#generation++;
    this.#scanAbort?.abort();
    for (const request of this.#requests.values()) request.abort();
    const writer = this.#writer;
    const cleanup = (async () => {
      try {
        if (!writer) throw new Error("history-search-cache-unavailable");
        await writer.request("withdraw", { sessionId, ownerKey: entry.session.ownerKey });
      } catch {
        // A dead writer cannot persist the withdrawal. Clear the rebuildable cache
        // after closing its workers so a restart cannot expose the rejected source.
        await this.clear();
      }
    })();
    this.#withdrawals.add(cleanup);
    try {
      await cleanup;
    } finally {
      this.#withdrawals.delete(cleanup);
    }
  }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === HISTORY_SEARCH_METHODS.cancel) {
      const id = z.string().uuid().parse(params.requestId);
      this.#requests.get(id)?.abort();
      return null;
    }
    if (method === HISTORY_SEARCH_METHODS.configure) {
      const enabled = z.boolean().parse(params.enabled);
      if (enabled && readPreferences(this.dataDir).session_index_enabled === false)
        throw new Error("index-disabled");
      writePreference(this.dataDir, "session_content_search_enabled", enabled);
      if (!enabled) await this.clear();
      else this.refresh();
      return this.request(HISTORY_SEARCH_METHODS.status, {});
    }
    if (method === HISTORY_SEARCH_METHODS.clear) {
      await this.clear();
      return emptySearchStatus(this.enabled());
    }
    if (method === HISTORY_SEARCH_METHODS.refresh) {
      await this.clear();
      this.refresh();
      return this.request(HISTORY_SEARCH_METHODS.status, {});
    }
    if (!reads.has(method)) throw new Error("Unknown history search operation");
    const explicit =
      params.allowedSessionIds === undefined
        ? undefined
        : scopeSchema.parse(params.allowedSessionIds);
    if (!this.enabled()) {
      const status = emptySearchStatus();
      if (method === HISTORY_SEARCH_METHODS.status) return status;
      if (method === HISTORY_SEARCH_METHODS.query)
        return { hits: [], nextCursor: null, status, limited: false };
      throw new Error("history-search-disabled");
    }
    const id =
      params.requestId === undefined ? undefined : z.string().uuid().parse(params.requestId);
    if (id && this.#requests.has(id)) throw new Error("Duplicate history read request");
    const controller = new AbortController();
    if (id) this.#requests.set(id, controller);
    const epoch = this.#generation;
    try {
      await this.#maintenance;
      await this.#workers();
      controller.signal.throwIfAborted();
      const entries = this.#entries();
      const query =
        method === HISTORY_SEARCH_METHODS.query
          ? historyQuerySchema.parse(typeof params.query === "string" ? params : params.query)
          : undefined;
      const allowedSessionIds = [...entries.keys()].filter((key) => {
        if (this.#withdrawn.has(key)) return false;
        if (explicit && !explicit.includes(key)) return false;
        const session = entries.get(key)!.session;
        return (
          !query ||
          ((!query.workspaceIds || query.workspaceIds.includes(session.workspaceId)) &&
            (!query.agents || query.agents.includes(session.agent)) &&
            (query.archived === undefined || query.archived === session.archived))
        );
      });
      const relevant: Entry[] = [];
      const source = (sessionId: string) => {
        const entry = entries.get(sessionId);
        if (!entry || !allowedSessionIds.includes(sessionId))
          throw new Error("history-source-unavailable");
        relevant.push(entry);
        return entry.source;
      };
      const input: Record<string, unknown> = {
        allowedSessionIds,
        owners: allowedSessionIds.map((key) => entries.get(key)!.session),
      };
      let operation: string;
      if (method === HISTORY_SEARCH_METHODS.query) {
        operation = "query";
        input.query = query;
      } else if (method === HISTORY_SEARCH_METHODS.locate) {
        operation = "locate";
        input.location = historyLocationSchema.parse(params.location ?? params);
        input.source = source((input.location as { sessionId: string }).sessionId);
      } else if (method === HISTORY_SEARCH_METHODS.references) {
        operation = "references";
        const refs = z.array(historyReferenceSchema).max(5).parse(params.references);
        input.references = refs;
        input.sources = Object.fromEntries(
          refs.map((ref) => [ref.sessionId, source(ref.sessionId)]),
        );
      } else operation = "status";
      const valid = () =>
        epoch === this.#generation &&
        !this.#stopping &&
        this.enabled() &&
        relevant.every((entry) => this.#current(entry, epoch));
      let result: unknown;
      try {
        result = await this.#reader!.request<unknown>(operation, input, {
          signal: controller.signal,
          verify: valid,
        });
      } catch (error) {
        if (error instanceof HistorySourceInvalidatedError) {
          const entry = relevant.find((entry) => entry.session.sessionId === error.sessionId);
          if (entry) await this.#withdraw(entry);
        }
        throw error;
      }
      const state =
        operation === "status"
          ? (result as HistorySearchStatus)
          : operation === "query"
            ? (result as { status: HistorySearchStatus }).status
            : undefined;
      if (state && this.#writer?.failed) {
        const limitation = "index-worker-unavailable-rebuild-required";
        state.coverage.limitations.push(limitation);
        for (const coverage of [
          state.coverage,
          ...(state.sources ?? []).map((source) => source.coverage),
        ]) {
          if (coverage.building && !coverage.limitations.includes(limitation))
            coverage.limitations.push(limitation);
          coverage.unavailable += coverage.building;
          coverage.building = 0;
        }
      }
      controller.signal.throwIfAborted();
      if (!valid()) throw new Error("history-source-stale");
      // Recheck the complete visible scope after a query, including profile revocation and removal.
      const current = this.#entries();
      if (
        allowedSessionIds.some(
          (key) => current.get(key)?.session.ownerKey !== entries.get(key)?.session.ownerKey,
        )
      )
        throw new Error("history-source-stale");
      return result;
    } finally {
      if (id && this.#requests.get(id) === controller) this.#requests.delete(id);
    }
  }
  clear(): Promise<void> {
    this.#force.clear();
    this.#generation++;
    this.#dirty = false;
    this.#clearing = true;
    this.#scanAbort?.abort();
    for (const request of this.#requests.values()) request.abort();
    const writer = this.#writer,
      reader = this.#reader;
    writer?.stop();
    reader?.stop();
    this.#writer = undefined;
    this.#reader = undefined;
    const initializing = this.#initializing;
    this.#initializing = undefined;
    const update = this.#updating;
    const operation = this.#maintenance
      .catch(() => undefined)
      .then(async () => {
        await Promise.allSettled([initializing, update, writer?.close(), reader?.close()]);
        for (const name of [this.filename, `${this.filename}-wal`, `${this.filename}-shm`]) {
          try {
            if (!lstatSync(name).isFile()) throw new Error("Unsafe content search cache");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          rmSync(name);
        }
      });
    this.#maintenance = operation;
    void operation
      .finally(() => {
        if (this.#maintenance === operation) {
          this.#clearing = false;
          if (this.#dirty) this.refresh();
        }
      })
      .catch(() => undefined);
    return operation;
  }
  stop() {
    this.#stopping = true;
    this.#generation++;
    this.#dirty = false;
    this.#scanAbort?.abort();
    for (const request of this.#requests.values()) request.abort();
    this.#writer?.stop();
    this.#reader?.stop();
  }
  async close() {
    this.stop();
    await Promise.allSettled([
      this.#maintenance,
      this.#initializing,
      this.#updating,
      ...this.#withdrawals,
      this.#writer?.close(),
      this.#reader?.close(),
    ]);
    // A reader can report a confirmed invalidation while its shutdown is draining.
    // Its withdrawal may therefore have started after the first promise snapshot.
    while (this.#withdrawals.size) await Promise.allSettled([...this.#withdrawals]);
    await this.#maintenance.catch(() => undefined);
  }
}
