import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileTime } from "./asset-scanner";
import { isFile, readText, within } from "./files";
import { isDirectory, isProbeWorkspace } from "./paths";
import { jsonLines } from "./jsonl";
import { sessionTitle, type NativeSessionSource } from "./codex-sessions";
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
function transcriptHeader(
  file: string,
  probeWorkspace = isProbeWorkspace,
): NativeSessionSource | null {
  let nativeRef = path.basename(file, ".jsonl"),
    cwd: string | null = null,
    created: string | null = null,
    updated = fileTime(file),
    branch: string | null = null,
    sidechain: boolean | null = null;
  for (const { value } of jsonLines(file, { bytes: 2 * 1024 * 1024, lines: 256 })) {
    const row = record(value);
    if (!row) continue;
    nativeRef = text(row.sessionId) ?? nativeRef;
    cwd ??= text("cwd" in row ? row.cwd : row.projectPath);
    branch ??= text(row.gitBranch);
    if (sidechain === null && ["user", "assistant"].includes(String(row.type)))
      sidechain = typeof row.isSidechain === "boolean" ? row.isSidechain : false;
    const at = parseTime(row.timestamp);
    created = earliest(created, at);
    updated = latest(updated, at);
  }
  if (cwd === null || probeWorkspace(cwd)) return null;
  return {
    cwd,
    transcript: file,
    session: {
      native_ref: nativeRef,
      agent: "claude-code",
      title: null,
      origin: sidechain === null ? "unknown" : sidechain ? "auxiliary" : "interactive",
      created_at: created,
      updated_at: updated,
      message_count: null,
      git_branch: sessionTitle(branch),
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
  home() {
    return this.environment.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
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
    const home = this.home(),
      projects = path.join(home, "projects"),
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
    const history = path.join(home, "history.jsonl");
    if (isFile(history)) {
      try {
        for (const { value } of jsonLines(history, {
          bytes: 256 * 1024 * 1024,
          rejectOversized: true,
        })) {
          const row = record(value);
          if (!row) continue;
          const session =
            typeof row.sessionId === "string" ? sessions.get(row.sessionId) : undefined;
          if (session) {
            const at = parseTime(row.timestamp);
            session.session.created_at = earliest(session.session.created_at, at);
            session.session.updated_at = latest(session.session.updated_at, at);
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
