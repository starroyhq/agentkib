import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isReparseOrSymlink } from "./native-files";

export const SESSION_LOG_BLOCK_BYTES = 64 * 1024;
const MAX_CACHED_LOGS = 8;
const MAX_LOG_BLOCKS = (4 * 1024 * 1024) / SESSION_LOG_BLOCK_BYTES;
const APPEND_PROBE_BYTES = 1024;

type Block = { position: number; bytes: Buffer };
type Version = {
  stat: BigIntStats;
  blocks: Map<number, Block>;
  ready: Promise<void>;
  reads: Map<string, Promise<Buffer>>;
};

export interface SessionLogSnapshot {
  stat(): Promise<Stats>;
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  readCurrent(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export function sessionLogIdentity(stat: BigIntStats): string {
  return process.platform === "win32" && !stat.ino
    ? `${stat.dev}:${stat.birthtimeNs}`
    : `${stat.dev}:${stat.ino}`;
}

function sameVersion(first: BigIntStats, next: BigIntStats): boolean {
  return (
    first.size === next.size && first.mtimeNs === next.mtimeNs && first.ctimeNs === next.ctimeNs
  );
}

async function readBytes(fd: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await fd.read(bytes, filled, length - filled, position + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return bytes.subarray(0, filled);
}

/** One descriptor and one bounded cache per native file, across concurrent consumers. */
class SessionLog {
  users = 0;
  cached = true;
  #fd?: Promise<FileHandle>;
  #closing?: Promise<void>;
  #version?: Version;

  constructor(readonly id: string) {}

  async acquire(file: string): Promise<SessionLogSnapshot> {
    this.users++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (--this.users) return;
      const handle = this.#fd;
      this.#fd = undefined;
      this.#closing = handle?.then((fd) => fd.close()).catch(() => {});
      if (!this.cached) active.delete(this.id);
      await this.#closing;
    };
    try {
      const fd = await (this.#fd ??= (async () => {
        await this.#closing;
        return open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      })());
      const opened = await fd.stat({ bigint: true });
      if (!opened.isFile() || sessionLogIdentity(opened) !== this.id)
        throw new Error("transcript replaced while opening");
      const version = this.#select(fd, opened);
      const stat = (options?: { bigint: true }) => (options ? fd.stat(options) : fd.stat());
      return {
        stat: stat as SessionLogSnapshot["stat"],
        read: async (buffer, offset, length, position) => {
          if (released) throw new Error("transcript read after close");
          await version.ready;
          let filled = 0;
          while (filled < length) {
            const at = position + filled;
            const count = Math.min(
              length - filled,
              SESSION_LOG_BLOCK_BYTES - (at % SESSION_LOG_BLOCK_BYTES),
            );
            const part = await this.#block(fd, version, at, count);
            part.copy(buffer, offset + filled);
            filled += part.length;
            if (part.length < count) break;
          }
          return { bytesRead: filled };
        },
        readCurrent: async (buffer, offset, length, position) => {
          if (released) throw new Error("transcript read after close");
          return fd.read(buffer, offset, length, position);
        },
        close: release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  dropCache() {
    this.cached = false;
    this.#version?.blocks.clear();
    if (!this.users) active.delete(this.id);
  }

  #select(fd: FileHandle, stat: BigIntStats): Version {
    const previous = this.#version;
    if (previous && sameVersion(previous.stat, stat)) return previous;
    const version: Version = {
      stat,
      blocks: new Map(),
      reads: new Map(),
      ready: Promise.resolve(),
    };
    if (previous && stat.ctimeNs < previous.stat.ctimeNs) return version;
    this.#version = version;
    if (previous && stat.size > previous.stat.size) {
      version.ready = (async () => {
        await previous.ready;
        // A short witness at each end of the retained window distinguishes normal
        // appends from the usual truncate-and-rewrite on the same inode.
        const ordered = [...previous.blocks.values()].sort((a, b) => a.position - b.position);
        const first = ordered[0];
        const last = ordered.at(-1);
        if (!this.cached || !first || !last) return;
        const head = first.bytes.subarray(0, APPEND_PROBE_BYTES);
        const tail = last.bytes.subarray(-APPEND_PROBE_BYTES);
        const [headNow, tailNow] = await Promise.all([
          readBytes(fd, first.position, head.length),
          readBytes(fd, last.position + last.bytes.length - tail.length, tail.length),
        ]);
        if (head.equals(headNow) && tail.equals(tailNow)) {
          for (const [key, block] of previous.blocks) version.blocks.set(key, block);
        }
      })().catch(() => {
        version.blocks.clear();
      });
    }
    return version;
  }

  async #block(
    fd: FileHandle,
    version: Version,
    position: number,
    length: number,
  ): Promise<Buffer> {
    // Appends racing this read can be observed by its caller, but never seed
    // this version with bytes that weren't in its opening snapshot.
    if (BigInt(position + length) > version.stat.size) return readBytes(fd, position, length);
    const key = Math.floor(position / SESSION_LOG_BLOCK_BYTES);
    const cached = version.blocks.get(key);
    if (cached && cached.position <= position) {
      const index = position - cached.position;
      if (index + length <= cached.bytes.length)
        return cached.bytes.subarray(index, index + length);
    }
    const request = `${position}:${length}`;
    const active = version.reads.get(request);
    if (active) return active;
    const loading = (async () => {
      const retained = cached?.position === position ? cached.bytes : undefined;
      const bytes = retained
        ? Buffer.concat([
            retained,
            await readBytes(fd, position + retained.length, length - retained.length),
          ])
        : await readBytes(fd, position, length);
      if (this.cached && bytes.length === length && this.#version === version) {
        version.blocks.delete(key);
        if (version.blocks.size >= MAX_LOG_BLOCKS)
          version.blocks.delete(version.blocks.keys().next().value!);
        version.blocks.set(key, { position, bytes });
      }
      return bytes;
    })();
    version.reads.set(request, loading);
    try {
      return await loading;
    } finally {
      version.reads.delete(request);
    }
  }
}

const active = new Map<string, SessionLog>();
const cached = new Map<string, SessionLog>();

export async function openSessionLog(file: string): Promise<SessionLogSnapshot> {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || isReparseOrSymlink(file, info)) throw new Error("unsafe transcript source");
  const id = sessionLogIdentity(info);
  const reader = active.get(id) ?? new SessionLog(id);
  active.set(id, reader);
  cached.delete(id);
  if (cached.size >= MAX_CACHED_LOGS) {
    const [key, oldest] = cached.entries().next().value!;
    cached.delete(key);
    oldest.dropCache();
  }
  reader.cached = true;
  cached.set(id, reader);
  return reader.acquire(file);
}
