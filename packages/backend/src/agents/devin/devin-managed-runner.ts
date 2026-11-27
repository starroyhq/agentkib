import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionPlanProgress } from "@agentkib/runtime-protocol";
import { acpObject } from "../../acp-json";
import { acpPlanUpdate } from "../../acp-plan-progress";
import { trackAcpWorkerReportPrompt } from "../../acp-worker-report-prompt";
import type { AcpPromptAttachmentSupport, AcpPromptBlock } from "../../acp-prompt-attachments";
import type { LeadToolRegistration } from "../../orchestration-endpoint";
import { sanitizeHandoffExport } from "../../session-handoff";
import { devinSessionDatabase } from "./devin-sessions";
import {
  AcpUndispatchedError,
  AntigravityAcp,
  initializeAcpProbe,
  type AcpId,
  type AcpMcpServer,
  type AcpPermission,
} from "../antigravity/antigravity-acp";
import { devinUsageLimitHit, type UsageLimitHit, type UsageLimitView } from "../../usage-limit";
import { anchorWorkerReportMessage } from "../../worker-report-ledger";

export function devinWorkerReportAnchor(
  dataDir: string,
  { sessionId, requestId }: { sessionId: string; requestId: string },
) {
  return (messageId: string) =>
    anchorWorkerReportMessage(dataDir, sessionId, requestId, {
      type: "native-message",
      // Same identity as the native history projection of chat_message.message_id.
      id: `devin-${messageId}`,
    });
}

/**
 * AgentKib runs each Devin turn through Devin CLI's ACP server (`devin acp`), which uses the
 * login `devin auth login` stored; AgentKib never reads it. Older CLIs (3000.12) refused that
 * login in ACP mode and wanted the host's API key; they are told to update. The value stays
 * `devin-print` because clients and stored receipts already name "AgentKib runs this Devin
 * session" with it.
 */
export const DEVIN_EXECUTION_MODE = "devin-print";
/** Devin's own permission modes, applied to a whole turn. */
export const DEVIN_PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"] as const;
export type DevinPermissionMode = (typeof DEVIN_PERMISSION_MODES)[number];
export const DEVIN_MAX_PROMPT_BYTES = 64 * 1024;

const POLL_MS = 1_000;
/** After `session/cancel`, the ACP process is ended if the turn has not ended by then. */
const STOP_KILL_MS = 5_000;
/** Each ACP setup step (initialize, load or new session, an option) must answer by then. */
const ACP_STEP_MS = 60_000;
const ACP_PROMPT_PROBE_MS = 3_000;
const ACP_PROMPT_CAPABILITIES_MS = 60_000;
const ACP_EVENT_MS = 1_000;
/** How AgentKib's permission modes map onto Devin's ACP session modes. */
const DEVIN_ACP_MODES: Record<DevinPermissionMode, string> = {
  auto: "ask",
  "accept-edits": "accept-edits",
  smart: "smart",
  dangerous: "bypass",
};
const MAX_APPROVAL_FIELD_BYTES = 16 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface DevinTurnSettings {
  model?: string;
  effort?: DevinModelEffort | null;
  serviceTier?: DevinModelSpeed | null;
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
  /** Associates old CLI model variants with families for ACP settings selection. */
  modelCatalog?(): Promise<DevinModelCatalog>;
  /** The newest page of a session's history, as the session readers build it. */
  latestItems(nativeId: string): Promise<Array<Record<string, unknown>>>;
  /** Devin sessions in the runner's workspace, with when each was created (ms). */
  listSessions(): Promise<Array<{ nativeId: string; createdAt: number }>>;
  /** The text of a session's first user message, to tell sessions started together apart. */
  firstUserText(nativeId: string): Promise<string | null>;
  turnEnded?(end: DevinTurnEnd): void;
  /** A turn began waiting for the person to answer a permission request. */
  waiting?(turnId: string): void;
  /**
   * This session's Project Agent worker tools. Read for every turn so it sees changes to the
   * lead's delegation.
   */
  leadTools?(): Promise<LeadToolRegistration | null>;
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
 * that usage goes to the host's account. AgentKib's `devin acp` runs with the login the CLI
 * stored instead, so the marker inherited from wherever AgentKib started is dropped.
 */
export function devinChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { ACP_BACKEND: _host, ...rest } = environment;
  return rest;
}

