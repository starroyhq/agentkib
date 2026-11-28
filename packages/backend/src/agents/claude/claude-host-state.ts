import { randomUUID } from "node:crypto";
import { REMOTE_CONTROL_OUTCOMES, type ClaudePermissionMode } from "@agentkib/runtime-protocol";
import type { DatabaseSync } from "node:sqlite";
import {
  dispatchManagedCommandInTransaction,
  beginManagedLedgerWrite,
  openManagedLedger,
  prepareManagedCommandInTransaction,
  withManagedLedgerReader,
} from "../../managed-ledger";
import {
  admitControlReceipt,
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
import { bindWorkerReportMessageInTransaction } from "../../worker-report-ledger";
import { z } from "zod";

const localTitleRequest = z.strictObject({
  operation: z.literal("rename"),
  sessionId: z.string().min(1).max(256),
  requestId: z.uuid(),
  deviceId: z.string().regex(/^[A-Za-z0-9_:-]{1,256}$/),
  runtimeBootId: z.string(),
  expectedRevision: z.number().int().nonnegative(),
  experimentalEnabled: z.literal(true),
  publicInputHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  name: z.unknown(),
});

export type ClaudeLocalTitleScope = {
  sessionId: string;
  workspaceId: string;
  revision: number;
  executionMode: "claude-follower" | "claude-managed";
};

export function claudeSessionTitle(name: unknown): string {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    Buffer.byteLength(name) > 512 ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("invalid-session-name");
  return name;
}

function isClaudeCatalogRow(row: unknown): row is Record<string, unknown> & { id: string } {
  return (
    !!row &&
    typeof row === "object" &&
    "id" in row &&
    typeof row.id === "string" &&
    "agent" in row &&
    row.agent === "claude-code"
  );
}

export const validClaudeDeviceId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_:-]{1,256}$/.test(value);
export type ClaudeSettings = {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: ClaudePermissionMode;
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
  /** Delivery IDs in the order in which their text was appended to this report. */
  workerReportIds?: readonly string[];
};
type TerminalReportImport = {
  deviceId: string;
  length: number;
  fingerprint: string;
  mergedIds: readonly string[];
};
export type ClaudeHostState = {
  version: 1;
  bootId: string;
  revision: number;
  title: string | null;
  /** An AgentKib-only title, distinct from the title synced to Claude Code. */
  localTitle?: string;
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
  /** Bridge receipts outlive the work history because acknowledging the source is a separate write. */
  terminalReportImports?: Record<string, TerminalReportImport>;
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

function enqueueLeadReport(
  state: ClaudeHostState,
  database: DatabaseSync,
  sessionId: string,
  deviceId: string,
  text: string,
  reportIds: readonly string[],
  sourceId?: string,
) {
  // Appending to an earlier batch would let this report overtake the tail.
  const waiting = state.work.filter((work) => work.kind === "report" && active(work)).at(-1);
  if (
    waiting?.status === "pending" &&
    waiting.deviceId === deviceId &&
    typeof waiting.input === "string" &&
    waiting.input.length + 2 + text.length < 32_000
  ) {
    const input = `${waiting.input}\n\n${text}`;
    waiting.input = input;
    // Keep all combined text visible when either side has no recorded delivery IDs.
    if (waiting.workerReportIds?.length && reportIds.length) {
      waiting.workerReportIds = [...waiting.workerReportIds, ...reportIds];
      bindWorkerReportMessageInTransaction(
        database,
        sessionId,
        { type: "native-message", id: waiting.requestId },
        waiting.workerReportIds,
        input,
      );
    } else {
      delete waiting.workerReportIds;
    }
    return true;
  }
  const requestId = randomUUID();
  state.work.push({
    id: sourceId ?? randomUUID(),
    requestId,
    deviceId,
    originDeviceId: deviceId,
    kind: "report",
    status: "pending",
    input: text,
    requiresAttachments: false,
    createdAt: new Date().toISOString(),
    report: null,
    usage: null,
    ...(reportIds.length ? { workerReportIds: [...reportIds] } : {}),
  });
  bindWorkerReportMessageInTransaction(
    database,
    sessionId,
    { type: "native-message", id: requestId },
    reportIds,
    text,
  );
  return false;
}

function terminalReportReplay(
  state: ClaudeHostState,
  deviceId: string,
  id: string,
): boolean | undefined {
  const imports = state.terminalReportImports ?? {};
  const primary = Object.hasOwn(imports, id) ? imports[id] : undefined;
  if (primary) {
    // Replay the enqueue result the bridge gave the orchestrator, even if several
    // bridge batches were combined into one managed turn.
    if (primary.deviceId !== deviceId) throw new Error("request-id-reused-with-different-input");
    return false;
  }
  const merged = Object.values(imports).find(({ mergedIds }) => mergedIds.includes(id));
  if (merged) {
    if (merged.deviceId !== deviceId) throw new Error("request-id-reused-with-different-input");
    return true;
  }
  // Older handovers used the primary bridge report ID as both work and request ID.
  const legacy = state.work.find(
    (work) => work.kind === "report" && work.id === id && work.requestId === id,
  );
  if (legacy) {
    if (legacy.deviceId !== deviceId) throw new Error("request-id-reused-with-different-input");
    return false;
  }
}

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

  renameLocalTitle(value: Record<string, unknown>, scope: ClaudeLocalTitleScope) {
    const input = localTitleRequest.safeParse(value);
    if (
      !input.success ||
      value.sessionId !== scope.sessionId ||
      value.runtimeBootId !== this.bootId
    )
      throw new Error("invalid-managed-control");
    const name = claudeSessionTitle(value.name);
    const prior = admitControlReceipt(
      this.dataDir,
      input.data.requestId,
      claudeCommandFingerprintInput(value),
    );
    if (prior.previous) return { receipt: prior.previous, changed: false };
    if (value.expectedRevision !== scope.revision) throw new Error("stale-Claude-revision");
    const receipt = this.command(
      scope.sessionId,
      value,
      scope.workspaceId,
      (state) => {
        state.localTitle = name;
        return { name };
      },
      false,
      scope,
    );
    return { receipt, changed: true };
  }

  projectLocalTitles(rows: unknown[]): unknown[] {
    const sessions = rows.filter(isClaudeCatalogRow);
    if (!sessions.length) return rows;
    return (
      withManagedLedgerReader(this.dataDir, (database) => {
        if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='claude_host_states'").get())
          return rows;
        const titles = database
          .prepare(`
        SELECT session_id, CASE WHEN json_valid(record) THEN json_extract(record, '$.localTitle') END AS title
        FROM claude_host_states WHERE session_id IN (SELECT value FROM json_each(?))
      `)
          .all(JSON.stringify(sessions.map(({ id }) => id)));
        const byId = new Map(titles.map(({ session_id, title }) => [session_id, title]));
        return rows.map((row) => {
          if (!isClaudeCatalogRow(row)) return row;
          const title = byId.get(row.id);
          return typeof title === "string" && title
            ? { ...row, title, notificationTitle: title }
            : row;
        });
      }) ?? rows
    );
  }

  #transaction<T>(
    sessionId: string,
    fn: (state: ClaudeHostState, database: DatabaseSync) => T,
    writeState?: (result: T) => boolean,
  ): T {
    const database = openManagedLedger(this.dataDir, true)!;
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS claude_host_states(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
      );
      beginManagedLedgerWrite(database);
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
      if (!writeState || writeState(result))
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

  update<T>(sessionId: string, mutate: (state: ClaudeHostState, database: DatabaseSync) => T): T {
    return this.#transaction(sessionId, (state, database) => {
      const result = mutate(state, database);
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
    const apply = (state: ClaudeHostState, database: DatabaseSync) => {
      const previous = replayControlReceiptInTransaction(
        database,
        requestId,
        fingerprint,
        resolveDispatched,
      );
      if (previous !== undefined) return previous;
      const payload = mutate(state);
      if (payload.controlOutcome !== REMOTE_CONTROL_OUTCOMES.notDispatched) state.revision++;
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
    };
    // A pre-dispatch refusal commits only the device-bound receipt.
    return this.#transaction(
      sessionId,
      apply,
      (result) => result.controlOutcome !== REMOTE_CONTROL_OUTCOMES.notDispatched,
    );
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
  addReport(sessionId: string, deviceId: string, text: string, reportId?: string): boolean {
    if (!validClaudeDeviceId(deviceId) || !text.trim()) throw new Error("invalid-report");
    const fingerprint = reportId
      ? controlReceiptFingerprint(
          JSON.stringify(["orchestration-report", sessionId, deviceId, text]),
        )
      : undefined;
    return this.#transaction(sessionId, (state, database) => {
      if (reportId && fingerprint) {
        const imported = terminalReportReplay(state, deviceId, reportId);
        if (imported !== undefined) return imported;
        const previous = replayControlReceiptInTransaction(database, reportId, fingerprint, false);
        if (previous) return previous.merged === true;
      }
      state.revision++;
      const merged = enqueueLeadReport(
        state,
        database,
        sessionId,
        deviceId,
        text,
        reportId ? [reportId] : [],
      );
      if (reportId && fingerprint)
        finishControlReceiptInTransaction(database, {
          requestId: reportId,
          sessionId,
          deviceId,
          fingerprint,
          evidence: { operation: "orchestration-report", executionMode: "claude-managed" },
          result: { accepted: true, controlOutcome: "accepted", merged },
        });
      return merged;
    });
  }

  importTerminalHandover(
    sessionId: string,
    settings: ClaudeSettings,
    reports: readonly { id: string; text: string; mergedIds?: readonly string[] }[],
    reportDeviceId: string | undefined,
    continuation?: { id: string; deviceId: string; text: string },
  ): void {
    if (reports.length && !validClaudeDeviceId(reportDeviceId))
      throw new Error("claude-terminal-report-owner-unavailable");
    return this.update(sessionId, (state, database) => {
      state.settings = settings;
      if (state.reason === "released") {
        state.paused = false;
        state.reason = null;
      }
      if (continuation && !state.work.some((work) => work.id === continuation.id)) {
        state.work.push({
          id: continuation.id,
          requestId: continuation.id,
          deviceId: continuation.deviceId,
          originDeviceId: continuation.deviceId,
          kind: "queue",
          status: "pending",
          input: continuation.text,
          requiresAttachments: false,
          createdAt: new Date().toISOString(),
          report: null,
          usage: null,
        });
      }
      if (reportDeviceId && reports.length) {
        const imports = (state.terminalReportImports ??= Object.create(null));
        for (const { id, text, mergedIds = [] } of reports) {
          const previous = Object.hasOwn(imports, id) ? imports[id] : undefined;
          const replayed = terminalReportReplay(state, reportDeviceId, id);
          if (previous) {
            if (
              text.length < previous.length ||
              controlReceiptFingerprint(text.slice(0, previous.length)) !== previous.fingerprint ||
              (text.length > previous.length && !text.startsWith("\n\n", previous.length))
            )
              throw new Error("claude-terminal-report-unconfirmed");
            // If a process stopped between the two writes, the bridge may still have
            // appended to this batch. Import only the part that was not persisted.
            if (text.length > previous.length) {
              const importedIds = new Set(previous.mergedIds);
              enqueueLeadReport(
                state,
                database,
                sessionId,
                reportDeviceId,
                text.slice(previous.length + 2),
                mergedIds.filter((mergedId) => !importedIds.has(mergedId)),
              );
            }
          } else if (replayed === undefined) {
            enqueueLeadReport(
              state,
              database,
              sessionId,
              reportDeviceId,
              text,
              [id, ...mergedIds],
              id,
            );
          }
          imports[id] = {
            deviceId: reportDeviceId,
            length: text.length,
            fingerprint: controlReceiptFingerprint(text),
            mergedIds: [...new Set([...(previous?.mergedIds ?? []), ...mergedIds])],
          };
        }
      }
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
  resumeQueueAfterQuit(sessionId: string): boolean {
    return this.#transaction(sessionId, (state) => {
      if (
        !state.paused ||
        state.reason !== "restart-confirmation-required" ||
        state.work.some((item) => ["claimed", "dispatched", "unknown"].includes(item.status))
      )
        return false;
      state.paused = false;
      state.reason = null;
      state.revision++;
      return true;
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
