import { lstatSync } from "node:fs";
import { REMOTE_CONTROL_OUTCOMES, REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import {
  beginManagedLedgerWrite,
  managedSessionHasPendingCommands,
  openManagedLedger,
} from "../../managed-ledger";
import type { bindControlReceipt } from "../../sessions/control-receipts";
import { coldClaudeHandoverTurn, settledClaudeSnapshot } from "./claude-execution";
import { terminationCodeOf } from "./claude-frame-policy";
import type { ClaudeRecord } from "./claude-managed-record";
import { readClaudeManagedCompletion } from "./claude-terminal-turn-evidence";
import { sameClaudeTranscript } from "./claude-transcript-proof";

export const ORPHANED_CLAUDE_COMMAND = "orphaned-claude-command";

export function claudeReconcileBlockReason(record: ClaudeRecord | null) {
  const reason = record?.snapshot.reason;
  if (typeof reason === "string" && reason.startsWith("Claude process cleanup unconfirmed"))
    return REMOTE_ERROR_CODES.claudeOwnerCheckUnavailable;
  return coldClaudeHandoverTurn(record) ? null : terminationCodeOf(reason);
}

type PendingCommand = {
  request_id: string;
  phase: string;
  evidence: string | null;
  result: string | null;
};

/** Only the caller holding the session lease and verifying the old writer is gone may retire these. */
function retireOrphanedCommands(
  dataDir: string,
  record: ClaudeRecord,
  reconcileId: string,
): boolean {
  const database = openManagedLedger(dataDir);
  if (!database) return true;
  try {
    beginManagedLedgerWrite(database);
    const rows = database
      .prepare(
        "SELECT request_id,phase,evidence,result FROM managed_commands WHERE session_id=? AND request_id<>? AND phase IN ('prepared','dispatched')",
      )
      .all(record.id, reconcileId) as PendingCommand[];
    if (
      rows.some(({ phase, evidence, result }) => {
        const scope = evidence === null ? null : JSON.parse(evidence);
        return (
          // A reconcile can leave a prepared row on interruption, but never dispatches a native input.
          (phase !== "dispatched" && scope?.operation !== "reconcile") ||
          result !== null ||
          scope?.executionMode !== "claude-managed" ||
          scope.workspaceId !== record.workspaceId ||
          typeof scope.operation !== "string" ||
          !scope.operation
        );
      })
    )
      return false;

    const retire = database.prepare(
      "UPDATE managed_commands SET phase='resolved',result=? WHERE session_id=? AND request_id=? AND phase=? AND result IS NULL",
    );
    for (const { request_id: requestId, phase } of rows) {
      if (
        retire.run(
          JSON.stringify({
            accepted: false,
            completed: false,
            controlOutcome: REMOTE_CONTROL_OUTCOMES.unknown,
            reason: REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
            recovery: ORPHANED_CLAUDE_COMMAND,
            requestId,
            sessionId: record.id,
          }),
          record.id,
          requestId,
          phase,
        ).changes !== 1
      )
        return false;
    }
    database.exec("COMMIT");
    return true;
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
}

export async function reconcileColdClaudeSession(
  record: ClaudeRecord,
  options: {
    dataDir: string;
    reconcileId?: string;
    current: () => boolean;
    transcript: () => string;
    verifyNoOwner: () => Promise<void>;
  },
): Promise<boolean> {
  const { dataDir, reconcileId, current, transcript, verifyNoOwner } = options;
  if (record.released) return false;
  const turnId = coldClaudeHandoverTurn(record);
  const pending = () => managedSessionHasPendingCommands(dataDir, record.id);
  if (reconcileId) {
    // Explicit protocol stops and unconfirmed process-tree cleanup require their own proof.
    if (claudeReconcileBlockReason(record)) return false;
  } else if (!turnId || pending()) return false;

  const file = turnId ? transcript() : null;
  const proof =
    file && turnId ? await readClaudeManagedCompletion(file, record.nativeId, turnId) : null;
  if (!proof && (!reconcileId || terminationCodeOf(record.snapshot.reason) !== null)) return false;
  await verifyNoOwner();
  if (
    !current() ||
    (proof &&
      file &&
      (transcript() !== file || !sameClaudeTranscript(proof, lstatSync(file, { bigint: true }))))
  )
    return false;
  if (reconcileId ? !retireOrphanedCommands(dataDir, record, reconcileId) : pending()) return false;

  if (proof && turnId && !record.completedRequests.includes(turnId))
    record.completedRequests.push(turnId);
  const settled = settledClaudeSnapshot(record.snapshot, proof ? (turnId ?? null) : null);
  record.snapshot =
    record.snapshot.status === "idle"
      ? { ...settled, turnId: record.snapshot.turnId, lastOutcome: record.snapshot.lastOutcome }
      : settled;
  return true;
}

export async function runClaudeReconcile(
  receipt: ReturnType<typeof bindControlReceipt>,
  {
    requestId,
    sessionId,
    deviceId,
    workspaceId,
    runtimeBootId,
  }: {
    requestId: string;
    sessionId: string;
    deviceId: string;
    workspaceId: string;
    runtimeBootId: string;
  },
  readLive: () => Promise<Record<string, unknown>>,
  recover: () => Promise<boolean>,
) {
  let live = await readLive();
  const prior = receipt.claim(sessionId, deviceId, {
    operation: "reconcile",
    workspaceId,
    executionMode: "claude-managed",
    runtimeBootId,
  });
  if (prior) return prior;
  const identity = { requestId, sessionId, runtimeBootId };
  try {
    let reason: string | undefined;
    if (live.status === "outcome-unknown") {
      const recovered = await recover().catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          ![
            REMOTE_ERROR_CODES.claudeOwnerBusy,
            REMOTE_ERROR_CODES.claudeBackgroundSessionRunning,
            REMOTE_ERROR_CODES.claudeOwnerCheckUnavailable,
          ].some((code) => code === error.message)
        )
          throw error;
        reason = error.message;
        return false;
      });
      if (recovered) live = await readLive();
    }
    const reconciled = live.status === "idle";
    const result = {
      ...identity,
      accepted: true,
      completed: true,
      controlOutcome: "accepted",
      reconciled,
      ...(reconciled ? {} : { reason: reason ?? REMOTE_ERROR_CODES.controlOutcomeUnconfirmed }),
      live,
    };
    receipt.finish(result);
    return result;
  } catch (error) {
    receipt.finish({
      ...identity,
      accepted: false,
      completed: false,
      controlOutcome: REMOTE_CONTROL_OUTCOMES.unknown,
    });
    throw error;
  }
}
