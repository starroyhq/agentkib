import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import { openManagedLedger } from "../../managed-ledger";
import { existingFileLeaseBusy } from "../../managed-session-lock";
import type { DeferredCodexSendOwner, DeferredCodexSendResult } from "../../orchestration-service";
import type { managedControlSchema } from "../../sessions/control-admission";
import { finishControlReceiptInTransaction } from "../../sessions/control-receipts";

export const OWNER_WAIT_REASON = "codex-waiting-for-owner";
export const OWNER_WAIT_PAUSED = "codex-owner-wait-paused";
const POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;
const MAX_SESSIONS = 32;

export type OwnerWaitEntry = {
  request: z.infer<typeof managedControlSchema>;
  nativeId: string;
  workspaceId: string;
  home: string;
  lock: string;
  acceptedAt: number;
  restrictNativePolicy: boolean;
  worker?: DeferredCodexSendOwner;
};

type StoredWait = OwnerWaitEntry & { bootId: string; delivering: boolean };
type Delivery = DeferredCodexSendResult | { status: "retry" | "paused" };

export type CodexOwnerWaitSchedule = {
  operation: string;
  sessionId: string;
  deviceId: string;
  runtimeBootId: string;
  requestId: string;
  itemId?: string;
  expectedRevision?: number;
  permitId?: string;
  restrictNativePolicy?: boolean;
};

