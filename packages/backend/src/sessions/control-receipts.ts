import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  replayManagedCommand,
} from "../managed-ledger";

export function controlReceiptFingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Admit a command with the provider's existing fingerprint input and validation order. */
export function admitControlReceipt(dataDir: string, requestId: string, fingerprintInput: string) {
  const fingerprint = controlReceiptFingerprint(fingerprintInput);
  const previous = replayManagedCommand(dataDir, requestId, fingerprint);
  return {
    fingerprint,
    previous,
    claim(sessionId: string, deviceId: string | null, evidence: Record<string, unknown>) {
      return claimManagedCommand(dataDir, requestId, sessionId, fingerprint, deviceId, evidence);
    },
    dispatch: () => dispatchManagedCommand(dataDir, requestId),
    finish: (result: Record<string, unknown>) => finishManagedCommand(dataDir, requestId, result),
  };
}

/** Read again inside the caller's state transaction before applying a local mutation. */
export function replayControlReceiptInTransaction(
  database: DatabaseSync,
  requestId: string,
  fingerprint: string,
  resolveDispatched: boolean,
): Record<string, unknown> | undefined {
  const previous = database
    .prepare("SELECT fingerprint,result FROM managed_commands WHERE request_id=?")
    .get(requestId) as { fingerprint: string; result: string | null } | undefined;
  if (!previous) return;
  if (previous.fingerprint !== fingerprint)
    throw new Error("request-id-reused-with-different-input");
  if (previous.result) return JSON.parse(previous.result) as Record<string, unknown>;
  if (!resolveDispatched) throw new Error("control-outcome-unconfirmed");
}

/** Commit the receipt with the caller's state writes, keeping any existing claim's evidence. */
export function finishControlReceiptInTransaction(
  database: DatabaseSync,
  receipt: {
    requestId: string;
    sessionId: string;
    fingerprint: string;
    deviceId: string;
    evidence: Record<string, unknown>;
    result: Record<string, unknown>;
  },
): void {
  database
    .prepare(
      "INSERT INTO managed_commands(request_id,session_id,fingerprint,phase,result,device_id,evidence,claim_version) VALUES(?,?,?,'resolved',?,?,?,1) ON CONFLICT(request_id) DO UPDATE SET phase='resolved',result=excluded.result",
    )
    .run(
      receipt.requestId,
      receipt.sessionId,
      receipt.fingerprint,
      JSON.stringify(receipt.result),
      receipt.deviceId,
      JSON.stringify(receipt.evidence),
    );
}
