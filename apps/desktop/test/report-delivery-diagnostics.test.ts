import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recordLocalRuntimeTrace } from "../../../packages/backend/src/local-runtime-activity";
import {
  LeadReportNotDispatched,
  LeadReportUsageLimit,
} from "../../../packages/backend/src/message-lead-reports";
import { reportFailure, traceReportDelivery } from "../../../packages/backend/src/report-delivery";

vi.mock("../../../packages/backend/src/local-runtime-activity", () => ({
  recordLocalRuntimeTrace: vi.fn(),
}));

describe("report delivery diagnostics", () => {
  beforeEach(() => {
    vi.mocked(recordLocalRuntimeTrace).mockClear();
  });

  it.each([
    [
      new LeadReportNotDispatched("session-unavailable"),
      "report-route",
      "refused",
      REMOTE_ERROR_CODES.reportTargetUnavailable,
    ],
    [
      new LeadReportNotDispatched("report-queue-full"),
      "report-enqueue",
      "refused",
      REMOTE_ERROR_CODES.reportQueueFull,
    ],
    [
      new LeadReportNotDispatched("report-too-long"),
      "report-enqueue",
      "refused",
      REMOTE_ERROR_CODES.reportTooLong,
    ],
    [
      new LeadReportNotDispatched("report-storage-unavailable"),
      "report-enqueue",
      "refused",
      REMOTE_ERROR_CODES.reportStorageUnavailable,
    ],
    [
      new LeadReportNotDispatched("report-queue-update-refused"),
      "report-enqueue",
      "refused",
      REMOTE_ERROR_CODES.reportQueueUpdateRefused,
    ],
    [
      new Error("report-receipt-mismatch"),
      "report-confirmation",
      "unknown",
      REMOTE_ERROR_CODES.reportReceiptMismatch,
    ],
    [
      new LeadReportUsageLimit("usage-limit"),
      "report-availability",
      "refused",
      REMOTE_ERROR_CODES.reportLeadUsageLimited,
    ],
    [
      new LeadReportUsageLimit("usage-limit", "user"),
      "report-availability",
      "refused",
      REMOTE_ERROR_CODES.delegationPaused,
    ],
    [
      new Error("private native response"),
      "report-confirmation",
      "unknown",
      REMOTE_ERROR_CODES.outcomeUnknown,
    ],
  ])("records %s with a fixed phase and reason", (error, stage, outcome, reason) => {
    traceReportDelivery(performance.now(), reportFailure(error));
    expect(recordLocalRuntimeTrace).toHaveBeenCalledExactlyOnceWith({
      kind: "request",
      method: "orchestration.report",
      durationMs: expect.any(Number),
      stage,
      outcome,
      reason,
    });
  });
});
