import { homedir } from "node:os";
import type { ConversationReadResult, ConversationReadState } from "@agentkib/runtime-protocol";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import { resolveClaudeConfig } from "./claude-config";
import { codexRollouts } from "./codex-rollout-files";
import { CodexReadStateObserver, type CodexReadTarget } from "./codex-read-state";
import { conversationReadKey, ReadStateLedger } from "./read-state-ledger";
import { observeReadHistory } from "./read-state-history";
import { hasManagedCatalogWorkspace, managedRecordSchema } from "./managed-session-catalog";
import { readManagedRecord } from "./managed-ledger";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { resolveCommand } from "./command-resolution";

export interface ReadStateTarget {
  provider: "codex" | "claude-code";
  home: string;
  nativeId: string;
  workspace: string;
  transcript: string | null;
}
type Target = ReadStateTarget & { key: string };
type Candidate = {
  provider: "codex" | "claude-code";
  target?: Target;
  touched: number;
  stale: boolean;
};
const unknown = (source: ConversationReadState["source"]): ConversationReadState => ({
  source,
  status: "unknown",
  freshness: "stale",
  version: null,
  firstUnread: null,
  latestResult: null,
});
/** A thread with no turns yet has nothing to review. */
const nothingToRead: ConversationReadState = {
  source: "codex-native",
  status: "read",
  freshness: "current",
  version: null,
  firstUnread: null,
  latestResult: null,
};
function readStateFailure(error: unknown): Error {
  return error instanceof Error &&
    ["read-state-conflict", "read-state-unavailable", "read-state-unsupported"].includes(
      error.message,
    )
    ? error
    : new Error("read-state-unavailable");
}

