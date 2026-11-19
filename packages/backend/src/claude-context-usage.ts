import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { ContextUsage } from "./context-usage";
import {
  normalizeObservedPermissionMode,
  type ClaudeObservedPermissionMode,
} from "./claude-managed-runner";

const TAIL_BYTES = 128 * 1024;
const SETTINGS_TAIL_BYTES = 2 * 1024 * 1024;
const TERMINAL_USAGE_TAIL_BYTES = 4 * 1024 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const unavailable = (): ContextUsage => ({ available: false, state: "unavailable" });
export type ClaudeTranscriptObservation = {
  usage: ContextUsage;
  model?: string;
  permissionMode?: ClaudeObservedPermissionMode | null;
};
const cachedReports = new Map<
  string,
  { version: string; bytes: number; observation: ClaudeTranscriptObservation }
>();
const copy = ({
  usage,
  model,
  permissionMode,
}: ClaudeTranscriptObservation): ClaudeTranscriptObservation => ({
  usage: { ...usage },
  ...(model ? { model } : {}),
  ...(permissionMode !== undefined ? { permissionMode } : {}),
});

/** Read recent display metadata from a verified Claude transcript without restoring the session. */
export function readClaudeTranscriptObservation(
  transcript: string,
  nativeId: string,
  searchEarlier: boolean | "terminal-usage" = false,
): ClaudeTranscriptObservation {
  let fd: number | undefined;
  const missing = { usage: unavailable() };
  try {
    const metadata = lstatSync(transcript);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return missing;
    const key = `${nativeId}\0${transcript}`;
    const version = [
      metadata.dev,
      metadata.ino,
      metadata.size,
      metadata.mtimeMs,
      metadata.ctimeMs,
    ].join(":");
    // Terminal resume can append several large metadata records after the last
    // compaction without reporting newer usage. Keep normal reads on the small tail.
    const limit =
      searchEarlier === "terminal-usage"
        ? TERMINAL_USAGE_TAIL_BYTES
        : searchEarlier
          ? SETTINGS_TAIL_BYTES
          : TAIL_BYTES;
    const bytes = Math.min(metadata.size, limit);
    const cached = cachedReports.get(key);
    if (
      cached?.version === version &&
      (cached.bytes >= bytes ||
        (cached.observation.model &&
          cached.observation.usage.available &&
          cached.observation.permissionMode !== undefined))
    )
      return copy(cached.observation);
    fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.ino !== metadata.ino || before.dev !== metadata.dev)
      return missing;
    const start = Math.max(0, before.size - bytes);
    const buffer = Buffer.allocUnsafe(before.size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const size = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (!size) break;
      filled += size;
    }
    const after = fstatSync(fd);
    const current = lstatSync(transcript);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.size !== after.size ||
      current.mtimeMs !== after.mtimeMs ||
      current.ctimeMs !== after.ctimeMs ||
      filled !== buffer.length
    )
      return missing;
    const tail = buffer.subarray(0, filled);
    const first = start > 0 ? tail.indexOf(10) + 1 : 0;
    const observation =
      start > 0 && first === 0
        ? missing
        : observeClaudeTranscript(tail.subarray(first).toString("utf8"), nativeId);
    if (
      before.size === metadata.size &&
      before.mtimeMs === metadata.mtimeMs &&
      before.ctimeMs === metadata.ctimeMs &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs
    ) {
      if (cachedReports.size >= 256) cachedReports.delete(cachedReports.keys().next().value!);
      cachedReports.set(key, { version, bytes, observation });
    }
    return copy(observation);
  } catch {
    // Usage is optional display metadata; a failed read never changes execution eligibility.
    return missing;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function observeClaudeTranscript(text: string, nativeId: string): ClaudeTranscriptObservation {
  let latest:
    | { model?: string; usedTokens: number; updatedAt?: string; afterCompaction?: true }
    | undefined;
  let lastModel: string | undefined;
  let permissionMode: ClaudeObservedPermissionMode | null | undefined;
  const windows = new Map<string, number>();
  for (const line of text.split("\n")) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !object(row) ||
      (row.sessionId ?? row.session_id) !== nativeId ||
      (row.sessionId !== undefined && row.sessionId !== nativeId) ||
      (row.session_id !== undefined && row.session_id !== nativeId) ||
      row.isSidechain === true ||
      (row.parent_tool_use_id !== undefined && row.parent_tool_use_id !== null)
    )
      continue;
    if (row.type === "permission-mode") {
      // Native last-wins session state; user-message snapshots and global defaults are not current modes.
      permissionMode = normalizeObservedPermissionMode(row.permissionMode);
      continue;
    }
    if (row.type === "system" && row.subtype === "compact_boundary") {
      // Claude can record the resulting occupancy on the boundary itself. Older
      // versions only recorded preTokens, which cannot describe this context.
      const usedTokens = object(row.compactMetadata) ? row.compactMetadata.postTokens : undefined;
      latest = count(usedTokens)
        ? {
            usedTokens,
            model: lastModel,
            updatedAt: reportTime(row.timestamp),
            afterCompaction: true,
          }
        : undefined;
      windows.clear();
      continue;
    }
    if (row.type === "result" && object(row.modelUsage)) {
      for (const [model, usage] of Object.entries(row.modelUsage)) {
        if (object(usage) && count(usage.contextWindow) && usage.contextWindow > 0)
          windows.set(model, usage.contextWindow);
      }
      continue;
    }
    if (row.type !== "assistant" || row.isCompactSummary === true || !object(row.message)) continue;
    const message = row.message;
    if (
      typeof message.model !== "string" ||
      !message.model ||
      message.model === "<synthetic>" ||
      message.model.length > 128
    )
      continue;
    if (lastModel !== message.model) latest = undefined;
    lastModel = message.model;
    if (!object(message.usage)) continue;
    let usage = message.usage;
    if (Array.isArray(usage.iterations) && usage.iterations.length) {
      const last = [...usage.iterations]
        .reverse()
        .find(
          (item) => object(item) && !["advisor_message", "compaction"].includes(String(item.type)),
        );
      if (!object(last) || !["message", "fallback_message"].includes(String(last.type))) continue;
      usage = last;
    }
    const input = usage.input_tokens;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    if (
      !count(input) ||
      !count(cacheRead) ||
      !count(cacheCreation) ||
      !count(input + cacheRead + cacheCreation)
    ) {
      latest = undefined;
      continue;
    }
    latest = {
      model: message.model,
      usedTokens: input + cacheRead + cacheCreation,
      updatedAt: reportTime(row.timestamp),
    };
  }
  const model = {
    ...(lastModel ? { model: lastModel } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
  if (!latest) return { ...model, usage: unavailable() };
  const contextWindow = latest.model ? windows.get(latest.model) : undefined;
  return {
    ...model,
    usage: {
      available: true,
      state: "stale",
      historical: true,
      usedTokens: latest.usedTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(latest.afterCompaction
        ? { reason: "claude-post-compaction-usage" }
        : contextWindow === undefined
          ? { reason: "model-context-window-unavailable" }
          : {}),
      ...(latest.updatedAt ? { updatedAt: latest.updatedAt } : {}),
    },
  };
}

function reportTime(value: unknown) {
  const date = typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
