import { readSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { projectContextUsage } from "./context-usage";
import { isCompressedRollout } from "./codex-rollout-files";
import { jsonTimestamp } from "./session-history";

export interface CodexHistoricalSettings {
  modelId?: string;
  effort?: string;
  usage?: { usedTokens: number; contextWindow: number; updatedAt?: string };
}

const tailBytes = 512 * 1024;
const maxCompressedBytes = 512 * 1024;
const maxDecompressedBytes = 4 * 1024 * 1024;

function bytesAt(fd: number, offset: number, length: number) {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(fd, bytes, count, bytes.length - count, offset + count);
    if (!read) break;
    count += read;
  }
  return bytes.subarray(0, count);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function codexHistoricalSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 128 && !/\p{Cc}/u.test(value)
    ? value.trim()
    : undefined;
}

function readRows(bytes: Buffer, isTail: boolean): CodexHistoricalSettings {
  const result: CodexHistoricalSettings = {};
  let hasSettings = false;
  // Only newline-terminated records are committed. Skip the partial record
  // where a bounded tail starts in the middle of a line.
  let end = bytes.lastIndexOf(10);
  while (end >= 0 && (!hasSettings || !result.usage)) {
    const start = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    if (start < 0 && isTail) break;
    const line = bytes.subarray(start + 1, end);
    end = start;
    const settings = !hasSettings && line.includes('"turn_context"');
    const usage = !result.usage && line.includes('"token_count"');
    if (!settings && !usage) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      continue;
    }
    const payload = record(row?.payload);
    if (!payload) continue;
    if (settings && row?.type === "turn_context") {
      const modelId = codexHistoricalSetting(payload.model);
      const effort = codexHistoricalSetting(payload.effort ?? payload.reasoning_effort);
      if (!modelId && !effort) continue;
      result.modelId = modelId;
      result.effort = effort;
      hasSettings = true;
    } else if (usage && row?.type === "event_msg" && payload.type === "token_count") {
      const info = record(payload.info) ?? payload;
      const projected = projectContextUsage({
        available: true,
        tokenUsage: { last: info.last_token_usage, modelContextWindow: info.model_context_window },
      });
      if (projected?.usedTokens === undefined || projected.contextWindow === undefined) continue;
      const updatedAt = jsonTimestamp(row.timestamp);
      result.usage = {
        usedTokens: projected.usedTokens,
        contextWindow: projected.contextWindow,
        ...(updatedAt ? { updatedAt } : {}),
      };
    }
  }
  return result;
}

/** Read the latest retained display evidence from an already verified descriptor. */
export function readCodexHistoricalFields(
  fd: number,
  file: string,
  size: number,
): CodexHistoricalSettings {
  if (!isCompressedRollout(file)) {
    const offset = Math.max(0, size - tailBytes);
    if (!offset) return readRows(bytesAt(fd, 0, size), false);
    const bytes = bytesAt(fd, offset - 1, tailBytes + 1);
    return readRows(bytes.subarray(1), bytes[0] !== 10);
  }
  // Zstandard rollouts are sequential. Only decode small frames for this
  // optional metadata read. The history reader owns any decompressed copy.
  if (size > maxCompressedBytes) return {};
  try {
    const bytes = zstdDecompressSync(bytesAt(fd, 0, size), {
      maxOutputLength: maxDecompressedBytes,
    });
    const offset = Math.max(0, bytes.length - tailBytes);
    return readRows(bytes.subarray(offset), offset > 0 && bytes[offset - 1] !== 10);
  } catch {
    return {};
  }
}