/** Maps what Devin said about a failed turn to a reason the UI explains; it is not kept. */
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
export const DEVIN_MODEL_SPEEDS = ["fast", "priority", "lightning"] as const;
export type DevinModelEffort = (typeof DEVIN_MODEL_EFFORTS)[number];
export type DevinModelSpeed = (typeof DEVIN_MODEL_SPEEDS)[number];

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

export function devinItemInTurn(timestamp: unknown, startedAt: number, endedAt: number) {
  const time = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  return time >= startedAt && time <= endedAt;
}

type DevinApproval = {
  id: AcpId;
  requestId: string;
  turnId: string;
  method: "session/request_permission";
  presentation: "tool" | "mcp";
  toolCall: Record<string, unknown>;
  agentDescription?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  availableDecisions: string[];
  supported: true;
};

type DevinAcpOutcome = { stopReason: string } | { error: string; code?: AcpId };

/** Reasons AgentKib names itself; anything else is what Devin said, mapped below. */
const OWN_REASONS = new Set([
  "create-permission-unconfirmed",
  "stale-or-disabled-control",
  "session-runner-unavailable",
  "devin-session-not-found",
  "devin-acp-timeout",
  "devin-run-stopped",
  "unsupported-model",
  "unsupported-effort",
  "unsupported-service-tier",
]);

/** Why a turn could not run or failed, in the reason codes clients explain. */
export function devinAcpFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (OWN_REASONS.has(message)) return message;
  // 3000.12 and older refuse the CLI's own login in ACP mode.
  if (/host has not authenticated|host-provided credentials/i.test(message))
    return "devin-cli-update-required";
  return devinRunFailure(message, 1);
}

type DevinOptionId = "model" | "thought_level" | "speed" | "mode";
type DevinOption = { current?: string; preferred?: string; choices: ReadonlySet<string> };
type DevinConfig = Partial<Record<DevinOptionId, DevinOption>>;
type DevinModelControls = {
  model: string;
  familyId: string;
  efforts?: DevinModelEffort[];
  serviceTierIds?: DevinModelSpeed[];
};
type AppliedDevinSettings = {
  settings: DevinTurnSettings;
  controls: DevinModelControls | undefined;
};

function configString(value: unknown): string | undefined {
  return typeof value === "string" && MODEL_ID.test(value) ? value : undefined;
}

function configRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configOptions(result: Record<string, unknown>): DevinConfig | undefined {
  if (!Array.isArray(result.configOptions)) return;
  const config: DevinConfig = {};
  for (const value of result.configOptions) {
    const entry = configRecord(value);
    const id = entry?.id;
    if (!entry || (id !== "model" && id !== "thought_level" && id !== "speed" && id !== "mode"))
      continue;
    const choices = new Set<string>();
    if (Array.isArray(entry.options))
      for (const value of entry.options) {
        const item = configRecord(value);
        const choice = configString(item?.value);
        if (choice) choices.add(choice);
        if (Array.isArray(item?.options))
          for (const member of item.options) {
            const choice = configString(configRecord(member)?.value);
            if (choice) choices.add(choice);
          }
      }
    config[id] = {
      current: configString(entry.currentValue),
      preferred: configString(entry.defaultValue),
      choices,
    };
  }
  return config;
}

function modelFamily(model: string, catalog: DevinModelCatalog): string {
  const known = catalog.familyOf.get(model);
  if (known) return known;
  if (catalog.variantsByFamily.has(model)) return model;
  const parts = model.split("-");
  const speed = (DEVIN_MODEL_SPEEDS as readonly string[]).includes(parts.at(-1) ?? "");
  if (speed) parts.pop();
  if ((DEVIN_MODEL_EFFORTS as readonly string[]).includes(parts.at(-1) ?? "")) parts.pop();
  return parts.join("-") || model;
}

