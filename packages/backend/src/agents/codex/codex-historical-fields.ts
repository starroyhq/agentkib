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
const maxPolicyTailBytes = 8 * 1024 * 1024;
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

// Native rollout records name their type before the payload. Check the marker
// before decoding a candidate so a response mentioning it is skipped.
function startsTurnContext(line: Buffer): boolean {
  const marker = line.indexOf('"turn_context"');
  if (marker < 0) return false;
  const payload = line.indexOf('"payload"');
  return (
    (payload < 0 || marker < payload) &&
    turnContextMarker.test(line.subarray(Math.max(0, marker - 96), marker + 14).toString("utf8"))
  );
}

function readRows(
  bytes: Buffer,
  cwd: string,
  startsMidRow: boolean,
  policyOnly = false,
): CodexHistoricalSettings {
  const result: CodexHistoricalSettings = {};
  let hasSettings = policyOnly;
  let newerContext = false;
  // Only newline-terminated records are committed. Skip the partial record
  // where a bounded tail starts in the middle of a line.
  let end = bytes.lastIndexOf(10);
  if (startsTurnContext(bytes.subarray(end + 1)))
    result.nativePolicy = unconfirmedCodexNativePolicy;
  while (end >= 0 && (!hasSettings || (!policyOnly && !result.usage) || !result.nativePolicy)) {
    const start = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    if (start < 0 && startsMidRow) break;
    const line = bytes.subarray(start + 1, end);
    end = start;
    const settings =
      (!hasSettings || !result.nativePolicy) &&
      (policyOnly ? startsTurnContext(line) : line.includes('"turn_context"'));
    const usage = !policyOnly && !result.usage && line.includes('"token_count"');
    if (!settings && !usage) continue;
    let row: Record<string, unknown> | undefined;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      if (settings && !result.nativePolicy && startsTurnContext(line))
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
  return result;
}

function readPlainTail(fd: number, size: number, cwd: string, limit: number, policyOnly = false) {
  const offset = Math.max(0, size - limit);
  const start = Math.max(0, offset - 1);
  const bytes = bytesAt(fd, start, size - start);
  if (bytes.length !== size - start) return { nativePolicy: unconfirmedCodexNativePolicy };
  return offset
    ? readRows(bytes.subarray(1), cwd, bytes[0] !== 10, policyOnly)
    : readRows(bytes, cwd, false, policyOnly);
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
      const fields = readPlainTail(fd, size, cwd, tailBytes);
      if (fields.nativePolicy || size <= tailBytes) return fields;
      // Long turns can leave the policy behind many large response records. Expand
      // only the policy window, keeping the newest-context ordering across cuts.
      for (let limit = tailBytes * 2; limit <= maxPolicyTailBytes; limit *= 2) {
        fields.nativePolicy = readPlainTail(fd, size, cwd, limit, true).nativePolicy;
        if (fields.nativePolicy || size <= limit) break;
      }
      fields.nativePolicy ??= unconfirmedCodexNativePolicy;
      return fields;
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
    const fields = readRows(bytes.subarray(offset), cwd, offset > 0 && bytes[offset - 1] !== 10);
    if (offset > 0) fields.nativePolicy ??= unconfirmedCodexNativePolicy;
    return fields;
  } catch {
    return { nativePolicy: unconfirmedCodexNativePolicy };
  }
}
