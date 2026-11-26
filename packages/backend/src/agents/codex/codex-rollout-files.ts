import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  futimesSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlib, createZstdDecompress, zstdDecompressSync } from "node:zlib";
import { isReparseOrSymlink } from "../../native-files";

/**
 * Codex compresses the rollout of an idle thread in place: `x.jsonl` becomes
 * `x.jsonl.zst`, while the thread row may still name `x.jsonl`. Both spellings
 * hold the same transcript, and the decompressed bytes keep the original
 * offsets, so event ids and history cursors stay the same.
 */
export const COMPRESSED_ROLLOUT = ".zst";
const BLOCK_BYTES = 64 * 1024;
// A header line sits at the start; read more of the frame only when needed.
const PREFIX_STEPS = [16 * 1024, 256 * 1024, 4 * 1024 * 1024];
const MAX_PREFIX_OUTPUT = 32 * 1024 * 1024;

export function isCompressedRollout(file: string): boolean {
  return file.endsWith(COMPRESSED_ROLLOUT);
}

function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function cachedCopy(file: string, expectedSize?: number): boolean {
  try {
    const metadata = lstatSync(file);
    if (
      !metadata.isFile() ||
      isReparseOrSymlink(file, metadata) ||
      (expectedSize !== undefined && metadata.size !== expectedSize) ||
      (process.getuid && metadata.uid !== process.getuid()) ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    )
      throw new Error("TRANSCRIPT_UNREADABLE");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new Error("TRANSCRIPT_UNREADABLE");
  }
}

/**
 * The recorded rollout, or its compressed sibling when only that exists.
 * Readers still apply their own regular-file and symlink checks.
 */
export function resolveRollout(recorded: string): string {
  if (isCompressedRollout(recorded) || exists(recorded)) return recorded;
  const compressed = recorded + COMPRESSED_ROLLOUT;
  return exists(compressed) ? compressed : recorded;
}

function readFully(fd: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const size = readSync(fd, bytes, count, length - count, count);
    if (!size) break;
    count += size;
  }
  return bytes.subarray(0, count);
}

/**
 * Up to [limit] bytes from the start of an opened rollout. A compressed
 * rollout is decoded only as far as its first line needs.
 */
export function readRolloutPrefix(fd: number, file: string, limit: number): Buffer {
  if (!isCompressedRollout(file)) return readFully(fd, limit);
  const size = fstatSync(fd).size;
  for (const step of PREFIX_STEPS) {
    const input = readFully(fd, Math.min(step, size));
    const decode = (length: number) =>
      zstdDecompressSync(input.subarray(0, length), {
        finishFlush: zlib.ZSTD_e_continue,
        maxOutputLength: MAX_PREFIX_OUTPUT,
      });
    let output: Buffer;
    try {
      output = decode(input.length);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE"))
        throw error;
      // A small compressed prefix can contain a large history after a valid
      // short header. Find enough input for the header without decoding that tail.
      let low = 0,
        high = input.length;
      while (low + 1 < high) {
        const length = Math.floor((low + high) / 2);
        try {
          output = decode(length);
          if (output.length >= limit || output.includes(10))
            return output.subarray(0, Math.min(output.length, limit));
          low = length;
        } catch (failure) {
          if (
            !(
              failure instanceof Error &&
              "code" in failure &&
              failure.code === "ERR_BUFFER_TOO_LARGE"
            )
          )
            throw failure;
          high = length;
        }
      }
      return Buffer.alloc(0);
    }
    if (output.length >= limit || output.includes(10) || input.length >= size)
      return output.subarray(0, Math.min(output.length, limit));
  }
  return Buffer.alloc(0);
}

/**
 * The decompressed bytes of an opened compressed rollout. The caller alone
 * owns and closes [fd]; [open] turns false first, so a late read by the
 * stream never reaches a descriptor number another request reused.
 */
export function decompressedChunks(fd: number, size: number, open: () => boolean): Readable {
  function* compressed() {
    let position = 0;
    while (position < size) {
      if (!open()) return;
      const chunk = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, size - position));
      const length = readSync(fd, chunk, 0, chunk.length, position);
      if (!length) throw new Error(REMOTE_ERROR_CODES.historySourceChanged);
      position += length;
      yield chunk.subarray(0, length);
    }
  }
  const source = Readable.from(compressed(), { objectMode: false }),
    decompressor = createZstdDecompress();
  // pipe() does not forward a failed read; the reader must see it.
  source.once("error", (error) => decompressor.destroy(error));
  return source.pipe(decompressor);
}

interface CacheLimits {
  /** Largest decompressed transcript kept. */
  file: number;
  /** All decompressed transcripts together. */
  total: number;
  /** Files used this recently stay, so open history cursors keep working. */
  recentMs: number;
}

