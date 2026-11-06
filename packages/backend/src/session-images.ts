import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isReparseOrSymlink } from "./native-files";
import type { ConversationImage, HistoryFormat } from "./session-events";

export const MAX_SESSION_IMAGE_BYTES = 8 * 1024 * 1024;
/** One large inline image may exceed the ordinary text-record limit. */
export const MAX_IMAGE_RECORD_BYTES = 12 * 1024 * 1024;
const MAX_ENCODED_BYTES = 4 * Math.ceil(MAX_SESSION_IMAGE_BYTES / 3);
const MAX_IMAGES = 32;
const MAX_REFERENCES = 4096;
const TTL = 15 * 60 * 1000;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type ImageSource =
  | { kind: "inline"; mimeType: string; data: string; name?: string }
  | { kind: "local"; path: string; name: string };
interface ImageReference {
  scope: string;
  offset: number;
  digest: string;
  sourceDigest: string;
  format: HistoryFormat;
  workspace: string;
  localRevision?: string | null;
  created: number;
  key: string;
  image: ConversationImage;
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const nameOf = (value: string) =>
  [...path.basename(value).replace(/[\p{Cc}\p{Cf}]/gu, "")].slice(0, 255).join("");

function localSource(value: unknown, workspace: string): ImageSource | null {
  if (typeof value !== "string" || !value || value.includes("\0") || value.length > 4096)
    return null;
  let filename = value;
  if (filename.startsWith("file:")) {
    try {
      filename = fileURLToPath(filename);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(filename) && !path.isAbsolute(filename)) return null;
  if (!path.isAbsolute(filename)) {
    if (!path.isAbsolute(workspace)) return null;
    filename = path.resolve(workspace, filename);
  }
  return { kind: "local", path: filename, name: nameOf(filename) };
}

function imageSource(value: unknown, workspace: string, filename?: unknown): ImageSource | null {
  // Native image_url wrappers contain one URL string, never recursive objects.
  if (record(value)) value = value.url ?? value.image_url;
  if (typeof value !== "string") return null;
  const inline = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value);
  if (!inline) return value.startsWith("data:") ? null : localSource(value, workspace);
  const mimeType = inline[1]!.toLowerCase();
  const data = inline[2]!;
  if (!MIME_TYPES.has(mimeType) || data.length > MAX_ENCODED_BYTES) return null;
  return {
    kind: "inline",
    mimeType,
    data,
    ...(typeof filename === "string" ? { name: nameOf(filename) } : {}),
  };
}

/** Only structured native attachment fields confer image-read authority. */
export function sessionImageSources(
  value: unknown,
  format: HistoryFormat,
  workspace = "",
): ImageSource[] {
  if (!record(value)) return [];
  const sources: ImageSource[] = [];
  const add = (source: ImageSource | null) => {
    if (source && sources.length < MAX_IMAGES) sources.push(source);
  };
  let content: unknown;
  if (format === "codex") {
    const payload = value.payload;
    if (!record(payload)) return [];
    if (
      value.type === "event_msg" &&
      ["user_message", "agent_message"].includes(String(payload.type))
    ) {
      if (Array.isArray(payload.images))
        for (const image of payload.images.slice(0, MAX_IMAGES)) add(imageSource(image, workspace));
      if (Array.isArray(payload.local_images))
        for (const image of payload.local_images.slice(0, MAX_IMAGES))
          add(localSource(record(image) ? image.path : image, workspace));
    } else if (
      value.type === "response_item" &&
      payload.type === "message" &&
      ["user", "assistant"].includes(String(payload.role))
    )
      content = payload.content;
  } else if (
    format === "claude-code" &&
    ["user", "assistant"].includes(String(value.type)) &&
    value.isMeta !== true &&
    value.isCompactSummary !== true &&
    record(value.message)
  )
    content = value.message.content;
  if (Array.isArray(content))
    for (const block of content.slice(0, 1024)) {
      if (!record(block)) continue;
      if (["input_image", "image"].includes(String(block.type))) {
        if (record(block.source) && block.source.type === "base64") {
          const { media_type: mimeType, data } = block.source;
          if (typeof mimeType === "string" && typeof data === "string")
            add(imageSource(`data:${mimeType};base64,${data}`, workspace, block.filename));
        } else add(imageSource(block.image_url ?? block.url, workspace, block.filename));
      } else if (["localImage", "local_image"].includes(String(block.type)))
        add(localSource(block.path, workspace));
    }
  const unique = new Map<string, ImageSource>();
  for (const source of sources) unique.set(sourceDigest(source), source);
  return [...unique.values()];
}

function sourceDigest(source: ImageSource): string {
  return digest(
    source.kind === "inline" ? `${source.mimeType}\0${source.data}` : `local\0${source.path}`,
  );
}

function revision(fd: number): string {
  const metadata = fstatSync(fd, { bigint: true });
  if (!metadata.isFile()) throw new Error("session-image-unavailable");
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}`;
}
function openRegular(filename: string): number {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || isReparseOrSymlink(filename, metadata))
    throw new Error("session-image-unavailable");
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    revision(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function localRevision(source: ImageSource): string | null | undefined {
  if (source.kind !== "local") return undefined;
  let fd: number | undefined;
  try {
    fd = openRegular(source.path);
    return revision(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function mimeOf(bytes: Buffer): string | null {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0
  )
    return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 10 &&
    ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
    bytes.readUInt16LE(6) > 0 &&
    bytes.readUInt16LE(8) > 0
  )
    return "image/gif";
  if (
    bytes.length >= 20 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" &&
    bytes.readUInt32LE(4) + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))
  )
    return "image/webp";
  return null;
}

/** Canonical base64 for one image within the size limit; any other spelling is refused. */
export function decodedSessionImage(data: string): Buffer {
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error("session-image-unsupported");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_SESSION_IMAGE_BYTES) throw new Error("session-image-too-large");
  if (bytes.toString("base64") !== data) throw new Error("session-image-unsupported");
  return bytes;
}

/** Bytes that really are a supported image, and of the type the source declared, if it did. */
export function sessionImageResult(
  data: Buffer,
  declared?: string,
): { mimeType: string; base64: string } {
  const mimeType = mimeOf(data);
  if (!mimeType || (declared !== undefined && mimeType !== declared))
    throw new Error("session-image-unsupported");
  return { mimeType, base64: data.toString("base64") };
}

function readRecord(filename: string, offset: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openRegular(filename);
    const parts: Buffer[] = [];
    let length = 0;
    while (length <= MAX_IMAGE_RECORD_BYTES) {
      const part = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_IMAGE_RECORD_BYTES + 1 - length));
      const read = readSync(fd, part, 0, part.length, offset + length);
      if (!read) return Buffer.concat(parts, length);
      const newline = part.subarray(0, read).indexOf(10);
      const count = newline < 0 ? read : newline;
      parts.push(part.subarray(0, count));
      length += count;
      if (newline >= 0) return Buffer.concat(parts, length);
    }
    throw new Error("session-image-too-large");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("session-image-")) throw error;
    throw new Error("session-image-unavailable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Opaque, short-lived references retain proof metadata, never inline image bodies. */
export class SessionImages {
  #references = new Map<string, ImageReference>();
  #keys = new Map<string, string>();
  clear() {
    this.#references.clear();
    this.#keys.clear();
  }
  register(
    scope: string,
    offset: number,
    bytes: Buffer,
    row: unknown,
    format: HistoryFormat,
    workspace = "",
  ): ConversationImage[] {
    const sources = sessionImageSources(row, format, workspace);
    if (!sources.length) return [];
    const now = performance.now();
    for (const [id, reference] of this.#references)
      if (now - reference.created >= TTL) this.#delete(id, reference);
    const images: ConversationImage[] = [];
    const proof = digest(bytes);
    for (const source of sources) {
      const fingerprint = sourceDigest(source);
      const version = localRevision(source);
      const key = digest(`${scope}\0${fingerprint}\0${version ?? ""}`);
      let id = this.#keys.get(key);
      let reference = id ? this.#references.get(id) : undefined;
      if (!id || !reference) {
        while (this.#references.size >= MAX_REFERENCES) {
          const first = this.#references.entries().next().value;
          if (first) this.#delete(...first);
        }
        id = `session-image-v1-${randomUUID()}`;
        const image: ConversationImage = {
          id,
          ...(source.kind === "inline" ? { mimeType: source.mimeType } : {}),
          ...(source.name ? { name: source.name } : {}),
        };
        reference = {
          scope,
          offset,
          digest: proof,
          sourceDigest: fingerprint,
          format,
          workspace,
          localRevision: version,
          created: now,
          key,
          image,
        };
        this.#references.set(id, reference);
        this.#keys.set(key, id);
      } else {
        // Mirrored native rows may point to the same image. Keep one visual item
        // with a proof from the row this verified page most recently observed.
        reference.offset = offset;
        reference.digest = proof;
        reference.created = now;
      }
      images.push(reference.image);
    }
    return images;
  }
  read(scope: string, filename: string, imageId: string): { mimeType: string; base64: string } {
    if (!/^session-image-v1-[a-f0-9-]{36}$/.test(imageId)) throw new Error("session-image-invalid");
    const reference = this.#references.get(imageId);
    if (!reference || reference.scope !== scope || performance.now() - reference.created >= TTL)
      throw new Error("session-image-unavailable");
    const bytes = readRecord(filename, reference.offset);
    if (digest(bytes) !== reference.digest) throw new Error("session-image-changed");
    let row: unknown;
    try {
      row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("session-image-changed");
    }
    const source = sessionImageSources(row, reference.format, reference.workspace).find(
      (candidate) => sourceDigest(candidate) === reference.sourceDigest,
    );
    if (!source) throw new Error("session-image-changed");
    let data: Buffer;
    if (source.kind === "inline") data = decodedSessionImage(source.data);
    else {
      if (reference.localRevision === null) throw new Error("session-image-unavailable");
      let fd: number | undefined;
      try {
        fd = openRegular(source.path);
        if (revision(fd) !== reference.localRevision) throw new Error("session-image-changed");
        const size = fstatSync(fd).size;
        if (size > MAX_SESSION_IMAGE_BYTES) throw new Error("session-image-too-large");
        data = Buffer.allocUnsafe(size);
        let read = 0;
        while (read < size) {
          const count = readSync(fd, data, read, size - read, read);
          if (!count) throw new Error("session-image-changed");
          read += count;
        }
        if (revision(fd) !== reference.localRevision) throw new Error("session-image-changed");
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("session-image-")) throw error;
        throw new Error("session-image-unavailable");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return sessionImageResult(data, source.kind === "inline" ? source.mimeType : undefined);
  }
  #delete(id: string, reference: ImageReference) {
    this.#references.delete(id);
    this.#keys.delete(reference.key);
  }
}
