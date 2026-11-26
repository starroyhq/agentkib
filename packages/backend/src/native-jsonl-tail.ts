import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isReparseOrSymlink } from "./native-files";

const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/** A bounded snapshot of complete native records, verified against file replacement. */
export function verifiedNativeJsonlTail(file: string, requireComplete = false): string[] {
  const expected = lstatSync(file);
  if (!expected.isFile() || isReparseOrSymlink(file, expected)) return [];
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.ino !== expected.ino || before.dev !== expected.dev) return [];
    const start = Math.max(0, before.size - MAX_HISTORY_BYTES);
    const bytes = Buffer.allocUnsafe(before.size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, start + offset);
      if (!count) return [];
      offset += count;
    }
    const current = lstatSync(file);
    if (
      !current.isFile() ||
      isReparseOrSymlink(file, current) ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs
    )
      return [];
    const from = start ? bytes.indexOf(10) + 1 : 0;
    const through = bytes.lastIndexOf(10);
    return (start && from === 0) ||
      through < from ||
      (requireComplete && through !== bytes.length - 1)
      ? []
      : bytes.subarray(from, through).toString("utf8").split("\n");
  } finally {
    closeSync(fd);
  }
}
