import { createHash } from "node:crypto";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  replayManagedCommand,
} from "../managed-ledger";

/** Admit a command with the provider's existing fingerprint input and validation order. */
export function admitControlReceipt(dataDir: string, requestId: string, fingerprintInput: string) {
  const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
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
