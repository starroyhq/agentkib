import { randomUUID } from "node:crypto";
import { REMOTE_ERROR_CODES, type WorkerReportPart } from "@agentkib/runtime-protocol";
import { recordLocalRuntimeTrace } from "./local-runtime-activity";
import {
  LOCAL_RUNTIME_TRACE_REPORT_METHOD,
  localRuntimeTraceReason,
  type LocalRuntimeTraceReason,
  type LocalRuntimeTraceStage,
} from "./local-runtime-trace";
import type { Lead } from "./orchestration-registry";
import { LeadReportNotDispatched, LeadReportUsageLimit } from "./message-lead-reports";

const failureCodes = [
  "session-unavailable",
  "report-queue-full",
  "report-too-long",
  "report-storage-unavailable",
  "report-authorization-changed",
  "report-id-conflict",
  "report-receipt-unavailable",
  "report-receipt-mismatch",
  "report-queue-update-refused",
  "control-outcome-unconfirmed",
  "outcome-unknown",
  "not-dispatched",
  "usage-limit",
  "legacy-outcome-unknown",
] as const;
type ReportFailureCode = (typeof failureCodes)[number];
type ReportFailurePhase = "availability" | "route" | "enqueue" | "confirmation";

export type ReportFailure = { phase: ReportFailurePhase; code: ReportFailureCode };

const traceStages = {
  availability: "report-availability",
  route: "report-route",
  enqueue: "report-enqueue",
  confirmation: "report-confirmation",
} satisfies Record<ReportFailurePhase, LocalRuntimeTraceStage>;
const traceReasons: Partial<Record<ReportFailureCode, LocalRuntimeTraceReason>> = {
  "report-authorization-changed": REMOTE_ERROR_CODES.accessChanged,
  "report-id-conflict": REMOTE_ERROR_CODES.requestIdConflict,
  "report-receipt-unavailable": REMOTE_ERROR_CODES.receiptUnavailable,
  "outcome-unknown": REMOTE_ERROR_CODES.outcomeUnknown,
  "not-dispatched": REMOTE_ERROR_CODES.controlPreflightRejected,
};

export function traceReportDelivery(started: number, failure?: ReportFailure) {
  const request = {
    kind: "request",
    method: LOCAL_RUNTIME_TRACE_REPORT_METHOD,
    durationMs: performance.now() - started,
  } as const;
  recordLocalRuntimeTrace(
    failure
      ? {
          ...request,
          stage: traceStages[failure.phase],
          outcome: failure.phase === "confirmation" ? "unknown" : "refused",
          reason:
            localRuntimeTraceReason(failure.code) ??
            traceReasons[failure.code] ??
            REMOTE_ERROR_CODES.requestFailed,
        }
      : { ...request, stage: "report-delivery", outcome: "accepted" },
  );
}

export type ReportPart = {
  text: string;
  occurredAt?: number;
  sourceLaneIds?: string[];
  urgent?: boolean;
  meta?: WorkerReportPart;
};

export type ReportDelivery = {
  reportId: string;
  text: string;
  occurredAt?: number;
  /** Unattempted parts can be interleaved with native completions discovered during a hold. */
  parts?: ReportPart[];
  quitLaneId?: string;
  sourceLaneIds?: string[];
  attempted?: true;
  attempts?: number;
  retryAt?: number;
  failure?: ReportFailure;
};

export function recordReports(lead: Lead, reportId: string, parts: ReportPart[], held: boolean) {
  if (!parts.length) return;
  if (lead.reason === "usage-limit") {
    const deliveries = (lead.reportDeliveries ??= []);
    for (const part of parts) deliveries.push(deliveryOf(part));
    return;
  }
  const text = joinReports(
    parts.map((part) => part.text),
    (index) => !!parts[index]?.urgent,
  );
  if (held) {
    (lead.pendingReportParts ??= lead.pendingReports.map(() => null)).push(parts);
    lead.pendingReports.push(text);
  } else
    (lead.reportDeliveries ??= []).push({
      reportId,
      text,
      occurredAt: parts[0]?.occurredAt,
      parts,
      sourceLaneIds: [...new Set(parts.flatMap(({ sourceLaneIds }) => sourceLaneIds ?? []))],
    });
}

/** Never include an exception's text in the orchestration journal. */
export function reportFailure(error: unknown, phase?: ReportFailurePhase): ReportFailure {
  if (error instanceof LeadReportUsageLimit) return { phase: "availability", code: "usage-limit" };
  const fixed =
    error instanceof Error
      ? failureCodes.find((candidate) => candidate === error.message)
      : undefined;
  if (error instanceof LeadReportNotDispatched)
    return {
      phase: phase ?? (fixed === "session-unavailable" ? "route" : "enqueue"),
      code: fixed ?? "not-dispatched",
    };
  return {
    phase: phase ?? "confirmation",
    code: fixed ?? "outcome-unknown",
  };
}

export function reportRetryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 20_000 * 2 ** Math.min(4, attempts - 1));
}

/** Block the report offers during queue recovery without blocking unrelated commands. */
export function trackReportRecovery(
  connection: { leadReportsRecovery?: Promise<void>; wake?: () => void },
  recovery: Promise<void> | void,
): void {
  if (!recovery) return;
  connection.leadReportsRecovery = recovery;
  void recovery
    .finally(() => {
      if (connection.leadReportsRecovery !== recovery) return;
      connection.leadReportsRecovery = undefined;
      connection.wake?.();
    })
    .catch(() => undefined);
}

