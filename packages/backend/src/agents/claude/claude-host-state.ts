import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  dispatchManagedCommandInTransaction,
  openManagedLedger,
  prepareManagedCommandInTransaction,
} from "../../managed-ledger";
import {
  controlReceiptFingerprint,
  finishControlReceiptInTransaction,
  replayControlReceiptInTransaction,
} from "../../sessions/control-receipts";
import type {
  ClaudeObservedPermissionMode,
  ClaudeRunnerOptionsSnapshot,
} from "./claude-managed-runner";
import {
  holdUsageLimit,
  usageLimitContinue,
  type UsageLimit,
  type UsageLimitHit,
} from "../../usage-limit";

export const validClaudeDeviceId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_:-]{1,256}$/.test(value);
export type ClaudeSettings = {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: "default" | "plan" | "acceptEdits";
};
export type ClaudeGoalReport = {
  stepId: string;
  reportId: string;
  outcome: "continue" | "complete" | "blocked";
  summary: string;
  evidence: string[];
  remainingWork: string[];
};
export type ClaudeHostGoal = {
  id: string;
  generation: string;
  objective: string;
  status: "active" | "paused" | "completed" | "blocked" | "budget-exhausted" | "cancelled";
  deviceId: string;
  tokenBudget: number | null;
  tokensUsed: number;
  reason: string | null;
  lastReport: ClaudeGoalReport | null;
  noProgressCount?: number;
  elapsedMs?: number;
  usageIncomplete?: boolean;
  missingUsageStepIds?: string[];
};
export type ClaudeHostWork = {
  id: string;
  requestId: string;
  deviceId: string;
  originDeviceId: string;
  originRequestId?: string;
  /**
   * `report`: what a lead's lanes did, delivered to the lead (`orchestration-service.ts`).
   * `continue`: AgentKib continuing the session after a usage limit reset (`usage-limit.ts`).
   */
  kind: "queue" | "goal" | "report" | "continue";
  goalGeneration?: string;
  goalId?: string;
  usageAccounted?: boolean;
  status: "pending" | "claimed" | "dispatched" | "succeeded" | "failed" | "cancelled" | "unknown";
  input: unknown;
  requiresAttachments: boolean;
  createdAt: string;
  dispatchedAt?: number;
  report: ClaudeGoalReport | null;
  usage: Record<string, unknown> | null;
};
export type ClaudeHostState = {
  version: 1;
  bootId: string;
  revision: number;
  title: string | null;
  settings: ClaudeSettings;
  lastConfirmedOptions?: {
    options: Omit<ClaudeRunnerOptionsSnapshot, "settingsAcknowledged">;
    selection: ClaudeSettings;
    permissionMode: ClaudeObservedPermissionMode | null;
  };
  paused: boolean;
  reason: string | null;
  goal: ClaudeHostGoal | null;
  work: ClaudeHostWork[];
  settledRequests: string[];
  /** The usage limit the last turn met, until a turn succeeds or the person sends something. */
  usageLimit?: UsageLimit | null;
};
export function canSteerClaudeQueueItem(
  item: ClaudeHostWork,
): item is ClaudeHostWork & { input: string } {
  return (
    item.kind === "queue" &&
    item.status === "pending" &&
    !item.requiresAttachments &&
    typeof item.input === "string" &&
    !item.input.split("\n").some((line) => line.startsWith("User attached file "))
  );
}

const fresh = (bootId: string): ClaudeHostState => ({
  version: 1,
  bootId,
  revision: 0,
  title: null,
  settings: {},
  paused: false,
  reason: null,
  goal: null,
  work: [],
  settledRequests: [],
});
const active = (item: ClaudeHostWork) =>
  ["pending", "claimed", "dispatched", "unknown"].includes(item.status);

/**
 * AgentKib no longer archives Claude sessions: only Claude Desktop can, in its own list. A
 * session an earlier release archived comes back as its unarchive did, paused until resumed.
 * Returns whether the state changed in a way readers must see.
 */