function modelOffered(option: DevinOption | undefined, model: string): boolean {
  return option?.current === model || option?.choices.has(model) === true;
}

function advertisedAcpModel(
  option: DevinOption | undefined,
  model: string,
  family: string,
  catalog: DevinModelCatalog,
  useFamily: boolean,
) {
  if (
    catalog.variantsByFamily.has(model) &&
    option?.current &&
    modelFamily(option.current, catalog) === family
  )
    return option.current;
  if (modelOffered(option, model)) return model;
  if (useFamily) {
    if (option?.current && modelFamily(option.current, catalog) === family) return option.current;
    const familyChoices = [...(option?.choices ?? [])].filter(
      (choice) => modelFamily(choice, catalog) === family,
    );
    if (option?.preferred && familyChoices.includes(option.preferred)) return option.preferred;
    if (familyChoices.length === 1) return familyChoices[0]!;
  }
}

function selectAcpVariant(
  option: DevinOption | undefined,
  model: string,
  family: string,
  catalog: DevinModelCatalog,
  effort: DevinModelEffort | undefined,
  tier: DevinModelSpeed | null | undefined,
) {
  const candidates =
    catalog.variantsByFamily
      .get(family)
      ?.filter(
        (variant) =>
          (!effort || variant.effort === effort) &&
          (tier === undefined || variant.serviceTierId === (tier ?? undefined)) &&
          (!option?.choices.size || modelOffered(option, variant.id)),
      ) ?? [];
  const standard = candidates.filter((variant) => variant.serviceTierId === undefined);
  const choice =
    candidates.find(({ id }) => id === model) ??
    candidates.find(({ id }) => id === option?.current) ??
    (candidates.length === 1 ? candidates[0] : undefined) ??
    (tier === undefined && standard.length === 1 ? standard[0] : undefined);
  if (!choice)
    throw new Error(tier === undefined ? "unsupported-effort" : "unsupported-service-tier");
  return choice.id;
}

function confirmedSettings(config: DevinConfig): DevinTurnSettings {
  const model = config.model?.current;
  const effort = DEVIN_MODEL_EFFORTS.find((value) => value === config.thought_level?.current);
  const speed = config.speed?.current;
  const serviceTier = speed === "standard" ? null : DEVIN_MODEL_SPEEDS.find((id) => id === speed);
  const permissionMode = DEVIN_PERMISSION_MODES.find(
    (id) => DEVIN_ACP_MODES[id] === config.mode?.current,
  );
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
}

function modelControls(
  config: DevinConfig,
  catalog: DevinModelCatalog,
): DevinModelControls | undefined {
  const model = config.model?.current;
  if (!model) return;
  return {
    model,
    familyId: modelFamily(model, catalog),
    ...(config.thought_level
      ? {
          efforts: DEVIN_MODEL_EFFORTS.filter((effort) =>
            config.thought_level?.choices.has(effort),
          ),
        }
      : {}),
    ...(config.speed
      ? { serviceTierIds: DEVIN_MODEL_SPEEDS.filter((tier) => config.speed?.choices.has(tier)) }
      : {}),
  };
}

/** What a permission card shows of Devin's tool call: bounded and with secrets redacted. */
function devinToolCall(source: Record<string, unknown>, rule: string): Record<string, unknown> {
  const text = (value: unknown, limit: number) =>
    typeof value === "string" && value && !value.includes("\0")
      ? sanitizeHandoffExport(value, "markdown").slice(0, limit)
      : undefined;
  const json = (value: unknown) => {
    if (value === undefined || value === null) return undefined;
    try {
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > MAX_APPROVAL_FIELD_BYTES) return undefined;
      return JSON.parse(sanitizeHandoffExport(raw, "json")) as unknown;
    } catch {
      return undefined;
    }
  };
  const call: Record<string, unknown> = {
    toolCallId: text(source.toolCallId, 4096) ?? "[unavailable]",
    title: text(source.title, 512) ?? text(rule, 512) ?? "Devin",
  };
  for (const [key, value] of [
    ["kind", text(source.kind, 64)],
    ["rawInput", json(source.rawInput)],
    ["content", Array.isArray(source.content) ? json(source.content) : undefined],
    ["locations", Array.isArray(source.locations) ? json(source.locations) : undefined],
  ] as const)
    if (value !== undefined) call[key] = value;
  return call;
}

