import { REMOTE_ERROR_CODES, SESSION_ATTACHMENT_RASTER_TYPES } from "@agentkib/runtime-protocol";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import { canonicalize, lexicalPathIdentity } from "./paths";
import { MAX_SESSION_IMAGE_BYTES, sessionImageResult } from "./session-images";

/** Trusted file location and upload metadata from the host attachment manifest. */
export type SentAttachmentFile = {
  directory: string;
  filename: string;
  size: number;
  digest: string;
  mimeType: string;
  directoryIdentity?: { dev: string; ino: string };
};

function inspect(file: SentAttachmentFile, maxSize?: number) {
  const { directory, directoryIdentity, filename, size } = file;
  if (
    !path.isAbsolute(directory) ||
    !filename ||
    filename === "." ||
    filename === ".." ||
    /[/\\:]/.test(filename) ||
    filename.includes("\0") ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);

  const parent = lstatSync(directory, { bigint: true });
  if (
    !parent.isDirectory() ||
    isReparseOrSymlink(directory, parent) ||
    lexicalPathIdentity(canonicalize(directory)) !== lexicalPathIdentity(directory) ||
    (directoryIdentity &&
      (directoryIdentity.dev !== String(parent.dev) ||
        directoryIdentity.ino !== String(parent.ino)))
  )
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);

  const target = path.join(directory, filename);
  const metadata = lstatSync(target, { bigint: true });
  if (!metadata.isFile() || metadata.nlink !== 1n || isReparseOrSymlink(target, metadata))
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
  if (maxSize !== undefined && metadata.size > BigInt(maxSize))
    throw new Error(REMOTE_ERROR_CODES.sessionImageTooLarge);
  if (metadata.size !== BigInt(size)) throw new Error(REMOTE_ERROR_CODES.sessionImageChanged);
  return { target, parent, metadata };
}

const sameInode = (left: BigIntStats, right: BigIntStats) =>
  left.dev === right.dev && left.ino === right.ino;

function withAttachmentFile<T>(
  file: SentAttachmentFile,
  run: (fd: number, verify: () => void) => T,
  maxSize?: number,
): T {
  const { target, parent, metadata } = inspect(file, maxSize);
  const fd = openSync(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const matches = (current: BigIntStats) =>
      current.isFile() &&
      current.nlink === 1n &&
      sameInode(current, metadata) &&
      current.size === metadata.size &&
      current.mtimeNs === metadata.mtimeNs &&
      current.ctimeNs === metadata.ctimeNs;
    const verify = () => {
      // Recheck the directory and leaf path as well as the descriptor. A
      // swapped parent cannot cause bytes from a different inode to escape.
      const current = inspect(file, maxSize);
      if (
        !sameInode(current.parent, parent) ||
        !matches(current.metadata) ||
        !matches(fstatSync(fd, { bigint: true }))
      )
        throw new Error(REMOTE_ERROR_CODES.sessionImageChanged);
    };
    verify();
    return run(fd, verify);
  } finally {
    closeSync(fd);
  }
}

export function sentAttachmentFileAvailable(file: SentAttachmentFile): boolean {
  try {
    return withAttachmentFile(file, () => true);
  } catch {
    return false;
  }
}

export function readSentAttachmentImage(file: SentAttachmentFile): {
  mimeType: string;
  base64: string;
} {
  if (!SESSION_ATTACHMENT_RASTER_TYPES.includes(file.mimeType))
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnsupported);
  if (file.size > MAX_SESSION_IMAGE_BYTES) throw new Error(REMOTE_ERROR_CODES.sessionImageTooLarge);
  try {
    return withAttachmentFile(
      file,
      (fd, verify) => {
        const data = Buffer.allocUnsafe(file.size);
        let offset = 0;
        while (offset < data.length) {
          const count = readSync(fd, data, offset, data.length - offset, offset);
          if (!count) throw new Error(REMOTE_ERROR_CODES.sessionImageChanged);
          offset += count;
        }
        verify();
        if (createHash("sha256").update(data).digest("hex") !== file.digest)
          throw new Error(REMOTE_ERROR_CODES.sessionImageChanged);
        return sessionImageResult(data, file.mimeType);
      },
      MAX_SESSION_IMAGE_BYTES,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("session-image-")) throw error;
    throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
  }
}
