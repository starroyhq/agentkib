import { createHash } from "node:crypto";
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
import type { ConversationEvent, ConversationEventPage } from "./session-events";
import { MAX_MESSAGE_BYTES, MAX_PAGE_BYTES, truncateUtf8 } from "./session-events";
import { pathIdentity } from "./paths";
import { timestamp } from "./timestamps";

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
function protoMetadata(data: Buffer, expectedId?: string): Metadata {
  const values = fields(data);
  // The summary's field 4 is another UUID, not the conversation identity.
  // Only the database primary key or the protobuf map key proves this identity.
  const id = expectedId;
  if (!id || !UUID.test(id)) throw new Error("Invalid Antigravity summary identity");
  const title = first(values, 1);
  const workspaces = values
    .filter((field) => field.number === 9 && Buffer.isBuffer(field.value))
    .map((field) => first(fields(field.value as Buffer), 1))
    .map((value) => (value ? filePath(decoder.decode(value)) : null))
    .filter((value): value is string => value !== null);
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
  const file = safeFile(root, relative);
  if (!file) return null;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TOTAL)
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
  const closed = !wal && !journal ? lstatSync(file, { bigint: true }) : null;
  const db = new DatabaseSync(closed ? `${pathToFileURL(file).href}?immutable=1` : file, {
    readOnly: true,
    timeout: 100,
  });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN DEFERRED");
    return {
      db,
      verify() {
        if (!closed) return;
        const current = lstatSync(file, { bigint: true });
        if (
          current.dev !== closed.dev ||
          current.ino !== closed.ino ||
          current.size !== closed.size ||
          current.mtimeNs !== closed.mtimeNs ||
          current.ctimeNs !== closed.ctimeNs ||
          sidecar("-wal") ||
          sidecar("-shm") ||
          sidecar("-journal")
        )
          throw new Error("Antigravity database changed during read");
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
function databaseMetadata(row: Row): Metadata {
  const id = String(row.conversation_id ?? "").toLowerCase();
  if (!UUID.test(id)) throw new Error("Invalid Antigravity summary identity");
  const proto =
    row.raw_summary instanceof Uint8Array && row.raw_summary.length
      ? protoMetadata(blob(row.raw_summary), id)
      : null;
  const uriValue: unknown = JSON.parse(text(row.workspace_uris));
  if (!Array.isArray(uriValue) || uriValue.length > 128)
    throw new Error("Invalid Antigravity workspace metadata");
  const workspaces = uriValue.map(filePath).filter((value): value is string => value !== null);
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

/** Offline search projections are partial history, never a writable/resumable native session. */
export class AntigravityLocalStore {
  constructor(readonly env: NodeJS.ProcessEnv = process.env) {}
  #home() {
    return this.env.HOME ?? this.env.USERPROFILE ?? homedir();
  }
  list(workspace?: string): { records: AntigravityLocalRecord[]; incomplete: boolean } {
    const result: AntigravityLocalRecord[] = [];
    const summaries = new Map<
      AntigravityLocalSurface,
      { records: Metadata[]; databaseIds: Set<string> }
    >();
    const roots = new Map<AntigravityLocalSurface, string>();
    let incomplete = false;
    for (const surface of ["app", "ide"] as const) {
      try {
        const root = safeRoot(this.#home(), surface);
        if (!root) continue;
        roots.set(surface, root);
        const metadata = new Map<string, Metadata>();
        const source = openDatabase(root);
        if (source)
          try {
            const rows = source.db
              .prepare(
                `SELECT conversation_id,substr(title,1,512) AS title,substr(workspace_uris,1,${MAX_METADATA + 1}) AS workspace_uris,last_modified_time,substr(raw_summary,1,${MAX_METADATA + 1}) AS raw_summary FROM conversation_summaries LIMIT ${MAX_RECORDS + 1}`,
              )
              .iterate();
            let bytes = 0;
            for (const row of rows) {
              if (metadata.size >= MAX_RECORDS)
                throw new Error("Antigravity history exceeds record limit");
              bytes +=
                blob(row.workspace_uris).length +
                (row.raw_summary ? blob(row.raw_summary).length : 0);
              if (bytes > MAX_TOTAL) throw new Error("Antigravity metadata exceeds total limit");
              try {
                const value = databaseMetadata(row);
                metadata.set(value.id, value);
              } catch {
                incomplete = true;
              }
            }
            source.verify();
          } finally {
            source.db.close();
          }
        const databaseIds = new Set(metadata.keys());
        const summaryFile = boundedRead(root, "agyhub_summaries_proto.pb");
        if (summaryFile) {
          // The map envelope may contain many individually bounded summary messages.
          for (const entry of fields(summaryFile)) {
            if (entry.number !== 1 || !Buffer.isBuffer(entry.value)) continue;
            if (metadata.size >= MAX_RECORDS)
              throw new Error("Antigravity history exceeds record limit");
            try {
              const parts = fields(entry.value),
                key = first(parts, 1),
                data = first(parts, 2);
              if (!key || !data) throw new Error("Invalid Antigravity summary map");
              const value = protoMetadata(data, decoder.decode(key));
              if (!metadata.has(value.id)) metadata.set(value.id, value);
            } catch {
              incomplete = true;
            }
          }
        }
        summaries.set(surface, { records: [...metadata.values()], databaseIds });
      } catch {
        incomplete = true;
      }
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
      try {
        source = openDatabase(root);
        const db = source?.db;
        const fts = db
          ?.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations_fts'",
          )
          .get();
        const records: AntigravityLocalRecord[] = [];
        for (const candidate of candidates.values()) {
          if (!safeFile(root, `conversations/${candidate.id}.pb`, 512 * 1024 * 1024)) continue;
          const readable =
            own?.databaseIds.has(candidate.id) &&
            !!fts &&
            !!db
              ?.prepare("SELECT 1 FROM conversations_fts WHERE conversation_id=? LIMIT 1")
              .get(candidate.id);
          for (const directory of candidate.workspaces) {
            if (workspace && pathIdentity(directory) !== pathIdentity(workspace)) continue;
            const { workspaces: _workspaces, ...metadata } = candidate;
            records.push({
              ...metadata,
              surface,
              workspace: directory,
              availability: readable ? "readable" : "metadata-only",
            });
            if (result.length + records.length > MAX_RECORDS)
              throw new Error("Antigravity history exceeds record limit");
          }
        }
        source?.verify();
        result.push(...records);
      } catch {
        incomplete = true;
      } finally {
        source?.db.close();
      }
    }
    return { records: result, incomplete };
  }
  events(
    surface: AntigravityLocalSurface,
    id: string,
    workspace: string,
    cursor: string | null,
    limit: number,
  ): ConversationEventPage {
    if (!UUID.test(id) || !Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error("invalid-request");
    const record = this.list(workspace).records.find(
      (value) => value.surface === surface && value.id === id.toLowerCase(),
    );
    if (!record || record.availability !== "readable")
      throw new Error("session-workspace-mismatch");
    const root = safeRoot(this.#home(), surface);
    if (!root) throw new Error("session-unavailable");
    const source = openDatabase(root);
    if (!source) throw new Error("session-unavailable");
    const { db } = source;
    try {
      const proof = db
        .prepare(
          `SELECT conversation_id,substr(title,1,512) AS title,substr(workspace_uris,1,${MAX_METADATA + 1}) AS workspace_uris,last_modified_time,substr(raw_summary,1,${MAX_METADATA + 1}) AS raw_summary FROM conversation_summaries WHERE conversation_id=?`,
        )
        .get(id);
      if (
        !proof ||
        !databaseMetadata(proof).workspaces.some(
          (value) => pathIdentity(value) === pathIdentity(workspace),
        )
      )
        throw new Error("session-workspace-mismatch");
      const rows = db
        .prepare(
          `SELECT chunk_index,chunk_first_step,chunk_last_step,substr(user_body,1,${MAX_METADATA + 1}) AS user_body,substr(agent_body,1,${MAX_METADATA + 1}) AS agent_body,substr(user_step_byte_offsets,1,${MAX_METADATA + 1}) AS user_step_byte_offsets,substr(agent_step_byte_offsets,1,${MAX_METADATA + 1}) AS agent_step_byte_offsets FROM conversations_fts WHERE conversation_id=? ORDER BY chunk_index LIMIT ${MAX_RECORDS + 1}`,
        )
        .iterate(id);
      const events: Array<{ step: number; event: ConversationEvent }> = [];
      const seen = new Set<number>(),
        digest = createHash("sha256").update([surface, id, pathIdentity(workspace)].join("\0"));
      let bytes = 0,
        chunks = 0;
      for (const row of rows) {
        if (++chunks > MAX_RECORDS) throw new Error("Antigravity search index exceeds chunk limit");
        digest.update(JSON.stringify(row));
        for (const role of ["user", "agent"] as const) {
          const body = blob(row[`${role}_body`]);
          bytes += body.length;
          if (bytes > MAX_TOTAL) throw new Error("Antigravity search projection exceeds limit");
          if (!body.length) continue;
          const offsets: unknown = JSON.parse(text(row[`${role}_step_byte_offsets`]));
          if (!Array.isArray(offsets) || offsets.length > MAX_RECORDS)
            throw new Error("Invalid Antigravity search offsets");
          let previousStep = -1,
            previousOffset = -1;
          for (let index = 0; index < offsets.length; index++) {
            const pair = offsets[index],
              next = offsets[index + 1];
            if (
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              pair.some((value) => !Number.isSafeInteger(value) || value < 0) ||
              pair[0] <= previousStep ||
              pair[1] <= previousOffset ||
              pair[1] >= body.length ||
              pair[0] < Number(row.chunk_first_step) ||
              pair[0] > Number(row.chunk_last_step)
            )
              throw new Error("Invalid Antigravity search offsets");
            const end =
              next === undefined
                ? body.length
                : Array.isArray(next) && Number.isSafeInteger(next[1])
                  ? next[1]
                  : -1;
            if (end <= pair[1] || end > body.length || seen.has(pair[0]))
              throw new Error("Invalid Antigravity search order");
            const content = decoder.decode(body.subarray(pair[1], end));
            previousStep = pair[0];
            previousOffset = pair[1];
            seen.add(pair[0]);
            if (!content.trim()) continue;
            const truncated = truncateUtf8(content, MAX_MESSAGE_BYTES);
            events.push({
              step: pair[0],
              event: {
                id: `antigravity-local-${surface}-${id}-${pair[0]}`,
                kind: role === "user" ? "user-message" : "agent-message",
                timestamp: null,
                content: truncated.content,
                tool_name: null,
                tool_status: null,
                duration_ms: null,
                attachment_count: 0,
                truncated: truncated.truncated,
              },
            });
            if (events.length > MAX_RECORDS)
              throw new Error("Antigravity search projection exceeds event limit");
          }
        }
      }
      events.sort((a, b) => a.step - b.step);
      const version = digest.digest("hex"),
        prefix = `antigravity-local-v1-${version}-`;
      let end = events.length;
      if (cursor !== null) {
        if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length)))
          throw new Error("Invalid Antigravity local cursor");
        end = Number(cursor.slice(prefix.length));
        if (!Number.isSafeInteger(end) || end < 0 || end > events.length)
          throw new Error("Invalid Antigravity local cursor");
      }
      const selected: ConversationEvent[] = [];
      let start = end,
        size = 0;
      while (start > 0 && selected.length < limit) {
        const event = events[start - 1]!.event,
          cost = Buffer.byteLength(event.content ?? "") + 256;
        if (selected.length && size + cost > MAX_PAGE_BYTES) break;
        selected.unshift(event);
        size += cost;
        start--;
      }
      source.verify();
      return {
        events: selected,
        next_cursor: start ? `${prefix}${start}` : null,
        warnings: ["history.warning.partial"],
      };
    } finally {
      db.close();
    }
  }
}
