import {
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { InvalidSessionSubscriptionError } from "../conversation-hub";
import { RuntimeRequestError, RuntimeUnavailableError } from "../runtime-host";
import type { ConversationResponse } from "./conversation-transport";

export type StreamTermination = RemoteErrorCode | "access-ended" | "unavailable";

export function writeStreamHeaders(response: ConversationResponse) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
}

export function streamTerminationReason(event: StreamTermination): RemoteErrorCode {
  if (event === "access-ended") return REMOTE_ERROR_CODES.accessEnded;
  return event === "unavailable" ? REMOTE_ERROR_CODES.streamUnavailable : event;
}

function streamTerminationFrame(event: StreamTermination): string {
  if (event === "access-ended" || event === "unavailable") return `event: ${event}\ndata: {}\n\n`;
  const reason = streamTerminationReason(event);
  return `event: unavailable\ndata: ${JSON.stringify({ reason })}\n\n`;
}

export function closeStreamResponse(
  response: ConversationResponse,
  event: StreamTermination | null,
  blocked = false,
) {
  if (response.destroyed) return;
  // A blocked socket must not outlive removal from the stream registry.
  if (blocked) response.destroy();
  else if (!response.writableEnded) {
    // A null event disconnects so the client re-reads its current access scope.
    if (event && !response.write(streamTerminationFrame(event))) response.destroy();
    else response.end();
  }
}

export function streamFailureReason(
  error: unknown,
  hostErrorCode?: RemoteErrorCode,
): StreamTermination {
  // Only the host's explicit proof of an ended grant should stop reconnection.
  if (hostErrorCode === REMOTE_ERROR_CODES.accessEnded) return "access-ended";
  if (hostErrorCode) return hostErrorCode;
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
