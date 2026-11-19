import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Commands } from "./commands";
import { resolveCommand } from "./command-resolution";
import { resolveClaudeConfig } from "./claude-config";

export type ClaudeSessionOwnership =
  | { kind: "idle" }
  | { kind: "interactive" | "background"; pid: number; source: "agents" | "registry" | "ps" };

type Process = { group: number; start: string; command: string };
type ProcessIdentities = Map<number, Set<string>>;
/** A live PID's registry file, read once per observation; failures are judged per session. */
type RegistryEntry = { pid: number; value?: unknown; unreadable?: true };
/** Read-only ownership sources, collected once and evaluated per session. */
export type ClaudeOwnerObservation = {
  readonly agents: unknown[] | null;
  readonly processes: ReadonlyMap<number, Process> | null;
  readonly registry: { readonly uncertain: boolean; readonly entries: readonly RegistryEntry[] };
};
/** Lets one maintenance tick evaluate all of its workers against a single observation. */
export type ClaudeOwnerObservationShare = { current?: Promise<ClaudeOwnerObservation> };

export type ClaudeRegistryTurn = {
  nativeId: string;
  cwd: string;
  startedAt: string;
  pid: number;
};

const unavailable = () => new Error("claude-owner-check-unavailable");
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pidOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const normalizedStart = (value: string) => value.trim().replace(/\s+/g, " ");
// Claude Code registers interactive | bg | daemon | daemon-worker; older fixtures say background.
const ownershipKind = (kind: unknown): "interactive" | "background" =>
  kind === "background" || kind === "bg" ? "background" : "interactive";

function rememberIdentity(identities: ProcessIdentities, pid: number, sessionId: unknown): void {
  if (typeof sessionId !== "string" || !sessionId) return;
  const known = identities.get(pid) ?? new Set<string>();
  known.add(sessionId);
  identities.set(pid, known);
}

function readsForkSource(words: string[], nativeId: string, identities?: Set<string>): boolean {
  const forks = words.filter(
    (word) => word === "--fork-session" || word.startsWith("--fork-session="),
  );
  if (forks.length !== 1 || forks[0] !== "--fork-session" || identities?.size !== 1) return false;
  const values = (flags: string[]) =>
    words.flatMap((word, index) => {
      if (flags.includes(word)) return [words[index + 1] ?? ""];
      const flag = flags.find((flag) => word.startsWith(`${flag}=`));
      return flag ? [word.slice(flag.length + 1)] : [];
    });
  const resumes = values(["--resume", "-r"]);
  const targets = values(["--session-id"]);
  return (
    resumes.length === 1 &&
    resumes[0] === nativeId &&
    uuidPattern.test(nativeId) &&
    targets.length === 1 &&
    uuidPattern.test(targets[0]!) &&
    targets[0] !== nativeId &&
    identities.has(targets[0]!)
  );
}

/** ps flattens argv; only an executable/official Node entry can establish a CLI owner. */
function claudeProcess(
  words: string[],
  resolvedExecutable: string | null,
): "claude" | "other" | "uncertain" {
  const executable = words[0] ?? "";
  const name = path.posix.basename(executable);
  if (name === "claude") return "claude";
  if (["echo", "printf"].includes(name)) return "other";
  if (["sh", "bash", "zsh", "dash", "fish"].includes(name)) {
    // -c/-lc executes command text, while a script named Claude remains unverified.
    if (/^-[a-z]*c[a-z]*$/.test(words[1] ?? "")) return "other";
    return "uncertain";
  }
  if (path.isAbsolute(executable) && resolvedExecutable) {
    try {
      if (realpathSync(executable) === realpathSync(resolvedExecutable)) return "claude";
    } catch {
      // A missing/unreadable candidate cannot supply positive executable identity.
    }
  }
  if (name === "node" || name === "nodejs") {
    let index = 1;
    while (words[index]?.startsWith("-")) {
      const option = words[index]!;
      if (
        ["-e", "--eval", "-p", "--print"].some(
          (flag) => option === flag || option.startsWith(`${flag}=`),
        )
      )
        return "other";
      // Only self-contained runtime options keep the following word an unambiguous script.
      if (!/^--(?:max-old-space-size=\d+|no-warnings|enable-source-maps)$/.test(option))
        return "uncertain";
      index++;
    }
    const entry = words[index] ?? "";
    if (entry.endsWith("/node_modules/@anthropic-ai/claude-code/cli.js")) return "claude";
    return "uncertain";
  }
  // This is only called after exact session flags match. An older native executable or
  // unfamiliar launcher cannot prove the session is free merely by lacking the word Claude.
  return "uncertain";
}

/**
 * Read-only observations. Startup checks never reuse one: every worker start must see current
 * external ownership. Only a maintenance tick shares one observation across its live workers.
 */
