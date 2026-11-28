import { lstatSync } from "node:fs";
import { openManagedLedger } from "../../managed-ledger";
import { completedClaudeForkResult } from "./claude-fork-history";
import type { ClaudeRecord } from "./claude-managed-record";
import { claudeSteeringCompletionPending } from "./claude-reconcile";
import { readClaudeSteeredAnswer } from "./claude-terminal-turn-evidence";
import { sameClaudeTranscript } from "./claude-transcript-proof";

const acceptedSteering = `
  session_id=? AND request_id=? AND phase='resolved'
    AND json_extract(evidence,'$.operation') IN ('steer','queue-steer')
    AND json_extract(evidence,'$.executionMode')='claude-managed'
    AND json_extract(evidence,'$.workspaceId')=? AND json_extract(evidence,'$.turnId')=?
    AND json_type(result,'$.accepted')='true'
    AND COALESCE(json_extract(result,'$.controlOutcome'),'accepted')='accepted'`;

function terminalTurn(record: ClaudeRecord) {
  const terminal = record.snapshot.terminalResult;
  if (!terminal || typeof terminal !== "object" || !("turnId" in terminal)) return;
  return terminal as { turnId: unknown; success?: unknown; steeringIds?: unknown };
}

/** Recover the legacy receipt only when the accepted input is on the completed native parent chain. */
export async function recoverStoredSteeringReceipt(
  dataDir: string,
  deviceId: string,
  record: ClaudeRecord,
  receipt: Record<string, unknown>,
  verifiedTranscript: () => string,
): Promise<boolean> {
  const { turnId, requestId } = receipt;
  const terminal = terminalTurn(record);
  const latest = terminal?.turnId === turnId ? terminal : undefined;
  if (
    receipt.status !== "accepted" ||
    (receipt.operation !== "steer" && receipt.operation !== "queue-steer") ||
    receipt.workspaceId !== record.workspaceId ||
    typeof turnId !== "string" ||
    typeof requestId !== "string" ||
    !record.completedRequests.includes(turnId) ||
    Array.isArray(latest?.steeringIds) ||
    claudeSteeringCompletionPending(record, requestId)
  )
    return false;

  try {
    const file = verifiedTranscript();
    const proof = await readClaudeSteeredAnswer(file, record.nativeId, turnId, {
      knownCompletion: latest?.success === true,
    });
    if (
      !proof?.sources.has(requestId) ||
      file !== verifiedTranscript() ||
      !sameClaudeTranscript(proof.version, lstatSync(file, { bigint: true }))
    )
      return false;

    const database = openManagedLedger(dataDir);
    if (!database) return false;
    try {
      return (
        database
          .prepare(
            `UPDATE managed_commands
          SET result=json_set(result,'$.completed',json('true'),'$.completionObserved',json('true'))
          WHERE ${acceptedSteering} AND device_id=? AND json_extract(evidence,'$.operation')=?`,
          )
          .run(record.id, requestId, record.workspaceId, turnId, deviceId, receipt.operation)
          .changes === 1
      );
    } finally {
      database.close();
    }
  } catch {
    // A changed or unavailable source supplies no new completion evidence.
    return false;
  }
}

export async function confirmedClaudeForkCutoff(
  dataDir: string,
  record: ClaudeRecord,
  file: string,
  last: { type: "user" | "assistant"; uuid: string; stopReason: unknown } | undefined,
  userUuid: unknown,
): Promise<boolean> {
  if (last?.type !== "assistant") return false;
  if (completedClaudeForkResult(last.stopReason)) return true;

  const terminal = terminalTurn(record);
  const turnId = terminal?.turnId;
  if (
    terminal?.success !== true ||
    typeof turnId !== "string" ||
    !record.completedRequests.includes(turnId)
  )
    return false;
  if (turnId === userUuid) return true;
  if (Array.isArray(terminal.steeringIds)) return terminal.steeringIds.includes(userUuid);

  // A legacy fork cutoff without a native stop reason needs both the parent chain and the old ACK.
  const proof = await readClaudeSteeredAnswer(file, record.nativeId, turnId, {
    cutoffId: last.uuid,
    knownCompletion: true,
  });
  if (!proof || !sameClaudeTranscript(proof.version, lstatSync(file, { bigint: true })))
    return false;
  const database = openManagedLedger(dataDir);
  if (!database) return false;
  try {
    const lookup = database.prepare(`SELECT 1 FROM managed_commands WHERE ${acceptedSteering}`);
    return [...proof.sources].some(
      (source) =>
        !claudeSteeringCompletionPending(record, source) &&
        lookup.get(record.id, source, record.workspaceId, turnId),
    );
  } finally {
    database.close();
  }
}
