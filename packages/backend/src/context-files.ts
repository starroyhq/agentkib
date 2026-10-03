import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { canonicalize } from "./paths";
import { isFile, within } from "./files";
import { compareUtf8 } from "./workspaces";
export const FILE_CHARS = 128 * 1024,
  TOTAL_CHARS = 512 * 1024;
export function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split(/\r?\n/);
  if (text.endsWith("\n")) result.pop();
  return result;
}
export function decodePrefix(bytes: Buffer, allowPartial: boolean): string {
  const decode = (value: Buffer) =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  try {
    return decode(bytes);
  } catch (error) {
    if (allowPartial) {
      let start = bytes.length - 1;
      while (start >= 0 && bytes.length - start <= 3 && (bytes[start]! & 0xc0) === 0x80) start--;
      const lead = bytes[start] ?? 0,
        length =
          lead >= 0xc2 && lead <= 0xdf
            ? 2
            : lead >= 0xe0 && lead <= 0xef
              ? 3
              : lead >= 0xf0 && lead <= 0xf4
                ? 4
                : 0,
        available = bytes.length - start;
      const second = bytes[start + 1];
      const validSecond =
        second === undefined ||
        ((lead !== 0xe0 || second >= 0xa0) &&
          (lead !== 0xed || second <= 0x9f) &&
          (lead !== 0xf0 || second >= 0x90) &&
          (lead !== 0xf4 || second <= 0x8f));
      if (length > available && validSecond) return decode(bytes.subarray(0, start));
    }
    throw error;
  }
}
export function prefix(file: string, limit: number, regular = false): Buffer {
  if (regular && !lstatSync(file).isFile())
    throw new Error("Instruction source must be a regular file");
  const fd = openSync(file, constants.O_RDONLY | (regular ? (constants.O_NOFOLLOW ?? 0) : 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Instruction source must be a regular file");
    const bytes = Buffer.allocUnsafe(limit);
    let size = 0;
    while (size < limit) {
      const count = readSync(fd, bytes, size, limit - size, null);
      if (!count) break;
      size += count;
    }
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function readContext(file: string): { content: string; truncated: boolean } {
  const bytes = prefix(file, FILE_CHARS * 4 + 1),
    exceeded = bytes.length > FILE_CHARS * 4,
    raw = decodePrefix(exceeded ? bytes.subarray(0, FILE_CHARS * 4) : bytes, exceeded),
    chars = [...raw];
  return {
    content: chars.slice(0, FILE_CHARS).join(""),
    truncated: exceeded || chars.length > FILE_CHARS,
  };
}
export interface Budget {
  remaining: number;
}
export function budgetWarning(warnings: string[]): void {
  const text = `Resolved project instructions exceed ${TOTAL_CHARS} characters and were truncated for preview`;
  if (!warnings.includes(text)) warnings.push(text);
}
export function append(value: string, budget: Budget, warnings: string[]): string {
  const chars = [...value],
    chunk = chars.slice(0, budget.remaining).join("");
  if (chars.length > budget.remaining) budgetWarning(warnings);
  budget.remaining = Math.max(0, budget.remaining - chars.length);
  return chunk;
}
export function loadImports(
  file: string,
  root: string,
  budget: Budget,
  warnings: string[],
  visited = new Set<string>(),
  depth = 0,
): string {
  if (depth > 5) throw new Error(`Instruction import depth exceeds 5: ${file}`);
  const canonical = canonicalize(file);
  if (!within(canonical, root))
    throw new Error(`Refusing to import instructions outside the project: ${file}`);
  if (visited.has(canonical)) throw new Error(`Circular instruction import detected: ${file}`);
  visited.add(canonical);
  let loaded: ReturnType<typeof readContext>;
  try {
    loaded = readContext(canonical);
  } catch {
    throw new Error(`Could not read ${file}`);
  }
  if (loaded.truncated)
    warnings.push(
      `Instruction file exceeds ${FILE_CHARS} characters and was truncated for preview: ${file}`,
    );
  let output = "";
  for (const line of lines(loaded.content)) {
    if (!budget.remaining) {
      budgetWarning(warnings);
      break;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("@") && !trimmed.slice(1).includes(" ")) {
      const name = trimmed.slice(1);
      const imported = path.isAbsolute(name)
        ? name
        : `${path.dirname(canonical)}${path.sep}${name}`;
      if (isFile(imported)) {
        output +=
          loadImports(imported, root, budget, warnings, visited, depth + 1) +
          append("\n", budget, warnings);
        continue;
      }
      warnings.push(`Imported file is missing: ${imported} (source: ${canonical})`);
    }
    output += append(line, budget, warnings) + append("\n", budget, warnings);
  }
  visited.delete(canonical);
  return output;
}
export function entries(root: string): string[] {
  try {
    return readdirSync(root).map((name) => path.join(root, name));
  } catch {
    return [];
  }
}
export function sortedFiles(root: string, extension: string): string[] {
  return entries(root)
    .filter((file) => path.extname(file) === extension)
    .sort(compareUtf8);
}
export function firstExisting(directory: string, names: string[]): string | null {
  return names.map((name) => path.join(directory, name)).find(isFile) ?? null;
}
export function cursorAlways(file: string): boolean {
  try {
    const content = lines(readContext(file).content);
    if (content.shift()?.trim() !== "---") return false;
    for (const line of content) {
      if (line.trim() === "---") break;
      const colon = line.indexOf(":");
      if (
        colon >= 0 &&
        line.slice(0, colon).trim() === "alwaysApply" &&
        line
          .slice(colon + 1)
          .trim()
          .toLowerCase() === "true"
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
