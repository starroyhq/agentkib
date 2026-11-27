import {
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { InvalidSessionSubscriptionError } from "../conversation-hub";
import { RuntimeRequestError, RuntimeUnavailableError } from "../runtime-host";

export type StreamTermination = RemoteErrorCode | "access-ended" | "unavailable";

export function streamTerminationFrame(event: StreamTermination): string {
  if (event === "access-ended") return "event: access-ended\ndata: {}\n\n";
  const reason = event === "unavailable" ? REMOTE_ERROR_CODES.streamUnavailable : event;
  return `event: unavailable\ndata: ${JSON.stringify({ reason })}\n\n`;
}

export function streamFailureReason(error: unknown): RemoteErrorCode {
  if (error instanceof InvalidSessionSubscriptionError)
    return REMOTE_ERROR_CODES.streamInvalidResponse;
  if (
    error instanceof RuntimeUnavailableError ||
    (error instanceof Error && error.message === REMOTE_ERROR_CODES.runtimeUnavailable)
  )
    return REMOTE_ERROR_CODES.runtimeUnavailable;
  if (
    error instanceof RuntimeRequestError &&
    error.code === REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode &&
    error.data &&
    typeof error.data === "object" &&
    "detail" in error.data
  ) {
    if (error.data.detail === "session-stream-unavailable")
      return REMOTE_ERROR_CODES.runtimeUnavailable;
    if (error.data.detail === "session-subscription-limit") return REMOTE_ERROR_CODES.streamLimit;
  }
  return REMOTE_ERROR_CODES.streamUnavailable;
}