export function isLocalCodexSender(deviceId: string | undefined): boolean {
  return deviceId === undefined || deviceId === "desktop-local";
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NATIVE_ID = new RegExp("^" + UUID + "$", "i");
const FORK_ROLLOUT = new RegExp("-(" + UUID + ")_(" + UUID + ")\\.jsonl(?:\\.zst)?$", "i");

export function codexWriterLockPath(home: string, nativeId: string, transcript?: string) {
  if (!nativeId || nativeId === "." || nativeId === ".." || /[/\\]/.test(nativeId))
    throw new Error("native-session-unconfirmed");
  const fork =
    NATIVE_ID.test(nativeId) && transcript && FORK_ROLLOUT.exec(path.basename(transcript));
  const key = fork && fork[2]?.toLowerCase() === nativeId.toLowerCase() ? fork[1]! : nativeId;
  return path.join(home, "thread-writer-locks", key + ".lock");
}

/** Codex can leave the file after releasing its advisory lock. Probe and release before resume. */
function lockReleased(file: string): boolean {
  try {
    return !existingFileLeaseBusy(file);
  } catch (error) {
    // The file may vanish during the probe. Other errors leave ownership unconfirmed.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export class CodexOwnerWait {
  #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #ready = new Map<string, OwnerWaitEntry>();
  #permits = new Map<string, { id: string; requestId: string; until: number; sending: boolean }>();
  #stopped = false;

  constructor(
    private readonly deps: {
      dataDir: string;
      bootId: string;
      deliver(entry: OwnerWaitEntry, beforeDispatch: () => void): Promise<Delivery>;
      canDeliver(entry: OwnerWaitEntry): "ready" | "paused" | "revoked";
      changed(sessionId: string): void;
      report(entry: OwnerWaitEntry, result: DeferredCodexSendResult): void;
    },
  ) {}

  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#ready.clear();
    this.#permits.clear();
  }

  read(sessionId: string): StoredWait | undefined {
    const entry = this.#withTable(false, (db) => {
      const row = db
        .prepare("SELECT entry, boot_id, delivering FROM codex_owner_wait WHERE session_id=?")
        .get(sessionId) as { entry: string; boot_id: string; delivering: number } | undefined;
      if (!row) return;
      return {
        ...(JSON.parse(row.entry) as OwnerWaitEntry),
        bootId: row.boot_id,
        delivering: row.delivering === 1,
      };
    });
    if (
      entry?.worker &&
      entry.bootId !== this.deps.bootId &&
      this.deps.canDeliver(entry) === "revoked"
    ) {
      if (entry.delivering) this.dismissInterrupted(entry);
      else this.cancel(entry);
      return undefined;
    }
    return entry;
  }

  paused(entry: StoredWait): boolean {
    return (
      entry.bootId !== this.deps.bootId ||
      !this.#timers.has(entry.request.sessionId) ||
      this.deps.canDeliver(entry) === "paused"
    );
  }

  accept(entry: OwnerWaitEntry, fingerprint: string, evidence: Record<string, unknown>) {
    const { request } = entry;
    const result = {
      accepted: true,
      completed: false,
      reason: OWNER_WAIT_REASON,
      status: "waiting-for-owner",
      sessionId: request.sessionId,
      requestId: request.requestId,
      runtimeBootId: this.deps.bootId,
    };
    const stored = this.#withTable(true, (db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = db
          .prepare(
            "INSERT OR IGNORE INTO codex_owner_wait(session_id, request_id, device_id, boot_id, entry) SELECT ?,?,?,?,? WHERE (SELECT count(*) FROM codex_owner_wait) < ?",
          )
          .run(
            request.sessionId,
            request.requestId,
            request.deviceId ?? "",
            this.deps.bootId,
            JSON.stringify(entry),
            MAX_SESSIONS,
          );
        if (inserted.changes === 1)
          finishControlReceiptInTransaction(db, {
            requestId: request.requestId,
            sessionId: request.sessionId,
            fingerprint,
            deviceId: request.deviceId ?? "",
            evidence,
            result,
          });
        db.exec("COMMIT");
        return inserted.changes === 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    if (!stored) return;
    this.#arm(entry, POLL_MS);
    this.deps.changed(request.sessionId);
    return result;
  }

  cancel(entry: OwnerWaitEntry): boolean {
    const { request } = entry;
    const removed = this.#settle(
      entry,
      {
        accepted: true,
        completed: true,
        status: "cancelled",
      },
      "cancel",
    );
    if (!removed) return false;
    this.#clear(request.sessionId);
    this.deps.changed(request.sessionId);
    return true;
  }

  dismissInterrupted(entry: StoredWait): boolean {
    if (!entry.delivering || entry.bootId === this.deps.bootId) return false;
    const removed = this.#settle(
      entry,
      {
        accepted: false,
        completed: false,
        controlOutcome: "unknown",
        reason: "control-outcome-unconfirmed",
      },
      "dismiss",
    );
    if (removed) this.deps.changed(entry.request.sessionId);
    return removed;
  }

  resume(entry: StoredWait, restrictNativePolicy = false): boolean {
    if (entry.delivering || this.deps.canDeliver(entry) !== "ready") return false;
    const { request, bootId, delivering: _delivering, ...fields } = entry;
    const resumed = {
      ...fields,
      request,
      restrictNativePolicy: entry.restrictNativePolicy || restrictNativePolicy,
    };
    const saved = this.#withTable(
      false,
      (db) =>
        db
          .prepare(
            "UPDATE codex_owner_wait SET boot_id=?,entry=? WHERE session_id=? AND request_id=? AND boot_id=? AND delivering=0",
          )
          .run(
            this.deps.bootId,
            JSON.stringify(resumed),
            request.sessionId,
            request.requestId,
            bootId,
          ).changes === 1,
    );
    if (!saved) return false;
    this.#arm(resumed, POLL_MS);
    this.deps.changed(request.sessionId);
    return true;
  }

  invalidateDevice(deviceId: string): void {
    const entries = this.#withTable(
      false,
      (db) =>
        db
          .prepare("SELECT entry FROM codex_owner_wait WHERE device_id=? AND delivering=0")
          .all(deviceId) as Array<{ entry: string }>,
    );
    for (const { entry } of entries ?? []) this.cancel(JSON.parse(entry) as OwnerWaitEntry);
  }

  suspendDevice(deviceId: string): void {
    const sessions = this.#withTable(
      false,
      (db) =>
        db
          .prepare(
            "SELECT session_id FROM codex_owner_wait WHERE device_id=? AND boot_id=? AND delivering=0",
          )
          .all(deviceId, this.deps.bootId) as Array<{ session_id: string }>,
    );
    for (const { session_id } of sessions ?? []) {
      this.#clear(session_id);
      this.deps.changed(session_id);
    }
  }

  scheduleList() {
    return [...this.#ready.values()].flatMap((entry) => {
      const { request } = entry;
      if (!request.deviceId || this.#permits.get(request.sessionId)?.sending) return [];
      return [
        {
          agent: "codex" as const,
          sessionId: request.sessionId,
          workspaceId: entry.workspaceId,
          runtimeBootId: this.deps.bootId,
          revision: 0,
          paused: false,
          next: {
            itemId: request.requestId,
            requestId: request.requestId,
            deviceId: request.deviceId,
            kind: "queue" as const,
            requiresAttachments: !!request.input?.some(
              (part) =>
                typeof part === "object" &&
                part !== null &&
                "type" in part &&
                part.type === "localImage",
            ),
          },
        },
      ];
    });
  }

  async schedule(value: CodexOwnerWaitSchedule) {
    const { sessionId, deviceId, requestId, itemId, runtimeBootId, permitId } = value;
    if (runtimeBootId !== this.deps.bootId || this.#stopped)
      throw new Error("invalid-schedule-request");
    const current = this.read(sessionId);
    if (
      !current ||
      current.worker ||
      isLocalCodexSender(current.request.deviceId) ||
      current.request.deviceId !== deviceId ||
      current.bootId !== this.deps.bootId
    )
      throw new Error("stale-schedule-item");
    if (value.operation === "schedule-pause") {
      if (itemId !== current.request.requestId) throw new Error("stale-schedule-item");
      if (!current.delivering) this.cancel(current);
      return { accepted: true };
    }
    const ready = this.#ready.get(sessionId);
    if (
      !ready ||
      current.delivering ||
      ready.request.requestId !== requestId ||
      current.request.requestId !== requestId ||
      itemId !== requestId ||
      value.expectedRevision !== 0
    )
      throw new Error("stale-schedule-item");
    if (value.operation === "schedule-prepare") {
      const previous = this.#permits.get(sessionId);
      if (previous?.sending || (previous && previous.until >= Date.now()))
        return { accepted: false };
      const id = randomUUID();
      this.#permits.set(sessionId, { id, requestId, until: Date.now() + 15_000, sending: false });
      return { accepted: true, permitId: id, expectedRevision: 0, runtimeBootId };
    }
    const permit = this.#permits.get(sessionId);
    if (
      value.operation !== "schedule-dispatch" ||
      !permit ||
      permit.id !== permitId ||
      permit.requestId !== requestId ||
      permit.until < Date.now() ||
      permit.sending
    )
      throw new Error("schedule-permit-unavailable");
    permit.sending = true;
    try {
      await this.#tick(
        {
          ...ready,
          restrictNativePolicy: ready.restrictNativePolicy || value.restrictNativePolicy !== false,
        },
        POLL_MS,
        () => this.#permits.get(sessionId) === permit && Date.now() <= permit.until,
      );
    } finally {
      if (this.#permits.get(sessionId) === permit) this.#permits.delete(sessionId);
    }
    // An actual refusal has already settled the item and its original receipt. A relock
    // merely rearms the metadata check with the same accepted request.
    return { accepted: true };
  }

  #clear(sessionId: string): void {
    clearTimeout(this.#timers.get(sessionId));
    this.#timers.delete(sessionId);
    this.#ready.delete(sessionId);
    this.#permits.delete(sessionId);
  }

  #arm(entry: OwnerWaitEntry, delay: number): void {
    if (this.#stopped || this.#timers.has(entry.request.sessionId)) return;
    const timer = setTimeout(
      () =>
        void this.#tick(entry, delay).catch(() => {
          // Keep the durable item for manual recovery if the ledger becomes unavailable.
          if (this.#timers.get(entry.request.sessionId) === timer)
            this.#clear(entry.request.sessionId);
        }),
      delay,
    );
    timer.unref();
    this.#timers.set(entry.request.sessionId, timer);
  }

  async #tick(
    entry: OwnerWaitEntry,
    delay: number,
    authorizedByHost?: () => boolean,
  ): Promise<void> {
    const { request } = entry;
    const next = Math.min(delay * 2, MAX_POLL_MS);
    const timer = this.#timers.get(request.sessionId);
    const current = this.read(request.sessionId);
    if (
      !timer ||
      !current ||
      current.request.requestId !== request.requestId ||
      current.bootId !== this.deps.bootId ||
      current.delivering ||
      this.#stopped
    ) {
      this.#clear(request.sessionId);
      return;
    }
    const access = this.deps.canDeliver(entry);
    if (access === "revoked") {
      this.cancel(entry);
      return;
    }
    if (access === "paused" || !lockReleased(entry.lock)) {
      this.#clear(request.sessionId);
      this.#arm(entry, next);
      return;
    }
    const remote = !entry.worker && !isLocalCodexSender(entry.request.deviceId);
    if (remote && !authorizedByHost) {
      this.#ready.set(request.sessionId, entry);
      return;
    }
    const beforeDispatch = () => {
      if (remote && !authorizedByHost?.()) throw new Error("schedule-permit-unavailable");
      const access = this.deps.canDeliver(entry);
      if (this.#stopped || access === "paused") throw new Error(OWNER_WAIT_PAUSED);
      if (this.#timers.get(request.sessionId) !== timer) {
        const waiting = this.read(request.sessionId);
        throw new Error(
          waiting?.request.requestId === request.requestId
            ? OWNER_WAIT_PAUSED
            : "codex-owner-wait-cancelled",
        );
      }
      if (access !== "ready") throw new Error("codex-owner-wait-not-authorized");
      const started = this.#withTable(
        false,
        (db) =>
          db
            .prepare(
              "UPDATE codex_owner_wait SET delivering=1 WHERE session_id=? AND request_id=? AND boot_id=? AND delivering=0",
            )
            .run(request.sessionId, request.requestId, this.deps.bootId).changes === 1,
      );
      if (!started) throw new Error("codex-owner-wait-cancelled");
    };
    const result = await this.deps.deliver(entry, beforeDispatch);
    // Another authenticated action may have replaced or removed this row during preflight.
    const latest = this.read(request.sessionId);
    if (
      latest?.request.requestId !== request.requestId ||
      latest.bootId !== this.deps.bootId ||
      (!latest.delivering && this.#timers.get(request.sessionId) !== timer)
    )
      return;
    this.#clear(request.sessionId);
    if (!latest.delivering && (result.status === "retry" || result.status === "paused")) {
      this.#arm(entry, next);
      return;
    }
    const delivered = result.status === "sent";
    const reason = result.status === "refused" ? result.reason : "control-outcome-unconfirmed";
    const removed = this.#settle(
      entry,
      delivered
        ? {
            accepted: true,
            completed: false,
            status: "sent",
          }
        : {
            accepted: false,
            completed: false,
            reason,
            controlOutcome: latest.delivering ? "unknown" : "not-dispatched",
          },
    );
    if (!removed) return;
    this.deps.changed(request.sessionId);
    if (result.status === "sent" || result.status === "refused") this.deps.report(entry, result);
  }

  #settle(
    entry: OwnerWaitEntry,
    result: Record<string, unknown>,
    mode: "sent" | "cancel" | "dismiss" = "sent",
  ): boolean {
    const { request } = entry;
    return (
      this.#withTable(false, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const query =
            mode === "cancel"
              ? "DELETE FROM codex_owner_wait WHERE session_id=? AND request_id=? AND delivering=0"
              : mode === "dismiss"
                ? "DELETE FROM codex_owner_wait WHERE session_id=? AND request_id=? AND delivering=1 AND boot_id<>?"
                : "DELETE FROM codex_owner_wait WHERE session_id=? AND request_id=? AND boot_id=?";
          const key = [request.sessionId, request.requestId];
          if (mode !== "cancel") key.push(this.deps.bootId);
          const removed = db.prepare(query).run(...key).changes === 1;
          if (removed)
            db.prepare(
              "UPDATE managed_commands SET result=? WHERE request_id=? AND session_id=? AND phase='resolved'",
            ).run(
              JSON.stringify({
                ...result,
                requestId: request.requestId,
                sessionId: request.sessionId,
                runtimeBootId: this.deps.bootId,
              }),
              request.requestId,
              request.sessionId,
            );
          db.exec("COMMIT");
          return removed;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }) === true
    );
  }

  #withTable<T>(create: boolean, run: (db: DatabaseSync) => T): T | undefined {
    const db = openManagedLedger(this.deps.dataDir, create);
    if (!db) return;
    try {
      if (create)
        db.exec(
          "CREATE TABLE IF NOT EXISTS codex_owner_wait(session_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, device_id TEXT NOT NULL, boot_id TEXT NOT NULL, entry TEXT NOT NULL, delivering INTEGER NOT NULL DEFAULT 0)",
        );
      else if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_owner_wait'")
          .get()
      )
        return;
      return run(db);
    } finally {
      db.close();
    }
  }
}