export function nextReportOfferAt(
  reports: Array<{ id: string }>,
  offered: ReadonlyMap<string, number> | undefined,
  now: number,
): number {
  return reports.reduce(
    (earliest, { id }) => Math.min(earliest, offered?.get(id) ?? now),
    Infinity,
  );
}

const MAX_REPORT_BYTES = 16_000;

/** Keep a combined report within the message limit, even with several long Worker replies. */
function joinReports(reports: string[], urgent: (index: number) => boolean = () => false): string {
  const full = reports.join("\n\n");
  if (Buffer.byteLength(full) <= MAX_REPORT_BYTES) return full;
  const note = "Some report details were omitted. Use worker_list and worker_read for more.";
  const lines: string[] = [];
  let bytes = Buffer.byteLength(note);
  for (const report of reports) {
    const header = report.split("\n", 1)[0]!;
    const size = Buffer.byteLength(header) + 2;
    if (bytes + size > MAX_REPORT_BYTES) break;
    bytes += size;
    lines.push(header);
  }
  // Keep the headers in chronological order, reserving room for urgent details first.
  const detailsOrder = [...lines.keys()].sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
  for (const index of detailsOrder) {
    const report = reports[index]!;
    const details = Buffer.byteLength(report) - Buffer.byteLength(lines[index]!);
    if (bytes + details <= MAX_REPORT_BYTES) {
      lines[index] = report;
      bytes += details;
    }
  }
  return [...lines, note].join("\n\n");
}

export function queueHeldReports(lead: Lead, enabled: (delivery: ReportPart) => boolean): void {
  if (!lead.pendingReports.length) return;
  const deliveries = (lead.reportDeliveries ??= []);
  if (lead.reason === "usage-limit") {
    // Existing records only contain the original message text; they cannot be split by time.
    deliveries.push(...takeHeldReports(lead));
    return;
  }
  let waiting = deliveries.at(-1);
  if (
    !waiting ||
    waiting.quitLaneId ||
    waiting.attempted ||
    waiting.failure?.code !== "usage-limit" ||
    !enabled(waiting)
  )
    waiting = undefined;
  for (const delivery of takeHeldReports(lead)) {
    const { text } = delivery;
    const eligible = enabled(delivery);
    if (
      eligible &&
      waiting &&
      Buffer.byteLength(waiting.text) + Buffer.byteLength(text) + 2 <= MAX_REPORT_BYTES
    ) {
      waiting.parts = [
        ...(waiting.parts ?? [reportPart(waiting)]),
        ...(delivery.parts ?? [reportPart(delivery)]),
      ];
      waiting.text += "\n\n" + text;
      waiting.sourceLaneIds = [
        ...new Set([...(waiting.sourceLaneIds ?? []), ...(delivery.sourceLaneIds ?? [])]),
      ];
    } else {
      deliveries.push(delivery);
      waiting = eligible ? delivery : undefined;
    }
  }
}

export function takeHeldReports(lead: Lead): ReportDelivery[] {
  const parts = lead.pendingReportParts;
  delete lead.pendingReportParts;
  return lead.pendingReports.splice(0).map((text, index) => {
    const batch = parts?.[index];
    return batch?.length
      ? {
          reportId: randomUUID(),
          text,
          parts: batch,
          occurredAt: batch[0]?.occurredAt,
          sourceLaneIds: [...new Set(batch.flatMap((part) => part.sourceLaneIds ?? []))],
        }
      : { reportId: randomUUID(), text };
  });
}

export function orderUsageBacklog(lead: Lead, canMerge: (entry: ReportDelivery) => boolean): void {
  const deliveries = lead.reportDeliveries;
  if (!deliveries?.length) return;
  const unpacked = deliveries.flatMap((delivery): ReportDelivery[] => {
    if (delivery.quitLaneId || delivery.attempted || (delivery.parts?.length ?? 0) < 2)
      return [delivery];
    return delivery.parts!.map((part, index) =>
      deliveryOf(part, index === 0 ? delivery.reportId : undefined),
    );
  });
  // Older records lack timestamps. Keep their existing order and any potentially
  // submitted payload ahead of work which is known to have never been dispatched.
  const time = (report: ReportDelivery) =>
    report.attempted ? Number.MIN_SAFE_INTEGER : (report.occurredAt ?? Number.MIN_SAFE_INTEGER);
  unpacked.sort((a, b) => time(a) - time(b));
  const batches: ReportDelivery[] = [];
  for (const entry of unpacked) {
    const last = batches.at(-1);
    if (
      last &&
      !last.attempted &&
      !entry.attempted &&
      !last.quitLaneId &&
      !entry.quitLaneId &&
      canMerge(last) &&
      canMerge(entry) &&
      Buffer.byteLength(last.text) + Buffer.byteLength(entry.text) + 2 <= MAX_REPORT_BYTES
    ) {
      last.parts = [...(last.parts ?? [reportPart(last)]), ...(entry.parts ?? [reportPart(entry)])];
      last.text += `\n\n${entry.text}`;
      last.sourceLaneIds = [
        ...new Set([...(last.sourceLaneIds ?? []), ...(entry.sourceLaneIds ?? [])]),
      ];
    } else {
      batches.push(entry);
    }
  }
  lead.reportDeliveries = batches;
}

function reportPart({ text, occurredAt, sourceLaneIds }: ReportDelivery): ReportPart {
  return { text, occurredAt, sourceLaneIds };
}

function deliveryOf(part: ReportPart, reportId: string = randomUUID()): ReportDelivery {
  return {
    reportId,
    text: joinReports([part.text]),
    occurredAt: part.occurredAt,
    sourceLaneIds: part.sourceLaneIds,
    parts: [part],
  };
}