function retireLegacyArchive(state: ClaudeHostState & { archived?: unknown }): boolean {
  if (!Object.hasOwn(state, "archived")) return false;
  const archived = state.archived === true;
  delete state.archived;
  if (!archived) return false;
  state.paused = true;
  state.reason = "resume-confirmation-required";
  if (state.goal?.reason === "archived") state.goal.reason = "resume-confirmation-required";
  return true;
}

function recoverGoalUsage(state: ClaudeHostState): void {
  const goal = state.goal;
  if (!goal) return;
  goal.missingUsageStepIds ??= [];
  for (const work of state.work) {
    if (
      work.kind !== "goal" ||
      (work.goalGeneration !== goal.generation && work.goalId !== goal.id)
    )
      continue;
    work.goalId ??= goal.id;
    const executed =
      ["succeeded", "failed", "unknown"].includes(work.status) ||
      (work.status === "cancelled" &&
        (work.dispatchedAt !== undefined || work.goalGeneration === goal.generation));
    if (!executed) continue;
    const known = work.status !== "unknown" && claudeTurnTokens(work.usage) !== null;
    // Legacy terminal usage was already included in tokensUsed. Unknown outcomes were not.
    work.usageAccounted ??= known;
    if (!work.usageAccounted && !goal.missingUsageStepIds.includes(work.id))
      goal.missingUsageStepIds.push(work.id);
  }
  goal.usageIncomplete = goal.usageIncomplete === true || goal.missingUsageStepIds.length > 0;
}
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
export function claudeCommandFingerprintInput(value: Record<string, unknown>): string {
  const copy = { ...value };
  delete copy.runtimeBootId;
  return stable(copy);
}

/** Claude orchestration never enters managed_sessions: that catalog belongs to Codex. */
export class ClaudeHostStateStore {
  constructor(
    readonly dataDir: string,
    readonly bootId: string,
  ) {}

