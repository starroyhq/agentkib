import { homedir } from "node:os";
import path from "node:path";
import type {
  ConversationAgentAction,
  ConversationToolContent,
  ConversationToolDetail,
  ConversationToolKind,
  ConversationToolLocation,
} from "@agentkib/runtime-protocol";
import {
  isSensitiveSessionKey,
  sanitizeHandoffExport,
  sanitizeSessionText,
} from "./session-handoff";
import { toolStatus, truncateUtf8 } from "./session-event-values";

/**
 * Normalizes native tool records into the bounded `ConversationToolDetail`
 * shape. Every string that leaves this module is redacted with the same rules
 * as content search and handoff; line counts are taken before redaction.
 * Reasoning, Claude's `originalFile`, read-tool file contents and binary data
 * are never copied.
 */
export const TOOL_DETAIL_LIMITS = {
  titleChars: 512,
  nameChars: 128,
  commandBytes: 2 * 1024,
  outputBytes: 4 * 1024,
  textBytes: 4 * 1024,
  diffPreviewBytes: 8 * 1024,
  diffPreviewTotalBytes: 24 * 1024,
  diffPreviewFiles: 20,
  diffFiles: 200,
  locations: 20,
  detailBytes: 32 * 1024,
} as const;

/** Raw windows kept before redaction; whole lines only, so no secret is cut in half. */
const RAW_WINDOW_BYTES = 16 * 1024;

export interface ToolContext {
  /** Workspace root; paths inside it are shown relative to it. */
  workspace?: string | null;
  /** Working directory used to resolve relative paths. */
  cwd?: string | null;
  home?: string | null;
}

export interface NormalizedToolCall {
  /** Kept as `tool_name` so clients without detail support still show a name. */
  name: string;
  status: string | null;
  durationMs: number | null;
  detail: ConversationToolDetail;
}

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const visible = (value: unknown): value is string =>
  typeof value === "string" && /[^\p{White_Space}]/u.test(value);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
function field(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) if (Object.hasOwn(record, key)) return record[key];
  return undefined;
}
/** `commandExecution`, `CommandExecution` and `command_execution` compare equal. */
const typeKey = (value: unknown): string =>
  typeof value === "string" ? value.replace(/[^a-z\d]/gi, "").toLowerCase() : "";
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
export function jsonBytes(value: unknown): number {
  return value === undefined ? 0 : byteLength(JSON.stringify(value));
}

function chars(value: string, maximum: number): string {
  const points = [...value];
  return points.length <= maximum ? value : `${points.slice(0, maximum - 1).join("")}…`;
}
/** First non-empty line, marked when more lines follow. */
function firstLine(value: string, maximum: number = TOOL_DETAIL_LIMITS.titleChars): string {
  const lines = value.split("\n");
  const index = lines.findIndex((line) => line.trim());
  if (index < 0) return "";
  const more = lines.slice(index + 1).some((line) => line.trim());
  return chars(`${lines[index]!.trim()}${more ? " …" : ""}`, maximum);
}
function headBytes(value: string, maximum: number): { text: string; truncated: boolean } {
  const { content, truncated } = truncateUtf8(value, maximum);
  if (!truncated) return { text: content, truncated };
  const newline = content.lastIndexOf("\n");
  return { text: newline > content.length / 2 ? content.slice(0, newline) : content, truncated };
}
function tailBytes(value: string, maximum: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return { text: value, truncated: false };
  let start = bytes.length - maximum;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const tail = bytes.subarray(start).toString("utf8");
  const newline = tail.indexOf("\n");
  return {
    text: newline >= 0 && newline < tail.length / 2 ? tail.slice(newline + 1) : tail,
    truncated: true,
  };
}
/** A single line up to this size is redacted whole rather than dropped. */
const RAW_LINE_BYTES = 1024 * 1024;
/**
 * Whole trailing lines within a raw window. Redaction must see complete lines
 * (a key and its value, a whole token), so the window never starts inside one.
 */
function rawTail(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= RAW_WINDOW_BYTES) return { text: value, truncated: false };
  let start = bytes.length - RAW_WINDOW_BYTES;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const newline = bytes.indexOf(10, start);
  if (newline >= 0 && newline + 1 < bytes.length)
    return { text: bytes.subarray(newline + 1).toString("utf8"), truncated: true };
  // One long final line: redact it whole when that stays cheap, otherwise show nothing.
  const lineStart = bytes.lastIndexOf(10, bytes.length - 2) + 1;
  return bytes.length - lineStart <= RAW_LINE_BYTES
    ? { text: bytes.subarray(lineStart).toString("utf8"), truncated: true }
    : { text: "", truncated: true };
}
function rawHeadLines(lines: string[], maximum = RAW_WINDOW_BYTES) {
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (kept.length && bytes + byteLength(line) + 1 > maximum)
      return { lines: kept, truncated: true };
    kept.push(line);
    bytes += byteLength(line) + 1;
  }
  return { lines: kept, truncated: false };
}

