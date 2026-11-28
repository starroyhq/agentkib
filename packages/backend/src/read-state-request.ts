import { REMOTE_ERROR_CODES, REMOTE_READ_STATE_UPDATE_CONTRACT } from "@agentkib/runtime-protocol";
import { z } from "zod";
import type { ConversationReadStates } from "./conversation-read-state";
import { parameters } from "./rpc";

const requestSchema = z
  .object({
    operation: z.enum(["read-state", "read-state-update"]),
    sessionId: z.string().min(1).max(256),
    readerScope: z.string().min(1).max(512),
    workspaceScope: z.string().min(1).max(256).optional(),
    expectedVersion: z.string().min(1).max(8192).optional(),
    seenResultId: z.string().min(1).max(1024).nullable().optional(),
    mark: z.enum(REMOTE_READ_STATE_UPDATE_CONTRACT.properties.mark.enum).optional(),
  })
  .strict();

export async function readStateRequest(
  states: Pick<ConversationReadStates, "get" | "update"> | undefined,
  value: unknown,
  workspaceOf?: (sessionId: string) => Promise<string | undefined>,
) {
  const request = parameters(requestSchema, value);
  if (!states) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
  const { operation, sessionId, readerScope, workspaceScope, expectedVersion, seenResultId, mark } =
    request;
  if (operation === "read-state") {
    const readState = await states.get(sessionId, readerScope);
    // The host checked the workspace before dispatch. Verify that same workspace after the read.
    if (workspaceScope && (await workspaceOf?.(sessionId)) !== workspaceScope)
      throw new Error(REMOTE_ERROR_CODES.workspaceNotAuthorized);
    return { readState };
  }
  if (!expectedVersion || seenResultId === undefined)
    throw new Error(REMOTE_ERROR_CODES.readStateConflictDetail);
  const readState = await states.update(
    sessionId,
    readerScope,
    expectedVersion,
    seenResultId,
    mark,
  );
  return { readState };
}
