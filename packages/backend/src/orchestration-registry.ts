import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { REMOTE_ERROR_CODES, PROJECT_AGENT_MAX_WORKERS } from "@agentkib/runtime-protocol";
import { beginManagedLedgerWrite, openManagedLedger } from "./managed-ledger";
import type { ReportDelivery, ReportFailure } from "./report-delivery";

/**
 * Which managed sessions direct which (the "lead" and its "lanes"), and what the lead may do.
 * One row per lead in the managed-execution ledger, beside the Claude host states that deliver
 * its reports. A lead is a Claude Code or Codex session AgentKib runs; its lanes are Codex or
 * DeepSeek Harness sessions AgentKib runs. Nothing here starts a turn: the service checks this
 * record before every lane operation and every report it delivers.
 */

/** Codex permission presets a lead may choose for a lane; full access is never offered. */
export const LANE_POLICIES = ["workspace-write-on-request", "workspace-write-auto-review"] as const;
export type LanePolicy = (typeof LANE_POLICIES)[number];

/**
 * Approvals a lead may decide for its lanes, when the person allows it: a file change, or a
 * command run outside the sandbox. Only a plain approval qualifies (accept once or decline);
 * one asking for network access, more permissions or a policy change always goes to the person.
 */
export const LEAD_APPROVALS = ["file-change", "command"] as const;
export type LeadApproval = (typeof LEAD_APPROVALS)[number];

export const LEAD_DEFAULTS = Object.freeze({
  maxLanes: PROJECT_AGENT_MAX_WORKERS,
  maxAutoTurns: 25,
  stallMinutes: 10,
});
const MAX_RECORDS = 200;
const MAX_REPORTED_TURNS = 64;
const MAX_PENDING_REPORTS = 32;
const WORKER_RESTART_WINDOW_MS = 60 * 60_000;
const MAX_WORKER_RESTARTS = 3;

export type LeadScope = {
  /** Workspaces new lanes may be created in; the lead's own one by default. */
  workspaceIds: string[];
  /** Codex permission presets a lane may be created with. */
  policies: LanePolicy[];
  maxLanes: number;
  /** Turns the lead may be started in a row without the user speaking (reports and its own). */
  maxAutoTurns: number;
  /** Minutes a running Worker may go without progress before it is reported as stalled. */
  stallMinutes?: number;
  /** Approvals the lead may decide for its lanes; none when absent, as in earlier records. */
  approvals?: LeadApproval[];
  /** Whether the lead may answer its lanes' question cards; no when absent. */
  answers?: boolean;
};

/** A record from before per-Worker agents has no agent field and represents Codex. */
export const LANE_AGENTS = [
  "codex",
  "deepseek-harness",
  "claude-code",
  "devin",
  "antigravity",
] as const;
export type LaneAgent = (typeof LANE_AGENTS)[number];

export function isLaneAgent(value: unknown): value is LaneAgent {
  return (LANE_AGENTS as readonly unknown[]).includes(value);
}

export type Lane = {
  id: string;
  name: string;
  /** The session AgentKib runs for it. */
  sessionId: string;
  /** Absent in records from before DeepSeek Harness lanes: those are Codex. */
  agent?: LaneAgent;
  workspaceId: string;
  /**
   * The Codex preset it was created with. Null when an existing session was taken over (it keeps
   * its own preset) and for a DeepSeek Harness lane, which starts in DSH's own workspace-write
   * preset whatever the lead's Codex presets are.
   */
  policyId: LanePolicy | null;
  /** What the lead last asked it to do, as the lead titled it. */
  title: string | null;
  createdAt: string;
  /** Turns already reported, newest last, so that a turn is reported once. */
  reportedTurns: string[];
  lastReport: { at: string; preview: string } | null;
};

export type LeadRecord = {
  at: string;
  kind:
    | "open"
    | "send"
    | "stop"
    | "restart"
    | "approve"
    | "answer"
    | "report"
    | "report-delivery"
    | "pause"
    | "resume"
    /** A worker removed by the user or when its session is deleted. */
    | "close"
    /** The person changed the lead's scope. */
    | "update";
  laneId: string | null;
  requestId: string | null;
  outcome: string;
  reportFailure?: ReportFailure;
};