/** Host-wide observation, with acknowledgements isolated by the authenticated reader scope. */
export class ConversationReadStates {
  readonly ledger: ReadStateLedger;
  #native: CodexReadStateObserver;
  #candidates = new Map<string, Candidate>();
  #timer: ReturnType<typeof setInterval>;
  #cursor = 0;
  #homeCursor = 0;
  #polling = false;
  #closed = false;
  #flights = new Map<string, Promise<Target>>();
  #sources = new Map<string, "codex-native" | "agentkib">();
  #lastNative = new Map<string, ConversationReadState>();
  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly claudeManagedTarget: (id: string) => ReadStateTarget | null,
    readonly changed: () => void,
    readonly observed: () => boolean,
  ) {
    this.ledger = new ReadStateLedger(dataDir);
    this.#native = new CodexReadStateObserver(environment, changed);
    this.#timer = setInterval(() => void this.#poll(), 5_000);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#native.close();
  }

  #nativeTarget(target: Target): CodexReadTarget | null {
    if (target.provider !== "codex") return null;
    const executable = resolveCommand("codex", this.environment);
    return executable ? { ...target, executable } : null;
  }

  async #resolve(id: string): Promise<Target> {
    const flight = this.#flights.get(id);
    if (flight) return flight;
    const work = (async (): Promise<Target> => {
      const claude = this.claudeManagedTarget(id);
      let target: ReadStateTarget;
      if (claude) target = claude;
      else {
        const stored = readManagedRecord(this.dataDir, id);
        const parsed = managedRecordSchema.safeParse(stored);
        if (parsed.success) {
          const record = parsed.data;
          if (
            !hasManagedCatalogWorkspace(this.store, record) ||
            pathIdentity(record.home) !== pathIdentity(this.sessions.codexHome()) ||
            !record.native_id
          )
            throw new Error("read-state-unavailable");
          let transcript: string | null = null;
          const alias = this.store.sessions.id("codex", record.native_id);
          if (this.store.sessions.get(alias)) {
            const source = await this.sessions.resolve(alias);
            transcript = "transcript" in source ? (source.transcript ?? null) : null;
          }
          const verified = this.sessions.verifiedCodexControlDirectory(record.native_id);
          if (
            !verified ||
            !within(canonicalize(verified.cwd), canonicalize(record.workspace)) ||
            (record.cwd !== undefined && pathIdentity(verified.cwd) !== pathIdentity(record.cwd))
          )
            throw new Error("read-state-unavailable");
          transcript ??= this.sessions.verifiedCodexReadTranscript(
            record.native_id,
            record.workspace,
          );
          target = {
            provider: "codex",
            home: record.home,
            nativeId: record.native_id,
            workspace: verified.cwd,
            transcript,
          };
        } else {
          const summary = this.store.sessions.get(id);
          if (summary?.agent !== "codex" && summary?.agent !== "claude-code")
            throw new Error("read-state-unsupported");
          const source = await this.sessions.resolve(id);
          if (!source.workspace) throw new Error("read-state-unavailable");
          const workspace =
            source.native.agent === "codex"
              ? this.sessions.verifiedCodexControlDirectory(source.native.native_ref)?.cwd
              : source.workspace;
          if (!workspace) throw new Error("read-state-unavailable");
          if (!within(canonicalize(workspace), canonicalize(source.workspace)))
            throw new Error("read-state-unavailable");
          target = {
            provider: summary.agent,
            home:
              summary.agent === "codex"
                ? this.sessions.codexHome()
                : resolveClaudeConfig(this.environment, this.environment.HOME ?? homedir()).dir,
            nativeId: source.native.native_ref,
            workspace,
            transcript: "transcript" in source ? (source.transcript ?? null) : null,
          };
        }
      }
      const result = {
        ...target,
        key: conversationReadKey(target.provider, target.home, target.nativeId),
      };
      const candidate = this.#candidates.get(id) ?? {
        provider: target.provider,
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
    const sourceKey = JSON.stringify([target.key, scope]);
    if (native) {
      const value = await this.#native.refresh(native, scope);
      if (this.#closed) throw new Error("read-state-unavailable");
      if (value) {
        if (value.status === "unknown") {
          const persisted = this.ledger.nativeSnapshot(target.key)?.state;
          if (persisted?.status === "unread")
            return { ...persisted, source: "codex-native", freshness: "stale", version: null };
        }
        this.#sources.set(sourceKey, "codex-native");
        this.#lastNative.set(sourceKey, value);
        const revision = this.#native.revision(native);
        if (revision && value.freshness === "current") {
          try {
            this.ledger.saveNative(target.key, value, revision);
          } catch {
            return { ...value, freshness: "stale" };
          }
        }
        return value;
      }
    } else if (target.provider === "codex") {
      // Missing executable is temporary; never silently switch an authoritative source.
      const previous =
        this.#lastNative.get(sourceKey) ?? this.ledger.nativeSnapshot(target.key)?.state;
      return {
        ...(previous ?? unknown("codex-native")),
        source: "codex-native",
        freshness: "stale",
        version: null,
      };
    }
    const before = this.ledger.get(target.key, scope);
    try {
      this.ledger.retryObservations(target.key);
      if (target.transcript) {
        const file =
          target.provider === "codex"
            ? await codexRollouts.plain(target.transcript)
            : target.transcript;
        if (this.#closed) throw new Error("read-state-unavailable");
        const observation = observeReadHistory(this.ledger, target.key, target.provider, file);
        if (observation.changed || (before.status === "unknown" && observation.complete))
          this.changed();
        if (native && this.#sources.get(sourceKey) !== "agentkib" && observation.complete) {
          const persisted = this.ledger.nativeSnapshot(target.key);
          const verified = persisted?.state ?? this.#native.lastVerified(native, scope);
          if (verified) this.ledger.handoff(target.key, scope, verified, persisted?.fingerprint);
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

  /** Codex writes a thread AgentKib started only with its first message. */
  #unwrittenCodexThread(id: string): boolean {
    const parsed = managedRecordSchema.safeParse(readManagedRecord(this.dataDir, id));
    return (
      parsed.success &&
      !!parsed.data.native_id &&
      pathIdentity(parsed.data.home) === pathIdentity(this.sessions.codexHome()) &&
      !this.sessions.codexThreadWritten(parsed.data.native_id)
    );
  }

  async get(id: string, scope: string): Promise<ConversationReadState> {
    if (this.#closed) throw new Error("read-state-unavailable");
    if (this.#unwrittenCodexThread(id)) return nothingToRead;
    const target = await this.#resolve(id);
    if (this.#closed) throw new Error("read-state-unavailable");
    const value = await this.#observe(target, scope).catch((error: unknown) => {
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
  ): Promise<ConversationReadState> {
    if (this.#closed) throw new Error("read-state-unavailable");
    const target = await this.#resolve(id);
    if (this.#closed) throw new Error("read-state-unavailable");
    const current = await this.#observe(target, scope).catch((error: unknown) => {
      throw readStateFailure(error);
    });
    if (current.freshness !== "current" || current.version === null)
      throw new Error("read-state-unavailable");
    if (current.version !== expectedVersion || (current.latestResult?.id ?? null) !== seenResultId)
      throw new Error("read-state-conflict");
    const native = this.#nativeTarget(target);
    if (current.source === "codex-native") {
      if (!native) throw new Error("read-state-unavailable");
      const state = await this.#native.update(native, scope, expectedVersion, seenResultId);
      if (this.#closed) throw new Error("read-state-unavailable");
      const revision = this.#native.revision(native);
      if (revision) {
        try {
          this.ledger.saveNative(target.key, state, revision);
        } catch {
          throw new Error("read-state-unavailable");
        }
      }
      this.#lastNative.set(JSON.stringify([target.key, scope]), state);
      return state;
    }
    let result: ConversationReadState;
    try {
      result = this.ledger.update(target.key, scope, expectedVersion, seenResultId);
    } catch (error) {
      throw readStateFailure(error);
    }
    this.changed();
    return result;
  }

  /** Does not await N native processes on a catalog request; the observer visits bounded pages. */
  project<T>(rows: T[], scope: string): T[] {
    const now = Date.now();
    const fallbackKeys = new Map<string, boolean>();
    let codexExecutable: string | null | undefined;
    const projections = rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        !("id" in row) ||
        !("agent" in row) ||
        typeof row.id !== "string" ||
        (row.agent !== "codex" && row.agent !== "claude-code")
      )
        return { row };
      let candidate = this.#candidates.get(row.id);
      if (!candidate) {
        if (this.#candidates.size >= 20_000) return { row };
        candidate = { provider: row.agent, touched: now, stale: true };
        this.#candidates.set(row.id, candidate);
      }
      candidate.touched = now;
      const { target, stale } = candidate;
      if (!target)
        return {
          row,
          state: unknown(candidate.provider === "codex" ? "codex-native" : "agentkib"),
        };
      if (target.provider === "codex" && codexExecutable === undefined)
        codexExecutable = resolveCommand("codex", this.environment);
      const executable = target.provider === "codex" ? codexExecutable : null;
      if (executable) {
        const state = this.#native.cached({ ...target, executable }, scope);
        if (state) return { row, state, stale };
      } else if (candidate.provider === "codex") {
        return { row, state: unknown("codex-native") };
      }
      fallbackKeys.set(target.key, candidate.provider === "codex");
      return { row, fallbackKey: target.key, stale };
    });
    const fallbackStates = this.ledger.catalogStates(fallbackKeys, scope);
    return projections.map(({ row, state, fallbackKey, stale }) => {
      const readState = fallbackKey
        ? (fallbackStates.get(fallbackKey) ?? unknown("agentkib"))
        : state;
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
      const homes = new Map<string, CodexReadTarget>();
      for (const candidate of this.#candidates.values()) {
        const target = candidate.target && this.#nativeTarget(candidate.target);
        if (target) homes.set(pathIdentity(target.home), target);
      }
      const native = [...homes.values()];
      if (native.length) await this.#native.pollPage(native[this.#homeCursor++ % native.length]!);
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
  ): void {
    if (this.#closed) return;
    this.ledger.record(conversationReadKey(target.provider, target.home, target.nativeId), result);
    this.changed();
  }
}
