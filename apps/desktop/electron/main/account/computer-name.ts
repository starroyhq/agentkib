import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

/** Same limit and cleanup rules as the account broker, so a detected name is never rejected. */
export const COMPUTER_NAME_LIMIT = 64;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const codePoints = (text: string) => [...text].length;

/**
 * Whitespace collapsed, control and bidi-override characters removed, then NFC, trimmed, and cut
 * to at most 64 code points on a grapheme boundary, in the broker's order. Returns undefined when
 * nothing usable is left.
 */
export function normalizeComputerName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .slice(0, 1024)
    // In `u` mode this matches only lone surrogates, which the broker would reject.
    .replace(/[\uD800-\uDFFF]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    // After the removal, so a stripped character cannot keep a combining mark apart.
    .normalize("NFC")
    .replace(/ {2,}/g, " ")
    .trim();
  let name = "";
  for (const { segment } of graphemes.segment(clean)) {
    if (codePoints(name) + codePoints(segment) > COMPUTER_NAME_LIMIT) break;
    name += segment;
  }
  return name.trimEnd() || undefined;
}

/** Reads PRETTY_HOSTNAME from /etc/machine-info (an env-style file with optional shell quoting). */
export function prettyHostname(machineInfo: string): string | undefined {
  for (const line of machineInfo.split(/\r?\n/)) {
    const match = /^\s*PRETTY_HOSTNAME=(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) return raw.slice(1, -1);
    if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"'))
      return raw.slice(1, -1).replace(/\\(.)/g, "$1");
    return raw;
  }
  return undefined;
}

type Probe = {
  platform: NodeJS.Platform;
  hostname(): string;
  run(command: string, args: string[]): Promise<string>;
  readFile(path: string): Promise<string>;
};
const defaultProbe: Probe = {
  platform: process.platform,
  hostname,
  run: (command, args) =>
    new Promise((resolve, reject) =>
      execFile(
        command,
        args,
        { timeout: 2_000, windowsHide: true, encoding: "utf8" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    ),
  readFile: (path) => readFile(path, "utf8"),
};

/** The computer's display name, as the user sees it in system settings. Never throws. */
export async function detectComputerName(probe: Partial<Probe> = {}): Promise<string | undefined> {
  const { platform, run, hostname: host, readFile: read } = { ...defaultProbe, ...probe };
  const fallback = () => {
    try {
      return normalizeComputerName(host().replace(/\.local\.?$/i, ""));
    } catch {
      return undefined;
    }
  };
  const attempt = async (work: () => Promise<string | undefined>) => {
    try {
      return normalizeComputerName(await work());
    } catch {
      return undefined;
    }
  };
  if (platform === "darwin")
    return (await attempt(() => run("scutil", ["--get", "ComputerName"]))) ?? fallback();
  if (platform === "linux")
    return (
      (await attempt(async () => prettyHostname(await read("/etc/machine-info")))) ??
      (await attempt(() => run("hostnamectl", ["--pretty"]))) ??
      fallback()
    );
  return fallback();
}
