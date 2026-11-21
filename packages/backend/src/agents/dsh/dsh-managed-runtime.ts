/**
 * The DeepSeek Harness that AgentKib starts in the background when no running DSH can take a
 * session (phase 3 in docs/agents/deepseek-harness.md). It runs DSH's own command line with the
 * web profile, the only one that can continue DSH Desktop's sessions; the user's Desktop
 * settings are layered on top, and the AgentKib plugin is mounted by path, so no profile file
 * changes. The DSH bridge decides when to start and stop it; this class owns the process.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dshBridgeLaunchable } from "@agentkib/runtime-protocol";

/** DSH Desktop's own command-line launcher; it runs DSH with the app's bundled Node. */
const APP_LAUNCHER = path.join(
  "DeepSeek Harness.app",
  "Contents",
  "Resources",
  "runtime",
  "cli",
  "bin",
  "dsh",
);
const APP_BINARY = path.join("DeepSeek Harness.app", "Contents", "MacOS", "DeepSeek Harness");
const VERSION_TIMEOUT_MS = 10_000;
/** DSH bounds its own shutdown at 5 seconds. */
const STOP_GRACE_MS = 8_000;
const STDERR_TAIL_CHARS = 8 * 1024;
const DESKTOP_CHECK_MS = 10_000;
/** The plugin row this class mounts; DSH names it when it turns the plugin off. */
export const DSH_MANAGED_PLUGIN_ROW = "agentkib-dsh-bridge-managed";

export type DshLauncher = { path: string; kind: "app" | "path" };
/** Where to look besides the PATH; tests replace the system folders. */
export type DshLauncherPlaces = { applications?: string[]; bins?: string[] };
export type DshManagedPhase = "stopped" | "starting" | "running" | "stopping";
/** Why the background DSH could not start, or why it went away. */
export type DshManagedFailure =
  | "dsh-launcher-unavailable"
  | "dsh-version-unsupported"
  | "dsh-start-failed"
  | "dsh-exited";

export interface DshManagedRuntimeOptions {
  /** AgentKib's data directory; the overlay is written under `dsh-bridge/`. */
  dataDir: string;
  /** AgentKib home where the plugin finds this Runtime's discovery file. */
  agentkibHome: string;
  /** Unpacked plugin directory shipped with the application. */
  pluginDirectory: string;
  /** Environment DSH runs with; it also locates the launcher and DSH's home. */
  env?: NodeJS.ProcessEnv;
  /** A DSH process ended. `failure` is set unless AgentKib stopped it. */
  onExit?(pid: number, failure: DshManagedFailure | null): void;
  spawn?: typeof spawn;
  execFile?: typeof execFile;
  stopGraceMs?: number;
  launcherPlaces?: DshLauncherPlaces;
}

export interface DshManagedStatus {
  phase: DshManagedPhase;
  pid: number | null;
  launcher: DshLauncher["kind"] | null;
  version: string | null;
  failure: { reason: DshManagedFailure; at: number } | null;
}

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * DSH Desktop's launcher first, in /Applications or ~/Applications, then a `dsh` on the PATH
 * (the npm command line, or the one DSH Desktop installs). `AGENTKIB_DSH_LAUNCHER` replaces the
 * search, for tests and sandboxes.
 */
export function findDshLauncher(
  env: NodeJS.ProcessEnv = process.env,
  places: DshLauncherPlaces = {},
): DshLauncher | null {
  const override = env.AGENTKIB_DSH_LAUNCHER;
  if (override)
    return path.isAbsolute(override) && executable(override)
      ? { path: override, kind: "path" }
      : null;
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : homedir();
  for (const root of places.applications ?? ["/Applications", path.join(home, "Applications")]) {
    const candidate = path.join(root, APP_LAUNCHER);
    if (executable(candidate)) return { path: candidate, kind: "app" };
  }
  // A GUI app's PATH is short; DSH Desktop installs its command in /usr/local/bin.
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter),
    ...(places.bins ?? ["/usr/local/bin", "/opt/homebrew/bin"]),
  ];
  for (const dir of new Set(dirs)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "dsh");
    if (executable(candidate)) return { path: candidate, kind: "path" };
  }
  return null;
}

