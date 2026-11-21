import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Dirent,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "../../native-files";

/**
 * Format probe for native Claude Code imports.
 *
 * AgentKib writes `user` and `assistant` records, so it only needs proof that the installed CLI
 * still produces records of that shape. A current transcript starts with a handful of metadata
 * records (`mode`, `permission-mode`, `queue-operation`, `file-history-snapshot`, `ai-title`,
 * `custom-title`, `agent-name`, `last-prompt`, `system`, `attachment`, and whatever comes next)
 * before its first message, so the probe walks the opening of the newest main session file and
 * skips every record that is not a `user` or `assistant` record instead of enumerating them.
 *
 * The probe fails closed: it passes only when a conforming `user` or `assistant` record appears
 * inside the window, and every line it has to read on the way must be a well-formed JSON object.
 */

/** Lines examined at the start of a transcript. */
export const PROBE_MAX_RECORDS = 64;
/** Bytes read from the start of a transcript; also the longest line the probe will accept. */
export const PROBE_MAX_BYTES = 4 * 1024 * 1024;

/** Main sessions are `<uuid>.jsonl`; subagent transcripts use other names or deeper directories. */
const mainSessionFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export type ClaudeSessionProbeFailure =
  | "unreadable"
  | "empty"
  | "malformed-record"
  | "record-too-large"
  | "unexpected-record-shape"
  | "no-conforming-record";

export type ClaudeSessionProbe =
  /** `file` is null when `projects/` holds no main session yet, so nothing contradicts the format. */
  | { ok: true; file: string | null }
  | { ok: false; file: string; reason: ClaudeSessionProbeFailure };

/** Judge the format of the most recently modified main session below `<config>/projects`. */
export function probeClaudeSessionFormat(projectsRoot: string): ClaudeSessionProbe {
  const discovered = latestMainSession(projectsRoot);
  if (!discovered.ok || discovered.file === null) return discovered;
  const { file } = discovered;
  const reason = inspectOpening(file);
  return reason === null ? { ok: true, file } : { ok: false, file, reason };
}

/** Judge the opening of one specific transcript with the same rules as the directory probe. */
export function probeClaudeSessionFile(file: string): ClaudeSessionProbeFailure | null {
  return inspectOpening(file);
}

/** Only `projects/<project>/<uuid>.jsonl`: never `<uuid>/subagents/*.jsonl` or `agent-*.jsonl`. */
function latestMainSession(root: string): ClaudeSessionProbe {
  let latest: { file: string; modified: number } | null = null;
  let projects: Dirent[];
  try {
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || isReparseOrSymlink(root, metadata))
      return { ok: false, file: root, reason: "unreadable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, file: null };
    return { ok: false, file: root, reason: "unreadable" };
  }
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: false, file: root, reason: "unreadable" };
  }
  for (const project of projects) {
    const directory = path.join(root, project.name);
    let entries: Dirent[];
    try {
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory() || isReparseOrSymlink(directory, metadata)) continue;
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return { ok: false, file: directory, reason: "unreadable" };
    }
    for (const entry of entries) {
      if (!mainSessionFile.test(entry.name)) continue;
      const file = path.join(directory, entry.name);
      try {
        const metadata = lstatSync(file);
        if (!metadata.isFile() || isReparseOrSymlink(file, metadata)) continue;
        if (!latest || metadata.mtimeMs > latest.modified)
          latest = { file, modified: metadata.mtimeMs };
      } catch {
        return { ok: false, file, reason: "unreadable" };
      }
    }
  }
  return { ok: true, file: latest?.file ?? null };
}

/** `null` means a conforming record was found inside the window. */
function inspectOpening(file: string): ClaudeSessionProbeFailure | null {
  let fd: number | undefined;
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || isReparseOrSymlink(file, metadata)) return "unreadable";
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) return "unreadable";
    if (opened.size === 0) return "empty";
    const buffer = Buffer.allocUnsafe(Math.min(opened.size, PROBE_MAX_BYTES));
    let filled = 0;
    while (filled < buffer.length) {
      const size = readSync(fd, buffer, filled, buffer.length - filled, filled);
      if (!size) break;
      filled += size;
    }
    const window = buffer.subarray(0, filled);
    // A line that does not end inside a truncated window cannot be judged; at the end of the whole
    // file the last line may legitimately lack its newline.
    const wholeFile = filled === opened.size;
    let start = 0;
    for (let line = 0; line < PROBE_MAX_RECORDS && start < window.length; line++) {
      let end = window.indexOf(10, start);
      if (end < 0) {
        if (!wholeFile) return "record-too-large";
        end = window.length;
      }
      const verdict = inspectRecord(window.subarray(start, end));
      if (verdict === "conforming") return null;
      if (verdict !== "skip") return verdict;
      start = end + 1;
    }
    return "no-conforming-record";
  } catch {
    return "unreadable";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inspectRecord(
  bytes: Buffer,
): "skip" | "conforming" | "malformed-record" | "unexpected-record-shape" {
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.trim()) return "skip";
    value = JSON.parse(text);
  } catch {
    return "malformed-record";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return "malformed-record";
  const record = value as Record<string, unknown>;
  // Metadata and any record type added later are neither proof nor disproof of the message shape.
  if (record.type !== "user" && record.type !== "assistant") return "skip";
  // Subagent traffic embedded in a main file is not the main conversation.
  if (record.isSidechain === true) return "skip";
  const message = record.message;
  return nonEmptyString(record.sessionId) &&
    nonEmptyString(record.uuid) &&
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message)
    ? "conforming"
    : "unexpected-record-shape";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}
