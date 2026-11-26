import { z } from "zod";
import { bindWorkerReportMessage } from "../../worker-report-ledger";

const uuid = z.string().uuid();

/** Reports a terminal holds at most before it takes them, as its outbox holds 20 messages. */
export const MAX_QUEUED_REPORTS = 16;
export const MAX_MERGED_REPORT_IDS = 128;
// Keep more receipts than can be acknowledged by removing the entire queue at once.
export const MAX_REPORT_RECEIPTS = 4096;
export const NATIVE_REPORT_RETRY_MS = 4_000;
/** Persisted reports can exceed the current plugin’s submission budget. */
const MAX_REPORT_TEXT = 32_000;
// JSON uses up to six bytes for each escaped UTF-16 code unit.
export const MAX_REPORT_FILE_BYTES =
  MAX_QUEUED_REPORTS * (MAX_REPORT_TEXT * 6 + MAX_MERGED_REPORT_IDS * 39 + 128);
const MAX_REPORT_CODE_POINTS = 16_000;
const MAX_REPORT_BYTES = 16_384;
export function fitsTerminalReport(text: string): boolean {
  return Buffer.byteLength(text) <= MAX_REPORT_BYTES && [...text].length <= MAX_REPORT_CODE_POINTS;
}
export const reportQueueSchema = z
  .array(
    z.object({
      id: uuid,
      text: z.string().max(MAX_REPORT_TEXT),
      offered: z.literal(true).optional(),
      nativeReceipt: z.literal(true).optional(),
      mergedIds: z.array(uuid).max(MAX_MERGED_REPORT_IDS).optional(),
    }),
  )
  .max(MAX_QUEUED_REPORTS);
export const reportReceiptsSchema = z
  .array(z.object({ id: uuid, merged: z.boolean() }))
  .max(MAX_REPORT_RECEIPTS);

/** A report on its way into a terminal Project Agent’s outbox. */
export type QueuedReport = z.infer<typeof reportQueueSchema>[number];

export function recordTerminalReportMessages(
  dataDir: string,
  sessionId: string,
  acknowledged: readonly QueuedReport[],
  nativeMessages?: ReadonlyMap<string, string>,
): boolean {
  let historyChanged = false;
  for (const report of acknowledged) {
    const messageId = report.nativeReceipt && nativeMessages?.get(report.id);
    if (!messageId) continue;
    bindWorkerReportMessage(
      dataDir,
      sessionId,
      { type: "native-message", id: messageId },
      [report.id, ...(report.mergedIds ?? [])],
      `${report.text}\n\n[AgentKib report ID: ${report.id}]`,
    );
    historyChanged = true;
  }
  return historyChanged;
}