export class ClaudeSessionOwnerProbe {
  constructor(
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
  ) {}

  async check(
    nativeId: string,
    ownedPid: number | null = null,
    share?: ClaudeOwnerObservationShare,
  ): Promise<ClaudeSessionOwnership> {
    const observation = share ? (share.current ??= this.observe()) : this.observe();
    return this.#evaluate(await observation, nativeId, ownedPid);
  }

  async observe(): Promise<ClaudeOwnerObservation> {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("platform-unsupported");
    // Liveness must be newer than the agents observation: an earlier process snapshot can
    // omit a newly opened session and incorrectly discard positive ownership as a dead PID.
    const agents = await this.#agents().catch(() => null);
    const processes = await this.#processes().catch(() => null);
    return {
      agents,
      processes,
      registry: processes ? this.#registry(processes) : { uncertain: false, entries: [] },
    };
  }

  /** Display only. A matching live process can report activity before its bridge is online. */
  async activeRegistryTurns(): Promise<ClaudeRegistryTurn[]> {
    if (process.platform !== "darwin" && process.platform !== "linux") return [];
    const processes = await this.#processes();
    const registry = this.#registry(processes);
    if (registry.uncertain) return [];
    const turns: ClaudeRegistryTurn[] = [];
    for (const { pid, value } of registry.entries) {
      if (!object(value) || value.status !== "working") continue;
      const processRow = processes.get(pid);
      if (
        !processRow ||
        value.pid !== pid ||
        value.pidDomain !== process.platform ||
        typeof value.procStart !== "string" ||
        normalizedStart(value.procStart) !== processRow.start ||
        typeof value.sessionId !== "string" ||
        !uuidPattern.test(value.sessionId) ||
        typeof value.cwd !== "string" ||
        !path.isAbsolute(value.cwd) ||
        typeof value.statusUpdatedAt !== "number" ||
        !Number.isSafeInteger(value.statusUpdatedAt) ||
        value.statusUpdatedAt <= 0 ||
        value.statusUpdatedAt > Date.now() + 2_000
      )
        continue;
      turns.push({
        nativeId: value.sessionId.toLowerCase(),
        cwd: value.cwd,
        startedAt: new Date(value.statusUpdatedAt).toISOString(),
        pid,
      });
    }
    return turns;
  }

