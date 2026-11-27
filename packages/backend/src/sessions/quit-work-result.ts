import { REMOTE_ERROR_CODES, type RemoteErrorCode } from "@agentkib/runtime-protocol";

const reasons = new Map<string, RemoteErrorCode>(
  Object.values(REMOTE_ERROR_CODES).map((code) => [code, code]),
);

export type NoteQuitWorkReason = (reason: RemoteErrorCode) => void;
export type QuitWorkReportOutcome = "continued" | "not-continued" | "unknown";

export function quitWorkReason(value: unknown): RemoteErrorCode | undefined {
  const code = value instanceof Error ? value.message : value;
  return typeof code === "string" ? reasons.get(code) : undefined;
}

export function quitWorkBlocked<T>(
  result: T,
  note: NoteQuitWorkReason | undefined,
  reason: RemoteErrorCode,
): T {
  note?.(reason);
  return result;
}

export function quitWorkReportSummary(
  outcome: QuitWorkReportOutcome,
  upgrade: boolean,
  reason?: RemoteErrorCode,
) {
  const result = {
    continued: "AgentKib has started a continuation in the same session.",
    "not-continued": "AgentKib did not start a continuation.",
    unknown: "AgentKib could not confirm whether a continuation started.",
  }[outcome];
  const detail = reason
    ? ` ${outcome === "continued" ? "Queue restoration" : "Continuation"}: ${reason}.`
    : "";
  return `its turn was interrupted ${upgrade ? "by an AgentKib upgrade" : "when AgentKib quit"}. ${result}${detail}`;
}

export function quitWorkReportMetadata(
  outcome: QuitWorkReportOutcome,
  upgrade: boolean,
  reason?: RemoteErrorCode,
) {
  return {
    interruptedBy: upgrade ? "upgrade" : "quit",
    ...(reason && { [outcome === "continued" ? "queueRestoreReason" : "reason"]: reason }),
  };
}
