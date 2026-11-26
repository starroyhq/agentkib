import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { createHash } from "node:crypto";
import { indexedAntigravityEntry, readIndexedAntigravityPage } from "./antigravity-indexed-page";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ConversationEventPage } from "../../session-events";
import type { SessionListingIssue } from "../../sessions/history-provider";
import { pathIdentity } from "../../paths";
import { timestamp } from "../../timestamps";

export type AntigravityLocalSurface = "app" | "ide";
export interface AntigravityLocalRecord {
  surface: AntigravityLocalSurface;
  id: string;
  workspace: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number | null;
  availability: "readable" | "metadata-only";
}
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decoder = new TextDecoder("utf-8", { fatal: true });
type Field = { number: number; value: Buffer | bigint };
type Metadata = Omit<AntigravityLocalRecord, "surface" | "workspace" | "availability"> & {
  workspaces: string[];
};
type Row = Record<string, unknown>;
type RecordScope = { id?: string; workspaces: string[] };
const directory = (surface: AntigravityLocalSurface) =>
  surface === "app" ? "antigravity" : "antigravity-ide";
function absent(error: unknown) {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Only observed summary fields are projected; arbitrary .pb trajectories are never guessed. */
function fields(data: Buffer): Field[] {
  if (data.length > MAX_METADATA) throw new Error("Antigravity summary exceeds limit");
  let at = 0;
  const integer = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (at >= data.length) throw new Error("Truncated Antigravity summary");
      const byte = data[at++]!;
      if (shift === 63n && byte > 1) throw new Error("Invalid Antigravity summary integer");
      result |= BigInt(byte & 127) << shift;
      if (byte < 128) return result;
    }
    throw new Error("Invalid Antigravity summary integer");
  };
  const result: Field[] = [];
  while (at < data.length) {
    if (result.length >= 20_000) throw new Error("Antigravity summary exceeds field limit");
    const tag = integer(),
      number = Number(tag >> 3n),
      wire = Number(tag & 7n);
    if (!number || number > 536_870_911) throw new Error("Invalid Antigravity summary tag");
    if (wire === 0) result.push({ number, value: integer() });
    else {
      const size = wire === 2 ? Number(integer()) : wire === 1 ? 8 : wire === 5 ? 4 : NaN;
      if (!Number.isSafeInteger(size) || size < 0 || at + size > data.length)
        throw new Error("Invalid Antigravity summary field");
      if (wire === 2) result.push({ number, value: data.subarray(at, at + size) });
      at += size;
    }
  }
  return result;
}
function blob(value: unknown, maximum = MAX_METADATA): Buffer {
  const result =
    typeof value === "string"
      ? Buffer.from(value)
      : value instanceof Uint8Array
        ? Buffer.from(value)
        : null;
  if (!result || result.length > maximum) throw new Error("Invalid Antigravity local record");
  return result;
}
function text(value: unknown, maximum = MAX_METADATA) {
  return decoder.decode(blob(value, maximum));
}
function first(data: Field[], number: number): Buffer | undefined {
  const field = data.find((field) => field.number === number)?.value;
  return Buffer.isBuffer(field) ? field : undefined;
}
function filePath(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 16_384)
    return null;
  try {
    if (!value.startsWith("file://")) return null;
    const url = new URL(value);
    if (url.hostname && url.hostname !== "localhost") return null;
    if (url.search || url.hash || url.username || url.password) return null;
    const result = fileURLToPath(url);
    return path.isAbsolute(result) ? result : null;
  } catch {
    return null;
  }
}
function protoWorkspaces(values: Field[]): string[] {
  return values
    .filter((field) => field.number === 9 && Buffer.isBuffer(field.value))
    .map((field) => first(fields(field.value as Buffer), 1))
    .map((value) => (value ? filePath(decoder.decode(value)) : null))
    .filter((value): value is string => value !== null);
}
function protoMetadata(data: Buffer, expectedId?: string): Metadata {
  const values = fields(data);
  // The summary's field 4 is another UUID, not the conversation identity.
  // Only the database primary key or the protobuf map key proves this identity.
  const id = expectedId;
  if (!id || !UUID.test(id)) throw new Error("Invalid Antigravity summary identity");
  const title = first(values, 1);
  const workspaces = protoWorkspaces(values);
  let updated: string | null = null;
  // Field 3 is the last-modified Timestamp, verified against the native summary database.
  const modified = first(values, 3);
  if (modified) {
    const times = fields(modified);
    const seconds = times.find((field) => field.number === 1)?.value;
    const nanos = times.find((field) => field.number === 2)?.value ?? 0n;
    if (
      typeof seconds === "bigint" &&
      typeof nanos === "bigint" &&
      nanos >= 0n &&
      nanos < 1_000_000_000n
    ) {
      const milliseconds = Number(seconds) * 1000 + Number(nanos / 1_000_000n);
      if (Number.isSafeInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 8.64e15)
        updated = new Date(milliseconds).toISOString();
    }
  }
  return {
    id: id.toLowerCase(),
    title: title ? decoder.decode(title).slice(0, 512) || null : null,
    created_at: null,
    updated_at: updated,
    message_count: null,
    workspaces,
  };
}
function safeRoot(home: string, surface: AntigravityLocalSurface): string | null {
  const base = realpathSync(home);
  const gemini = path.join(base, ".gemini"),
    root = path.join(gemini, directory(surface));
  for (const entry of [gemini, root]) {
    try {
      const info = lstatSync(entry);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe Antigravity history root");
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  return root;
}
function safeFile(root: string, relative: string, max = MAX_TOTAL): string | null {
  const parts = relative.split("/");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const info = lstatSync(current);
      if (
        info.isSymbolicLink() ||
        (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.size > max)
      )
        throw new Error("Unsafe Antigravity history file");
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
  }
  return current;
}
function boundedRead(root: string, relative: string): Buffer | null {
  const file = safeFile(root, relative, MAX_METADATA);
  if (!file) return null;
  const fd = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_METADATA)
      throw new Error("Antigravity summary exceeds limit");
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const count = readSync(fd, bytes, at, bytes.length - at, at);
      if (!count) throw new Error("Antigravity summary changed during read");
      at += count;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function openDatabase(root: string) {
  const name = "conversation_summaries.db";
  const maxSize = 512 * 1024 * 1024;
  const file = safeFile(root, name, maxSize);
  if (!file) return null;
  const sidecar = (suffix: string) => safeFile(root, `${name}${suffix}`, maxSize);
  const wal = sidecar("-wal"),
    shm = sidecar("-shm"),
    journal = sidecar("-journal");
  if (!!wal !== !!shm) throw new Error("Antigravity database sidecars are incomplete");
  // Opening a closed WAL database in ordinary read-only mode can create sidecars.
  // Keep normal locking for active writers so committed WAL entries are visible.
  const closed = !wal && !journal;
  const version = () =>
    [file, sidecar("-wal"), sidecar("-journal")]
      .map((entry) => {
        if (!entry) return "";
        const info = lstatSync(entry, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Unsafe Antigravity history file");
        return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
      })
      .join("|");
  const initial = version();
  const db = new DatabaseSync(closed ? `${pathToFileURL(file).href}?immutable=1` : file, {
    readOnly: true,
    timeout: 100,
  });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN DEFERRED");
    return {
      db,
      version: initial,
      verify(checkVersion = closed) {
        if (
          checkVersion &&
          (version() !== initial ||
            (closed && (sidecar("-wal") || sidecar("-shm") || sidecar("-journal"))))
        )
          throw new Error("Antigravity database changed during read");
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
function databaseWorkspaces(row: Row): string[] {
  const uriValue: unknown = JSON.parse(text(row.workspace_uris));
  if (!Array.isArray(uriValue) || uriValue.length > 128)
    throw new Error("Invalid Antigravity workspace metadata");
  return uriValue.map(filePath).filter((value): value is string => value !== null);
}

function nativeId(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

function workspaceProof(read: () => string[]): string[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function databaseRecordScope(row: Row): RecordScope {
  const workspaces = workspaceProof(() => databaseWorkspaces(row));
  const raw = row.raw_summary;
  return {
    id: nativeId(row.conversation_id),
    workspaces:
      workspaces.length || !(raw instanceof Uint8Array)
        ? workspaces
        : workspaceProof(() => protoWorkspaces(fields(blob(raw)))),
  };
}

function databaseMetadata(row: Row): Metadata {
  const id = nativeId(row.conversation_id);
  if (!id) throw new Error("Invalid Antigravity summary identity");
  const raw = row.raw_summary == null ? null : blob(row.raw_summary);
  const proto =
    row.raw_summary instanceof Uint8Array && raw?.length ? protoMetadata(raw, id) : null;
  const workspaces = databaseWorkspaces(row);
  const title =
    typeof row.title === "string" && row.title ? row.title.slice(0, 512) : (proto?.title ?? null);
  return {
    id,
    title,
    workspaces: workspaces.length ? workspaces : (proto?.workspaces ?? []),
    created_at: null,
    updated_at: timestamp(row.last_modified_time, true) ?? proto?.updated_at ?? null,
    message_count: null,
  };
}

function storageBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  return value instanceof Uint8Array ? value.byteLength : 0;
}

/** Offline search projections are partial history, never a writable/resumable native session. */
export class AntigravityLocalStore {
  constructor(
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly observeProjectionBytes?: (bytes: number) => void,
  ) {}
  #home() {
    return this.env.HOME ?? this.env.USERPROFILE ?? homedir();
  }
  list(
    workspace?: string,
    onlyId?: string,
  ): {
    records: AntigravityLocalRecord[];
    incomplete: boolean;
    issues?: SessionListingIssue[];
  } {
    const result: AntigravityLocalRecord[] = [];
    const summaries = new Map<
      AntigravityLocalSurface,
      { records: Metadata[]; databaseIds: Set<string> }
    >();
    const roots = new Map<AntigravityLocalSurface, string>();
    const issues: SessionListingIssue[] = [];
    const reportedSources = new Set<string>();
    const workspaceKey = workspace ? pathIdentity(workspace) : null;
    const matchingWorkspaces = (values: string[]) =>
      workspaceKey === null
        ? values
        : values.filter((value) => pathIdentity(value) === workspaceKey);
    let incomplete = false;
    const report = (surface: AntigravityLocalSurface, code: string, record?: RecordScope) => {
      if (!record) {
        const key = `${surface}:${code}`;
        if (reportedSources.has(key)) return;
        reportedSources.add(key);
        issues.push({ surface, code, scope: "source" });
        incomplete = true;
        return;
      }
      if (record.workspaces.length && !matchingWorkspaces(record.workspaces).length) return;
      const scope = record.workspaces.length ? "workspace" : "unattributed";
      issues.push({ surface, code, scope, ...(record.id ? { id: record.id } : {}) });
      incomplete ||= scope === "workspace";
    };
    for (const surface of ["app", "ide"] as const) {
      let root: string | null;
      try {
        root = safeRoot(this.#home(), surface);
      } catch {
        report(surface, "antigravity-database-source");
        continue;
      }
      if (!root) continue;
      roots.set(surface, root);
      const metadata = new Map<string, Metadata>();
      try {
        const source = openDatabase(root);
        if (source)
          try {
            const rows = source.db
              .prepare(
                `SELECT conversation_id,substr(title,1,512) AS title,substr(workspace_uris,1,${MAX_METADATA + 1}) AS workspace_uris,last_modified_time,substr(raw_summary,1,${MAX_METADATA + 1}) AS raw_summary FROM conversation_summaries ${onlyId ? "WHERE conversation_id=?" : ""} LIMIT ${MAX_RECORDS + 1}`,
              )
              .iterate(...(onlyId ? [onlyId] : []));
            const verified: Metadata[] = [];
            let bytes = 0,
              seen = 0;
            for (const row of rows) {
              bytes += storageBytes(row.workspace_uris) + storageBytes(row.raw_summary);
              if (++seen > MAX_RECORDS || bytes > MAX_TOTAL) {
                report(surface, "antigravity-local-limit");
                break;
              }
              try {
                verified.push(databaseMetadata(row));
              } catch {
                report(surface, "antigravity-database-record", databaseRecordScope(row));
              }
            }
            source.verify();
            for (const value of verified) metadata.set(value.id, value);
          } finally {
            source.db.close();
          }
      } catch {
        report(surface, "antigravity-database-source");
      }
      const databaseIds = new Set(metadata.keys());
      try {
        const summaryFile =
          onlyId && metadata.has(onlyId) ? null : boundedRead(root, "agyhub_summaries_proto.pb");
        if (summaryFile) {
          // The map envelope may contain many individually bounded summary messages.
          for (const entry of fields(summaryFile)) {
            if (entry.number !== 1 || !Buffer.isBuffer(entry.value)) continue;
            if (metadata.size >= MAX_RECORDS) {
              report(surface, "antigravity-local-limit");
              break;
            }
            let id: string | undefined;
            let data: Buffer | undefined;
            try {
              const parts = fields(entry.value),
                key = first(parts, 1);
              data = first(parts, 2);
              if (!key || !data) throw new Error("Invalid Antigravity summary map");
              id = nativeId(decoder.decode(key));
              if (onlyId && id !== onlyId) continue;
              const value = protoMetadata(data, id);
              if (!metadata.has(value.id)) metadata.set(value.id, value);
            } catch {
              const summary = data;
              report(surface, "antigravity-summary-record", {
                id,
                workspaces: summary ? workspaceProof(() => protoWorkspaces(fields(summary))) : [],
              });
            }
          }
        }
      } catch {
        report(surface, "antigravity-summary-source");
      }
      summaries.set(surface, { records: [...metadata.values()], databaseIds });
    }
    for (const [surface, root] of roots) {
      const own = summaries.get(surface);
      const candidates = new Map(own?.records.map((value) => [value.id, value]));
      // App migrations retain IDs; only recover the other surface's known identity when its
      // trajectory also exists here. Extra orphan trajectories are never assigned a workspace.
      for (const [other, { records }] of summaries)
        if (other !== surface)
          for (const record of records)
            if (!candidates.has(record.id)) candidates.set(record.id, record);
      let source: ReturnType<typeof openDatabase> = null;
      let readableEntry: ReturnType<DatabaseSync["prepare"]> | undefined;
      try {
        source = openDatabase(root);
        const db = source?.db;
        const fts = db
          ?.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations_fts'",
          )
          .get();
        if (db && fts) readableEntry = indexedAntigravityEntry(db);
      } catch {
        report(surface, "antigravity-database-source");
      }
      try {
        const records: AntigravityLocalRecord[] = [];
        for (const candidate of candidates.values()) {
          const directories = matchingWorkspaces(candidate.workspaces);
          if (!directories.length) continue;
          let readable = false;
          try {
            if (!safeFile(root, `conversations/${candidate.id}.pb`, 512 * 1024 * 1024)) continue;
          } catch {
            report(surface, "antigravity-trajectory-record", candidate);
            continue;
          }
          try {
            readable =
              own?.databaseIds.has(candidate.id) === true && !!readableEntry?.get(candidate.id);
          } catch {
            report(surface, "antigravity-database-record", candidate);
          }
          if (result.length + records.length + directories.length > MAX_RECORDS) {
            report(surface, "antigravity-local-limit");
            break;
          }
          for (const directory of directories) {
            const { workspaces: _workspaces, ...metadata } = candidate;
            records.push({
              ...metadata,
              surface,
              workspace: directory,
              availability: readable ? "readable" : "metadata-only",
            });
          }
        }
        source?.verify();
        result.push(...records);
      } catch {
        report(surface, "antigravity-database-source");
      } finally {
        source?.db.close();
      }
    }
    return { records: result, incomplete, ...(issues.length ? { issues } : {}) };
  }
  events(
    surface: AntigravityLocalSurface,
    id: string,
    workspace: string,
    cursor: string | null,
    limit: number,
  ): ConversationEventPage {
    if (!UUID.test(id) || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const root = safeRoot(this.#home(), surface);
    if (!root || !safeFile(root, `conversations/${id.toLowerCase()}.pb`, 512 * 1024 * 1024))
      throw new Error("session-workspace-mismatch");
    const source = openDatabase(root);
    if (!source) throw new Error("session-workspace-mismatch");
    const { db } = source;
    try {
      const proof = db
        .prepare(
          `SELECT conversation_id,substr(title,1,512) AS title,substr(workspace_uris,1,${MAX_METADATA + 1}) AS workspace_uris,last_modified_time,substr(raw_summary,1,${MAX_METADATA + 1}) AS raw_summary FROM conversation_summaries WHERE conversation_id=?`,
        )
        .get(id);
      const workspaceKey = pathIdentity(workspace);
      if (
        !proof ||
        !databaseMetadata(proof).workspaces.some((value) => pathIdentity(value) === workspaceKey) ||
        !indexedAntigravityEntry(db).get(id)
      )
        throw new Error("session-workspace-mismatch");
      const prefix = `antigravity-local-v1-${createHash("sha256")
        .update([surface, id, workspaceKey, source.version].join("\0"))
        .digest("hex")}-`;
      const page = readIndexedAntigravityPage(
        db,
        { id, surface, prefix, cursor, limit },
        this.observeProjectionBytes,
      );
      source.verify(true);
      return page;
    } finally {
      db.close();
    }
  }
}