  #evaluate(
    observation: ClaudeOwnerObservation,
    nativeId: string,
    ownedPid: number | null,
  ): ClaudeSessionOwnership {
    const { agents, processes } = observation;
    // The worker leads its own process group (detached spawn). A launcher shim can run the real
    // CLI as its child, which then registers a PID other than the one AgentKib spawned.
    const owned = (pid: number) =>
      ownedPid !== null && (pid === ownedPid || processes?.get(pid)?.group === ownedPid);
    let uncertain = false;
    const identities: ProcessIdentities = new Map();
    const resolvedExecutable = resolveCommand("claude", this.environment);

    for (const agent of agents ?? []) {
      if (!object(agent)) continue;
      const pid = pidOf(agent.pid);
      if (pid === null) {
        uncertain ||= agent.sessionId === nativeId;
        continue;
      }
      if (owned(pid) || (processes && !processes.has(pid))) continue;
      rememberIdentity(identities, pid, agent.sessionId);
      if (agent.sessionId === nativeId)
        return { kind: ownershipKind(agent.kind), pid, source: "agents" };
    }

    if (processes) {
      const registry = this.#registryOwner(observation, nativeId, owned, identities);
      if (registry.owner) return registry.owner;
      uncertain ||= registry.uncertain;
      for (const [pid, row] of processes) {
        if (owned(pid)) continue;
        const words = row.command.trim().split(/\s+/);
        const mentioned = words.some(
          (word, index) =>
            word === `--resume=${nativeId}` ||
            word === `--session-id=${nativeId}` ||
            (["--resume", "-r", "--session-id"].includes(word) && words[index + 1] === nativeId),
        );
        if (!mentioned) continue;
        const executable = claudeProcess(words, resolvedExecutable);
        if (executable === "other") continue;
        if (executable === "uncertain") {
          uncertain = true;
          continue;
        }
        // ps flattens argv: fork-looking words may be user prompt text. Only a positive,
        // consistent agents/verified registry identity can prove this PID writes the child.
        if (mentioned && !readsForkSource(words, nativeId, identities.get(pid)))
          return {
            kind: words.some((word) => word === "--print" || word === "-p")
              ? "background"
              : "interactive",
            pid,
            source: "ps",
          };
      }
    }
    // A successful but empty agents response cannot replace the retained process scan. Older
    // CLIs and sessions that have not registered yet may only be visible through `ps`.
    if (!processes || uncertain) throw unavailable();
    return { kind: "idle" };
  }

  async #agents(): Promise<unknown[] | null> {
    const executable = resolveCommand("claude", this.environment);
    if (!executable) return null;
    const result = await this.commands.run(executable, ["agents", "--json"], {
      env: this.environment,
      timeout: 3000,
      limit: 2 * 1024 * 1024,
      strictOutput: true,
      allowFailure: true,
    });
    if (!result.success || result.truncated) return null;
    try {
      const value: unknown = JSON.parse(result.bytes.toString("utf8"));
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async #processes(): Promise<Map<number, Process>> {
    const read = () =>
      this.commands.run("/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="], {
        env: { ...this.environment, TZ: "UTC", LC_ALL: "C", LANG: "C" },
        timeout: 3000,
        limit: 4 * 1024 * 1024,
        strictOutput: true,
      });
    const result = await read().catch((error: unknown) => {
      // A busy event loop can reach the command deadline before handling ps's exit.
      // Retry that read once with a fresh process table; invalid/partial output and
      // cancellation remain failures, and a second timeout still fails closed.
      if (!(error instanceof Error) || error.message !== "/bin/ps command timed out") throw error;
      return read();
    });
    if (!result.success || result.truncated) throw unavailable();
    const processes = new Map<number, Process>();
    for (const line of result.bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(
          line,
        );
      if (!match) throw unavailable();
      const pid = pidOf(Number(match[1]));
      const group = Number(match[2]);
      if (pid === null || !Number.isSafeInteger(group)) throw unavailable();
      processes.set(pid, { group, start: normalizedStart(match[3]!), command: match[4]! });
    }
    return processes;
  }

  #registry(processes: ReadonlyMap<number, Process>): ClaudeOwnerObservation["registry"] {
    const home = this.environment.HOME ?? homedir();
    const config = resolveClaudeConfig(this.environment, home);
    if (config.invalid) return { uncertain: true, entries: [] };
    const directory = path.join(config.dir, "sessions");
    let names: string[];
    try {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { uncertain: true, entries: [] };
      names = readdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { uncertain: code !== "ENOENT" && code !== "ENOTDIR", entries: [] };
    }
    if (names.length > 4096) return { uncertain: true, entries: [] };
    const entries: RegistryEntry[] = [];
    for (const name of names) {
      if (!/^[1-9]\d*\.json$/.test(name)) continue;
      const pid = Number(name.slice(0, -5));
      if (!processes.has(pid)) continue;
      let fd: number | undefined;
      try {
        const file = path.join(directory, name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) continue;
        if (!stat.isFile() || stat.size > 64 * 1024) {
          entries.push({ pid, unreadable: true });
          continue;
        }
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.size > 64 * 1024 ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev
        )
          throw unavailable();
        const bytes = Buffer.alloc(64 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
          const size = readSync(fd, bytes, length, bytes.length - length, null);
          if (size === 0) break;
          length += size;
        }
        if (length > 64 * 1024) throw unavailable();
        entries.push({ pid, value: JSON.parse(bytes.subarray(0, length).toString("utf8")) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          entries.push({ pid, unreadable: true });
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    return { uncertain: false, entries };
  }

  #registryOwner(
    observation: ClaudeOwnerObservation,
    nativeId: string,
    owned: (pid: number) => boolean,
    identities: ProcessIdentities,
  ): { owner: ClaudeSessionOwnership | null; uncertain: boolean } {
    const { processes, registry } = observation;
    if (registry.uncertain || !processes) return { owner: null, uncertain: registry.uncertain };
    let uncertain = false;
    for (const entry of registry.entries) {
      // Our own worker's record is skipped before its readability can matter, as it always was.
      if (owned(entry.pid)) continue;
      if (entry.unreadable || !object(entry.value)) {
        uncertain = true;
        continue;
      }
      const value = entry.value;
      const relevant = value.sessionId === nativeId;
      if (typeof value.pidDomain === "string" && value.pidDomain !== process.platform) continue;
      const pid = pidOf(value.pid);
      if (pid !== entry.pid || typeof value.procStart !== "string" || !value.procStart.trim()) {
        uncertain ||= relevant;
        continue;
      }
      // CLI registry records use UTC lstart. Matching the birth time prevents a dead PID's
      // stale record from claiming an unrelated process after the OS reuses that PID.
      if (normalizedStart(value.procStart) !== processes.get(pid)!.start) continue;
      rememberIdentity(identities, pid, value.sessionId);
      if (!relevant) continue;
      return {
        owner: { kind: ownershipKind(value.kind), pid, source: "registry" },
        uncertain,
      };
    }
    return { owner: null, uncertain };
  }
}
