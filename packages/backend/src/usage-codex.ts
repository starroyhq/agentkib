import { createHash, createHmac } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize, pathIdentity } from "./paths";
import type { UsageBatch, UsageEvent } from "./usage-providers";

const PARSER_VERSION = 3;
const BOUNDARY_BYTES = 256;
interface Stamp {
  size: number;
  modified_ns: number;
  modified_ns_exact?: string;
  identity: string;
}
type CachedEvent = Omit<UsageEvent, "surface_agent" | "workspace_path"> & {
  source_id: string;
  session_hash: string | null;
  workspace_id: string | null;
};
interface Cached {
  event: CachedEvent;
  workspace_ancestors: string[];
}
interface FileState {
  parser_version: number;
  stamp: Stamp;
  complete_offset: number;
  boundary_fingerprint: string;
  workspace_ancestors: string[];
  session_counted: boolean;
  aggregates: Cached[];
}
interface DatabaseState {
  parser_version: number;
  fingerprint: string;
  models: Record<string, string>;
  fallbacks: Cached[];
}
interface State {
  files: Record<string, FileState>;
  databases: Record<string, DatabaseState>;
}
const emptyState = (): State => ({ files: {}, databases: {} });
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const keyed = (salt: string, value: string) =>
  createHmac("sha256", salt).update(value).digest("hex");
const valueObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const field = (value: unknown, key: string) => valueObject(value)[key];
const string = (value: unknown) => (typeof value === "string" ? value : null);
const tokens = (value: unknown) => {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER)
    : 0;
};
const asDay = (value: Date) =>
  `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
const parseInstant = (value: unknown): Date | null => {
  if (typeof value !== "string") return null;
  const parsed = /^-?\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};
const canonicalIdentity = (value: string) => {
  try {
    return pathIdentity(canonicalize(value));
  } catch {
    return pathIdentity(path.normalize(value));
  }
};
const ancestors = (value: string | null, salt: string) => {
  if (!value || !path.isAbsolute(value)) return [];
  const ids: string[] = [];
  let current = canonicalIdentity(value);
  while (true) {
    ids.push(keyed(salt, current));
    const parent = path.dirname(current);
    if (parent === current) return ids;
    current = parent;
  }
};
const identifyPath = (value: string, salt: string) =>
  keyed(salt, pathIdentity(path.normalize(value)));
const stampFile = async (filename: string): Promise<Stamp> => {
  const info = await stat(filename, { bigint: true });
  if (!info.isFile()) throw new Error("Source is not a regular file");
  return {
    size: Number(info.size),
    modified_ns: Number(info.mtimeNs),
    modified_ns_exact: info.mtimeNs.toString(),
    identity: `${info.dev}:${info.ino}`,
  };
};
const databaseFingerprint = async (filename: string) => {
  const hash = createHash("sha256");
  for (const source of [filename, `${filename}-wal`]) {
    try {
      const stamp = await stampFile(source);
      hash.update(
        `{"size":${stamp.size},"modified_ns":${stamp.modified_ns_exact ?? stamp.modified_ns},"identity":${JSON.stringify(stamp.identity)}}`,
      );
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex");
};
async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return;
      throw new Error("Some Codex session sources could not be enumerated");
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && path.extname(candidate) === ".jsonl") output.push(candidate);
      else if (entry.isDirectory()) await visit(candidate);
    }
  };
  await visit(root);
  return output.sort();
}
const jsonPointer = (value: unknown, pointer: string) =>
  pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (current, key) => field(current, key.replaceAll("~1", "/").replaceAll("~0", "~")),
      value,
    );

function mergeCached(left: Cached, right: Cached, salt: string): Cached {
  const a = left.event,
    b = right.event;
  const event: CachedEvent = {
    ...a,
    source_key: "",
    occurred_at:
      !a.occurred_at || (b.occurred_at && b.occurred_at > a.occurred_at)
        ? b.occurred_at
        : a.occurred_at,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    session_count: a.session_count + b.session_count,
    workspace_id: a.workspace_id ?? b.workspace_id,
  };
  return {
    event: {
      ...event,
      session_hash: event.session_key ? keyed(salt, event.session_key) : null,
    },
    workspace_ancestors: left.workspace_ancestors,
  };
}
function parseCodexLine(
  line: Buffer,
  id: string,
  state: FileState,
  aggregates: Map<string, Cached>,
  salt: string,
) {
  if (!isUtf8(line)) return;
  const text = line.toString("utf8");
  if (!text.includes("token_count") && !text.includes("session_meta")) return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  const payloadType = jsonPointer(value, "/payload/type") ?? field(value, "type");
  if (payloadType === "session_meta") {
    state.workspace_ancestors = ancestors(
      string(jsonPointer(value, "/payload/cwd") ?? field(value, "cwd")),
      salt,
    );
    return;
  }
  if (jsonPointer(value, "/payload/type") !== "token_count") return;
  const usage =
    jsonPointer(value, "/payload/info/last_token_usage") ??
    jsonPointer(value, "/payload/last_token_usage");
  if (!usage) return;
  const total = tokens(field(usage, "total_tokens"));
  if (!total) return;
  const instant = parseInstant(field(value, "timestamp") ?? null);
  const modelValue =
    jsonPointer(value, "/payload/info/model") ?? jsonPointer(value, "/payload/model");
  const model = typeof modelValue === "string" && modelValue.trim() ? modelValue.trim() : null;
  const event: CachedEvent = {
    source_id: id,
    source_key: "",
    session_key: id,
    session_hash: keyed(salt, id),
    workspace_id: null,
    occurred_at: instant?.toISOString() ?? null,
    day: instant ? asDay(instant) : null,
    model,
    input_tokens: tokens(field(usage, "input_tokens")),
    output_tokens: tokens(field(usage, "output_tokens")),
    cache_read_tokens: tokens(field(usage, "cached_input_tokens")),
    cache_write_tokens: 0,
    reasoning_tokens: tokens(field(usage, "reasoning_output_tokens")),
    total_tokens: total,
    session_count: state.session_counted ? 0 : 1,
    date_precision: "exact" as const,
    quality: "exact" as const,
  };
  const key = JSON.stringify([
    event.session_key,
    event.day,
    event.model,
    state.workspace_ancestors[0] ?? null,
  ]);
  const cached = { event, workspace_ancestors: [...state.workspace_ancestors] };
  const previous = aggregates.get(key);
  aggregates.set(key, previous ? mergeCached(previous, cached, salt) : cached);
  state.session_counted = true;
}

async function collectFile(filename: string, id: string, old: FileState | undefined, salt: string) {
  const stamp = await stampFile(filename);
  if (
    old?.parser_version === PARSER_VERSION &&
    old.stamp.identity === stamp.identity &&
    old.stamp.size === stamp.size &&
    old.stamp.modified_ns_exact !== undefined &&
    old.stamp.modified_ns_exact === stamp.modified_ns_exact
  )
    return old;
  let append = Boolean(
    old &&
    old.parser_version === PARSER_VERSION &&
    old.stamp.identity === stamp.identity &&
    stamp.size > old.stamp.size &&
    old.complete_offset <= stamp.size,
  );
  const file = await open(filename, "r");
  try {
    if (append && old) {
      const start = Math.max(0, old.complete_offset - BOUNDARY_BYTES);
      const boundary = Buffer.alloc(old.complete_offset - start);
      await file.read(boundary, 0, boundary.length, start);
      append = sha(boundary) === old.boundary_fingerprint;
    }
    const next: FileState =
      append && old
        ? structuredClone(old)
        : {
            parser_version: PARSER_VERSION,
            stamp,
            complete_offset: 0,
            boundary_fingerprint: "",
            workspace_ancestors: [],
            session_counted: false,
            aggregates: [],
          };
    const aggregates = new Map<string, Cached>();
    for (const event of next.aggregates)
      aggregates.set(
        JSON.stringify([
          event.event.session_key,
          event.event.day,
          event.event.model,
          event.workspace_ancestors[0] ?? null,
        ]),
        event,
      );
    const chunkSize = Math.min(1024 * 1024, Math.max(1, stamp.size - next.complete_offset));
    let offset = next.complete_offset,
      pending = Buffer.alloc(0);
    while (offset < stamp.size) {
      const buffer = Buffer.alloc(Math.min(chunkSize, stamp.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      const data = pending.length
        ? Buffer.concat([pending, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      let from = 0;
      for (let index = 0; index < data.length; index++) {
        if (data[index] === 10) {
          parseCodexLine(data.subarray(from, index + 1), id, next, aggregates, salt);
          next.complete_offset += index + 1 - from;
          from = index + 1;
        }
      }
      pending = data.subarray(from);
    }
    next.aggregates = [...aggregates.values()];
    const start = Math.max(0, next.complete_offset - BOUNDARY_BYTES);
    const boundary = Buffer.alloc(next.complete_offset - start);
    if (boundary.length) await file.read(boundary, 0, boundary.length, start);
    next.boundary_fingerprint = sha(boundary);
    const after = await stampFile(filename);
    if (
      after.identity !== stamp.identity ||
      after.size < stamp.size ||
      (after.size === stamp.size && after.modified_ns !== stamp.modified_ns)
    )
      throw new Error("Codex source changed during parsing");
    next.stamp = stamp;
    return next;
  } finally {
    await file.close();
  }
}

async function readDatabase(
  filename: string,
  id: string,
  home: string,
  salt: string,
): Promise<DatabaseState | null> {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    if (
      !["rollout_path", "cwd", "updated_at", "tokens_used", "model"].every((name) =>
        columns.has(name),
      )
    )
      return null;
    const rows = db
      .prepare("SELECT rollout_path,cwd,updated_at,tokens_used,model FROM threads")
      .all() as Array<Record<string, unknown>>;
    const models: Record<string, string> = {},
      fallbacks: Cached[] = [];
    for (const row of rows) {
      const rollout = string(row.rollout_path),
        sessionPath = rollout
          ? path.resolve(path.isAbsolute(rollout) ? rollout : path.join(home, rollout))
          : null;
      const session = sessionPath ? identifyPath(sessionPath, salt) : null;
      const model = string(row.model)?.trim() || null;
      if (session && model) models[session] = model;
      const total = tokens(row.tokens_used);
      if (!total) continue;
      const updated = Number(row.updated_at),
        instant = Number.isFinite(updated) ? new Date(updated * 1000) : null;
      const cwd = string(row.cwd);
      fallbacks.push({
        event: {
          source_id: id,
          source_key: sha(`codex-fallback:${session ?? id}`),
          session_key: session,
          session_hash: session ? keyed(salt, session) : null,
          workspace_id: null,
          occurred_at: instant && Number.isFinite(instant.getTime()) ? instant.toISOString() : null,
          day: null,
          model,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: total,
          session_count: 1,
          date_precision: "aggregate",
          quality: "incomplete",
        },
        workspace_ancestors: ancestors(cwd, salt),
      });
    }
    return {
      parser_version: PARSER_VERSION,
      fingerprint: await databaseFingerprint(filename),
      models,
      fallbacks,
    };
  } finally {
    db.close();
  }
}

function materialize(
  state: State,
  workspaceFor: (identity: string) => string | null,
  salt: string,
): UsageEvent[] {
  const models = Object.assign({}, ...Object.values(state.databases).map((entry) => entry.models));
  const merged = new Map<string, Cached>(),
    detailed = new Set<string>();
  for (const [id, file] of Object.entries(state.files))
    for (const cached of file.aggregates) {
      const event = {
        ...cached.event,
        model: cached.event.model ?? models[id] ?? null,
        workspace_id: cached.workspace_ancestors.map(workspaceFor).find(Boolean) ?? null,
      };
      const next = { event, workspace_ancestors: cached.workspace_ancestors } as Cached;
      const key = JSON.stringify([
        event.session_key,
        event.day,
        event.model,
        cached.workspace_ancestors[0] ?? null,
      ]);
      merged.set(key, merged.has(key) ? mergeCached(merged.get(key)!, next, salt) : next);
      detailed.add(id);
    }
  const bySource = new Map<string, Cached>();
  for (const database of Object.values(state.databases))
    for (const cached of database.fallbacks) {
      if (cached.event.session_key && detailed.has(cached.event.session_key)) continue;
      const key = cached.event.source_key;
      const prior = bySource.get(key);
      bySource.set(
        key,
        prior
          ? {
              ...cached,
              event: {
                ...cached.event,
                workspace_id: prior.event.workspace_id ?? cached.event.workspace_id,
              },
            }
          : cached,
      );
    }
  const output = [...merged.values(), ...bySource.values()].map(
    ({ event, workspace_ancestors }) => ({
      ...event,
      source_key:
        event.date_precision === "aggregate"
          ? event.source_key
          : sha(
              `codex-session:${event.session_key ?? ""}:${event.day ?? ""}:${event.model ?? ""}:${event.workspace_id ?? ""}`,
            ),
      workspace_path: null,
      session_hash:
        event.session_hash ?? (event.session_key ? keyed(salt, event.session_key) : null),
      surface_agent: "codex",
      workspace_id:
        event.workspace_id ?? workspace_ancestors.map(workspaceFor).find(Boolean) ?? null,
    }),
  ) as UsageEvent[];
  return output;
}

export async function collectCodexUsage(options: {
  home: string;
  state: State;
  salt: string;
  workspaces: Array<{ id: string; canonical_path: string }>;
}): Promise<{ batch: UsageBatch; state: State; initial_complete: boolean }> {
  const { home, salt } = options,
    state = structuredClone(options.state),
    errors: string[] = [];
  try {
    if (!(await stat(home)).isDirectory()) throw new Error("Codex Home is unavailable");
  } catch {
    throw new Error("Codex Home is unavailable");
  }
  const sessionsRoot = path.join(home, "sessions");
  let enumerated = true;
  let files: string[] = [];
  try {
    files = await filesBelow(sessionsRoot);
  } catch {
    enumerated = false;
    errors.push("session-enumeration");
  }
  const seenFiles = new Set<string>();
  for (const filename of files) {
    const id = identifyPath(filename, salt);
    seenFiles.add(id);
    try {
      state.files[id] = await collectFile(filename, id, state.files[id], salt);
    } catch {
      errors.push("session-read");
    }
  }
  if (enumerated)
    for (const id of Object.keys(state.files)) if (!seenFiles.has(id)) delete state.files[id];
  let entries: Dirent[];
  let databaseEnumerationComplete = true;
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    entries = [];
    errors.push("state-enumeration");
    databaseEnumerationComplete = false;
  }
  const seenDatabases = new Set<string>();
  const stateFiles = entries.filter(
    (entry) =>
      entry.isFile() && entry.name.startsWith("state_") && path.extname(entry.name) === ".sqlite",
  );
  for (const entry of stateFiles) {
    const filename = path.join(home, entry.name),
      id = identifyPath(filename, salt);
    seenDatabases.add(id);
    try {
      const fingerprint = await databaseFingerprint(filename);
      if (
        state.databases[id]?.parser_version === PARSER_VERSION &&
        state.databases[id]?.fingerprint === fingerprint
      )
        continue;
      const next = await readDatabase(filename, id, home, salt);
      if (next) state.databases[id] = next;
      else if (state.databases[id]) errors.push("state-schema");
    } catch {
      errors.push("state-read");
    }
  }
  if (databaseEnumerationComplete)
    for (const id of Object.keys(state.databases))
      if (!seenDatabases.has(id)) delete state.databases[id];
  const workspaceFor = (identity: string) => {
    const candidates = options.workspaces.map((workspace) => ({
      workspace,
      identity: keyed(salt, pathIdentity(canonicalIdentity(workspace.canonical_path))),
    }));
    return candidates.find((value) => value.identity === identity)?.workspace.id ?? null;
  };
  for (const file of Object.values(state.files))
    for (const cached of file.aggregates)
      cached.event.workspace_id =
        cached.workspace_ancestors.map(workspaceFor).find(Boolean) ?? null;
  for (const database of Object.values(state.databases))
    for (const cached of database.fallbacks)
      cached.event.workspace_id =
        cached.workspace_ancestors.map(workspaceFor).find(Boolean) ?? null;
  const events = materialize(state, workspaceFor, salt);
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  };
  const unchanged = errors.length === 0 && canonicalJson(state) === canonicalJson(options.state);
  const days = events
    .map((event) => event.day)
    .filter((day): day is string => day !== null)
    .sort();
  const batch: UsageBatch = {
    agent: "codex",
    events,
    cursor: null,
    unchanged,
    status: {
      available: true,
      quality: errors.length
        ? "incomplete"
        : events.some((event) => event.quality === "incomplete")
          ? "incomplete"
          : "exact",
      coverage_from: days[0] ?? null,
      coverage_to: days.at(-1) ?? null,
      imported_events: events.length,
      ...(errors.length
        ? {
            error_key: "errors.providerUnavailable",
            error: "Some Codex sources could not be read; prior data retained",
          }
        : {}),
    },
  };
  return { batch, state, initial_complete: errors.length === 0 };
}

export function parseCodexState(
  value: string | null,
  sqlRows: Array<{ source_kind: string; source_id: string; state_json: string }>,
): State {
  if (value) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      if (!field(parsed, "storage_version"))
        return {
          files: valueObject(parsed.files) as unknown as State["files"],
          databases: valueObject(parsed.databases) as unknown as State["databases"],
        };
      const manifest = field(parsed, "sources");
      if (tokens(manifest) === sqlRows.length) {
        const state = emptyState();
        for (const row of sqlRows) {
          const parsedRow = JSON.parse(row.state_json);
          if (row.source_kind === "files") state.files[row.source_id] = parsedRow as FileState;
          if (row.source_kind === "databases")
            state.databases[row.source_id] = parsedRow as DatabaseState;
        }
        return state;
      }
    } catch {
      /* damaged checkpoint is rebuilt from sources */
    }
  }
  return emptyState();
}
export function checkpointRows(state: State) {
  return [
    ...Object.entries(state.files).map(([source_id, value]) => ({
      source_kind: "files",
      source_id,
      state_json: JSON.stringify(value),
    })),
    ...Object.entries(state.databases).map(([source_id, value]) => ({
      source_kind: "databases",
      source_id,
      state_json: JSON.stringify(value),
    })),
  ];
}
