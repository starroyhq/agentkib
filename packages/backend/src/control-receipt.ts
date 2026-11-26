import { z } from "zod";
import { REMOTE_CONTROL_OUTCOMES } from "@agentkib/runtime-protocol";
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
  status: REMOTE_CONTROL_OUTCOMES.notDispatched,
  recovery: "legacy-prepared",
  completionObserved: false,
});

type PendingNativeReceipt = Record<string, unknown> & {
  found: true;
  status: typeof REMOTE_CONTROL_OUTCOMES.unknown;
  requestId: string;
  sessionId: string;
  workspaceId: string;
  operation: string;
};

export function isPendingNativeReceipt(value: unknown): value is PendingNativeReceipt {
  return (
    object(value) &&
    value.found === true &&
    value.status === REMOTE_CONTROL_OUTCOMES.unknown &&
    typeof value.requestId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.workspaceId === "string" &&
    typeof value.operation === "string"
  );
}

/** Settle only the exact device-bound claim, without overwriting a racing acknowledgement. */
export function acceptNativeControlReceipt(
  dataDir: string,
  deviceId: string,
  receipt: PendingNativeReceipt,
  completedTurnId?: string,
) {
  const { requestId, sessionId, runtimeBootId } = receipt;
  const database = openManagedLedger(dataDir);
  if (!database) return receipt;
  try {
    database
      .prepare(
        "UPDATE managed_commands SET phase='resolved',result=? WHERE request_id=? AND session_id=? AND device_id=? AND " +
          "((phase='dispatched' AND result IS NULL) OR " +
          "(phase='resolved' AND json_extract(result,'$.controlOutcome')=? AND json_extract(result,'$.accepted') IS NOT 1))",
      )
      .run(
        JSON.stringify({
          accepted: true,
          reconciled: true,
          completed: completedTurnId !== undefined,
          completionObserved: completedTurnId !== undefined,
          ...(completedTurnId === undefined ? {} : { turnId: completedTurnId }),
          controlOutcome: "accepted",
          requestId,
          sessionId,
          runtimeBootId,
        }),
        requestId,
        sessionId,
        deviceId,
        REMOTE_CONTROL_OUTCOMES.unknown,
      );
  } finally {
    database.close();
  }
  return readControlReceipt(dataDir, { requestId, deviceId });
}

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
        controlOutcome: REMOTE_CONTROL_OUTCOMES.notDispatched,
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
      ackRecord.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched
    ) {
      database.exec("COMMIT");
      return legacyPrepared(requestId);
    }
    if (row.device_id !== deviceId) {
      database.exec("COMMIT");
      return { found: false, requestId };
    }
    const status =
      row.phase !== "resolved" || ackRecord.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown
        ? REMOTE_CONTROL_OUTCOMES.unknown
        : ackRecord.accepted === true
          ? "accepted"
          : REMOTE_CONTROL_OUTCOMES.notDispatched;
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
      ...(typeof evidenceRecord.historyInputHash === "string" &&
      /^[a-f0-9]{64}$/.test(evidenceRecord.historyInputHash)
        ? { historyInputHash: evidenceRecord.historyInputHash }
        : {}),
      ...(typeof evidenceRecord.publicInputHash === "string" &&
      /^[a-f0-9]{64}$/.test(evidenceRecord.publicInputHash)
        ? { publicInputHash: evidenceRecord.publicInputHash }
        : {}),
      status,
      ack,
      completionObserved:
        status === "accepted" &&
        ackRecord.completed === true &&
        ackRecord.completionObserved === true &&
        (evidenceRecord.operation !== "stop" ||
          (typeof evidenceRecord.turnId === "string" &&
            ackRecord.turnId === evidenceRecord.turnId)),
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
