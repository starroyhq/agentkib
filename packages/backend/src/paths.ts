import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function canonicalize(value: string): string {
  return stripVerbatim(realpathSync.native(value));
}

export function pathIdentity(value: string): string {
  let resolved = stripVerbatim(value);
  try {
    resolved = canonicalize(value);
  } catch {
    if (process.platform === "win32") {
      // Match Rust's missing-path handling for removed children below junctions or 8.3 aliases.
      try {
        if (value.split(/[\\/]/).includes("..")) throw new Error("Parent component");
        let ancestor = stripVerbatim(value);
        const suffix: string[] = [];
        while (!exists(ancestor)) {
          const parent = path.dirname(ancestor);
          if (parent === ancestor || !path.basename(ancestor)) throw new Error("Missing ancestor");
          suffix.unshift(path.basename(ancestor));
          ancestor = parent;
        }
        resolved = path.join(canonicalize(ancestor), ...suffix);
      } catch {
        // Retain the original spelling when an existing ancestor cannot be resolved.
      }
    }
  }
  if (process.platform === "win32") {
    resolved = resolved.replaceAll("/", "\\").toLowerCase();
    while (resolved.length > 1 && resolved.endsWith("\\") && !/^[a-z]:\\$/.test(resolved))
      resolved = resolved.slice(0, -1);
  } else {
    while (resolved.length > 1 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
  }
  return resolved;
}

export function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function isProbeWorkspace(value: string): boolean {
  try {
    return lstatSync(path.join(value, ".codexbar-session-id")).isFile();
  } catch {
    return false;
  }
}

function exists(value: string): boolean {
  try {
    statSync(value);
    return true;
  } catch {
    return false;
  }
}

function stripVerbatim(value: string): string {
  if (process.platform !== "win32") return value;
  return value.startsWith("\\\\?\\UNC\\")
    ? `\\\\${value.slice(8)}`
    : value.startsWith("\\\\?\\")
      ? value.slice(4)
      : value;
}
