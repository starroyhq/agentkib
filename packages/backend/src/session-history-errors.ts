import {
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  sessionHistoryReadReason,
} from "@agentkib/runtime-protocol";
import { RpcFault } from "./rpc";

export class TranscriptPathChangedError extends Error {
  readonly reason = REMOTE_ERROR_CODES.transcriptCursorStale;

  constructor() {
    super(REMOTE_ERROR_CODES.transcriptCursorInvalid);
  }
}

export class TranscriptCacheLimitError extends Error {
  constructor(cause?: unknown) {
    super(REMOTE_ERROR_CODES.transcriptScanStateLimit, { cause });
  }
}

export function sessionHistoryError(error: unknown): Error {
  if (error instanceof RpcFault || (error instanceof Error && error.name === "AbortError"))
    return error;
  const message = error instanceof Error ? error.message : undefined;
  if (
    error instanceof Error &&
    (sessionHistoryReadReason(message) || message === REMOTE_ERROR_CODES.dshRuntimeOffline)
  )
    return error;
  if (message === "TRANSCRIPT_UNREADABLE: decompressed rollout exceeds the cache limit")
    return new TranscriptCacheLimitError(error);
  if (message === "Transcript exceeds the 256 MiB read limit")
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
    if (error instanceof TranscriptPathChangedError) {
      const { ipc } = REMOTE_ERROR_CONTRACT.transcriptCursorInvalid;
      throw new RpcFault(ipc.rpcCode, "AgentKib command failed", {
        detail: ipc.detail,
        reason: error.reason,
      });
    }
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
