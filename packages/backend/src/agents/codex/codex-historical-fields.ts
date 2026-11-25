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
const policyBlockBytes = 256 * 1024;
const maxPolicyTailBytes = 64 * 1024 * 1024;
const maxPolicyRowBytes = 8 * 1024 * 1024;
const maxCompressedBytes = 512 * 1024;
const maxDecompressedBytes = 4 * 1024 * 1024;
const maxCompressedPolicyBytes = 16 * 1024 * 1024;

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

function readRows(bytes: Buffer, cwd: string, startsMidRow: boolean): CodexHistoricalSettings {
  const result: CodexHistoricalSettings = {};
  let hasSettings = false;
  let newerContext = false;
  // Only newline-terminated records are committed. Skip the partial record
  // where a bounded tail starts in the middle of a line.
  let end = bytes.lastIndexOf(10);
  if (startsTurnContext(bytes.subarray(end + 1)))
    result.nativePolicy = unconfirmedCodexNativePolicy;
  while (end >= 0 && (!hasSettings || !result.usage || !result.nativePolicy)) {
    const start = end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
    if (start < 0 && startsMidRow) break;
    const line = bytes.subarray(start + 1, end);
    end = start;
    const settings = (!hasSettings || !result.nativePolicy) && line.includes('"turn_context"');
    const usage = !result.usage && line.includes('"token_count"');
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

function readPlainTail(fd: number, size: number, cwd: string) {
  const offset = Math.max(0, size - tailBytes);
  const start = Math.max(0, offset - 1);
  const bytes = bytesAt(fd, start, size - start);
  if (bytes.length !== size - start) return { nativePolicy: unconfirmedCodexNativePolicy };
  return offset ? readRows(bytes.subarray(1), cwd, bytes[0] !== 10) : readRows(bytes, cwd, false);
}

// The native serializer puts these header fields before the payload. This lets
// us skip a large non-context record without buffering or decoding its payload.
const nativeRowType =
  /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"([a-z_]+)"\s*[,}]/u;

function scanNativePolicy(
  read: (offset: number, length: number) => Buffer,
  size: number,
  cwd: string,
): CodexNativePolicy {
  const earliest = Math.max(0, size - maxPolicyTailBytes);
  let rowEnd = size;
  let terminated = false;
  let newerContext = false;

  const inspect = (block: Buffer, offset: number, rowStart: number) => {
    const length = rowEnd - rowStart;
    if (!length) return;
    let line = block.subarray(rowStart - offset, rowEnd - offset);
    if (line.length !== length) {
      const prefixLength = Math.min(1024, length);
      const prefix = line.length >= prefixLength ? line : read(rowStart, prefixLength);
      if (prefix.length < prefixLength) return unconfirmedCodexNativePolicy;
      const type = nativeRowType.exec(prefix.subarray(0, prefixLength).toString("utf8"))?.[1];
      if (type && type !== "turn_context") return;
      if (length > maxPolicyRowBytes) return unconfirmedCodexNativePolicy;
      line = read(rowStart, length);
      if (line.length !== length) return unconfirmedCodexNativePolicy;
    }
    if (!line.includes('"turn_context"')) return;

    let row: Record<string, unknown> | undefined;
    try {
      row = record(JSON.parse(line.toString("utf8")));
    } catch {
      if (startsTurnContext(line)) return unconfirmedCodexNativePolicy;
      return;
    }
    if (row?.type !== "turn_context") return;
    const payload = record(row.payload);
    if (!terminated || !payload) return unconfirmedCodexNativePolicy;
    const policy = readCodexNativeTurnPolicy(payload, cwd);
    if (policy) return newerContext ? unconfirmedCodexNativePolicy : policy;
    newerContext = true;
  };

  for (let next = size; next > earliest;) {
    const offset = Math.max(earliest, next - policyBlockBytes);
    const block = read(offset, next - offset);
    if (block.length !== next - offset) return unconfirmedCodexNativePolicy;
    for (
      let separator = block.lastIndexOf(10);
      separator >= 0;
      separator = separator ? block.lastIndexOf(10, separator - 1) : -1
    ) {
      const policy = inspect(block, offset, offset + separator + 1);
      if (policy) return policy;
      rowEnd = offset + separator;
      terminated = true;
    }
    if (!offset) return inspect(block, 0, 0) ?? unconfirmedCodexNativePolicy;
    next = offset;
  }
  return unconfirmedCodexNativePolicy;
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
      const fields = readPlainTail(fd, size, cwd);
      if (!fields.nativePolicy && size > tailBytes)
        fields.nativePolicy = scanNativePolicy(
          (offset, length) => bytesAt(fd, offset, length),
          size,
          cwd,
        );
      return fields;
    }
    // Zstandard rollouts are sequential. Keep a hard input and output budget,
    // and use the larger budget only for policy, leaving display fallbacks alone.
    if (size > maxCompressedPolicyBytes) return { nativePolicy: unconfirmedCodexNativePolicy };
    const compressed = bytesAt(fd, 0, size);
    if (compressed.length !== size) return { nativePolicy: unconfirmedCodexNativePolicy };
    const bytes = zstdDecompressSync(compressed, { maxOutputLength: maxPolicyTailBytes });
    const offset = Math.max(0, bytes.length - tailBytes);
    const showDisplay = size <= maxCompressedBytes && bytes.length <= maxDecompressedBytes;
    const fields: CodexHistoricalSettings = showDisplay
      ? readRows(bytes.subarray(offset), cwd, offset > 0 && bytes[offset - 1] !== 10)
      : {};
    if (!fields.nativePolicy && (offset > 0 || !showDisplay))
      fields.nativePolicy = scanNativePolicy(
        (start, length) => bytes.subarray(start, start + length),
        bytes.length,
        cwd,
      );
    return fields;
  } catch {
    return { nativePolicy: unconfirmedCodexNativePolicy };
  }
}
