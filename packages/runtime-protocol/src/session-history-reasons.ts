import { REMOTE_ERROR_CONTRACT } from "./generated/remote-contract";

const historyReadErrors = [
  REMOTE_ERROR_CONTRACT.staleCursor,
  REMOTE_ERROR_CONTRACT.transcriptCursorStale,
  REMOTE_ERROR_CONTRACT.transcriptCursorInvalid,
  REMOTE_ERROR_CONTRACT.transcriptUnreadable,
  REMOTE_ERROR_CONTRACT.transcriptScanStateLimit,
  REMOTE_ERROR_CONTRACT.historyReadFailed,
  REMOTE_ERROR_CONTRACT.historyReadMissing,
  REMOTE_ERROR_CONTRACT.dshHistoryTimeout,
  REMOTE_ERROR_CONTRACT.dshHistoryUnavailable,
  REMOTE_ERROR_CONTRACT.antigravityAcpDisabled,
] as const;

export type SessionHistoryReadReason = (typeof historyReadErrors)[number]["code"];

export function sessionHistoryReadReason(value: unknown): SessionHistoryReadReason | undefined {
  return historyReadErrors.find(({ code }) => code === value)?.code;
}
