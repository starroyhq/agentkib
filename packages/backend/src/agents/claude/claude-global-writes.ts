import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpDiagnosticMessage } from "@agentkib/runtime-protocol";
import { pathIdentity } from "../../paths";

// A running Claude Code keeps its own copy of the global configuration file in memory and may
// write the whole file back, which undoes what AgentKib changed (audit P1-5). AgentKib does not
// look for Claude Code processes: process lists differ per platform, they cannot tell a terminal
// session from the editor extension or the desktop app, and a wrong answer would either nag or
// hide the risk. Instead the review screens always say to close Claude Code first, and the
// migration leaves a small record that the next scan compares with the file.
//
// The record holds only a path, the names of the servers the migration took out of the file, a
// time and the hash of what was written; no server definition and no value.

export interface ClaudeGlobalWrite {
  file: string;
  names: string[];
  at: string;
  /** SHA-256 of the file as AgentKib wrote it. */
  hash: string;
}

const FILE_NAME = "claude-global-writes.json";
const MAX_RECORDS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NAMES = 256;

const recordFile = (dataDir: string) => path.join(dataDir, FILE_NAME);

export function readClaudeGlobalWrites(dataDir: string, now = Date.now()): ClaudeGlobalWrite[] {
  try {
    if (statSync(recordFile(dataDir)).size > 256 * 1024) return [];
    const parsed: unknown = JSON.parse(readFileSync(recordFile(dataDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ClaudeGlobalWrite =>
          item !== null &&
          typeof item === "object" &&
          typeof item.file === "string" &&
          typeof item.hash === "string" &&
          typeof item.at === "string" &&
          Array.isArray(item.names) &&
          item.names.every((name: unknown) => typeof name === "string"),
      )
      .filter((item) => now - Date.parse(item.at) < MAX_AGE_MS)
      .slice(-MAX_RECORDS);
  } catch {
    return [];
  }
}

/** Remembers a migration of the global file. Advisory only: a failure here never fails the migration. */
export function recordClaudeGlobalWrite(
  dataDir: string,
  write: { file: string; names: string[]; content: string },
): void {
  try {
    const entry: ClaudeGlobalWrite = {
      file: write.file,
      names: write.names.slice(0, MAX_NAMES),
      at: new Date().toISOString(),
      hash: createHash("sha256").update(write.content).digest("hex"),
    };
    // A newer migration of the same file replaces the earlier record.
    const kept = readClaudeGlobalWrites(dataDir).filter(
      (item) => pathIdentity(item.file) !== pathIdentity(write.file),
    );
    mkdirSync(dataDir, { recursive: true });
    const temporary = `${recordFile(dataDir)}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...kept, entry], null, 2), { mode: 0o600 });
    renameSync(temporary, recordFile(dataDir));
  } catch {
    // Nothing to do: without a record the next scan simply has nothing to compare.
  }
}

const OVERWRITTEN_TEXT =
  "AgentKib moved this server out of Claude Code's configuration file, but it is there again and the file no longer matches what AgentKib wrote. A running Claude Code session may have written its older copy of the file over the change. Close Claude Code, then migrate again.";

interface Scanned {
  agent: string;
  scope: string;
  name: string;
  source_path: string;
  warnings: string[];
  warning_messages?: McpDiagnosticMessage[];
}

/**
 * Marks the servers of the global file that a migration took out and that are back, in a file that
 * AgentKib did not write in this form. Works on a fresh scan result; changes nothing on disk.
 */
export function markPossiblyOverwritten<T extends Scanned>(candidates: T[], dataDir: string): T[] {
  const records = readClaudeGlobalWrites(dataDir);
  if (!records.length) return candidates;
  const hashes = new Map<string, string | null>();
  const currentHash = (file: string) => {
    if (!hashes.has(file))
      try {
        hashes.set(
          file,
          statSync(file).size > 1024 * 1024
            ? null
            : createHash("sha256").update(readFileSync(file)).digest("hex"),
        );
      } catch {
        hashes.set(file, null);
      }
    return hashes.get(file)!;
  };
  for (const candidate of candidates) {
    if (candidate.agent !== "claude-code" || candidate.scope !== "home") continue;
    const record = records.find(
      (item) =>
        pathIdentity(item.file) === pathIdentity(candidate.source_path) &&
        item.names.includes(candidate.name),
    );
    if (!record) continue;
    const now = currentHash(candidate.source_path);
    if (now === null || now === record.hash) continue;
    if (!candidate.warnings.includes(OVERWRITTEN_TEXT)) {
      candidate.warnings.push(OVERWRITTEN_TEXT);
      candidate.warning_messages ??= [];
      candidate.warning_messages.push({ key: "mcp.manage.diagnostic.native_possibly_overwritten" });
    }
  }
  return candidates;
}