const ANSI_PATTERN =
  // CSI, OSC and two-character escape sequences; matching control characters is the point.
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export function plainTerminalText(value: string): string {
  return (
    value
      .replace(ANSI_PATTERN, "")
      .replace(/\r\n/g, "\n")
      .replace(/[^\n]*\r(?!\n)/g, "")
      // Remaining C0 controls and DEL; tabs and newlines stay.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

function redactUrlParameters(value: string): string {
  return value.replace(
    /([?&;])([A-Za-z][\w.-]{0,80})=([^&#\s'"]*)/g,
    (match, separator: string, key: string, raw: string) =>
      raw && raw !== "[REDACTED]" && isSensitiveSessionKey(key)
        ? `${separator}${key}=[REDACTED]`
        : match,
  );
}
/** Plain text, using the handoff rules plus sensitive URL parameters. */
export function redactToolText(value: string): string {
  return redactUrlParameters(sanitizeSessionText(value, { value: 0 }));
}
/**
 * Structured values keep their JSON redaction (sensitive keys anywhere in the
 * tree). Returns undefined when a structured value cannot be redacted, so a
 * weaker rule is never used for it.
 */
function redactStructuredText(value: string): string | undefined {
  if (/^\s*[[{]/.test(value)) {
    try {
      return redactUrlParameters(sanitizeHandoffExport(value, "json").trimEnd());
    } catch (error) {
      if (!(error instanceof SyntaxError)) return undefined;
    }
  }
  return redactToolText(value);
}
function jsonPreview(value: unknown): { text: string; truncated: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  let raw: string | undefined;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!visible(raw) || raw === "{}" || raw === "[]") return undefined;
  const redacted = redactStructuredText(raw);
  return redacted === undefined ? undefined : headBytes(redacted, TOOL_DETAIL_LIMITS.textBytes);
}
interface Bounded {
  text: string;
  truncated: boolean;
}
function outputTail(value: string | null): Bounded | undefined {
  if (!visible(value)) return undefined;
  const window = rawTail(value);
  const cleaned = plainTerminalText(window.text);
  if (!visible(cleaned)) return window.truncated ? { text: "", truncated: true } : undefined;
  const bounded = tailBytes(redactToolText(cleaned), TOOL_DETAIL_LIMITS.outputBytes);
  return { text: bounded.text, truncated: window.truncated || bounded.truncated };
}
/** Redact a command once; titles and terminal entries share the result. */
function boundedCommand(command: string): Bounded {
  const window = rawHeadLines(command.split("\n"));
  const bounded = headBytes(
    redactToolText(window.lines.join("\n")),
    TOOL_DETAIL_LIMITS.commandBytes,
  );
  return { text: bounded.text, truncated: window.truncated || bounded.truncated };
}

/**
 * Redact unified diff lines without their `+`/`-`/space prefix, so key-value
 * rules see the line as written. Private key blocks become one marker line.
 */
function redactDiffLines(lines: string[]): string[] {
  const output: string[] = [];
  let keyEnd: string | undefined;
  for (const line of lines) {
    const prefix = /^[+\- ]/.test(line) ? line[0]! : "";
    const body = prefix ? line.slice(1) : line;
    const marker = body.trim().toUpperCase();
    if (keyEnd) {
      if (marker === keyEnd) keyEnd = undefined;
      continue;
    }
    const begin = marker.match(/^-----BEGIN (.*PRIVATE KEY)-----$/);
    if (begin) {
      output.push(`${prefix}[REDACTED PRIVATE KEY]`);
      keyEnd = `-----END ${begin[1]}-----`;
      continue;
    }
    output.push(line.startsWith("@@") ? line : `${prefix}${redactToolText(body)}`);
  }
  return output;
}

export function lineCount(value: string): number {
  if (!value) return 0;
  const breaks = value.split("\n").length - 1;
  return value.endsWith("\n") ? breaks : breaks + 1;
}
/** Count changed lines inside unified diff hunks; header lines are not counted. */
export function countUnifiedDiff(value: string): { added: number; removed: number } {
  let added = 0,
    removed = 0,
    oldLeft = 0,
    newLeft = 0,
    hunks = 0;
  for (const line of value.split("\n")) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      hunks++;
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    const marker = line[0];
    if (marker === "+") {
      added++;
      newLeft--;
    } else if (marker === "-") {
      removed++;
      oldLeft--;
    } else if (marker === " " || line === "") {
      oldLeft--;
      newLeft--;
    } else if (marker !== "\\") oldLeft = newLeft = 0;
  }
  if (hunks) return { added, removed };
  // Not a hunk-based diff: count marked lines and skip file headers.
  for (const line of value.split("\n")) {
    if (/^(\+\+\+|---)( |$)/.test(line)) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function absoluteFrom(value: string, context: ToolContext): string {
  if (path.isAbsolute(value) || !context.cwd || !path.isAbsolute(context.cwd)) return value;
  return path.resolve(context.cwd, value);
}
/** Relative inside the workspace, `~/…` under the home directory, otherwise as recorded. */
export function displayToolPath(value: string, context: ToolContext = {}): string {
  let shown = absoluteFrom(value, context);
  const workspace = context.workspace;
  if (workspace && path.isAbsolute(workspace) && path.isAbsolute(shown)) {
    const relative = path.relative(workspace, shown);
    if (relative === "") shown = ".";
    else if (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      shown = relative;
  }
  const home = context.home ?? homedir();
  if (home && path.isAbsolute(shown) && (shown === home || shown.startsWith(`${home}${path.sep}`)))
    shown = `~${shown.slice(home.length)}`;
  return chars(redactToolText(shown), TOOL_DETAIL_LIMITS.titleChars);
}
function locations(paths: Array<{ path: string; line?: number }>): ConversationToolLocation[] {
  const seen = new Set<string>();
  const result: ConversationToolLocation[] = [];
  for (const entry of paths) {
    if (!entry.path || seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push(entry.line === undefined ? { path: entry.path } : entry);
    if (result.length >= TOOL_DETAIL_LIMITS.locations) break;
  }
  return result;
}

interface DiffSource {
  path: string;
  change: "add" | "update" | "delete" | "move";
  movePath?: string;
  added: number;
  removed: number;
  /** Raw unified lines; redacted and bounded when the entry is built. */
  lines?: string[];
}
class DiffBudget {
  remaining: number = TOOL_DETAIL_LIMITS.diffPreviewTotalBytes;
  previews = 0;
}
function diffContent(source: DiffSource, context: ToolContext, budget: DiffBudget) {
  const entry: Extract<ConversationToolContent, { type: "diff" }> = {
    type: "diff",
    path: displayToolPath(source.path, context),
    change: source.change,
    added: source.added,
    removed: source.removed,
  };
  if (source.movePath) entry.move_path = displayToolPath(source.movePath, context);
  if (!source.lines?.length) return entry;
  const allowance = Math.min(TOOL_DETAIL_LIMITS.diffPreviewBytes, budget.remaining);
  if (budget.previews >= TOOL_DETAIL_LIMITS.diffPreviewFiles || allowance < 256) {
    entry.truncated = true;
    return entry;
  }
  const window = rawHeadLines(source.lines);
  const preview = headBytes(redactDiffLines(window.lines).join("\n"), allowance);
  entry.preview = preview.text;
  if (window.truncated || preview.truncated) entry.truncated = true;
  budget.remaining -= byteLength(preview.text);
  budget.previews++;
  return entry;
}
function prefixed(value: string, prefix: "+" | "-"): string[] {
  const lines = value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
  const count = value ? lines.length : 0;
  const header = prefix === "+" ? `@@ -0,0 +1,${count} @@` : `@@ -1,${count} +0,0 @@`;
  return count ? [header, ...lines.map((line) => `${prefix}${line}`)] : [];
}
function diffLines(value: string): string[] {
  return (value.endsWith("\n") ? value.slice(0, -1) : value).split("\n");
}

/** Trim common leading and trailing lines; exact for one changed region. */
export function diffStrings(before: string, after: string): string[] {
  const left = before.split("\n"),
    right = after.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let leftEnd = left.length,
    rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd--;
    rightEnd--;
  }
  return [
    "@@",
    ...left.slice(Math.max(0, start - 2), start).map((line) => ` ${line}`),
    ...left.slice(start, leftEnd).map((line) => `-${line}`),
    ...right.slice(start, rightEnd).map((line) => `+${line}`),
    ...left.slice(leftEnd, Math.min(left.length, leftEnd + 2)).map((line) => ` ${line}`),
  ];
}
function countMarked(lines: string[]): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of lines) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function finalizeDetail(detail: ConversationToolDetail): ConversationToolDetail {
  for (const key of ["title", "locations", "content"] as const) {
    const value = detail[key];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))
      delete detail[key];
  }
  if (jsonBytes(detail) <= TOOL_DETAIL_LIMITS.detailBytes) return detail;
  // Drop the largest previews first; titles, paths and counts stay.
  const steps: Array<(content: ConversationToolContent) => ConversationToolContent | null> = [
    (entry) =>
      entry.type === "terminal" ? { ...entry, output: undefined, truncated: true } : entry,
    (entry) => (entry.type === "text" ? null : entry),
    (entry) => (entry.type === "diff" ? { ...entry, preview: undefined, truncated: true } : entry),
  ];
  for (const step of steps) {
    detail.truncated = true;
    detail.content = detail.content?.map(step).filter((entry) => entry !== null) as
      | ConversationToolContent[]
      | undefined;
    if (jsonBytes(detail) <= TOOL_DETAIL_LIMITS.detailBytes) return detail;
  }
  detail.content = detail.content?.slice(0, 50);
  detail.locations = detail.locations?.slice(0, 5);
  if (jsonBytes(detail) <= TOOL_DETAIL_LIMITS.detailBytes) return detail;
  delete detail.content;
  delete detail.locations;
  if (detail.title) detail.title = chars(detail.title, 128);
  return detail;
}

function durationOf(record: JsonRecord): number | null {
  const milliseconds = field(record, "durationMs", "duration_ms");
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0)
    return Math.round(milliseconds);
  const duration = record.duration;
  if (
    isRecord(duration) &&
    typeof duration.secs === "number" &&
    typeof duration.nanos === "number" &&
    duration.secs >= 0 &&
    duration.nanos >= 0
  )
    return Math.round(duration.secs * 1000 + duration.nanos / 1e6);
  return null;
}
const statusOf = (record: JsonRecord): string => toolStatus(record.status) ?? "completed";
const integerOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const nameOf = (value: unknown, fallback: string): string =>
  visible(value) ? chars(redactToolText(value.trim()), TOOL_DETAIL_LIMITS.nameChars) : fallback;

const SHELLS = /(^|[\\/])(ba|z|k|da|fi)?sh(\.exe)?$/i;
/** `["/bin/zsh", "-lc", script]` shows the script; other argv lists are joined. */
function argvCommand(argv: unknown[]): string {
  const values = argv.filter((value): value is string => typeof value === "string");
  if (values.length === 3 && SHELLS.test(values[0]!) && /^-[a-z]*c$/.test(values[1]!))
    return values[2]!;
  return values
    .map((value) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`))
    .join(" ");
}
/** Best-effort display of `zsh -lc '…'` strings reported by the live protocol. */
function unwrapShell(command: string): string {
  const match = /^(?:\S*[\\/])?(?:ba|z|k|da)?sh(?:\.exe)?\s+-[a-z]*c\s+([\s\S]+)$/i.exec(
    command.trim(),
  );
  if (!match) return command;
  const script = match[1]!;
  if (script.length > 1 && script.startsWith("'") && script.endsWith("'"))
    return script.slice(1, -1).replace(/'\\''/g, "'");
  if (script.length > 1 && script.startsWith('"') && script.endsWith('"'))
    return script.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  return script;
}
function terminal(
  command: Bounded,
  output: Bounded | undefined,
  exitCode: number | null,
): Extract<ConversationToolContent, { type: "terminal" }> {
  const entry: Extract<ConversationToolContent, { type: "terminal" }> = { type: "terminal" };
  if (command.text) entry.command = command.text;
  if (output?.text) entry.output = output.text;
  if (exitCode !== null) entry.exit_code = exitCode;
  if (command.truncated || output?.truncated) entry.truncated = true;
  return entry;
}

function commandExecution(item: JsonRecord, context: ToolContext): NormalizedToolCall {
  const argv = item.command;
  const command = boundedCommand(
    Array.isArray(argv) ? argvCommand(argv) : unwrapShell(text(argv) ?? ""),
  );
  const cwd = text(item.cwd);
  const local: ToolContext = { ...context, cwd: cwd ?? context.cwd };
  const actions = arrayOf(field(item, "parsed_cmd", "commandActions", "command_actions")).filter(
    isRecord,
  );
  const status = statusOf(item);
  const exitCode = integerOrNull(field(item, "exit_code", "exitCode"));
  const output = outputTail(text(field(item, "aggregated_output", "aggregatedOutput")));
  const durationMs = durationOf(item);
  const explore = new Set(["read", "search", "listfiles"]);
  if (actions.length && actions.every((action) => explore.has(typeKey(action.type)))) {
    const parts: string[] = [];
    const paths: Array<{ path: string }> = [];
    for (const action of actions) {
      const kind = typeKey(action.type);
      const target = text(action.path) ?? (kind === "read" ? text(action.name) : null);
      const shown = visible(target) ? displayToolPath(target, local) : "";
      if (shown) paths.push({ path: shown });
      if (kind === "search" && visible(action.query)) {
        const query = chars(redactToolText(action.query), 200);
        parts.push(shown ? `${query} · ${shown}` : query);
      } else parts.push(shown || (kind === "listfiles" ? "." : ""));
    }
    const kind: ConversationToolKind = actions.every((action) => typeKey(action.type) === "read")
      ? "read"
      : "search";
    const detail: ConversationToolDetail = {
      kind,
      title: chars([...new Set(parts.filter(Boolean))].join(", "), TOOL_DETAIL_LIMITS.titleChars),
      locations: locations(paths),
    };
    // A failed lookup shows its command and error; successful reads never copy file contents.
    if (status === "failed") detail.content = [terminal(command, output, exitCode)];
    return { name: "shell", status, durationMs, detail: finalizeDetail(detail) };
  }
  return {
    name: "shell",
    status,
    durationMs,
    detail: finalizeDetail({
      kind: "execute",
      title: firstLine(command.text),
      content: [terminal(command, output, exitCode)],
    }),
  };
}

function fileChange(item: JsonRecord, context: ToolContext): NormalizedToolCall {
  const sources: DiffSource[] = [];
  const add = (filePath: unknown, changeType: unknown, movePath: unknown, body: unknown): void => {
    if (!visible(filePath) || sources.length >= TOOL_DETAIL_LIMITS.diffFiles) return;
    const kind = typeKey(changeType);
    const value = text(body) ?? "";
    const hunks = /^@@ /m.test(value);
    const change: DiffSource["change"] =
      kind === "add" ? "add" : kind === "delete" ? "delete" : visible(movePath) ? "move" : "update";
    let counts: { added: number; removed: number };
    let lines: string[];
    if (hunks || change === "update" || change === "move") {
      counts = countUnifiedDiff(value);
      lines = value ? diffLines(value) : [];
    } else {
      counts =
        change === "add"
          ? { added: lineCount(value), removed: 0 }
          : { added: 0, removed: lineCount(value) };
      lines = prefixed(value, change === "add" ? "+" : "-");
    }
    sources.push({
      path: filePath,
      change,
      ...(visible(movePath) ? { movePath } : {}),
      ...counts,
      lines,
    });
  };
  const changes = item.changes;
  if (Array.isArray(changes)) {
    for (const change of changes) {
      if (!isRecord(change)) continue;
      const kind = isRecord(change.kind) ? change.kind : { type: change.kind };
      add(change.path, kind.type, field(kind, "move_path", "movePath"), change.diff);
    }
  } else if (isRecord(changes)) {
    for (const [filePath, change] of Object.entries(changes)) {
      if (!isRecord(change)) continue;
      add(
        filePath,
        change.type,
        field(change, "move_path", "movePath"),
        field(change, "unified_diff", "diff", "content"),
      );
    }
  }
  const budget = new DiffBudget();
  const content = sources.map((source) => diffContent(source, context, budget));
  const kind: ConversationToolKind =
    sources.length && sources.every((source) => source.change === "delete")
      ? "delete"
      : sources.length === 1 && sources[0]!.change === "move"
        ? "move"
        : "edit";
  return {
    name: "apply_patch",
    status: statusOf(item),
    durationMs: durationOf(item),
    detail: finalizeDetail({
      kind,
      title: content.length === 1 ? content[0]!.path : undefined,
      locations: locations(content.map((entry) => ({ path: entry.path }))),
      content,
    }),
  };
}

function textContent(
  label: "input" | "output",
  preview: { text: string; truncated: boolean } | undefined,
): ConversationToolContent[] {
  if (!preview || !visible(preview.text)) return [];
  return [
    { type: "text", label, text: preview.text, ...(preview.truncated ? { truncated: true } : {}) },
  ];
}
function joinedTexts(values: string[]): { text: string; truncated: boolean } | undefined {
  const parts: string[] = [];
  let truncated = false;
  for (const value of values) {
    const redacted = redactStructuredText(value);
    if (redacted === undefined) {
      truncated = true;
      continue;
    }
    parts.push(redacted);
  }
  if (!parts.length) return truncated ? { text: "", truncated } : undefined;
  const bounded = headBytes(parts.join("\n"), TOOL_DETAIL_LIMITS.textBytes);
  return { text: bounded.text, truncated: truncated || bounded.truncated };
}
function mcpResultTexts(result: unknown): string[] {
  if (!isRecord(result)) return typeof result === "string" ? [result] : [];
  return arrayOf(result.content)
    .filter((entry): entry is JsonRecord => isRecord(entry) && entry.type === "text")
    .map((entry) => text(entry.text))
    .filter((value): value is string => visible(value));
}
function mcpToolCall(item: JsonRecord): NormalizedToolCall {
  const server = nameOf(item.server, "");
  const tool = nameOf(item.tool, "");
  let argumentsValue = item.arguments;
  if (typeof argumentsValue === "string") {
    try {
      argumentsValue = JSON.parse(argumentsValue);
    } catch {
      // Keep the string; it is redacted as text.
    }
  }
  const error = isRecord(item.error) && visible(item.error.message) ? item.error.message : null;
  const result = item.result;
  const texts = error ? [error] : mcpResultTexts(result);
  const output =
    joinedTexts(texts) ??
    (isRecord(result) && result.structuredContent != null
      ? jsonPreview(result.structuredContent)
      : undefined);
  const failed = isRecord(result) && result.isError === true;
  return {
    name: tool || "mcp",
    status: failed && statusOf(item) === "completed" ? "failed" : statusOf(item),
    durationMs: durationOf(item),
    detail: finalizeDetail({
      kind: "other",
      title: [server, tool].filter(Boolean).join(" · "),
      mcp: { server, tool },
      content: [
        ...textContent("input", jsonPreview(argumentsValue)),
        ...textContent("output", output),
      ],
    }),
  };
}
function dynamicToolCall(item: JsonRecord): NormalizedToolCall {
  const namespace = nameOf(item.namespace, "");
  const tool = nameOf(item.tool, "tool");
  const texts = arrayOf(field(item, "contentItems", "content_items"))
    .filter((entry): entry is JsonRecord => isRecord(entry) && typeKey(entry.type) === "inputtext")
    .map((entry) => text(entry.text))
    .filter((value): value is string => visible(value));
  const status =
    item.success === false && statusOf(item) === "completed" ? "failed" : statusOf(item);
  return {
    name: tool,
    status,
    durationMs: durationOf(item),
    detail: finalizeDetail({
      kind: "other",
      title: namespace ? `${namespace} · ${tool}` : tool,
      content: [
        ...textContent("input", jsonPreview(item.arguments)),
        ...textContent("output", joinedTexts(texts)),
      ],
    }),
  };
}
function webSearch(item: JsonRecord): NormalizedToolCall {
  const action = isRecord(item.action) ? item.action : null;
  const kind = action ? typeKey(action.type) : "search";
  const url = action ? text(action.url) : null;
  const queries = action ? arrayOf(action.queries).filter(visible) : [];
  const query =
    (visible(item.query) ? item.query : null) ??
    (action && visible(action.query) ? action.query : null) ??
    (queries.length ? queries.join(", ") : null);
  const title =
    kind === "openpage"
      ? url
      : kind === "findinpage"
        ? [url, action ? text(action.pattern) : null].filter(visible).join(" · ")
        : (query ?? url);
  return {
    name: "web_search",
    status: statusOf(item),
    durationMs: durationOf(item),
    detail: finalizeDetail({
      kind: "fetch",
      title: visible(title)
        ? chars(redactToolText(title.trim()), TOOL_DETAIL_LIMITS.titleChars)
        : undefined,
    }),
  };
}
const AGENT_ACTIONS: Record<string, ConversationAgentAction> = {
  started: "spawn",
  interacted: "message",
  interrupted: "interrupt",
  completed: "complete",
  spawnagent: "spawn",
  sendinput: "message",
  sendmessage: "message",
  followuptask: "message",
  resumeagent: "message",
  wait: "wait",
  waitagent: "wait",
  interruptagent: "interrupt",
  closeagent: "interrupt",
};
function subAgentActivity(item: JsonRecord): NormalizedToolCall {
  const agentPath = text(field(item, "agent_path", "agentPath")) ?? "";
  const segment = agentPath.split(/[\\/]/).filter(Boolean).at(-1);
  return {
    name: "agent",
    status: "completed",
    durationMs: null,
    detail: finalizeDetail({
      kind: "other",
      agent: {
        action: AGENT_ACTIONS[typeKey(item.kind)] ?? "other",
        ...(segment ? { name: nameOf(segment, "") } : {}),
      },
    }),
  };
}
function collabAgentToolCall(item: JsonRecord): NormalizedToolCall {
  return {
    name: nameOf(item.tool, "agent"),
    status: statusOf(item),
    durationMs: durationOf(item),
    detail: finalizeDetail({
      kind: "other",
      agent: { action: AGENT_ACTIONS[typeKey(item.tool)] ?? "other" },
    }),
  };
}

/**
 * A completed Codex thread item, either persisted in a rollout
 * (`CommandExecution`, snake_case fields) or reported by app-server
 * (`commandExecution`, camelCase fields). Messages, reasoning, plans and
 * compaction are not tool calls and return null.
 */
export function codexItemTool(item: unknown, context: ToolContext = {}): NormalizedToolCall | null {
  if (!isRecord(item)) return null;
  switch (typeKey(item.type)) {
    case "commandexecution":
      return commandExecution(item, context);
    case "filechange":
      return fileChange(item, context);
    case "mcptoolcall":
      return mcpToolCall(item);
    case "dynamictoolcall":
      return dynamicToolCall(item);
    case "websearch":
      return webSearch(item);
    case "extension": {
      const kind = typeKey(item.kind);
      if (kind === "websearch") return webSearch(item);
      if (kind === "clocksleep")
        return {
          name: "sleep",
          status: statusOf(item),
          durationMs: null,
          detail: { kind: "other" },
        };
      return {
        name: kind === "imagegengeneration" ? "image_gen" : nameOf(item.kind, "extension"),
        status: statusOf(item),
        durationMs: durationOf(item),
        detail: { kind: "other" },
      };
    }
    case "sleep":
      return {
        name: "sleep",
        status: "completed",
        durationMs: durationOf(item),
        detail: { kind: "other" },
      };
    case "imagegeneration":
      return {
        name: "image_gen",
        status: statusOf(item),
        durationMs: null,
        detail: { kind: "other" },
      };
    case "imageview": {
      const target = text(item.path);
      const shown = visible(target) ? displayToolPath(target, context) : "";
      return {
        name: "view_image",
        status: "completed",
        durationMs: null,
        detail: finalizeDetail({
          kind: "read",
          title: shown,
          locations: shown ? [{ path: shown }] : [],
        }),
      };
    }
    case "subagentactivity":
      return subAgentActivity(item);
    case "collabagenttoolcall":
      return collabAgentToolCall(item);
    default:
      return null;
  }
}

/** Bounded, redacted parts of a Claude Code tool result, kept until the call is seen. */
export interface ClaudeToolResult {
  output?: string;
  outputTruncated?: boolean;
  /** Text of the tool_result content; used only by tools whose output is shown. */
  text?: string;
  textTruncated?: boolean;
  /** Redacted unified diff lines from `structuredPatch`. */
  patch?: string[];
  patchAdded?: number;
  patchRemoved?: number;
  patchTruncated?: boolean;
  created?: boolean;
}
function resultText(content: unknown): string | null {
  if (typeof content === "string") return content;
  const parts = arrayOf(content)
    .filter((entry): entry is JsonRecord => isRecord(entry) && entry.type === "text")
    .map((entry) => text(entry.text))
    .filter((value): value is string => value !== null);
  return parts.length ? parts.join("\n") : null;
}
/**
 * Claude Code writes the structured result (`toolUseResult`) beside the
 * tool_result block. Only stdout/stderr, the structured patch and the
 * create/update marker are kept; `originalFile` and file contents are not.
 */
export function claudeToolResult(
  structured: unknown,
  content: unknown,
): ClaudeToolResult | undefined {
  const result: ClaudeToolResult = {};
  const contentText = resultText(content) ?? (typeof structured === "string" ? structured : null);
  const tail = outputTail(contentText);
  if (tail) {
    result.text = tail.text;
    if (tail.truncated) result.textTruncated = true;
  }
  if (isRecord(structured)) {
    const streams = [text(structured.stdout), text(structured.stderr)].filter(visible);
    if (streams.length) {
      const tail = outputTail(streams.join("\n"));
      if (tail) {
        result.output = tail.text;
        if (tail.truncated) result.outputTruncated = true;
      }
    }
    const hunks = arrayOf(structured.structuredPatch).filter(isRecord);
    if (hunks.length) {
      const lines: string[] = [];
      for (const hunk of hunks) {
        const numbers = [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines];
        lines.push(
          numbers.every((value) => typeof value === "number")
            ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
            : "@@",
        );
        for (const line of arrayOf(hunk.lines)) if (typeof line === "string") lines.push(line);
      }
      const counts = countMarked(lines.filter((line) => !line.startsWith("@@")));
      const window = rawHeadLines(lines);
      result.patch = redactDiffLines(window.lines);
      result.patchAdded = counts.added;
      result.patchRemoved = counts.removed;
      if (window.truncated) result.patchTruncated = true;
    }
    if (structured.type === "create") result.created = true;
  }
  return Object.keys(result).length ? result : undefined;
}
export function claudeToolResultBytes(result: ClaudeToolResult | undefined): number {
  return result ? jsonBytes(result) : 0;
}

function editSource(
  filePath: string,
  input: JsonRecord,
  name: string,
  result: ClaudeToolResult | undefined,
): DiffSource {
  if (result?.patch?.length)
    return {
      path: filePath,
      change: "update",
      added: result.patchAdded ?? 0,
      removed: result.patchRemoved ?? 0,
      lines: result.patch,
    };
  if (name === "Write") {
    const content = text(input.content) ?? "";
    return {
      path: filePath,
      change: "add",
      added: lineCount(content),
      removed: 0,
      lines: prefixed(content, "+"),
    };
  }
  if (name === "NotebookEdit") {
    const source = text(input.new_source) ?? "";
    const remove = input.edit_mode === "delete";
    return {
      path: filePath,
      change: "update",
      added: remove ? 0 : lineCount(source),
      removed: 0,
      lines: remove ? [] : prefixed(source, "+"),
    };
  }
  const edits =
    name === "MultiEdit" ? arrayOf(input.edits).filter(isRecord) : [input as JsonRecord];
  const lines: string[] = [];
  for (const edit of edits) {
    const before = text(edit.old_string);
    const after = text(edit.new_string);
    if (before === null || after === null) continue;
    lines.push(...diffStrings(before, after));
  }
  return { path: filePath, change: "update", ...countMarked(lines), lines };
}
function todoText(input: JsonRecord): string | undefined {
  const lines = arrayOf(input.todos)
    .filter(isRecord)
    .map((todo) => {
      const mark =
        todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[-]" : "[ ]";
      return visible(todo.content) ? `${mark} ${todo.content.trim()}` : "";
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}
function claudeMcpName(name: string): { server: string; tool: string } | null {
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  return { server: parts[1]!, tool: parts.slice(2).join("__") };
}

/**
 * Detail for one Claude Code tool call, from its `tool_use` input and, when
 * already seen, its result. Unknown tools return undefined and keep the
 * plain name-and-status row.
 */
export function claudeToolDetail(
  name: string,
  input: unknown,
  result: ClaudeToolResult | undefined,
  context: ToolContext = {},
): ConversationToolDetail | undefined {
  const values = isRecord(input) ? input : {};
  const target = (key: string) => {
    const value = text(values[key]);
    return visible(value) ? displayToolPath(value, context) : "";
  };
  const plain = (value: unknown, maximum: number = TOOL_DETAIL_LIMITS.titleChars) =>
    visible(value) ? chars(redactToolText(value.trim()), maximum) : "";
  const textPreview = (value: string | undefined) =>
    value ? headBytes(redactToolText(value), TOOL_DETAIL_LIMITS.textBytes) : undefined;
  switch (name) {
    case "Bash": {
      const command = boundedCommand(text(values.command) ?? "");
      const output =
        result?.output !== undefined
          ? { text: result.output, truncated: result.outputTruncated === true }
          : result?.text !== undefined
            ? { text: result.text, truncated: result.textTruncated === true }
            : undefined;
      return finalizeDetail({
        kind: "execute",
        title: firstLine(command.text),
        content: [terminal(command, output, null)],
      });
    }
    case "Read":
    case "NotebookRead": {
      const shown = target(name === "Read" ? "file_path" : "notebook_path");
      const line =
        typeof values.offset === "number" && values.offset > 0 ? values.offset : undefined;
      return finalizeDetail({
        kind: "read",
        title: shown,
        locations: shown ? [line === undefined ? { path: shown } : { path: shown, line }] : [],
      });
    }
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const key = name === "NotebookEdit" ? "notebook_path" : "file_path";
      const filePath = text(values[key]);
      if (!visible(filePath)) return finalizeDetail({ kind: "edit" });
      const source = editSource(filePath, values, name, result);
      const content = diffContent(source, context, new DiffBudget());
      return finalizeDetail({
        kind: "edit",
        title: content.path,
        locations: [{ path: content.path }],
        content: [content],
      });
    }
    case "Grep":
    case "Glob": {
      const pattern = plain(values.pattern, 200);
      const where = target("path") || plain(values.glob, 200);
      return finalizeDetail({
        kind: "search",
        title: [pattern, where].filter(Boolean).join(" · "),
        locations: target("path") ? [{ path: target("path") }] : [],
      });
    }
    case "LS":
      return finalizeDetail({ kind: "search", title: target("path") });
    case "WebFetch":
      return finalizeDetail({ kind: "fetch", title: plain(values.url) });
    case "WebSearch":
      return finalizeDetail({ kind: "fetch", title: plain(values.query) });
    case "Task":
    case "Agent":
      return finalizeDetail({
        kind: "other",
        title: plain(values.description),
        agent: {
          action: "spawn",
          ...(visible(values.subagent_type) ? { name: nameOf(values.subagent_type, "") } : {}),
        },
      });
    case "TodoWrite":
      return finalizeDetail({
        kind: "think",
        content: textContent("input", textPreview(todoText(values))),
      });
    case "ExitPlanMode":
      return finalizeDetail({
        kind: "switch_mode",
        content: textContent("input", textPreview(text(values.plan) ?? undefined)),
      });
    case "AskUserQuestion": {
      const first = arrayOf(values.questions).find(isRecord);
      return finalizeDetail({ kind: "other", title: plain(first?.question) });
    }
    default: {
      const mcp = claudeMcpName(name);
      if (!mcp) return undefined;
      const server = nameOf(mcp.server, "");
      const tool = nameOf(mcp.tool, "");
      return finalizeDetail({
        kind: "other",
        title: [server, tool].filter(Boolean).join(" · "),
        mcp: { server, tool },
        content: [
          ...textContent("input", jsonPreview(input)),
          ...textContent(
            "output",
            result?.text
              ? { text: result.text, truncated: result.textTruncated === true }
              : undefined,
          ),
        ],
      });
    }
  }
}

const COMPACT_INPUT_BYTES = 64 * 1024;
const COMPACT_INPUT_KEYS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "glob",
  "url",
  "query",
  "description",
  "subagent_type",
];
/**
 * A tool_use input kept by a live runner until its result arrives. Large
 * inputs (a whole file being written) keep only the short fields titles use.
 */
export function compactClaudeInput(input: unknown): unknown {
  if (!isRecord(input) || jsonBytes(input) <= COMPACT_INPUT_BYTES) return input;
  const compact: JsonRecord = {};
  for (const key of COMPACT_INPUT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && byteLength(value) <= 4096) compact[key] = value;
  }
  return compact;
}

/** Bytes an item contributes to page and cache budgets beyond its message text. */
export function toolEventBytes(event: { tool?: unknown; turn_meta?: unknown }): number {
  return jsonBytes(event.tool) + jsonBytes(event.turn_meta);
}
