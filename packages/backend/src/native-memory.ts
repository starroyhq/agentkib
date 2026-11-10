import { createHash, randomUUID } from "node:crypto";
import { constants, watch, watchFile, unwatchFile } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  NativeMemoryDetail,
  NativeMemoryFile,
  NativeMemoryQuery,
  NativeMemorySnapshot,
  NativeMemorySource,
} from "@agentkib/runtime-protocol";
import { resolveClaudeConfig } from "./claude-config";
import { autoMemoryLocation } from "./claude-memory";
import { parseFrontMatter } from "./claude-assets";
import { readClaudeSettings, redactText } from "./claude-settings";
import { isSensitiveExternalPath } from "./context-claude";
import {
  defaultIo,
  isInside,
  isNetworkOrDevicePath,
  pathKey,
  probe,
} from "./context-claude-sources";
import { FILE_CHARS } from "./context-files";
import { safeAncestors } from "./files";
import { userHome } from "./mcp-config-read";
import type { BackendStore } from "./store";
import { sanitizeSessionText } from "./session-handoff";

interface Limits {
  depth: number;
  files: number;
  fileBytes: number;
  characters: number;
  directoryBytes: number;
  pollMs: number;
}
interface CachedFile {
  file: NativeMemoryFile;
  content: string;
  fingerprint: string;
  observed: number;
}
interface SourceState {
  source: NativeMemorySource;
  files: Map<string, CachedFile>;
  // Paths are private and are always revalidated before reading; IPC accepts IDs only.
  directory: string | null;
}
interface Workspace {
  id: string;
  name: string;
  path: string;
}
const DEFAULT_LIMITS: Limits = {
  depth: 4,
  files: 512,
  fileBytes: 512 * 1024,
  characters: FILE_CHARS,
  directoryBytes: 8 * 1024 * 1024,
  pollMs: 5000,
};
const context = { io: defaultIo, platform: process.platform };
const digest = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const now = () => new Date().toISOString();
const fingerprint = (stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}) =>
  digest(
    String(stat.dev),
    String(stat.ino),
    String(stat.size),
    String(stat.mtimeMs),
    String(stat.ctimeMs),
  );
const missing = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const unavailable = () =>
  Object.assign(new Error("native-memory-file-unavailable"), {
    code: "NATIVE_MEMORY_UNAVAILABLE",
  });
const unsafe = (error: unknown) =>
  ["NATIVE_MEMORY_UNAVAILABLE", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
const safePath = (value: string) =>
  !isNetworkOrDevicePath(value, process.platform) &&
  !(process.platform !== "win32" && /^\/(dev|proc|sys)(\/|$)/.test(path.normalize(value))) &&
  !isSensitiveExternalPath(value, value);

// Preserve the complete bounded document through credential redaction before applying
// its code-point preview budget. The default settings preview still uses 200 characters.
const safeText = (text: string) =>
  redactText(
    // Strip complete private-key blocks before the shell parser can interpret PEM
    // markers as command-line flags. Other text keeps its original continuations
    // until the complete shell-argument redaction has run.
    text.replace(
      /-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/gi,
      (block) => sanitizeSessionText(block, { value: 0 }),
    ),
    DEFAULT_LIMITS.fileBytes * 8,
  );

/** List labels are derived from the same sanitized, bounded text as the detail pane. */
function metadata(content: string): Pick<NativeMemoryFile, "title" | "excerpt"> {
  const fields = parseFrontMatter(content);
  let body = content.replace(/^\uFEFF/, "");
  const opening = /^---[ \t]*\r?\n/.exec(body);
  if (opening) {
    const rest = body.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(rest);
    // An unfinished frontmatter block is metadata, not a prose preview.
    body = closing ? rest.slice(closing.index + closing[0].length) : "";
  }
  const flatten = (value: string, limit: number): string | undefined => {
    const plain = safeText(value)
      .replace(/!?\[([^\]\n]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]*>/g, "")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!plain) return;
    const points = Array.from(plain);
    return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : plain;
  };
  const scalar = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string) : "");
  let heading: string | undefined;
  let fence: { char: string; length: number } | undefined;
  const prose: string[] = [];
  let paragraphFinished = false;
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const value = marker[1]!;
      if (!fence) fence = { char: value[0]!, length: value.length };
      else if (value[0] === fence.char && value.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;
    const title = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    const setext = line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1] ?? "");
    if (title || setext) {
      heading ??= flatten(title ? title[1]! : line, 120);
      if (setext) index++;
      continue;
    }
    if (!line.trim()) {
      if (prose.length) paragraphFinished = true;
      continue;
    }
    if (paragraphFinished || /^\s*(?:[-_*]{3,}|\|.*)\s*$/.test(line)) continue;
    prose.push(line.replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/, ""));
  }
  const excerpt = flatten(scalar("description"), 180) ?? flatten(prose.join(" "), 180);
  const title =
    flatten(scalar("name"), 120) ??
    flatten(scalar("title"), 120) ??
    heading ??
    flatten(prose.join(" "), 120);
  return { ...(title ? { title } : {}), ...(excerpt ? { excerpt } : {}) };
}

