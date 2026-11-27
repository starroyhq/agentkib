import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import type { ConversationReadResult } from "@agentkib/runtime-protocol";
import { claudeReadReplyId } from "../../read-state-history";
import { claudeTurnStart } from "../../session-event-parser";
import { sessionLogIdentity } from "../../session-log-reader";
import type { ReadStateResultProof } from "../../sessions/read-state-provider";
import {
  completeClaudeTail,
  MAX_CLAUDE_TAIL_BYTES,
  readVerifiedClaudeTail,
} from "./claude-terminal-turn-evidence";

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
const cached = new Map<string, string | undefined>();
const scans = new Map<string, Promise<string | undefined>>();
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

function transcriptGeneration(version: BigIntStats): string {
  return [
    sessionLogIdentity(version),
    version.birthtimeNs,
    version.size,
    version.mtimeNs,
    version.ctimeNs,
  ].join(":");
}

/** Bind the recorded result to the current transcript, including any reply inferred for a bridge turn. */
export async function verifyClaudeReadResult(
  file: string,
  nativeId: string,
  result: ConversationReadResult,
  window?: Window,
): Promise<ReadStateResultProof | undefined> {
  const start = window ? Date.parse(window.startedAt) : NaN;
  const end = window ? Date.parse(window.completedAt) : NaN;
  let ownedScan: { key: string; promise: Promise<string | undefined> } | undefined;
  try {
    const current = await readVerifiedClaudeTail(file, async (log, version) => {
      const generation = transcriptGeneration(version);
      // Native and managed observations already identify the recorded row. Only a bridge
      // receipt without that identity needs the bounded native parent-chain scan.
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
        return { generation, key: undefined, anchor: undefined };
      // Restrict reuse to a single path when filesystem identity is unavailable.
      const pathScope = version.dev && version.ino ? null : file;
      const key = JSON.stringify([pathScope, generation, nativeId, start, end]);
      if (cached.has(key)) return { generation, key, anchor: cached.get(key) };
      let promise = scans.get(key);
      if (!promise) {
        const size = Number(version.size);
        promise = replyInWindow(
          completeClaudeTail(log, size),
          nativeId,
          start,
          end,
          size <= MAX_CLAUDE_TAIL_BYTES,
        );
        scans.set(key, promise);
        ownedScan = { key, promise };
      }
      // Every caller still verifies its descriptor and current path after the shared scan.
      return { generation, key, anchor: await promise };
    });
    if (!current) return;
    if (current.key !== undefined) {
      cached.delete(current.key);
      if (cached.size >= 32) cached.delete(cached.keys().next().value!);
      cached.set(current.key, current.anchor);
    }
    const itemId = current.anchor ?? result.itemId;
    const evidence = createHash("sha256")
      .update(
        JSON.stringify([
          nativeId,
          current.generation,
          result.id,
          result.turnId,
          result.itemId,
          result.outcome,
          result.completedAt,
          start,
          end,
          itemId,
        ]),
      )
      .digest("hex");
    return Object.freeze({ itemId, evidence });
  } finally {
    if (ownedScan && scans.get(ownedScan.key) === ownedScan.promise) scans.delete(ownedScan.key);
  }
}
