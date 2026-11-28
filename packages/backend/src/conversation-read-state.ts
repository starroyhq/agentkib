import { createHash } from "node:crypto";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type {
  ConversationReadResult,
  ConversationReadState,
  ConversationReadStateMark,
} from "@agentkib/runtime-protocol";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import { conversationReadKey, ReadStateLedger } from "./read-state-ledger";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { getSessionProviderReader, sessionProviderReaders } from "./sessions/providers";
import type {
  NativeReadStateObserver,
  NativeReadStateTarget,
  ReadStateActiveTurn,
  ReadStateProvider,
  ReadStateTarget,
} from "./sessions/read-state-provider";

export type { ReadStateTarget } from "./sessions/read-state-provider";

type Target = ReadStateTarget & { key: string; reader: ReadStateProvider };
type Candidate = {
  reader: ReadStateProvider;
  target?: Target;
  touched: number;
  stale: boolean;
};

function readStateProvider(agent: unknown): ReadStateProvider | undefined {
  return typeof agent === "string" ? getSessionProviderReader(agent)?.readState : undefined;
}

const unknown = (source: ConversationReadState["source"]): ConversationReadState => ({
  source,
  status: "unknown",
  freshness: "stale",
  version: null,
  firstUnread: null,
  latestResult: null,
});
function readStateFailure(error: unknown): Error {
  return error instanceof Error &&
    [
      REMOTE_ERROR_CODES.readStateConflictDetail,
      REMOTE_ERROR_CODES.readStateUnavailableDetail,
      REMOTE_ERROR_CODES.readStateUnsupportedDetail,
    ].some((code) => code === error.message)
    ? error
    : new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
}