/** Owns read-only native memory discovery and its separate, disposable SQLite cache. */
export class NativeMemoryOwner {
  readonly #store: BackendStore;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #home?: string;
  readonly #notify: () => void;
  readonly #limits: Limits;
  #sources = new Map<string, SourceState>();
  #blocked = new Set<string>();
  #signature = "";
  #revision = randomUUID();
  #generation = 0;
  #observation = 0;
  #closed = false;
  #running: Promise<NativeMemorySnapshot> | null = null;
  #observers = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #watchers = new Map<string, { close(): void }>();
  #savedFiles = new Map<string, string>();
  #notification: ReturnType<typeof setTimeout> | null = null;
  constructor(options: {
    store: BackendStore;
    environment: NodeJS.ProcessEnv;
    notify: () => void;
    home?: string;
    limits?: Partial<Limits>;
  }) {
    this.#store = options.store;
    this.#environment = options.environment;
    this.#home = options.home;
    this.#notify = options.notify;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#reconcile();
  }

  snapshot(query: NativeMemoryQuery = {}): NativeMemorySnapshot {
    if (this.#closed)
      return {
        sources: [],
        files: [],
        total: 0,
        nextOffset: null,
        revision: this.#revision,
        refreshing: false,
      };
    this.#reconcile();
    const sources = [...this.#sources.values()].filter(
      ({ source }) =>
        (!query.workspaceId ||
          source.workspaces.some((workspace) => workspace.id === query.workspaceId)) &&
        (!query.sourceId || source.id === query.sourceId),
    );
    const terms = (query.query ?? "")
      .trim()
      .toLocaleLowerCase()
      .slice(0, 512)
      .split(/\s+/)
      .filter(Boolean);
    const files = sources
      .flatMap((source) => [...source.files.values()])
      .filter(({ file, content }) =>
        terms.every(
          (term) =>
            file.relativePath.toLocaleLowerCase().includes(term) ||
            content.toLocaleLowerCase().includes(term),
        ),
      );
    files.sort(
      (a, b) =>
        a.file.kind.localeCompare(b.file.kind) ||
        a.file.relativePath.localeCompare(b.file.relativePath) ||
        a.file.id.localeCompare(b.file.id),
    );
    const offset = Math.max(0, Number.isSafeInteger(query.offset) ? query.offset! : 0);
    const pageSize = query.query === undefined ? 100 : 50;
    return structuredClone({
      sources: sources.map(({ source }) => source),
      files: files.slice(offset, offset + pageSize).map(({ file }) => file),
      total: files.length,
      nextOffset: offset + pageSize < files.length ? offset + pageSize : null,
      revision: this.#revision,
      refreshing: this.#running !== null,
    });
  }
  search(query: NativeMemoryQuery): NativeMemorySnapshot {
    return this.snapshot({ ...query, query: query.query ?? "" });
  }

  async read(fileId: string): Promise<NativeMemoryDetail> {
    this.#reconcile();
    const state = [...this.#sources.values()].find((value) => value.files.has(fileId));
    if (this.#closed || !state?.directory) throw new Error("native-memory-file-unavailable");
    const captured = state.files.get(fileId)!;
    if (this.#blocked.has(state.source.id)) return this.#detail(state, captured);
    const generation = this.#generation;
    try {
      const current = await this.#readFile(state, captured.file.relativePath);
      this.#reconcile();
      if (
        this.#closed ||
        generation !== this.#generation ||
        this.#sources.get(state.source.id) !== state
      )
        throw new Error("Native memory source changed");
      // Compare successful file observations, not when their asynchronous requests began.
      const latest = state.files.get(fileId);
      if (latest && latest.observed > current.observed) return this.#detail(state, latest);
      state.files.set(fileId, current);
      this.#boundCache(state, fileId);
      this.#save(state);
      if (current.file.version !== captured.file.version) this.#changed();
      return this.#detail(state, current);
    } catch (error) {
      this.#reconcile();
      if (
        this.#closed ||
        generation !== this.#generation ||
        this.#sources.get(state.source.id) !== state
      )
        throw new Error("Native memory source changed");
      if (missing(error) || unsafe(error)) {
        state.files.delete(fileId);
        // Confirmed deletion or loss of authorization invalidates scans holding this file in a
        // private result map; they must not resurrect it after this detail request.
        this.#generation++;
        this.#save(state);
        this.#changed();
        throw new Error("native-memory-file-unavailable");
      }
      this.#stale(state, "read-failed");
      this.#save(state);
      this.#changed();
      return this.#detail(state, state.files.get(fileId) ?? captured);
    }
  }

  refresh(): Promise<NativeMemorySnapshot> {
    if (this.#closed) return Promise.resolve(this.snapshot());
    this.#reconcile();
    if (this.#running) return this.#running;
    const generation = this.#generation;
    this.#running = this.#scan(generation)
      .finally(() => {
        this.#running = null;
        if (!this.#closed) this.#changed();
      })
      .then(() => this.snapshot());
    this.#changed();
    return this.#running;
  }
  observe(observerId: string, active: boolean): void {
    if (this.#closed) return;
    if (active) this.#observers.add(observerId);
    else this.#observers.delete(observerId);
    if (this.#observers.size && !this.#timer) {
      this.#timer = setInterval(() => {
        void this.refresh();
      }, this.#limits.pollMs);
      this.#timer.unref();
      this.#syncWatchers();
      void this.refresh();
    } else if (!this.#observers.size) this.#stopWatching();
  }
  close(): void {
    this.#closed = true;
    this.#generation++;
    this.#stopWatching();
    if (this.#notification) clearTimeout(this.#notification);
    this.#notification = null;
    this.#observers.clear();
  }

  #reconcile(): void {
    if (this.#closed) return;
    const env = this.#home ? { ...this.#environment, HOME: this.#home } : this.#environment;
    const home = this.#home ?? userHome(env);
    const config = resolveClaudeConfig(env, home);
    const scope = digest("native-memory-v1", config.dir);
    const blockedDirectories = new Set<string>();
    const candidates = new Map<string, { source: NativeMemorySource; directory: string | null }>();
    const workspaces = this.#store.listWorkspaces() as Workspace[];
    for (const workspace of workspaces) {
      let directory: string | null = null;
      let status: NativeMemorySource["status"] = "empty";
      let reason: string | undefined;
      if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") {
        status = "disabled";
        reason = "disabled";
      } else if (config.invalid || !safePath(workspace.path) || !safePath(config.dir)) {
        status = "unavailable";
        reason = "path-unresolved";
      } else {
        const cwd = probe(workspace.path, null, context);
        if (cwd.kind !== "dir") {
          status = "unavailable";
          reason = "path-unresolved";
        } else {
          const settings = readClaudeSettings({
            root: cwd.real,
            cwd: cwd.real,
            environment: env,
            config,
            mode: "full",
            sensitive: isSensitiveExternalPath,
          });
          const memory = settings.autoMemory();
          if (!settings.complete) {
            // An unreadable settings file is not evidence that an old source was disabled or moved.
            const previous = [...this.#sources.values()].find(
              (state) =>
                state.source.workspaces.some((value) => value.id === workspace.id) &&
                state.directory !== null &&
                state.source.id === digest(scope, pathKey(state.directory, process.platform)),
            );
            directory = previous?.directory ?? null;
            if (directory) blockedDirectories.add(directory);
            status = "error";
            reason = "read-failed";
          } else if (!memory.enabled) {
            status = "disabled";
            reason = "disabled";
          } else if (
            memory.directoryInvalid ||
            (memory.directoryIgnoredIn.length > 0 && memory.directory?.layer !== "managed")
          ) {
            // Project/local overrides depend on Claude's private trust decision. Unless
            // managed policy takes precedence, neither their target nor the fallback is
            // a verified native source for this workspace.
            status = "unavailable";
            reason = "path-unresolved";
          } else {
            const override = memory.directory?.value;
            const location = autoMemoryLocation(
              cwd.real,
              config,
              env,
              context,
              override?.startsWith("~/") ? path.join(home, override.slice(2)) : override,
            );
            if (!location.ok) {
              status = location.reason === "disabled" ? "disabled" : "unavailable";
              reason = status === "disabled" ? "disabled" : "path-unresolved";
            } else {
              directory = path.dirname(location.file);
              if (!safePath(directory)) {
                directory = null;
                status = "unavailable";
                reason = "path-unresolved";
              } else {
                const root = probe(directory, null, context);
                if (root.kind === "dir" && safePath(root.real)) directory = root.real;
                else if (
                  root.kind === "network" ||
                  root.kind === "outside" ||
                  (root.kind === "dir" && !safePath(root.real))
                ) {
                  directory = null;
                  status = "unavailable";
                  reason = "path-unresolved";
                } else if (root.kind !== "missing") {
                  status = "error";
                  reason = "read-failed";
                }
              }
            }
          }
        }
      }
      const id = digest(
        scope,
        directory ? pathKey(directory, process.platform) : `${workspace.id}:${status}`,
      );
      const existing = candidates.get(id);
      const association = { id: workspace.id, name: workspace.name };
      if (existing) {
        existing.source.workspaces.push(association);
        if (status === "error") {
          existing.source.status = "error";
          existing.source.stale = true;
          existing.source.reason = reason;
        }
        continue;
      }
      candidates.set(id, {
        directory,
        source: {
          id,
          agent: "claude-code",
          directory,
          workspaces: [association],
          status,
          stale: status === "error",
          incomplete: false,
          ...(reason ? { reason } : {}),
          lastAttemptAt: null,
          lastSuccessAt: null,
        },
      });
    }
    const signature = digest(
      scope,
      JSON.stringify(
        [...candidates.values()].map(({ source }) => [
          source.id,
          source.workspaces,
          source.status === "disabled",
          source.reason,
        ]),
      ),
    );
    this.#blocked = new Set(
      [...candidates]
        .filter(([, value]) => value.directory && blockedDirectories.has(value.directory))
        .map(([id]) => id),
    );
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#generation++;
    const next = new Map<string, SourceState>();
    for (const [id, candidate] of candidates) {
      let state = this.#sources.get(id);
      if (!state && candidate.directory) state = this.#load(id, candidate.directory);
      if (!state) state = { ...candidate, files: new Map() };
      state.source.workspaces = candidate.source.workspaces;
      if (candidate.source.status === "disabled" || candidate.source.status === "unavailable")
        state = { ...candidate, files: new Map() };
      else if (candidate.source.status === "error") this.#stale(state, "read-failed");
      next.set(id, state);
    }
    this.#sources = next;
    // Removed/disabled sources cannot reappear from disk or an in-flight old scan.
    for (const row of this.#store.sql.rows("SELECT source_id FROM native_memory_cache"))
      if (!next.get(String(row.source_id))?.directory) {
        this.#store.sql.run(
          "DELETE FROM native_memory_cache WHERE source_id=?",
          String(row.source_id),
        );
        this.#savedFiles.delete(String(row.source_id));
      }
    this.#revision = randomUUID();
    this.#syncWatchers();
  }

  async #scan(generation: number): Promise<NativeMemorySnapshot> {
    const allVisited = new Set<string>();
    for (const state of this.#sources.values()) {
      if (
        !state.directory ||
        state.source.status === "disabled" ||
        state.source.status === "unavailable" ||
        this.#blocked.has(state.source.id)
      )
        continue;
      const attempted = now();
      const result = new Map<string, CachedFile>();
      const scanStarted = this.#observation;
      const visited = new Set<string>();
      let bytes = 0,
        count = 0,
        entries = 0,
        incomplete = false,
        failed = false;
      try {
        const root = probe(state.directory, null, context);
        if (root.kind === "missing") {
          /* Confirmed missing source: publish an empty result. */
        } else if (root.kind !== "dir" || root.real !== state.directory)
          throw new Error("Source changed");
        else {
          const rootDevice = (await lstat(state.directory)).dev;
          const visit = async (directory: string, depth: number): Promise<void> => {
            if (this.#closed || generation !== this.#generation) return;
            const found = probe(directory, state.directory, context, state.directory!);
            if (found.kind !== "dir" || !safePath(found.real) || visited.has(found.real)) return;
            if ((await lstat(found.real)).dev !== rootDevice) {
              incomplete = true;
              return;
            }
            visited.add(found.real);
            allVisited.add(found.real);
            let reader: Awaited<ReturnType<typeof opendir>>;
            try {
              reader = await opendir(found.real);
            } catch {
              failed = true;
              return;
            }
            try {
              for await (const entry of reader) {
                if (this.#closed || generation !== this.#generation) return;
                if (++entries > this.#limits.files * 8) {
                  incomplete = true;
                  return;
                }
                const written = path.join(directory, entry.name);
                if (!safePath(written)) continue;
                const item = probe(written, state.directory, context, state.directory!);
                if (item.kind === "dir") {
                  if (depth < this.#limits.depth) await visit(written, depth + 1);
                  else incomplete = true;
                } else if (item.kind === "file") {
                  if (++count > this.#limits.files) {
                    incomplete = true;
                    return;
                  }
                  if (!/\.md$/i.test(entry.name)) continue;
                  if (
                    bytes + Math.min(item.size, this.#limits.fileBytes) >
                    this.#limits.directoryBytes
                  ) {
                    incomplete = true;
                    continue;
                  }
                  bytes += Math.min(item.size, this.#limits.fileBytes);
                  try {
                    const relative = path.relative(state.directory!, written);
                    const cached = state.files.get(digest(state.source.id, relative));
                    const stat = await lstat(item.real);
                    const unchanged =
                      cached && !cached.file.stale && cached.fingerprint === fingerprint(stat);
                    const file = unchanged ? cached : await this.#readFile(state, relative);
                    result.set(file.file.id, file);
                    incomplete ||= file.file.truncated;
                  } catch (error) {
                    if (!missing(error) && !unsafe(error)) failed = true;
                  }
                } else if (item.kind === "unreadable") failed = true;
              }
            } catch {
              failed = true;
            }
          };
          await visit(state.directory, 0);
        }
        this.#reconcile();
        if (this.#closed || generation !== this.#generation) return this.snapshot();
        // A bounded/incomplete scan cannot confirm that an old file was deleted.
        if (failed || incomplete)
          for (const [id, file] of state.files)
            if (!result.has(id)) {
              const found = probe(
                path.join(state.directory, file.file.relativePath),
                state.directory,
                context,
                state.directory,
              );
              if (
                found.kind !== "missing" &&
                found.kind !== "outside" &&
                found.kind !== "network" &&
                found.kind !== "dir" &&
                !(found.kind === "file" && !safePath(found.real))
              )
                result.set(id, { ...file, file: { ...file.file, stale: true } });
            }
        // An earlier file observation cannot overwrite a newer detail read.
        for (const [id, file] of state.files)
          if (file.observed > (result.get(id)?.observed ?? scanStarted)) result.set(id, file);
        state.files = result;
        state.source = {
          ...state.source,
          status: failed ? "error" : result.size ? "ready" : "empty",
          stale: failed,
          incomplete,
          ...(failed
            ? { reason: "read-failed" }
            : incomplete
              ? { reason: "limited" }
              : { reason: undefined }),
          lastAttemptAt: attempted,
          lastSuccessAt: failed ? state.source.lastSuccessAt : now(),
        };
        this.#boundCache(state);
        this.#save(state);
        this.#changed();
      } catch {
        this.#reconcile();
        if (this.#closed || generation !== this.#generation) return this.snapshot();
        this.#stale(state, "read-failed");
        state.source.lastAttemptAt = attempted;
        this.#save(state);
        this.#changed();
      }
    }
    this.#syncWatchers(allVisited);
    return this.snapshot();
  }

  async #readFile(state: SourceState, relativePath: string): Promise<CachedFile> {
    const root = state.directory!;
    const written = path.join(root, relativePath);
    if (!safePath(written) || !/\.md$/i.test(written) || !isInside(written, root, process.platform))
      throw unavailable();
    const found = probe(written, root, context, root);
    if (found.kind === "missing")
      throw Object.assign(new Error("Missing memory file"), { code: "ENOENT" });
    if (
      found.kind === "outside" ||
      found.kind === "network" ||
      found.kind === "dir" ||
      (found.kind === "file" && !safePath(found.real))
    )
      throw unavailable();
    // An unreadable probe or failed ancestor check alone does not establish unsafe
    // authorization: permissions and transient IO errors retain the last good preview.
    if (found.kind !== "file" || !safeAncestors(found.real, root))
      throw new Error("Memory file could not be read");
    let handle: FileHandle | undefined;
    try {
      const before = await lstat(found.real);
      const rootBefore = await lstat(root);
      if (!before.isFile() || before.dev !== rootBefore.dev) throw unavailable();
      handle = await open(found.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== rootBefore.dev) throw unavailable();
      if (stat.dev !== before.dev || stat.ino !== before.ino)
        throw new Error("Memory file changed");
      const chunks: Buffer[] = [];
      let size = 0;
      while (size < this.#limits.fileBytes + 1) {
        const buffer = Buffer.alloc(Math.min(65536, this.#limits.fileBytes + 1 - size));
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (!read.bytesRead) break;
        chunks.push(buffer.subarray(0, read.bytesRead));
        size += read.bytesRead;
      }
      const after = await handle.stat();
      const rootAfter = await lstat(root);
      const current = probe(written, root, context, root);
      if (
        current.kind === "outside" ||
        current.kind === "network" ||
        current.kind === "dir" ||
        (current.kind === "file" && !safePath(current.real))
      )
        throw unavailable();
      if (current.kind === "missing")
        throw Object.assign(new Error("Missing memory file"), { code: "ENOENT" });
      const disk = current.kind === "file" ? await lstat(current.real) : null;
      if (
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.mtimeMs !== after.mtimeMs ||
        stat.ctimeMs !== after.ctimeMs ||
        stat.size !== after.size ||
        rootBefore.ino !== rootAfter.ino ||
        rootBefore.dev !== rootAfter.dev ||
        !safeAncestors(found.real, root) ||
        !disk ||
        disk.ino !== stat.ino ||
        disk.dev !== stat.dev ||
        disk.mtimeMs !== after.mtimeMs ||
        disk.ctimeMs !== after.ctimeMs ||
        disk.size !== after.size
      )
        throw new Error("Memory file changed");
      const raw = Buffer.concat(chunks);
      if (raw.includes(0)) throw new Error("Invalid memory text");
      const truncated = raw.length > this.#limits.fileBytes || stat.size > this.#limits.fileBytes;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const text = decoder.decode(raw.subarray(0, this.#limits.fileBytes), { stream: truncated });
      const safe = safeText(text);
      const chars = Array.from(safe);
      const content = chars.slice(0, this.#limits.characters).join("");
      return {
        fingerprint: fingerprint(stat),
        observed: ++this.#observation,
        file: {
          id: digest(state.source.id, relativePath),
          sourceId: state.source.id,
          relativePath: relativePath.split(path.sep).join("/"),
          kind: relativePath === "MEMORY.md" ? "index" : "topic",
          ...metadata(content),
          modifiedAt: stat.mtime.toISOString(),
          version: digest(raw.toString("base64"), String(stat.mtimeMs), String(stat.size)),
          size: stat.size,
          truncated: truncated || chars.length > this.#limits.characters,
          stale: false,
        },
        content,
      };
    } finally {
      await handle?.close();
    }
  }

  #detail(state: SourceState, cached: CachedFile): NativeMemoryDetail {
    const links: NativeMemoryDetail["links"] = [];
    for (const match of cached.content.matchAll(/\[([^\]\n]*)\]\(([^\s)]+)\)/g)) {
      const target = match[2]!;
      if (/^[a-z][a-z\d+.-]*:|^[\\/]/i.test(target)) continue;
      let decoded: string;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        continue;
      }
      const [name, fragment] = decoded.split("#", 2);
      const resolved = path.resolve(
        state.directory!,
        path.dirname(cached.file.relativePath),
        name || path.basename(cached.file.relativePath),
      );
      if (!isInside(resolved, state.directory!, process.platform)) continue;
      const relative = path.relative(state.directory!, resolved).split(path.sep).join("/");
      const file = [...state.files.values()].find((value) => value.file.relativePath === relative);
      const found = file ? probe(resolved, state.directory, context, state.directory!) : null;
      if (file && found?.kind === "file" && safePath(found.real))
        links.push({ label: match[1]!, targetId: file.file.id, ...(fragment ? { fragment } : {}) });
    }
    return structuredClone({
      file: cached.file,
      source: state.source,
      content: cached.content,
      links,
    });
  }
  #stale(state: SourceState, reason: string): void {
    state.source = { ...state.source, status: "error", stale: true, reason };
    for (const cached of state.files.values()) cached.file = { ...cached.file, stale: true };
  }
  #boundCache(state: SourceState, keepId?: string): void {
    let bytes = 0;
    const files = [...state.files].sort(([left], [right]) =>
      left === keepId ? -1 : right === keepId ? 1 : 0,
    );
    for (const [id, cached] of files) {
      const size = Buffer.byteLength(cached.content, "utf8");
      if (bytes + size <= this.#limits.directoryBytes) {
        bytes += size;
        continue;
      }
      state.files.delete(id);
      state.source = { ...state.source, incomplete: true, reason: "limited" };
    }
  }
  #load(id: string, directory: string): SourceState | undefined {
    const row = this.#store.sql.one(
      "SELECT * FROM native_memory_cache WHERE source_id=? AND directory=?",
      id,
      directory,
    );
    if (!row) return;
    try {
      const source = JSON.parse(String(row.source_json)) as NativeMemorySource;
      const files = JSON.parse(String(row.files_json)) as CachedFile[];
      if (source.id !== id || source.directory !== directory || !Array.isArray(files)) return;
      const valid = files.filter(
        ({ file, content }) =>
          file.sourceId === id &&
          file.id === digest(id, file.relativePath.split("/").join(path.sep)) &&
          isInside(path.resolve(directory, file.relativePath), directory, process.platform) &&
          safePath(path.resolve(directory, file.relativePath)) &&
          typeof content === "string",
      );
      return {
        directory,
        source: { ...source, stale: true },
        files: new Map(
          valid.map((value) => {
            const content = safeText(value.content);
            return [
              value.file.id,
              {
                file: {
                  ...value.file,
                  stale: true,
                  title: undefined,
                  excerpt: undefined,
                  ...metadata(content),
                },
                fingerprint: value.fingerprint,
                observed: 0,
                content,
              },
            ];
          }),
        ),
      };
    } catch {
      return;
    }
  }
  #save(state: SourceState): void {
    if (!state.directory || this.#closed) return;
    const signature = digest(JSON.stringify([...state.files.values()].map(({ file }) => file)));
    if (this.#savedFiles.get(state.source.id) === signature) {
      this.#store.sql.run(
        "UPDATE native_memory_cache SET source_json=? WHERE source_id=?",
        JSON.stringify(state.source),
        state.source.id,
      );
      return;
    }
    this.#store.sql.run(
      "INSERT INTO native_memory_cache(source_id,directory,source_json,files_json) VALUES (?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET directory=excluded.directory,source_json=excluded.source_json,files_json=excluded.files_json",
      state.source.id,
      state.directory,
      JSON.stringify(state.source),
      JSON.stringify([...state.files.values()]),
    );
    this.#savedFiles.set(state.source.id, signature);
  }
  #changed(): void {
    if (!this.#closed) {
      this.#revision = randomUUID();
      if (!this.#notification) {
        this.#notification = setTimeout(() => {
          this.#notification = null;
          if (!this.#closed) this.#notify();
        }, 100);
        this.#notification.unref();
      }
    }
  }
  #syncWatchers(extra: Iterable<string> = []): void {
    if (!this.#observers.size || this.#closed) return;
    const directories = new Set(
      [...this.#sources.values()].flatMap((state) => (state.directory ? [state.directory] : [])),
    );
    for (const directory of extra) directories.add(directory);
    // FSEvents directory notifications can be unavailable on a macOS volume while
    // kqueue file watches still work. Keep a bounded set; the five-second scan also
    // covers new files, atomic replacements and unsupported watcher implementations.
    if (process.platform === "darwin") {
      let count = 0;
      for (const state of this.#sources.values())
        for (const cached of state.files.values()) {
          if (++count > 512) break;
          if (state.directory)
            directories.add(path.join(state.directory, cached.file.relativePath));
        }
    }
    for (const [directory, watcher] of this.#watchers)
      if (!directories.has(directory)) {
        watcher.close();
        this.#watchers.delete(directory);
      }
    for (const directory of directories)
      if (!this.#watchers.has(directory)) {
        try {
          const found = probe(directory, null, context);
          if (
            (found.kind !== "dir" && found.kind !== "file") ||
            found.real !== directory ||
            !safePath(found.real)
          )
            continue;
          const changed = () => {
            if (!this.#debounce) {
              this.#debounce = setTimeout(() => {
                this.#debounce = null;
                if (this.#observers.size) void this.refresh();
              }, 100);
              this.#debounce.unref();
            }
          };
          // On macOS multiple directory FSEvents streams can block synchronously when
          // closed. StatWatcher avoids that platform failure; kqueue watches below
          // still provide prompt updates for already-known files.
          if (process.platform === "darwin" && found.kind === "dir") {
            const listener = () => changed();
            const watcher = watchFile(
              directory,
              { persistent: false, interval: this.#limits.pollMs },
              listener,
            );
            watcher.unref();
            this.#watchers.set(directory, { close: () => unwatchFile(directory, listener) });
            continue;
          }
          const watcher = watch(directory, changed);
          watcher.on("error", () => {
            watcher.close();
            this.#watchers.delete(directory);
          });
          watcher.unref();
          this.#watchers.set(directory, watcher);
        } catch {
          /* Missing directories and unsupported watchers are covered by the bounded poll. */
        }
      }
  }
  #stopWatching(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#timer = null;
    this.#debounce = null;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }
}
