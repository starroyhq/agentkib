import { isReparseOrSymlink } from "./native-files";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { canonicalize, pathIdentity } from "./paths";
export function exists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
export function isFile(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch {
    return false;
  }
}
export function safeFile(value: string): boolean {
  try {
    return lstatSync(value).isFile();
  } catch {
    return false;
  }
}
export function within(value: string, root: string): boolean {
  const a = pathIdentity(value),
    b = pathIdentity(root);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
export function safeAncestors(value: string, root: string): boolean {
  const resolved = path.resolve(value),
    base = path.resolve(root);
  if (!withinLexical(resolved, base)) return false;
  let current = resolved;
  while (current !== base) {
    try {
      if (isReparseOrSymlink(current)) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    current = path.dirname(current);
  }
  try {
    return !isReparseOrSymlink(base);
  } catch {
    return false;
  }
}
export function withinLexical(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
export function readBytes(value: string, limit: number, regular = true): Buffer {
  const metadata = regular ? lstatSync(value) : statSync(value);
  if (regular && isReparseOrSymlink(value, metadata))
    throw new Error(`${value} must be a regular file`);
  if (!metadata.isFile()) throw new Error(`${value} must be a regular file`);
  if (metadata.size > limit) throw new Error(`${value} exceeds the ${limit} byte read limit`);
  const fd = openSync(value, constants.O_RDONLY | (regular ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Input must be a regular file");
    const chunks: Buffer[] = [];
    let count = 0;
    while (count <= limit) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - count));
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      count += size;
      if (count > limit) throw new Error(`${value} exceeds the ${limit} byte read limit`);
      chunks.push(chunk.subarray(0, size));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}
export function readText(value: string, limit = 1024 * 1024, regular = true): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readBytes(value, limit, regular),
  );
}
export function maybeText(value: string, limit = 1024 * 1024): string | null {
  try {
    return readText(value, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function walk(
  root: string,
  depth: number,
  include?: (value: string, directory: boolean) => boolean,
  strict = false,
): string[] {
  const result: string[] = [];
  const visit = (directory: string, level: number) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (strict) throw error;
      return;
    }
    for (const entry of entries) {
      const value = path.join(directory, entry.name);
      try {
        if (isReparseOrSymlink(value, entry)) continue;
      } catch (error) {
        if (strict) throw error;
        continue;
      }
      if (include && !include(value, entry.isDirectory())) continue;
      if (entry.isDirectory()) visit(value, level + 1);
      else if (entry.isFile()) result.push(value);
    }
  };
  try {
    if (isReparseOrSymlink(root)) return [];
  } catch (error) {
    if (strict) throw error;
    return [];
  }
  visit(root, 1);
  return result;
}
export function relativePath(value: string, label = "Path"): void {
  if (
    !value.trim() ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    (process.platform === "win32" ? value.split(/[\\/]/) : value.split("/")).includes("..")
  )
    throw new Error(`${label} must be a relative path inside the project: ${value}`);
}
export function canonicalProject(value: string): string {
  const root = canonicalize(value);
  if (!statSync(root).isDirectory()) throw new Error("Project must be a directory");
  return root;
}
