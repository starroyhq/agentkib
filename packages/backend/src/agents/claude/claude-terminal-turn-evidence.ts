import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isReparseOrSymlinkAsync } from "../../native-files";
import { nativeHistoryRules } from "../../session-event-parser";
import { hasText, messageText } from "../../session-events";
import {
  openSessionLog,
  SESSION_LOG_BLOCK_BYTES,
  sessionLogIdentity,
  type SessionLogSnapshot,
} from "../../session-log-reader";
import { sameClaudeTranscript } from "./claude-transcript-proof";

export const MAX_CLAUDE_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_TURNS = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const turnStart = nativeHistoryRules["claude-code"]!.turnStart;

export interface ClaudeTerminalTurnEvidence {
  transcriptIdentity: string;
  promptId: string;
  completed: boolean;
}

type Link = { parentId: string; order: number };
type Node = Link & { kind: "attachment" | "message" | "answer" };
type NativeTurn = Omit<ClaudeTerminalTurnEvidence, "transcriptIdentity">;
const evidenceCache = new Map<string, { version: BigIntStats; turn: NativeTurn }>();

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && uuidPattern.test(value) ? value : undefined;
}

export async function* completeClaudeTail(
  log: SessionLogSnapshot,
  size: number,
): AsyncGenerator<Buffer> {
  const floor = Math.max(0, size - MAX_CLAUDE_TAIL_BYTES);
  let fragments: Buffer[] = [];
  for (let end = size; end > floor;) {
    const start = Math.max(
      floor,
      Math.floor((end - 1) / SESSION_LOG_BLOCK_BYTES) * SESSION_LOG_BLOCK_BYTES,
    );
    const block = Buffer.allocUnsafe(end - start);
    let filled = 0;
    while (filled < block.length) {
      // Share the descriptor with other readers, while proving this version from its current bytes.
      const { bytesRead } = await log.readCurrent(
        block,
        filled,
        block.length - filled,
        start + filled,
      );
      if (!bytesRead) return;
      filled += bytesRead;
    }
    // An unfinished newer prompt could otherwise make an older completion look current.
    if (end === size && block.at(-1) !== 10) return;
    let boundary = block.length;
    while (boundary > 0) {
      const newline = block.lastIndexOf(10, boundary - 1);
      if (newline < 0) break;
      const line = block.subarray(newline + 1, boundary);
      yield fragments.length ? Buffer.concat([line, ...fragments.reverse()]) : line;
      fragments = [];
      boundary = newline;
    }
    if (boundary) fragments.push(block.subarray(0, boundary));
    // Drop a line cut by the tail budget. Only byte zero gives the first line a boundary.
    if (start === 0 && fragments.length) yield Buffer.concat(fragments.reverse());
    end = start;
  }
}

function provesCompletion(marker: Link, promptId: string, nodes: ReadonlyMap<string, Node>) {
  let link = marker;
  let answered = false;
  while (link.parentId !== promptId) {
    const parent = nodes.get(link.parentId);
    if (!parent || parent.order <= link.order) return false;
    if (!answered && parent.kind !== "attachment") {
      if (parent.kind !== "answer") return false;
      answered = true;
    }
    link = parent;
  }
  return answered;
}

async function latestTurn(lines: AsyncIterable<Buffer>, nativeId: string) {
  const nodes = new Map<string, Node>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let order = 0;
  let marker: Link | undefined;
  let sawNewerResponseOrEnd = false;
  for await (const line of lines) {
    const text = decoder.decode(line).trim();
    if (!text) continue;
    const row: unknown = JSON.parse(text);
    if (!object(row)) return undefined;
    if (row.sessionId !== nativeId || row.isSidechain || row.isCompactSummary) continue;
    const id = uuid(row.uuid);
    const parentId = uuid(row.parentUuid);
    order++;
    if (turnStart(row, 0) !== undefined) {
      // A known older bridge report opens a turn too, but metadata is not a proof of its start.
      return row.type === "user" && !row.isMeta && id && !nodes.has(id)
        ? { promptId: id, completed: !!marker && provesCompletion(marker, id, nodes) }
        : undefined;
    }
    if (row.isMeta) continue;
    if (row.type === "system" && row.subtype === "turn_duration") {
      // The first completion boundary is the only candidate, even if its evidence is incomplete.
      if (!sawNewerResponseOrEnd && id && parentId && row.error == null)
        marker = { parentId, order };
      sawNewerResponseOrEnd = true;
      continue;
    }
    if (row.type === "assistant") sawNewerResponseOrEnd = true;
    if (row.type !== "assistant" && row.type !== "user" && row.type !== "attachment") continue;
    if (!id || !parentId || nodes.has(id)) return undefined;
    const message = row.message;
    const answer =
      row.type === "assistant" &&
      row.isSynthetic !== true &&
      object(message) &&
      message.role === "assistant" &&
      message.model !== "<synthetic>" &&
      message.stop_reason === "end_turn" &&
      hasText(messageText(message.content));
    nodes.set(id, {
      parentId,
      order,
      kind: row.type === "attachment" ? "attachment" : answer ? "answer" : "message",
    });
  }
  return undefined;
}

/** Read only the current file version, including after a replace or a write during the read. */
export async function readVerifiedClaudeTail<T>(
  transcript: string,
  read: (log: SessionLogSnapshot, version: BigIntStats) => Promise<T | undefined>,
): Promise<T | undefined> {
  try {
    const log = await openSessionLog(transcript);
    try {
      const before = await log.stat({ bigint: true });
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      const result = await read(log, before);
      if (result === undefined) return undefined;
      const after = await log.stat({ bigint: true });
      const current = await lstat(transcript, { bigint: true });
      if (
        !sameClaudeTranscript(before, after) ||
        !sameClaudeTranscript(before, current) ||
        (await isReparseOrSymlinkAsync(transcript, current))
      )
        return undefined;
      return result;
    } finally {
      await log.close();
    }
  } catch {
    // Missing files, partial writes and malformed records cannot establish a completion.
    return undefined;
  }
}

/** The terminal's latest prompt and explicit completion, from a stable bounded native tail. */
export async function readClaudeTerminalTurnEvidence(
  transcript: string,
  nativeId: string,
): Promise<ClaudeTerminalTurnEvidence | undefined> {
  const evidence = await readVerifiedClaudeTail(transcript, async (log, version) => {
    const transcriptIdentity = `${sessionLogIdentity(version)}:${version.birthtimeNs}`;
    const key = `${nativeId}\0${transcriptIdentity}`;
    const saved = evidenceCache.get(key);
    const turn =
      saved && sameClaudeTranscript(saved.version, version)
        ? saved.turn
        : await latestTurn(completeClaudeTail(log, Number(version.size)), nativeId);
    return turn && { turn, key, transcriptIdentity, version };
  });
  if (!evidence) return undefined;
  const { turn, key, transcriptIdentity, version } = evidence;
  evidenceCache.delete(key);
  if (evidenceCache.size >= MAX_CACHED_TURNS)
    evidenceCache.delete(evidenceCache.keys().next().value!);
  evidenceCache.set(key, { version, turn });
  return { ...turn, transcriptIdentity };
}