/** Host-wide observation, with acknowledgements isolated by the authenticated reader scope. */
export class ConversationReadStates {
  readonly ledger: ReadStateLedger;
  readonly #native = new Map<ReadStateProvider, NativeReadStateObserver>();
  readonly #managedReaders: NonNullable<ReadStateProvider["managed"]>[] = [];
  #candidates = new Map<string, Candidate>();
  #timer: ReturnType<typeof setInterval>;
  #cursor = 0;
  #homeCursor = 0;
  #polling = false;
  #closed = false;
  #flights = new Map<string, Promise<Target>>();
  #sources = new Map<string, ConversationReadState["source"]>();
  #lastNative = new Map<string, ConversationReadState>();
  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly claudeManagedTarget: (id: string) => ReadStateTarget | null,
    readonly changed: () => void,
    readonly observed: () => boolean,
    activeTurn?: ReadStateActiveTurn,
  ) {
    this.ledger = new ReadStateLedger(dataDir);
    for (const { readState } of sessionProviderReaders()) {
      if (readState?.native)
        this.#native.set(readState, readState.native.observe(environment, changed, activeTurn));
      if (readState?.managed) this.#managedReaders.push(readState.managed);
    }
    // A managed session may have a readable identity before it appears in the index.
    this.#managedReaders.sort((left, right) => left.priority - right.priority);
    this.#timer = setInterval(() => void this.#poll(), 5_000);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.all([...this.#native.values()].map((observer) => observer.close()));
  }

  #nativeTarget(target: Target) {
    const observer = this.#native.get(target.reader);
    const executable = target.reader.native?.executable(this.environment);
    return observer && executable ? { observer, target: { ...target, executable } } : null;
  }

  async #resolveIndexed(id: string): Promise<ReadStateTarget> {
    const reader = readStateProvider(this.store.sessions.get(id)?.agent);
    if (!reader) throw new Error(REMOTE_ERROR_CODES.readStateUnsupportedDetail);
    const source = await this.sessions.resolve(id);
    if (!source.workspace) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const nativeReader = readStateProvider(source.native.agent);
    const workspace = nativeReader?.indexedWorkspace
      ? nativeReader.indexedWorkspace(this, source)
      : source.workspace;
    if (!workspace || !within(canonicalize(workspace), canonicalize(source.workspace)))
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    return {
      provider: reader.agent,
      home: reader.home(this),
      nativeId: source.native.native_ref,
      workspace,
      transcript: "transcript" in source ? (source.transcript ?? null) : null,
    };
  }

  async #resolve(id: string): Promise<Target> {
    const flight = this.#flights.get(id);
    if (flight) return flight;
    const known = this.#candidates.get(id)?.target;
    if (known?.reader.reuseTarget && this.store.sessions.get(id)?.agent === known.provider)
      return known;
    const work = (async (): Promise<Target> => {
      let target: ReadStateTarget | null = null;
      for (const managed of this.#managedReaders) {
        const resolved = managed.resolve(this, id);
        if (!resolved) continue;
        target = resolved instanceof Promise ? await resolved : resolved;
        break;
      }
      target ??= await this.#resolveIndexed(id);
      const reader = readStateProvider(target.provider);
      if (!reader) throw new Error(REMOTE_ERROR_CODES.readStateUnsupportedDetail);
      const result = {
        ...target,
        reader,
        key: conversationReadKey(target.provider, target.home, target.nativeId),
      };
      const candidate = this.#candidates.get(id) ?? {
        reader,
        touched: Date.now(),
        stale: true,
      };
      candidate.target = result;
      this.#candidates.set(id, candidate);
      return result;
    })().catch((error: unknown) => {
      throw readStateFailure(error);
    });
    this.#flights.set(id, work);
    try {
      return await work;
    } finally {
      if (this.#flights.get(id) === work) this.#flights.delete(id);
    }
  }

  async #observe(target: Target, scope: string): Promise<ConversationReadState> {
    const native = this.#nativeTarget(target);
    const nativeSource = target.reader.native?.source;
    const sourceKey = JSON.stringify([target.key, scope]);
    if (native && nativeSource) {
      const value = await native.observer.refresh(native.target, scope);
      if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      if (value) {
        if (value.status === "unknown") {
          const persisted = this.ledger.nativeSnapshot(target.key)?.state;
          if (persisted?.status === "unread")
            return { ...persisted, source: nativeSource, freshness: "stale", version: null };
        }
        this.#sources.set(sourceKey, nativeSource);
        this.#lastNative.set(sourceKey, value);
        const revision = native.observer.revision(native.target);
        if (revision && value.freshness === "current") {
          try {
            this.ledger.saveNative(target.key, value, revision);
          } catch {
            return { ...value, freshness: "stale" };
          }
        }
        return value;
      }
    } else if (nativeSource) {
      // Missing executable is temporary; never silently switch an authoritative source.
      const previous =
        this.#lastNative.get(sourceKey) ?? this.ledger.nativeSnapshot(target.key)?.state;
      return {
        ...(previous ?? unknown(nativeSource)),
        source: nativeSource,
        freshness: "stale",
        version: null,
      };
    }
    const before = this.ledger.get(target.key, scope);
    const { ledgerOnly, readTranscript, observeTranscript } = target.reader;
    try {
      this.ledger.retryObservations(target.key, !!ledgerOnly);
      if (ledgerOnly) return ledgerOnly(this.ledger.get(target.key, scope));
      if (target.transcript && observeTranscript) {
        const file = readTranscript ? await readTranscript(target.transcript) : target.transcript;
        if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
        const observation = observeTranscript(this.ledger, target.key, file);
        if (observation.changed || (before.status === "unknown" && observation.complete))
          this.changed();
        if (native && this.#sources.get(sourceKey) !== "agentkib" && observation.complete) {
          const persisted = this.ledger.nativeSnapshot(target.key);
          const verified = persisted?.state ?? native.observer.lastVerified(native.target, scope);
          if (verified && !this.ledger.handoff(target.key, scope, verified, persisted?.fingerprint))
            return { ...this.ledger.get(target.key, scope), freshness: "stale", version: null };
          this.#sources.set(sourceKey, "agentkib");
        }
        const state = this.ledger.get(target.key, scope);
        if (!observation.complete) {
          const verified = native ? this.ledger.nativeSnapshot(target.key)?.state : null;
          return verified?.status === "unread" && state.status !== "unread"
            ? { ...verified, source: "agentkib", freshness: "stale", version: null }
            : { ...state, freshness: "stale" };
        }
        return state;
      }
      return { ...before, freshness: "stale" };
    } catch {
      return { ...before, freshness: "stale" };
    }
  }

  #requiresResultProof(target: Target, state: ConversationReadState): boolean {
    return (
      state.source === "agentkib" &&
      state.latestResult !== null &&
      !!(target.reader.verifyLedgerResult || target.reader.verifyTranscriptResult)
    );
  }

  async #withResultProof(
    target: Target,
    scope: string,
    state: ConversationReadState,
  ): Promise<ConversationReadState> {
    if (
      scope === "observer" ||
      state.status !== "unread" ||
      state.freshness !== "current" ||
      !state.version ||
      !state.latestResult ||
      !this.#requiresResultProof(target, state)
    )
      return state;
    const { verifyLedgerResult, verifyTranscriptResult, readTranscript } = target.reader;
    const result = state.latestResult;
    const proof = verifyLedgerResult
      ? await verifyLedgerResult(this, target, this.ledger, result)
      : target.transcript && verifyTranscriptResult
        ? await verifyTranscriptResult(
            this.ledger,
            target.key,
            result,
            readTranscript ? await readTranscript(target.transcript) : target.transcript,
            target.nativeId,
          )
        : undefined;
    if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const current = this.ledger.get(target.key, scope);
    if (current.freshness !== "current" || current.version !== state.version)
      return { ...state, freshness: "stale" };
    // Legacy clients require a current version to acknowledge automatically.
    if (!proof)
      return { ...state, version: null, manualVersion: state.version, canAcknowledge: false };
    const verified = {
      ...result,
      turnId: proof.turnId ?? result.turnId,
      itemId: proof.itemId,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify([state.version, verified, proof.evidence]))
      .digest("base64url");
    const firstUnread = state.firstUnread;
    return {
      ...state,
      version: `${state.version}.${digest}`,
      canAcknowledge: true,
      latestResult: verified,
      firstUnread:
        firstUnread?.type === "result" && firstUnread.resultId === verified.id
          ? { ...firstUnread, turnId: verified.turnId }
          : firstUnread,
    };
  }

  async get(id: string, scope: string): Promise<ConversationReadState> {
    if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    for (const managed of this.#managedReaders) {
      const state = managed.beforeGet?.(this, id);
      if (state) return state;
    }
    const target = await this.#resolve(id);
    if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const value = await this.#observe(target, scope)
      .then((state) => this.#withResultProof(target, scope, state))
      .catch((error: unknown) => {
        throw readStateFailure(error);
      });
    const candidate = this.#candidates.get(id)!;
    candidate.stale = value.freshness !== "current";
    return value;
  }

  async update(
    id: string,
    scope: string,
    expectedVersion: string,
    seenResultId: string | null,
    mark?: ConversationReadStateMark,
  ): Promise<ConversationReadState> {
    if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const target = await this.#resolve(id);
    if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const current = await this.#observe(target, scope).catch((error: unknown) => {
      throw readStateFailure(error);
    });
    if (current.freshness !== "current" || current.version === null)
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    if ((current.latestResult?.id ?? null) !== seenResultId)
      throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
    const observed = mark
      ? current
      : await this.#withResultProof(target, scope, current).catch((error: unknown) => {
          throw readStateFailure(error);
        });
    // A manual action only compares the reader's ledger revision and result.
    const expected =
      mark && current.source === "agentkib"
        ? expectedVersion.replace(/^(agentkib:[A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/, "$1")
        : expectedVersion;
    if (observed.freshness !== "current")
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    if (observed.version !== expected) throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
    if (!mark && this.#requiresResultProof(target, current) && observed.canAcknowledge !== true)
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const native = this.#nativeTarget(target);
    if (current.source !== "agentkib") {
      if (!native) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      const state = await native.observer.update(
        native.target,
        scope,
        expectedVersion,
        seenResultId,
        mark,
      );
      if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      const revision = native.observer.revision(native.target);
      if (revision) {
        try {
          this.ledger.saveNative(target.key, state, revision);
        } catch {
          throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
        }
      }
      this.#lastNative.set(JSON.stringify([target.key, scope]), state);
      return state;
    }
    let result: ConversationReadState;
    try {
      result = this.ledger.update(target.key, scope, current.version, seenResultId, mark);
    } catch (error) {
      throw readStateFailure(error);
    }
    this.changed();
    return target.reader.ledgerOnly?.(result) ?? result;
  }

  /** Does not await N native processes on a catalog request; the observer visits bounded pages. */
  project<T>(rows: T[], scope: string): T[] {
    const now = Date.now();
    const fallbackKeys = new Map<string, boolean>();
    const executables = new Map<ReadStateProvider, string | null>();
    const projections = rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        !("id" in row) ||
        !("agent" in row) ||
        typeof row.id !== "string"
      )
        return { row };
      const reader = readStateProvider(row.agent);
      if (!reader) return { row };
      let candidate = this.#candidates.get(row.id);
      if (!candidate) {
        if (this.#candidates.size >= 20_000) return { row };
        candidate = { reader, touched: now, stale: true };
        this.#candidates.set(row.id, candidate);
      }
      candidate.touched = now;
      const { target, stale } = candidate;
      const nativeSource = candidate.reader.native?.source;
      if (!target) return { row, state: unknown(nativeSource ?? "agentkib") };
      let executable = executables.get(target.reader);
      if (executable === undefined && target.reader.native) {
        executable = target.reader.native.executable(this.environment);
        executables.set(target.reader, executable);
      }
      if (executable) {
        const state = this.#native.get(target.reader)?.cached({ ...target, executable }, scope);
        if (state) return { row, state, stale };
      } else if (nativeSource) {
        return { row, state: unknown(nativeSource) };
      }
      fallbackKeys.set(target.key, !!nativeSource);
      return { row, fallbackKey: target.key, stale, ledgerOnly: target.reader.ledgerOnly };
    });
    const fallbackStates = this.ledger.catalogStates(fallbackKeys, scope);
    return projections.map(({ row, state, fallbackKey, stale, ledgerOnly }) => {
      let readState = state;
      if (fallbackKey) {
        const kept = fallbackStates.get(fallbackKey) ?? unknown("agentkib");
        readState = ledgerOnly ? ledgerOnly(kept) : kept;
      }
      return readState
        ? { ...row, readState: stale ? { ...readState, freshness: "stale" } : readState }
        : row;
    });
  }

  async #poll(): Promise<void> {
    if (
      this.#polling ||
      this.#closed ||
      (!this.observed() &&
        ![...this.#candidates.values()].some(
          (candidate) => Date.now() - candidate.touched < 12_000,
        ))
    )
      return;
    this.#polling = true;
    try {
      const ids = [...this.#candidates.keys()];
      const count = Math.min(20, ids.length);
      const deadline = Date.now() + 4_500;
      const homes = new Map<
        string,
        { observer: NativeReadStateObserver; target: NativeReadStateTarget }
      >();
      for (const candidate of this.#candidates.values()) {
        const native = candidate.target && this.#nativeTarget(candidate.target);
        if (native) homes.set(pathIdentity(native.target.home), native);
      }
      const pages = [...homes.values()];
      if (pages.length) {
        const { observer, target } = pages[this.#homeCursor++ % pages.length]!;
        await observer.pollPage(target);
      }
      let freshnessChanged = false;
      for (let n = 0; n < count && !this.#closed && Date.now() < deadline; n++) {
        const id = ids[this.#cursor++ % ids.length]!;
        const candidate = this.#candidates.get(id)!;
        const wasStale = candidate.stale;
        try {
          const value = await this.get(id, "observer");
          candidate.stale = value.freshness !== "current";
        } catch {
          candidate.stale = true;
        }
        freshnessChanged ||= wasStale !== candidate.stale;
      }
      // Native receipts and fallback results emit their own semantic invalidations.
      // An unchanged five-second revalidation must not restart the catalog refresh loop.
      if (freshnessChanged && !this.#closed) this.changed();
    } finally {
      this.#polling = false;
    }
  }

  recordTerminal(
    target: Omit<ReadStateTarget, "transcript">,
    result: ConversationReadResult,
    options?: { turnStartedAt?: string | null },
  ): void {
    if (this.#closed) return;
    this.ledger.record(
      conversationReadKey(target.provider, target.home, target.nativeId),
      result,
      !!readStateProvider(target.provider)?.ledgerOnly,
      options?.turnStartedAt,
    );
    this.changed();
  }
}
