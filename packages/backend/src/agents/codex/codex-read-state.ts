import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type {
  ConversationReadResult,
  ConversationReadState,
  ConversationReadStateMark,
} from "@agentkib/runtime-protocol";
import { CodexAppServerError, CodexAppServerSession } from "./codex-app-server";
import { pathIdentity } from "../../paths";
import { codexTerminalResults } from "../../read-state-history";

export interface CodexReadTarget {
  key: string;
  home: string;
  workspace: string;
  nativeId: string;
  executable: string;
  transcript?: string | null;
}
export type CodexReadActiveTurn = (
  target: Pick<CodexReadTarget, "home" | "workspace" | "nativeId">,
) => string | null;
type NativeRead = {
  revision: string;
  firstUnread: { type: "threadStart" } | { type: "turn"; turnId: string } | null;
};
type Snapshot = {
  receipt: NativeRead;
  latest: ConversationReadResult | null;
  ownerTurnId: string | null;
  activeTurnId: string | null;
  pendingTurnIds: string[];
  checkedAt: number;
  stale: boolean;
  fileVersion?: string;
};
type Connection = {
  session: Promise<CodexAppServerSession>;
  child?: CodexAppServerSession;
  retiring?: Promise<void>;
  tail: Promise<unknown>;
  used: number;
  queued: number;
};
const MAX_CONNECTIONS = 8;
const MAX_QUEUED = 64;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function receipt(value: unknown): NativeRead {
  if (
    !object(value) ||
    typeof value.revision !== "string" ||
    !value.revision ||
    value.revision.length > 8192
  )
    throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
  const unread = value.firstUnread;
  if (
    unread !== null &&
    (!object(unread) ||
      (unread.type !== "threadStart" &&
        !(unread.type === "turn" && typeof unread.turnId === "string")))
  )
    throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
  return { revision: value.revision, firstUnread: unread as NativeRead["firstUnread"] };
}
function nativeResult(value: unknown): (ConversationReadResult & { turnId: string }) | null {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !["completed", "failed", "interrupted"].includes(String(value.status))
  )
    return null;
  const completed =
    typeof value.completedAt === "number" && Number.isFinite(value.completedAt)
      ? new Date(value.completedAt * 1000)
      : null;
  return {
    id: `turn:${value.id}`,
    turnId: value.id,
    itemId: null,
    outcome:
      value.status === "failed"
        ? "failed"
        : value.status === "interrupted"
          ? "cancelled"
          : "completed",
    completedAt: completed && Number.isFinite(completed.getTime()) ? completed.toISOString() : null,
  };
}

