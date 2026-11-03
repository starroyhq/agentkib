import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { ConversationReadResult, ConversationReadState } from "@agentkib/runtime-protocol";
import { CodexAppServerError, CodexAppServerSession } from "./codex-app-server";
import { pathIdentity } from "./paths";

export interface CodexReadTarget {
  key: string;
  home: string;
  workspace: string;
  nativeId: string;
  executable: string;
}
type NativeRead = {
  revision: string;
  firstUnread: { type: "threadStart" } | { type: "turn"; turnId: string } | null;
};
type Snapshot = {
  receipt: NativeRead;
  latest: ConversationReadResult | null;
  active: boolean;
  checkedAt: number;
  stale: boolean;
};
type Connection = {
  session: Promise<CodexAppServerSession>;
  tail: Promise<unknown>;
  used: number;
  queued: number;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function receipt(value: unknown): NativeRead {
  if (
    !object(value) ||
    typeof value.revision !== "string" ||
    !value.revision ||
    value.revision.length > 8192
  )
    throw new Error("read-state-unavailable");
  const unread = value.firstUnread;
  if (
    unread !== null &&
    (!object(unread) ||
      (unread.type !== "threadStart" &&
        !(unread.type === "turn" && typeof unread.turnId === "string")))
  )
    throw new Error("read-state-unavailable");
  return { revision: value.revision, firstUnread: unread as NativeRead["firstUnread"] };
}
function nativeResult(value: unknown): ConversationReadResult | null {
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
  #snapshots = new Map<string, Snapshot>();
  #unsupported = new Map<string, number>();
  #unsupportedThreads = new Map<string, number>();
  #epochs = new Map<string, number>();
  #pages = new Map<string, string | null>();
  #closed = false;
  constructor(
    readonly environment: NodeJS.ProcessEnv,
    readonly changed: () => void,
    readonly start = CodexAppServerSession.start,
  ) {}

  async close(): Promise<void> {
    this.#closed = true;
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    await Promise.allSettled(
      connections.map(async (connection) => (await connection.session).close()),
    );
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
  #connection(target: CodexReadTarget): Connection {
    if (this.#closed) throw new Error("read-state-unavailable");
    const key = this.#poolKey(target);
    let connection = this.#connections.get(key);
    if (connection) {
      connection.used = Date.now();
      return connection;
    }
    if (this.#connections.size >= 8) {
      const oldest = [...this.#connections.entries()]
        .filter((entry) => entry[1].queued === 0)
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) throw new Error("read-state-unavailable");
      this.#connections.delete(oldest[0]);
      void oldest[1].session.then((session) => session.close()).catch(() => undefined);
    }
    const opened = this.start(
      target.executable,
      target.workspace,
      target.home,
      this.environment,
      (event) => {
        if (
          event.method !== "thread/readState/changed" ||
          !object(event.params) ||
          typeof event.params.threadId !== "string"
        )
          return;
        // A notification is invalidation, not permission to acknowledge or take execution ownership.
        for (const [id, snapshot] of this.#snapshots) {
          if (id.startsWith(`${key}\0${event.params.threadId}\0`)) snapshot.stale = true;
        }
        this.changed();
      },
    );
    connection = { session: opened, tail: Promise.resolve(), used: Date.now(), queued: 0 };
    this.#connections.set(key, connection);
    const captured = connection;
    void opened.then(
      (session) =>
        session.once("close", () => {
          if (this.#connections.get(key) === captured) this.#connections.delete(key);
          for (const [id, snapshot] of this.#snapshots)
            if (id.startsWith(`${key}\0`)) snapshot.stale = true;
          if (!this.#closed) this.changed();
        }),
      () => {
        if (this.#connections.get(key) === captured) this.#connections.delete(key);
      },
    );
    return connection;
  }

  #cacheKey(target: CodexReadTarget): string {
    return `${this.#poolKey(target)}\0${target.nativeId}\0${target.key}`;
  }
  #serialized<T>(
    target: CodexReadTarget,
    operation: (session: CodexAppServerSession) => Promise<T>,
  ): Promise<T> {
    const connection = this.#connection(target);
    if (connection.queued >= 64) return Promise.reject(new Error("read-state-unavailable"));
    connection.queued++;
    const run = connection.tail
      .catch(() => undefined)
      .then(async () => operation(await connection.session))
      .finally(() => {
        connection.queued--;
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
    const stale = snapshot.stale || Date.now() - snapshot.checkedAt > 10_000;
    const first = snapshot.receipt.firstUnread;
    return {
      source: "codex-native",
      status: first === null ? "read" : "unread",
      freshness: stale ? "stale" : "current",
      version: `codex-native:${createHash("sha256")
        .update(
          JSON.stringify([
            target.key,
            scope,
            this.#cacheKey(target),
            this.#epochs.get(this.#cacheKey(target)) ?? 0,
            snapshot.receipt.revision,
            snapshot.latest?.id ?? null,
            snapshot.active,
          ]),
        )
        .digest("base64url")}`,
      firstUnread:
        first === null
          ? null
          : first.type === "threadStart"
            ? first
            : { type: "result", resultId: `turn:${first.turnId}`, turnId: first.turnId },
      latestResult: snapshot.latest,
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
        const value = await session.request("thread/list", {
          cursor,
          limit: 20,
          sortKey: "updated_at",
          sortDirection: "desc",
          modelProviders: [],
        });
        if (!object(value) || !Array.isArray(value.data)) return;
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

  async #read(session: CodexAppServerSession, target: CodexReadTarget): Promise<Snapshot> {
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
      throw new Error("read-state-unavailable");
    if (!Object.hasOwn(value, "readState") || value.readState === null)
      throw new Error("read-state-thread-unsupported");
    const current = receipt(value.readState);
    const turns = await session.request("thread/turns/list", {
      threadId: target.nativeId,
      cursor: null,
      limit: 20,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    if (!object(turns) || !Array.isArray(turns.data)) throw new Error("read-state-unavailable");
    const active = object(turns.data[0]) && turns.data[0].status === "inProgress";
    const latest = turns.data.map(nativeResult).find((result) => result !== null) ?? null;
    const checked = await session.request("thread/read", {
      threadId: target.nativeId,
      includeTurns: false,
    });
    if (!object(checked) || JSON.stringify(receipt(checked.readState)) !== JSON.stringify(current))
      throw new Error("read-state-unavailable");
    return { receipt: current, latest, active, checkedAt: Date.now(), stale: false };
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
        const fresh = await this.#read(session, target);
        const poolChanged = this.#unsupported.delete(this.#poolKey(target)),
          threadChanged = this.#unsupportedThreads.delete(key);
        if (poolChanged || threadChanged) this.#epochs.set(key, (this.#epochs.get(key) ?? 0) + 1);
        this.#snapshots.set(key, fresh);
        if (
          JSON.stringify([old?.receipt, old?.latest, old?.stale]) !==
          JSON.stringify([fresh.receipt, fresh.latest, false])
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
  ): Promise<ConversationReadState> {
    if (
      this.#unsupported.has(this.#poolKey(target)) ||
      this.#unsupportedThreads.has(this.#cacheKey(target))
    )
      throw new Error("read-state-conflict");
    return this.#serialized(target, async (session) => {
      const fresh = await this.#read(session, target);
      this.#snapshots.set(this.#cacheKey(target), fresh);
      const projected = this.#project(target, scope, fresh);
      if (
        projected.version !== expectedVersion ||
        (projected.latestResult?.id ?? null) !== seenResultId
      )
        throw new Error("read-state-conflict");
      let value: unknown;
      try {
        value = await session.request("thread/readState/update", {
          threadId: target.nativeId,
          expectedRevision: fresh.receipt.revision,
          operation: { type: "read" },
        });
      } catch (error) {
        fresh.stale = true;
        this.changed();
        if (error instanceof CodexAppServerError) throw new Error("read-state-conflict");
        // Losing a write response is unknown. Only a subsequent GET may reconcile it.
        throw new Error("read-state-unavailable");
      }
      if (!object(value)) throw new Error("read-state-unavailable");
      fresh.receipt = receipt(value.readState);
      fresh.checkedAt = Date.now();
      this.changed();
      return this.#project(target, scope, fresh);
    }).catch((error: unknown) => {
      const snapshot = this.#snapshots.get(this.#cacheKey(target));
      if (snapshot) snapshot.stale = true;
      this.changed();
      if (error instanceof Error && error.message === "read-state-conflict") throw error;
      throw new Error("read-state-unavailable");
    });
  }
}