/** DSH's home: `DSH_HOME` when it is absolute, else `~/.dsh`, as DSH resolves it. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_HOME && path.isAbsolute(env.DSH_HOME)) return env.DSH_HOME;
  return path.join(env.HOME && path.isAbsolute(env.HOME) ? env.HOME : homedir(), ".dsh");
}

/**
 * The environment DSH runs with: the user's, without AgentKib's and Electron's own settings,
 * which DSH would hand on to the tools its agents run. The launcher sets what DSH needs.
 */
export function dshEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !key.startsWith("AGENTKIB_") && !key.startsWith("ELECTRON_"),
    ),
  );
}

/** The web token DSH prints and anything that looks like one stay out of diagnostics. */
function redact(text: string): string {
  return text.replace(/token=[^\s&"']+/gi, "token=<redacted>").replace(/[A-Za-z0-9_-]{40,}/g, "…");
}

export class DshManagedRuntime {
  #child: ChildProcess | null = null;
  #phase: DshManagedPhase = "stopped";
  #exited: Promise<void> | null = null;
  #stderr = "";
  #failure: DshManagedStatus["failure"] = null;
  #launcher: DshLauncher | null = null;
  #version: { key: string; value: string | null } | null = null;
  #desktop: { at: number; running: boolean } | null = null;

  constructor(readonly options: DshManagedRuntimeOptions) {}

  get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }
  get pid(): number | null {
    return this.#phase === "stopped" ? null : (this.#child?.pid ?? null);
  }
  get phase(): DshManagedPhase {
    return this.#phase;
  }

  /** Whether a start can be tried now: a launcher exists and no start is known to be refused. */
  available(): { available: true } | { available: false; reason: DshManagedFailure } {
    this.#launcher = findDshLauncher(this.env, this.options.launcherPlaces);
    if (!this.#launcher) return { available: false, reason: "dsh-launcher-unavailable" };
    const version = this.#version;
    if (version && version.key === this.#versionKey(this.#launcher) && version.value !== null)
      if (!dshBridgeLaunchable(version.value))
        return { available: false, reason: "dsh-version-unsupported" };
    return { available: true };
  }

  status(): DshManagedStatus {
    return {
      phase: this.#phase,
      pid: this.pid,
      launcher: this.#launcher?.kind ?? null,
      version: this.#version?.value ?? null,
      failure: this.#failure,
    };
  }

  /** The launcher changes with an app update; its version is read again then. */
  #versionKey(launcher: DshLauncher): string {
    const stamp = (file: string) => {
      try {
        return String(statSync(file).mtimeMs);
      } catch {
        return "-";
      }
    };
    const app =
      launcher.kind === "app"
        ? path.join(path.dirname(launcher.path), "..", "..", "..", "app.asar")
        : launcher.path;
    return `${launcher.path}\n${stamp(launcher.path)}\n${stamp(app)}`;
  }

  /** `dsh --version` prints the runtime version and reads no profile. */
  async version(launcher: DshLauncher): Promise<string | null> {
    const key = this.#versionKey(launcher);
    if (this.#version?.key === key) return this.#version.value;
    const run = this.options.execFile ?? execFile;
    const value = await new Promise<string | null>((resolve) => {
      run(
        launcher.path,
        ["--version"],
        { env: this.env, timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          const text = String(stdout ?? "")
            .trim()
            .split(/\s+/)
            .pop();
          resolve(error || !text ? null : text);
        },
      );
    });
    this.#version = { key, value };
    return value;
  }

  /**
   * Starts DSH and resolves with its process ID once it runs; the caller waits for the plugin to
   * register. Rejects with a `DshManagedFailure` as the message.
   */
  async start(): Promise<number> {
    if (this.#phase === "starting" || this.#phase === "running") return this.#child!.pid!;
    if (this.#phase === "stopping") await this.#exited;
    const fail = (reason: DshManagedFailure): never => {
      this.#failure = { reason, at: Date.now() };
      throw new Error(reason);
    };
    const launcher = findDshLauncher(this.env, this.options.launcherPlaces);
    this.#launcher = launcher;
    if (!launcher) return fail("dsh-launcher-unavailable");
    const version = await this.version(launcher);
    // A version that cannot be read may still run the plugin; DSH checks the range itself.
    if (version !== null && !dshBridgeLaunchable(version)) return fail("dsh-version-unsupported");
    const patches: string[] = [];
    // The user's Desktop settings, so the models and defaults match DSH Desktop. Entries for
    // plugins the web profile lacks are skipped by DSH with a warning.
    const desktop = path.join(dshHome(this.env), "profiles", "desktop", "cordis.patch.yml");
    try {
      if (lstatSync(desktop).isFile()) patches.push("--patch", desktop);
    } catch {
      // No DSH Desktop settings.
    }
    patches.push("--patch", this.#writeOverlay());
    const home = this.env.HOME && path.isAbsolute(this.env.HOME) ? this.env.HOME : homedir();
    const child = (this.options.spawn ?? spawn)(
      launcher.path,
      ["--profile", "web", ...patches, "--no-open", "--port", "0", "--host", "127.0.0.1"],
      { cwd: home, env: dshEnvironment(this.env), stdio: ["pipe", "pipe", "pipe"] },
    );
    this.#child = child;
    this.#phase = "starting";
    this.#stderr = "";
    // DSH prints the address of its web page with a token; it is never kept or shown.
    child.stdout?.resume();
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    // Closing standard input is how this DSH notices that AgentKib went away; keep it open.
    child.stdin?.on("error", () => undefined);
    let spawnError = false;
    this.#exited = new Promise<void>((resolve) => {
      child.once("error", () => {
        spawnError = true;
        resolve();
      });
      child.once("exit", () => resolve());
    }).then(() => {
      const stopped = this.#phase === "stopping";
      const starting = this.#phase === "starting";
      const pid = child.pid ?? 0;
      if (this.#child === child) {
        this.#child = null;
        this.#phase = "stopped";
      }
      let failure: DshManagedFailure | null = null;
      if (!stopped) {
        failure = this.#stderr.includes(`"${DSH_MANAGED_PLUGIN_ROW}"`)
          ? "dsh-version-unsupported"
          : spawnError || starting
            ? "dsh-start-failed"
            : "dsh-exited";
        this.#failure = { reason: failure, at: Date.now() };
      }
      this.options.onExit?.(pid, failure);
    });
    if (!child.pid) {
      await this.#exited;
      return fail("dsh-start-failed");
    }
    this.#failure = null;
    return child.pid;
  }

  /** The plugin registered: DSH is up. */
  started(): void {
    if (this.#phase === "starting") this.#phase = "running";
  }

  /** Recent diagnostics, with the web token removed. */
  diagnostics(): string {
    return redact(this.#stderr).slice(-2048);
  }

  /** Asks DSH to stop as its own launcher would, then forces it after the grace period. */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || this.#phase === "stopped") return;
    this.#phase = "stopping";
    child.kill("SIGTERM");
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), grace);
      timer.unref?.();
    });
    if ((await Promise.race([this.#exited, late])) === "late") {
      child.kill("SIGKILL");
      await this.#exited;
    }
    if (timer) clearTimeout(timer);
  }

  /**
   * Whether DSH Desktop's own window is open. Its main process runs the app binary itself; DSH
   * processes started from a command line run it with `--expose-internals`.
   */
  async desktopRunning(): Promise<boolean> {
    const known = this.#desktop;
    if (known && Date.now() - known.at < DESKTOP_CHECK_MS) return known.running;
    const run = this.options.execFile ?? execFile;
    const running = await new Promise<boolean>((resolve) => {
      run(
        "/bin/ps",
        ["-A", "-o", "args="],
        { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) return resolve(false);
          resolve(
            String(stdout)
              .split("\n")
              .some(
                (line) =>
                  line.includes(APP_BINARY) &&
                  !line.includes("--expose-internals") &&
                  !line.includes("Helper"),
              ),
          );
        },
      );
    });
    this.#desktop = { at: Date.now(), running };
    return running;
  }

  /**
   * The overlay mounting the plugin, written fresh before every start. It turns off a copy of
   * the plugin the web profile may have installed, so only this one connects.
   */
  #writeOverlay(): string {
    const directory = path.join(this.options.dataDir, "dsh-bridge");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = path.join(directory, "managed-overlay.yml");
    // JSON strings are valid YAML scalars, so paths need no further quoting.
    const lines = [
      "# Written by AgentKib for the DeepSeek Harness it starts in the background.",
      "- id: agentkib-dsh-bridge",
      "  disabled: true",
      "- insert:",
      `    - id: ${DSH_MANAGED_PLUGIN_ROW}`,
      `      name: ${JSON.stringify(path.join(this.options.pluginDirectory, "index.js"))}`,
      "      config:",
      "        managed:",
      `          home: ${JSON.stringify(this.options.agentkibHome)}`,
      "",
    ];
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, lines.join("\n"), { flag: "wx", mode: 0o600 });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    return file;
  }
}
