import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function privatePath(value: string, directory = false): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error("unsafe-Claude-bridge-path");
  for (let current = value; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("unsafe-Claude-bridge-path");
    if (path.dirname(current) === current) break;
  }
  if (directory) {
    mkdirSync(value, { recursive: true, mode: 0o700 });
    const stat = lstatSync(value);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("unsafe-Claude-bridge-owner");
    chmodSync(value, 0o700);
  }
}
export function privateJson(file: string, value: unknown): void {
  privatePath(path.dirname(file), true);
  privatePath(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Retain the write error. No cleanup runs after a successful atomic replacement.
    }
    throw error;
  }
}
