import { readSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { projectContextUsage } from "../../context-usage";
import { isCompressedRollout } from "./codex-rollout-files";
import { jsonTimestamp } from "../../session-history";
import {
  readCodexNativeTurnPolicy,
  unconfirmedCodexNativePolicy,
  type CodexNativePolicy,
} from "./codex-native-policy";

export interface CodexHistoricalSettings {
  modelId?: string;
  effort?: string;
  usage?: { usedTokens: number; contextWindow: number; updatedAt?: string };
  nativePolicy?: CodexNativePolicy;
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

const turnContextMarker = /"type"\s*:\s*"turn_context"/u;

function readRows(
  bytes: Buffer,
  cwd: string,
  prefix: "included" | "omitted" | "partial-row",
): CodexHistoricalSettings {
  const result: CodexHistoricalSettings = {};
  let hasSettings = false;
  let newerContext = false;
  // Only newline-terminated records are committed. Skip the partial record
  // where a bounded tail starts in the middle of a line.
  let end = bytes.lastIndexOf(10);
  if (turnContextMarker.test(bytes.subarray(end + 1).toString("utf8")))
    result.nativePolicy = unconfirmedCodexNativePolicy;
  while (end >= 0 && (!hasSettings || !result.usage || !result.nativePolicy)) {
    const start = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    if (start < 0 && prefix === "partial-row") break;
    const line = bytes.subarray(start + 1, end);
    end = start;
    const settings = (!hasSettings || !result.nativePolicy) && line.includes('"turn_context"');
    const usage = !result.usage && line.includes('"token_count"');
    if (!settings && !usage) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      if (settings && !result.nativePolicy && turnContextMarker.test(line.toString("utf8")))
        result.nativePolicy = unconfirmedCodexNativePolicy;
      continue;
    }
    const payload = record(row?.payload);
    if (settings && row?.type === "turn_context") {
      if (!result.nativePolicy) {
        const policy = payload
          ? readCodexNativeTurnPolicy(payload, cwd)
          : unconfirmedCodexNativePolicy;
        // If newer turns stopped reporting permissions, a prior policy is no longer current.
        if (policy) result.nativePolicy = newerContext ? unconfirmedCodexNativePolicy : policy;
        newerContext = true;
      }
      if (!hasSettings && payload) {
        const modelId = codexHistoricalSetting(payload.model);
        const effort = codexHistoricalSetting(payload.effort ?? payload.reasoning_effort);
        if (modelId || effort) {
          result.modelId = modelId;
          result.effort = effort;
          hasSettings = true;
        }
      }
    } else if (usage && row?.type === "event_msg" && payload?.type === "token_count") {
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
  if (prefix !== "included") result.nativePolicy ??= unconfirmedCodexNativePolicy;
  return result;
}

/** Read the latest retained display evidence from an already verified descriptor. */
export function readCodexHistoricalFields(
  fd: number,
  file: string,
  size: number,
  cwd: string,
): CodexHistoricalSettings {
  try {
    if (!isCompressedRollout(file)) {
      const offset = Math.max(0, size - tailBytes);
      const start = Math.max(0, offset - 1);
      const bytes = bytesAt(fd, start, size - start);
      if (bytes.length !== size - start) return { nativePolicy: unconfirmedCodexNativePolicy };
      if (!offset) return readRows(bytes, cwd, "included");
      return readRows(bytes.subarray(1), cwd, bytes[0] === 10 ? "omitted" : "partial-row");
    }
    // Zstandard rollouts are sequential. Only decode small frames for this
    // metadata read. The history reader owns any decompressed copy.
    if (size > maxCompressedBytes) return { nativePolicy: unconfirmedCodexNativePolicy };
    const compressed = bytesAt(fd, 0, size);
    if (compressed.length !== size) return { nativePolicy: unconfirmedCodexNativePolicy };
    const bytes = zstdDecompressSync(compressed, {
      maxOutputLength: maxDecompressedBytes,
    });
    const offset = Math.max(0, bytes.length - tailBytes);
    if (!offset) return readRows(bytes, cwd, "included");
    return readRows(
      bytes.subarray(offset),
      cwd,
      bytes[offset - 1] === 10 ? "omitted" : "partial-row",
    );
  } catch {
    return { nativePolicy: unconfirmedCodexNativePolicy };
  }
}
