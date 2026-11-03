import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { ConversationReadResult } from "@agentkib/runtime-protocol";
import { ReadStateLedger, type ReadCheckpoint } from "./read-state-ledger";
import { jsonTimestamp } from "./session-history";
import { hasText, messageText, trimWhitespace } from "./session-events";
import { claudeCommandInvocation, claudeCommandOutput } from "./claude-command-records";

const SLICE_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Explicit termination records only, including turns without an assistant message. */
export function historyReadResult(
  provider: "codex" | "claude-code",
  row: Record<string, unknown>,
  position: number,
  cursor: ReadCheckpoint,
): ConversationReadResult | null {
  const payload = object(row.payload) ? row.payload : {};
  if (provider === "codex") {
    if (row.type === "turn_context") cursor.lastTurnId = text(payload.turn_id) ?? cursor.lastTurnId;
    if (row.type !== "event_msg") return null;
    const turnId = text(payload.turn_id) ?? cursor.lastTurnId;
    if (payload.type === "task_started") {
      cursor.lastTurnId = turnId;
      return null;
    }
    if (!["task_complete", "turn_aborted"].includes(String(payload.type))) return null;
    return {
      id: turnId ? `turn:${turnId}` : `record:${position}`,
      turnId,
      itemId: cursor.lastItemId,
      outcome:
        payload.type === "turn_aborted"
          ? "cancelled"
          : payload.error != null
            ? "failed"
            : "completed",
      completedAt: jsonTimestamp(row.timestamp),
    };
  }
  const message = object(row.message) ? row.message : null;
  const content = message?.content;
  const blocks = Array.isArray(content) ? content.filter(object) : [];
  const body = messageText(content);
  const internal = row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true;
  const visibleText = (value: string | null): value is string =>
    hasText(value) &&
    !["<local-command-", "<command-name>", "<command-message>"].some((prefix) =>
      trimWhitespace(value).startsWith(prefix),
    );
  const invocation = body ? claudeCommandInvocation(body) : null;
  const output = body ? claudeCommandOutput(body) : null;
  if (
    row.type === "user" &&
    !internal &&
    message &&
    (message.role === undefined || message.role === "user") &&
    !blocks.some((block) => block.type === "tool_result") &&
    output === null &&
    (invocation !== null ||
      visibleText(body) ||
      blocks.some((block) => block.type === "image" || block.type === "document"))
  ) {
    cursor.lastTurnId = text(row.uuid) ?? text(message.id);
    // A new prompt cannot inherit the preceding turn's visible reply.
    cursor.lastItemId = null;
  }
  if (row.type === "assistant" && !internal && visibleText(body)) {
    const nativeId = [row.uuid, message?.id].find(
      (id): id is string => typeof id === "string" && messageId.test(id),
    );
    // Only IDs the real history reader can expose may anchor a result. A byte-offset
    // guess, tool-use UUID or thinking-only row would prevent the terminal marker being seen.
    cursor.lastItemId = nativeId ?? null;
    if (nativeId && Array.isArray(content)) {
      cursor.lastItemId = null;
      for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (
          !object(block) ||
          block.type !== "text" ||
          !visibleText(typeof block.text === "string" ? block.text : null)
        )
          continue;
        cursor.lastItemId = index === 0 ? nativeId : `${nativeId}:text:${index}`;
        break;
      }
    }
  }
  if (row.type !== "system" || row.subtype !== "turn_duration" || internal) return null;
  const turnId = text(row.turn_id) ?? cursor.lastTurnId;
  // Native Claude uses the final assistant message ID; managed turns supply it too.
  return {
    id: turnId
      ? `turn:${turnId}`
      : cursor.lastItemId
        ? `item:${cursor.lastItemId}`
        : text(row.uuid)
          ? `record:${row.uuid}`
          : `record:${position}`,
    turnId,
    itemId: cursor.lastItemId,
    outcome: row.error != null ? "failed" : "ended",
    completedAt: jsonTimestamp(row.timestamp),
  };
}

/** At most one bounded slice per call. Cursor and markers survive process restarts. */
export function observeReadHistory(
  ledger: ReadStateLedger,
  key: string,
  provider: "codex" | "claude-code",
  file: string,
): { changed: boolean; complete: boolean } {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("read-state-unavailable");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino)
      throw new Error("read-state-unavailable");
    const saved = ledger.checkpoint(key),
      identity = `${stat.dev}:${stat.ino}`;
    const old = saved.checkpoint;
    const reusable = old?.file === file && old.identity === identity && old.offset <= stat.size;
    const checkpoint: ReadCheckpoint = reusable
      ? { ...old }
      : {
          file,
          identity,
          offset: 0,
          baselineEnd: saved.complete ? 0 : stat.size,
          lastItemId: null,
          lastTurnId: null,
        };
    const size = Math.min(SLICE_BYTES, stat.size - checkpoint.offset);
    const bytes = Buffer.alloc(size);
    let length = 0;
    while (length < size) {
      const count = readSync(fd, bytes, length, size - length, checkpoint.offset + length);
      if (!count) throw new Error("read-state-unavailable");
      length += count;
    }
    const newline = bytes.lastIndexOf(10);
    const end = newline + 1;
    if (end === 0 && size === SLICE_BYTES) throw new Error("read-state-unavailable");
    // A partial trailing write is retained for the next observation, never used as a baseline.
    if (end === 0 && size !== 0) return { changed: false, complete: false };
    const start = checkpoint.offset;
    const results: Array<{ result: ConversationReadResult; baseline: boolean; position: number }> =
      [];
    let offset = 0;
    while (offset < end) {
      const next = bytes.indexOf(10, offset);
      const line = bytes.subarray(offset, next).toString("utf8").trim();
      if (line) {
        const row: unknown = JSON.parse(line);
        if (!object(row)) throw new Error("read-state-unavailable");
        const result = historyReadResult(provider, row, start + offset, checkpoint);
        if (result)
          results.push({
            result,
            baseline: start + next + 1 <= checkpoint.baselineEnd,
            position: start + offset,
          });
      }
      offset = next + 1;
    }
    const after = fstatSync(fd);
    if (after.ino !== stat.ino || after.size < stat.size) throw new Error("read-state-unavailable");
    checkpoint.offset += end;
    const complete = checkpoint.offset >= stat.size;
    const changed = ledger.observe(
      key,
      results,
      checkpoint,
      saved.complete || (checkpoint.offset >= checkpoint.baselineEnd && complete),
    );
    return { changed, complete };
  } finally {
    closeSync(fd);
  }
}
