import type { Lane, Lead } from "./orchestration-registry";
import { isObject, type WorkerLimit } from "./orchestration-worker-state";
import { waitingItems } from "./worker-report-parts";

/** A session's part in delegation, as session lists show it. */
export type SessionRole =
  | {
      role: "lead";
      workers: number;
      paused: boolean;
      reason: string | null;
      /** Reports on their way into the lead's next turn. */
      reports: number;
      reportsUnavailable?: true;
      requiresUser?: true;
      recovering?: true;
    }
  | { role: "worker"; leadId: string; name: string; requiresUser?: true };

export type WorkerNotificationKind = "completed" | "failed" | "approval" | "question";

type Assignment = { lead: Lead; lane: Lane };
type Live = Record<string, unknown>;
type Watch = {
  offline?: { reported: boolean; userOnly: boolean };
  limit?: { value: Pick<WorkerLimit, "continueAt" | "manual"> };
};

type NotificationSource = {
  leads(): Lead[];
  leadEnabled(sessionId: string): boolean;
  workerEnabled(agent: Lane["agent"]): boolean;
  inAssignedWorkspace(lane: Lane, live?: Live): boolean;
  leadReachable(sessionId: string): boolean;
  leadLimitNeedsUser(sessionId: string): boolean;
  managedLeadNeedsUser(sessionId: string): boolean | undefined;
  workerWatch(laneId: string): Watch | undefined;
  queuedReports(sessionId: string): number;
  completionReports(
    sessionId: string,
  ): readonly { laneId: string; key: string | null; text: string | null }[] | undefined;
  readWorker(sessionId: string): Promise<Live | null>;
  changed(): void;
  closed(): boolean;
};

/** Stable assignments and the transient work that determines whether to notify. */
export class OrchestrationNotifications {
  #preparing = new Map<string, Map<string, number>>();

  constructor(private readonly source: NotificationSource) {}

  /** Keep a lead busy while a Worker completion still needs a native history read. */
  async prepareReport<T>(
    leadId: string,
    laneId: string,
    needsHistory: boolean,
    prepare: () => Promise<T>,
    ready: (report: T) => void,
  ): Promise<void> {
    if (!needsHistory) {
      ready(await prepare());
      return;
    }

    const pending = this.#preparing.get(leadId) ?? new Map<string, number>();
    const started = pending.size === 0;
    pending.set(laneId, (pending.get(laneId) ?? 0) + 1);
    this.#preparing.set(leadId, pending);
    if (started) this.source.changed();

    let last = false;
    try {
      let report: T;
      try {
        report = await prepare();
      } finally {
        last = this.#finishPreparation(leadId, laneId, pending);
      }
      ready(report);
    } finally {
      if (last) this.source.changed();
    }
  }

  #finishPreparation(leadId: string, laneId: string, pending: Map<string, number>): boolean {
    if (this.#preparing.get(leadId) !== pending) return false;
    const count = pending.get(laneId);
    if (count === undefined) return false;
    if (count > 1) pending.set(laneId, count - 1);
    else pending.delete(laneId);
    if (pending.size) return false;
    this.#preparing.delete(leadId);
    return true;
  }

  remove(leadId: string, laneId?: string): void {
    if (laneId === undefined) this.#preparing.delete(leadId);
    else {
      const preparing = this.#preparing.get(leadId);
      if (preparing?.delete(laneId) && !preparing.size) this.#preparing.delete(leadId);
    }
  }

  clear(): void {
    this.#preparing.clear();
  }

