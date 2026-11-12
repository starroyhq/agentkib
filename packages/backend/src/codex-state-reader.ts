import { accessSync, constants, statSync, type BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Sql, type Row } from "./sql";

const QUERY_BATCH_SIZE = 500;
const MAX_CACHED_IDS = 20_000;
const MAX_CONNECTIONS = 4;

function fileIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid].join(":");
}

function stateIdentity(file: string): string {
  const main = statSync(file, { bigint: true });
  const wal = statSync(`${file}-wal`, { bigint: true, throwIfNoEntry: false });
  const shared = statSync(`${file}-shm`, { bigint: true, throwIfNoEntry: false });
  // WAL appends and checkpoints keep the same connection. Replaced sidecars
  // can leave a retained reader on old file descriptors.
  return [main, wal, shared].map((stat) => (stat ? fileIdentity(stat) : "")).join("/");
}

class StateDatabase {
  readonly sql: Sql;
  #busyTimeoutMs: number | undefined;
  #ids: { version: bigint; byLowercase: Map<string, string[]> | null } | undefined;

  constructor(
    file: string,
    readonly identity?: string,
  ) {
    this.sql = new Sql(new DatabaseSync(file, { readOnly: true }));
  }

  close(): void {
    this.sql.database.close();
  }

  read<T>(busyTimeoutMs: number, read: (database: StateDatabase) => T): T {
    const { database } = this.sql;
    if (this.#busyTimeoutMs !== busyTimeoutMs) {
      database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      if (this.#busyTimeoutMs === undefined && this.identity !== undefined)
        database.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
      this.#busyTimeoutMs = busyTimeoutMs;
    }
    database.exec("BEGIN");
    try {
      return read(this);
    } finally {
      if (database.isTransaction) database.exec("ROLLBACK");
    }
  }

  rows(query: string, ids?: readonly string[], caseInsensitive = false): Row[] {
    if (!ids) return this.sql.rows(query);
    const rawIds = caseInsensitive ? this.#matchingIds(ids) : ids;
    return this.#selectIds(query, rawIds, caseInsensitive ? " COLLATE BINARY" : "");
  }

  #selectIds(query: string, ids: readonly string[], collation: string): Row[] {
    const rows: Row[] = [];
    for (let start = 0; start < ids.length; start += QUERY_BATCH_SIZE) {
      const batch = ids.slice(start, start + QUERY_BATCH_SIZE);
      rows.push(
        ...this.sql.rows(
          `${query} WHERE id${collation} IN (${batch.map(() => "?").join(",")})`,
          ...batch,
        ),
      );
    }
    return rows;
  }

  #matchingIds(ids: readonly string[]): string[] {
    if (!ids.length) return [];
    // data_version is connection-local. The read transaction keeps the version, ID
    // spellings and primary-key lookups on one SQLite snapshot even while Codex writes.
    const version =
      this.identity === undefined ? undefined : this.sql.one("PRAGMA data_version")?.data_version;
    if (typeof version === "bigint") {
      if (!this.#ids || this.#ids.version !== version) {
        const rows = this.sql.rows(
          `SELECT id FROM threads WHERE length(id)=36 LIMIT ${MAX_CACHED_IDS + 1}`,
        );
        const byLowercase = rows.length > MAX_CACHED_IDS ? null : new Map<string, string[]>();
        if (byLowercase) {
          for (const { id } of rows) {
            if (typeof id !== "string") continue;
            const key = id.toLowerCase();
            const matches = byLowercase.get(key);
            if (matches) matches.push(id);
            else byLowercase.set(key, [id]);
          }
        }
        this.#ids = { version, byLowercase };
      }
      const { byLowercase } = this.#ids;
      if (byLowercase) return ids.flatMap((id) => byLowercase.get(id) ?? []);
    }
    // Even without a reusable ID map SQLite can scan the narrow covering index.
    // Keep the potentially wide metadata reads on exact primary-key lookups.
    return this.#selectIds("SELECT id FROM threads", ids, " COLLATE NOCASE").flatMap(({ id }) =>
      typeof id === "string" ? [id] : [],
    );
  }
}

export class CodexStateReader {
  #connections = new Map<string, StateDatabase>();

  constructor(readonly retainDatabase: boolean) {}

  keep(files: readonly string[]): void {
    const current = new Set(files);
    for (const file of this.#connections.keys()) {
      if (!current.has(file)) this.#close(file);
    }
  }

  close(): void {
    for (const file of this.#connections.keys()) this.#close(file);
  }

  read<T>(file: string, busyTimeoutMs: number, read: (database: StateDatabase) => T): T {
    // SQLite's Windows file handles can prevent the native app replacing its own database.
    if (!this.retainDatabase || process.platform === "win32") {
      const database = new StateDatabase(file);
      try {
        return database.read(busyTimeoutMs, read);
      } finally {
        database.close();
      }
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Recheck current access rather than treating an existing descriptor as permission.
        accessSync(file, constants.R_OK);
        const identity = stateIdentity(file);
        let database = this.#connections.get(file);
        if (database?.identity !== identity) {
          this.#close(file);
          database = new StateDatabase(file, identity);
          if (this.#connections.size >= MAX_CONNECTIONS)
            this.#close(this.#connections.keys().next().value!);
        }
        this.#connections.delete(file);
        this.#connections.set(file, database);
        const result = database.read(busyTimeoutMs, read);
        if (stateIdentity(file) === identity) return result;
        this.#close(file);
      }
      throw new Error("codex-state-database-changed");
    } catch (error) {
      this.#close(file);
      throw error;
    }
  }

  #close(file: string): void {
    const database = this.#connections.get(file);
    this.#connections.delete(file);
    database?.close();
  }
}