/** No resume/start/turn RPC is ever issued by this observer. */
export class CodexReadStateObserver {
  #connections = new Map<string, Connection>();
  #eviction?: Promise<void>;
  #snapshots = new Map<string, Snapshot>();
  #unsupported = new Map<string, number>();
  #unsupportedThreads = new Map<string, number>();
  #epochs = new Map<string, number>();
  #pages = new Map<string, string | null>();
  #directory = new Map<
    string,
    { thread: Record<string, unknown>; receipt: NativeRead; checkedAt: number }
  >();
  #workspacePages = new Map<string, { cursor: string | null; checkedAt: number }>();
  #directoryEpochs = new Map<string, number>();
  #closed = false;
  #closing?: Promise<void>;
  constructor(
    readonly environment: NodeJS.ProcessEnv,
    readonly changed: () => void,
    readonly start = CodexAppServerSession.start,
    readonly activeTurn: CodexReadActiveTurn = () => null,
  ) {}

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#directory.clear();
    this.#workspacePages.clear();
    return (this.#closing = Promise.allSettled(
      [...this.#connections].map(([key, connection]) => this.#retire(key, connection)),
    ).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }));
  }

  #poolKey(target: CodexReadTarget): string {
    let identity = "missing";
    try {
      const stat = statSync(target.executable);
      identity = `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      /* Start reports a temporary unavailable executable. */
    }
    return JSON.stringify([pathIdentity(target.home), target.executable, identity]);
  }
  #forget(key: string, connection: Connection): void {
    if (this.#connections.get(key) !== connection) return;
    this.#connections.delete(key);
    this.#invalidateDirectory(key);
    for (const id of this.#directory.keys())
      if (id.startsWith(`${key}\0`)) this.#directory.delete(id);
    for (const [id, snapshot] of this.#snapshots)
      if (id.startsWith(`${key}\0`)) snapshot.stale = true;
    if (!this.#closed) this.changed();
  }

  #retire(key: string, connection: Connection): Promise<void> {
    return (connection.retiring ??= (async () => {
      const child = connection.child ?? (await connection.session.catch(() => connection.child));
      // A failed close does not prove exit. Its slot stays owned until the child closes.
      await child?.close();
      this.#forget(key, connection);
    })());
  }

  #startConnection(key: string, target: CodexReadTarget): Connection {
    const capture = (child: CodexAppServerSession) => {
      if (connection.child) return;
      connection.child = child;
      child.once("close", () => this.#forget(key, connection));
    };
    const connection: Connection = {
      tail: Promise.resolve(),
      used: Date.now(),
      queued: 0,
      session: Promise.resolve().then(async () => {
        try {
          if (this.#closed || connection.retiring)
            throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
          const child = await this.start(
            target.executable,
            target.workspace,
            target.home,
            this.environment,
            (event) => {
              if (
                this.#closed ||
                connection.retiring ||
                this.#connections.get(key) !== connection ||
                event.method !== "thread/readState/changed" ||
                !object(event.params) ||
                typeof event.params.threadId !== "string"
              )
                return;
              this.#directory.delete(`${key}\0${event.params.threadId}`);
              this.#invalidateDirectory(key);
              // Notifications invalidate receipts without granting permission to change them.
              for (const [id, snapshot] of this.#snapshots) {
                if (id.startsWith(`${key}\0${event.params.threadId}\0`)) snapshot.stale = true;
              }
              this.changed();
            },
            capture,
          );
          capture(child);
          return child;
        } catch (error) {
          if (!connection.child || connection.child.closed) this.#forget(key, connection);
          throw error;
        }
      }),
    };
    this.#connections.set(key, connection);
    return connection;
  }

  async #claimConnection(key: string, target: CodexReadTarget): Promise<Connection> {
    while (!this.#closed) {
      const existing = this.#connections.get(key);
      if (existing && (existing.retiring || (existing.child && !existing.child.connected))) {
        await this.#retire(key, existing);
        continue;
      }
      if (!existing && this.#connections.size >= MAX_CONNECTIONS) {
        // Quiet observers still receive native invalidations. Evict them only to
        // admit a new target, and confirm exit before opening the replacement.
        if (!this.#eviction) {
          const oldest = [...this.#connections.entries()]
            .filter(([, connection]) => !connection.retiring && connection.queued === 0)
            .sort(([, a], [, b]) => a.used - b.used)[0];
          if (!oldest) break;
          this.#eviction = this.#retire(...oldest).finally(() => {
            this.#eviction = undefined;
          });
        }
        await this.#eviction;
        continue;
      }
      const connection = existing ?? this.#startConnection(key, target);
      if (connection.queued >= MAX_QUEUED) break;
      // Reserve synchronously before returning the connection to the caller.
      connection.queued++;
      connection.used = Date.now();
      return connection;
    }
    throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
  }

  #cacheKey(target: CodexReadTarget): string {
    return `${this.#poolKey(target)}\0${target.nativeId}\0${target.key}`;
  }
  async #serialized<T>(
    target: CodexReadTarget,
    operation: (session: CodexAppServerSession) => Promise<T>,
  ): Promise<T> {
    const key = this.#poolKey(target);
    const connection = await this.#claimConnection(key, target);
    const run = connection.tail
      .catch(() => undefined)
      .then(async () => {
        const child = await connection.session;
        if (this.#closed || connection.retiring)
          throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
        return operation(child);
      })
      .finally(() => {
        connection.queued--;
        if (connection.child && !connection.child.connected)
          void this.#retire(key, connection).catch(() => undefined);
      });
    connection.tail = run;
    return run;
  }

  #project(target: CodexReadTarget, scope: string, snapshot?: Snapshot): ConversationReadState {
    if (!snapshot)
      return {
        source: "codex-native",
        status: "unknown",
        freshness: "stale",
        version: null,
        firstUnread: null,
        latestResult: null,
      };
    const first = snapshot.receipt.firstUnread;
    const ownerTurnId = this.activeTurn(target);
    const ownerChanged = ownerTurnId !== snapshot.ownerTurnId;
    const latest = ownerChanged && snapshot.latest?.turnId === ownerTurnId ? null : snapshot.latest;
    // Preserve a native unread pointer while its outcome is being verified. It
    // cannot authorize advancing the native receipt past an unobserved result.
    const unconfirmed =
      ownerChanged || (first?.type === "turn" && snapshot.pendingTurnIds.includes(first.turnId));
    const stale = snapshot.stale || Date.now() - snapshot.checkedAt > 10_000 || unconfirmed;
    return {
      source: "codex-native",
      status: first === null ? "read" : "unread",
      freshness: stale ? "stale" : "current",
      version: unconfirmed
        ? null
        : `codex-native:${createHash("sha256")
            .update(
              JSON.stringify([
                target.key,
                scope,
                this.#cacheKey(target),
                this.#epochs.get(this.#cacheKey(target)) ?? 0,
                snapshot.receipt.revision,
                snapshot.latest,
                snapshot.activeTurnId,
                snapshot.pendingTurnIds,
              ]),
            )
            .digest("base64url")}`,
      firstUnread:
        first === null
          ? null
          : first.type === "threadStart"
            ? first
            : { type: "result", resultId: `turn:${first.turnId}`, turnId: first.turnId },
      latestResult: latest,
    };
  }

  cached(target: CodexReadTarget, scope: string): ConversationReadState | null {
    if (
      this.#unsupported.has(this.#poolKey(target)) ||
      this.#unsupportedThreads.has(this.#cacheKey(target))
    )
      return null;
    return this.#project(target, scope, this.#snapshots.get(this.#cacheKey(target)));
  }

  lastVerified(target: CodexReadTarget, scope: string): ConversationReadState | null {
    const snapshot = this.#snapshots.get(this.#cacheKey(target));
    return snapshot ? this.#project(target, scope, snapshot) : null;
  }
  revision(target: CodexReadTarget): string | null {
    return this.#snapshots.get(this.#cacheKey(target))?.receipt.revision ?? null;
  }

  /** Directory observation includes old, unopened conversations and native manual unread. */
  async pollPage(target: CodexReadTarget): Promise<void> {
    const pool = this.#poolKey(target);
    if ((this.#unsupported.get(pool) ?? 0) > Date.now()) return;
    try {
      await this.#serialized(target, async (session) => {
        const cursor = this.#pages.get(pool) ?? null;
        const epoch = this.#directoryEpochs.get(pool);
        const params = {
          cursor,
          limit: 20,
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
        };
        let value: unknown;
        try {
          value = await session.request("thread/list", { ...params, useStateDbOnly: true });
        } catch (error) {
          // Older servers may reject the optimization option. Keep their original directory
          // observation and use coherent thread reads for result data instead.
          if (!(error instanceof CodexAppServerError) || error.code !== -32602) throw error;
          value = await session.request("thread/list", params);
        }
        if (
          this.#closed ||
          this.#directoryEpochs.get(pool) !== epoch ||
          !object(value) ||
          !Array.isArray(value.data)
        )
          return;
        this.#rememberDirectory(pool, value);
        const next =
          typeof value.nextCursor === "string" &&
          value.nextCursor.length <= 8192 &&
          value.nextCursor !== cursor
            ? value.nextCursor
            : null;
        this.#pages.set(pool, next);
        if (!object(value.readStates)) return;
        let changed = false;
        for (const [threadId, state] of Object.entries(value.readStates).slice(0, 20)) {
          if (state === null) continue;
          let current: NativeRead;
          try {
            current = receipt(state);
          } catch {
            continue;
          }
          for (const [key, snapshot] of this.#snapshots) {
            if (
              key.startsWith(`${pool}\0${threadId}\0`) &&
              JSON.stringify(snapshot.receipt) !== JSON.stringify(current)
            ) {
              snapshot.receipt = current;
              snapshot.stale = true;
              changed = true;
            }
          }
        }
        if (changed) this.changed();
      });
    } catch {
      /* Directory failure cannot turn a native receipt into a fallback baseline. */
    }
  }

  #invalidateDirectory(pool: string): void {
    this.#directoryEpochs.set(pool, (this.#directoryEpochs.get(pool) ?? 0) + 1);
    // Keep each page cursor: unread changes must not starve older directory candidates.
    for (const [key, page] of this.#workspacePages)
      if (key.startsWith(`${pool}\0`)) page.checkedAt = 0;
  }

  // Recent CLI versions can return native receipts from SQLite without decoding rollouts.
  // Keep pagination bounded; targets absent from a page still use the authoritative read RPC.
  #rememberDirectory(pool: string, value: Record<string, unknown>): void {
    if (!Array.isArray(value.data) || !object(value.readStates)) return;
    for (const thread of value.data.slice(0, 100)) {
      if (!object(thread) || typeof thread.id !== "string") continue;
      try {
        this.#directory.set(`${pool}\0${thread.id}`, {
          thread,
          receipt: receipt(value.readStates[thread.id]),
          checkedAt: Date.now(),
        });
      } catch {
        this.#directory.delete(`${pool}\0${thread.id}`);
      }
    }
    // Entries are only a short-lived batch cache, never an alternative receipt authority.
    for (const [key, entry] of this.#directory)
      if (Date.now() - entry.checkedAt > 10_000) this.#directory.delete(key);
  }

  #fileVersion(target: CodexReadTarget, thread: Record<string, unknown>): string | undefined {
    if (
      thread.id !== target.nativeId ||
      typeof thread.cwd !== "string" ||
      pathIdentity(thread.cwd) !== pathIdentity(target.workspace) ||
      typeof thread.path !== "string"
    )
      return undefined;
    try {
      const file = statSync(thread.path, { bigint: true });
      if (!file.isFile()) return undefined;
      return JSON.stringify([
        thread.path,
        String(file.dev),
        String(file.ino),
        String(file.size),
        String(file.mtimeNs),
        String(file.ctimeNs),
        thread.status,
      ]);
    } catch {
      return undefined;
    }
  }

  async #unchanged(
    session: CodexAppServerSession,
    target: CodexReadTarget,
    old: Snapshot | undefined,
  ): Promise<Snapshot | null> {
    if (!old?.fileVersion || old.ownerTurnId !== this.activeTurn(target)) return null;
    const pool = this.#poolKey(target);
    const key = `${pool}\0${target.nativeId}`;
    const workspace = `${pool}\0${pathIdentity(target.workspace)}`;
    let entry = this.#directory.get(key);
    if (!entry || Date.now() - entry.checkedAt > 2_000) {
      const page = this.#workspacePages.get(workspace);
      if (!page || Date.now() - page.checkedAt > 2_000) {
        try {
          const cursor = page?.cursor ?? null;
          const epoch = this.#directoryEpochs.get(pool);
          const value = await session.request("thread/list", {
            cursor,
            limit: 100,
            cwd: target.workspace,
            useStateDbOnly: true,
            sortKey: "updated_at",
            sortDirection: "desc",
            modelProviders: [],
            sourceKinds: [
              "cli",
              "vscode",
              "exec",
              "appServer",
              "subAgent",
              "subAgentReview",
              "subAgentCompact",
              "subAgentThreadSpawn",
              "subAgentOther",
              "unknown",
            ],
          });
          if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
          if (
            this.#directoryEpochs.get(pool) === epoch &&
            object(value) &&
            Array.isArray(value.data)
          ) {
            this.#rememberDirectory(pool, value);
            this.#workspacePages.set(workspace, {
              checkedAt: Date.now(),
              cursor:
                typeof value.nextCursor === "string" &&
                value.nextCursor.length <= 8192 &&
                value.nextCursor !== cursor
                  ? value.nextCursor
                  : null,
            });
          }
        } catch {
          // Missing options/readStates in older CLIs must not change the source or imply read.
        }
        entry = this.#directory.get(key);
      }
    }
    if (!old?.fileVersion || !entry || Date.now() - entry.checkedAt > 2_000) return null;
    if (
      this.#fileVersion(target, entry.thread) !== old.fileVersion ||
      old.ownerTurnId !== this.activeTurn(target)
    )
      return null;
    return { ...old, receipt: entry.receipt, checkedAt: entry.checkedAt, stale: false };
  }

  async #read(session: CodexAppServerSession, target: CodexReadTarget): Promise<Snapshot> {
    const ownerTurnId = this.activeTurn(target);
    let value: unknown;
    try {
      value = await session.request("thread/read", {
        threadId: target.nativeId,
        includeTurns: false,
      });
    } catch (error) {
      if (error instanceof CodexAppServerError && error.code === -32601)
        throw new Error("read-state-method-unsupported");
      throw error;
    }
    if (
      !object(value) ||
      !object(value.thread) ||
      value.thread.id !== target.nativeId ||
      typeof value.thread.cwd !== "string" ||
      pathIdentity(value.thread.cwd) !== pathIdentity(target.workspace)
    )
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    if (!Object.hasOwn(value, "readState") || value.readState === null)
      throw new Error("read-state-thread-unsupported");
    const current = receipt(value.readState);
    const fileVersion = this.#fileVersion(target, value.thread);
    const turns = await session.request("thread/turns/list", {
      threadId: target.nativeId,
      cursor: null,
      limit: 20,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    if (!object(turns) || !Array.isArray(turns.data))
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    const firstTurn = turns.data[0];
    const reportedActiveTurnId =
      object(firstTurn) && firstTurn.status === "inProgress" && typeof firstTurn.id === "string"
        ? firstTurn.id
        : null;
    const nativeResults = turns.data.map(nativeResult).filter((result) => result !== null);
    const uncertain = new Set(
      nativeResults
        .filter((result) => result.outcome === "cancelled" && result.completedAt === null)
        .map((result) => result.turnId),
    );
    // An independent app-server can report a live turn as interrupted with no
    // completedAt. A verified explicit end in the same transcript can prove it.
    const terminalEvidence =
      uncertain.size && target.transcript
        ? codexTerminalResults(target.transcript, uncertain)
        : null;
    const activeTurnId = ownerTurnId ?? reportedActiveTurnId;
    const pendingTurnIds = [...uncertain].filter((turnId) => !terminalEvidence?.has(turnId));
    if (activeTurnId && !pendingTurnIds.includes(activeTurnId)) pendingTurnIds.push(activeTurnId);
    const latest =
      nativeResults
        .filter((result) => !pendingTurnIds.includes(result.turnId))
        .map((result) => terminalEvidence?.get(result.turnId) ?? result)[0] ?? null;
    const checked = await session.request("thread/read", {
      threadId: target.nativeId,
      includeTurns: false,
    });
    if (!object(checked) || JSON.stringify(receipt(checked.readState)) !== JSON.stringify(current))
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    if (this.#closed || ownerTurnId !== this.activeTurn(target))
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    if (
      fileVersion &&
      (!object(checked.thread) || this.#fileVersion(target, checked.thread) !== fileVersion)
    )
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    // Replace any older batch entry so a concurrent native read/unread change cannot regress
    // to the receipt fetched by thread/list before this coherent read.
    this.#directory.delete(`${this.#poolKey(target)}\0${target.nativeId}`);
    return {
      receipt: current,
      latest,
      ownerTurnId,
      activeTurnId,
      pendingTurnIds,
      checkedAt: Date.now(),
      stale: false,
      fileVersion,
    };
  }

  async refresh(target: CodexReadTarget, scope: string): Promise<ConversationReadState | null> {
    if (
      (this.#unsupported.get(this.#poolKey(target)) ?? 0) > Date.now() ||
      (this.#unsupportedThreads.get(this.#cacheKey(target)) ?? 0) > Date.now()
    )
      return null;
    return this.#serialized(target, async (session) => {
      const key = this.#cacheKey(target),
        old = this.#snapshots.get(key);
      try {
        const fresh =
          (await this.#unchanged(session, target, old)) ?? (await this.#read(session, target));
        if (this.#closed) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
        const poolChanged = this.#unsupported.delete(this.#poolKey(target)),
          threadChanged = this.#unsupportedThreads.delete(key);
        if (poolChanged || threadChanged) this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
        this.#snapshots.set(key, fresh);
        if (
          JSON.stringify([
            old?.receipt,
            old?.latest,
            old?.activeTurnId,
            old?.pendingTurnIds,
            old?.stale,
          ]) !==
          JSON.stringify([
            fresh.receipt,
            fresh.latest,
            fresh.activeTurnId,
            fresh.pendingTurnIds,
            false,
          ])
        )
          this.changed();
        return this.#project(target, scope, fresh);
      } catch (error) {
        if (error instanceof Error && error.message === "read-state-thread-unsupported") {
          this.#unsupportedThreads.set(key, Date.now() + 30_000);
          this.changed();
          return null;
        }
        if (error instanceof Error && error.message === "read-state-method-unsupported") {
          this.#unsupported.set(this.#poolKey(target), Date.now() + 30_000);
          this.changed();
          return null;
        }
        if (old) old.stale = true;
        return this.#project(target, scope, old);
      }
    }).catch(() => {
      const old = this.#snapshots.get(this.#cacheKey(target));
      if (old) old.stale = true;
      return this.#project(target, scope, old);
    });
  }

  async update(
    target: CodexReadTarget,
    scope: string,
    expectedVersion: string,
    seenResultId: string | null,
    mark?: ConversationReadStateMark,
  ): Promise<ConversationReadState> {
    if (
      this.#unsupported.has(this.#poolKey(target)) ||
      this.#unsupportedThreads.has(this.#cacheKey(target))
    )
      throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
    return this.#serialized(target, async (session) => {
      const fresh = await this.#read(session, target);
      this.#snapshots.set(this.#cacheKey(target), fresh);
      const projected = this.#project(target, scope, fresh);
      if (projected.freshness !== "current")
        throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      if (
        projected.version !== expectedVersion ||
        (projected.latestResult?.id ?? null) !== seenResultId
      )
        throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
      this.#directory.delete(`${this.#poolKey(target)}\0${target.nativeId}`);
      this.#invalidateDirectory(this.#poolKey(target));
      let value: unknown;
      try {
        value = await session.request("thread/readState/update", {
          threadId: target.nativeId,
          expectedRevision: fresh.receipt.revision,
          operation: { type: mark ?? "read" },
        });
      } catch (error) {
        fresh.stale = true;
        this.changed();
        if (error instanceof CodexAppServerError)
          throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
        // Losing a write response is unknown. Only a subsequent GET may reconcile it.
        throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      }
      if (!object(value)) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      this.#directory.delete(`${this.#poolKey(target)}\0${target.nativeId}`);
      this.#invalidateDirectory(this.#poolKey(target));
      fresh.receipt = receipt(value.readState);
      fresh.checkedAt = Date.now();
      this.changed();
      return this.#project(target, scope, fresh);
    }).catch((error: unknown) => {
      const snapshot = this.#snapshots.get(this.#cacheKey(target));
      if (snapshot) snapshot.stale = true;
      this.changed();
      if (error instanceof Error && error.message === REMOTE_ERROR_CODES.readStateConflictDetail)
        throw error;
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
    });
  }
}
