import { z } from "zod";
import { openManagedLedger } from "./managed-ledger";

const requestSchema = z
  .object({ requestId: z.string().uuid(), deviceId: z.string().min(1).max(256) })
  .strict()
  .refine((value) => Buffer.byteLength(value.deviceId, "utf8") <= 256)
  .refine((value) => /^[a-zA-Z0-9_:-]+$/.test(value.deviceId));

type ReceiptRow = {
  session_id: string;
  phase: string;
  result: string | null;
  evidence: string | null;
  device_id: string;
  claim_version: number;
};

const legacyPrepared = (requestId: string) => ({
  found: true,
  requestId,
  status: "not-dispatched",
  recovery: "legacy-prepared",
  completionObserved: false,
});

/** Resolve a device-bound control receipt from the durable managed-session ledger. */
export function readControlReceipt(dataDir: string, value: unknown) {
  const { requestId, deviceId } = requestSchema.parse(value);
  const database = openManagedLedger(dataDir);
  if (!database) return { found: false, requestId };
  try {
    database.exec("BEGIN IMMEDIATE");

    const row = database
      .prepare(
        "SELECT session_id,phase,result,evidence,device_id,claim_version FROM managed_commands WHERE request_id=? AND (device_id=? OR (device_id='' AND claim_version=0))",
      )
      .get(requestId, deviceId) as ReceiptRow | undefined;
    if (!row) {
      database.exec("COMMIT");
      return { found: false, requestId };
    }
    const ack: unknown = row.result === null ? null : JSON.parse(row.result);
    const evidence: unknown = row.evidence === null ? null : JSON.parse(row.evidence);
    const ackRecord = object(ack) ? ack : {};
    const evidenceRecord = object(evidence) ? evidence : {};
    const operation = typeof evidenceRecord.operation === "string" ? evidenceRecord.operation : "";
    const orphan = row.claim_version === 0 && (row.device_id === "" || operation.length === 0);
    if (orphan && row.phase === "prepared") {
      const recovered = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        requestId,
        recovery: "legacy-prepared",
      };
      database
        .prepare(
          "UPDATE managed_commands SET phase='resolved',result=? WHERE request_id=? AND phase='prepared'",
        )
        .run(JSON.stringify(recovered), requestId);
      database.exec("COMMIT");
      return legacyPrepared(requestId);
    }
    if (
      orphan &&
      row.phase === "resolved" &&
      ackRecord.recovery === "legacy-prepared" &&
      ackRecord.controlOutcome === "not-dispatched"
    ) {
      database.exec("COMMIT");
      return legacyPrepared(requestId);
    }
    if (row.device_id !== deviceId) {
      database.exec("COMMIT");
      return { found: false, requestId };
    }
    const status =
      row.phase === "dispatched"
        ? "unknown"
        : ackRecord.accepted === true
          ? "accepted"
          : "not-dispatched";
    database.exec("COMMIT");
    return {
      found: true,
      requestId,
      sessionId: row.session_id,
      workspaceId: evidenceRecord.workspaceId ?? null,
      operation: evidenceRecord.operation ?? null,
      executionMode: evidenceRecord.executionMode ?? null,
      runtimeBootId: evidenceRecord.runtimeBootId ?? null,
      expectedRevision: evidenceRecord.expectedRevision ?? null,
      turnId: evidenceRecord.turnId ?? null,
      status,
      ack,
      completionObserved: false,
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have committed before a later close error.
    }
    throw error;
  } finally {
    database.close();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
