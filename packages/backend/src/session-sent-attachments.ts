import {
  REMOTE_ERROR_CODES,
  SESSION_ATTACHMENT_LIMITS,
  SESSION_ATTACHMENT_RASTER_TYPES,
  sessionAttachmentMarkdown,
  type ConversationSentAttachment,
} from "@agentkib/runtime-protocol";
import { createHmac, randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readText } from "./files";
import { isReparseOrSymlink } from "./native-files";
import { canonicalize } from "./paths";
import { sanitizeSessionText } from "./session-handoff";
import { MAX_SESSION_IMAGE_BYTES } from "./session-images";
import {
  readSentAttachmentImage,
  sentAttachmentFileAvailable,
  type SentAttachmentFile,
} from "./session-sent-attachment-files";
import { projectWorkerReports } from "./worker-report-ledger";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MARKER_ID = /\/([a-f0-9-]{36})(?:\.[a-zA-Z0-9]{1,12})?\)$/;
const IMAGE_PREFIX = "sent-attachment-v1-";
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCES = 4096;
const REFERENCE_TTL = 15 * 60 * 1000;
const indexItem = z.object({
  id: z.string().regex(UUID),
  sessionId: z.string().min(1).max(256),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\x00-\x1f\\/]+$/),
  mime: z
    .string()
    .max(255)
    .regex(/^[\w.+-]+\/[\w.+-]+$/),
  size: z.number().int().positive().max(SESSION_ATTACHMENT_LIMITS.fileBytes),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  sent: z.literal(true),
  terminalCopy: z
    .object({
      cwd: z.string().max(4096),
      directory: z.string(),
      file: z.string(),
      dev: z.string().regex(/^\d+$/),
      ino: z.string().regex(/^\d+$/),
    })
    .optional(),
});
type IndexItem = z.infer<typeof indexItem>;
type Location = "host" | "terminal";
type Match = { root: string; item: IndexItem; location: Location; file: SentAttachmentFile };
type ImageReference = { match: Match; expiresAt: number };
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function hostDirectories(dataDir: string, environment: NodeJS.ProcessEnv): string[] {
  const roots = new Set([path.join(dataDir, "attachments")]);
  try {
    const configured: unknown = JSON.parse(environment.AGENTKIB_HOST_ATTACHMENTS_DIRS ?? "[]");
    if (Array.isArray(configured) && configured.length <= 4) {
      for (const directory of configured) {
        if (typeof directory !== "string" || !path.isAbsolute(directory)) continue;
        roots.add(directory);
        const web = path.dirname(directory);
        // Shared desktop runtimes receive the trusted Web stores from both app profiles.
        if (path.basename(web) === "web" && path.basename(directory) === "attachments")
          roots.add(path.join(path.dirname(web), "web-lan", "attachments"));
      }
    }
  } catch {}
  return [...roots];
}

function attachmentFile(
  root: string,
  item: IndexItem,
  location: Location,
): SentAttachmentFile | undefined {
  const base = { size: item.size, digest: item.version, mimeType: item.mime };
  if (location === "host") return { ...base, directory: root, filename: item.id };
  const copy = item.terminalCopy;
  if (
    !copy ||
    !path.isAbsolute(copy.cwd) ||
    copy.cwd.includes("\0") ||
    copy.cwd.split(path.sep).includes("..") ||
    (process.platform === "win32" && /^[\\/]{2}/.test(copy.cwd)) ||
    !copy.directory.startsWith(".agentkib-attachment-") ||
    !UUID.test(copy.directory.slice(".agentkib-attachment-".length)) ||
    !copy.file.startsWith(item.id) ||
    (copy.file !== item.id && !/^\.[a-z0-9]{1,12}$/i.test(copy.file.slice(item.id.length)))
  )
    return;
  return {
    ...base,
    directory: path.join(copy.cwd, copy.directory),
    filename: copy.file,
    directoryIdentity: { dev: copy.dev, ino: copy.ino },
  };
}

/** Derive paths exclusively from the host's existing sent-upload index. */
export class SessionSentAttachments {
  readonly #directories: readonly string[];
  readonly #index = new Map<
    string,
    { revision: string; sessions: Map<string, Map<string, IndexItem>> }
  >();
  readonly #references = new Map<string, ImageReference>();
  readonly #key = randomBytes(32);

  constructor(
    private readonly dataDir: string,
    environment: NodeJS.ProcessEnv,
  ) {
    this.#directories = hostDirectories(dataDir, environment);
  }

  #manifest(root: string) {
    const index = path.join(root, "index.json");
    const revision = () => {
      const info = lstatSync(index, { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || isReparseOrSymlink(index, info))
        throw new Error("Invalid attachment index");
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    };
    try {
      const current = revision();
      const cached = this.#index.get(root);
      if (cached?.revision === current) return cached.sessions;
      const rows: unknown = JSON.parse(readText(index, MAX_INDEX_BYTES));
      if (!Array.isArray(rows) || revision() !== current) return;
      const sessions = new Map<string, Map<string, IndexItem>>();
      for (const row of rows) {
        const parsed = indexItem.safeParse(row);
        if (!parsed.success) continue;
        const item = parsed.data;
        const entries = sessions.get(item.sessionId) ?? new Map();
        entries.set(item.id, item);
        sessions.set(item.sessionId, entries);
      }
      this.#index.set(root, { revision: current, sessions });
      return sessions;
    } catch {
      this.#index.delete(root);
    }
  }

