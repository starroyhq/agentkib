import type { BigIntStats } from "node:fs";
import { claudeReadReplyId } from "../../read-state-history";
import { claudeTurnStart } from "../../session-event-parser";
import { sessionLogIdentity } from "../../session-log-reader";
import {
  completeClaudeTail,
  MAX_CLAUDE_TAIL_BYTES,
  readVerifiedClaudeTail,
} from "./claude-terminal-turn-evidence";
import { sameClaudeTranscript } from "./claude-transcript-proof";

type TurnLink = {
  parent: string | null;
  order: number;
  when: number;
  startsTurn: boolean;
  endsTurn: boolean;
  reply: string | null | undefined;
};
type Window = { startedAt: string; completedAt: string };
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const cached = new Map<string, { version: BigIntStats; itemId?: string }>();
const object = (row: unknown): row is Record<string, unknown> =>
  row !== null && typeof row === "object" && !Array.isArray(row);
const uuid = (value: unknown) =>
  typeof value === "string" && idPattern.test(value) ? value : null;

function linkedReply(
  marker: TurnLink,
  nodes: Map<string, TurnLink | null>,
  startedAt: number,
): string | undefined {
  let link = marker;
  let itemId: string | undefined;
  while (link.parent) {
    const parent = nodes.get(link.parent);
    if (!parent || parent.order <= link.order || parent.endsTurn) return;
    if (parent.startsTurn) return itemId;
    if (itemId === undefined && parent.reply !== undefined) {
      // A second marker can point back to an answer from an older native turn, even
      // if the older marker is a sibling and therefore not part of this parent chain.
      if (parent.reply === null || !(parent.when >= startedAt && parent.when <= marker.when))
        return;
      itemId = parent.reply;
    }
    link = parent;
  }
}

async function replyInWindow(
  lines: AsyncIterable<Buffer>,
  nativeId: string,
  start: number,
  end: number,
  wholeFile: boolean,
): Promise<string | undefined> {
  const nodes = new Map<string, TurnLink | null>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let order = 0;
  let covered = wholeFile;
  let completion: TurnLink | undefined;
  for await (const line of lines) {
    const text = decoder.decode(line).trim();
    if (!text) continue;
    const row: unknown = JSON.parse(text);
    if (!object(row)) return;
    if (row.sessionId !== nativeId || row.isSidechain || row.isCompactSummary) continue;
    const endsTurn = row.type === "system" && row.subtype === "turn_duration" && !row.isMeta;
    const when = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const link = {
      parent: uuid(row.parentUuid),
      order: order++,
      when,
      startsTurn: claudeTurnStart(row, 0) !== undefined,
      endsTurn,
      reply: claudeReadReplyId(row),
    };
    if (endsTurn) {
      if (!Number.isFinite(when)) return;
      if (completion && when < start) covered = true;
      if (when >= start && when <= end) {
        // Count actual rows. A repeated completion of the same prompt is still ambiguous.
        if (completion || row.error != null) return;
        completion = link;
      }
    }
    const id = uuid(row.uuid);
    if (id) nodes.set(id, nodes.has(id) ? null : link);
    if (nodes.size > 8_192) return;
  }
  return covered && completion ? linkedReply(completion, nodes, start) : undefined;
}

/** Match a bridge receipt to a unique, linked native reply in the current transcript. */
export async function readClaudeBridgeReply(
  file: string,
  nativeId: string,
  window: Window,
): Promise<string | undefined> {
  const start = Date.parse(window.startedAt);
  const end = Date.parse(window.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return;
  const proof = await readVerifiedClaudeTail(file, async (log, version) => {
    const key = JSON.stringify([
      sessionLogIdentity(version),
      version.birthtimeNs.toString(),
      nativeId,
      start,
      end,
    ]);
    const previous = cached.get(key);
    if (previous && sameClaudeTranscript(previous.version, version)) return { key, ...previous };
    const size = Number(version.size);
    const itemId = await replyInWindow(
      completeClaudeTail(log, size),
      nativeId,
      start,
      end,
      size <= MAX_CLAUDE_TAIL_BYTES,
    );
    return { key, version, itemId };
  });
  if (!proof) return;
  const { key, version, itemId } = proof;
  cached.delete(key);
  if (cached.size >= 32) cached.delete(cached.keys().next().value!);
  cached.set(key, { version, itemId });
  return itemId;
}
