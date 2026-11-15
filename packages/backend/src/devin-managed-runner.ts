import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { devinSessionDatabase } from "./devin-sessions";

/**
 * Devin CLI runs each turn non-interactively (`devin -p`), so it is its own host and uses the
 * login `devin auth login` stored; AgentKib never reads it. `devin acp` is not used: it refuses
 * local CLI credentials and wants the host to hand it the user's API key.
 */
export const DEVIN_EXECUTION_MODE = "devin-print";
/** Devin's own permission modes, applied to a whole turn: print mode cannot ask mid-turn. */
export const DEVIN_PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"] as const;
export type DevinPermissionMode = (typeof DEVIN_PERMISSION_MODES)[number];
export const DEVIN_MAX_PROMPT_BYTES = 64 * 1024;

const POLL_MS = 1_000;
// `devin -p` does not exit on SIGINT (seen with 3000.12.59); SIGTERM ends it and its tools.
const STOP_TERM_MS = 1_500;
const STOP_KILL_MS = 5_000;
const OUTPUT_LIMIT = 64 * 1024;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface DevinTurnSettings {
  model?: string;
  permissionMode?: DevinPermissionMode;
}

export interface DevinRunnerHost {
  executable(): string | null;
  environment: NodeJS.ProcessEnv;
  /** The newest page of a session's history, as the session readers build it. */
  latestItems(nativeId: string): Promise<Array<Record<string, unknown>>>;
  /** Devin sessions in the runner's workspace, with when each was created (ms). */
  listSessions(): Promise<Array<{ nativeId: string; createdAt: number }>>;
  /** The text of a session's first user message, to tell sessions started together apart. */
  firstUserText(nativeId: string): Promise<string | null>;
  publish(
    type: "state" | "snapshot",
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
}

/**
 * The environment for a Devin CLI that AgentKib starts. Devin marks processes under an ACP host,
 * such as Devin Desktop, with `ACP_BACKEND`, and a CLI that inherits it refuses its own login so
 * that usage goes to the host's account. AgentKib's `devin -p` has no such host: it runs with the
 * login the CLI stored, so the marker inherited from wherever AgentKib started is dropped.
 */
export function devinChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ACP_BACKEND: _host, ...rest } = environment;
  return rest;
}

/** Maps what a failed `devin -p` printed to a reason the UI explains; the output is not kept. */
export function devinRunFailure(output: string, code: number | null): string {
  if (/not logged in|devin auth login/i.test(output)) return "devin-login-required";
  if (/workspace[- ]trust|not trusted|untrusted/i.test(output)) return "devin-workspace-untrusted";
  if (/session[^\n]{0,40}(locked|in use|already (open|running))/i.test(output))
    return "session-open-elsewhere";
  return code === null ? "devin-run-stopped" : "devin-run-failed";
}

/**
 * Whether another live Devin process holds the session. Devin keeps one lock file per session
 * with its holder's PID and leaves it behind, so the PID must still be a running Devin.
 */
export async function devinSessionLockedElsewhere(
  environment: NodeJS.ProcessEnv,
  nativeId: string,
  ownPid?: number,
): Promise<boolean> {
  if (!NATIVE_ID.test(nativeId)) return false;
  const file = path.join(
    path.dirname(devinSessionDatabase(environment)),
    "session_locks",
    `${nativeId}.lock`,
  );
  const text = await readFile(file, "utf8").then(
    (value) => value.trim(),
    () => "",
  );
  if (!/^\d{1,10}$/.test(text)) return false;
  const pid = Number(text);
  if (pid === ownPid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform === "win32") return true;
  const command = await new Promise<string>((resolve) =>
    execFile("ps", ["-p", String(pid), "-o", "comm="], { timeout: 5_000 }, (error, stdout) =>
      resolve(error ? "" : String(stdout)),
    ),
  );
  return /devin/i.test(command);
}

/** Devin's models by family, and which family each concrete model (variant) belongs to. */
export interface DevinModelCatalog {
  families: Array<{ id: string; name?: string }>;
  familyOf: Map<string, string>;
}

const MODEL_ID = /^[A-Za-z0-9._:@/+-]{1,128}$/;

/**
 * The model families `devin models list --format json` reports (`{ families: [{ slug,
 * family_label, variants: [{ model_uid }] }] }`), one choice each: `--model <slug>` lets Devin
 * pick the variant. A session keeps the variant it ran with, which `familyOf` names a family
 * for. Empty when the CLI cannot list them, for example without a login.
 */
