import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { devinSessionDatabase } from "./devin-sessions";
import { devinUsageLimitHit, type UsageLimitHit, type UsageLimitView } from "../../usage-limit";

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

/** How a turn of a session Devin stored ended, told before the runner shows itself idle. */
export interface DevinTurnEnd {
  nativeId: string;
  /** AgentKib's ID of the turn, as the live state named it. */
  turnId: string;
  startedAt: string;
  endedAt: string;
  /** Answered, failed (also on a usage limit), or stopped by the person. */
  outcome: "completed" | "failed" | "cancelled";
  /** The turn's prompt and answer in the session's history, when Devin stored them. */
  historyTurnId: string | null;
  answerItemId: string | null;
  /** Only when the observed prompt or answer can be tied to this run. */
  observedHistoryTurnId?: string;
  observedReplyText?: string;
  usageLimit: UsageLimitHit | null;
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
  turnEnded?(end: DevinTurnEnd): void;
  /** A `state` event's payload is the live state itself; a `snapshot` carries it as `live`. */
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

export const DEVIN_MODEL_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
const DEVIN_MODEL_SPEEDS = ["fast", "priority", "lightning"] as const;
type DevinModelEffort = (typeof DEVIN_MODEL_EFFORTS)[number];
type DevinModelSpeed = (typeof DEVIN_MODEL_SPEEDS)[number];

export interface DevinModelVariant {
  id: string;
  familyId: string;
  name?: string;
  effort?: DevinModelEffort;
  serviceTierId?: DevinModelSpeed;
  maxContextTokens?: number;
}

/** Devin's model families and the concrete variants the account can select. */
export interface DevinModelCatalog {
  families: Array<{ id: string; name?: string }>;
  familyOf: Map<string, string>;
  variantsByFamily: Map<string, DevinModelVariant[]>;
}

const MODEL_ID = /^[A-Za-z0-9._:@/+-]{1,128}$/;

export function emptyDevinModelCatalog(): DevinModelCatalog {
  return { families: [], familyOf: new Map(), variantsByFamily: new Map() };
}

export function devinModelVariant(
  catalog: DevinModelCatalog,
  id: string,
): DevinModelVariant | undefined {
  const familyId = catalog.familyOf.get(id);
  return familyId
    ? catalog.variantsByFamily.get(familyId)?.find((variant) => variant.id === id)
    : undefined;
}

/** Resolve a unique advertised variant. A bare family leaves the choice to Devin. */
export function resolveDevinModel(
  catalog: DevinModelCatalog,
  {
    modelId,
    effort,
    serviceTierId,
  }: { modelId: string; effort?: string | null; serviceTierId?: string | null },
): string | undefined {
  if (!effort && !serviceTierId) {
    return catalog.variantsByFamily.has(modelId) || catalog.familyOf.has(modelId)
      ? modelId
      : undefined;
  }
  const matches = (variant: DevinModelVariant) =>
    (!effort || variant.effort === effort) &&
    variant.serviceTierId === (serviceTierId ?? undefined);
  const exact = devinModelVariant(catalog, modelId);
  if (exact && matches(exact)) return exact.id;
  const choices = catalog.variantsByFamily.get(exact?.familyId ?? modelId)?.filter(matches);
  return choices?.length === 1 ? choices[0]?.id : undefined;
}

/** Read an exact effort/speed suffix after the native family ID (or the CLI slug).
 * Composite models, capacity variants, and unfamiliar suffixes stay selectable by their native ID. */
function devinVariantControls(
  id: string,
  familyIds: string[],
  label?: string,
  familyLabel?: string,
): Pick<DevinModelVariant, "effort" | "serviceTierId"> {
  for (const family of familyIds) {
    if (id === family && label && familyLabel && label.startsWith(`${familyLabel} `)) {
      // Some bare variants carry the reasoning setting only in their own label, e.g. GLM-5.2 High.
      const suffix = label.slice(familyLabel.length + 1).toLowerCase();
      const effort = DEVIN_MODEL_EFFORTS.find((value) => value === suffix);
      if (effort) return { effort };
    }
    if (!id.startsWith(`${family}-`)) continue;
    const suffix = id.slice(family.length + 1);
    const [level, speed, extra] = suffix.split("-");
    if (extra !== undefined) continue;
    const effort = DEVIN_MODEL_EFFORTS.find((value) => value === level);
    if (effort && speed === undefined) return { effort };
    const serviceTierId = DEVIN_MODEL_SPEEDS.find((value) => value === (effort ? speed : level));
    if (serviceTierId && (effort || speed === undefined))
      return effort ? { effort, serviceTierId } : { serviceTierId };
  }
  return {};
}

function parseDevinModelCatalog(listing: unknown): DevinModelCatalog {
  const catalog = emptyDevinModelCatalog();
  const families = (listing as { families?: unknown } | null)?.families;
  if (!Array.isArray(families)) return catalog;
  for (const family of families.slice(0, 200)) {
    const entry = (family ?? {}) as {
      slug?: unknown;
      family_uid?: unknown;
      family_label?: unknown;
      variants?: unknown;
    };
    const { slug } = entry;
    if (typeof slug !== "string" || !MODEL_ID.test(slug) || catalog.variantsByFamily.has(slug))
      continue;
    const name =
      typeof entry.family_label === "string" ? entry.family_label.trim().slice(0, 256) : "";
    catalog.families.push({ id: slug, ...(name ? { name } : {}) });
    const familyIds = [slug, slug.replaceAll(".", "-")];
    if (typeof entry.family_uid === "string" && MODEL_ID.test(entry.family_uid))
      familyIds.unshift(entry.family_uid);
    const variants: DevinModelVariant[] = [];
    catalog.variantsByFamily.set(slug, variants);
    if (!Array.isArray(entry.variants)) continue;
    for (const value of entry.variants.slice(0, 2_000)) {
      const variant = value as {
        model_uid?: unknown;
        label?: unknown;
        max_context_tokens?: unknown;
      } | null;
      const id = variant?.model_uid;
      if (typeof id !== "string" || !MODEL_ID.test(id) || catalog.familyOf.has(id)) continue;
      const label = typeof variant?.label === "string" ? variant.label.trim().slice(0, 256) : "";
      const capacity = variant?.max_context_tokens;
      variants.push({
        id,
        familyId: slug,
        ...(label ? { name: label } : {}),
        ...devinVariantControls(id, familyIds, label, name),
        ...(typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0
          ? { maxContextTokens: capacity }
          : {}),
      });
      catalog.familyOf.set(id, slug);
    }
  }
  return catalog;
}

/** Query the CLI catalog. An unavailable catalog leaves Devin's default model in effect. */
export function devinModelCatalog(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<DevinModelCatalog> {
  return new Promise((resolve) =>
    execFile(
      executable,
      ["models", "list", "--format", "json"],
      { env: environment, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(emptyDevinModelCatalog());
        try {
          resolve(parseDevinModelCatalog(JSON.parse(String(stdout))));
        } catch {
          resolve(emptyDevinModelCatalog());
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

export function devinItemInTurn(timestamp: unknown, startedAt: number, endedAt: number) {
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return time >= startedAt && time <= endedAt;
}

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
  /** The usage limit the last turn met, until the next turn starts. */
  #usageLimit: UsageLimitView | null = null;
  #child: ChildProcess | null = null;
  #runningSettings: DevinTurnSettings | undefined;
  #timer: NodeJS.Timeout | undefined;
  #published = "";
  /** The history items last read, which tell the turn's answer once it ends. */
  #items: Array<Record<string, unknown>> = [];
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

  get canStageSettings() {
    return !this.#closed && this.#nativeId !== null;
  }

  get runningSettings(): Readonly<DevinTurnSettings> | undefined {
    return this.#runningSettings;
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
      usageLimit: this.#usageLimit,
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
    let startedAt: number;
    try {
      await writeFile(promptFile, text, { mode: 0o600 });
      if (this.#closed || expectedRevision !== this.#revision)
        throw new Error("stale-or-disabled-control");
      beforeDispatch();
      startedAt = Date.now();
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
    this.#runningSettings = { ...settings };
    this.#status = "running";
    this.#reason = null;
    this.#usageLimit = null;
    this.#turnId = randomUUID();
    this.#revision++;
    // The ends are kept: Devin prints why a turn failed after whatever it printed before.
    let output = "";
    let errors = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-OUTPUT_LIMIT);
      errors = (errors + text).slice(-OUTPUT_LIMIT);
    });
    this.#publishState();
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", () => resolve({ code: -1, signal: null }));
      },
    );
    this.#timer = setInterval(() => void this.#poll(before, text, startedAt), POLL_MS);
    void exited.then(async ({ code, signal }) => {
      const endedAt = Date.now();
      clearInterval(this.#timer);
      this.#timer = undefined;
      await this.#poll(before, text, startedAt);
      await rm(directory, { recursive: true, force: true });
      const stopped =
        this.#status === "stopping" &&
        (signal === "SIGINT" ||
          signal === "SIGTERM" ||
          signal === "SIGKILL" ||
          code === 130 ||
          code === 143 ||
          code === 137);
      // A usage limit can end a turn that exits 0, so what Devin printed as errors is read
      // either way; its reply only when the turn failed, where it cannot pass for an answer.
      const limit = stopped ? null : devinUsageLimitHit(code === 0 ? errors : output);
      const failed = code !== 0 && !stopped && !limit;
      this.#child = null;
      this.#runningSettings = undefined;
      this.#status = failed ? "failed" : "idle";
      this.#reason = failed
        ? devinRunFailure(output, code)
        : this.#nativeId
          ? null
          : "devin-session-not-found";
      // `devin -p` says no reset time: the notice says so until the host learns more
      // (docs/agents/usage-limits.md).
      this.#usageLimit = limit
        ? { ...limit, agent: "devin", continueAt: null, manual: "reset-unknown", autoContinues: 0 }
        : null;
      if (!this.#nativeId) for (const end of this.#ended.splice(0)) end(this.#reason ?? "failed");
      this.#found = [];
      const turnId = this.#turnId;
      this.#completedTurnId = turnId;
      this.#turnId = null;
      this.#revision++;
      // Told before the idle state goes out, so that what follows it already knows the outcome.
      if (this.#nativeId && turnId)
        try {
          this.host.turnEnded?.({
            nativeId: this.#nativeId,
            turnId,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            outcome: stopped ? "cancelled" : failed || limit ? "failed" : "completed",
            ...this.#answer(startedAt, endedAt),
            usageLimit: limit,
          });
        } catch {
          // The host's bookkeeping never changes how the turn ended.
        }
      this.#publishState();
      // The session view reads the store itself when this last read fails.
      await this.#publishItems().catch(() => undefined);
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

  /**
   * Shows `view` as the usage limit the last turn met, as the host holds it. The revision stays:
   * what the notice says is not something a control was decided on.
   */
  showUsageLimit(view: UsageLimitView | null): boolean {
    if (this.#status === "running" || this.#status === "stopping") return false;
    if (JSON.stringify(view) === JSON.stringify(this.#usageLimit)) return false;
    this.#usageLimit = view ? { ...view } : null;
    this.#publishState();
    return true;
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

  /**
   * The last prompt in the history read, and the answer to it: Devin's last reply in that turn
   * that is not commentary. AgentKib's own continue is not an item, so a continued turn answers
   * under the prompt it continues.
   */
  #answer(
    startedAt: number,
    endedAt: number,
  ): Pick<
    DevinTurnEnd,
    "historyTurnId" | "answerItemId" | "observedHistoryTurnId" | "observedReplyText"
  > {
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    const newestFirst = [...this.#items].reverse();
    const prompt = newestFirst.find((item) => item.kind === "user-message");
    const historyTurnId = text(prompt?.turn_id) ?? text(prompt?.id);
    const answer = historyTurnId
      ? newestFirst.find(
          (item) =>
            item.kind === "agent-message" &&
            item.turn_id === historyTurnId &&
            item.message_phase !== "commentary",
        )
      : undefined;
    // A failure or very early stop may leave only the previous turn's history. That is still
    // the read-state anchor, but must not be quoted as this run's answer in a Worker report.
    const fresh = [prompt, answer].some((item) =>
      devinItemInTurn(item?.timestamp, startedAt, endedAt),
    );
    return {
      historyTurnId,
      answerItemId: text(answer?.id),
      ...(historyTurnId && fresh ? { observedHistoryTurnId: historyTurnId } : {}),
      ...(typeof answer?.content === "string" &&
      devinItemInTurn(answer.timestamp, startedAt, endedAt)
        ? { observedReplyText: answer.content }
        : {}),
    };
  }

  async #publishItems() {
    if (!this.#nativeId) return;
    const items = await this.host.latestItems(this.#nativeId);
    this.#items = items;
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
    // Clients merge a state event's payload into the live state they hold.
    this.host.publish("state", live, live);
  }
}
