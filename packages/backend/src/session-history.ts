import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import { pathIdentity, isDirectory } from "./paths";
import { isReparseOrSymlink } from "./native-files";
import { sessionWorkspaceRoot, type NativeSession } from "./session-store";
import { timestamp } from "./timestamps";
import { compareTimes, compareUtf8 } from "./workspaces";
export const MAX_DISCOVERY_FILES = 20_000;
export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export interface NativeHistorySource {
  session: NativeSession;
  transcript: string;
  cwd: string | null;
}
export function stableNativeRef(kind: string, parts: string[]): string {
  return `${kind}-v1-${createHash("sha256")
    .update([kind, ...parts].join("\0"))
    .digest("hex")}`;
}
export function jsonTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    try {
      return timestamp(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    try {
      return timestamp(new Date(Math.abs(value) >= 1e10 ? value : value * 1000).toISOString());
    } catch {}
  }
  return null;
}
export function belongsToWorkspace(
  cwd: string,
  workspace: string,
  home: string | null = homedir(),
): boolean {
  const a = sessionWorkspaceRoot(cwd, home),
    b = sessionWorkspaceRoot(workspace, home);
  return a !== null && b !== null && pathIdentity(a) === pathIdentity(b);
}
export function readableHistory(file: string): boolean {
  let fd: number | undefined;
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || isReparseOrSymlink(file, metadata)) return false;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return fstatSync(fd).isFile();
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function historyOrder(a: NativeHistorySource, b: NativeHistorySource): number {
  return (
    (b.session.updated_at && a.session.updated_at
      ? compareTimes(b.session.updated_at, a.session.updated_at)
      : b.session.updated_at
        ? 1
        : a.session.updated_at
          ? -1
          : 0) || compareUtf8(b.session.native_ref, a.session.native_ref)
  );
}
/** Metadata providers only inspect bounded transcript headers and tails. */
export function readHeadTail(file: string): { head: string[]; tail: string[] } {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
    throw new Error("History source must be a regular file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new Error("History source must be a regular file");
    const read = (offset: number, limit: number) => {
      const bytes = Buffer.allocUnsafe(Math.min(limit, Math.max(0, metadata.size - offset)));
      let count = 0;
      while (count < bytes.length) {
        const size = readSync(fd, bytes, count, bytes.length - count, offset + count);
        if (!size) break;
        count += size;
      }
      return bytes.subarray(0, count);
    };
    const head = read(0, MAX_METADATA_BYTES);
    let tail = read(Math.max(0, metadata.size - 512 * 1024), 512 * 1024);
    if (metadata.size > 512 * 1024) {
      const newline = tail.indexOf(10);
      if (newline >= 0) tail = tail.subarray(newline + 1);
    }
    const lines = (bytes: Buffer) => {
      const text = bytes.toString("utf8"),
        values = text.split(/\r?\n/);
      if (!text || text.endsWith("\n")) values.pop();
      return values;
    };
    return { head: lines(head).slice(0, 64), tail: lines(tail).slice(-32) };
  } finally {
    closeSync(fd);
  }
}
/** Count directories and ordinary entries as WalkDir does, before reading any metadata. */
export function scanHistory(
  root: string,
  depth: number,
  budget: { visited: number; incomplete: boolean },
  visit: (file: string) => void,
): void {
  if (!isDirectory(root)) return;
  const walk = (file: string, level: number) => {
    if (budget.visited >= MAX_DISCOVERY_FILES) {
      budget.incomplete = true;
      return;
    }
    try {
      const metadata = lstatSync(file);
      if (isReparseOrSymlink(file, metadata)) return;
      budget.visited++;
      if (metadata.isFile()) visit(file);
      else if (metadata.isDirectory() && level < depth) {
        const directory = opendirSync(file);
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            walk(path.join(file, entry.name), level + 1);
            if (budget.visited >= MAX_DISCOVERY_FILES) {
              // A limit is incomplete only if the iterator has another entry.
              if (directory.readSync()) budget.incomplete = true;
              break;
            }
          }
        } finally {
          directory.closeSync();
        }
      }
    } catch {
      budget.incomplete = true;
    }
  };
  walk(root, 0);
}