/**
 * One Devin session run by AgentKib. A turn is one `devin acp` process: AgentKib loads the
 * session (or starts it with the first message), sets the model and permission mode the turn
 * runs with, sends the prompt and passes Devin's permission requests to the person; the process
 * ends with the turn, so that Devin Desktop or a terminal can open the session in between.
 * Progress is read back from Devin's session store while the turn runs.
 */
export class DevinManagedRunner {
  #nativeId: string | null;
  #status: "idle" | "running" | "stopping" | "failed" = "idle";
  #revision = 0;
  #turnId: string | null = null;
  #completedTurnId: string | null = null;
  #planProgress: SessionPlanProgress | null = null;
  #reason: string | null = null;
  /** The usage limit the last turn met, until the next turn starts. */
  #usageLimit: UsageLimitView | null = null;
  #acp: AntigravityAcp | null = null;
  #acpSession: string | null = null;
  #promptAttachments?: { support: AcpPromptAttachmentSupport | undefined; expiresAt: number };
  #promptProbe?: {
    client: AntigravityAcp;
    result: Promise<AcpPromptAttachmentSupport | undefined>;
  };
  #approvals = new Map<string, DevinApproval>();
  #runningSettings: DevinTurnSettings | undefined;
  #lastSettings: DevinTurnSettings | undefined;
  #modelControls: DevinModelControls | undefined;
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

  get lastSettings(): Readonly<DevinTurnSettings> | undefined {
    return this.#lastSettings;
  }

  get modelControls(): Readonly<DevinModelControls> | undefined {
    return this.#modelControls;
  }

  /** Devin does not run an idle ACP process. Probe initialize without opening a native session. */
  async promptAttachmentSupport(): Promise<AcpPromptAttachmentSupport | undefined> {
    if (this.#closed) return undefined;
    const previous = this.#promptAttachments;
    if (previous && Date.now() < previous.expiresAt) return previous.support;
    if (this.#promptProbe) return this.#promptProbe.result;
    const executable = this.host.executable();
    if (!executable) return undefined;

    let client: AntigravityAcp;
    try {
      client = AntigravityAcp.spawn(executable, ["acp"], this.workspace, this.host.environment, {
        timeout: ACP_PROMPT_PROBE_MS,
      });
    } catch {
      return undefined;
    }
    const result = initializeAcpProbe(client, ACP_PROMPT_PROBE_MS)
      .then(
        () => client.compatibility?.promptAttachments,
        () => undefined,
      )
      .then((support) => {
        if (this.#closed) return undefined;
        // A turn may have negotiated fresher capabilities while the probe was running.
        if (this.#promptAttachments === previous)
          this.#rememberPromptAttachments(support, client.compatibility !== null);
        return this.#promptAttachments?.support;
      })
      .finally(() => {
        client.shutdown();
        this.#promptProbe = undefined;
      });
    this.#promptProbe = { client, result };
    return result;
  }

  #rememberPromptAttachments(
    support: AcpPromptAttachmentSupport | undefined,
    initialized = true,
  ): void {
    this.#promptAttachments = {
      support,
      expiresAt: Date.now() + (initialized ? ACP_PROMPT_CAPABILITIES_MS : ACP_PROMPT_PROBE_MS),
    };
  }

  get running(): boolean {
    return !this.#closed && this.#status === "running" && this.#approvals.size === 0;
  }

  snapshot(): Record<string, unknown> {
    const running = this.#status === "running" || this.#status === "stopping";
    const waiting = this.#status === "running" && this.#approvals.size > 0;
    return {
      executionMode: DEVIN_EXECUTION_MODE,
      status: this.#status === "failed" ? "idle" : waiting ? "waiting-approval" : this.#status,
      revision: this.#revision,
      turnId: this.#turnId,
      completedTurnId: this.#completedTurnId,
      planProgress: this.#planProgress,
      sendEnabled: !running && !this.#closed,
      stopEnabled: this.#status === "running",
      cancelling: this.#status === "stopping",
      approvals: [...this.#approvals.values()].map(({ id: _id, ...approval }) => approval),
      questions: [],
      reason: this.#reason,
      usageLimit: this.#usageLimit,
      usage: { available: false },
    };
  }

  /** Resolves with the new session's ID once Devin has created it, for a runner without one. */
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
    prepareInput?: (support: AcpPromptAttachmentSupport | undefined) => Promise<AcpPromptBlock[]>,
    options: { confirmPermission?: boolean; onNativeUserMessage?: (id: string) => boolean } = {},
  ): Promise<void> {
    if (this.#closed) throw new Error("session-runner-unavailable");
    if (expectedRevision !== this.#revision) throw new Error("stale-or-disabled-control");
    if (this.#status === "running" || this.#status === "stopping") throw new Error("session-busy");
    if ((!text.trim() && !prepareInput) || Buffer.byteLength(text, "utf8") > DEVIN_MAX_PROMPT_BYTES)
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
    const lead = await this.host.leadTools?.().catch(() => null);
    const mcpServers: AcpMcpServer[] = [];
    const leadToolRules = new Set<string>();
    if (lead) {
      mcpServers.push({ type: "http", name: lead.serverName, url: lead.url, headers: [] });
      for (const name of lead.toolNames) leadToolRules.add(`mcp__${lead.serverName}__${name}`);
    }
    let acp: AntigravityAcp;
    try {
      acp = AntigravityAcp.spawn(executable, ["acp"], this.workspace, this.host.environment, {
        timeout: ACP_STEP_MS,
      });
    } catch {
      throw new Error("devin-cli-unavailable");
    }
    let session: string;
    let promptId: AcpId;
    let applied: AppliedDevinSettings;
    let startedAt = 0;
    let inputRejected = false;
    try {
      await this.#step(acp, acp.initialize());
      const support = acp.compatibility?.promptAttachments;
      this.#rememberPromptAttachments(support);
      const prompt =
        prepareInput === undefined
          ? text
          : await prepareInput(support).catch((error: unknown) => {
              inputRejected = true;
              throw error;
            });
      const attached = this.#nativeId
        ? await this.#step(acp, acp.loadSession(this.#nativeId, this.workspace, mcpServers))
        : await this.#step(acp, acp.newSession(this.workspace, mcpServers));
      session = this.#nativeId ?? String(attached.sessionId ?? "");
      if (!NATIVE_ID.test(session)) throw new Error("devin-session-not-found");
      applied = await this.#applySettings(
        acp,
        session,
        attached,
        settings,
        options.confirmPermission,
      );
      if (this.#closed || expectedRevision !== this.#revision)
        throw new Error("stale-or-disabled-control");
      promptId = await acp.prompt(session, prompt, () => {
        beforeDispatch();
        startedAt = Date.now();
      });
    } catch (error) {
      acp.shutdown();
      // Once the prompt went out, what happened to it is not known.
      if (startedAt || inputRejected || error instanceof AcpUndispatchedError) throw error;
      throw new Error(devinAcpFailure(error), { cause: error });
    }
    this.#acp = acp;
    this.#acpSession = session;
    if (!this.#nativeId) {
      this.#nativeId = session;
      for (const found of this.#found.splice(0)) found(session);
      this.#ended = [];
    }
    this.#runningSettings = applied.settings;
    this.#lastSettings = applied.settings;
    this.#modelControls = applied.controls;
    this.#status = "running";
    this.#reason = null;
    this.#usageLimit = null;
    this.#approvals.clear();
    this.#turnId = randomUUID();
    this.#planProgress = null;
    this.#revision++;
    this.#publishState();
    const previousItems = this.#items;
    const reportPrompt =
      options.onNativeUserMessage && !prepareInput
        ? {
            matcher: trackAcpWorkerReportPrompt(text, (id) =>
              previousItems.some((item) => item.id === `devin-${id}`),
            ),
            anchor: options.onNativeUserMessage,
          }
        : undefined;
    this.#timer = setInterval(() => void this.#publishItems().catch(() => undefined), POLL_MS);
    void this.#consume(acp, promptId, startedAt, leadToolRules, reportPrompt);
  }

  async stop(turnId: string, expectedRevision: number, beforeDispatch: () => void) {
    if (expectedRevision !== this.#revision) throw new Error("stale-or-disabled-control");
    const acp = this.#acp;
    const session = this.#acpSession;
    if (this.#status !== "running" || !acp || !session || turnId !== this.#turnId)
      throw new Error("session-not-running");
    beforeDispatch();
    this.#status = "stopping";
    this.#approvals.clear();
    this.#revision++;
    this.#publishState();
    void acp.cancel(session).catch(() => acp.shutdown());
    setTimeout(() => this.#acp === acp && acp.shutdown(), STOP_KILL_MS).unref();
  }

  /** Answers a permission request Devin made in this turn with one of the offered options. */
  async approve(
    requestId: string,
    turnId: string,
    optionId: string,
    expectedRevision: number,
    beforeDispatch?: () => void,
  ) {
    if (expectedRevision !== this.#revision) throw new Error("stale-or-disabled-control");
    const approval = this.#approvals.get(requestId);
    const acp = this.#acp;
    if (!approval || !acp || approval.turnId !== turnId || turnId !== this.#turnId)
      throw new Error("approval-unavailable");
    if (!approval.availableDecisions.includes(optionId))
      throw new Error("approval-option-unavailable");
    beforeDispatch?.();
    await acp.respondPermission(approval.id, optionId);
    this.#approvals.delete(requestId);
    this.#revision++;
    this.#publishState();
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
    this.#lastSettings = undefined;
    this.#revision++;
    this.#publishState();
  }

  close() {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#acp?.shutdown();
    this.#promptProbe?.client.shutdown();
  }

  async #applySettings(
    acp: AntigravityAcp,
    session: string,
    attached: Record<string, unknown>,
    settings: DevinTurnSettings,
    confirmPermission = false,
  ): Promise<AppliedDevinSettings> {
    let config = configOptions(attached) ?? {};
    // An option change can reset other settings. Only the latest native readback confirms mode.
    let confirmedMode = config.mode?.current;
    let catalog = emptyDevinModelCatalog();
    const set = async (id: DevinOptionId, value: string) => {
      const verify = id === "mode" && confirmPermission;
      if ((verify ? confirmedMode : config[id]?.current) === value) return;
      let result: Record<string, unknown>;
      try {
        result = await this.#step(acp, acp.setConfigOption(session, id, value));
      } catch (error) {
        if (verify) throw new Error("create-permission-unconfirmed", { cause: error });
        throw error;
      }
      const updated = configOptions(result);
      confirmedMode = updated?.mode?.current;
      if (verify && confirmedMode !== value) throw new Error("create-permission-unconfirmed");
      config = updated ?? config;
      const confirmed = updated?.[id];
      if (confirmed?.current && confirmed.current !== value && confirmed.choices.size) {
        const reason = {
          model: "unsupported-model",
          thought_level: "unsupported-effort",
          speed: "unsupported-service-tier",
          mode: "devin-run-failed",
        }[id];
        throw new Error(reason);
      }
      // Some acknowledgements do not repeat options. Keep the acknowledged value in that case.
      if (!confirmed?.current)
        config[id] = { choices: config[id]?.choices ?? new Set(), current: value };
    };
    if (settings.model || settings.effort || settings.serviceTier !== undefined) {
      catalog = (await this.host.modelCatalog?.()) ?? catalog;
      const requested = settings.model ?? config.model?.current;
      if (!requested) throw new Error("unsupported-model");
      const family = modelFamily(requested, catalog);
      const old =
        settings.model && !catalog.variantsByFamily.has(requested)
          ? devinModelVariant(catalog, requested)
          : undefined;
      const offered = modelOffered(config.model, requested);
      const suffix =
        settings.model && !offered && family !== requested
          ? devinVariantControls(requested, [family])
          : {};
      const base = advertisedAcpModel(
        config.model,
        requested,
        family,
        catalog,
        requested === family || !!old || !!suffix.effort || !!suffix.serviceTierId,
      );
      if (base) await set("model", base);
      // A model change can add the independent options or replace their choices.
      const effort =
        settings.effort === null
          ? undefined
          : (settings.effort ?? old?.effort ?? (config.thought_level ? suffix.effort : undefined));
      const tier =
        settings.serviceTier !== undefined
          ? settings.serviceTier
          : (old?.serviceTierId ?? (config.speed ? suffix.serviceTierId : undefined));
      const variantEffort = config.thought_level ? undefined : effort;
      const variantTier = config.speed ? undefined : tier;
      if (variantEffort || variantTier !== undefined) {
        await set(
          "model",
          selectAcpVariant(config.model, requested, family, catalog, variantEffort, variantTier),
        );
      } else if (!base) {
        // Some older responses have no model choices. Let that CLI validate an exact ID.
        if (config.model?.choices.size || catalog.variantsByFamily.has(requested))
          throw new Error("unsupported-model");
        await set("model", requested);
      }
      if (effort && (config.thought_level || !variantEffort)) {
        if (!modelOffered(config.thought_level, effort)) throw new Error("unsupported-effort");
        await set("thought_level", effort);
      }
      if (tier !== undefined && (config.speed || variantTier === undefined)) {
        const speed = tier ?? "standard";
        if (!modelOffered(config.speed, speed)) throw new Error("unsupported-service-tier");
        await set("speed", speed);
      }
    }
    if (settings.permissionMode) await set("mode", DEVIN_ACP_MODES[settings.permissionMode]);
    return { settings: confirmedSettings(config), controls: modelControls(config, catalog) };
  }

  /** Sends one setup request and waits for its answer; other traffic before it is not the turn's. */
  async #step(acp: AntigravityAcp, request: Promise<AcpId>): Promise<Record<string, unknown>> {
    const id = await request;
    const deadline = Date.now() + ACP_STEP_MS;
    for (;;) {
      const event = await acp.nextEvent(Math.max(1, deadline - Date.now()));
      if (!event) throw new Error("devin-acp-timeout");
      // Loading a session replays its history as updates; AgentKib reads history from the store.
      if (event.type === "permission") await acp.respondPermission(event.id, null);
      if (event.type !== "response" || event.id !== id) continue;
      if (event.error) throw new Error(event.error.message);
      return acpObject(event.result);
    }
  }

  async #consume(
    acp: AntigravityAcp,
    promptId: AcpId,
    startedAt: number,
    leadToolRules: ReadonlySet<string>,
    reportPrompt?: {
      matcher: ReturnType<typeof trackAcpWorkerReportPrompt>;
      anchor(id: string): boolean;
    },
  ) {
    let outcome: DevinAcpOutcome = { error: "devin-run-failed" };
    try {
      for (;;) {
        const event = await acp.nextEvent(ACP_EVENT_MS);
        if (!event) continue;
        if (event.type === "permission") {
          await this.#permission(acp, event.id, event.request, leadToolRules);
          continue;
        }
        if (event.type === "permission-cancelled") continue;
        if (
          event.type === "session-update" &&
          event.sessionId === this.#acpSession &&
          this.#status === "running" &&
          this.#turnId
        ) {
          reportPrompt?.matcher.observe(event.update);
          const plan = acpPlanUpdate(event.update, this.#turnId, this.#planProgress);
          if (plan) {
            this.#planProgress = plan;
            this.#revision++;
            this.#publishState();
          }
        }
        if (event.type === "response" && event.id === promptId) {
          const messageId = reportPrompt?.matcher.match();
          if (messageId && reportPrompt?.anchor(messageId)) this.#published = "";
          outcome = event.error
            ? { error: event.error.message, code: event.error.code }
            : { stopReason: String(acpObject(event.result).stopReason ?? "end_turn") };
          break;
        }
      }
    } catch {
      // Devin's process ended without answering the prompt.
      outcome = { error: "devin-run-stopped" };
    }
    acp.shutdown();
    await this.#finish(outcome, startedAt);
  }

  async #permission(
    acp: AntigravityAcp,
    id: AcpId,
    request: AcpPermission,
    leadToolRules: ReadonlySet<string>,
  ) {
    const toolCall = request.toolCall as Record<string, unknown>;
    const meta =
      toolCall._meta && typeof toolCall._meta === "object"
        ? (toolCall._meta as Record<string, unknown>)
        : {};
    const rule =
      typeof meta["cognition.ai/permissionRule"] === "string"
        ? meta["cognition.ai/permissionRule"]
        : "";
    const once = request.options.find((option) => option.kind === "allow_once");
    const reject = request.options.find((option) => option.kind === "reject_once");
    // Designating the session a Project Agent grants the worker tools registered for this turn.
    if (once && leadToolRules.has(rule)) {
      await acp.respondPermission(id, once.optionId);
      return;
    }
    // Only answers for this one call are offered: Devin's "always" choices change its config.
    const choices = [once, reject].filter((option) => option !== undefined);
    const turnId = this.#turnId;
    if (!choices.length || turnId === null || this.#status !== "running") {
      await acp.respondPermission(id, null);
      return;
    }
    const requestId = typeof id === "bigint" ? id.toString() : id;
    const presented = devinToolCall(toolCall, rule);
    this.#approvals.set(requestId, {
      id,
      requestId,
      turnId,
      method: "session/request_permission",
      presentation: rule.startsWith("mcp__") ? "mcp" : "tool",
      toolCall: presented,
      // Legacy title can fall back to a permission rule or redact parts of the native text.
      ...(typeof toolCall.title === "string" && presented.title === toolCall.title
        ? { agentDescription: toolCall.title }
        : {}),
      options: choices.map(({ optionId, name, kind }) => ({
        optionId,
        name: sanitizeHandoffExport(name, "markdown").slice(0, 512),
        kind,
      })),
      availableDecisions: choices.map((option) => option.optionId),
      supported: true,
    });
    this.#revision++;
    this.#publishState();
    try {
      this.host.waiting?.(turnId);
    } catch {
      // The host's bookkeeping never changes the turn.
    }
  }

  async #finish(outcome: DevinAcpOutcome, startedAt: number) {
    const endedAt = Date.now();
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#publishItems().catch(() => undefined);
    const stopped =
      this.#status === "stopping" ||
      ("stopReason" in outcome && outcome.stopReason === "cancelled");
    const error = "error" in outcome ? outcome.error : null;
    const code = "error" in outcome && outcome.code !== undefined ? `${outcome.code} ` : "";
    // Devin's words name the limit; only the error code may say it when they do not.
    const limit =
      stopped || error === null
        ? null
        : (devinUsageLimitHit(error) ?? (code ? devinUsageLimitHit(`${code}${error}`) : null));
    const refused = "stopReason" in outcome && outcome.stopReason === "refusal";
    const failed = !stopped && !limit && (error !== null || refused);
    this.#acp = null;
    this.#acpSession = null;
    this.#approvals.clear();
    this.#runningSettings = undefined;
    this.#status = failed ? "failed" : "idle";
    this.#reason = failed ? (error !== null ? devinAcpFailure(error) : "devin-run-failed") : null;
    // Devin says no reset time: the notice says so until the host learns more
    // (docs/agents/usage-limits.md).
    this.#usageLimit = limit
      ? { ...limit, agent: "devin", continueAt: null, manual: "reset-unknown", autoContinues: 0 }
      : null;
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