export type QuitReport = {
  laneId: string;
  turnId: string;
  text: string;
  /** The provider may have accepted the report. Do not retry automatically. */
  attempted?: true;
};

export type Lead = {
  version: 1;
  /** The Claude Code session that directs the lanes. */
  sessionId: string;
  /** The device that made it a lead; its authorization governs every lane operation. */
  deviceId: string;
  bootId: string;
  createdAt: string;
  revision: number;
  paused: boolean;
  reason: string | null;
  scope: LeadScope;
  autoTurns: number;
  lanes: Lane[];
  records: LeadRecord[];
  /** Reports held while delegation is paused, sent together when it resumes. */
  pendingReports: string[];
  /** Legacy same-version flag used to recognize a confirmed unattempted delivery. */
  reportRetryable?: boolean;
  /** A recovery batch may have reached the provider if the host stopped before its reply. */
  deliveringReports?: string[];
  reportDeliveries?: ReportDelivery[];
  /** Unconfirmed pre-ID deliveries, retained without replaying unkeyed native sends. */
  legacyUnconfirmedReports?: string[];
  /** Quit status survives a restart and has its own delivery rules. */
  pendingQuitReports?: QuitReport[];
};

type NewLead = Omit<
  Lead,
  "version" | "bootId" | "revision" | "records" | "lanes" | "autoTurns" | "pendingReports"
>;

const TABLE =
  "CREATE TABLE IF NOT EXISTS orchestration_leads(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)";
const RESTART_TABLE =
  "CREATE TABLE IF NOT EXISTS orchestration_worker_restarts(" +
  "request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id TEXT NOT NULL, " +
  "attempted_at INTEGER NOT NULL, pending INTEGER NOT NULL);" +
  "CREATE INDEX IF NOT EXISTS orchestration_worker_restarts_session " +
  "ON orchestration_worker_restarts(session_id, attempted_at)";

type WorkerRestartWindow = {
  retryAt: number | null;
  pending: { requestId: string; deviceId: string } | null;
};

export class LeadRegistry {
  constructor(
    readonly dataDir: string,
    readonly bootId: string,
  ) {}