export function devinModelCatalog(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<DevinModelCatalog> {
  const empty = (): DevinModelCatalog => ({ families: [], familyOf: new Map() });
  return new Promise((resolve) =>
    execFile(
      executable,
      ["models", "list", "--format", "json"],
      { env: environment, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(empty());
        try {
          const families = (JSON.parse(String(stdout)) as { families?: unknown }).families;
          if (!Array.isArray(families)) return resolve(empty());
          const catalog = empty();
          for (const family of families.slice(0, 200)) {
            const entry = (family ?? {}) as {
              slug?: unknown;
              family_label?: unknown;
              variants?: unknown;
            };
            if (typeof entry.slug !== "string" || !MODEL_ID.test(entry.slug)) continue;
            const label = entry.family_label;
            catalog.families.push({
              id: entry.slug,
              ...(typeof label === "string" && label ? { name: label } : {}),
            });
            if (Array.isArray(entry.variants))
              for (const variant of entry.variants.slice(0, 2_000)) {
                const uid = (variant as { model_uid?: unknown } | null)?.model_uid;
                if (typeof uid === "string" && MODEL_ID.test(uid) && !catalog.familyOf.has(uid))
                  catalog.familyOf.set(uid, entry.slug);
              }
          }
          resolve(catalog);
        } catch {
          resolve(empty());
        }
      },
    ),
  );
}

/** Asks the CLI itself whether it has a login; nothing about the login is read or kept. */
export function devinLoggedIn(executable: string, environment: NodeJS.ProcessEnv) {
  return new Promise<boolean>((resolve) =>
    execFile(
      executable,
      ["auth", "status"],
      { env: environment, timeout: 15_000, maxBuffer: OUTPUT_LIMIT, windowsHide: true },
      (error, stdout, stderr) =>
        resolve(!error && !/not logged in/i.test(`${String(stdout)}\n${String(stderr)}`)),
    ),
  );
}

function signal(child: ChildProcess, name: NodeJS.Signals) {
  try {
    // The CLI is started in its own process group so that its tools stop with it.
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // Already gone.
  }
}

const normalized = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim();

/**
 * One Devin session run by AgentKib: a turn is one `devin -p` process, its progress is read
 * back from Devin's session store while it runs, and stopping it ends that process.
 */
export class DevinManagedRunner {
  #nativeId: string | null;
  #status: "idle" | "running" | "stopping" | "failed" = "idle";
  #revision = 0;
  #turnId: string | null = null;
  #completedTurnId: string | null = null;
  #reason: string | null = null;
  #child: ChildProcess | null = null;
  #timer: NodeJS.Timeout | undefined;
  #published = "";
  #closed = false;
  #found: Array<(nativeId: string) => void> = [];
  #ended: Array<(reason: string) => void> = [];

  constructor(
    readonly workspace: string,
    nativeId: string | null,
    readonly host: DevinRunnerHost,
  ) {
    this.#nativeId = nativeId;
  }

  get nativeId() {
    return this.#nativeId;
  }

  snapshot(): Record<string, unknown> {
    const running = this.#status === "running" || this.#status === "stopping";
    return {
      executionMode: DEVIN_EXECUTION_MODE,
      status: this.#status === "failed" ? "idle" : this.#status,
      revision: this.#revision,
      turnId: this.#turnId,
      completedTurnId: this.#completedTurnId,
      sendEnabled: !running && !this.#closed,
      stopEnabled: this.#status === "running",
      cancelling: this.#status === "stopping",
      approvals: [],
      questions: [],
      reason: this.#reason,
      usage: { available: false },
    };
  }

  /** Resolves with the new session's ID once Devin has stored it, for a runner without one. */
  session(): Promise<string> {
    if (this.#nativeId) return Promise.resolve(this.#nativeId);
    return new Promise((resolve, reject) => {
      this.#found.push(resolve);
      this.#ended.push((reason) => reject(new Error(reason)));
    });
  }

  async send(
    text: string,
    expectedRevision: number,
    beforeDispatch: () => void,
    settings: DevinTurnSettings = {},
  ): Promise<void> {
    if (this.#closed) throw new Error("session-runner-unavailable");
    if (expectedRevision !== this.#revision) throw new Error("stale-or-disabled-control");
    if (this.#status === "running" || this.#status === "stopping") throw new Error("session-busy");
    if (!text.trim() || Buffer.byteLength(text, "utf8") > DEVIN_MAX_PROMPT_BYTES)
      throw new Error("invalid-text");
    const executable = this.host.executable();
    if (!executable) throw new Error("devin-cli-unavailable");
    if (
      this.#nativeId &&
      (await devinSessionLockedElsewhere(this.host.environment, this.#nativeId))
    )
      throw new Error("session-open-elsewhere");
    if (!(await devinLoggedIn(executable, this.host.environment)))
      throw new Error("devin-login-required");
    const before = this.#nativeId
      ? null
      : new Set((await this.host.listSessions()).map((item) => item.nativeId));
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-devin-"));
    const promptFile = path.join(directory, "prompt.md");
    const args = [
      "-p",
      "--prompt-file",
      promptFile,
      ...(this.#nativeId ? ["-r", this.#nativeId] : []),
      ...(settings.model ? ["--model", settings.model] : []),
      ...(settings.permissionMode ? ["--permission-mode", settings.permissionMode] : []),
    ];
    let child: ChildProcess;
    try {
      await writeFile(promptFile, text, { mode: 0o600 });
      beforeDispatch();
      child = spawn(executable, args, {
        cwd: this.workspace,
        env: this.host.environment,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    this.#child = child;
    this.#status = "running";
    this.#reason = null;
    this.#turnId = randomUUID();
    this.#revision++;
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8").slice(0, OUTPUT_LIMIT);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const startedAt = Date.now();
    this.#publishState();
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(-1));
    });
    this.#timer = setInterval(() => void this.#poll(before, text, startedAt), POLL_MS);
    void exited.then(async (code) => {
      clearInterval(this.#timer);
      this.#timer = undefined;
      await this.#poll(before, text, startedAt);
      await rm(directory, { recursive: true, force: true });
      const stopped = this.#status === "stopping";
      this.#child = null;
      this.#status = code === 0 || stopped ? "idle" : "failed";
      this.#reason =
        code === 0 || stopped
          ? this.#nativeId
            ? null
            : "devin-session-not-found"
          : devinRunFailure(output, code);
      if (!this.#nativeId) for (const end of this.#ended.splice(0)) end(this.#reason ?? "failed");
      this.#found = [];
      this.#completedTurnId = this.#turnId;
      this.#turnId = null;
      this.#revision++;
      this.#publishState();
      await this.#publishItems();
    });
  }

  async stop(turnId: string, expectedRevision: number, beforeDispatch: () => void) {
    if (expectedRevision !== this.#revision) throw new Error("stale-or-disabled-control");
    const child = this.#child;
    if (this.#status !== "running" || !child || turnId !== this.#turnId)
      throw new Error("session-not-running");
    beforeDispatch();
    this.#status = "stopping";
    this.#revision++;
    this.#publishState();
    signal(child, "SIGINT");
    setTimeout(() => this.#child === child && signal(child, "SIGTERM"), STOP_TERM_MS).unref();
    setTimeout(() => this.#child === child && signal(child, "SIGKILL"), STOP_KILL_MS).unref();
  }

  /** Marks a change to what the next turn runs with, so that a stale control is refused. */
  bump() {
    this.#revision++;
    this.#publishState();
  }

  close() {
    this.#closed = true;
    clearInterval(this.#timer);
    if (this.#child) signal(this.#child, "SIGTERM");
  }

  async #poll(before: Set<string> | null, prompt: string, startedAt: number) {
    try {
      if (!this.#nativeId && before) {
        const fresh = (await this.host.listSessions()).filter(
          (item) => !before.has(item.nativeId) && item.createdAt >= startedAt - 5_000,
        );
        let match = fresh.length === 1 ? fresh[0]!.nativeId : null;
        // Sessions another Devin started meanwhile in this workspace are told apart by prompt.
        if (fresh.length > 1)
          for (const item of fresh)
            if (normalized(await this.host.firstUserText(item.nativeId)) === normalized(prompt)) {
              match = item.nativeId;
              break;
            }
        if (match) {
          this.#nativeId = match;
          for (const found of this.#found.splice(0)) found(match);
          this.#ended = [];
        }
      }
      if (this.#nativeId) await this.#publishItems();
    } catch {
      // The store is read again on the next tick; a turn never fails for a missed read.
    }
  }

  async #publishItems() {
    if (!this.#nativeId) return;
    const items = await this.host.latestItems(this.#nativeId);
    const digest = createHash("sha256").update(JSON.stringify(items)).digest("hex");
    if (digest === this.#published) return;
    this.#published = digest;
    const live = this.snapshot();
    this.host.publish(
      "snapshot",
      {
        live,
        items,
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        completeItems: false,
      },
      live,
    );
  }

  #publishState() {
    const live = this.snapshot();
    this.host.publish("state", { live }, live);
  }
}
