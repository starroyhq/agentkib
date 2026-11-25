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

export type ReportDelivery = {
  reportId: string;
  text: string;
  quitLaneId?: string;
  sourceLaneIds?: string[];
  attempted?: true;
  attempts?: number;
  retryAt?: number;
  failure?: ReportFailure;
};

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