  #open() {
    const database = openManagedLedger(this.dataDir, true)!;
    database.exec(TABLE);
    return database;
  }

  /**
   * Reads and writes one lead atomically, including any migration from the previous boot.
   */
  #transaction<T>(
    sessionId: string,
    fn: (
      lead: Lead | null,
      database: DatabaseSync,
      unsupportedLanes: unknown[],
    ) => { lead: Lead | null; value: T },
  ) {
    const database = this.#open();
    try {
      beginManagedLedgerWrite(database);
      const row = database
        .prepare("SELECT record FROM orchestration_leads WHERE session_id=?")
        .get(sessionId) as { record: string } | undefined;
      const stored = row ? this.#readRecord(row.record) : null;
      const { lead, value } = fn(stored?.lead ?? null, database, stored?.unsupportedLanes ?? []);
      if (lead === null) {
        if (row)
          database.prepare("DELETE FROM orchestration_leads WHERE session_id=?").run(sessionId);
      } else {
        lead.records = lead.records.slice(-MAX_RECORDS);
        lead.pendingReports ??= [];
        if (lead.reason !== "usage-limit" && !lead.reportRetryable && !lead.deliveringReports)
          lead.pendingReports = lead.pendingReports.slice(-MAX_PENDING_REPORTS);
        if (lead.pendingQuitReports && lead.pendingQuitReports.length > MAX_PENDING_REPORTS)
          lead.pendingQuitReports = lead.pendingQuitReports.slice(-MAX_PENDING_REPORTS);
        for (const lane of lead.lanes)
          lane.reportedTurns = lane.reportedTurns.slice(-MAX_REPORTED_TURNS);
        database
          .prepare(
            "INSERT INTO orchestration_leads(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record",
          )
          .run(
            sessionId,
            JSON.stringify({
              ...lead,
              lanes: [...lead.lanes, ...(stored?.unsupportedLanes ?? [])],
            }),
          );
      }
      database.exec("COMMIT");
      return value;
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

  #readRecord(record: string): { lead: Lead; unsupportedLanes: unknown[] } {
    const { lanes, ...stored } = JSON.parse(record) as Omit<Lead, "lanes"> & { lanes?: unknown };
    if (stored.version !== 1 || !Array.isArray(lanes)) throw new Error("invalid-lead-record");
    const lead: Lead = {
      ...stored,
      scope: {
        ...stored.scope,
        stallMinutes: stored.scope.stallMinutes ?? LEAD_DEFAULTS.stallMinutes,
      },
      pendingReports: stored.pendingReports ?? [],
      lanes: [],
    };
    const unsupportedLanes: unknown[] = [];
    for (const lane of lanes as unknown[]) {
      if (lane && typeof lane === "object" && !Array.isArray(lane)) {
        const agent = "agent" in lane ? lane.agent : undefined;
        if (agent === undefined || isLaneAgent(agent)) {
          lead.lanes.push(lane as Lane);
          continue;
        }
      }
      // Keep future Workers on disk so reading or updating a project cannot discard them.
      unsupportedLanes.push(lane);
    }
    this.#restarted(lead);
    migrateReportDelivery(lead);
    return { lead, unsupportedLanes };
  }

  #restarted(lead: Lead): void {
    const oldBoot = lead.bootId !== this.bootId;
    const oldRestartPause = lead.paused && lead.reason === "restart-confirmation-required";
    if (!oldBoot && !oldRestartPause) return;
    lead.bootId = this.bootId;
    if (oldRestartPause) {
      lead.paused = false;
      lead.reason = null;
      addLeadRecord(lead, "resume", null, null, "restart-confirmation-removed");
    }
    lead.revision++;
  }

  get(sessionId: string): Lead | null {
    return this.#transaction(sessionId, (lead) => ({ lead, value: lead && structuredClone(lead) }));
  }

  /** Every lead, with any restart migration projected without writing it back. */
  list(): Lead[] {
    const database = this.#open();
    try {
      return (
        database.prepare("SELECT record FROM orchestration_leads").all() as Array<{
          record: string;
        }>
      ).map((row) => this.#readRecord(row.record).lead);
    } finally {
      database.close();
    }
  }

  /** The lead a session is a lane of, if any. */
  leadOfLane(laneSessionId: string): { lead: Lead; lane: Lane } | null {
    for (const lead of this.list()) {
      const lane = lead.lanes.find((item) => item.sessionId === laneSessionId);
      if (lane) return { lead, lane };
    }
    return null;
  }

  /** Changes one lead; `fn` may return null to remove it. Throws `lead-unavailable` when absent. */
  update<T>(sessionId: string, fn: (lead: Lead) => T): T {
    return this.#transaction(sessionId, (lead) => {
      if (!lead) throw new Error(REMOTE_ERROR_CODES.leadUnavailable);
      const value = fn(lead);
      lead.revision++;
      return { lead, value };
    });
  }

  #restartWindow(database: DatabaseSync, sessionId: string, now: number): WorkerRestartWindow {
    const rows = database
      .prepare(
        "SELECT request_id,device_id,attempted_at,pending FROM orchestration_worker_restarts " +
          "WHERE session_id=? AND (attempted_at>? OR pending=1) ORDER BY attempted_at",
      )
      .all(sessionId, now - WORKER_RESTART_WINDOW_MS) as Array<{
      request_id: string;
      device_id: string;
      attempted_at: number;
      pending: number;
    }>;
    const recent = rows.filter((row) => row.attempted_at > now - WORKER_RESTART_WINDOW_MS);
    const pending = rows.find((row) => row.pending === 1);
    return {
      retryAt:
        recent.length >= MAX_WORKER_RESTARTS
          ? recent[recent.length - MAX_WORKER_RESTARTS]!.attempted_at + WORKER_RESTART_WINDOW_MS
          : null,
      pending: pending ? { requestId: pending.request_id, deviceId: pending.device_id } : null,
    };
  }

  workerRestartWindow(sessionId: string, now = Date.now()): WorkerRestartWindow {
    const database = openManagedLedger(this.dataDir);
    if (!database) return { retryAt: null, pending: null };
    try {
      if (
        !database
          .prepare("SELECT 1 FROM sqlite_master WHERE name='orchestration_worker_restarts'")
          .get()
      )
        return { retryAt: null, pending: null };
      return this.#restartWindow(database, sessionId, now);
    } finally {
      database.close();
    }
  }

  /** The Worker session keeps its budget when the person changes its assignment or host restarts. */
  reserveWorkerRestart(
    leadId: string,
    lane: Pick<Lane, "id" | "sessionId">,
    deviceId: string,
    requestId: string,
    now = Date.now(),
  ): WorkerRestartWindow {
    return this.#transaction(leadId, (lead, database) => {
      if (!lead?.lanes.some((item) => item.id === lane.id && item.sessionId === lane.sessionId))
        throw new Error(REMOTE_ERROR_CODES.workerUnavailable);
      if (lead.paused || lead.deviceId !== deviceId) throw new Error("delegation-paused");
      database.exec(RESTART_TABLE);
      const window = this.#restartWindow(database, lane.sessionId, now);
      if (window.pending || window.retryAt !== null) return { lead, value: window };
      database
        .prepare("DELETE FROM orchestration_worker_restarts WHERE attempted_at<=? AND pending=0")
        .run(now - WORKER_RESTART_WINDOW_MS);
      database
        .prepare(
          "INSERT INTO orchestration_worker_restarts(request_id,session_id,device_id,attempted_at,pending) VALUES(?,?,?,?,1)",
        )
        .run(requestId, lane.sessionId, deviceId, now);
      addLeadRecord(lead, "restart", lane.id, requestId, "pending");
      lead.revision++;
      return { lead, value: window };
    });
  }

  finishWorkerRestart(
    leadId: string,
    lane: Pick<Lane, "id" | "sessionId">,
    requestId: string,
    outcome: "accepted" | "not-dispatched" | "unknown",
  ): void {
    this.#transaction(leadId, (lead, database) => {
      if (outcome !== "unknown") {
        const action =
          outcome === "accepted"
            ? "UPDATE orchestration_worker_restarts SET pending=0"
            : "DELETE FROM orchestration_worker_restarts";
        database
          .prepare(`${action} WHERE request_id=? AND session_id=?`)
          .run(requestId, lane.sessionId);
      }
      const record = lead?.records.find(
        (item) => item.requestId === requestId && item.kind === "restart",
      );
      if (record && lead) {
        record.outcome = outcome;
        lead.revision++;
      }
      return { lead, value: undefined };
    });
  }

  #newLead(lead: NewLead): Lead {
    return {
      ...lead,
      version: 1,
      bootId: this.bootId,
      revision: 1,
      autoTurns: 0,
      lanes: [],
      records: [],
      pendingReports: [],
    };
  }

  #hasWorker(database: DatabaseSync, sessionId: string): boolean {
    return !!database
      .prepare(
        `SELECT 1 FROM orchestration_leads, json_each(orchestration_leads.record, '$.lanes') AS lane
         WHERE CASE WHEN lane.type = 'object' THEN json_extract(lane.value, '$.sessionId') END = ? LIMIT 1`,
      )
      .get(sessionId);
  }

  create(lead: NewLead) {
    return this.#transaction(lead.sessionId, (current, database) => {
      if (current) throw new Error(REMOTE_ERROR_CODES.leadExists);
      if (this.#hasWorker(database, lead.sessionId))
        throw new Error(REMOTE_ERROR_CODES.sessionIsAWorker);
      const created = this.#newLead(lead);
      return { lead: created, value: structuredClone(created) };
    });
  }

  /**
   * Register a batch of workers and, if needed, its lead in one write. Every path that
   * assigns a worker uses this check so a concurrent assignment cannot claim the same session.
   */
  registerWorkers(
    sessionId: string,
    workers: (lead: Lead, usedNames: ReadonlySet<string>) => Lane[],
    requestId: string | null,
    create?: () => NewLead,
  ): { designated: boolean } {
    return this.#transaction(sessionId, (current, database, unsupportedLanes) => {
      if (this.#hasWorker(database, sessionId))
        throw new Error(REMOTE_ERROR_CODES.sessionIsAWorker);
      let lead = current;
      if (!lead) {
        if (!create) throw new Error(REMOTE_ERROR_CODES.leadUnavailable);
        lead = this.#newLead(create());
      }
      const names = new Set(lead.lanes.map((lane) => lane.name));
      for (const lane of unsupportedLanes)
        if (lane && typeof lane === "object" && "name" in lane && typeof lane.name === "string")
          names.add(lane.name);
      const lanes = workers(lead, names);
      if (lead.lanes.length + unsupportedLanes.length + lanes.length > PROJECT_AGENT_MAX_WORKERS)
        throw new Error("worker-limit-reached");
      const sessions = new Set<string>();
      const hasLead = database.prepare("SELECT 1 FROM orchestration_leads WHERE session_id = ?");
      for (const lane of lanes) {
        if (lane.sessionId === sessionId || hasLead.get(lane.sessionId))
          throw new Error("session-is-a-project-agent");
        if (sessions.has(lane.sessionId) || this.#hasWorker(database, lane.sessionId))
          throw new Error(REMOTE_ERROR_CODES.sessionIsAWorker);
        if (names.has(lane.name)) throw new Error("worker-name-taken");
        sessions.add(lane.sessionId);
        names.add(lane.name);
        lead.lanes.push(lane);
        addLeadRecord(lead, "open", lane.id, requestId, "accepted");
      }
      if (current) lead.revision++;
      return { lead, value: { designated: current === null } };
    });
  }

  remove(sessionId: string): boolean {
    return this.#transaction(sessionId, (lead) => ({ lead: null, value: lead !== null }));
  }
}

