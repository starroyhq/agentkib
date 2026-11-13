import { statSync } from "node:fs";
import { Commands } from "./commands";
import { codexExecutables } from "./codex-executable";

export const MINIMUM_CODEX_WRITER_VERSION = "0.147.0";

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RELEASE_IN_TEXT =
  /(?:^|[\s/v])((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?:\+[0-9A-Za-z.-]+)?(?=$|[\s,;()])/;

/**
 * The release a `codex --version` line names: "codex-cli 0.167.0", "codex 0.147.0" and later
 * spellings that still name Codex and a release. Null when the first line names neither.
 */
export function codexCliVersion(output: string): string | null {
  const line = output.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!/codex/i.test(line)) return null;
  const release = RELEASE_IN_TEXT.exec(line)?.[1];
  return release && RELEASE.test(release) ? release : null;
}

/**
 * The release an app-server names in its `initialize` reply, whose user agent starts with
 * "<client>/<release>": "agentkib/0.167.0 (Mac OS 27.0.1; arm64) …".
 */
export function codexServerVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== "string") return null;
  const release = /^[^/\s]+\/(\S+)/.exec(userAgent)?.[1];
  return release && RELEASE.test(release) ? release : null;
}

/** Whether a Codex release keeps the thread writer lock AgentKib relies on. */
export function codexReleaseSupportsWriterLock(release: string): boolean {
  const match = RELEASE.exec(release);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  if (!parts.every((part) => Number.isSafeInteger(part))) return false;
  const minimum = MINIMUM_CODEX_WRITER_VERSION.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (parts[index] !== minimum[index]) return parts[index]! > minimum[index]!;
  }
  // A prerelease of the first supported release is still older than that release.
  return !match[4];
}

export function codexVersionSupportsWriterLock(output: string): boolean {
  const release = codexCliVersion(output);
  return !!release && codexReleaseSupportsWriterLock(release);
}

export type CodexRuntimeCheck = {
  /** The CLI AgentKib runs; set whenever one was found, also one it cannot write with. */
  executable?: string;
  reason: string | null;
};

type Probe = "supported" | "too-old" | "unknown" | "failed";

/**
 * Picks the Codex CLI AgentKib writes with from every copy on this computer (see
 * `codexExecutables`): the first whose version keeps the writer lock. One that names no
 * release AgentKib can read is still tried when nothing else qualifies, since every release
 * without the lock printed "codex-cli X.Y.Z"; the runner then checks the release the
 * app-server reports. Only when no copy can be used does Codex stay read-only, with the
 * first copy's reason.
 */
export class CodexRuntimePreflight {
  #commands = new Commands();
  #cached?: {
    identity: string;
    checkedAt: number;
    result: Promise<CodexRuntimeCheck>;
  };
  #settled?: CodexRuntimeCheck;

  constructor(
    readonly environment: NodeJS.ProcessEnv,
    readonly candidates: (environment: NodeJS.ProcessEnv) => string[] = codexExecutables,
  ) {}

  close(): void {
    this.#commands.close();
  }

  /** The CLI the last finished check chose to write with, while it is still there. */
  preferred(): string | null {
    const executable = this.#settled?.reason === null ? this.#settled.executable : undefined;
    if (!executable) return null;
    try {
      return statSync(executable).isFile() ? executable : null;
    } catch {
      return null;
    }
  }

  check(): Promise<CodexRuntimeCheck> {
    const found: string[] = [];
    const identities: string[] = [];
    for (const executable of this.candidates(this.environment)) {
      try {
        const info = statSync(executable);
        found.push(executable);
        identities.push(`${executable}:${info.mtimeMs}:${info.size}`);
      } catch {}
    }
    if (!found.length) {
      this.#settled = undefined;
      return Promise.resolve({ reason: "codex-cli-unavailable" });
    }
    const identity = identities.join("\n");
    if (this.#cached?.identity === identity && Date.now() - this.#cached.checkedAt < 30_000)
      return this.#cached.result;
    const result = this.#choose(found);
    this.#cached = { identity, checkedAt: Date.now(), result };
    void result.then((value) => {
      if (this.#cached?.result === result) this.#settled = value;
    });
    return result;
  }

  async #choose(executables: string[]): Promise<CodexRuntimeCheck> {
    let unreadable: string | undefined;
    let first: CodexRuntimeCheck | undefined;
    for (const executable of executables) {
      const probe = await this.#probe(executable);
      if (probe === "supported") return { executable, reason: null };
      if (probe === "unknown") unreadable ??= executable;
      else
        first ??= {
          executable,
          reason:
            probe === "too-old" ? "codex-cli-version-too-old" : "codex-cli-version-unavailable",
        };
    }
    return unreadable ? { executable: unreadable, reason: null } : first!;
  }

  async #probe(executable: string): Promise<Probe> {
    try {
      const output = await this.#commands.run(executable, ["--version"], {
        env: this.environment,
        limit: 512,
        timeout: 5000,
        strictOutput: true,
      });
      const release = codexCliVersion(output.bytes.toString("utf8"));
      if (!release) return "unknown";
      return codexReleaseSupportsWriterLock(release) ? "supported" : "too-old";
    } catch {
      return "failed";
    }
  }
}
