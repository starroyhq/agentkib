import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { constants } from "node:fs";
import { imageDimensions } from "./attachment-images";

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  version: string;
  deviceId: string;
  sessionId: string;
  createdAt: number;
  sent: boolean;
}
const FILE_LIMIT = 25 * 1024 * 1024;
const MESSAGE_LIMIT = 100 * 1024 * 1024;
const STORE_LIMIT = 2 * 1024 * 1024 * 1024;
const CLAUDE_IMAGE_LIMIT = 4 * 1024 * 1024;
const CLAUDE_IMAGES_LIMIT = 12 * 1024 * 1024;
interface AttachmentRequest {
  deviceId: string;
  sessionId: string;
  requestId: string;
  fingerprint: string;
  ids: string[];
  settled: boolean;
}
export class AttachmentStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async load(): Promise<Attachment[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let items: Attachment[];
    try {
      items = JSON.parse(await readFile(join(this.directory, "index.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      items = [];
    }
    if (
      !Array.isArray(items) ||
      items.some(
        (item) =>
          !/^[a-f0-9-]{36}$/.test(item.id) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0 ||
          !/^[a-f0-9]{64}$/.test(item.version),
      )
    )
      throw new AttachmentError(503, "attachment_index_invalid");
    // Only this serialized store writes UUID files. A file missing from the atomic
    // manifest is an interrupted upload, never a native message reference.
    const retained = new Set(items.map((item) => item.id));
    if (
      (await this.requests()).some(
        (request) => !request.settled && request.ids.some((id) => !retained.has(id)),
      )
    )
      throw new AttachmentError(503, "attachment_index_missing_references");
    for (const file of await readdir(this.directory)) {
      if (/^[a-f0-9-]{36}$/.test(file) && !retained.has(file))
        await rm(join(this.directory, file), { force: true });
    }
    return items;
  }

  private async save(items: Attachment[]) {
    const temporary = join(this.directory, "index.tmp");
    await writeFile(temporary, JSON.stringify(items), { mode: 0o600 });
    await rename(temporary, join(this.directory, "index.json"));
  }
  private async requests(): Promise<AttachmentRequest[]> {
    try {
      const document = JSON.parse(await readFile(join(this.directory, "requests.json"), "utf8"));
      if (!document || document.schemaVersion !== 1)
        throw new AttachmentError(503, "attachment_requests_invalid");
      const value: unknown = document.requests;
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            !item ||
            typeof item.deviceId !== "string" ||
            typeof item.sessionId !== "string" ||
            typeof item.requestId !== "string" ||
            !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
            typeof item.settled !== "boolean" ||
            !Array.isArray(item.ids) ||
            item.ids.some((id: unknown) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)),
        )
      )
        throw new AttachmentError(503, "attachment_requests_invalid");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  private async saveRequests(requests: AttachmentRequest[]) {
    const temporary = join(this.directory, "requests.tmp");
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, requests }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(this.directory, "requests.json"));
    if (process.platform !== "win32") {
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }
  private async prune(items: Attachment[]) {
    const pinned = new Set(
      (await this.requests())
        .filter((request) => !request.settled)
        .flatMap((request) => request.ids),
    );
    const stale = items.filter(
      (item) => !item.sent && !pinned.has(item.id) && Date.now() - item.createdAt >= 86_400_000,
    );
    const next = items.filter((item) => !stale.includes(item));
    if (stale.length) {
      await this.save(next);
      for (const item of stale) await rm(join(this.directory, item.id), { force: true });
    }
    return next;
  }
  static public(item: Attachment) {
    const { id, name, mime, size, version, sent, createdAt } = item;
    return { id, name, mime, size, version, sent, createdAt };
  }
  upload(
    source: AsyncIterable<Uint8Array>,
    owner: { deviceId: string; sessionId: string },
    name: string,
    mime: string,
    check: () => void,
  ) {
    return this.serialize(async () => {
      if (!name || name.length > 255 || /[\x00-\x1f\\/]/.test(name) || [".", ".."].includes(name))
        throw new AttachmentError(400, "invalid_attachment_name");
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime))
        throw new AttachmentError(400, "invalid_attachment_type");
      const items = await this.prune(await this.load());
      const used = items.reduce((sum, item) => sum + item.size, 0);
      const id = randomUUID();
      const path = join(this.directory, id);
      const handle = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        for await (const chunk of source) {
          check();
          size += chunk.byteLength;
          if (size > FILE_LIMIT) throw new AttachmentError(413, "attachment_too_large");
          if (used + size > STORE_LIMIT) throw new AttachmentError(507, "attachment_storage_full");
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        check();
        if (!size) throw new AttachmentError(400, "attachment_empty");
        await handle.sync();
        await handle.close();
        const item: Attachment = {
          id,
          name,
          mime,
          size,
          version: hash.digest("hex"),
          ...owner,
          createdAt: Date.now(),
          sent: false,
        };
        await this.save([...items, item]);
        return AttachmentStore.public(item);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true });
        throw error;
      }
    });
  }
  list(deviceId: string, sessionId: string) {
    return this.serialize(async () =>
      (await this.prune(await this.load()))
        .filter((item) => item.deviceId === deviceId && item.sessionId === sessionId)
        .map(AttachmentStore.public),
    );
  }
  remove(deviceId: string, sessionId: string, id: string, version: string) {
    return this.serialize(async () => {
      const items = await this.load();
      const item = items.find(
        (item) =>
          item.id === id &&
          item.deviceId === deviceId &&
          item.sessionId === sessionId &&
          item.version === version,
      );
      if (!item) throw new AttachmentError(404, "attachment_not_found");
      if ((await this.requests()).some((request) => !request.settled && request.ids.includes(id)))
        throw new AttachmentError(409, "attachment_in_use");
      await this.save(items.filter((candidate) => candidate !== item));
      await rm(join(this.directory, item.id), { force: true });
    });
  }
  /**
   * A deleted conversation takes its uploads with it, sent or not, from every device. Its
   * request records go first: a manifest never names a file the index no longer has.
   */
  removeSession(sessionId: string) {
    return this.serialize(async () => {
      const items = await this.load();
      const requests = await this.requests();
      const keptRequests = requests.filter((request) => request.sessionId !== sessionId);
      if (keptRequests.length !== requests.length) await this.saveRequests(keptRequests);
      const removed = items.filter((item) => item.sessionId === sessionId);
      if (removed.length) {
        await this.save(items.filter((item) => item.sessionId !== sessionId));
        for (const item of removed) await rm(join(this.directory, item.id), { force: true });
      }
      return removed.length;
    });
  }
  /** Mark before dispatch: unknown execution outcomes retain referenced files. */
  input(deviceId: string, sessionId: string, ids: unknown, text: string) {
    return this.prepareInput(deviceId, sessionId, ids, text, "codex");
  }
  /** Persist references before dispatch; an unknown outcome must never be settled. */
  inputForAgent(
    deviceId: string,
    sessionId: string,
    ids: unknown,
    text: string,
    agent: "claude" | "codex",
    requestId: string,
  ) {
    if (!requestId || requestId.length > 256)
      return Promise.reject(new AttachmentError(400, "invalid_attachment_request"));
    return this.prepareInput(deviceId, sessionId, ids, text, agent, requestId);
  }
  /** Host-only recovery inventory; listing alone never releases references. */
  pendingRequests(sessionId: string) {
    return this.serialize(async () =>
      (await this.requests())
        .filter((request) => request.sessionId === sessionId && !request.settled)
        .map(({ deviceId, requestId }) => ({ deviceId, requestId })),
    );
  }
  /** Validate a replay against the original input even after terminal attachment deletion. */
  verifyReplay(
    deviceId: string,
    sessionId: string,
    ids: unknown,
    text: string,
    agent: "claude" | "codex",
    requestId: string,
  ): Promise<boolean> {
    return this.serialize(async () => {
      const original = (await this.requests()).find(
        (request) =>
          request.deviceId === deviceId &&
          request.sessionId === sessionId &&
          request.requestId === requestId,
      );
      if (!original) return false;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ ids, text, agent }))
        .digest("hex");
      if (original.fingerprint !== fingerprint)
        throw new AttachmentError(409, "attachment_request_conflict");
      return true;
    });
  }
  /** The host calls this only after a known terminal result (or proven non-dispatch). */
  settle(deviceId: string, sessionId: string, requestId: string) {
    return this.serialize(async () => {
      const requests = await this.requests();
      if (
        !requests.some(
          (request) =>
            request.deviceId === deviceId &&
            request.sessionId === sessionId &&
            request.requestId === requestId &&
            !request.settled,
        )
      )
        return;
      await this.saveRequests(
        requests.map((request) =>
          request.deviceId === deviceId &&
          request.sessionId === sessionId &&
          request.requestId === requestId
            ? { ...request, settled: true }
            : request,
        ),
      );
    });
  }
  private prepareInput(
    deviceId: string,
    sessionId: string,
    ids: unknown,
    text: string,
    agent: "claude" | "codex",
    requestId?: string,
  ) {
    return this.serialize(async () => {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 10 ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw new AttachmentError(400, "invalid_attachments");
      const items = await this.prune(await this.load());
      const requests = await this.requests();
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ ids, text, agent }))
        .digest("hex");
      const existing = requestId
        ? requests.find(
            (request) =>
              request.deviceId === deviceId &&
              request.sessionId === sessionId &&
              request.requestId === requestId,
          )
        : undefined;
      if (existing && existing.fingerprint !== fingerprint)
        throw new AttachmentError(409, "attachment_request_conflict");
      if (existing?.settled) throw new AttachmentError(409, "attachment_request_settled");
      const selected = ids.map((id) =>
        items.find(
          (item) => item.id === id && item.deviceId === deviceId && item.sessionId === sessionId,
        ),
      );
      if (selected.some((item) => !item)) throw new AttachmentError(404, "attachment_not_found");
      const files = selected as Attachment[];
      if (files.reduce((sum, item) => sum + item.size, 0) > MESSAGE_LIMIT)
        throw new AttachmentError(413, "attachments_too_large");
      const input: Record<string, unknown>[] = text.trim()
        ? [agent === "claude" ? { type: "text", text } : { type: "text", text, text_elements: [] }]
        : [];
      let imageBytes = 0;
      for (const item of files) {
        const path = join(this.directory, item.id);
        const info = await lstat(path);
        if (!info.isFile() || info.size !== item.size)
          throw new AttachmentError(409, "attachment_changed");
        const canonicalPath = await realpath(path);
        if (dirname(canonicalPath) !== (await realpath(this.directory)))
          throw new AttachmentError(409, "attachment_changed");
        // Read from the validated descriptor: a symlink replacement cannot redirect the read.
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
          const opened = await handle.stat();
          if (
            !opened.isFile() ||
            opened.size !== item.size ||
            opened.ino !== info.ino ||
            opened.dev !== info.dev
          )
            throw new AttachmentError(409, "attachment_changed");
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (
          bytes.length !== item.size ||
          createHash("sha256").update(bytes).digest("hex") !== item.version
        )
          throw new AttachmentError(409, "attachment_changed");
        const image = agent === "claude" ? imageDimensions(bytes) : null;
        if (agent === "claude" && (item.mime.startsWith("image/") || image)) {
          if (
            !image ||
            image.mime !== item.mime ||
            !image.width ||
            !image.height ||
            image.width > 8000 ||
            image.height > 8000
          )
            throw new AttachmentError(400, "invalid_attachment_image");
          imageBytes += bytes.length;
          if (bytes.length > CLAUDE_IMAGE_LIMIT || imageBytes > CLAUDE_IMAGES_LIMIT)
            throw new AttachmentError(413, "claude_images_too_large");
          input.push({
            type: "image",
            source: { type: "base64", media_type: image.mime, data: bytes.toString("base64") },
          });
        } else if (
          agent === "codex" &&
          ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mime)
        )
          input.push({ type: "localImage", path: canonicalPath });
        else
          input.push({
            type: "text",
            text: `User attached file ${JSON.stringify(item.name)}: ${canonicalPath}`,
            ...(agent === "codex" ? { text_elements: [] } : {}),
          });
      }
      if (requestId && !existing)
        await this.saveRequests([
          ...requests,
          {
            deviceId,
            sessionId,
            requestId,
            fingerprint,
            ids: files.map((file) => file.id),
            settled: false,
          },
        ]);
      await this.save(items.map((item) => (files.includes(item) ? { ...item, sent: true } : item)));
      return input;
    });
  }
}
