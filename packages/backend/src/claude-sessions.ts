import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileTime } from "./asset-scanner";
import { claudeConfigFiles, resolveClaudeConfig } from "./claude-config";
import { isFile, readText, within } from "./files";
import { isDirectory, isProbeWorkspace } from "./paths";
import { jsonLines } from "./jsonl";
import { sessionTitle, type NativeSessionSource } from "./codex-sessions";
import { isClaudeEcho } from "./session-document-providers";
import { timestamp } from "./timestamps";
import { compareTimes, compareUtf8 } from "./workspaces";
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function parseTime(value: unknown): string | null {
  if (typeof value === "string") return timestamp(value);
  if (typeof value === "number" && Number.isInteger(value)) {
    try {
      return timestamp(new Date(Math.abs(value) >= 1e10 ? value : value * 1000).toISOString());
    } catch {}
  }
  return null;
}
function earliest(a: string | null, b: string | null): string | null {
  return a && b ? (compareTimes(a, b) <= 0 ? a : b) : (a ?? b);
}
function latest(a: string | null, b: string | null): string | null {
  return a && b ? (compareTimes(a, b) >= 0 ? a : b) : (a ?? b);
}
function readable(file: string): boolean {
  let fd: number | undefined;
  try {
    if (!lstatSync(file).isFile()) return false;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return fstatSync(fd).isFile();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function scan(root: string, errors: string[]): string[] {
  const files: string[] = [];
  const visit = (directory: string, level: number) => {
    if (level > 3) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(String(error));
      return;
    }
    for (const entry of entries) {
      const value = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(value, level + 1);
      else if (entry.isFile()) files.push(value);
    }
  };
  visit(root, 1);
  return files;
}
function userTitle(row: Record<string, unknown>): string | null {
  if (row.type !== "user") return null;
  const message = record(row.message);
  if (!message || (message.role !== undefined && message.role !== "user")) return null;
  const titleText = (value: unknown) =>
    typeof value === "string" && !isClaudeEcho(value) ? sessionTitle(value) : null;
  if (typeof message.content === "string") return titleText(message.content);
  if (!Array.isArray(message.content)) return null;
  return sessionTitle(
    message.content
      .map((value) => {
        const block = record(value);
        return block?.type === "text" ? titleText(block.text) : null;
      })
      .filter((value) => value !== null)
      .join("\n"),
  );
}
const HEADER_BYTES = 2 * 1024 * 1024;
const HEADER_LINES = 256;
/** Claude appends renames and generated titles late, so the newest values live near the end. */
const TAIL_BYTES = 256 * 1024;
const SCAN_CACHE_LIMIT = 4096;
/** Claude Code leaves these out of `/resume` and `--continue`: SDK and `-p` runs, and daemons. */
const PROGRAMMATIC_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py"]);
const DAEMON_SESSION_KINDS = new Set(["daemon", "daemon-worker"]);
const LOOP_COMMAND = "<command-name>/loop</command-name>";
interface TranscriptScan {
  nativeRef: string;
  cwd: string | null;
  created: string | null;
  updated: string | null;
  branch: string | null;
  sidechain: boolean | null;
  /** The first record's launch surface decides, as in Claude Code; later resumes do not. */
  entrypoint: string | null;
  sessionKind: string | null;
  /** Whether the first prompt is `/loop`; null until the header reaches a prompt. */
  loop: boolean | null;
  customTitles: Map<string, string>;
  aiTitles: Map<string, string>;
  firstPrompts: Map<string, string>;
}
/** Mirrors Claude Code's session picker, which hides these from `/resume`. */
function programmatic(scan: TranscriptScan): boolean {
  return (
    (scan.entrypoint !== null && PROGRAMMATIC_ENTRYPOINTS.has(scan.entrypoint)) ||
    (scan.sessionKind !== null && DAEMON_SESSION_KINDS.has(scan.sessionKind)) ||
    scan.loop === true
  );
}
/** Claude Code reads the first prompt that is not metadata, a compaction or a tool result. */
function loopPrompt(row: Record<string, unknown>): boolean | null {
  if (row.type !== "user" || row.isMeta === true || row.isCompactSummary === true) return null;
  const message = record(row.message);
  if (!message) return null;
  const texts: string[] = [];
  if (typeof message.content === "string") texts.push(message.content);
  else if (Array.isArray(message.content))
    for (const value of message.content) {
      const block = record(value);
      if (block?.type === "tool_result") return null;
      if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  return texts.some((value) => value.includes(LOOP_COMMAND));
}
// These caches contain display metadata, never control or ownership evidence.
// File replacement and in-place writes must invalidate even if size/mtime match.
const fileVersion = (stat: BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const scans = new Map<string, { version: string; scan: TranscriptScan }>();
type HistoryTimes = Map<string, { created: string | null; updated: string | null }>;
const histories = new Map<
  string,
  { version: string; nativeRefs: Set<string>; times: HistoryTimes }
>();
function historyTimes(file: string, nativeRefs: Iterable<string>): HistoryTimes {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("History must be a regular file");
  const version = fileVersion(stat),
    refs = new Set(nativeRefs),
    cached = histories.get(file);
  if (
    cached?.version === version &&
    cached.nativeRefs.size === refs.size &&
    [...refs].every((ref) => cached.nativeRefs.has(ref))
  )
    return cached.times;
  const times: HistoryTimes = new Map();
  for (const { value } of jsonLines(file, { bytes: 256 * 1024 * 1024, rejectOversized: true })) {
    const row = record(value);
    if (!row || typeof row.sessionId !== "string" || !refs.has(row.sessionId)) continue;
    const previous = times.get(row.sessionId),
      at = parseTime(row.timestamp);
    times.set(row.sessionId, {
      created: earliest(previous?.created ?? null, at),
      updated: latest(previous?.updated ?? null, at),
    });
  }
  histories.delete(file);
  if (refs.size <= SCAN_CACHE_LIMIT && fileVersion(lstatSync(file, { bigint: true })) === version) {
    histories.set(file, { version, nativeRefs: refs, times });
    if (histories.size > 16) histories.delete(histories.keys().next().value as string);
  }
  return times;
}
/** A title names a session; it is not evidence for changing the transcript's identity. */
function noteTitle(
  row: Record<string, unknown>,
  customTitles: Map<string, string>,
  aiTitles: Map<string, string>,
) {
  const internal = row.isMeta === true || row.isCompactSummary === true || row.isSidechain === true;
  const custom = row.type === "custom-title";
  const id = text(row.sessionId),
    title = sessionTitle(custom ? row.customTitle : row.aiTitle);
  if (!internal && id && title) (custom ? customTitles : aiTitles).set(id, title);
}
/** Reads at most TAIL_BYTES from the end; the first (possibly partial) line is dropped. */
function tailLines(file: string): string[] {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size === 0) return [];
    const start = Math.max(0, metadata.size - TAIL_BYTES),
      buffer = Buffer.allocUnsafe(metadata.size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const count = readSync(fd, buffer, filled, buffer.length - filled, start + filled);
      if (!count) break;
      filled += count;
    }
    let from = 0;
    if (start > 0) {
      const newline = buffer.subarray(0, filled).indexOf(10);
      if (newline < 0) return [];
      from = newline + 1;
    }
    return buffer.subarray(from, filled).toString("utf8").split("\n");
  } finally {
    closeSync(fd);
  }
}
function tailTitles(
  lines: string[],
  customTitles: Map<string, string>,
  aiTitles: Map<string, string>,
) {
  for (const line of lines) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const row = record(JSON.parse(line));
      if (row && (row.type === "custom-title" || row.type === "ai-title"))
        noteTitle(row, customTitles, aiTitles);
    } catch {}
  }
}
/** Claude Code falls back to the newest entrypoint when the header has none. */
function tailEntrypoint(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.includes('"entrypoint"')) continue;
    try {
      const value = text(record(JSON.parse(line))?.entrypoint);
      if (value !== null) return value;
    } catch {}
  }
  return null;
}
function scanTranscript(file: string): TranscriptScan {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("Transcript must be a regular file");
  const version = fileVersion(stat),
    cached = scans.get(file);
  if (cached?.version === version) return cached.scan;
  const scan: TranscriptScan = {
    nativeRef: path.basename(file, ".jsonl"),
    cwd: null,
    created: null,
    updated: fileTime(file),
    branch: null,
    sidechain: null,
    entrypoint: null,
    sessionKind: null,
    loop: null,
    customTitles: new Map(),
    aiTitles: new Map(),
    firstPrompts: new Map(),
  };
  // Claude Code reads the session kind from the first message record, else from any record.
  let messageKind = false;
  for (const { value } of jsonLines(file, { bytes: HEADER_BYTES, lines: HEADER_LINES })) {
    const row = record(value);
    if (!row) continue;
    scan.entrypoint ??= text(row.entrypoint);
    if (!messageKind && "parentUuid" in row) {
      messageKind = true;
      scan.sessionKind = text(row.sessionKind);
    } else if (!messageKind) scan.sessionKind ??= text(row.sessionKind);
    if (scan.loop === null) scan.loop = loopPrompt(row);
    const internal =
      row.isMeta === true || row.isCompactSummary === true || row.isSidechain === true;
    if (row.type === "custom-title" || row.type === "ai-title") {
      noteTitle(row, scan.customTitles, scan.aiTitles);
      continue;
    }
    scan.nativeRef = text(row.sessionId) ?? scan.nativeRef;
    scan.cwd ??= text("cwd" in row ? row.cwd : row.projectPath);
    scan.branch ??= text(row.gitBranch);
    if (scan.sidechain === null && ["user", "assistant"].includes(String(row.type)))
      scan.sidechain = typeof row.isSidechain === "boolean" ? row.isSidechain : false;
    const at = parseTime(row.timestamp);
    scan.created = earliest(scan.created, at);
    scan.updated = latest(scan.updated, at);
    if (!internal && !scan.firstPrompts.has(scan.nativeRef)) {
      const title = userTitle(row);
      if (title) scan.firstPrompts.set(scan.nativeRef, title);
    }
  }
  // Tail records are newer than anything in the header, so they overwrite it.
  const tail = tailLines(file);
  tailTitles(tail, scan.customTitles, scan.aiTitles);
  scan.entrypoint ??= tailEntrypoint(tail);
  scans.delete(file);
  if (fileVersion(lstatSync(file, { bigint: true })) === version)
    scans.set(file, { version, scan });
  if (scans.size > SCAN_CACHE_LIMIT) scans.delete(scans.keys().next().value as string);
  return scan;
}
/** Explicit titles first (user set, then generated); the caller chooses the fallbacks. */
function explicitTitle(scan: TranscriptScan): string | null {
  return scan.customTitles.get(scan.nativeRef) ?? scan.aiTitles.get(scan.nativeRef) ?? null;
}
function transcriptHeader(
  file: string,
  probeWorkspace = isProbeWorkspace,
): NativeSessionSource | null {
  const scan = scanTranscript(file),
    { nativeRef, cwd, sidechain } = scan;
  if (cwd === null || probeWorkspace(cwd)) return null;
  return {
    cwd,
    transcript: file,
    session: {
      native_ref: nativeRef,
      agent: "claude-code",
      title: sidechain ? null : (explicitTitle(scan) ?? scan.firstPrompts.get(nativeRef) ?? null),
      origin: sidechain
        ? "auxiliary"
        : programmatic(scan)
          ? "execution"
          : sidechain === null
            ? "unknown"
            : "interactive",
      created_at: scan.created,
      updated_at: scan.updated,
      message_count: null,
      git_branch: sessionTitle(scan.branch),
      archived: false,
      sidechain: sidechain ?? false,
      availability: readable(file) ? "readable" : "metadata-only",
      spawned_by_session_id: null,
      forked_from_session_id: null,
    },
  };
}
export class ClaudeSessions {
  constructor(readonly environment: NodeJS.ProcessEnv) {}
  #config() {
    return resolveClaudeConfig(this.environment, homedir());
  }
  home() {
    return this.#config().dir;
  }
  list(workspace: string | null) {
    // Many sessions share a cwd. Retain probe checks only within this scan so
    // adding or removing the marker is visible on the next request.
    const probes = new Map<string, boolean>();
    const membership = new Map<string, boolean>();
    const probeWorkspace = (cwd: string) => {
      let result = probes.get(cwd);
      if (result === undefined) {
        result = isProbeWorkspace(cwd);
        probes.set(cwd, result);
      }
      return result;
    };
    const belongs = (cwd: string) => {
      let result = membership.get(cwd);
      if (result === undefined) {
        result = workspace === null || within(cwd, workspace);
        membership.set(cwd, result);
      }
      return result;
    };
    const files = claudeConfigFiles(this.#config()),
      projects = files.projects,
      errors: string[] = [],
      paths = isDirectory(projects) ? scan(projects, errors) : [],
      sessions = new Map<string, NativeSessionSource>();
    for (const index of paths.filter((file) => path.basename(file) === "sessions-index.json")) {
      let document: Record<string, unknown> | null;
      try {
        document = record(JSON.parse(readText(index, 16 * 1024 * 1024)));
      } catch (error) {
        errors.push(String(error));
        continue;
      }
      if (document?.version !== 1) {
        errors.push(`Unsupported Claude session index version in ${index}`);
        continue;
      }
      for (const value of Array.isArray(document.entries) ? document.entries : []) {
        const row = record(value);
        if (!row) continue;
        const cwd = text(row.projectPath),
          nativeRef = text(row.sessionId);
        if (cwd === null || nativeRef === null || probeWorkspace(cwd)) continue;
        const transcript =
            text(row.fullPath) ?? path.join(path.dirname(index), `${nativeRef}.jsonl`),
          sidechain = typeof row.isSidechain === "boolean" ? row.isSidechain : false;
        const summary = text(row.summary),
          message_count =
            typeof row.messageCount === "number" &&
            Number.isInteger(row.messageCount) &&
            row.messageCount >= 0
              ? row.messageCount
              : null;
        sessions.set(nativeRef, {
          cwd,
          transcript,
          session: {
            native_ref: nativeRef,
            agent: "claude-code",
            title: sessionTitle(summary?.trim() ? summary : row.firstPrompt),
            origin: sidechain ? "auxiliary" : "interactive",
            created_at: parseTime(row.created),
            updated_at: parseTime("modified" in row ? row.modified : row.fileMtime),
            message_count,
            git_branch: sessionTitle(row.gitBranch),
            archived: false,
            sidechain,
            availability: readable(transcript) ? "readable" : "metadata-only",
            spawned_by_session_id: null,
            forked_from_session_id: null,
          },
        });
      }
    }
    const update = (session: NativeSessionSource, file: string) => {
      session.transcript = file;
      session.session.updated_at = latest(session.session.updated_at, fileTime(file));
      session.session.availability = readable(file) ? "readable" : "metadata-only";
      if (!session.session.sidechain) {
        try {
          // custom-title and ai-title outrank the indexed title; the index and first prompt fill in.
          const scan = scanTranscript(file);
          if (scan.nativeRef === session.session.native_ref) {
            session.session.title =
              explicitTitle(scan) ??
              session.session.title ??
              scan.firstPrompts.get(scan.nativeRef) ??
              null;
            // The index carries no launch surface; the transcript's first record does.
            if (programmatic(scan)) session.session.origin = "execution";
          }
        } catch (error) {
          errors.push(String(error));
        }
      }
    };
    for (const file of paths.filter((file) => path.extname(file) === ".jsonl")) {
      const indexed = sessions.get(path.basename(file, ".jsonl"));
      if (indexed) {
        update(indexed, file);
        continue;
      }
      try {
        const session = transcriptHeader(file, probeWorkspace);
        if (!session) continue;
        const previous = sessions.get(session.session.native_ref);
        if (previous) update(previous, file);
        else sessions.set(session.session.native_ref, session);
      } catch (error) {
        errors.push(String(error));
      }
    }
    const history = files.history;
    if (isFile(history)) {
      try {
        for (const [nativeRef, times] of historyTimes(history, sessions.keys())) {
          const session = sessions.get(nativeRef);
          if (session) {
            session.session.created_at = earliest(session.session.created_at, times.created);
            session.session.updated_at = latest(session.session.updated_at, times.updated);
          }
        }
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (!sessions.size && errors.length) throw new Error(errors.join("; "));
    return {
      sessions: [...sessions.entries()]
        .sort(([a], [b]) => compareUtf8(a, b))
        .map(([, value]) => value)
        .filter(
          (value) => isFile(value.transcript) && !probeWorkspace(value.cwd) && belongs(value.cwd),
        ),
      incomplete: false,
    };
  }
}
