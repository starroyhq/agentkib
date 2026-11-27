import {
  REMOTE_ERROR_CODES,
  REMOTE_REQUEST_PATH,
  type ConversationReadState,
  type ConversationReadStateMark,
} from "@agentkib/runtime-protocol";
import { ApiError } from "./api-error";
import type { WebClient } from "./index";

/** A lost ACK is resolved by a GET, never by replaying the write. */
export async function updateReadState(
  client: Pick<WebClient, "request" | "readState">,
  sessionId: string,
  expectedVersion: string,
  seenResultId: string | null,
  mark?: ConversationReadStateMark,
  signal?: AbortSignal,
) {
  try {
    const result = await client.request<{ readState: ConversationReadState }>(
      REMOTE_REQUEST_PATH.readState,
      { sessionId, expectedVersion, seenResultId, ...(mark !== undefined ? { mark } : {}) },
      signal,
    );
    return { ...result, acknowledged: true };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ApiError && error.status !== 409 && error.status > 0 && error.status < 500)
      throw error;
    const result = await client.readState(sessionId, signal);
    const conflict =
      error instanceof ApiError &&
      error.status === 409 &&
      error.code === REMOTE_ERROR_CODES.readStateConflict;
    return { ...result, acknowledged: false, ...(conflict ? { conflict: true as const } : {}) };
  }
}