export function addLeadRecord(
  lead: Lead,
  kind: LeadRecord["kind"],
  laneId: string | null,
  requestId: string | null,
  outcome: string,
  reportFailure?: ReportFailure,
): void {
  lead.records.push({
    at: new Date().toISOString(),
    kind,
    laneId,
    requestId,
    outcome,
    ...(reportFailure ? { reportFailure } : {}),
  });
}

function migrateReportDelivery(lead: Lead): void {
  lead.pendingReports ??= [];
  const uncertain = lead.deliveringReports ?? [];
  delete lead.deliveringReports;
  if (lead.reason === "report-undelivered" && !lead.reportRetryable)
    uncertain.push(...lead.pendingReports.splice(0));
  for (const report of lead.pendingQuitReports ?? []) {
    if (report.attempted) uncertain.push(report.text);
    else
      (lead.reportDeliveries ??= []).push({
        reportId: randomUUID(),
        text: report.text,
        quitLaneId: report.laneId,
      });
  }
  delete lead.pendingQuitReports;
  if (uncertain.length) {
    (lead.legacyUnconfirmedReports ??= []).push(...uncertain);
    addLeadRecord(lead, "report-delivery", null, null, "retained", {
      phase: "confirmation",
      code: "legacy-outcome-unknown",
    });
  }
  if (lead.reason === "report-undelivered") {
    lead.paused = false;
    lead.reason = null;
    addLeadRecord(lead, "resume", null, null, "report-retry-enabled");
  }
  if (!lead.paused && lead.pendingReports.length) {
    for (const text of lead.pendingReports.splice(0))
      (lead.reportDeliveries ??= []).push({ reportId: randomUUID(), text });
  }
  delete lead.reportRetryable;
}
