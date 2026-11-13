import { openManagedLedger } from "./managed-ledger";

/**
 * Which managed sessions direct which (the "lead" and its "lanes"), and what the lead may do.
 * One row per lead in the managed-execution ledger, beside the Claude host states that deliver
 * its reports. A lead is a Claude Code session AgentKib runs; its lanes are Codex sessions
 * AgentKib runs. Nothing here starts a turn: the service checks this record before every lane
 * operation and every report it delivers.
 */

/** Codex permission presets a lead may choose for a lane; full access is never offered. */
export const LANE_POLICIES = ["workspace-write-on-request", "workspace-write-auto-review"] as const;
export type LanePolicy = (typeof LANE_POLICIES)[number];

export const LEAD_DEFAULTS = Object.freeze({ maxLanes: 4, maxAutoTurns: 25 });
const MAX_RECORDS = 200;
const MAX_REPORTED_TURNS = 64;
const MAX_PENDING_REPORTS = 32;

export type LeadScope = {
  /** Workspaces new lanes may be created in; the lead's own one by default. */
  workspaceIds: string[];
  /** Codex permission presets a lane may be created with. */
  policies: LanePolicy[];
  maxLanes: number;
  /** Turns the lead may be started in a row without the user speaking (reports and its own). */
  maxAutoTurns: number;
};

export type Lane = {
  id: string;
  name: string;
  /** The Codex session AgentKib runs for it. */
  sessionId: string;
  workspaceId: string;
  /** Null when an existing session was taken over: it keeps its own preset. */
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
  kind: "open" | "send" | "stop" | "report" | "pause" | "resume";
  laneId: string | null;
  requestId: string | null;
  outcome: string;
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
};

const TABLE =
  "CREATE TABLE IF NOT EXISTS orchestration_leads(session_id TEXT PRIMARY KEY, record TEXT NOT NULL)";

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
   * Reads and writes one lead atomically. A lead first read after a restart is paused until
   * the user resumes it, as automatic Claude turns are.
   */
  #transaction<T>(sessionId: string, fn: (lead: Lead | null) => { lead: Lead | null; value: T }) {
    const database = this.#open();
    try {
      database.exec("BEGIN IMMEDIATE");
      const row = database
        .prepare("SELECT record FROM orchestration_leads WHERE session_id=?")
        .get(sessionId) as { record: string } | undefined;
      const current = row ? this.#restarted(JSON.parse(row.record) as Lead) : null;
      const { lead, value } = fn(current);
      if (lead === null) {
        if (row)
          database.prepare("DELETE FROM orchestration_leads WHERE session_id=?").run(sessionId);
      } else {
        lead.records = lead.records.slice(-MAX_RECORDS);
        lead.pendingReports = (lead.pendingReports ?? []).slice(-MAX_PENDING_REPORTS);
        for (const lane of lead.lanes)
          lane.reportedTurns = lane.reportedTurns.slice(-MAX_REPORTED_TURNS);
        database
          .prepare(
            "INSERT INTO orchestration_leads(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record",
          )
          .run(sessionId, JSON.stringify(lead));
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

  #restarted(lead: Lead): Lead {
    if (lead.version !== 1 || !Array.isArray(lead.lanes)) throw new Error("invalid-lead-record");
    if (lead.bootId === this.bootId) return lead;
    lead.bootId = this.bootId;
    if (!lead.paused) {
      lead.paused = true;
      lead.reason = "restart-confirmation-required";
    }
    lead.revision++;
    return lead;
  }

  get(sessionId: string): Lead | null {
    return this.#transaction(sessionId, (lead) => ({ lead, value: lead && structuredClone(lead) }));
  }

  /** Every lead, read without the restart pause being written back. */
  list(): Lead[] {
    const database = this.#open();
    try {
      return (
        database.prepare("SELECT record FROM orchestration_leads").all() as Array<{
          record: string;
        }>
      ).map((row) => this.#restarted(JSON.parse(row.record) as Lead));
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
      if (!lead) throw new Error("lead-unavailable");
      const value = fn(lead);
      lead.revision++;
      return { lead, value };
    });
  }

  create(
    lead: Omit<
      Lead,
      "version" | "bootId" | "revision" | "records" | "lanes" | "autoTurns" | "pendingReports"
    >,
  ) {
    return this.#transaction(lead.sessionId, (current) => {
      if (current) throw new Error("lead-exists");
      const created: Lead = {
        ...lead,
        version: 1,
        bootId: this.bootId,
        revision: 1,
        autoTurns: 0,
        lanes: [],
        records: [],
        pendingReports: [],
      };
      return { lead: created, value: structuredClone(created) };
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
): void {
  lead.records.push({ at: new Date().toISOString(), kind, laneId, requestId, outcome });
}
