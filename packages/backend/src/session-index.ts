import { z } from "zod";
import {
  isCatalogSourceReason,
  REMOTE_ERROR_CODES,
  sessionCollection,
} from "@agentkib/runtime-protocol";
import { SessionStore } from "./session-store";
import {
  SESSION_AGENTS,
  type NativeListing,
  type SessionReaders,
  type SessionAgent,
} from "./session-readers";
import { parameters } from "./rpc";
import {
  ANTIGRAVITY_ACP_DISABLED,
  canRetrySessionSource,
  parseSessionSourceReasons,
  retainIncompleteSessionSource,
  sessionSourceReasonPattern,
} from "./session-source-reasons";
import { BackendTaskError } from "./task-executor";
import { applyNativeCatalogListing } from "./session-catalog-index";
import {
  catalogWatchSources,
  SessionCatalogWatch,
  type CatalogSourceChange,
} from "./session-catalog-watch";

interface ScanPass {
  force: boolean;
  codexOnly: boolean;
}
interface Refresh {
  epoch: bigint;
  active: ScanPass;
  started: boolean;
  next?: ScanPass;
  remaining?: Set<SessionAgent>;
  promise: Promise<ReturnType<SessionStore["list"]>>;
}

const MAX_REPORTED_RECORD_ISSUES = 2048;
const nativeRecordIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTIAL_SOURCE_DETAIL =
  "Some conversation sources could not be read; previous records were retained";

type IndexStatus = ReturnType<SessionStore["status"]>[number];

function sourceIssues(status: IndexStatus | undefined): string[] {
  const detail = status?.error_detail ?? null;
  if (detail === PARTIAL_SOURCE_DETAIL) return [REMOTE_ERROR_CODES.sourcePartial];
  const reasons = parseSessionSourceReasons(detail);
  if (reasons.length) return reasons.filter((reason) => reason !== ANTIGRAVITY_ACP_DISABLED);
  if (status?.error_key) return [REMOTE_ERROR_CODES.sourceUnavailable];
  return status?.last_success_at ? [] : ["not-scanned"];
}