  #transaction<T>(sessionId: string, fn: (state: ClaudeHostState, database: DatabaseSync) => T): T {
    const database = openManagedLedger(this.dataDir, true)!;
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS claude_host_states(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      database.exec("BEGIN IMMEDIATE");
      const row = database
        .prepare("SELECT record FROM claude_host_states WHERE session_id=?")
        .get(sessionId) as { record: string } | undefined;
      const state: ClaudeHostState = row ? JSON.parse(row.record) : fresh(this.bootId);
      if (
        state.version !== 1 ||
        !Array.isArray(state.work) ||
        !Number.isSafeInteger(state.revision)
      )
        throw new Error("invalid-Claude-host-state");
      if (retireLegacyArchive(state)) state.revision++;
      if (state.bootId !== this.bootId) {
        const unfinished = state.work.some(active) || state.goal?.status === "active";
        for (const item of state.work) {
          if (item.status === "claimed") item.status = "pending";
          if (item.status === "dispatched") item.status = "unknown";
        }
        if (unfinished) {
          if (!state.paused) {
            state.paused = true;
            state.reason = "restart-confirmation-required";
          }
          if (state.goal?.status === "active") {
            state.goal.status = "paused";
            state.goal.reason = "restart-confirmation-required";
          }
        }
        state.bootId = this.bootId;
        state.revision++;
      }
      state.settledRequests ??= [];
      recoverGoalUsage(state);
      const result = fn(state, database);
      database
        .prepare(
          "INSERT INTO claude_host_states(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record",
        )
        .run(sessionId, JSON.stringify(state));
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        /* Preserve the operation failure. */
      }
      throw error;
    } finally {
      database.close();
    }
  }

  read(sessionId: string): ClaudeHostState {
    return this.#transaction(sessionId, (state) => structuredClone(state));
  }

  /** A deleted session's queue, goal and settings go with it. */
  forget(sessionId: string): void {
    const database = openManagedLedger(this.dataDir);
    if (!database) return;
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS claude_host_states(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      database.prepare("DELETE FROM claude_host_states WHERE session_id=?").run(sessionId);
    } finally {
      database.close();
    }
  }

  /** Catalog readers must not take over another process's recovery generation. */
  peek(sessionId: string): ClaudeHostState | null {
    const database = openManagedLedger(this.dataDir);
    if (!database) return null;
    try {
      if (
        !database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='claude_host_states'",
          )
          .get()
      )
        return null;
      const row = database
        .prepare("SELECT record FROM claude_host_states WHERE session_id=?")
        .get(sessionId) as { record: string } | undefined;
      if (!row) return null;
      const state = JSON.parse(row.record) as ClaudeHostState;
      retireLegacyArchive(state);
      return state;
    } finally {
      database.close();
    }
  }

  keysWithPrefix(prefix: string): string[] {
    const database = openManagedLedger(this.dataDir);
    if (!database) return [];
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='claude_host_states'").get())
        return [];
      const rows = database
        .prepare("SELECT session_id FROM claude_host_states WHERE session_id>=? AND session_id<?")
        .all(prefix, `${prefix}\uffff`) as Array<{ session_id: string }>;
      return rows.map((row) => row.session_id);
    } finally {
      database.close();
    }
  }

  update<T>(sessionId: string, mutate: (state: ClaudeHostState) => T): T {
    return this.#transaction(sessionId, (state) => {
      const result = mutate(state);
      state.revision++;
      return result;
    });
  }

  /** Host-only mutations and their device-bound receipts commit together. */
  command(
    sessionId: string,
    value: Record<string, unknown>,
    workspaceId: string,
    mutate: (state: ClaudeHostState) => Record<string, unknown>,
    resolveDispatched = false,
    receipt?: { sessionId: string; executionMode: string },
  ): Record<string, unknown> {
    const requestId = value.requestId;
    if (typeof requestId !== "string" || !validClaudeDeviceId(value.deviceId))
      throw new Error("invalid-managed-control");
    const fingerprint = controlReceiptFingerprint(claudeCommandFingerprintInput(value));
    const receiptSessionId = receipt?.sessionId ?? sessionId;
    return this.#transaction(sessionId, (state, database) => {
      const previous = replayControlReceiptInTransaction(
        database,
        requestId,
        fingerprint,
        resolveDispatched,
      );
      if (previous !== undefined) return previous;
      const payload = mutate(state);
      state.revision++;
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: receiptSessionId,
        runtimeBootId: this.bootId,
        ...(typeof value.publicInputHash === "string"
          ? { publicInputHash: value.publicInputHash }
          : {}),
        ...payload,
      };
      finishControlReceiptInTransaction(database, {
        requestId,
        sessionId: receiptSessionId,
        fingerprint,
        result,
        deviceId: value.deviceId as string,
        evidence: {
          operation: value.operation,
          workspaceId,
          executionMode: receipt?.executionMode ?? "claude-managed",
          runtimeBootId: this.bootId,
          ...(typeof value.publicInputHash === "string"
            ? { publicInputHash: value.publicInputHash }
            : {}),
          ...(typeof value.historyInputHash === "string"
            ? { historyInputHash: value.historyInputHash }
            : {}),
        },
      });
      return result;
    });
  }

  next(sessionId: string): ClaudeHostWork | null {
    return this.#transaction(sessionId, (state) => {
      if (
        state.paused ||
        state.work.some((item) => ["claimed", "dispatched", "unknown"].includes(item.status))
      )
        return null;
      // The user's own messages first, then reports from lanes, then AgentKib's continue after a
      // usage limit, then the goal's next step.
      let item =
        state.work.find((work) => work.kind === "queue" && work.status === "pending") ??
        state.work.find((work) => work.kind === "report" && work.status === "pending") ??
        state.work.find((work) => work.kind === "continue" && work.status === "pending");
      const goal = state.goal;
      if (!item && goal?.status === "active") {
        if (goal.tokenBudget !== null && goal.usageIncomplete) {
          goal.status = "paused";
          goal.reason = "usage-unavailable";
          state.revision++;
          return null;
        }
        if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
          goal.status = "budget-exhausted";
          goal.reason = "token-budget-exhausted";
          state.revision++;
          return null;
        }
        item = state.work.find(
          (work) =>
            work.kind === "goal" &&
            work.goalGeneration === goal.generation &&
            work.status === "pending",
        );
        if (!item) {
          item = {
            id: randomUUID(),
            requestId: randomUUID(),
            deviceId: goal.deviceId,
            originDeviceId: goal.deviceId,
            kind: "goal",
            goalGeneration: goal.generation,
            goalId: goal.id,
            usageAccounted: false,
            status: "pending",
            input: goal.objective,
            requiresAttachments: false,
            createdAt: new Date().toISOString(),
            report: null,
            usage: null,
          };
          state.work.push(item);
          state.revision++;
        }
      }
      return item ? structuredClone(item) : null;
    });
  }

  /**
   * Queues a report for a lead, sent as its own turn once the lead is idle, on behalf of the
   * device that made it a lead. Reports not yet picked up are sent as one message.
   */
  addReport(sessionId: string, deviceId: string, text: string): boolean {
    if (!validClaudeDeviceId(deviceId) || !text.trim()) throw new Error("invalid-report");
    return this.#transaction(sessionId, (state) => {
      const waiting = state.work.find(
        (work) =>
          work.kind === "report" &&
          work.status === "pending" &&
          work.deviceId === deviceId &&
          typeof work.input === "string" &&
          work.input.length + text.length < 32_000,
      );
      state.revision++;
      if (waiting) {
        waiting.input = `${String(waiting.input)}\n\n${text}`;
        return true;
      }
      state.work.push({
        id: randomUUID(),
        requestId: randomUUID(),
        deviceId,
        originDeviceId: deviceId,
        kind: "report",
        status: "pending",
        input: text,
        requiresAttachments: false,
        createdAt: new Date().toISOString(),
        report: null,
        usage: null,
      });
      return false;
    });
  }

  claim(sessionId: string, itemId: string, deviceId: string): ClaudeHostWork {
    return this.update(sessionId, (state) => {
      if (
        state.paused ||
        state.work.some((item) => ["claimed", "dispatched", "unknown"].includes(item.status))
      )
        throw new Error("schedule-paused");
      const item = state.work.find((work) => work.id === itemId);
      if (!item || item.status !== "pending" || item.deviceId !== deviceId)
        throw new Error("stale-schedule-item");
      if (
        item.kind === "goal" &&
        (state.goal?.status !== "active" || state.goal.generation !== item.goalGeneration)
      )
        throw new Error("stale-goal-generation");
      if (item.kind === "goal" && state.goal?.tokenBudget !== null && state.goal?.usageIncomplete)
        throw new Error("usage-unavailable");
      const firstQueue = state.work.find(
        (work) => work.kind === "queue" && work.status === "pending",
      );
      if (firstQueue && firstQueue.id !== item.id) throw new Error("stale-queue-order");
      item.status = "claimed";
      return structuredClone(item);
    });
  }

  dispatched(sessionId: string, itemId: string): void {
    this.update(sessionId, (state) => {
      const item = state.work.find((work) => work.id === itemId);
      if (!item || item.status !== "claimed" || state.paused) throw new Error("schedule-paused");
      if (item.kind === "goal" && state.goal?.tokenBudget !== null && state.goal?.usageIncomplete)
        throw new Error("usage-unavailable");
      item.status = "dispatched";
      item.dispatchedAt = Date.now();
    });
  }

  dispatchQueueSteer(
    sessionId: string,
    queued: ClaudeHostWork,
    requestId: string,
    fingerprint: string,
    evidence: Record<string, unknown>,
  ): void {
    this.#transaction(sessionId, (state, database) => {
      const item = state.work.find((work) => work.id === queued.id);
      if (
        !item ||
        !canSteerClaudeQueueItem(item) ||
        item.deviceId !== queued.deviceId ||
        item.originRequestId !== queued.originRequestId ||
        item.input !== queued.input
      )
        throw new Error("queue-item-unavailable");
      if (replayControlReceiptInTransaction(database, requestId, fingerprint, false))
        throw new Error("control-outcome-unconfirmed");
      prepareManagedCommandInTransaction(
        database,
        requestId,
        sessionId,
        fingerprint,
        item.deviceId,
        evidence,
      );
      dispatchManagedCommandInTransaction(database, requestId);
      // As soon as the native write may take effect, the scheduled copy must never run.
      // The steer receipt alone tracks the native outcome, including an interrupted write.
      item.status = "cancelled";
      item.input = "";
      if (item.originRequestId) state.settledRequests.push(item.originRequestId);
      state.revision++;
    });
  }

  releaseClaim(sessionId: string, itemId: string): void {
    this.update(sessionId, (state) => {
      const item = state.work.find((work) => work.id === itemId);
      if (item?.status === "claimed") item.status = "pending";
    });
  }

  pause(sessionId: string, reason: string): void {
    this.update(sessionId, (state) => {
      state.paused = true;
      state.reason = reason;
      for (const item of state.work) if (item.status === "claimed") item.status = "pending";
      if (state.goal?.status === "active") {
        state.goal.status = "paused";
        state.goal.reason = reason;
      }
    });
  }

  /** Prevent the scheduler from using the gap between interrupting the turn and closing the host. */
  pauseQueueForQuit(sessionId: string): boolean {
    return this.#transaction(sessionId, (state) => {
      if (state.paused) return false;
      if (state.work.some(active) || state.goal?.status === "active") {
        state.paused = true;
        state.reason = "restart-confirmation-required";
        for (const item of state.work) if (item.status === "claimed") item.status = "pending";
        state.revision++;
      }
      return true;
    });
  }

  /** A confirmed quit continuation may lift the boot's pause, keeping other holds intact. */
  resumeQueueAfterQuit(sessionId: string): void {
    this.#transaction(sessionId, (state) => {
      if (
        !state.paused ||
        state.reason !== "restart-confirmation-required" ||
        state.work.some((item) => ["claimed", "dispatched", "unknown"].includes(item.status))
      )
        return;
      state.paused = false;
      state.reason = null;
      state.revision++;
    });
  }

  /**
   * Continues a session its usage limit held once the continue is due (`usage-limit.ts`): the
   * queue resumes, a goal the limit paused resumes, and when neither has anything to send,
   * AgentKib queues `text` in the name of the device whose turn met the limit. Past the time by
   * more than the grace, the person continues instead.
   */
  continueAfterLimit(
    sessionId: string,
    text: string,
    now = Date.now(),
  ): "continued" | "stale" | "wait" | "never" {
    return this.#transaction(sessionId, (state) => {
      const limit = state.usageLimit;
      if (!limit) return "never";
      const due = usageLimitContinue(limit, state.bootId, now);
      if (due === "wait" || due === "never") return due;
      if (!state.paused || state.reason !== "usage-limit") return "never";
      if (due === "stale") {
        state.usageLimit = { ...limit, continueAt: null, manual: "stale" };
        state.revision++;
        return "stale";
      }
      state.paused = false;
      state.reason = null;
      const goal = state.goal;
      const goalResumes = goal?.status === "paused" && goal.reason === "usage-limit";
      if (goalResumes) {
        goal.status = "active";
        goal.reason = null;
      }
      const waiting = state.work.some(
        (work) => (work.kind === "queue" || work.kind === "report") && work.status === "pending",
      );
      if (!waiting && !goalResumes)
        state.work.push({
          id: randomUUID(),
          requestId: randomUUID(),
          deviceId: limit.deviceId,
          originDeviceId: limit.deviceId,
          kind: "continue",
          status: "pending",
          input: text,
          requiresAttachments: false,
          createdAt: new Date(now).toISOString(),
          report: null,
          usage: null,
        });
      state.usageLimit = { ...limit, continueAt: null, autoContinues: limit.autoContinues + 1 };
      state.revision++;
      return "continued";
    });
  }

  /**
   * The person sent a message: it takes over from the continue AgentKib armed, as typing does
   * in Claude Code, and the queue the limit held runs again after it.
   */
  personSent(sessionId: string): void {
    this.#transaction(sessionId, (state) => {
      if (!state.usageLimit) return;
      state.usageLimit = null;
      if (state.paused && state.reason === "usage-limit") {
        state.paused = false;
        state.reason = null;
      }
      state.revision++;
    });
  }

  report(sessionId: string, itemId: string, report: ClaudeGoalReport): void {
    this.update(sessionId, (state) => {
      const item = state.work.find((work) => work.id === itemId);
      if (
        state.paused ||
        state.goal?.status !== "active" ||
        !item ||
        item.kind !== "goal" ||
        item.status !== "dispatched" ||
        item.id !== report.stepId ||
        item.goalGeneration !== state.goal?.generation
      )
        throw new Error("stale-goal-report");
      if (
        !report.summary ||
        !Array.isArray(report.evidence) ||
        !Array.isArray(report.remainingWork) ||
        !["continue", "complete", "blocked"].includes(report.outcome) ||
        (report.outcome === "complete"
          ? !report.evidence.length || report.remainingWork.length !== 0
          : !report.remainingWork.length)
      )
        throw new Error("invalid-goal-report");
      if (item.report && stable(item.report) !== stable(report))
        throw new Error("goal-report-conflict");
      item.report = structuredClone(report);
    });
  }

  complete(
    sessionId: string,
    requestId: string,
    result: {
      success: boolean;
      usage: Record<string, unknown> | null;
      cancelled?: boolean;
      unknown?: boolean;
      /** The turn met the account's usage limit; `deviceId` sent it. */
      usageLimit?: UsageLimitHit | null;
      deviceId?: string | null;
      /** Whether to continue after the reset, as chosen for this computer. */
      autoContinue?: boolean;
    },
  ): void {
    this.#transaction(sessionId, (state) => {
      const item = state.work.find((work) => work.requestId === requestId);
      // The person's own messages are no work items, so a limit they meet is held here.
      const limited = !result.unknown && !result.success && !!result.usageLimit;
      if (limited) {
        state.usageLimit = holdUsageLimit("claude-code", result.usageLimit!, {
          deviceId: item?.deviceId ?? result.deviceId ?? state.usageLimit?.deviceId ?? "",
          bootId: state.bootId,
          // Work AgentKib sent by itself (a continue, a report, a goal step) counts toward the
          // three in a row; the person's own message starts again from zero.
          previous: item && item.kind !== "queue" ? state.usageLimit : null,
          autoContinue: result.autoContinue,
        });
        // Nothing queued goes out into the limit; the scheduler resumes at the continue time.
        state.paused = true;
        state.reason = "usage-limit";
        if (state.goal?.status === "active") {
          state.goal.status = "paused";
          state.goal.reason = "usage-limit";
        }
        state.revision++;
      } else if (result.success && state.usageLimit) {
        state.usageLimit = null;
        state.revision++;
      }
      if (!item) return;
      const goal = state.goal;
      const belongsToGoal =
        item.kind === "goal" &&
        goal &&
        (item.goalId === goal.id ||
          item.goalGeneration === goal.generation ||
          goal.missingUsageStepIds?.includes(item.id));
      const used = result.unknown ? null : claudeTurnTokens(result.usage);
      const accountUsage = () => {
        if (!belongsToGoal || !goal || item.usageAccounted) return;
        goal.missingUsageStepIds ??= [];
        if (used === null) {
          if (!goal.missingUsageStepIds.includes(item.id)) goal.missingUsageStepIds.push(item.id);
          goal.usageIncomplete = true;
        } else {
          const trackedGap = goal.missingUsageStepIds.includes(item.id);
          goal.tokensUsed += used;
          item.usageAccounted = true;
          goal.missingUsageStepIds = goal.missingUsageStepIds.filter(
            (stepId) => stepId !== item.id,
          );
          if (trackedGap) goal.usageIncomplete = goal.missingUsageStepIds.length > 0;
        }
      };
      if (!["dispatched", "unknown"].includes(item.status)) {
        // A later native usage record may repair accounting; never replay the turn or its outcome.
        if (
          !belongsToGoal ||
          used === null ||
          item.usageAccounted ||
          !goal?.missingUsageStepIds?.includes(item.id)
        )
          return;
        item.usage = result.usage;
        accountUsage();
        if (!goal.usageIncomplete && goal.reason === "usage-unavailable")
          goal.reason = "usage-reconciled-requires-resume";
        state.revision++;
        return;
      }
      item.status = result.unknown
        ? "unknown"
        : result.cancelled
          ? "cancelled"
          : result.success
            ? "succeeded"
            : "failed";
      item.usage = result.usage;
      if (!result.unknown) item.input = "";
      if (
        !result.unknown &&
        item.originRequestId &&
        !state.settledRequests.includes(item.originRequestId)
      )
        state.settledRequests.push(item.originRequestId);
      state.revision++;
      if ((result.unknown || !result.success) && !limited) {
        state.paused = true;
        state.reason = result.unknown
          ? "control-outcome-unconfirmed"
          : result.cancelled
            ? "cancelled"
            : "turn-failed";
      }
      if (!belongsToGoal || !goal) return;
      accountUsage();
      if (!result.unknown && item.dispatchedAt !== undefined)
        goal.elapsedMs = (goal.elapsedMs ?? 0) + Math.max(0, Date.now() - item.dispatchedAt);
      if (goal.status !== "active" && !result.unknown && result.success) {
        if (item.report) goal.lastReport = item.report;
        return;
      }
      if (result.unknown || !result.success) {
        goal.status = "paused";
        goal.reason = limited
          ? "usage-limit"
          : result.unknown
            ? "control-outcome-unconfirmed"
            : result.cancelled
              ? "cancelled"
              : "turn-failed";
      } else if (goal.tokenBudget !== null && goal.usageIncomplete) {
        goal.status = "paused";
        goal.reason = "usage-unavailable";
      } else if (!item.report) {
        goal.noProgressCount = (goal.noProgressCount ?? 0) + 1;
        goal.status = goal.noProgressCount >= 3 ? "blocked" : "paused";
        goal.reason = goal.noProgressCount >= 3 ? "no-progress" : "report-required";
      } else {
        const progressed =
          item.report.outcome === "complete" ||
          item.report.evidence.some((evidence) => !goal.lastReport?.evidence.includes(evidence));
        goal.noProgressCount = progressed ? 0 : (goal.noProgressCount ?? 0) + 1;
        goal.lastReport = item.report;
        goal.status =
          item.report.outcome === "complete"
            ? "completed"
            : item.report.outcome === "blocked" || goal.noProgressCount >= 3
              ? "blocked"
              : state.paused
                ? "paused"
                : "active";
        goal.reason =
          item.report.outcome === "blocked"
            ? item.report.summary
            : goal.noProgressCount >= 3
              ? "no-progress"
              : null;
      }
      if (
        goal.status === "active" &&
        goal.tokenBudget !== null &&
        goal.tokensUsed >= goal.tokenBudget
      ) {
        goal.status = "budget-exhausted";
        goal.reason = "token-budget-exhausted";
      }
      // Bound retained terminal work without dropping unresolved execution evidence.
      if (state.work.length > 200)
        state.work = state.work
          .filter((work) => active(work) || goal.missingUsageStepIds?.includes(work.id))
          .concat(
            state.work
              .filter((work) => !active(work) && !goal.missingUsageStepIds?.includes(work.id))
              .slice(-100),
          );
    });
  }
}

/** Native result usage is aggregate consumption, unlike the live context occupancy report. */
export function claudeTurnTokens(usage: Record<string, unknown> | null): number | null {
  if (
    !usage ||
    !Number.isSafeInteger(usage.input_tokens) ||
    !Number.isSafeInteger(usage.output_tokens)
  )
    return null;
  let total = 0;
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ]) {
    const value = usage[key] ?? 0;
    if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
    total += Number(value);
  }
  return Number.isSafeInteger(total) ? total : null;
}
