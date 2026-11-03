import { z } from "zod";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { SessionStore } from "./session-store";
import {
  SESSION_AGENTS,
  type NativeListing,
  type SessionReaders,
  type SessionAgent,
} from "./session-readers";
import { parameters } from "./rpc";

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

/** Invalidate scans before clearing or changing preferences; no await occurs between validation and writes. */
export class SessionIndex {
  #epoch = 0n;
  #closed = false;
  #refreshes = new Map<string, Refresh>();
  #classification = new Map<string, ReturnType<typeof setTimeout>>();
  #classificationRetryAfter = new Map<string, number>();
  #changed?: ReturnType<typeof setTimeout>;
  constructor(
    readonly store: SessionStore,
    readonly readers: Pick<SessionReaders, "list">,
    readonly enabled: () => boolean,
    readonly refreshed: () => void = () => {},
    /** Native IDs (lowercase) of Claude sessions AgentKib runs through `--print` itself. */
    readonly managedClaudeIds: () => ReadonlySet<string> = () => new Set(),
    /** Coalesced directory invalidation after each committed provider result. */
    readonly sourceChanged: () => void = () => {},
  ) {}
  invalidate(): void {
    this.#epoch++;
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
    return null;
  }
  /** A deleted conversation leaves the index at once; scans already reading it are discarded. */
  forget(ids: readonly string[]): void {
    this.invalidate();
    this.store.forget(ids);
    this.refreshed();
  }
  read(workspaceId: string) {
    if (this.#closed) return Promise.reject(new Error("session-index-stale"));
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
    const result: Array<{ workspaceId: string; agent: SessionAgent }> = [];
    for (const workspaceId of new Set(workspaceIds)) {
      const statuses = this.store.status(workspaceId);
      const agents = sessionCollection(workspaceId) ? ["codex" as const] : SESSION_AGENTS;
      const pending = new Set(
        agents.filter(
          (agent) =>
            !statuses.some(
              (status) =>
                status.agent === agent &&
                status.last_success_at !== null &&
                status.error_key === null,
            ),
        ),
      );
      if (
        this.#classification.has(workspaceId) ||
        this.store.codexClassificationPending(workspaceId)
      )
        pending.add("codex");
      const refresh = this.#refreshes.get(workspaceId);
      if (refresh?.epoch === this.#epoch) {
        for (const agent of refresh.remaining ?? this.#due(workspaceId, refresh.active))
          pending.add(agent);
        if (refresh.next)
          for (const agent of this.#due(workspaceId, refresh.next)) pending.add(agent);
      }
      for (const agent of pending) result.push({ workspaceId, agent });
    }
    return result;
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
    refresh.promise = Promise.resolve().then(async () => {
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
    this.#refreshes.set(workspaceId, refresh);
    const release = () => {
      if (this.#refreshes.get(workspaceId) === refresh) this.#refreshes.delete(workspaceId);
    };
    void refresh.promise.then(release, release);
    return refresh.promise;
  }
  #assertCurrent(epoch: bigint) {
    if (this.#closed || epoch !== this.#epoch) throw new Error("session-index-stale");
    if (!this.enabled()) throw new Error("index-disabled");
  }
  #sourceChanged() {
    if (this.#changed || this.#closed) return;
    this.#changed = setTimeout(() => {
      this.#changed = undefined;
      if (!this.#closed) this.sourceChanged();
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
        listing = await this.readers.list(agent, workspace);
      } catch {
        this.#assertCurrent(epoch);
        this.store.failure(workspaceId, agent, "Conversation source could not be read");
        refresh.remaining.delete(agent);
        this.#sourceChanged();
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      this.#assertCurrent(epoch);
      const owner = ["open-claw", "hermes", "grok-build"].includes(agent)
        ? (normalizedOwner ??= this.store.owner(workspaceId))
        : undefined;
      this.store.sync(
        workspaceId,
        agent,
        agent === "claude-code" ? this.#managed(listing.sessions) : listing.sessions,
        !listing.incomplete,
        owner,
      );
      if (agent === "codex" && !this.store.codexClassificationPending(workspaceId))
        this.#classificationRetryAfter.delete(workspaceId);
      if (listing.incomplete)
        this.store.failure(
          workspaceId,
          agent,
          "Some conversation sources could not be read; previous records were retained",
        );
      refresh.remaining.delete(agent);
      this.#sourceChanged();
      // Most native metadata readers are synchronous. Yield between sources so
      // cached directory reads and committed-source invalidations can be served.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.#assertCurrent(epoch);
    this.refreshed();
    return this.store.list(workspaceId);
  }
  /** AgentKib's own Claude runs start in print mode, yet they are the user's conversations. */
  #managed(sessions: NativeListing["sessions"]): NativeListing["sessions"] {
    if (!sessions.some((session) => session.origin === "execution")) return sessions;
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
