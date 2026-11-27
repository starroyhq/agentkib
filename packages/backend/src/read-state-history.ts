import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { ConversationReadResult } from "@agentkib/runtime-protocol";
import { ReadStateLedger, type ReadCheckpoint } from "./read-state-ledger";
import { jsonTimestamp } from "./session-history";
import { hasText, messageText, trimWhitespace } from "./session-events";
import { claudeTurnStart } from "./session-event-parser";
import { isReparseOrSymlink } from "./native-files";

const SLICE_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const messageId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const visibleClaudeText = (value: string | null): value is string =>
  hasText(value) &&
  !["<local-command-", "<command-name>", "<command-message>"].some((prefix) =>
    trimWhitespace(value).startsWith(prefix),
  );

/** undefined leaves the current reply alone, while null is visible text without a stable ID. */
export function claudeReadReplyId(row: Record<string, unknown>): string | null | undefined {
  if (row.type !== "assistant" || row.isMeta || row.isSidechain || row.isCompactSummary) return;
  const message = object(row.message) ? row.message : null;
  const content = message?.content;
  if (!visibleClaudeText(messageText(content))) return;
  const id = [row.uuid, message?.id].find(
    (value): value is string => typeof value === "string" && messageId.test(value),
  );
  if (!id) return null;
  if (!Array.isArray(content)) return id;
  for (let index = content.length - 1; index >= 0; index--) {
    const block: unknown = content[index];
    if (object(block) && block.type === "text" && visibleClaudeText(text(block.text)))
      return index === 0 ? id : `${id}:text:${index}`;
  }
  return null;
}

function codexTerminalOutcome(
  payload: Record<string, unknown>,
): ConversationReadResult["outcome"] | null {
  if (payload.type === "turn_aborted") return "cancelled";
  if (payload.type === "task_complete") return payload.error == null ? "completed" : "failed";
  return null;
}

/** Check only the verified transcript's recent complete records for the named native turns. */
export function codexTerminalResults(
  file: string,
  turnIds: ReadonlySet<string>,
): Map<string, ConversationReadResult> {
  const results = new Map<string, ConversationReadResult>();
  let fd: number | undefined;
  try {
    const expected = lstatSync(file);
    if (!expected.isFile() || isReparseOrSymlink(file, expected)) return results;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== expected.dev || stat.ino !== expected.ino) return results;
    const start = Math.max(0, stat.size - SLICE_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    let read = 0;
    while (read < bytes.length) {
      const length = readSync(fd, bytes, read, bytes.length - read, start + read);
      if (!length) return results;
      read += length;
    }
    let end = bytes.lastIndexOf(10);
    const firstComplete = start > 0 ? bytes.indexOf(10) + 1 : 0;
    while (end >= firstComplete && results.size < turnIds.size) {
      const previous = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
      const line = bytes.subarray(previous + 1, end);
      end = previous;
      if (line.indexOf('"turn_aborted"') < 0 && line.indexOf('"task_complete"') < 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      if (!object(row) || row.type !== "event_msg" || !object(row.payload)) continue;
      const turnId = text(row.payload.turn_id) ?? text(row.turn_id);
      if (!turnId || !turnIds.has(turnId) || results.has(turnId)) continue;
      const outcome = codexTerminalOutcome(row.payload);
      if (outcome)
        results.set(turnId, {
          id: `turn:${turnId}`,
          turnId,
          itemId: null,
          outcome,
          completedAt: jsonTimestamp(row.timestamp),
        });
    }
    return results;
  } catch {
    return results;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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
    const outcome = codexTerminalOutcome(payload);
    if (!outcome) return null;
    return {
      id: turnId ? `turn:${turnId}` : `record:${position}`,
      turnId,
      itemId: cursor.lastItemId,
      outcome,
      completedAt: jsonTimestamp(row.timestamp),
    };
  }
  const internal = row.isMeta === true || row.isSidechain === true || row.isCompactSummary === true;
  const turnStart = claudeTurnStart(row, position);
  if (turnStart !== undefined) {
    cursor.lastTurnId = text(row.uuid) ?? (object(row.message) ? text(row.message.id) : null);
    // A new prompt cannot inherit the preceding turn's visible reply.
    cursor.lastItemId = null;
  }
  const itemId = claudeReadReplyId(row);
  if (itemId !== undefined) cursor.lastItemId = itemId;
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
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino)
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
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
      if (!count) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
      length += count;
    }
    const newline = bytes.lastIndexOf(10);
    const end = newline + 1;
    if (end === 0 && size === SLICE_BYTES)
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
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
        if (!object(row)) throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
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
    if (after.ino !== stat.ino || after.size < stat.size)
      throw new Error(REMOTE_ERROR_CODES.readStateUnavailableDetail);
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
