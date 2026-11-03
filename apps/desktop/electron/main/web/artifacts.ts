import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

export interface ArtifactScope {
  deviceId: string;
  workspaceId: string;
  sessionId?: string;
}
export interface ArtifactGrant {
  root: string;
  /** Changes whenever the device's read grant or workspace registration changes. */
  epoch: string;
}
export type ArtifactPreviewKind =
  | "html"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "download";
export interface ArtifactEntry {
  id: string;
  name: string;
  kind: "file" | "directory";
  mime: string;
  size: number;
  modifiedAt: string;
  revision: string;
  previewKind: ArtifactPreviewKind;
}
export interface ArtifactListing {
  directoryId: string;
  parentId?: string;
  entries: ArtifactEntry[];
}
export interface ArtifactTicketOptions {
  artifactId: string;
  expectedRevision?: string;
  bundleRootId?: string;
  ttlMs?: number;
  download?: boolean;
}
export interface ArtifactOptions {
  previewOrigin: string;
  appOrigin: string;
  additionalAppOrigins?: string[];
  /** Main-process supplied Electron origin, never accepted from remote configuration. */
  desktopAppOrigin?: string;
  authorize: (scope: ArtifactScope) => Promise<ArtifactGrant>;
  /** Only for local integration tests; never permits plain HTTP on LAN addresses. */
  allowHttpLoopback?: boolean;
  now?: () => number;
  maxBundleBytes?: number;
  maxBundleFiles?: number;
  maxTextBytes?: number;
  maxTickets?: number;
  maxSnapshotBytes?: number;
  bytesPerSecond?: number;
  maxTransfers?: number;
  maxDeviceTransfers?: number;
  maxPreviewRequests?: number;
  maxDeviceRequests?: number;
}
export class ArtifactError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
interface Binding {
  scope: ArtifactScope;
  root: string;
  sourceRoot: string;
  rootIdentity: string;
  epoch: string;
}
interface RecordEntry extends Binding {
  path: string;
}
interface Opened {
  handle: FileHandle;
  size: number;
  revision: string;
}
interface BundleFile {
  bytes: Buffer;
  mime: string;
}
interface Ticket extends Binding {
  expiresAt: number;
  revision: string;
  entryPath: string;
  filePath: string;
  mime: string;
  kind: ArtifactPreviewKind;
  download: boolean;
  bundle?: Map<string, BundleFile>;
  active: Set<ServerResponse>;
}
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".rs",
  ".py",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".swift",
  ".sh",
  ".sql",
  ".diff",
  ".patch",
]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};
const opaqueId = () => randomBytes(24).toString("base64url");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const scopeKey = (scope: ArtifactScope) =>
  JSON.stringify([scope.deviceId, scope.workspaceId, scope.sessionId ?? null]);
const toUrlPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");
function reject(status: number, code: string): never {
  throw new ArtifactError(status, code);
}
function validateRelative(path: string, allowRoot = false) {
  if (allowRoot && path === "") return;
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    [...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    reject(403, "artifact_path_denied");
  for (const part of path.split("/")) {
    if (
      part.startsWith(".") ||
      /^(?:node_modules|vendor|target|credentials?|secrets?|id_rsa|id_ed25519)$/i.test(part) ||
      /(?:^|[._-])(?:secret|credentials?|private[-_]?key)(?:[._-]|$)/i.test(part) ||
      /^(?:auth|oauth|tokens?|access[_-]?token|refresh[_-]?token)(?:\.[^.]+)?$/i.test(part) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(part) ||
      part.includes(":")
    )
      reject(403, "artifact_sensitive_path");
  }
}
function servable(path: string) {
  try {
    validateRelative(path, true);
    return true;
  } catch {
    return false;
  }
}
function percentDecoded(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
function validateCanonical(path: string) {
  // Granting an ancestor must not publish agent state (config files can contain
  // MCP environment secrets). Only actual Codex worktrees are project roots.
  const parts = resolve(path)
    .split(sep)
    .map((part) => part.toLowerCase());
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const child = parts[index + 1] ?? "";
    if (
      [
        ".git",
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".claude",
        ".gemini",
        ".agentkib",
        "ai.agentkib",
        "ai.agentkib.dev",
      ].includes(part) ||
      (part === ".codex" && !(child === "worktrees" && parts[index + 2]))
    )
      reject(403, "artifact_sensitive_path");
  }
}
function revisionOf(stat: Awaited<ReturnType<FileHandle["stat"]>>) {
  return digest([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"));
}
function identityOf(stat: Awaited<ReturnType<typeof lstat>>) {
  return `${stat.dev}:${stat.ino}`;
}
function mimeFor(path: string) {
  const ext = extname(path).toLowerCase();
  return (
    MIME[ext] ??
    (TEXT_EXTENSIONS.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream")
  );
}
function kindFor(path: string): ArtifactPreviewKind {
  const mime = mimeFor(path);
  return mime.startsWith("text/html")
    ? "html"
    : mime.startsWith("image/")
      ? "image"
      : mime.startsWith("video/")
        ? "video"
        : mime.startsWith("audio/")
          ? "audio"
          : mime === "application/pdf"
            ? "pdf"
            : TEXT_EXTENSIONS.has(extname(path).toLowerCase())
              ? "text"
              : "download";
}
function validOrigin(value: string, allowHttp: boolean) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        allowHttp &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("invalid_artifact_origin");
  return value;
}
/** File metadata and content are scoped by a fresh host-side grant, never a browser path. */
export class ArtifactService {
  private records = new Map<string, RecordEntry>();
  private recordIds = new Map<string, string>();
  private tickets = new Map<string, Ticket>();
  private preparingTickets = 0;
  private transfers = new Map<ServerResponse, string>();
  private previewRequests = new Map<ServerResponse, string>();
  private nextChunkAt = 0;
  private paced: { bytes: number; res: ServerResponse; done: () => void; cancel: () => void }[] =
    [];
  private paceTimer?: ReturnType<typeof setTimeout>;
  private now: () => number;
  previewOrigin: string;
  appOrigin: string;
  private additionalAppOrigins: string[] = [];
  constructor(private options: ArtifactOptions) {
    this.previewOrigin = validOrigin(options.previewOrigin, !!options.allowHttpLoopback);
    this.appOrigin = validOrigin(options.appOrigin, !!options.allowHttpLoopback);
    if (this.previewOrigin === this.appOrigin) throw new Error("artifact_origin_must_be_isolated");
    this.additionalAppOrigins = this.validAdditionalOrigins(
      options.additionalAppOrigins ?? [],
      this.previewOrigin,
    );
    this.now = options.now ?? Date.now;
    for (const value of [
      options.bytesPerSecond,
      options.maxTransfers,
      options.maxDeviceTransfers,
      options.maxPreviewRequests,
      options.maxDeviceRequests,
    ])
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error("artifact_invalid_transfer_limit");
  }
  private reserveRequest(res: ServerResponse, deviceId: string) {
    if (
      this.previewRequests.size >= (this.options.maxPreviewRequests ?? 64) ||
      [...this.previewRequests.values()].filter((id) => id === deviceId).length >=
        (this.options.maxDeviceRequests ?? 16)
    )
      reject(429, "artifact_request_limit");
    this.previewRequests.set(res, deviceId);
    const release = () => {
      this.previewRequests.delete(res);
      res.off("finish", release);
      res.off("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
  }
  private reserveTransfer(res: ServerResponse, deviceId: string) {
    if (
      this.transfers.size >= (this.options.maxTransfers ?? 8) ||
      [...this.transfers.values()].filter((id) => id === deviceId).length >=
        (this.options.maxDeviceTransfers ?? 4)
    )
      reject(429, "artifact_transfer_limit");
    this.transfers.set(res, deviceId);
    const release = () => {
      this.transfers.delete(res);
      res.off("finish", release);
      res.off("close", release);
    };
    res.once("finish", release);
    res.once("close", release);
  }
  private async pace(bytes: number, res: ServerResponse) {
    // One shared schedule bounds aggregate output, independent of the number of
    // tickets or Range requests. Monotonic time is unaffected by clock changes.
    if (res.destroyed) return;
    await new Promise<void>((done) => {
      const chunk = {
        bytes,
        res,
        done,
        cancel: () => {
          this.paced = this.paced.filter((entry) => entry !== chunk);
          done();
          this.pumpChunks();
        },
      };
      this.paced.push(chunk);
      res.once("close", chunk.cancel);
      this.pumpChunks();
    });
  }
  private pumpChunks() {
    if (this.paceTimer) clearTimeout(this.paceTimer);
    this.paceTimer = undefined;
    if (!this.paced.length) return;
    const now = performance.now();
    if (this.nextChunkAt > now) {
      this.paceTimer = setTimeout(() => this.pumpChunks(), this.nextChunkAt - now);
      return;
    }
    const chunk = this.paced.shift()!;
    chunk.res.off("close", chunk.cancel);
    this.nextChunkAt =
      now + (chunk.bytes * 1000) / (this.options.bytesPerSecond ?? 2 * 1024 * 1024);
    chunk.done();
    this.pumpChunks();
  }
  private validAdditionalOrigins(origins: string[], previewOrigin: string) {
    const desktop = this.options.desktopAppOrigin;
    if (desktop && desktop !== "app://bundle")
      validOrigin(desktop, !!this.options.allowHttpLoopback);
    const validated = [
      ...new Set([
        ...origins.map((origin) => validOrigin(origin, !!this.options.allowHttpLoopback)),
        ...(desktop ? [desktop] : []),
      ]),
    ].sort();
    if (validated.includes(previewOrigin)) throw new Error("artifact_origin_must_be_isolated");
    return validated;
  }
  /** The app origins that may frame this preview origin. */
  frameAncestors(): string[] {
    return [this.appOrigin, ...this.additionalAppOrigins];
  }
  setOrigins(appOrigin: string, previewOrigin: string, additionalAppOrigins: string[] = []) {
    validOrigin(appOrigin, !!this.options.allowHttpLoopback);
    validOrigin(previewOrigin, !!this.options.allowHttpLoopback);
    if (appOrigin === previewOrigin) throw new Error("artifact_origin_must_be_isolated");
    const additional = this.validAdditionalOrigins(additionalAppOrigins, previewOrigin);
    if (
      this.appOrigin === appOrigin &&
      this.previewOrigin === previewOrigin &&
      JSON.stringify(additional) === JSON.stringify(this.additionalAppOrigins)
    )
      return;
    this.clear();
    this.appOrigin = appOrigin;
    this.previewOrigin = previewOrigin;
    this.additionalAppOrigins = additional;
  }
  private async binding(scope: ArtifactScope): Promise<Binding> {
    if (!scope.deviceId || !scope.workspaceId) reject(403, "artifact_access_denied");
    const grant = await this.options.authorize({ ...scope });
    if (!grant || !grant.root || !grant.epoch) reject(403, "artifact_access_denied");
    const root = await realpath(grant.root).catch(() => reject(404, "artifact_root_unavailable"));
    validateCanonical(root);
    validateCanonical(grant.root);
    const stat = await lstat(root);
    if (!stat.isDirectory()) reject(404, "artifact_root_unavailable");
    return {
      scope: { ...scope },
      root,
      sourceRoot: resolve(grant.root),
      rootIdentity: identityOf(stat),
      epoch: grant.epoch,
    };
  }
  private sameBinding(left: Binding, right: Binding) {
    return (
      scopeKey(left.scope) === scopeKey(right.scope) &&
      left.root === right.root &&
      left.rootIdentity === right.rootIdentity &&
      left.epoch === right.epoch
    );
  }
  private async check(binding: Binding) {
    if (!this.sameBinding(binding, await this.binding(binding.scope)))
      reject(403, "artifact_access_changed");
  }
  private remember(binding: Binding, path: string) {
    const key = JSON.stringify([
      scopeKey(binding.scope),
      binding.root,
      binding.rootIdentity,
      binding.epoch,
      path,
    ]);
    const existing = this.recordIds.get(key);
    if (existing) return existing;
    if (this.records.size >= 20_000) reject(429, "artifact_catalog_limit");
    const id = opaqueId();
    this.records.set(id, { ...binding, path });
    this.recordIds.set(key, id);
    return id;
  }
  private async record(scope: ArtifactScope, id: string) {
    const record = this.records.get(id);
    if (!record || scopeKey(record.scope) !== scopeKey(scope)) reject(404, "artifact_not_found");
    await this.check(record);
    return record;
  }
  private async inspect(binding: Binding, path: string) {
    validateRelative(path, true);
    validateCanonical(join(binding.root, path));
    validateCanonical(join(binding.sourceRoot, path));
    let current = binding.root;
    const rootStat = await lstat(current);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      identityOf(rootStat) !== binding.rootIdentity
    )
      reject(409, "artifact_changed");
    for (const part of path ? path.split("/") : []) {
      current = join(current, part);
      const stat = await lstat(current).catch(() => reject(404, "artifact_not_found"));
      // Node reports Windows junctions as symbolic links as well.
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        reject(403, "artifact_path_denied");
    }
    const canonical = await realpath(current).catch(() => reject(404, "artifact_not_found"));
    const rel = relative(binding.root, canonical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || canonical !== current)
      reject(403, "artifact_path_denied");
    return { file: canonical, stat: await lstat(canonical) };
  }
  private async openFile(
    binding: Binding,
    path: string,
    expectedRevision?: string,
    verifyGrant = true,
  ): Promise<Opened> {
    const before = await this.inspect(binding, path);
    if (!before.stat.isFile() || before.stat.nlink !== 1) reject(403, "artifact_path_denied");
    const revision = revisionOf(before.stat);
    if (expectedRevision && revision !== expectedRevision) reject(409, "artifact_changed");
    const handle = await open(before.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      const after = await this.inspect(binding, path);
      // Use the verified descriptor for reads. A path substitution must never
      // switch the stream to a file outside the authorized directory.
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        revisionOf(stat) !== revision ||
        revisionOf(after.stat) !== revision
      )
        reject(409, "artifact_changed");
      if (verifyGrant) await this.check(binding);
      return { handle, revision, size: stat.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private async snapshot(binding: Binding, path: string, maxBytes: number, verifyGrant = true) {
    const opened = await this.openFile(binding, path, undefined, verifyGrant);
    try {
      if (opened.size > maxBytes) reject(413, "artifact_too_large");
      // A file can grow after fstat; do not let readFile allocate without a bound.
      const bytes = Buffer.alloc(opened.size);
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await opened.handle.read(
          bytes,
          position,
          bytes.length - position,
          position,
        );
        if (!bytesRead) reject(409, "artifact_changed");
        position += bytesRead;
      }
      if (revisionOf(await opened.handle.stat()) !== opened.revision)
        reject(409, "artifact_changed");
      if (verifyGrant) await this.check(binding);
      return { bytes, revision: opened.revision };
    } finally {
      await opened.handle.close();
    }
  }
  async list(scope: ArtifactScope, directoryId?: string): Promise<ArtifactListing> {
    const binding = directoryId ? await this.record(scope, directoryId) : await this.binding(scope);
    const path = "path" in binding ? (binding.path as string) : "";
    const directory = await this.inspect(binding, path);
    if (!directory.stat.isDirectory()) reject(400, "artifact_not_directory");
    const names = await readdir(directory.file);
    if (names.length > 5_000) reject(413, "artifact_directory_too_large");
    const entries: ArtifactEntry[] = [];
    for (const name of names.sort()) {
      const entryPath = path ? `${path}/${name}` : name;
      try {
        const { stat } = await this.inspect(binding, entryPath);
        if (stat.isFile() && stat.nlink !== 1) continue;
        entries.push({
          id: this.remember(binding, entryPath),
          name,
          kind: stat.isDirectory() ? "directory" : "file",
          mime: stat.isDirectory() ? "inode/directory" : mimeFor(name),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          revision: revisionOf(stat),
          previewKind: kindFor(name),
        });
      } catch (error) {
        if (!(error instanceof ArtifactError && [403, 404].includes(error.status))) throw error;
      }
    }
    await this.check(binding);
    return {
      directoryId: this.remember(binding, path),
      ...(path
        ? {
            parentId: this.remember(
              binding,
              path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
            ),
          }
        : {}),
      entries,
    };
  }
  async readText(scope: ArtifactScope, artifactId: string, expectedRevision?: string) {
    const record = await this.record(scope, artifactId);
    if (!["text", "html"].includes(kindFor(record.path))) reject(415, "artifact_not_text");
    const snapshot = await this.snapshot(
      record,
      record.path,
      this.options.maxTextBytes ?? 1024 * 1024,
    );
    if (expectedRevision && snapshot.revision !== expectedRevision) reject(409, "artifact_changed");
    if (snapshot.bytes.includes(0)) reject(415, "artifact_not_text");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
    } catch {
      return reject(415, "artifact_invalid_utf8");
    }
    return { id: artifactId, name: basename(record.path), text, revision: snapshot.revision };
  }
  /** Resolve an opaque browser file ID immediately before native dispatch. */
  async resolveContextReference(
    scope: ArtifactScope,
    artifactId: string,
    expectedRevision: string,
  ) {
    const record = await this.record(scope, artifactId);
    const inspected = await this.inspect(record, record.path);
    if (!inspected.stat.isDirectory() && (!inspected.stat.isFile() || inspected.stat.nlink !== 1))
      reject(403, "artifact_path_denied");
    const revision = revisionOf(inspected.stat);
    if (revision !== expectedRevision) reject(409, "artifact_changed");
    await this.check(record);
    return {
      kind: inspected.stat.isDirectory() ? ("directory" as const) : ("file" as const),
      relativePath: record.path,
      revision,
    };
  }
  /**
   * References found in a transcript are candidates, never an authorization override.
   *
   * `directory` is the session's working directory, a hint for relative references:
   * they are tried against it first and then against the root. When it lies outside the
   * root or in a directory the root never serves (a hidden worktree, for example),
   * relative references are skipped rather than matched against a different checkout.
   */
  async resolveReferences(scope: ArtifactScope, references: string[], directory?: string) {
    if (references.length > 100) reject(413, "artifact_reference_limit");
    const binding = await this.binding(scope);
    // "" places relative references at the root; undefined means they cannot be placed.
    let base: string | undefined = "";
    if (directory !== undefined) {
      base = isAbsolute(directory) ? this.relativeToRoot(binding, directory) : undefined;
      if (base && !servable(base)) base = undefined;
    }
    const results: (ArtifactEntry & { reference: string })[] = [];
    for (const reference of references) {
      if (
        typeof reference !== "string" ||
        reference.length > 4096 ||
        /^[a-z]+:\/\//i.test(reference)
      )
        continue;
      let candidates: string[];
      if (isAbsolute(reference)) {
        const path = this.relativeToRoot(binding, reference);
        if (path === undefined) continue;
        candidates = [path];
      } else if (base === undefined) continue;
      else candidates = base ? [posix.join(base, reference), reference] : [reference];
      // Markdown destinations may be percent-encoded (`with%20space.txt`).
      for (const path of new Set(candidates.flatMap((path) => [path, percentDecoded(path)]))) {
        try {
          const { stat } = await this.inspect(binding, path);
          if (!stat.isFile() || stat.nlink !== 1) continue;
          results.push({
            reference,
            id: this.remember(binding, path),
            name: basename(path),
            revision: revisionOf(stat),
            kind: "file",
            mime: mimeFor(path),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            previewKind: kindFor(path),
          });
          break;
        } catch (error) {
          if (!(error instanceof ArtifactError && [403, 404].includes(error.status))) throw error;
        }
      }
    }
    await this.check(binding);
    return results;
  }
  /** An absolute path as a slash-separated path under the root, or undefined outside it. */
  private relativeToRoot(binding: Binding, absolute: string): string | undefined {
    const inside = (path: string) =>
      path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
    // The registered root itself may be an alias (e.g. /var -> /private/var
    // on macOS), but resolving a child first would conceal forbidden links.
    const aliasRelative = relative(binding.sourceRoot, absolute);
    const path = inside(aliasRelative) ? aliasRelative : relative(binding.root, absolute);
    return inside(path) ? path.split(sep).join("/") : undefined;
  }
  async issueTicket(scope: ArtifactScope, input: ArtifactTicketOptions) {
    // Preparing snapshots also consumes memory before a ticket is published.
    if (this.preparingTickets >= 2) reject(429, "artifact_preparation_busy");
    this.preparingTickets++;
    try {
      return await this.prepareTicket(scope, input);
    } finally {
      this.preparingTickets--;
    }
  }
  private async prepareTicket(scope: ArtifactScope, input: ArtifactTicketOptions) {
    this.expire();
    if (this.tickets.size >= (this.options.maxTickets ?? 32)) reject(429, "artifact_ticket_limit");
    const record = await this.record(scope, input.artifactId);
    const inspected = await this.inspect(record, record.path);
    if (!inspected.stat.isFile()) reject(400, "artifact_not_file");
    const kind = kindFor(record.path);
    let entryPath = basename(record.path),
      revision = revisionOf(inspected.stat);
    let sourceRevision = revision;
    if (input.expectedRevision && input.expectedRevision !== revision)
      reject(409, "artifact_changed");
    let bundle: Map<string, BundleFile> | undefined;
    if (kind === "html" && !input.download) {
      const rootRecord = input.bundleRootId ? await this.record(scope, input.bundleRootId) : record;
      const bundleRoot = input.bundleRootId
        ? rootRecord.path
        : dirname(record.path) === "."
          ? ""
          : dirname(record.path).split(sep).join("/");
      if (
        !this.sameBinding(rootRecord, record) ||
        (bundleRoot && !record.path.startsWith(`${bundleRoot}/`))
      )
        reject(403, "artifact_bundle_denied");
      const root = await this.inspect(record, bundleRoot);
      if (!root.stat.isDirectory()) reject(400, "artifact_not_directory");
      entryPath = bundleRoot ? record.path.slice(bundleRoot.length + 1) : record.path;
      bundle = new Map();
      let total = 0;
      const maxBytes = this.options.maxBundleBytes ?? 32 * 1024 * 1024;
      const maxFiles = this.options.maxBundleFiles ?? 256;
      let visitedNodes = 0;
      const visit = async (path: string, depth: number) => {
        // Empty directories count too: a file-only quota permits unbounded walks.
        if (depth > 12 || ++visitedNodes > maxFiles * 4) reject(413, "artifact_bundle_too_large");
        const directory = await this.inspect(record, path);
        const names = await readdir(directory.file);
        if (names.length > maxFiles) reject(413, "artifact_bundle_too_large");
        for (const name of names.sort()) {
          const child = path ? `${path}/${name}` : name;
          try {
            validateRelative(child);
          } catch {
            continue;
          }
          if (++visitedNodes > maxFiles * 4) reject(413, "artifact_bundle_too_large");
          const { stat } = await this.inspect(record, child);
          if (stat.isDirectory()) {
            await visit(child, depth + 1);
            continue;
          }
          if (bundle!.size >= maxFiles) reject(413, "artifact_bundle_too_large");
          const snapshot = await this.snapshot(record, child, maxBytes - total, false);
          if (
            child === record.path &&
            input.expectedRevision &&
            snapshot.revision !== input.expectedRevision
          )
            reject(409, "artifact_changed");
          if (child === record.path) sourceRevision = snapshot.revision;
          total += snapshot.bytes.length;
          bundle!.set(bundleRoot ? child.slice(bundleRoot.length + 1) : child, {
            bytes: snapshot.bytes,
            mime: mimeFor(child),
          });
        }
      };
      await visit(bundleRoot, 0);
      if (!bundle.has(entryPath)) reject(404, "artifact_not_found");
      const hash = createHash("sha256");
      for (const [path, file] of bundle)
        hash.update(JSON.stringify([path, file.bytes.length])).update(file.bytes);
      revision = hash.digest("hex");
    } else {
      const opened = await this.openFile(record, record.path, revision);
      await opened.handle.close();
    }
    await this.check(record);
    const ttlMs = input.ttlMs ?? 10 * 60_000;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 30 * 60_000)
      reject(400, "artifact_invalid_ttl");
    const id = opaqueId(),
      expiresAt = this.now() + ttlMs;
    // Recheck after filesystem awaits so concurrent preparations cannot bypass limits.
    this.expire();
    if (this.tickets.size >= (this.options.maxTickets ?? 32)) reject(429, "artifact_ticket_limit");
    const bytesIn = (files?: Map<string, BundleFile>) =>
      [...(files?.values() ?? [])].reduce((sum, file) => sum + file.bytes.length, 0);
    const allocated = [...this.tickets.values()].reduce(
      (sum, ticket) => sum + bytesIn(ticket.bundle),
      0,
    );
    if (allocated + bytesIn(bundle) > (this.options.maxSnapshotBytes ?? 64 * 1024 * 1024))
      reject(413, "artifact_snapshot_limit");
    this.tickets.set(id, {
      ...record,
      expiresAt,
      revision,
      entryPath,
      filePath: record.path,
      mime: mimeFor(record.path),
      kind,
      download: !!input.download,
      bundle,
      active: new Set(),
    });
    return {
      url: `${this.previewOrigin}/p/${id}/${toUrlPath(entryPath)}`,
      expiresAt,
      revision,
      // HTML revision identifies the complete frozen bundle; callers compare the
      // selected entry against this actual snapshot revision instead.
      sourceRevision,
      kind,
      ...(bundle
        ? {
            manifest: [...bundle].map(([path, file]) => ({
              path,
              mime: file.mime,
              size: file.bytes.length,
            })),
          }
        : {}),
    };
  }
  /** Only already-issued desktop tickets may open a native download dialog. */
  ownsTicketUrl(deviceId: string, input: string): boolean {
    try {
      const url = new URL(input);
      if (
        url.origin !== this.previewOrigin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return false;
      const match = /^\/p\/([A-Za-z0-9_-]{32})\/(.+)$/.exec(url.pathname);
      const ticket = match && this.tickets.get(match[1]);
      return (
        !!ticket &&
        ticket.scope.deviceId === deviceId &&
        ticket.expiresAt > this.now() &&
        url.pathname === `/p/${match![1]}/${toUrlPath(ticket.entryPath)}`
      );
    } catch {
      return false;
    }
  }
  revokeDevice(deviceId: string) {
    for (const [id, ticket] of this.tickets)
      if (ticket.scope.deviceId === deviceId) this.removeTicket(id);
    for (const [id, record] of this.records)
      if (record.scope.deviceId === deviceId) this.records.delete(id);
    for (const [key, id] of this.recordIds) if (!this.records.has(id)) this.recordIds.delete(key);
  }
  clear() {
    for (const id of this.tickets.keys()) this.removeTicket(id);
    this.records.clear();
    this.recordIds.clear();
  }
  private removeTicket(id: string) {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    for (const response of ticket?.active ?? []) response.destroy();
  }
  private expire() {
    for (const [id, ticket] of this.tickets)
      if (ticket.expiresAt <= this.now()) this.removeTicket(id);
  }
  /** The caller routes ONLY the isolated preview host here. Also checks Host defensively. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const known =
        error instanceof ArtifactError ? error : new ArtifactError(500, "artifact_unavailable");
      res.writeHead(known.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...(known.status === 429 ? { "Retry-After": "1" } : {}),
      });
      res.end(JSON.stringify({ code: known.code }));
    }
  }
  private async serve(req: IncomingMessage, res: ServerResponse) {
    this.expire();
    if (req.headers.host !== new URL(this.previewOrigin).host) reject(403, "artifact_invalid_host");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? ""))
      reject(405, "artifact_method_not_allowed");
    // Inspect the raw path before URL normalization could erase traversal segments.
    const match = /^\/p\/([A-Za-z0-9_-]{32})\/([^?#]+)$/.exec((req.url ?? "").split("?")[0]);
    if (!match) reject(404, "artifact_not_found");
    let path: string;
    try {
      path = decodeURIComponent(match[2]);
    } catch {
      return reject(400, "artifact_invalid_path");
    }
    validateRelative(path);
    const ticket = this.tickets.get(match[1]);
    if (!ticket) reject(410, "artifact_ticket_expired");
    this.reserveRequest(res, ticket.scope.deviceId);
    await this.check(ticket);
    const origin = req.headers.origin;
    if (
      origin &&
      !["null", this.appOrigin, this.previewOrigin, ...this.additionalAppOrigins].includes(origin)
    )
      reject(403, "artifact_invalid_origin");
    const bundleFile = ticket.bundle?.get(path);
    if (ticket.bundle ? !bundleFile : path !== ticket.entryPath) reject(404, "artifact_not_found");
    const mime = bundleFile?.mime ?? ticket.mime;
    const base = `${this.previewOrigin}/p/${match[1]}/`;
    const ancestors = this.frameAncestors().join(" ");
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Accept-Ranges": "bytes",
      "Content-Type": mime,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Content-Security-Policy": mime.startsWith("text/html")
        ? `default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src ${base} data: blob:; media-src ${base} blob:; font-src ${base} data:; connect-src ${base}; object-src 'none'; worker-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts; frame-ancestors ${ancestors}`
        : `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
      ETag: `"${ticket.revision}"`,
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
      headers["Access-Control-Expose-Headers"] =
        "Accept-Ranges, Content-Length, Content-Range, ETag";
    }
    if (req.method === "OPTIONS") {
      const requested = String(req.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (
        !origin ||
        !["GET", "HEAD"].includes(String(req.headers["access-control-request-method"])) ||
        requested.some((header) => !["range", "if-range"].includes(header))
      )
        reject(403, "artifact_invalid_preflight");
      res.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Range, If-Range",
      });
      res.end();
      return;
    }
    if ((ticket.kind === "download" || ticket.download) && !ticket.bundle)
      headers["Content-Disposition"] =
        `attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`;
    let opened: Opened | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!bundleFile) opened = await this.openFile(ticket, ticket.filePath, ticket.revision);
      const size = bundleFile?.bytes.length ?? opened!.size;
      let range: { start: number; end: number } | undefined;
      if (
        req.method !== "HEAD" &&
        req.headers.range &&
        (!req.headers["if-range"] || req.headers["if-range"] === headers.ETag)
      )
        range = parseByteRange(req.headers.range, size);
      const start = range?.start ?? 0,
        end = range?.end ?? size - 1;
      headers["Content-Length"] = String(Math.max(0, end - start + 1));
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      if (ticket.expiresAt <= this.now() || this.tickets.get(match[1]) !== ticket)
        reject(410, "artifact_ticket_expired");
      if (req.method === "GET" && size > 256 * 1024)
        this.reserveTransfer(res, ticket.scope.deviceId);
      ticket.active.add(res);
      timer = setTimeout(() => res.destroy(), Math.max(1, ticket.expiresAt - this.now()));
      timer.unref();
      const done = () => {
        if (timer) clearTimeout(timer);
        ticket.active.delete(res);
        res.off("finish", done);
        res.off("close", done);
      };
      res.once("finish", done);
      res.once("close", done);
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      let nextGrantCheck = this.now() + 1000;
      const revalidate = async () => {
        if (this.now() >= nextGrantCheck) {
          await this.check(ticket);
          nextGrantCheck = this.now() + 1000;
        }
        if (this.tickets.get(match[1]) !== ticket || ticket.expiresAt <= this.now())
          reject(410, "artifact_ticket_expired");
      };
      if (bundleFile) {
        for (let position = start; position <= end && !res.destroyed; position += 64 * 1024) {
          const chunk = bundleFile.bytes.subarray(
            position,
            Math.min(position + 64 * 1024, end + 1),
          );
          await this.pace(chunk.length, res);
          if (res.destroyed) return;
          await revalidate();
          if (!res.write(chunk))
            await new Promise<void>((done) => {
              const finish = () => {
                res.off("drain", finish);
                res.off("close", finish);
                done();
              };
              res.once("drain", finish);
              res.once("close", finish);
            });
        }
        if (!res.destroyed) res.end();
        return;
      }
      // A bounded read loop avoids buffering large videos and revalidates revocation
      // and in-place mutations between chunks. Descriptor identity remains pinned.
      const buffer = Buffer.alloc(Math.min(256 * 1024, Math.max(1, size)));
      let position = start;
      while (position <= end && !res.destroyed) {
        await revalidate();
        if (revisionOf(await opened!.handle.stat()) !== opened!.revision)
          reject(409, "artifact_changed");
        const count = Math.min(buffer.length, end - position + 1);
        const { bytesRead } = await opened!.handle.read(buffer, 0, count, position);
        if (bytesRead !== count || revisionOf(await opened!.handle.stat()) !== opened!.revision)
          reject(409, "artifact_changed");
        position += bytesRead;
        await this.pace(bytesRead, res);
        if (res.destroyed) return;
        await revalidate();
        if (revisionOf(await opened!.handle.stat()) !== opened!.revision)
          reject(409, "artifact_changed");
        if (!res.write(Buffer.from(buffer.subarray(0, bytesRead)))) {
          await new Promise<void>((resolveDrain) => {
            const done = () => {
              res.off("drain", done);
              res.off("close", done);
              resolveDrain();
            };
            res.once("drain", done);
            res.once("close", done);
          });
        }
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      if (
        error instanceof ArtifactError &&
        error.code === "artifact_invalid_range" &&
        !res.headersSent
      ) {
        res.writeHead(416, {
          ...headers,
          "Content-Range": `bytes */${bundleFile?.bytes.length ?? opened?.size ?? 0}`,
          "Content-Length": "0",
        });
        res.end();
        return;
      }
      throw error;
    } finally {
      if (!res.headersSent) {
        if (timer) clearTimeout(timer);
        ticket.active.delete(res);
      }
      await opened?.handle.close();
    }
  }
}
export function parseByteRange(value: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size <= 0) reject(416, "artifact_invalid_range");
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    reject(416, "artifact_invalid_range");
  const start = first ?? Math.max(0, size - last!);
  const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);
  if ((first === undefined && last === 0) || start >= size || end < start)
    reject(416, "artifact_invalid_range");
  return { start, end };
}