  #sessionIndexes(sessionId: string) {
    const indexes = new Map<string, Map<string, IndexItem>>();
    for (const directory of this.#directories) {
      let root: string;
      try {
        if (isReparseOrSymlink(directory)) continue;
        root = canonicalize(directory);
      } catch {
        continue;
      }
      const entries = this.#manifest(root)?.get(sessionId);
      if (entries) indexes.set(root, entries);
    }
    return indexes;
  }

  #match(
    line: string,
    id: string,
    indexes: ReadonlyMap<string, ReadonlyMap<string, IndexItem>>,
  ): Match | undefined {
    for (const [root, entries] of indexes) {
      const item = entries.get(id);
      if (!item) continue;
      for (const location of ["host", "terminal"] as const) {
        const file = attachmentFile(root, item, location);
        if (!file) continue;
        const expected = sessionAttachmentMarkdown(
          item.name,
          pathToFileURL(path.join(file.directory, file.filename)).href,
        );
        // Some native transcript readers already redact the actual home into $HOME.
        if (line === expected || line === sanitizeSessionText(expected, { value: 0 }))
          return { root, item, location, file };
      }
    }
  }

  #imageId(match: Match): string {
    const token =
      IMAGE_PREFIX +
      createHmac("sha256", this.#key)
        .update(JSON.stringify([match.item.sessionId, match.root, match.item.id, match.file]))
        .digest("base64url");
    this.#references.delete(token);
    this.#references.set(token, { match, expiresAt: Date.now() + REFERENCE_TTL });
    if (this.#references.size > MAX_REFERENCES)
      this.#references.delete(this.#references.keys().next().value!);
    return token;
  }

  image(params: Record<string, unknown>) {
    const { operation, sessionId, imageId } = params;
    if (
      operation !== "session-image" ||
      typeof imageId !== "string" ||
      !imageId.startsWith(IMAGE_PREFIX)
    )
      return;
    const reference = this.#references.get(imageId);
    if (
      !reference ||
      reference.expiresAt <= Date.now() ||
      reference.match.item.sessionId !== sessionId
    )
      throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    const { match } = reference;
    const current = this.#manifest(match.root)?.get(match.item.sessionId)?.get(match.item.id);
    const file = current && attachmentFile(match.root, current, match.location);
    if (!file || JSON.stringify(file) !== JSON.stringify(match.file))
      throw new Error(REMOTE_ERROR_CODES.sessionImageChanged);
    return readSentAttachmentImage(file);
  }

  project<T>(sessionId: unknown, value: T): T {
    if (typeof sessionId !== "string" || !record(value)) return value;
    let indexes: ReadonlyMap<string, ReadonlyMap<string, IndexItem>> | undefined;
    const item = (event: unknown) => {
      if (
        !record(event) ||
        event.kind !== "user-message" ||
        typeof event.content !== "string" ||
        !event.content.includes("User attached file [")
      )
        return event;
      const attachments: ConversationSentAttachment[] = [];
      const content = event.content.split(/\r?\n/).filter((line) => {
        if (
          attachments.length >= SESSION_ATTACHMENT_LIMITS.count ||
          !line.startsWith("User attached file [")
        )
          return true;
        // The raw suffix is only an index key. The whole marker must match a path from the manifest.
        const id = MARKER_ID.exec(line)?.[1];
        if (!id || !UUID.test(id)) return true;
        indexes ??= this.#sessionIndexes(sessionId);
        const found = this.#match(line, id, indexes);
        if (!found) return true;
        const { file, item: source } = found;
        const image = SESSION_ATTACHMENT_RASTER_TYPES.includes(file.mimeType);
        const available =
          (!image || file.size <= MAX_SESSION_IMAGE_BYTES) && sentAttachmentFileAvailable(file);
        attachments.push({
          name: source.name,
          kind: image ? "image" : "file",
          mimeType: file.mimeType,
          size: file.size,
          available,
          ...(image && available && { imageId: this.#imageId(found) }),
        });
        return false;
      });
      if (!attachments.length) return event;
      return {
        ...event,
        content: content.join("\n").replace(/^\n+|\n+$/g, "") || null,
        attachment_count:
          (typeof event.attachment_count === "number" ? event.attachment_count : 0) +
          attachments.length,
        attachments,
      };
    };
    if (Array.isArray(value.events)) return { ...value, events: value.events.map(item) };
    if (Array.isArray(value.items)) return { ...value, items: value.items.map(item) };
    return item(value) as T;
  }

  projectConversation<T>(sessionId: unknown, value: T): T {
    return this.project(sessionId, projectWorkerReports(this.dataDir, sessionId, value));
  }

  response(request: Record<string, unknown> | undefined, result: unknown) {
    if (request?.operation === "events")
      return Promise.resolve(result).then((page) =>
        this.projectConversation(request.sessionId, page),
      );
    if (request?.operation === "desktop-events")
      return Promise.resolve(result).then((response) =>
        record(response) && response.handled === true
          ? { ...response, page: this.project(request.sessionId, response.page) }
          : response,
      );
  }
}
