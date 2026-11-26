import { lstat } from "node:fs/promises";
import { isReparseOrSymlink } from "../../native-files";
import { openSessionLog, SESSION_LOG_BLOCK_BYTES } from "../../session-log-reader";
import { sameClaudeTranscript } from "./claude-transcript-proof";

const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const USER = Buffer.from('"user"');
const ASSISTANT = Buffer.from('"assistant"');

/** Only complete native assistant results are eligible when another writer owns the source. */
export function completedClaudeForkResult(stopReason: unknown): boolean {
  return stopReason === "end_turn" || stopReason === "stop_sequence";
}

type ForkAnchor = { type: "user" | "assistant"; uuid: string; stopReason: unknown };
type ForkHistory = { anchor?: ForkAnchor; userUuid: unknown };

/** Read backwards in bounded blocks, stopping when enough native rows prove a cutoff. */
export async function readClaudeForkHistory(
  file: string,
  nativeId: string,
  validUuid: RegExp,
  idle: boolean,
): Promise<ForkHistory> {
  const expected = await lstat(file, { bigint: true });
  if (!expected.isFile() || isReparseOrSymlink(file, expected))
    throw new Error("invalid-Claude-transcript");
  const handle = await openSessionLog(file);
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameClaudeTranscript(expected, before))
      throw new Error("claude-session-fingerprint-changed");
    const size = Number(before.size);
    const floor = Math.max(0, size - MAX_TAIL_BYTES);
    let anchor: ForkAnchor | undefined;
    let userUuid: unknown;
    let sawUser = false;
    let parts: Buffer[] = [];
    const accept = (line: Buffer) => {
      if (!line.includes(USER) && !line.includes(ASSISTANT)) return false;
      let item: unknown;
      try {
        item = JSON.parse(line.toString("utf8"));
      } catch {
        // A malformed native row supplies no cutoff evidence.
        return false;
      }
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      if (row.sessionId !== nativeId || (row.type !== "user" && row.type !== "assistant"))
        return false;
      if (row.type === "user" && !sawUser) {
        userUuid = row.uuid;
        sawUser = true;
      }
      if (!anchor && typeof row.uuid === "string" && validUuid.test(row.uuid)) {
        const message = row.message;
        const stopReason =
          message && typeof message === "object" && "stop_reason" in message
            ? message.stop_reason
            : undefined;
        if (idle || (row.type === "assistant" && completedClaudeForkResult(stopReason)))
          anchor = { type: row.type, uuid: row.uuid, stopReason };
      }
      return (
        anchor &&
        (anchor.type === "user" || completedClaudeForkResult(anchor.stopReason) || sawUser)
      );
    };
    readTail: for (let end = size; end > floor;) {
      const start = Math.max(
        floor,
        Math.floor((end - 1) / SESSION_LOG_BLOCK_BYTES) * SESSION_LOG_BLOCK_BYTES,
      );
      const block = Buffer.allocUnsafe(end - start);
      let count = 0;
      while (count < block.length) {
        // A fork cutoff is control evidence. Share the descriptor, but read the
        // current bytes even if a display read has cached this block.
        const { bytesRead } = await handle.readCurrent(
          block,
          count,
          block.length - count,
          start + count,
        );
        if (!bytesRead) throw new Error("claude-session-fingerprint-changed");
        count += bytesRead;
      }
      let boundary = block.length;
      while (boundary > 0) {
        const newline = block.lastIndexOf(10, boundary - 1);
        if (newline < 0) break;
        const line = block.subarray(newline + 1, boundary);
        if (accept(parts.length ? Buffer.concat([line, ...parts.reverse()]) : line)) break readTail;
        parts = [];
        boundary = newline;
      }
      if (boundary) parts.push(block.subarray(0, boundary));
      // A line crossing the byte budget is not complete evidence.
      if (start === 0 && parts.length) accept(Buffer.concat(parts.reverse()));
      end = start;
    }
    const current = await lstat(file, { bigint: true });
    if (!sameClaudeTranscript(before, current) || isReparseOrSymlink(file, current))
      throw new Error("claude-session-fingerprint-changed");
    return { anchor, userUuid };
  } finally {
    await handle.close();
  }
}
