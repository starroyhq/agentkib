import {
  lstatSync,
  readdirSync,
  unwatchFile,
  watch,
  watchFile,
  type FSWatcher,
  type WatchEventType,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { claudeConfigFiles, resolveClaudeConfig } from "./agents/claude/claude-config";
import { codexSessionHome } from "./agents/codex/codex-sessions";
import { devinSessionDatabase } from "./agents/devin/devin-sessions";
import { withinLexical } from "./files";
import type { SessionAgent } from "./session-readers";

const TRANSCRIPT_BATCH_MS = 180;
const DATABASE_BATCH_MS = 1000;
const MAX_PATHS_PER_AGENT = 256;
const MAX_WATCH_RETRY_MS = 30_000;
const MAX_METADATA_FILES = 32;
const METADATA_STAT_MS = 1000;
const CLAUDE_PROJECT_DEPTH = 3;

export type CatalogSourceChange = {
  agent: SessionAgent;
  /** Absent when only the provider's shared metadata source changed. */
  paths?: readonly string[];
};

export type CatalogWatchSource = {
  agent: SessionAgent;
  directory: string;
  recursive?: boolean;
  catchUp?: true;
  database?: true;
  databaseFiles?: readonly string[];
  classify(event: WatchEventType, relative: string): "path" | "source" | undefined;
};

/** Paths are hints only. The catalog reader still verifies native identity and workspace. */
export function catalogWatchSources(environment: NodeJS.ProcessEnv): CatalogWatchSource[] {
  const claude = claudeConfigFiles(resolveClaudeConfig(environment, homedir()));
  const codex = codexSessionHome(environment);
  const devin = devinSessionDatabase(environment);
  const devinFiles = new Set(
    ["", "-wal", "-journal"].map((suffix) => path.basename(devin) + suffix),
  );
  const codexDatabase: CatalogWatchSource["classify"] = (_event, relative) => {
    if (/^state_[^/\\]+\.sqlite(?:-wal|-journal)?$/i.test(relative)) return "source";
  };
  const codexRollout: CatalogWatchSource["classify"] = (event, relative) => {
    // Titles, archives, and last activity live in threads; additions/removals of a
    // rollout also affect whether an already indexed thread can be opened.
    if (event === "rename") {
      if (/\.jsonl(?:\.zst)?$/i.test(relative)) return "path";
      if (!path.extname(relative)) return "source";
    }
  };
  return [
    {
      agent: "claude-code",
      directory: claude.projects,
      recursive: true,
      catchUp: true,
      classify: (event, relative) => {
        if (relative.split(path.sep).length > CLAUDE_PROJECT_DEPTH) return;
        if (path.basename(relative) === "sessions-index.json") return "source";
        if (path.extname(relative) === ".jsonl") return "path";
        if (event === "rename" && !path.extname(relative)) return "source";
      },
    },
    { agent: "codex", directory: codex, database: true, classify: codexDatabase },
    {
      agent: "codex",
      directory: path.join(codex, "sqlite"),
      database: true,
      classify: codexDatabase,
    },
    ...["sessions", "archived_sessions"].map((directory): CatalogWatchSource => ({
      agent: "codex",
      directory: path.join(codex, directory),
      recursive: true,
      classify: codexRollout,
    })),
    {
      agent: "devin",
      directory: path.dirname(devin),
      database: true,
      databaseFiles: [...devinFiles],
      classify: (_event, relative) => (devinFiles.has(relative) ? "source" : undefined),
    },
  ];
}

function directoryIdentity(directory: string): string | undefined {
  try {
    const info = lstatSync(directory, { throwIfNoEntry: false, bigint: true });
    if (info?.isDirectory()) return `${info.dev}:${info.ino}`;
  } catch {
    // The source may be disabled, inaccessible or not installed.
  }
}

function metadataIdentity(file: string): string | undefined {
  try {
    const info = lstatSync(file, { throwIfNoEntry: false, bigint: true });
    if (info?.isFile())
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    // The watcher is a hint and cannot turn an unreadable path into a native record.
  }
}

type WatchState = {
  source: CatalogWatchSource;
  identity?: string;
  watcher?: FSWatcher;
  discovery?: ReturnType<typeof setTimeout>;
  metadata?: Map<string, () => void>;
  retry?: ReturnType<typeof setTimeout>;
  delay: number;
};

/** Bound the pending signals to one batch; repeated writes need only one metadata read. */
export class SessionCatalogWatch {
  #watches: WatchState[] = [];
  #databases: Set<SessionAgent>;
  #pending = new Map<
    SessionAgent,
    { paths: Set<string> | null; timer: ReturnType<typeof setTimeout> }
  >();
  #closed = false;

  constructor(
    sources: readonly CatalogWatchSource[],
    private readonly changed: (changes: readonly CatalogSourceChange[]) => void,
  ) {
    this.#watches = sources
      .filter(({ directory }) => path.isAbsolute(directory))
      .map((source) => ({
        source: { ...source, directory: path.resolve(source.directory) },
        delay: 1000,
      }));
    this.#databases = new Set(
      this.#watches.filter(({ source }) => source.database).map(({ source }) => source.agent),
    );
    for (const state of this.#watches) this.#attach(state);
  }

  #attach(state: WatchState): void {
    if (this.#closed) return;
    const { source } = state;
    const identity = directoryIdentity(source.directory);
    if (identity && state.identity === identity && state.watcher) return;
    if (!identity && state.discovery) return;
    this.#detach(state);
    if (!identity) {
      // Recheck only the missing root's stat. Creating it during an asynchronous
      // watch baseline must not leave an installation unobserved until restart.
      state.discovery = setTimeout(() => {
        state.discovery = undefined;
        this.#attach(state);
        if (state.watcher) this.#note(source.agent);
      }, METADATA_STAT_MS);
      state.discovery.unref();
      return;
    }

    try {
      const watcher = watch(
        source.directory,
        { persistent: false, recursive: source.recursive === true },
        (event, filename) => {
          if (this.#closed || state.watcher !== watcher) return;
          // A source directory can be swapped while its old inode is still watched.
          if (event === "rename") {
            this.#attach(state);
            if (state.watcher !== watcher) {
              this.#note(source.agent);
              return;
            }
          }
          if (!filename) {
            this.#note(source.agent);
            return;
          }
          const absolute = path.resolve(source.directory, filename);
          if (!withinLexical(absolute, source.directory)) return;
          const kind = source.classify(event, path.relative(source.directory, absolute));
          if (!kind) return;
          if (source.database && process.platform === "darwin") {
            const known = state.metadata?.get(absolute);
            if (known) {
              known();
              return;
            }
            this.#watchMetadata(state, absolute);
          }
          this.#note(source.agent, kind === "path" ? absolute : undefined);
        },
      );
      state.identity = identity;
      state.watcher = watcher;
      state.delay = 1000;
      if (source.database && process.platform === "darwin")
        this.#watchDatabaseFiles(state, watcher);
      // Native recursive delivery starts asynchronously. Reconcile this source
      // once on attachment so a transcript created during startup cannot be lost.
      if (source.catchUp) this.#note(source.agent);
      watcher.on("error", () => {
        if (this.#closed || state.watcher !== watcher) return;
        this.#detach(state);
        this.#retry(state);
      });
    } catch {
      this.#retry(state);
    }
  }

  #watchDatabaseFiles(state: WatchState, watcher: FSWatcher): void {
    const { directory, databaseFiles } = state.source;
    const collect = () => {
      try {
        const names =
          databaseFiles ??
          readdirSync(directory, { withFileTypes: true })
            .filter(
              (entry) => entry.isFile() && state.source.classify("change", entry.name) === "source",
            )
            .map((entry) => entry.name);
        for (const name of names) this.#watchMetadata(state, path.join(directory, name));
      } catch {
        // A subsequent named filesystem event can report an accessible replacement.
      }
    };
    collect();
    // A native store may be created or committed before FSEvents registers its first callback.
    setImmediate(() => {
      if (state.watcher !== watcher) return;
      const count = state.metadata?.size ?? 0;
      collect();
      if ((state.metadata?.size ?? 0) !== count) this.#note(state.source.agent);
      for (const check of state.metadata?.values() ?? []) check();
    }).unref();
  }

  #watchMetadata(state: WatchState, file: string): void {
    const metadata = (state.metadata ??= new Map());
    if (metadata.has(file) || metadata.size >= MAX_METADATA_FILES) return;
    let identity = metadataIdentity(file);
    const changed = () => {
      if (this.#closed || state.metadata !== metadata) return;
      const next = metadataIdentity(file);
      if (next !== identity) {
        identity = next;
        this.#note(state.source.agent);
      }
    };
    // macOS can omit WAL-only write notifications entirely. Scope the check
    // to the handful of known database files; no unchanged file triggers a read.
    watchFile(file, { persistent: false, interval: METADATA_STAT_MS }, changed);
    metadata.set(file, changed);
  }

  #detach(state: WatchState): void {
    state.watcher?.close();
    state.watcher = undefined;
    state.identity = undefined;
    clearTimeout(state.discovery);
    state.discovery = undefined;
    for (const [file, listener] of state.metadata ?? []) unwatchFile(file, listener);
    state.metadata = undefined;
    clearTimeout(state.retry);
    state.retry = undefined;
  }

  #retry(state: WatchState): void {
    if (state.retry || this.#closed) return;
    state.retry = setTimeout(() => {
      state.retry = undefined;
      this.#attach(state);
      if (state.watcher) this.#note(state.source.agent);
    }, state.delay);
    state.retry.unref();
    state.delay = Math.min(state.delay * 2, MAX_WATCH_RETRY_MS);
  }

  #note(agent: SessionAgent, filename?: string): void {
    const current = this.#pending.get(agent);
    if (current) {
      if (!current.paths) return;
      if (!filename || (current.paths.size >= MAX_PATHS_PER_AGENT && !current.paths.has(filename)))
        current.paths = null;
      else current.paths.add(filename);
      return;
    }

    // SQL notifications omit the session ID, so cap provider-wide reads even when
    // the WAL changes continuously. A fixed window still commits under sustained writes.
    const timer = setTimeout(
      () => {
        const batch = this.#pending.get(agent);
        this.#pending.delete(agent);
        if (!batch) return;
        this.changed([{ agent, ...(batch.paths ? { paths: [...batch.paths] } : {}) }]);
      },
      this.#databases.has(agent) ? DATABASE_BATCH_MS : TRANSCRIPT_BATCH_MS,
    );
    this.#pending.set(agent, { paths: filename ? new Set([filename]) : null, timer });
    timer.unref();
  }

  close(): void {
    this.#closed = true;
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
    for (const state of this.#watches) this.#detach(state);
    this.#watches = [];
  }
}
