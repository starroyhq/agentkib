import { REMOTE_ERROR_CODES, sessionHistoryReadReason } from "@agentkib/runtime-protocol";
import { RpcFault } from "./rpc";

export function sessionHistoryError(error: unknown): Error {
  if (error instanceof RpcFault || (error instanceof Error && error.name === "AbortError"))
    return error;
  const message = error instanceof Error ? error.message : undefined;
  if (
    error instanceof Error &&
    (sessionHistoryReadReason(message) || message === REMOTE_ERROR_CODES.dshRuntimeOffline)
  )
    return error;
  if (
    message === "Transcript exceeds the 256 MiB read limit" ||
    message === "TRANSCRIPT_UNREADABLE: decompressed rollout exceeds the cache limit"
  )
    return new Error(REMOTE_ERROR_CODES.transcriptScanStateLimit, { cause: error });
  return new Error(
    message === "Conversation transcript is no longer available"
      ? REMOTE_ERROR_CODES.transcriptUnreadable
      : REMOTE_ERROR_CODES.historyReadFailed,
    { cause: error },
  );
}

export async function readSessionHistory<T>(read: () => T | Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw sessionHistoryError(error);
  }
}

export function transcriptOpenError(error: unknown) {
  const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
  return new Error(
    missing ? REMOTE_ERROR_CODES.historyReadMissing : REMOTE_ERROR_CODES.transcriptUnreadable,
    { cause: error },
  );
}
