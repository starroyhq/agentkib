import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { z } from "zod";
import { CodexAppServerError, type CodexAppServerSession } from "./codex-app-server";

export const codexQuitEvidence = z.strictObject({
  turnId: z.string().min(1).max(256),
  nativeId: z.uuid(),
  workspaceId: z.string().min(1).max(256),
  createdAt: z.string().max(128),
  settings: z.string().length(64),
  history: z.string().max(256).nullable(),
  manualOnly: z.literal(true).optional(),
});
export type CodexQuitEvidence = z.infer<typeof codexQuitEvidence>;
export class CodexQuitQueueManual extends Error {
  constructor() {
    super(REMOTE_ERROR_CODES.quitWorkManualRequired);
  }
}

export async function dispatchCodexQuitContinuation(
  session: CodexAppServerSession,
  threadId: string,
  queued: string[] | undefined,
  params: Record<string, unknown>,
  claimDispatch: () => void,
  assertDispatchable: () => void,
): Promise<unknown> {
  if (!queued) throw new CodexQuitQueueManual();
  if (!queued.length) return session.request("turn/start", params, claimDispatch);

  const clientUserMessageId = params.clientUserMessageId;
  const queue = () => readManagedQueue(session, threadId, 100);
  const explicitlyRejected = (error: unknown) =>
    error instanceof CodexAppServerError &&
    error.code !== undefined &&
    [-32600, -32601, -32602].includes(error.code);
  let added: unknown;
  try {
    // The cancelled native turn keeps the queue paused across cold resume. Codex
    // does not deduplicate add, so write the dispatch receipt before adding once.
    added = await session.request(
      "thread/queue/add",
      { threadId, input: params.input, clientUserMessageId },
      claimDispatch,
    );
  } catch (error) {
    if (explicitlyRejected(error)) throw new CodexQuitQueueManual();
    throw error;
  }
  const item = isObject(added) && isObject(added.queuedSubmission) && added.queuedSubmission;
  if (
    !item ||
    typeof item.id !== "string" ||
    !item.id ||
    item.clientUserMessageId !== clientUserMessageId ||
    queued.includes(item.id)
  )
    throw new Error("unconfirmed-queue-mutation");
  const id = item.id;
  const ordered = [id, ...queued];
  const matches = async (ids: string[]) => {
    const current = await queue();
    return (
      current.complete &&
      current.data.length === ids.length &&
      current.data.every((row, index) => row.id === ids[index]) &&
      current.data[ids.indexOf(id)]?.clientUserMessageId === clientUserMessageId
    );
  };
  const abandon = async () => {
    // Only this queued item is ours to remove. Verify that the start was
    // never submitted or was explicitly refused before falling back to manual.
    const current = await queue();
    if (
      !current.complete ||
      !current.data.some((row) => row.id === id && row.clientUserMessageId === clientUserMessageId)
    )
      throw new Error("unconfirmed-queue-mutation");
    await session.request(
      "thread/queue/delete",
      { threadId, queuedSubmissionId: id },
      assertDispatchable,
    );
    const after = await queue();
    if (
      !after.complete ||
      after.data.some((row) => row.id === id || row.clientUserMessageId === clientUserMessageId)
    )
      throw new Error("unconfirmed-queue-mutation");
    throw new CodexQuitQueueManual();
  };
  if (!(await matches([...queued, id]))) return abandon();
  try {
    await session.request(
      "thread/queue/reorder",
      { threadId, queuedSubmissionIds: ordered },
      assertDispatchable,
    );
  } catch (error) {
    if (explicitlyRejected(error)) return abandon();
    throw error;
  }
  if (!(await matches(ordered))) return abandon();
  try {
    return await session.request(
      "thread/queue/start",
      { threadId, queuedSubmissionId: id },
      assertDispatchable,
    );
  } catch (error) {
    if (explicitlyRejected(error)) return abandon();
    throw error;
  }
}

export async function readManagedQueue(
  session: CodexAppServerSession,
  nativeId: string,
  limit: number,
) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await session.request("thread/queue/list", {
      threadId: nativeId,
      cursor,
      limit: 100,
    });
    if (!isObject(page) || !Array.isArray(page.data) || page.data.some((item) => !isObject(item)))
      throw new Error("invalid-native-queue");
    rows.push(...(page.data as Record<string, unknown>[]));
    if (rows.length > Math.min(100, limit))
      return { data: [], complete: false, reason: "queue-too-large" };
    const next = page.nextCursor;
    if (next === null || next === undefined)
      return { data: rows, nextCursor: null, complete: true };
    if (typeof next !== "string" || !next || seen.has(next) || page.data.length === 0)
      throw new Error("invalid-native-queue-cursor");
    seen.add(next);
    cursor = next;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
