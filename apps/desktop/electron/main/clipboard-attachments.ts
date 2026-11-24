import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_ATTACHMENT_LIMITS } from "@agentkib/runtime-protocol";
import { imageDimensions } from "./web/attachment-images";

type ClipboardUriItem = {
  readonly types: string[];
  getType(type: "text/uri-list"): Promise<Blob | Electron.ClipboardBookmark>;
};

export type ClipboardAttachment = { name: string; mime: string; bytes: Uint8Array };

const URI_LIST_LIMIT = 128 * 1024;

async function readClipboardFile(file: string, remaining: number): Promise<ClipboardAttachment> {
  const listed = await lstat(file);
  const maximum = Math.min(SESSION_ATTACHMENT_LIMITS.fileBytes, remaining);
  if (!listed.isFile() || listed.size <= 0 || listed.size > maximum)
    throw new Error("invalid-clipboard-attachment");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (
      !current.isFile() ||
      current.size !== listed.size ||
      current.dev !== listed.dev ||
      current.ino !== listed.ino
    )
      throw new Error("invalid-clipboard-attachment");
    const bytes = Buffer.allocUnsafe(current.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== current.size) throw new Error("invalid-clipboard-attachment");
    const data = bytes.subarray(0, offset);
    return {
      name: path.basename(file),
      mime: imageDimensions(data)?.mime ?? "application/octet-stream",
      bytes: data,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Electron maps the native file-reference pasteboard to text/uri-list. A textual
 * path pasted into the web view cannot select a file here.
 */
export async function readClipboardAttachments(
  items: readonly ClipboardUriItem[],
): Promise<ClipboardAttachment[] | undefined> {
  const paths = new Set<string>();
  let sawFiles = false;
  try {
    for (const item of items) {
      if (!item.types.includes("text/uri-list")) continue;
      const list = await item.getType("text/uri-list");
      if (!(list instanceof Blob) || list.size > URI_LIST_LIMIT) return [];
      for (const line of (await list.text()).split(/\r?\n/)) {
        const uri = line.trim();
        if (!/^file:/i.test(uri)) continue;
        sawFiles = true;
        const url = new URL(uri);
        if ((url.hostname && url.hostname !== "localhost") || url.search || url.hash) return [];
        const file = fileURLToPath(url);
        if (/^\/(?:net|network)(?:\/|$)/i.test(file)) return [];
        paths.add(file);
        if (paths.size > SESSION_ATTACHMENT_LIMITS.count) return [];
      }
    }
    if (!sawFiles) return undefined;
    const files: ClipboardAttachment[] = [];
    let remaining: number = SESSION_ATTACHMENT_LIMITS.messageBytes;
    for (const file of paths) {
      const item = await readClipboardFile(file, remaining);
      remaining -= item.bytes.byteLength;
      files.push(item);
    }
    return files;
  } catch {
    return [];
  }
}