/** Invalidate scans before clearing or changing preferences; no await occurs between validation and writes. */
export class SessionIndex {
  #epoch = 0n;
  #closed = false;
  #refreshes = new Map<string, Refresh>();
  #scanTail: Promise<void> = Promise.resolve();
  #classification = new Map<string, ReturnType<typeof setTimeout>>();
  #classificationRetryAfter = new Map<string, number>();
  #reportedRecordIssues = new Set<string>();
  #changed?: ReturnType<typeof setTimeout>;
  #watch?: SessionCatalogWatch;
  #observations = new Map<SessionAgent, Set<string> | null>();
  #observing = false;
  constructor(
    readonly store: SessionStore,
    readonly readers: Pick<SessionReaders, "list"> &
      Partial<Pick<SessionReaders, "catalogListing" | "env">>,
    readonly enabled: () => boolean,
    readonly refreshed: () => void = () => {},
    /** Native IDs (lowercase) of Claude sessions AgentKib runs through `--print` itself. */
    readonly managedClaudeIds: () => ReadonlySet<string> = () => new Set(),
    /** Coalesced directory invalidation after each committed provider result. */
    readonly sourceChanged: () => void = () => {},
    readonly metadataChanged: () => void = sourceChanged,
  ) {
    this.#syncCatalogWatch();
  }
  #syncCatalogWatch() {
    if (this.#closed || !this.enabled()) {
      this.#watch?.close();
      this.#watch = undefined;
      return;
    }
    const { env, catalogListing } = this.readers;
    if (env && catalogListing)
      this.#watch ??= new SessionCatalogWatch(catalogWatchSources(env), (changes) =>
        this.#observeCatalog(changes),
      );
  }
  invalidate(): void {
    this.#epoch++;
    this.#observations.clear();
    this.#syncCatalogWatch();
    for (const timer of this.#classification.values()) clearTimeout(timer);
    this.#classification.clear();
    this.#classificationRetryAfter.clear();
    if (this.#changed) clearTimeout(this.#changed);
    this.#changed = undefined;
  }
  generation(): bigint {
    return this.#epoch;
  }
  close(): void {
    this.#closed = true;
    this.invalidate();
  }
  clear(value: unknown): null {
    const { workspaceId } = parameters(
      z.object({ workspaceId: z.string().nullable().optional() }),
      value,
    );
    this.invalidate();
    this.store.clear(workspaceId ?? null);
    this.#sourceChanged();
    return null;
  }
  /** A deleted conversation leaves the index at once; scans already reading it are discarded. */
  forget(ids: readonly string[]): void {
    this.invalidate();
    this.store.forget(ids);
    this.refreshed();
    this.metadataChanged();
  }
  read(workspaceId: string) {
    if (this.#closed) return Promise.reject(new Error(REMOTE_ERROR_CODES.sessionIndexStaleDetail));
    // SQL already hides unverified Codex classifications. Show the remaining
    // trusted cache now; schedule only classification work after this response.
    const rows = this.enabled() ? this.store.list(workspaceId) : [];
    if (
      !this.#closed &&
      this.enabled() &&
      this.store.codexClassificationPending(workspaceId) &&
      Date.now() >= (this.#classificationRetryAfter.get(workspaceId) ?? 0) &&
      !this.#classification.has(workspaceId) &&
      !this.#refreshes.has(workspaceId)
    ) {
      const timer = setTimeout(() => {
        this.#classification.delete(workspaceId);
        void this.#queue(workspaceId, false, true).catch(() => undefined);
      }, 0);
      timer.unref?.();
      this.#classification.set(workspaceId, timer);
    }
    return Promise.resolve(rows);
  }
  complete(workspaceIds: readonly string[]): boolean {
    return this.incompleteSources(workspaceIds).length === 0;
  }
  incompleteSources(
    workspaceIds: readonly string[],
  ): Array<{ workspaceId: string; agent: SessionAgent }> {
    if (!this.enabled()) return [];
    return this.catalogSources(workspaceIds).flatMap(({ workspaceId, agent, reasons }) =>
      reasons?.some(retainIncompleteSessionSource) ? [{ workspaceId, agent }] : [],
    );
  }
  /** Coverage of cached Provider reads, including sources that returned zero sessions. */
  catalogSources(workspaceIds: readonly string[]): Array<{
    workspaceId: string;
    agent: SessionAgent;
    complete: boolean;
    reasons?: string[];
  }> {
    const enabled = this.enabled();
    return [...new Set(workspaceIds)].flatMap((workspaceId) => {
      const agents = sessionCollection(workspaceId) ? ["codex" as const] : SESSION_AGENTS;
      if (!enabled)
        return agents.map((agent) => ({
          workspaceId,
          agent,
          complete: false,
          reasons: ["index-disabled"],
        }));
      const statuses = new Map(this.store.status(workspaceId).map((row) => [row.agent, row]));
      const classifying =
        this.#classification.has(workspaceId) || this.store.codexClassificationPending(workspaceId);
      const refresh = this.#refreshes.get(workspaceId);
      const refreshing = new Set<SessionAgent>();
      if (refresh?.epoch === this.#epoch) {
        for (const agent of refresh.remaining ?? this.#due(workspaceId, refresh.active))
          refreshing.add(agent);
        if (refresh.next)
          for (const agent of this.#due(workspaceId, refresh.next)) refreshing.add(agent);
      }
      const issues = new Map<SessionAgent, string[]>();
      const addIssue = (agent: SessionAgent, issue: string) => {
        const reasons = issues.get(agent);
        if (reasons) reasons.push(issue);
        else issues.set(agent, [issue]);
      };
      for (const agent of agents) {
        const reasons = sourceIssues(statuses.get(agent));
        if (reasons.length > 0) issues.set(agent, reasons);
      }
      if (classifying) addIssue("codex", "classification-pending");
      for (const agent of refreshing) addIssue(agent, "refreshing");
      return [...new Set([...issues.keys(), ...agents])].map((agent) => {
        const reasons = issues.get(agent);
        return {
          workspaceId,
          agent,
          complete: reasons === undefined,
          ...(reasons ? { reasons } : {}),
        };
      });
    });
  }
  #due(workspaceId: string, pass: ScanPass): Set<SessionAgent> {
    const agents =
      sessionCollection(workspaceId) || pass.codexOnly ? ["codex" as const] : SESSION_AGENTS;
    const statuses = this.store.status(workspaceId);
    return new Set(
      agents.filter(
        (agent) =>
          pass.force ||
          (agent === "codex" && this.store.codexClassificationPending(workspaceId)) ||
          !statuses.some((status) => status.agent === agent && status.freshness === "fresh"),
      ),
    );
  }
  refresh(value: unknown) {
    const { workspaceId, force } = parameters(
      z.object({
        workspaceId: z.string(),
        force: z.boolean().default(false),
      }),
      value,
    );
    return this.#queue(workspaceId, force, false);
  }
  #queue(workspaceId: string, force: boolean, codexOnly: boolean) {
    const epoch = this.#epoch;
    const previous = this.#refreshes.get(workspaceId);
    if (previous?.epoch === epoch) {
      if (!previous.started) {
        previous.active.force ||= force;
        previous.active.codexOnly &&= codexOnly;
      } else if ((force && !previous.active.force) || (!codexOnly && previous.active.codexOnly)) {
        // A force arriving during a non-force pass must inspect providers that
        // pass may already have skipped. Coalesce all such requests into one pass.
        previous.next ??= { force, codexOnly };
        previous.next.force ||= force;
        previous.next.codexOnly &&= codexOnly;
      }
      return previous.promise;
    }
    const refresh: Refresh = {
      epoch,
      active: { force, codexOnly },
      started: false,
      promise: undefined!,
    };
    // Startup can request several different workspaces at once. Keep one scan
    // in the runtime while callers for the same workspace share its result.
    refresh.promise = this.#scanTail.then(async () => {
      let rows: ReturnType<SessionStore["list"]> = [];
      for (;;) {
        refresh.started = true;
        rows = await this.#scan(
          workspaceId,
          refresh.active.force,
          epoch,
          refresh.active.codexOnly,
          refresh,
        );
        if (!refresh.next) break;
        refresh.active = refresh.next;
        refresh.next = undefined;
      }
      return rows;
    });
    this.#scanTail = refresh.promise.then(
      () => undefined,
      () => undefined,
    );
    this.#refreshes.set(workspaceId, refresh);
    const release = () => {
      if (this.#refreshes.get(workspaceId) === refresh) this.#refreshes.delete(workspaceId);
    };
    void refresh.promise.then(release, release);
    return refresh.promise;
  }
  #observeCatalog(changes: readonly CatalogSourceChange[]) {
    if (this.#closed || !this.enabled()) return;
    for (const { agent, paths } of changes) {
      const prior = this.#observations.get(agent);
      if (prior === null) continue;
      const combined = paths && new Set([...(prior ?? []), ...paths]);
      this.#observations.set(agent, combined && combined.size <= 256 ? combined : null);
    }
    if (this.#observing || !this.#observations.size) return;
    this.#observing = true;
    const epoch = this.#epoch;
    const observation = this.#scanTail.then(async () => {
      if (this.#closed || this.#epoch !== epoch || !this.enabled()) return;
      const pending = this.#observations;
      this.#observations = new Map();
      let rowsChanged = false;
      for (const [agent, paths] of pending) {
        if (this.#closed || this.#epoch !== epoch || !this.enabled()) return;
        let listing: Awaited<ReturnType<NonNullable<SessionReaders["catalogListing"]>>>;
        try {
          listing = await this.readers.catalogListing?.(agent, paths ? [...paths] : undefined);
        } catch (error) {
          const reason =
            error instanceof BackendTaskError && isCatalogSourceReason(error.reason)
              ? error.reason
              : REMOTE_ERROR_CODES.sourceUnavailable;
          listing = {
            sessions: [],
            incomplete: true,
            sourceFailed: true,
            issues: [{ code: reason, scope: "source" }],
          };
        }
        if (this.#closed || this.#epoch !== epoch || !this.enabled()) return;
        if (!listing) continue;
        const applied = applyNativeCatalogListing(this.store, agent, listing, (sessions) =>
          this.#managed(agent, sessions),
        );
        if (applied.changed) this.metadataChanged();
        rowsChanged ||= applied.rowsChanged;
      }
      // History search verifies each snapshot against the catalog and needs a new pass after a write.
      if (rowsChanged) this.refreshed();
    });
    const settle = () => {
      this.#observing = false;
      this.#observeCatalog([]);
    };
    this.#scanTail = observation.then(settle, settle);
  }
  #assertCurrent(epoch: bigint) {
    if (this.#closed || epoch !== this.#epoch)
      throw new Error(REMOTE_ERROR_CODES.sessionIndexStaleDetail);
    if (!this.enabled()) throw new Error("index-disabled");
  }
  #sourceChanged(full = true) {
    if (this.#changed || this.#closed) return;
    this.#changed = setTimeout(() => {
      this.#changed = undefined;
      if (!this.#closed) (full ? this.sourceChanged : this.metadataChanged)();
    }, 50);
    this.#changed.unref?.();
  }
  async #scan(
    workspaceId: string,
    force: boolean,
    epoch: bigint,
    codexOnly: boolean,
    refresh: Refresh,
  ) {
    this.#assertCurrent(epoch);
    const collection = sessionCollection(workspaceId);
    const pendingClassification = this.store.codexClassificationPending(workspaceId);
    if (codexOnly && !pendingClassification) return this.store.list(workspaceId);
    const agents = collection || codexOnly ? (["codex"] as const) : SESSION_AGENTS;
    if (!force && !pendingClassification) {
      const statuses = this.store.status(workspaceId);
      if (
        statuses.length === agents.length &&
        statuses.every((status) => status.freshness === "fresh")
      )
        return this.store.list(workspaceId);
    }
    const workspace = collection ? workspaceId : this.store.workspacePath(workspaceId);
    const statuses = new Map(
      this.store.status(workspaceId).map((status) => [status.agent, status]),
    );
    refresh.remaining = this.#due(workspaceId, { force, codexOnly });
    let normalizedOwner: ReturnType<SessionStore["owner"]> | undefined;
    for (const agent of agents) {
      this.#assertCurrent(epoch);
      if (
        !force &&
        !(agent === "codex" && pendingClassification) &&
        statuses.get(agent)?.freshness === "fresh"
      )
        continue;
      let listing: NativeListing;
      if (agent === "codex" && pendingClassification)
        // Directory invalidations read this cache again. A failed/partial
        // classification must not turn that read into an immediate scan loop.
        // Explicit refreshes bypass this automatic-read interval.
        this.#classificationRetryAfter.set(workspaceId, Date.now() + 5_000);
      try {
        listing =
          agent === "antigravity"
            ? await this.readers.list(agent, workspace, {
                indexedSessionIds: this.store
                  .list(workspaceId)
                  .filter((session) => session.agent === agent)
                  .map(({ id }) => id),
              })
            : await this.readers.list(agent, workspace);
      } catch (error) {
        this.#assertCurrent(epoch);
        const reason =
          error instanceof BackendTaskError && isCatalogSourceReason(error.reason)
            ? error.reason
            : REMOTE_ERROR_CODES.sourceUnavailable;
        this.store.failure(
          workspaceId,
          agent,
          JSON.stringify([reason]),
          canRetrySessionSource(reason),
        );
        refresh.remaining.delete(agent);
        this.#sourceChanged(false);
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      this.#assertCurrent(epoch);
      this.#reportSkippedRecords(listing.issues);
      if (!listing.sourceFailed) {
        const owner = ["open-claw", "hermes", "grok-build"].includes(agent)
          ? (normalizedOwner ??= this.store.owner(workspaceId))
          : undefined;
        this.store.sync(
          workspaceId,
          agent,
          this.#managed(agent, listing.sessions),
          !listing.incomplete,
          owner,
          listing.retainedMetadataIds,
        );
      }
      if (agent === "codex" && !this.store.codexClassificationPending(workspaceId))
        this.#classificationRetryAfter.delete(workspaceId);
      if (
        listing.incomplete &&
        (!listing.issues?.length ||
          listing.issues.some(({ code }) => code !== ANTIGRAVITY_ACP_DISABLED))
      ) {
        const reasons = [
          ...new Set(
            listing.issues
              ?.filter(
                (issue) => issue.scope !== "unattributed" && isCatalogSourceReason(issue.code),
              )
              .map((issue) => issue.code),
          ),
        ].sort();
        const failureReasons = reasons.length ? reasons : [REMOTE_ERROR_CODES.sourcePartial];
        this.store.failure(
          workspaceId,
          agent,
          JSON.stringify(failureReasons),
          failureReasons.some(canRetrySessionSource),
        );
      }
      refresh.remaining.delete(agent);
      // Let directory observers reconcile the committed changes. A scan can
      // finish with the same rows and coverage, including a repeated failure.
      this.#sourceChanged(false);
      // Most native metadata readers are synchronous. Yield between sources so
      // cached directory reads and committed-source invalidations can be served.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.#assertCurrent(epoch);
    this.refreshed();
    return this.store.list(workspaceId);
  }
  #reportSkippedRecords(issues: NativeListing["issues"]): void {
    if (!issues?.length || this.#reportedRecordIssues.size >= MAX_REPORTED_RECORD_ISSUES) return;
    const summary = new Map<string, { category: string; count: number; ids: string[] }>();
    for (const issue of issues) {
      if (issue.scope === "source" || !sessionSourceReasonPattern.test(issue.code)) continue;
      const id = issue.id && nativeRecordIdPattern.test(issue.id) ? issue.id.toLowerCase() : "";
      const key = JSON.stringify([issue.code, issue.surface, id]);
      if (this.#reportedRecordIssues.has(key)) continue;
      this.#reportedRecordIssues.add(key);
      const category = summary.get(issue.code) ?? { category: issue.code, count: 0, ids: [] };
      category.count++;
      if (id) category.ids.push(id);
      summary.set(issue.code, category);
      if (this.#reportedRecordIssues.size >= MAX_REPORTED_RECORD_ISSUES) break;
    }
    // Every workspace may inspect the same store. Report new identities once, without paths or content.
    if (summary.size)
      console.warn("Skipped conversation records:", JSON.stringify([...summary.values()]));
  }
  /** AgentKib's own Claude runs start in print mode, yet they are the user's conversations. */
  #managed(agent: SessionAgent, sessions: NativeListing["sessions"]): NativeListing["sessions"] {
    if (agent !== "claude-code" || !sessions.some((session) => session.origin === "execution"))
      return sessions;
    let managed: ReadonlySet<string>;
    try {
      managed = this.managedClaudeIds();
    } catch {
      return sessions;
    }
    return sessions.map((session) =>
      session.origin === "execution" && managed.has(session.native_ref.toLowerCase())
        ? { ...session, origin: "interactive" as const }
        : session,
    );
  }
}
