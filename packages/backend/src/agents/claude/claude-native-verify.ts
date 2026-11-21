import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { probeClaudeSessionFile } from "./claude-session-probe";
import { isReparseOrSymlink } from "../../native-files";
import { pathIdentity } from "../../paths";
import { readClaudeDocument, rowTurn } from "../../session-document-providers";
import type { SessionDocument } from "../../session-model";

/**
 * Structural read-back of a Claude Code transcript that AgentKib has just written.
 *
 * It proves the file is what the writer (`renderNative`) intended and what AgentKib's own readers
 * and the format probe accept. It cannot prove that `claude --resume` will find the session: no
 * Claude process is started, so a CLI-side lookup rule AgentKib does not know about stays unchecked.
 */

/** Record types `renderNative` writes for Claude Code. Anything else is unexpected output. */
const WRITTEN_TYPES = new Set(["user", "assistant", "last-prompt"]);
const MESSAGE_TYPES = new Set(["user", "assistant"]);

export interface ClaudeNativeExpectation {
  /** Session id the launch request names; must equal the file name and every record's sessionId. */
  sessionId: string;
  /** Workspace the session was written for; must equal every message record's cwd. */
  workspace: string;
  /** `<projects>/<claudeProjectKey(workspace)>`: the only directory the file may live in. */
  directory: string;
}

function fail(reason: string): never {
  throw new Error(`Claude session read-back failed: ${reason}`);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** The tolerant reader drops fields such as message.role, so normalized turns alone cannot bind it. */
function assertTranscriptUnchanged(file: string, text: string, original: BigIntStats): void {
  const changed = () => fail("transcript changed during read-back");
  const metadata = lstatSync(file, { bigint: true });
  if (!sameSnapshot(original, metadata) || isReparseOrSymlink(file, metadata)) changed();
  if (metadata.size !== BigInt(Buffer.byteLength(text))) changed();
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameSnapshot(original, fstatSync(fd, { bigint: true }))) changed();
    const expected = Buffer.from(text);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < expected.length) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, expected.length - offset),
        offset,
      );
      if (!count || !chunk.subarray(0, count).equals(expected.subarray(offset, offset + count)))
        changed();
      offset += count;
    }
    if (
      readSync(fd, chunk, 0, 1, expected.length) !== 0 ||
      !sameSnapshot(original, fstatSync(fd, { bigint: true })) ||
      !sameSnapshot(original, lstatSync(file, { bigint: true }))
    )
      changed();
  } finally {
    closeSync(fd);
  }
}

/** Validate every block the native writer supports before the tolerant history reader sees it. */
function readableMessage(record: Record<string, unknown>, line: number) {
  const where = `line ${line}`;
  const message = record.message;
  if (!object(message)) fail(`${where} has no valid message`);
  if (message.role !== record.type) fail(`${where} has a mismatched message role`);
  if (record.isSidechain === true || record.isCompactSummary === true)
    fail(`${where} is not an ordinary main-session message`);
  const content = message.content;
  if (typeof content !== "string" && (!Array.isArray(content) || !content.length))
    fail(`${where} has no valid message content`);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!object(block)) fail(`${where} has a malformed content block`);
      switch (block.type) {
        case "text":
          if (typeof block.text !== "string") fail(`${where} has invalid text`);
          break;
        case "tool_use":
          if (typeof block.id !== "string" || typeof block.name !== "string" || !("input" in block))
            fail(`${where} has an invalid tool call`);
          break;
        case "tool_result":
          if (
            typeof block.tool_use_id !== "string" ||
            typeof block.content !== "string" ||
            typeof block.is_error !== "boolean"
          )
            fail(`${where} has an invalid tool result`);
          break;
        case "image":
        case "document": {
          const source = block.source;
          if (
            !object(source) ||
            source.type !== "base64" ||
            typeof source.media_type !== "string" ||
            typeof source.data !== "string" ||
            !source.data.trim() ||
            (block.name !== null && typeof block.name !== "string")
          )
            fail(`${where} has an invalid attachment`);
          break;
        }
        default:
          fail(`${where} has an unsupported content block`);
      }
    }
  }
  const turn = rowTurn({ line, value: record }, new Set(), new Map());
  if (!turn || turn.blocks.length !== (Array.isArray(content) ? content.length : 1))
    fail(`${where} loses message content in the history reader`);
  return turn;
}