  roles(): Map<string, SessionRole> {
    const source = this.source;
    const roles = new Map<string, SessionRole>();
    for (const lead of source.leads()) {
      const role: Extract<SessionRole, { role: "lead" }> = {
        role: "lead",
        workers: lead.lanes.length,
        paused: lead.paused,
        reason: lead.paused ? lead.reason : null,
        reports: lead.pendingReports.length + (lead.reportDeliveries?.length ?? 0),
      };
      try {
        if (!source.leadEnabled(lead.sessionId)) continue;
        if (lead.paused && lead.reason === "usage-limit") {
          if (source.leadLimitNeedsUser(lead.sessionId)) role.requiresUser = true;
          else role.recovering = true;
        }
        if (source.managedLeadNeedsUser(lead.sessionId)) role.requiresUser = true;
      } catch {
        // Failed supervision reads do not erase persisted assignments.
      }
      try {
        role.reports += source.queuedReports(lead.sessionId);
        for (const { laneId, key, text } of source.completionReports(lead.sessionId) ?? []) {
          if (
            text !== null &&
            lead.lanes.some(
              (lane) =>
                lane.id === laneId &&
                (key === null || !lane.reportedTurns.includes(key)) &&
                source.inAssignedWorkspace(lane),
            )
          )
            role.reports++;
        }
      } catch {
        role.reportsUnavailable = true;
      }
      // A history read may be for a report already picked up by catch-up. Hold the notification
      // without adding that possible duplicate to the confirmed queue count.
      if (this.#preparing.has(lead.sessionId)) role.reports = Math.max(role.reports, 1);
      roles.set(lead.sessionId, role);

      for (const lane of lead.lanes) {
        if (!source.workerEnabled(lane.agent)) continue;
        const worker: Extract<SessionRole, { role: "worker" }> = {
          role: "worker",
          leadId: lead.sessionId,
          name: lane.name,
        };
        try {
          const watch = source.workerWatch(lane.id);
          if (
            ((watch?.offline?.reported && watch.offline.userOnly) ||
              (watch?.limit?.value.continueAt === null && watch.limit.value.manual !== null)) &&
            source.inAssignedWorkspace(lane)
          )
            worker.requiresUser = true;
        } catch {
          // A failed workspace lookup can hide a supervision hint but not a Worker assignment.
        }
        roles.set(lane.sessionId, worker);
      }
    }
    return roles;
  }

  /** Resolve scheduled notifications using the current assignments, independent of catalog hints. */
  async workerStatus(
    sessionIds: readonly string[],
    kind: WorkerNotificationKind,
  ): Promise<{ worker: boolean; delegated: boolean }> {
    const ids = new Set(sessionIds);
    const assignments = () =>
      this.source
        .leads()
        .flatMap((lead) =>
          lead.lanes.filter(({ sessionId }) => ids.has(sessionId)).map((lane) => ({ lead, lane })),
        );
    const found = assignments();
    const direct = { worker: found.length > 0, delegated: false };
    const [owner] = found;
    if (kind === "completed" || kind === "failed" || found.length !== 1 || !owner) return direct;
    if (!this.#canDelegate(owner)) return direct;
    const live = await this.source.readWorker(owner.lane.sessionId).catch(() => null);
    if (!live) return direct;

    const now = assignments();
    const [current] = now;
    const currentDirect = { worker: now.length > 0, delegated: false };
    if (
      now.length !== 1 ||
      !current ||
      current.lead.sessionId !== owner.lead.sessionId ||
      current.lead.createdAt !== owner.lead.createdAt ||
      current.lead.deviceId !== owner.lead.deviceId ||
      current.lane.id !== owner.lane.id ||
      !this.#canDelegate(current, live)
    )
      return currentDirect;
    const waits = kind === "approval" ? live.approvals : live.questions;
    const waiting =
      kind === "approval"
        ? live.status === "awaiting-approval" || live.status === "waiting-approval"
        : live.status === "waiting-input";
    if (!waiting || !Array.isArray(waits) || !waits.length) return currentDirect;
    if (
      !waits.every(
        (item) =>
          isObject(item) &&
          ((typeof item.requestId === "string" && item.requestId.length > 0) ||
            Number.isSafeInteger(item.requestId)),
      )
    )
      return currentDirect;
    const items = waitingItems(live, current.lead.scope).filter((item) => item.kind === kind);
    return {
      worker: true,
      delegated: items.length === waits.length && items.every((item) => item.youMayDecide),
    };
  }

  #canDelegate({ lead, lane }: Assignment, live?: Live): boolean {
    try {
      return (
        !this.source.closed() &&
        !lead.paused &&
        this.source.leadEnabled(lead.sessionId) &&
        this.source.leadReachable(lead.sessionId) &&
        this.source.inAssignedWorkspace(lane, live)
      );
    } catch {
      return false;
    }
  }
}