const DEFAULT_LIMITS: CacheLimits = {
  file: 2 * 1024 ** 3,
  total: 4 * 1024 ** 3,
  recentMs: 15 * 60 * 1000,
};

/**
 * Private decompressed copies of compressed rollouts for readers that seek,
 * such as reverse history pages. Each copy is keyed by the compressed file's
 * identity, written once and evicted least recently used first.
 */
export class RolloutCache {
  #directory: string | null = null;
  #pending = new Map<string, Promise<string>>();
  constructor(
    readonly root: string = tmpdir(),
    readonly limits: CacheLimits = DEFAULT_LIMITS,
  ) {}

  /** [file] itself, or a decompressed copy when it is a compressed rollout. */
  async plain(file: string): Promise<string> {
    if (!isCompressedRollout(file)) return file;
    let fd: number;
    try {
      const metadata = lstatSync(file);
      if (!metadata.isFile() || isReparseOrSymlink(file, metadata)) throw new Error();
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new Error("TRANSCRIPT_UNREADABLE");
    }
    let owned = true;
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) throw new Error("TRANSCRIPT_UNREADABLE");
      const key = createHash("sha256")
        .update(`${file}\0${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`)
        .digest("hex")
        .slice(0, 40);
      const target = path.join(this.#cacheDirectory(), `${key}.jsonl`);
      if (cachedCopy(target)) {
        this.#touch(target);
        return target;
      }
      let pending = this.#pending.get(key);
      if (!pending) {
        owned = false;
        pending = this.#decompress(fd, Number(before.size), before, target).finally(() =>
          this.#pending.delete(key),
        );
        this.#pending.set(key, pending);
      }
      return await pending;
    } finally {
      if (owned) closeSync(fd);
    }
  }

  async #decompress(
    fd: number,
    size: number,
    before: BigIntStats,
    target: string,
  ): Promise<string> {
    const partial = `${target}.${randomUUID()}.partial`;
    let reading = true;
    try {
      let written = 0;
      const limit = this.limits.file;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          written += chunk.length;
          // An existing remote code: the copy cannot be read, with the reason here.
          done(
            written > limit
              ? new Error("TRANSCRIPT_UNREADABLE: decompressed rollout exceeds the cache limit")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        decompressedChunks(fd, size, () => reading),
        counter,
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      try {
        // Several backend processes share this cache. Publish the completed
        // inode once; replacing a winning copy would invalidate its cursors.
        linkSync(partial, target);
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
          !cachedCopy(target, written)
        )
          throw error;
      }
      rmSync(partial, { force: true });
      this.#touch(target);
      this.#evict(target);
      return target;
    } catch (error) {
      rmSync(partial, { force: true });
      throw error instanceof Error && error.message.startsWith("TRANSCRIPT_")
        ? error
        : new Error("TRANSCRIPT_UNREADABLE");
    } finally {
      reading = false;
      closeSync(fd);
    }
  }

  #cacheDirectory(): string {
    if (this.#directory) return this.#directory;
    const directory = path.join(
      this.root,
      `agentkib-codex-rollouts-${process.getuid?.() ?? "user"}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    // Decompressed transcripts are private; never follow a planted link.
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (process.getuid && metadata.uid !== process.getuid()) ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    )
      throw new Error("TRANSCRIPT_UNREADABLE");
    this.#directory = directory;
    return directory;
  }

  #touch(file: string): void {
    // Keep the transcript's nanosecond mtime stable for snapshot-bound cursors.
    // A separate marker also lets other backend processes observe recent use.
    const marker = `${file}.used`;
    if (exists(marker) && isReparseOrSymlink(marker)) throw new Error("TRANSCRIPT_UNREADABLE");
    const fd = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error("TRANSCRIPT_UNREADABLE");
      const now = new Date();
      futimesSync(fd, now, now);
    } finally {
      closeSync(fd);
    }
  }

  #evict(keep: string): void {
    const directory = this.#cacheDirectory(),
      now = Date.now();
    const files = readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => {
        const file = path.join(directory, name);
        try {
          const metadata = lstatSync(file);
          if (!metadata.isFile()) return [];
          let used = metadata.mtimeMs;
          try {
            const marker = lstatSync(`${file}.used`);
            if (marker.isFile() && !isReparseOrSymlink(`${file}.used`, marker))
              used = marker.mtimeMs;
          } catch {}
          return [{ file, size: metadata.size, used }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.used - b.used);
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of files) {
      if (total <= this.limits.total) break;
      if (entry.file === keep || now - entry.used < this.limits.recentMs) continue;
      rmSync(entry.file, { force: true });
      rmSync(`${entry.file}.used`, { force: true });
      total -= entry.size;
    }
  }
}

/** Shared by history pages and documents, so one copy serves both. */
export const codexRollouts = new RolloutCache();