export function verifyClaudeTranscript(
  file: string,
  text: string,
  expected: ClaudeNativeExpectation,
): void {
  if (path.basename(file, ".jsonl") !== expected.sessionId)
    fail("session id does not match the file name");
  if (pathIdentity(path.dirname(file)) !== pathIdentity(expected.directory))
    fail("file is not in the project directory Claude Code derives from the workspace");
  const snapshot = lstatSync(file, { bigint: true });
  if (
    !snapshot.isFile() ||
    isReparseOrSymlink(file, snapshot) ||
    snapshot.size > 256n * 1024n * 1024n ||
    Buffer.byteLength(text) > 256 * 1024 * 1024
  )
    fail("unsafe transcript or transcript exceeds the 256 MiB read limit");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) fail("file is empty");
  const records: Record<string, unknown>[] = [];
  lines.forEach((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(`line ${index + 1} is not valid JSON`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value))
      fail(`line ${index + 1} is not a JSON object`);
    records.push(value as Record<string, unknown>);
  });
  const seen = new Set<string>();
  let previous: string | null = null;
  let messages = 0;
  const expectedTurns: SessionDocument["turns"] = [];
  let last: Record<string, unknown> | null = null;
  records.forEach((record, index) => {
    const where = `line ${index + 1}`;
    if (typeof record.type !== "string" || !WRITTEN_TYPES.has(record.type))
      fail(`${where} has an unexpected record type`);
    if (record.sessionId !== expected.sessionId) fail(`${where} has a different sessionId`);
    if (last) fail(`${where} follows the closing last-prompt record`);
    if (record.type === "last-prompt") {
      last = record;
      return;
    }
    if (!MESSAGE_TYPES.has(record.type)) return;
    if (
      typeof record.cwd !== "string" ||
      pathIdentity(record.cwd) !== pathIdentity(expected.workspace)
    )
      fail(`${where} has a different cwd`);
    if (typeof record.uuid !== "string" || !record.uuid) fail(`${where} has no uuid`);
    if (seen.has(record.uuid)) fail(`${where} repeats a uuid`);
    if (messages === 0 ? record.parentUuid !== null : record.parentUuid !== previous)
      fail(`${where} has a dangling or out-of-order parentUuid`);
    expectedTurns.push(readableMessage(record, index + 1));
    seen.add(record.uuid);
    previous = record.uuid;
    messages++;
  });
  if (!messages) fail("file holds no user or assistant record");
  const closing = last as Record<string, unknown> | null;
  if (!closing) fail("closing last-prompt record is missing");
  if (closing!.leafUuid !== previous) fail("last-prompt does not point at the final message");
  const probe = probeClaudeSessionFile(file);
  if (probe !== null) fail(`format probe rejected the file (${probe})`);
  // The probe only checks the opening. Reopening an imported session has no frozen ChangeSet
  // to compare against, so every record must survive the same bounded reader used by handoff.
  let document: SessionDocument;
  try {
    document = readClaudeDocument(
      {
        agent: "claude-code",
        workspace_id: expected.workspace,
        title: null,
        created_at: null,
        updated_at: null,
        git_branch: null,
      },
      file,
      false,
    );
  } catch {
    fail("complete history reader rejected the file");
  }
  if (!isDeepStrictEqual(document.turns, expectedTurns))
    fail("complete history reader changed or omitted message content");
  // Detect replacement or writes across the probe/reader, and compare the original bytes too:
  // a different on-disk role can otherwise normalize to exactly the same turns as `text`.
  assertTranscriptUnchanged(file, text, snapshot);
}
