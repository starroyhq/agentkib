import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DSH_BRIDGE_PATHS,
  DSH_BRIDGE_PLUGIN_VERSION,
  DSH_BRIDGE_PROTOCOL,
  dshBridgeCompatibility,
  dshBridgePluginCompatibility,
  type DshBridgeAgentPreset,
  type DshBridgeCommand,
  type DshBridgeCommandEntry,
  type DshBridgeDocumentRecord,
  type DshBridgeHistoryPage,
  type DshBridgeHistoryRecord,
  type DshBridgeInteraction,
  type DshBridgePromptPart,
  type DshBridgeServices,
  type DshBridgeSessionState,
  type DshBridgeSessionSummary,
  type SessionStreamEvent,
} from "@agentkib/runtime-protocol";
import { acquirePortableFileLease } from "./managed-session-lock";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  readUnknownManagedCommands,
  replayManagedCommand,
} from "./managed-ledger";
import { dshSessionDocument, type DshDocumentImage } from "./dsh-document";
import type { DshManagedRuntime } from "./dsh-managed-runtime";
import { sanitizeSessionText } from "./session-handoff";
import type { DocumentSource } from "./session-document-providers";
import type { ConversationEvent, ConversationEventPage } from "./session-events";
import { decodedSessionImage, sessionImageResult } from "./session-images";
import type { DocumentOptions, SessionDocument } from "./session-model";
import type { NativeSession } from "./session-store";

const MAX_BODY = 8 * 1024 * 1024;
const OFFLINE_MS = 45_000;
/** A plugin that drops its poll and does not poll again this soon has gone (DSH quit). */
const DISCONNECT_GRACE_MS = 3_000;
const POLL_MS = 20_000;
const HISTORY_TIMEOUT_MS = 15_000;
/** DSH lists its Agent presets from memory; the new-task form waits for them. */
const PRESETS_TIMEOUT_MS = 5_000;
/** History read in this run, served while no DSH can be asked. Memory only. */
const PAGE_CACHE_CHARS = 16 * 1024 * 1024;
/** How often a session with unconfirmed commands asks its DSH again. */
const RECONCILE_INTERVAL_MS = 10_000;
/** After this long, a command DSH shows no trace of, and no longer works on, did not run. */
const RECONCILE_GIVE_UP_MS = 2 * 60_000;
const MAX_RUNTIMES = 8;
/** A DSH that AgentKib started stops after this long with nothing to do. */
const MANAGED_IDLE_MS = 3 * 60_000;
/** Sooner while DSH Desktop's window is open, so Desktop can continue what it resumed. */
const MANAGED_DESKTOP_IDLE_MS = 60_000;
/** Until its plugin has registered and listed the sessions. */
const MANAGED_START_TIMEOUT_MS = 30_000;
/**
 * After a command reaches it, the background DSH counts as busy this long: the plugin reports the
 * turn a command started a moment later, and stopping in between would end that turn.
 */
const MANAGED_SETTLE_MS = 10_000;
/** Controls that can start DSH: the ones a session offers while no DSH runs. */
const STARTING_CONTROLS = new Set(["send", "rename", "fork"]);
const CATALOG_LIMIT = 4096;
const CURSOR_PREFIX = "dsh-v1:";
export const DSH_EXECUTION_MODE = "dsh-follower";
const LOCAL_OWNER = "agentkib-local-owner";
/** The device a handoff's DSH session is recorded under; it is started on this computer. */
const HANDOFF_DEVICE = "agentkib-handoff";
/** A UUID named after a value, so a request made again for the same thing keeps its identity. */
function namedUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const uuid = z.string().uuid();
const nativeIdSchema = z.string().min(1).max(256);
const catalogRowSchema = z
  .object({
    id: nativeIdSchema,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(1024).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    parentSessionId: z.string().max(256).nullable(),
    origin: z.literal("subagent").nullable(),
    // Absent in caches written before archive support.
    archived: z.boolean().optional(),
  })
  .strict();
type CatalogRow = z.infer<typeof catalogRowSchema>;

const summarySchema = z
  .object({
    sessionId: nativeIdSchema,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(1024).nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    running: z.boolean(),
    live: z.boolean(),
    blank: z.boolean(),
    parentSessionId: z.string().max(256).nullable(),
    origin: z.literal("subagent").nullable(),
    archived: z.boolean().optional(),
  })
  .strip();
const modelPartSchema = z.string().min(1).max(128);
const selectionSchema = z
  .object({
    provider: modelPartSchema,
    model: modelPartSchema,
    reasoningEffort: modelPartSchema.nullable(),
  })
  .strip();
const modelsSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            provider: modelPartSchema,
            providerName: z.string().max(128),
            model: modelPartSchema,
            name: z.string().max(256),
            efforts: z
              .array(z.object({ id: modelPartSchema, name: z.string().max(128) }).strip())
              .max(16),
            defaultEffort: modelPartSchema.nullable(),
          })
          .strip(),
      )
      .max(64),
    default: selectionSchema.nullable(),
    selected: selectionSchema.nullable(),
  })
  .strip();
type DshModels = z.infer<typeof modelsSchema>;
/**
 * One DSH model as a single picker ID. Both parts are URI-encoded, so a "/" inside a provider or
 * model name cannot be mistaken for the separator.
 */
const modelId = (provider: string, model: string) =>
  `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
function parseModelId(value: unknown): { provider: string; model: string } | null {
  if (typeof value !== "string") return null;
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) return null;
  try {
    return {
      provider: decodeURIComponent(value.slice(0, index)),
      model: decodeURIComponent(value.slice(index + 1)),
    };
  } catch {
    return null;
  }
}
const stateSchema = z
  .object({
    sessionId: nativeIdSchema,
    live: z.boolean(),
    status: z.enum(["idle", "running"]),
    turn: z.number().int().nonnegative().nullable(),
    cursor: z.number().int().min(-1),
    queue: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            placement: z.enum(["queued", "steering"]),
            text: z.string().max(8192),
            images: z.number().int().nonnegative().max(64),
            rpcId: z.string().max(256).nullable(),
          })
          .strip(),
      )
      .max(64),
    streamText: z.string().max(256 * 1024),
    streamTruncated: z.boolean(),
    pending: z.number().int().nonnegative().max(64),
    activity: z.literal("compacting").nullable().default(null),
    goal: z
      .object({
        id: z.string().min(1).max(256),
        revision: z.number().int().positive(),
        phase: z.enum(["active", "paused", "blocked", "complete"]),
        activation: z.enum(["armed", "disarmed"]),
      })
      .strip()
      .nullable()
      .default(null),
  })
  .strip();
const commandEntrySchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    description: z.string().max(512),
    hint: z.string().max(256).nullable(),
    attachments: z.boolean(),
  })
  .strip();
const goalSchema = z
  .object({
    id: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    objective: z.string().max(64 * 1024),
    phase: z.enum(["active", "paused", "blocked", "complete"]),
    blockedReason: z
      .object({ code: z.string().max(128), message: z.string().max(4096) })
      .strip()
      .nullable(),
    maxGoalRounds: z.number().int().nonnegative(),
    roundsStarted: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative().nullable(),
    updatedAt: z.number().int().nonnegative().nullable(),
    activation: z.enum(["armed", "disarmed"]),
  })
  .strip();
const permissionsSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            value: z.string().min(1).max(128),
            name: z.string().max(128),
            description: z.string().max(512).nullable(),
          })
          .strip(),
      )
      .max(32),
    current: z.string().max(128).nullable(),
    /** DSH's `plan` projection view; plugins older than 0.4.0 do not report it. */
    plan: z.object({ active: z.boolean(), pending: z.boolean() }).strip().nullable().optional(),
  })
  .strip();
type DshPermissions = z.infer<typeof permissionsSchema>;
/**
 * The plan mode a session selected, as DSH's composer chip shows it: a switch made with `/plan`
 * counts at once, though DSH applies it at the next step.
 */
function planSelected(plan: DshPermissions["plan"]): boolean | null {
  return plan ? (plan.pending ? !plan.active : plan.active) : null;
}
const subagentsSchema = z
  .object({
    agents: z
      .array(
        z
          .object({
            sessionId: nativeIdSchema,
            createdAt: z.number().int().nonnegative().nullable(),
            mode: z.enum(["one-shot", "external", "continuable", "unknown"]),
            label: z.string().max(256).nullable(),
            status: z.enum(["running", "completed", "stopped", "unknown"]),
          })
          .strip(),
      )
      .max(64),
    truncated: z.boolean(),
  })
  .strip();
const questionSchema = z
  .object({
    id: z.string().min(1).max(256),
    question: z.string().max(8192),
    header: z.string().max(512).nullable(),
    detail: z
      .string()
      .max(128 * 1024)
      .nullable(),
    multiSelect: z.boolean(),
    options: z
      .array(
        z.object({ label: z.string().max(1024), description: z.string().max(2048).nullable() }),
      )
      .max(32),
    intent: z
      .union([
        z.object({ kind: z.literal("plan-review"), approve: z.string().max(1024) }).strip(),
        z
          .object({
            kind: z.literal("approval"),
            approve: z.string().max(1024),
            reject: z.string().max(1024),
            always: z.string().max(1024).optional(),
          })
          .strip(),
      ])
      .nullable(),
  })
  .strip();
const interactionSchema = z.union([
  z
    .object({
      id: uuid,
      sessionId: nativeIdSchema,
      createdAt: z.number().int().nonnegative(),
      kind: z.literal("approval"),
      toolName: z.string().max(512),
      callId: z.string().max(256).nullable(),
      reason: z.string().max(8192).nullable(),
      displayReason: z.record(z.string().max(32), z.string().max(8192)).nullable(),
      arguments: z.string().max(8192).nullable(),
    })
    .strip(),
  z
    .object({
      id: uuid,
      sessionId: nativeIdSchema,
      createdAt: z.number().int().nonnegative(),
      kind: z.literal("question"),
      questions: z.array(questionSchema).min(1).max(8),
    })
    .strip(),
]);
const servicesSchema = z
  .object({
    sessionController: z.boolean(),
    sessionQuery: z.boolean(),
    approvals: z.boolean(),
    questions: z.boolean(),
    workspaceController: z.boolean().optional(),
    modelCatalog: z.boolean().optional(),
    images: z.boolean().optional(),
    goals: z.boolean().optional(),
    commands: z.boolean().optional(),
    permissions: z.boolean().optional(),
    subagents: z.boolean().optional(),
    documents: z.boolean().optional(),
    agentPresets: z.boolean().optional(),
  })
  .strip();
const registerSchema = z
  .object({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    protocol: z.number(),
    pluginVersion: z.string().max(64),
    dshVersion: z.string().max(64),
    runtimeId: uuid,
    pid: z.number().int().positive(),
    services: servicesSchema,
  })
  .strip();
const reportSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    services: servicesSchema.optional(),
    sessions: z.array(summarySchema).max(CATALOG_LIMIT).optional(),
    states: z.array(stateSchema).max(512).optional(),
    interactions: z.array(interactionSchema).max(64).optional(),
    historyChanged: z.array(nativeIdSchema).max(512).optional(),
    commands: z.array(commandEntrySchema).max(128).optional(),
    sessionCommands: z
      .array(
        z
          .object({
            sessionId: nativeIdSchema,
            commands: z.array(commandEntrySchema).max(128).nullable(),
          })
          .strip(),
      )
      .max(512)
      .optional(),
    goalChanged: z.array(nativeIdSchema).max(512).optional(),
    settingsChanged: z.array(nativeIdSchema).max(512).optional(),
  })
  .strip();
const resultSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/),
    commandId: uuid,
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(256).optional(),
  })
  .strip();
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** A message with attachments, as the Host's attachment store builds it for DSH. */
const promptContentSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string().max(16_384) }).strict(),
      z
        .object({
          type: z.literal("image"),
          path: z
            .string()
            .min(1)
            .max(4096)
            .refine((value) => path.isAbsolute(value)),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          size: z
            .number()
            .int()
            .positive()
            .max(25 * 1024 * 1024),
          mediaType: z.enum(IMAGE_TYPES),
          name: z.string().min(1).max(255),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(32);
/** One image a history record names; anything else is dropped rather than shown. */
const historyImageSchema = z
  .object({
    attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.enum(IMAGE_TYPES),
    name: z.string().max(255).nullable(),
  })
  .strip();
const documentBase = {
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative().nullable(),
  current: z.boolean(),
  position: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
};
// The plugin's own bounds (`dsh-bridge-plugin/projection.js`).
const documentText = z.string().max(256 * 1024);
const documentPageSchema = z
  .object({
    sessionId: nativeIdSchema,
    revision: z.number().int().nonnegative().nullable(),
    records: z
      .array(
        z.discriminatedUnion("kind", [
          z
            .object({
              ...documentBase,
              kind: z.literal("user"),
              text: documentText,
              images: z.array(historyImageSchema).max(32),
              files: z.number().int().nonnegative().max(1024),
            })
            .strip(),
          z
            .object({
              ...documentBase,
              kind: z.literal("assistant"),
              text: documentText,
              calls: z
                .array(
                  z
                    .object({
                      id: z.string().max(256),
                      name: z.string().max(256),
                      arguments: z.string().max(64 * 1024),
                      truncated: z.boolean(),
                    })
                    .strip(),
                )
                .max(64),
              reasoning: z.boolean(),
            })
            .strip(),
          z
            .object({
              ...documentBase,
              kind: z.literal("tool-result"),
              callId: z.string().max(256),
              isError: z.boolean(),
              text: z.string().max(128 * 1024),
              images: z.number().int().nonnegative().max(1024),
            })
            .strip(),
          z.object({ ...documentBase, kind: z.literal("summary"), text: documentText }).strip(),
        ]),
      )
      .max(100_000),
    nextAfter: z.number().int().nonnegative().nullable(),
  })
  .strip();
/** Pages of one conversation read for a handoff or search: at most 64 pages of 3 MiB. */
const DOCUMENT_PAGE_LIMIT = 64;
/** Images a handoff document carries inline; the rest are named as left in DSH. */
const DOCUMENT_IMAGE_LIMIT = 32;
const DOCUMENT_IMAGE_CHARS = 32 * 1024 * 1024;
const presetsSchema = z
  .object({
    presets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: z.string().max(256).nullable(),
            description: z.string().max(1024).nullable(),
            isDefault: z.boolean(),
            broken: z.string().max(512).nullable(),
          })
          .strip(),
      )
      .max(32),
  })
  .strip();
const IMAGE_ID_PREFIX = "dsh-image-v1-";
/**
 * DSH reports only the keys of its built-in permission presets; AgentKib names them the way it
 * names Codex's execution policies. A preset configured with a name of its own keeps it.
 */
const PRESET_NAMES: Record<string, { name: string; description: string }> = {
  "read-only": {
    name: "Read only · ask when needed",
    description: "Can read the workspace; changes and other actions require user approval.",
  },
  "workspace-write": {
    name: "Workspace write · ask when needed",
    description:
      "Can write inside the workspace and permitted temporary directories; wider access requires user approval.",
  },
  "danger-full-access": {
    name: "Full access · no approval prompts",
    description: "Can access all files and run commands without prompting for approvals.",
  },
  auto: {
    name: "Auto review · experimental",
    description:
      "Runs without a sandbox; the same model reviews each tool call first, and the user decides the calls it denies.",
  },
};
function presetPresentation(option: DshPermissions["options"][number]): {
  name: string;
  description?: string;
} {
  if (Object.hasOwn(PRESET_NAMES, option.value) && option.name === option.value)
    return PRESET_NAMES[option.value]!;
  return {
    name: option.name || option.value,
    ...(option.description ? { description: option.description } : {}),
  };
}

type Command = DshBridgeCommand;
type CommandWaiter = {
  command: Command;
  delivered: boolean;
  settle(result: { ok: boolean; value?: unknown; error?: string; outcome?: "timeout" }): void;
  timer: ReturnType<typeof setTimeout>;
  onDelivered?: () => void;
};
type Runtime = {
  token: string;
  runtimeId: string;
  dshVersion: string;
  pluginVersion: string;
  pid: number;
  /** Started by this AgentKib in the background; used only when no DSH of the user's can serve. */
  managed: boolean;
  services: DshBridgeServices;
  lastSeen: number;
  /** When this runtime last reported its session list; 0 before the first. */
  listedAt: number;
  /** When this runtime last reported anything; 0 before the first report. */
  reportedAt: number;
  summaries: Map<string, DshBridgeSessionSummary>;
  states: Map<string, DshBridgeSessionState>;
  interactions: Map<string, DshBridgeInteraction>;
  /** DSH's slash commands for every session, and each running agent's own list. */
  slashCommands: DshBridgeCommandEntry[];
  sessionCommands: Map<string, DshBridgeCommandEntry[]>;
  queue: Command[];
  waiting?: () => void;
  commands: Map<string, CommandWaiter>;
};
type Inflight = { requestId: string; commandId: string; runtime: string };

export interface DshBridgeOptions {
  dataDir: string;
  bootId: string;
  /** Unpacked plugin directory shipped with the application; shown in install instructions. */
  pluginDirectory: string;
  /** Per-user file where plugins find this Runtime; the key rotates with every start. */
  discoveryFile?: string;
  platform?: NodeJS.Platform;
  /** The AgentKib session ID for one native DSH session. */
  sessionId(nativeId: string): string;
  /** The innermost registered workspace containing `cwd`, or null. */
  workspaceFor(cwd: string): { id: string; path: string } | null;
  /** The root of a registered workspace, where a new DSH session starts; null if unknown. */
  workspacePath?(workspaceId: string): string | null;
  /** DSH sessions or the runtimes serving them changed in these workspaces; refresh listings. */
  sessionsChanged(workspaceIds: string[]): void;
  publish(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ): void;
  commandTimeoutMs?: number;
  disconnectGraceMs?: number;
  reconcileIntervalMs?: number;
  reconcileGiveUpMs?: number;
  /**
   * Starting DSH in the background when no running DSH can take a session (phase 3). Without it
   * DSH sessions continue only in a DSH the user runs.
   */
  managed?: {
    runtime: Pick<
      DshManagedRuntime,
      "pid" | "available" | "status" | "start" | "started" | "stop" | "desktopRunning"
    >;
    /** The user's setting, read before every start. */
    enabled(): boolean;
    idleMs?: number;
    /** Idle time while DSH Desktop's own window is open. */
    desktopIdleMs?: number;
    startTimeoutMs?: number;
    /** How often to check whether the background DSH should stop. */
    reviewMs?: number;
    /** How long a command keeps the background DSH busy. */
    settleMs?: number;
  };
}

/** DSH's refusals that clients explain in their own words. */
const dshRefusal = (error: string | undefined) =>
  error === "session/writer-held" ? "dsh-session-in-use" : error;

function privatePath(value: string, directory = false): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error("unsafe-dsh-bridge-path");
  for (let current = value; ; current = path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("unsafe-dsh-bridge-path");
    if (path.dirname(current) === current) break;
  }
  if (directory) {
    mkdirSync(value, { recursive: true, mode: 0o700 });
    const stat = lstatSync(value);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("unsafe-dsh-bridge-owner");
    chmodSync(value, 0o700);
  }
}
function privateJson(file: string, value: unknown): void {
  privatePath(path.dirname(file), true);
  privatePath(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const canonical = (value: string) => {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);
const turnIdOf = (turn: number | null | undefined) =>
  typeof turn === "number" ? `dsh-turn-${turn}` : null;
/** Messages waiting for the next turn. Steering is already part of the running turn. */
const queuedFor = (state: DshBridgeSessionState | null | undefined) =>
  (state?.queue ?? []).filter((item) => item.placement === "queued");
/**
 * Why DSH's goal service refused a change. It checks the goal's own revision, so a goal changed
 * meanwhile in DSH's window is refused rather than overwritten.
 */
const goalRefusal = (error: string | undefined) =>
  error === "GOAL_STALE_REVISION" || error === "GOAL_NOT_FOUND" || error === "GOAL_ALREADY_EXISTS"
    ? "goal-changed"
    : error === "GOAL_INVALID_TRANSITION"
      ? "goal-action-unavailable"
      : error === "GOAL_INVALID_OBJECTIVE"
        ? "invalid-objective"
        : error;
/** The reason a control was refused before it reached DSH. */
const preflightReason = (error: unknown) =>
  error instanceof z.ZodError
    ? "invalid-managed-control"
    : error instanceof Error
      ? error.message
      : "control-unavailable";
/** What a control is decided on; streamed text and the history cursor are progress. */
const controlView = (state: DshBridgeSessionState | null | undefined) =>
  state
    ? {
        live: state.live,
        status: state.status,
        turn: state.turn,
        queue: state.queue,
        pending: state.pending,
        activity: state.activity ?? null,
        // A goal changed in DSH's own window makes the goal controls read it again.
        goal: state.goal ?? null,
      }
    : null;
const iso = (time: number | null) =>
  typeof time === "number" && Number.isFinite(time) ? new Date(time).toISOString() : null;

class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

/**
 * Converts one page of DSH history records into conversation items. Tool calls pair with their
 * results by call ID; injected context and hidden reasoning never reach this point.
 */
export function dshConversationEvents(
  records: readonly DshBridgeHistoryRecord[],
): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  const calls = new Map<string, { name: string; index: number }>();
  let turn: number | null = null;
  const base = (record: DshBridgeHistoryRecord) => ({
    timestamp: iso(record.time),
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
  });
  for (const record of records) {
    switch (record.kind) {
      case "turn-start":
        turn = record.turn;
        break;
      case "turn-end":
        turn = null;
        break;
      case "user": {
        // Each image is read on demand through the session (`DshBridge.image`), as other
        // agents' history images are; the ID names DSH's stored copy.
        const images = new Map<string, NonNullable<ConversationEvent["images"]>[number]>();
        for (const value of Array.isArray(record.images) ? record.images : []) {
          const image = historyImageSchema.safeParse(value);
          if (!image.success) continue;
          const id = IMAGE_ID_PREFIX + image.data.attachmentId.slice("sha256:".length);
          const name = image.data.name?.replace(/[\p{Cc}\p{Cf}]/gu, "");
          images.set(id, { id, mimeType: image.data.mediaType, ...(name ? { name } : {}) });
        }
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "user-message",
          ...(turnIdOf(turn) ? { turn_id: turnIdOf(turn)! } : {}),
          content: sanitizeSessionText(record.text, { value: 0 }),
          attachment_count: images.size + record.files,
          ...(images.size ? { images: [...images.values()] } : {}),
          truncated: record.truncated,
        });
        break;
      }
      case "assistant":
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "agent-message",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: sanitizeSessionText(record.text, { value: 0 }),
          truncated: record.truncated,
        });
        break;
      case "tool-call": {
        calls.set(record.callId, { name: record.name, index: events.length });
        events.push({
          ...base(record),
          id: `dsh-tool:${record.callId}`,
          kind: "tool-summary",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: null,
          tool_name: sanitizeSessionText(record.name, { value: 0 }),
          tool_status: "running",
        });
        break;
      }
      case "tool-result": {
        const call = calls.get(record.callId);
        const item: ConversationEvent = {
          ...base(record),
          id: `dsh-tool:${record.callId}`,
          kind: "tool-summary",
          ...(turnIdOf(record.turn) ? { turn_id: turnIdOf(record.turn)! } : {}),
          content: record.preview ? sanitizeSessionText(record.preview, { value: 0 }) : null,
          tool_name: call ? sanitizeSessionText(call.name, { value: 0 }) : null,
          tool_status: record.isError ? "failed" : "completed",
          truncated: record.truncated,
        };
        if (call) events[call.index] = { ...item, timestamp: events[call.index]!.timestamp };
        else events.push(item);
        break;
      }
      // A slash command reads as what the person typed, and DSH's answer as text DSH wrote
      // itself, the way a Claude Code local command and its output read.
      case "command":
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "user-message",
          content: sanitizeSessionText(`/${record.name}${record.args ?? ""}`, { value: 0 }),
        });
        break;
      case "command-result":
        if (!record.text?.trim()) break;
        events.push({
          ...base(record),
          id: `dsh:${record.seq}`,
          kind: "agent-message",
          content: sanitizeSessionText(record.text, { value: 0 }),
          cli_output: true,
        });
        break;
    }
  }
  return events;
}

/**
 * A borrowed DeepSeek Harness execution host. Every DSH process with the AgentKib plugin
 * registers here; closing this broker never signals a DSH process.
 */
export class DshBridge {
  readonly root: string;
  #runtimes = new Map<string, Runtime>();
  #catalog = new Map<string, CatalogRow>();
  /** Canonical working directories, resolved once per row instead of on every listing. */
  #cwds = new Map<string, string>();
  #ids = new Map<string, string>();
  #revisions = new Map<string, number>();
  #inflight = new Map<string, Inflight>();
  /**
   * The model catalog last read for each session. A settings change always reads it first, so
   * the current model is known when only the reasoning effort changes.
   */
  #models = new Map<string, DshModels>();
  /** Likewise the permission presets, so a preset change names one the user was shown. */
  #permissions = new Map<string, DshPermissions>();
  /** Each parent's last listing of its subagents, with the native session behind each ID. */
  #children = new Map<
    string,
    { runtime: string; at: number; ids: Map<string, string>; catalog: Record<string, unknown> }
  >();
  readonly #subagentSalt = randomBytes(32);
  #answered = new Map<string, { by: "native" | "agentkib" | "cancelled"; at: number }>();
  /** Pages by `<session>\n<cursor>`, oldest first. */
  #pages = new Map<string, { page: ConversationEventPage; chars: number }>();
  #pageChars = 0;
  /** Sessions whose history was answered without a DSH; they read again once one serves them. */
  #servedOffline = new Set<string>();
  /** Native sessions with commands of unknown outcome, asked about again while DSH runs. */
  #unknownSessions = new Set<string>();
  /** When this run first saw each unconfirmed request. */
  #unknownSince = new Map<string, number>();
  #reconciledAt = new Map<string, number>();
  #reconciling = new Set<string>();
  /** A background DSH starting for a control, history read or new session; later ones join it. */
  #managedStart?: Promise<Runtime>;
  /** Since when the background DSH has had nothing to do. */
  #idleSince: number | null = null;
  /** When a command last went to the background DSH. */
  #managedTouched = 0;
  /** The background DSH being stopped; it may not register again while it exits. */
  #managedStopping: number | null = null;
  #reviewing = false;
  /** Whether a background start can be tried; reading it looks for the launcher on disk. */
  #availability?: { at: number; value: ReturnType<DshManagedRuntime["available"]> };
  #server?: Server;
  #listening?: Promise<void>;
  #socketPath?: string;
  #socketDirectory?: string;
  #releaseLock?: () => void;
  #closed = false;
  #startupFailed = false;
  #revision = 0;
  #saveTimer?: ReturnType<typeof setTimeout>;
  #timer: ReturnType<typeof setInterval>;
  #managedTimer?: ReturnType<typeof setInterval>;
  readonly #key = randomBytes(32).toString("hex");

  constructor(readonly options: DshBridgeOptions) {
    this.root = path.join(options.dataDir, "dsh-bridge");
    const file = path.join(this.root, "sessions-v1.json");
    try {
      privatePath(file);
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (
          stat.isFile() &&
          stat.size <= MAX_BODY &&
          (!process.getuid || stat.uid === process.getuid())
        ) {
          const rows = z
            .object({
              version: z.literal(1),
              sessions: z.array(catalogRowSchema).max(CATALOG_LIMIT),
            })
            .strict()
            .parse(JSON.parse(readFileSync(file, "utf8")));
          for (const row of rows.sessions) this.#remember(row);
        }
      }
    } catch {
      // A damaged cache only loses offline listings; online plugins report them again.
      this.#catalog.clear();
      this.#cwds.clear();
      this.#ids.clear();
    }
    this.#timer = setInterval(() => {
      for (const runtime of [...this.#runtimes.values()])
        if (Date.now() - runtime.lastSeen > OFFLINE_MS) this.#drop(runtime);
      for (const nativeId of this.#unknownSessions) this.#autoReconcile(nativeId);
    }, 5_000);
    this.#timer.unref();
    if (options.managed) {
      this.#managedTimer = setInterval(
        () => void this.#reviewManaged(),
        options.managed.reviewMs ?? 5_000,
      );
      this.#managedTimer.unref();
    }
  }

  get supported(): boolean {
    return (this.options.platform ?? process.platform) === "darwin";
  }
  initialize(): void {
    if (this.supported) void this.#listen().catch(() => (this.#startupFailed = true));
  }

  // ---- catalog ----------------------------------------------------------------------------

  #remember(row: CatalogRow): void {
    if (this.#catalog.get(row.id)?.cwd !== row.cwd) this.#cwds.set(row.id, canonical(row.cwd));
    this.#catalog.set(row.id, row);
    this.#ids.set(this.options.sessionId(row.id), row.id);
  }
  #saveCatalog(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      try {
        const rows = [...this.#catalog.values()]
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, CATALOG_LIMIT);
        privateJson(path.join(this.root, "sessions-v1.json"), { version: 1, sessions: rows });
      } catch {
        // The live listing still works; only offline listing is affected.
      }
    }, 500);
    this.#saveTimer.unref();
  }
  /** The native DSH session behind an AgentKib session ID. */
  nativeId(sessionId: string): string | undefined {
    return this.#ids.get(sessionId);
  }
  handles(sessionId: string): boolean {
    return this.#ids.has(sessionId);
  }
  #online(): Runtime[] {
    return [...this.#runtimes.values()].filter(
      (runtime) => Date.now() - runtime.lastSeen <= OFFLINE_MS,
    );
  }

  // ---- background DSH ---------------------------------------------------------------------

  #managedRuntime(): Runtime | undefined {
    return this.#online().find((runtime) => runtime.managed);
  }
  #managedAvailability(): ReturnType<DshManagedRuntime["available"]> {
    const known = this.#availability;
    if (known && Date.now() - known.at < 10_000) return known.value;
    const value = this.options.managed!.runtime.available();
    this.#availability = { at: Date.now(), value };
    return value;
  }
  /**
   * Whether AgentKib may start DSH to serve a session now: no running DSH can continue
   * sessions, the user's setting allows it and a launcher of a version the plugin runs in exists.
   */
  #startable(): boolean {
    const managed = this.options.managed;
    if (!managed || this.#closed || !this.supported || !managed.enabled()) return false;
    if (this.#online().some((runtime) => runtime.services.sessionController)) return false;
    return this.#managedAvailability().available;
  }
  /** Why a session that no running DSH serves cannot be continued from here. */
  #offlineReason(ambiguous: boolean): string {
    if (ambiguous) return "dsh-runtime-ambiguous";
    const managed = this.options.managed;
    if (managed && managed.enabled() && !this.#closed && this.supported) {
      const availability = this.#managedAvailability();
      if (!availability.available && availability.reason === "dsh-version-unsupported")
        return availability.reason;
    }
    return "dsh-runtime-offline";
  }
  /**
   * The background DSH, started if needed, once its plugin has registered and listed sessions.
   * Rejects with the reason as the message.
   */
  /**
   * The background DSH can take requests once its plugin has reported and DSH's session service
   * is up. Its session list may come later: an empty one is not reported by older plugins.
   */
  #managedReady(runtime: Runtime | undefined, pid?: number): runtime is Runtime {
    return (
      !!runtime &&
      runtime.managed &&
      runtime.reportedAt > 0 &&
      runtime.services.sessionController === true &&
      (pid === undefined || runtime.pid === pid)
    );
  }
  #ensureManaged(): Promise<Runtime> {
    const running = this.#managedRuntime();
    if (this.#managedReady(running)) return Promise.resolve(running);
    const managed = this.options.managed;
    if (!managed) return Promise.reject(new Error("dsh-runtime-offline"));
    this.#managedStart ??= (async () => {
      const pid = await managed.runtime.start();
      this.#availability = undefined;
      const deadline = Date.now() + (managed.startTimeoutMs ?? MANAGED_START_TIMEOUT_MS);
      for (;;) {
        const runtime = this.#online().find((candidate) => this.#managedReady(candidate, pid));
        if (runtime) return runtime;
        if (this.#closed) throw new Error("control-unavailable");
        if (managed.runtime.pid !== pid)
          throw new Error(managed.runtime.status().failure?.reason ?? "dsh-start-failed");
        if (Date.now() > deadline) {
          void managed.runtime.stop();
          throw new Error("dsh-start-failed");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })().finally(() => {
      this.#managedStart = undefined;
      this.#idleSince = null;
    });
    return this.#managedStart;
  }
  /**
   * The background DSH process ended; its sessions stop showing as served at once. Why it ended
   * is in the managed runtime's status.
   */
  managedExited(pid: number): void {
    this.#availability = undefined;
    this.#idleSince = null;
    for (const runtime of [...this.#runtimes.values()])
      if (runtime.managed && runtime.pid === pid) this.#drop(runtime);
  }
  /** Something still runs or waits in the background DSH, so it keeps running. */
  #managedBusy(runtime: Runtime): boolean {
    const settle = this.options.managed?.settleMs ?? MANAGED_SETTLE_MS;
    if (Date.now() - this.#managedTouched < settle) return true;
    if (runtime.interactions.size || runtime.commands.size) return true;
    if ([...this.#inflight.values()].some((item) => item.runtime === runtime.token)) return true;
    for (const state of runtime.states.values())
      if (state.live && (state.status === "running" || state.activity === "compacting"))
        return true;
    return false;
  }
  /**
   * Stops the background DSH once it has had nothing to do for a while, and at once when the user
   * has a DSH of their own open or turned the setting off, so their DSH can take its sessions:
   * a DSH keeps a session it resumed until it exits.
   */
  async #reviewManaged(): Promise<void> {
    const managed = this.options.managed;
    const runtime = this.#managedRuntime();
    if (!managed || !runtime || this.#managedStart || this.#reviewing || this.#closed) {
      if (!runtime) this.#idleSince = null;
      return;
    }
    if (this.#managedBusy(runtime)) {
      this.#idleSince = null;
      return;
    }
    const now = Date.now();
    this.#idleSince ??= now;
    this.#reviewing = true;
    try {
      const yieldNow =
        !managed.enabled() ||
        this.#online().some((other) => !other.managed && other.services.sessionController);
      const limit = yieldNow
        ? 0
        : (await managed.runtime.desktopRunning())
          ? (managed.desktopIdleMs ?? MANAGED_DESKTOP_IDLE_MS)
          : (managed.idleMs ?? MANAGED_IDLE_MS);
      if (now - this.#idleSince >= limit && !this.#managedBusy(runtime)) {
        this.#idleSince = null;
        // Nothing new goes to it from here on, and it may not come back while it exits.
        this.#managedStopping = runtime.pid;
        this.#drop(runtime);
        try {
          await managed.runtime.stop();
        } finally {
          this.#managedStopping = null;
        }
      }
    } finally {
      this.#reviewing = false;
    }
  }
  /**
   * Sessions whose working directory lies in this registered workspace. Subagents stay out.
   * A DSH session keeps its history while DSH is closed, so it stays readable; its live state
   * says when no DSH can serve or continue it.
   */
  list(workspace: string): { sessions: NativeSession[]; incomplete: boolean } {
    const root = canonical(workspace);
    const sessions: NativeSession[] = [];
    for (const row of this.#catalog.values()) {
      if (row.origin === "subagent" || !within(this.#cwds.get(row.id) ?? row.cwd, root)) continue;
      const updated = row.updatedAt === null ? null : new Date(row.updatedAt).toISOString();
      sessions.push({
        native_ref: row.id,
        agent: "deepseek-harness",
        title: row.title,
        created_at: null,
        updated_at: updated,
        message_count: null,
        git_branch: null,
        archived: row.archived === true,
        sidechain: false,
        availability: "readable",
        origin: "interactive",
        spawned_by_session_id: null,
        forked_from_session_id: row.parentSessionId
          ? this.options.sessionId(row.parentSessionId)
          : null,
        cwd: row.cwd,
      });
    }
    return { sessions, incomplete: false };
  }
  #workspaceIds(nativeIds: Iterable<string>): string[] {
    const ids = new Set<string>();
    for (const id of nativeIds) {
      const row = this.#catalog.get(id);
      const workspace = row ? this.options.workspaceFor(row.cwd) : null;
      if (workspace) ids.add(workspace.id);
    }
    return [...ids];
  }

  // ---- history ----------------------------------------------------------------------------

  /** One page, newest first in paging order; each page is chronological. */
  async events(
    nativeId: string,
    cursor: string | null,
    limit: number,
  ): Promise<ConversationEventPage> {
    if (cursor !== null && !cursor.startsWith(CURSOR_PREFIX))
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    const before = cursor === null ? undefined : Number(cursor.slice(CURSOR_PREFIX.length));
    if (before !== undefined && !Number.isSafeInteger(before))
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    let runtime =
      this.#controlRuntime(nativeId) ??
      this.#online().find((candidate) => candidate.services.sessionQuery);
    // Someone opened the session while no DSH runs: start one in the background to read it.
    // Failing that, the session shows what this run already read, and its state says why.
    if (!runtime && this.#startable()) runtime = await this.#ensureManaged().catch(() => undefined);
    const key = `${nativeId}\n${cursor ?? ""}`;
    if (!runtime) {
      // No DSH to ask: show what this run already read. A session not read yet shows no history
      // and its live state says DSH is not running; an older page never read cannot be shown.
      const cached = this.#pages.get(key);
      if (!cached && cursor !== null) throw new Error("dsh-runtime-offline");
      this.#servedOffline.add(nativeId);
      return cached?.page ?? { events: [], next_cursor: null, warnings: [] };
    }
    const result = await this.#command(
      runtime,
      {
        commandId: randomUUID(),
        type: "history",
        sessionId: nativeId,
        ...(before !== undefined ? { before } : {}),
        limit: Math.min(Math.max(limit, 1), 100),
      },
      HISTORY_TIMEOUT_MS,
    );
    if (!result.ok)
      throw new Error(
        result.error === "timeout" ? "dsh-history-timeout" : "dsh-history-unavailable",
      );
    const page = result.value as DshBridgeHistoryPage;
    if (!page || !Array.isArray(page.records) || page.sessionId !== nativeId)
      throw new Error("dsh-history-unavailable");
    const history: ConversationEventPage = {
      events: dshConversationEvents(page.records),
      next_cursor:
        typeof page.nextBefore === "number" ? `${CURSOR_PREFIX}${page.nextBefore}` : null,
      warnings: [],
    };
    this.#cachePage(key, history);
    return history;
  }
  /**
   * One image a session's history shows, read from the DSH that has the session. DSH returns only
   * images the session's own log refers to; the ID is the digest of the stored bytes, so the
   * bytes are checked against it here.
   */
  async image(nativeId: string, imageId: string): Promise<{ mimeType: string; base64: string }> {
    const sha256 = imageId.startsWith(IMAGE_ID_PREFIX) ? imageId.slice(IMAGE_ID_PREFIX.length) : "";
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("session-image-invalid");
    const runtime =
      this.#controlRuntime(nativeId) ??
      this.#online().find((candidate) => candidate.services.images === true);
    if (runtime?.services.images !== true) throw new Error("session-image-unavailable");
    const result = await this.#command(
      runtime,
      {
        commandId: randomUUID(),
        type: "image",
        sessionId: nativeId,
        attachmentId: `sha256:${sha256}`,
      },
      HISTORY_TIMEOUT_MS,
    );
    if (!result.ok)
      throw new Error(
        result.error === "image-too-large"
          ? "session-image-too-large"
          : "session-image-unavailable",
      );
    const value = result.value as { mediaType?: unknown; data?: unknown } | null;
    if (typeof value?.data !== "string") throw new Error("session-image-unavailable");
    const bytes = decodedSessionImage(value.data);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("session-image-changed");
    return sessionImageResult(
      bytes,
      typeof value.mediaType === "string" ? value.mediaType : undefined,
    );
  }
  /** Whether the session is in a turn in a running DSH. */
  running(nativeId: string): boolean {
    return this.#state(nativeId).state?.status === "running";
  }
  /** Running DSHs that list this session and can read it whole. */
  #readers(nativeId: string): Runtime[] {
    return this.#online().filter(
      (runtime) => runtime.services.documents === true && runtime.summaries.has(nativeId),
    );
  }
  /**
   * Whether a handoff or search can read this session now, decided without reading it. A DSH
   * whose plugin predates 0.5.0 lists sessions but cannot read them whole.
   */
  documentStatus(nativeId: string): { status: "supported" | "unavailable"; reason?: string } {
    if (this.#readers(nativeId).length) return { status: "supported" };
    const listing = this.#online().filter((runtime) => runtime.summaries.has(nativeId));
    // A handoff starts DSH in the background to read the session.
    if (!listing.length && this.#startable()) return { status: "supported" };
    return {
      status: "unavailable",
      reason: listing.length ? "dsh-document-unavailable" : this.#offlineReason(false),
    };
  }
  /**
   * A session's whole conversation for a handoff or search, from a DSH that can read it. Later
   * pages stop at the event the first one was read up to, so the pages agree with one another.
   * `start` lets a handoff start DSH in the background; search indexing never starts it.
   */
  async conversation(
    nativeId: string,
    start = false,
  ): Promise<{ revision: number | null; records: DshBridgeDocumentRecord[] }> {
    if (start && !this.#readers(nativeId).length && this.#startable())
      await this.#ensureManaged().catch(() => undefined);
    const preferred = this.#controlRuntime(nativeId);
    const runtime = preferred?.services.documents === true ? preferred : this.#readers(nativeId)[0];
    if (!runtime) throw new Error(this.documentStatus(nativeId).reason ?? "dsh-runtime-offline");
    const records: DshBridgeDocumentRecord[] = [];
    let after: number | undefined;
    let through: number | undefined;
    for (let page = 0; page < DOCUMENT_PAGE_LIMIT; page++) {
      const result = await this.#command(
        runtime,
        {
          commandId: randomUUID(),
          type: "document",
          sessionId: nativeId,
          ...(after === undefined ? {} : { after }),
          ...(through === undefined ? {} : { through }),
        },
        HISTORY_TIMEOUT_MS,
      );
      if (!result.ok)
        throw new Error(
          result.outcome === "timeout" ? "dsh-history-timeout" : "dsh-document-unavailable",
        );
      const value = documentPageSchema.safeParse(result.value);
      if (!value.success || value.data.sessionId !== nativeId)
        throw new Error("dsh-document-unavailable");
      records.push(...(value.data.records as DshBridgeDocumentRecord[]));
      through ??= value.data.revision ?? undefined;
      if (value.data.nextAfter === null) return { revision: through ?? null, records };
      if (after !== undefined && value.data.nextAfter <= after)
        throw new Error("dsh-document-unavailable");
      after = value.data.nextAfter;
    }
    throw new Error("dsh-document-too-large");
  }
  /**
   * A session as a handoff document. The images its user messages carried are read from DSH and
   * kept inline, up to a bound; any others are counted as left in DSH.
   */
  async document(
    nativeId: string,
    source: DocumentSource,
    options?: DocumentOptions,
  ): Promise<SessionDocument> {
    const { records } = await this.conversation(nativeId, true);
    const images = new Map<string, DshDocumentImage | null>();
    let chars = 0;
    for (const record of records) {
      if (record.kind !== "user" || (!options?.includePreCompactionHistory && !record.current))
        continue;
      for (const image of record.images) {
        if (images.has(image.attachmentId)) continue;
        const read =
          [...images.values()].filter(Boolean).length < DOCUMENT_IMAGE_LIMIT
            ? await this.image(
                nativeId,
                `${IMAGE_ID_PREFIX}${image.attachmentId.slice("sha256:".length)}`,
              ).catch(() => null)
            : null;
        if (read && chars + read.base64.length <= DOCUMENT_IMAGE_CHARS) {
          chars += read.base64.length;
          images.set(image.attachmentId, { mediaType: read.mimeType, base64: read.base64 });
        } else images.set(image.attachmentId, null);
      }
    }
    return dshSessionDocument(source, records, images, options);
  }
  #cachePage(key: string, page: ConversationEventPage): void {
    const previous = this.#pages.get(key);
    if (previous) {
      this.#pages.delete(key);
      this.#pageChars -= previous.chars;
    }
    const chars = JSON.stringify(page).length;
    if (chars > PAGE_CACHE_CHARS) return;
    this.#pages.set(key, { page, chars });
    this.#pageChars += chars;
    for (const [oldest, entry] of this.#pages) {
      if (this.#pageChars <= PAGE_CACHE_CHARS) break;
      this.#pages.delete(oldest);
      this.#pageChars -= entry.chars;
    }
  }

  // ---- runtimes ---------------------------------------------------------------------------

  /** The runtime running this session, else the only connected runtime that can resume it. */
  #controlRuntime(nativeId: string): Runtime | null {
    const online = this.#online();
    const running = online
      .filter(
        (runtime) => runtime.states.get(nativeId)?.live || runtime.summaries.get(nativeId)?.live,
      )
      .sort((a, b) => b.lastSeen - a.lastSeen)[0];
    if (running) return running;
    // A DSH the user runs comes first; the one AgentKib started serves only without one.
    const resumable = online.filter((runtime) => runtime.services.sessionController);
    const own = resumable.filter((runtime) => !runtime.managed);
    if (own.length) return own.length === 1 ? own[0]! : null;
    return resumable.find((runtime) => runtime.managed) ?? null;
  }
  #state(nativeId: string): {
    runtime: Runtime | null;
    state: DshBridgeSessionState | null;
    ambiguous: boolean;
  } {
    const runtime = this.#controlRuntime(nativeId);
    const ambiguous =
      !runtime &&
      this.#online().filter(
        (candidate) => candidate.services.sessionController && !candidate.managed,
      ).length > 1;
    return { runtime, state: runtime?.states.get(nativeId) ?? null, ambiguous };
  }
  #interactions(nativeId: string): DshBridgeInteraction[] {
    const runtime = this.#controlRuntime(nativeId);
    return runtime
      ? [...runtime.interactions.values()].filter((item) => item.sessionId === nativeId)
      : [];
  }
  #touch(nativeId: string): void {
    this.#revisions.set(nativeId, ++this.#revision);
  }
  #publish(nativeId: string, history = false, queue = false, other: string[] = []): void {
    if (!this.#catalog.has(nativeId)) return;
    const id = this.options.sessionId(nativeId);
    const live = this.live(id, true);
    this.options.publish(id, "state", live, live);
    // Streaming changes the state many times a second; readers of the queue refetch only here.
    const domains = [...(history ? ["history"] : []), ...(queue ? ["queue"] : []), ...other];
    if (domains.length) this.options.publish(id, "invalidate", { domains }, live);
  }
  #drop(runtime: Runtime): void {
    if (!this.#runtimes.delete(runtime.token)) return;
    runtime.waiting?.();
    for (const waiter of runtime.commands.values()) {
      clearTimeout(waiter.timer);
      waiter.settle({
        ok: false,
        error: waiter.delivered ? "unknown" : "not-dispatched",
        outcome: "timeout",
      });
    }
    runtime.commands.clear();
    const affected = new Set([...runtime.summaries.keys(), ...runtime.states.keys()]);
    for (const id of affected) {
      this.#touch(id);
      this.#publish(id);
    }
    // With no runtime left, every listed DSH session can only be read from this run's history.
    this.options.sessionsChanged(
      this.#workspaceIds(this.#online().length ? affected : this.#catalog.keys()),
    );
  }

  #apply(runtime: Runtime, report: z.infer<typeof reportSchema>): string[] {
    runtime.reportedAt = Date.now();
    const changed = new Set<string>();
    // Sessions whose control state changed. A control carries the revision it was decided on, so
    // streamed text, titles and history progress, which change many times a second, never bump
    // it; otherwise a queue or steer sent while DSH streams would always look stale.
    const revised = new Set<string>();
    const historyChanged = new Set(report.historyChanged ?? []);
    let listChanged = false;
    if (report.services) runtime.services = report.services;
    if (report.commands && stable(report.commands) !== stable(runtime.slashCommands)) {
      runtime.slashCommands = report.commands;
      // The `/` menu comes with the capabilities; sessions this DSH serves read them again.
      for (const id of runtime.summaries.keys()) changed.add(id);
    }
    for (const entry of report.sessionCommands ?? []) {
      if (entry.commands) runtime.sessionCommands.set(entry.sessionId, entry.commands);
      else runtime.sessionCommands.delete(entry.sessionId);
      changed.add(entry.sessionId);
    }
    if (report.sessions) {
      const next = new Map(report.sessions.map((row) => [row.sessionId, row]));
      for (const id of new Set([...runtime.summaries.keys(), ...next.keys()])) {
        const before = runtime.summaries.get(id);
        const after = next.get(id);
        if (stable(before) === stable(after)) continue;
        changed.add(id);
        if (!before || !after || before.live !== after.live) revised.add(id);
      }
      runtime.summaries = next;
      runtime.listedAt = Date.now();
      for (const row of report.sessions) {
        const cached: CatalogRow = {
          id: row.sessionId,
          cwd: row.cwd,
          title: row.title,
          updatedAt: row.updatedAt,
          parentSessionId: row.parentSessionId,
          origin: row.origin,
          ...(row.archived === true ? { archived: true } : {}),
        };
        if (stable(this.#catalog.get(row.sessionId)) !== stable(cached)) {
          this.#remember(cached);
          listChanged = true;
        }
      }
      if (listChanged) this.#saveCatalog();
      // History shown without a DSH may be stale or empty; read it again from this one.
      if (runtime.services.sessionQuery)
        for (const id of runtime.summaries.keys())
          if (this.#servedOffline.delete(id)) historyChanged.add(id);
    }
    const queueChanged = new Set<string>();
    for (const state of report.states ?? []) {
      const previous = runtime.states.get(state.sessionId);
      if (stable(previous) === stable(state)) continue;
      if (stable(queuedFor(previous)) !== stable(queuedFor(state)))
        queueChanged.add(state.sessionId);
      if (stable(controlView(previous)) !== stable(controlView(state)))
        revised.add(state.sessionId);
      runtime.states.set(state.sessionId, state);
      changed.add(state.sessionId);
    }
    if (report.interactions) {
      const next = new Map(
        report.interactions.map((item) => [item.id, item as DshBridgeInteraction]),
      );
      for (const [id, item] of runtime.interactions)
        if (!next.has(id)) {
          if (!this.#answered.has(id)) this.#answered.set(id, { by: "native", at: Date.now() });
          changed.add(item.sessionId);
          revised.add(item.sessionId);
        }
      for (const item of next.values())
        if (!runtime.interactions.has(item.id)) {
          changed.add(item.sessionId);
          revised.add(item.sessionId);
        }
      runtime.interactions = next;
      for (const [id, entry] of this.#answered)
        if (Date.now() - entry.at > 10 * 60_000) this.#answered.delete(id);
    }
    const goalChanged = new Set(report.goalChanged ?? []);
    const settingsChanged = new Set(report.settingsChanged ?? []);
    for (const id of new Set([...changed, ...historyChanged, ...goalChanged, ...settingsChanged])) {
      if (revised.has(id)) this.#touch(id);
      this.#publish(id, historyChanged.has(id), queueChanged.has(id), [
        ...(goalChanged.has(id) ? ["goal"] : []),
        ...(settingsChanged.has(id) ? ["settings"] : []),
      ]);
    }
    // Every report, heartbeats included, is a chance to settle what is still unconfirmed.
    for (const nativeId of this.#unknownSessions) this.#autoReconcile(nativeId);
    if (listChanged)
      this.options.sessionsChanged(
        this.#workspaceIds(changed.size ? changed : runtime.summaries.keys()),
      );
    return [...runtime.summaries.keys()].filter((id) => {
      const row = this.#catalog.get(id);
      return !!row && row.origin !== "subagent" && !!this.options.workspaceFor(row.cwd);
    });
  }

  #command(
    runtime: Runtime,
    command: Command,
    timeoutMs = this.options.commandTimeoutMs ?? 12_000,
    onDelivered?: () => void,
  ): Promise<{ ok: boolean; value?: unknown; error?: string; outcome?: "timeout" }> {
    if (runtime.managed) this.#managedTouched = Date.now();
    return new Promise((resolve) => {
      const waiter: CommandWaiter = {
        command,
        delivered: false,
        onDelivered,
        settle: (result) => {
          runtime.commands.delete(command.commandId);
          resolve(result);
        },
        timer: setTimeout(() => {
          const index = runtime.queue.indexOf(command);
          if (index >= 0) runtime.queue.splice(index, 1);
          waiter.settle({
            ok: false,
            error: waiter.delivered ? "unknown" : "not-dispatched",
            outcome: "timeout",
          });
        }, timeoutMs),
      };
      waiter.timer.unref();
      runtime.commands.set(command.commandId, waiter);
      runtime.queue.push(command);
      runtime.waiting?.();
    });
  }

  // ---- live projection --------------------------------------------------------------------

  live(id: string, controls: boolean): Record<string, unknown> {
    const nativeId = this.#ids.get(id);
    if (!nativeId) throw new Error("session-unavailable");
    const row = this.#catalog.get(nativeId)!;
    const workspace = this.options.workspaceFor(row.cwd);
    const { runtime, state, ambiguous } = this.#state(nativeId);
    const online = !!runtime;
    // No running DSH can take the session, but AgentKib can start one: the session reads as
    // idle, and sending starts DSH in the background.
    const startable = !online && !ambiguous && this.#startable();
    const interactions = this.#interactions(nativeId);
    const inflight = this.#inflight.get(id);
    // A request still waiting for its reply makes the session busy, not unconfirmed. Also
    // covers requests left unconfirmed by an earlier run of AgentKib.
    const unknown = readUnknownManagedCommands(this.options.dataDir, id).some(
      (command) => command.requestId !== inflight?.requestId,
    );
    if (unknown) this.#unknownSessions.add(nativeId);
    const controller = runtime?.services.sessionController === true;
    const running = state?.live === true && state.status === "running";
    // DSH would take a message during a compaction and hold it until the end; AgentKib waits for
    // the compaction to finish, as it does with the other agents.
    const compacting = state?.live === true && state.activity === "compacting";
    const approval = interactions.find((item) => item.kind === "approval");
    const question = interactions.find((item) => item.kind === "question");
    const compatibility = runtime ? dshBridgeCompatibility(runtime.dshVersion) : null;
    const reason = !workspace
      ? "session-workspace-unavailable"
      : unknown
        ? "control-outcome-unconfirmed"
        : !online
          ? startable
            ? undefined
            : this.#offlineReason(ambiguous)
          : !controller
            ? "dsh-session-controller-unavailable"
            : approval
              ? "dsh-approval-pending"
              : question
                ? "dsh-question-pending"
                : compacting
                  ? "session-compacting"
                  : undefined;
    const controllable =
      controls && (online ? controller : startable) && !!workspace && !unknown && !inflight;
    const turnId = running ? turnIdOf(state!.turn) : null;
    const status = unknown
      ? "outcome-unknown"
      : !online
        ? startable
          ? "idle"
          : "unsupported"
        : approval
          ? "awaiting-approval"
          : question
            ? "waiting-input"
            : running
              ? "running"
              : "idle";
    const queue = queuedFor(state);
    return {
      sessionId: id,
      sourceSessionId: nativeId,
      workspaceId: workspace?.id ?? null,
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
      // A DSH that AgentKib started runs in AgentKib's place: it stops when AgentKib quits.
      executionLocation: runtime ? (runtime.managed ? "agentkib" : "external") : null,
      ownershipReason: null,
      connectionGeneration: runtime ? runtime.runtimeId : this.options.bootId,
      cliVersion: runtime ? `${runtime.dshVersion} (DeepSeek Harness)` : undefined,
      bridgeCompatibility:
        runtime &&
        (compatibility === "verified" ||
          compatibility === "unverified" ||
          compatibility === "unknown")
          ? { cliVersion: runtime.dshVersion, status: compatibility }
          : null,
      revision: this.#revisions.get(nativeId) ?? 0,
      status,
      reason,
      turnId,
      activity: compacting ? "compacting" : null,
      sendEnabled: controllable && !running && !approval && !question && !compacting,
      steerEnabled: controllable && running && !!turnId && !compacting,
      queueEnabled: controllable && running && !compacting,
      // Not tied to a non-empty queue: clients refetch capabilities on status changes, not when
      // DSH's own client queues a message. Each edit checks that its item still waits.
      queueEditEnabled: controllable,
      queuedCount: queue.length,
      stopEnabled: controls && online && controller && !unknown && running && !!turnId,
      approvals: approval
        ? interactions
            .filter((item) => item.kind === "approval")
            .map((item) =>
              this.#approval(
                item as Extract<DshBridgeInteraction, { kind: "approval" }>,
                turnId,
                controls && online && controller,
              ),
            )
        : [],
      questions: interactions
        .filter((item) => item.kind === "question")
        .map((item) =>
          this.#question(
            item as Extract<DshBridgeInteraction, { kind: "question" }>,
            turnId,
            controls && online && controller,
          ),
        ),
      streamText: running ? sanitizeSessionText(state?.streamText ?? "", { value: 0 }) : "",
      streamTextTruncated: running && state?.streamTruncated === true,
      usage: { available: false, state: "unavailable", reason: "usage-unavailable" },
    };
  }
  #approval(
    item: Extract<DshBridgeInteraction, { kind: "approval" }>,
    turnId: string | null,
    enabled: boolean,
  ) {
    let input: unknown = item.arguments;
    try {
      input = item.arguments ? JSON.parse(item.arguments) : null;
    } catch {
      // Show the raw arguments text.
    }
    return {
      requestId: item.id,
      turnId: turnId ?? "dsh-turn-unknown",
      method: "dsh/approval",
      toolName: item.toolName,
      input,
      command: {
        tool: item.toolName,
        ...(item.reason ? { reason: item.reason } : {}),
        ...(input !== null ? { arguments: input } : {}),
      },
      context: item.displayReason ? { description: item.displayReason } : undefined,
      availableDecisions: ["accept", "decline"],
      supported: enabled,
      unsupportedReason: enabled ? null : "dsh-handle-in-native-ui",
    };
  }
  #question(
    item: Extract<DshBridgeInteraction, { kind: "question" }>,
    turnId: string | null,
    enabled: boolean,
  ) {
    return {
      requestId: item.id,
      turnId: turnId ?? "dsh-turn-unknown",
      method: "dsh/question",
      supported: enabled,
      unsupportedReason: enabled ? null : "dsh-handle-in-native-ui",
      questions: item.questions.map((question) => {
        const options = question.options.map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        }));
        if (question.intent?.kind === "approval" && question.intent.always)
          options.push({ label: question.intent.always });
        return {
          id: question.id,
          ...(question.header ? { header: question.header } : {}),
          question: question.detail
            ? `${question.question}\n\n${question.detail}`
            : question.question,
          options,
          multiSelect: question.multiSelect,
          // DSH accepts free text unless the question is a fixed approval card.
          allowCustom: question.intent?.kind !== "approval",
        };
      }),
    };
  }

  capabilities(id: string, controls: boolean): Record<string, unknown> {
    const live = this.live(id, controls);
    const nativeId = this.#ids.get(id)!;
    const runtime = this.#state(nativeId).runtime;
    const online = !!runtime;
    const services = runtime?.services;
    // `live` reports this as queueEditEnabled: online, controllable and nothing unconfirmed.
    const controllable = live.queueEditEnabled === true;
    const idle = controllable && live.status === "idle" && live.activity !== "compacting";
    const archived = this.#catalog.get(nativeId)?.archived === true;
    const archivable = idle && services?.workspaceController === true;
    const commands = online && runtime ? this.#commandsFor(runtime, nativeId) : [];
    // A permission preset applies to the next approval, also in a running turn, as in DSH.
    const presets =
      services?.permissions === true && commands.some((entry) => entry.name === "permission");
    const compactable = commands.some((entry) => entry.name === "compact");
    const goals = online && services?.goals === true;
    const flags: Record<string, boolean> = {
      send: live.sendEnabled === true,
      stop: live.stopEnabled === true,
      steer: live.steerEnabled === true,
      approve: (live.approvals as unknown[]).length > 0 && controls && online,
      answer: (live.questions as unknown[]).length > 0 && controls && online,
      inspect: true,
      usage: false,
      context: false,
      files: false,
      reconcile: true,
      adopt: false,
      release: false,
      resources: false,
      // Images go with any message DSH takes now: sent, queued or added to the running turn.
      attachments:
        services?.images === true &&
        (live.sendEnabled === true || live.queueEnabled === true || live.steerEnabled === true),
      // A running turn keeps its model, so model changes wait for idle; a preset does not.
      settings: (idle && services?.modelCatalog === true) || (controllable && presets),
      "settings-state": online && (services?.modelCatalog === true || presets),
      queue: live.queueEnabled === true,
      "queue-list": online,
      "queue-add": live.queueEnabled === true,
      "queue-update": live.queueEditEnabled === true,
      "queue-delete": live.queueEditEnabled === true,
      // Moves a waiting message into the running turn, as DSH's own "steer" on a queued item.
      "queue-steer": live.queueEditEnabled === true && live.steerEnabled === true,
      "queue-reorder": false,
      "queue-resume": false,
      "queue-pause": false,
      fork: controllable,
      rename: controllable,
      // DSH refuses to archive an active session rather than stop it; so does AgentKib.
      archive: archivable && !archived,
      unarchive: archivable && archived,
      // DSH changes a goal also while a turn runs; the goal state says which change fits it now.
      goal: goals,
      "goal-set": controllable && goals,
      "goal-pause": controllable && goals,
      "goal-resume": controllable && goals,
      "goal-clear": controllable && goals,
      // DSH's own `/compact`, which waits for the session to be idle.
      compact: idle && compactable,
    };
    return {
      sessionId: id,
      executionMode: DSH_EXECUTION_MODE,
      status: live.status,
      reason: live.reason,
      // Clients filter the `/` menu per device (`dshMenuCommands`).
      ...(commands.length
        ? {
            commands: commands.map((entry) => ({
              name: entry.name,
              ...(entry.description ? { description: entry.description } : {}),
              ...(entry.hint ? { argumentHint: entry.hint } : {}),
            })),
          }
        : {}),
      features: Object.fromEntries(
        Object.entries(flags).map(([key, available]) => [
          key,
          available
            ? { available: true }
            : {
                available: false,
                reason:
                  key === "attachments" && online && services?.images !== true
                    ? "dsh-attachments-unavailable"
                    : // Offered once the turn ends, so say that rather than "unavailable".
                      controllable &&
                        !idle &&
                        live.activity !== "compacting" &&
                        ((key === "settings" && services?.modelCatalog === true) ||
                          (key === "compact" && compactable) ||
                          (["archive", "unarchive"].includes(key) &&
                            services?.workspaceController === true))
                      ? "session-busy"
                      : ((live.reason as string | undefined) ?? "operation-unavailable"),
              },
        ]),
      ),
    };
  }

  async request(value: Record<string, unknown>): Promise<unknown> {
    const id = z.string().min(1).max(256).parse(value.sessionId);
    const nativeId = this.#ids.get(id);
    if (!nativeId) throw new Error("session-unavailable");
    const controls = value.experimentalEnabled === true;
    switch (value.operation) {
      case "live":
        return this.live(id, controls);
      case "capabilities":
        return this.capabilities(id, controls);
      case "inspect":
        return {
          sessionId: id,
          sourceSessionId: nativeId,
          workspaceId: this.options.workspaceFor(this.#catalog.get(nativeId)!.cwd)?.id ?? null,
          live: this.live(id, controls),
          reconciled: false,
        };
      case "usage":
        return { available: false, state: "unavailable", reason: "usage-unavailable" };
      case "goal":
        return this.#goalState(id, nativeId);
      case "subagents":
        return this.#subagents(id, nativeId);
      case "subagent-events":
        return this.#subagentEvents(id, nativeId, value);
      case "context":
        return {
          available: true,
          cwd: this.#catalog.get(nativeId)!.cwd,
          projectId: null,
          branchAtCreation: null,
        };
      case "queue-list":
        return this.#queueList(id, nativeId);
      case "settings-state":
        return this.#settingsState(id, nativeId);
      case "reconcile":
        return this.#reconcile(id, nativeId, controls);
      case "send":
      case "steer":
      case "queue-add":
      case "queue-update":
      case "queue-delete":
      case "queue-steer":
      case "stop":
      case "approve":
      case "answer":
      case "rename":
      case "archive":
      case "unarchive":
      case "fork":
      case "settings":
      case "goal-set":
      case "goal-pause":
      case "goal-resume":
      case "goal-clear":
      case "compact":
        return this.#control(value, id, nativeId);
      default:
        throw new Error("operation-unavailable");
    }
  }
  #queueList(id: string, nativeId: string): Record<string, unknown> {
    const live = this.live(id, false);
    const { state } = this.#state(nativeId);
    return {
      available: true,
      revision: live.revision,
      paused: false,
      requiresResume: false,
      reason: null,
      data: queuedFor(state).map((item) => {
        // An attached file reaches DSH as its own line of text (see the Host's attachment store).
        // Listing those lines and the images, which are already in DSH, as their own inputs
        // marks the item as one with attachments; an edit would replace them with text only.
        const lines = item.text.split("\n");
        const note = (line: string) => line.startsWith("User attached file ");
        return {
          id: item.id,
          kind: "queue",
          input: [
            { type: "text", text: lines.filter((line) => !note(line)).join("\n") },
            ...lines.filter(note).map((text) => ({ type: "text", text })),
            ...Array.from({ length: item.images }, () => ({ type: "image" })),
          ],
          status: "pending",
          createdAt: null,
          requiresAttachments: false,
        };
      }),
      nextCursor: null,
    };
  }
  /**
   * Whether a new session can start now: exactly one running DSH that can take it. That DSH's
   * Agent presets come with it when it lists them; without them a session runs DSH's default.
   */
  async createOptions(): Promise<{
    available: boolean;
    reason?: string;
    agentPresets?: DshBridgeAgentPreset[];
  }> {
    if (!this.supported) return { available: false, reason: "platform-unsupported" };
    let runtime = this.#creator();
    if (runtime === "ambiguous") return { available: false, reason: "dsh-create-ambiguous" };
    // Choosing DSH for a new session starts it in the background, the way the first Codex read
    // starts an app-server; it stops again when nothing comes of it.
    if (!runtime && this.#startable())
      try {
        runtime = await this.#ensureManaged();
      } catch (error) {
        return { available: false, reason: preflightReason(error) };
      }
    if (!runtime) return { available: false, reason: this.#offlineReason(false) };
    if (runtime.services.agentPresets !== true) return { available: true };
    const result = await this.#command(
      runtime,
      { commandId: randomUUID(), type: "presets" },
      PRESETS_TIMEOUT_MS,
    );
    const roster = result.ok ? presetsSchema.safeParse(result.value) : null;
    return roster?.success
      ? { available: true, agentPresets: roster.data.presets }
      : { available: true };
  }
  /**
   * The DSH a new session starts in: the user's own when exactly one runs, else the one AgentKib
   * started. With more than one of the user's, AgentKib cannot tell which they mean.
   */
  #creator(): Runtime | "ambiguous" | null {
    const candidates = this.#online().filter((item) => item.services.sessionController);
    const own = candidates.filter((item) => !item.managed);
    // Not "dsh-runtime-ambiguous": that one asks to open an existing session in one of them.
    if (own.length > 1) return "ambiguous";
    return own[0] ?? candidates.find((item) => item.managed) ?? null;
  }
  /**
   * Starts a DSH session in a registered workspace through the one running DSH that can, or one
   * started in the background. With more than one of the user's, it asks them to pick in DSH.
   */
  async create(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = uuid.parse(value.requestId);
    const deviceId = z.string().min(1).max(256).parse(value.deviceId);
    const workspaceId = z.string().min(1).max(256).parse(value.workspaceId);
    const agentPreset =
      value.agentPreset === undefined
        ? undefined
        : z.string().min(1).max(128).parse(value.agentPreset);
    const result = (outcome: string, extra: Record<string, unknown> = {}) =>
      this.#created(requestId, outcome, extra);
    const fingerprint = digest(stable({ ...value, runtimeBootId: undefined })).toString("hex");
    const replay = replayManagedCommand(this.options.dataDir, requestId, fingerprint);
    if (replay) return replay;
    let runtime: Runtime;
    let cwd: string;
    try {
      if (this.#closed || !this.supported) throw new Error("control-unavailable");
      const root = this.options.workspacePath?.(workspaceId) ?? null;
      if (!root) throw new Error("workspace-unavailable");
      cwd = root;
      const candidate = this.#creator();
      if (candidate === "ambiguous") throw new Error("dsh-create-ambiguous");
      if (candidate) runtime = candidate;
      else if (this.#startable()) runtime = await this.#ensureManaged();
      else throw new Error(this.#offlineReason(false));
    } catch (error) {
      return result("not-dispatched", { reason: preflightReason(error) });
    }
    // DSH names a new session after the ID it is given, so the receipt carries the real session
    // and a reply that never comes back is settled by that session being listed or not.
    const nativeId = `session-${randomUUID()}`;
    const id = this.options.sessionId(nativeId);
    const commandId = randomUUID();
    const prior = claimManagedCommand(this.options.dataDir, requestId, id, fingerprint, deviceId, {
      operation: "create",
      commandId,
      runtimeId: runtime.runtimeId,
      workspaceId,
      nativeSessionId: nativeId,
      claimedAt: Date.now(),
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
    });
    if (prior) return prior;
    // Until DSH has replied and listed the session, it is busy, not unconfirmed.
    this.#inflight.set(id, { requestId, commandId, runtime: runtime.token });
    let sent: { ok: boolean; value?: unknown; error?: string };
    let made = nativeId;
    try {
      sent = await this.#command(
        runtime,
        {
          commandId,
          type: "create",
          cwd,
          sessionId: nativeId,
          ...(agentPreset ? { agentPreset } : {}),
        },
        undefined,
        () => dispatchManagedCommand(this.options.dataDir, requestId),
      );
      const child = sent.ok ? (sent.value as { sessionId?: unknown } | null)?.sessionId : undefined;
      if (typeof child === "string" && child) made = child;
      if (sent.ok) await this.#listed(made);
    } finally {
      this.#inflight.delete(id);
    }
    // Delivered without a reply: never sent again, settled as described above.
    if (sent.error === "unknown") {
      this.#unknownSessions.add(nativeId);
      this.#autoReconcile(nativeId);
      return result("unknown", { reason: "control-outcome-unconfirmed" });
    }
    const outcome = sent.ok
      ? result("accepted", { sessionId: this.options.sessionId(made) })
      : result("not-dispatched", { reason: dshRefusal(sent.error) });
    finishManagedCommand(this.options.dataDir, requestId, outcome);
    return outcome;
  }
  /**
   * Starts a DSH session for a handoff and sends it the message that points it at the handoff
   * file. Both requests are named after the handoff, so trying again replays the session the first
   * try started and never sends the message twice.
   */
  async handoff(value: {
    key: string;
    workspaceId: string;
    text: string;
  }): Promise<{ sessionId: string }> {
    const created = await this.create({
      requestId: namedUuid(`handoff-create\n${value.key}`),
      deviceId: HANDOFF_DEVICE,
      workspaceId: value.workspaceId,
    });
    const sessionId = typeof created.sessionId === "string" ? created.sessionId : null;
    if (created.controlOutcome !== "accepted" || !sessionId)
      throw new Error(
        created.controlOutcome === "unknown"
          ? "control-outcome-unconfirmed"
          : String(created.reason ?? "dsh-create-failed"),
      );
    // DSH lists a session it made with its next report.
    const until = Date.now() + 10_000;
    while (!this.#ids.has(sessionId) && !this.#closed && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const nativeId = this.#ids.get(sessionId);
    const runtime = nativeId ? this.#controlRuntime(nativeId) : null;
    if (!nativeId || !runtime) throw new Error("dsh-runtime-offline");
    const requestId = namedUuid(`handoff-message\n${value.key}`);
    const known = await this.#command(runtime, {
      commandId: randomUUID(),
      type: "verify",
      sessionId: nativeId,
      requestId,
    });
    if (known.ok && (known.value as { present?: unknown } | null)?.present === true)
      return { sessionId };
    const sent = await this.#command(runtime, {
      commandId: randomUUID(),
      type: "prompt",
      sessionId: nativeId,
      requestId,
      mode: "queue",
      content: [{ type: "text", text: value.text }],
    });
    if (!sent.ok)
      throw new Error(
        sent.error === "unknown"
          ? "control-outcome-unconfirmed"
          : (sent.error ?? "dsh-send-failed"),
      );
    return { sessionId };
  }
  /**
   * Waits briefly for DSH to list a session it just made. DSH replies first and lists it with
   * its next report, and the client opens the session as soon as the reply arrives.
   */
  async #listed(nativeId: string, timeoutMs = 3_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!this.#catalog.has(nativeId) && !this.#closed && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
  #created(requestId: string, outcome: string, extra: Record<string, unknown> = {}) {
    return {
      accepted: outcome === "accepted",
      completed: outcome === "accepted",
      requestId,
      runtimeBootId: this.options.bootId,
      executionMode: DSH_EXECUTION_MODE,
      controlOutcome: outcome,
      ...extra,
    };
  }
  /**
   * Settles a create whose reply never came. Its session being listed means DSH made it; long
   * overdue, a DSH that listed its sessions since and has none under that ID never made it.
   */
  #settleCreate(id: string, requestId: string): Record<string, unknown> | null {
    const command = readUnknownManagedCommands(this.options.dataDir, id).find(
      (item) => item.requestId === requestId,
    );
    if (command?.evidence?.operation !== "create") return null;
    const claimedAt = Number(command.evidence.claimedAt);
    const giveUp = this.options.reconcileGiveUpMs ?? RECONCILE_GIVE_UP_MS;
    const listed = this.#ids.has(id);
    const absent =
      Date.now() - claimedAt >= giveUp &&
      this.#online().some(
        (runtime) => runtime.services.sessionController && runtime.listedAt > claimedAt,
      );
    if (!listed && !absent) return null;
    const outcome = listed
      ? this.#created(requestId, "accepted", { sessionId: id })
      : this.#created(requestId, "not-dispatched", { reason: "dsh-session-not-created" });
    finishManagedCommand(this.options.dataDir, requestId, outcome);
    this.#unknownSince.delete(requestId);
    if (!listed) this.#unknownSessions.delete(String(command.evidence.nativeSessionId));
    return outcome;
  }
  /**
   * The model and reasoning effort picker, read from DSH's own model catalog, and the permission
   * preset (sandbox mode with approval policy) as AgentKib's execution policy.
   */
  async #settingsState(id: string, nativeId: string): Promise<Record<string, unknown>> {
    const live = this.live(id, true);
    const unavailable = (reason: string) => ({
      available: false,
      reason,
      executionMode: DSH_EXECUTION_MODE,
      revision: live.revision,
    });
    const runtime = this.#controlRuntime(nativeId);
    if (!runtime) return unavailable("dsh-runtime-offline");
    const presets = this.#presets(runtime, nativeId);
    if (runtime.services.modelCatalog !== true && !presets)
      return unavailable("operation-unavailable");
    const [result, permissionResult] = await Promise.all([
      runtime.services.modelCatalog === true
        ? this.#command(runtime, { commandId: randomUUID(), type: "models", sessionId: nativeId })
        : null,
      presets
        ? this.#command(runtime, {
            commandId: randomUUID(),
            type: "permissions",
            sessionId: nativeId,
          })
        : null,
    ]);
    const permissions = permissionResult?.ok
      ? permissionsSchema.safeParse(permissionResult.value)
      : null;
    if (permissions?.success) this.#permissions.set(nativeId, permissions.data);
    else this.#permissions.delete(nativeId);
    const policy = permissions?.success ? permissions.data : null;
    // Read moments before a change by the same request, so a change names what the user saw.
    const policyFields = policy
      ? {
          policies: policy.options.map((option) => ({
            id: option.value,
            ...presetPresentation(option),
          })),
          policyWritable:
            live.queueEditEnabled === true
              ? { available: true }
              : {
                  available: false,
                  reason: (live.reason as string | undefined) ?? "operation-unavailable",
                },
          // DSH's `custom` (knobs matching no preset) is not a choice; leave the picker unset.
          policyId: policy.options.some((option) => option.value === policy.current)
            ? policy.current
            : null,
        }
      : null;
    // Plan mode is DSH's collaboration mode, switched with its own `/plan` as in its window, also
    // in a running turn; DSH applies it at the next step.
    const planOn = planSelected(policy?.plan);
    const planFields =
      planOn !== null && this.#commandsFor(runtime, nativeId).some((entry) => entry.name === "plan")
        ? {
            mode: planOn ? "plan" : "default",
            collaborationModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
            writable:
              live.queueEditEnabled === true
                ? { available: true }
                : {
                    available: false,
                    reason: (live.reason as string | undefined) ?? "operation-unavailable",
                  },
          }
        : null;
    const modeFields = planFields
      ? { collaborationModes: planFields.collaborationModes }
      : { collaborationModes: [] };
    const modeWritable = planFields?.writable ?? {
      available: false,
      reason: "operation-unavailable",
    };
    if (!result) {
      return {
        available: true,
        executionMode: DSH_EXECUTION_MODE,
        revision: live.revision,
        current: {
          ...(policyFields?.policyId ? { policyId: policyFields.policyId } : {}),
          ...(planFields ? { mode: planFields.mode } : {}),
        },
        defaults: {},
        applicationStatus: "confirmed",
        models: [],
        policies: policyFields?.policies ?? [],
        ...modeFields,
        writable: {
          model: { available: false, reason: "operation-unavailable" },
          effort: { available: false, reason: "operation-unavailable" },
          mode: modeWritable,
          policy: policyFields?.policyWritable ?? {
            available: false,
            reason: "dsh-permissions-unavailable",
          },
        },
      };
    }
    const parsed = result.ok ? modelsSchema.safeParse(result.value) : null;
    if (!parsed?.success) return unavailable("dsh-models-unavailable");
    const catalog = parsed.data;
    this.#models.set(nativeId, catalog);
    const values = (selection: DshModels["default"]) =>
      selection
        ? { model: modelId(selection.provider, selection.model), effort: selection.reasoningEffort }
        : { model: null, effort: null };
    const current = values(catalog.selected ?? catalog.default);
    // The same model name can come from more than one provider.
    const names = new Map<string, number>();
    for (const model of catalog.models) names.set(model.name, (names.get(model.name) ?? 0) + 1);
    const writable = live.queueEditEnabled === true && live.status === "idle";
    // Why an offered choice cannot change now: a running turn keeps its model until it ends.
    const blocked =
      live.queueEditEnabled === true
        ? "session-busy"
        : ((live.reason as string | undefined) ?? "operation-unavailable");
    const choice = (offered: boolean) =>
      !offered
        ? { available: false, reason: "operation-unavailable" }
        : writable
          ? { available: true }
          : { available: false, reason: blocked };
    const selected = {
      ...current,
      ...(policyFields?.policyId ? { policyId: policyFields.policyId } : {}),
      ...(planFields ? { mode: planFields.mode } : {}),
    };
    return {
      available: true,
      executionMode: DSH_EXECUTION_MODE,
      revision: live.revision,
      current: selected,
      selected,
      defaults: values(catalog.default),
      applicationStatus: "confirmed",
      models: catalog.models.map((model) => ({
        id: modelId(model.provider, model.model),
        name:
          (names.get(model.name) ?? 0) > 1 ? `${model.name} · ${model.providerName}` : model.name,
        // DSH's own model menu lists models under their provider.
        group: model.providerName,
        efforts: model.efforts.map((effort) => effort.id),
        ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
      })),
      policies: policyFields?.policies ?? [],
      ...modeFields,
      writable: {
        model: choice(catalog.models.length > 0),
        effort: choice(catalog.models.some((model) => model.efforts.length > 0)),
        mode: modeWritable,
        policy: policyFields?.policyWritable ?? {
          available: false,
          reason: presets ? "dsh-permissions-unavailable" : "operation-unavailable",
        },
      },
    };
  }
  /** DSH's permission presets can be read and switched with its own `/permission`. */
  #presets(runtime: Runtime, nativeId: string): boolean {
    return (
      runtime.services.permissions === true &&
      this.#commandsFor(runtime, nativeId).some((entry) => entry.name === "permission")
    );
  }
  /**
   * The slash commands a session offers, as DSH's window lists them: its running agent's own
   * list. A session without one gets the commands every session has and those its running
   * siblings have, which it gets too once DSH resumes it. Only for the `/` menu and for what the
   * capabilities offer; the plugin decides with the session's own registry when a message comes.
   */
  #commandsFor(runtime: Runtime, nativeId: string): DshBridgeCommandEntry[] {
    if (runtime.services.commands !== true) return [];
    const own = runtime.sessionCommands.get(nativeId);
    if (own) return own;
    const byName = new Map(runtime.slashCommands.map((entry) => [entry.name, entry]));
    for (const entries of runtime.sessionCommands.values())
      for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  /**
   * The goal panel. DSH bounds a goal by rounds, not tokens, and continues an active goal only
   * while armed: a session it resumed waits for a resume, so AgentKib shows that goal as paused.
   */
  async #goalState(id: string, nativeId: string): Promise<Record<string, unknown>> {
    const live = this.live(id, true);
    const unavailable = (reason: string) => ({
      sessionId: id,
      available: false,
      reason,
      revision: live.revision,
    });
    const runtime = this.#controlRuntime(nativeId);
    if (!runtime) return unavailable("dsh-runtime-offline");
    if (runtime.services.goals !== true) return unavailable("operation-unavailable");
    const result = await this.#command(runtime, {
      commandId: randomUUID(),
      type: "goal",
      sessionId: nativeId,
    });
    const parsed = result.ok
      ? z.object({ goal: goalSchema.nullable() }).strip().safeParse(result.value)
      : null;
    if (!parsed?.success) return unavailable("dsh-goal-unavailable");
    const goal = parsed.data.goal;
    const blocked = (live.reason as string | undefined) ?? "operation-unavailable";
    const choice = (offered: boolean, reason = "goal-action-unavailable") =>
      live.queueEditEnabled !== true
        ? { available: false, reason: blocked }
        : offered
          ? { available: true }
          : { available: false, reason };
    const armed = goal?.phase === "active" && goal.activation === "armed";
    const exhausted = !!goal && goal.roundsStarted >= goal.maxGoalRounds;
    return {
      sessionId: id,
      available: true,
      revision: live.revision,
      budget: "rounds",
      ...(goal
        ? {
            goal: {
              objective: goal.objective,
              status: goal.phase === "active" && !armed ? "paused" : goal.phase,
              rounds: { used: goal.roundsStarted, limit: goal.maxGoalRounds },
              ...(goal.blockedReason?.message ? { detail: goal.blockedReason.message } : {}),
            },
          }
        : {}),
      actions: {
        set: choice(true),
        pause: choice(armed),
        resume: choice(
          !!goal && goal.phase !== "complete" && !armed && !exhausted,
          exhausted ? "goal-rounds-exhausted" : "goal-action-unavailable",
        ),
        clear: choice(!!goal),
      },
    };
  }

  // ---- subagents --------------------------------------------------------------------------

  /** A child's ID, meaningful only under its parent and only in this run of AgentKib. */
  #childId(parent: string, child: string): string {
    return createHmac("sha256", this.#subagentSalt).update(`${parent}\0${child}`).digest("hex");
  }
  /**
   * The direct children DSH lists for a session; DSH shows them read-only too. Phones ask every
   * few seconds, so a listing is reused briefly, longer for a parent that is not running.
   */
  async #subagents(id: string, nativeId: string): Promise<Record<string, unknown>> {
    const empty = { version: 1, sessionId: id, agents: [], truncated: false };
    const runtime = this.#controlRuntime(nativeId);
    if (!runtime || runtime.services.subagents !== true) {
      this.#children.delete(nativeId);
      return empty;
    }
    const cached = this.#children.get(nativeId);
    const ttl = this.#state(nativeId).state?.live ? 2_000 : 30_000;
    if (cached && cached.runtime === runtime.token && Date.now() - cached.at < ttl)
      return cached.catalog;
    const result = await this.#command(runtime, {
      commandId: randomUUID(),
      type: "subagents",
      sessionId: nativeId,
    });
    const parsed = result.ok ? subagentsSchema.safeParse(result.value) : null;
    if (!parsed?.success) return cached?.catalog ?? empty;
    const ids = new Map<string, string>();
    const agents = parsed.data.agents.map((child) => {
      const childId = this.#childId(nativeId, child.sessionId);
      ids.set(childId, child.sessionId);
      return {
        id: childId,
        name: child.label?.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() || "DeepSeek Harness",
        agent: "deepseek-harness",
        status: child.status,
        ...(iso(child.createdAt) ? { updatedAt: iso(child.createdAt) } : {}),
        readable: true,
      };
    });
    const catalog = { version: 1, sessionId: id, agents, truncated: parsed.data.truncated };
    this.#children.set(nativeId, { runtime: runtime.token, at: Date.now(), ids, catalog });
    if (this.#children.size > 64) this.#children.delete(this.#children.keys().next().value!);
    return catalog;
  }
  /** One page of a child's history, read like any DSH session's. */
  async #subagentEvents(
    id: string,
    nativeId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const childId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(value.subagentId);
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(value.limit ?? 50);
    const cursor =
      value.cursor === null || value.cursor === undefined ? null : String(value.cursor);
    let child = this.#children.get(nativeId)?.ids.get(childId);
    if (!child) {
      await this.#subagents(id, nativeId);
      child = this.#children.get(nativeId)?.ids.get(childId);
    }
    if (!child) throw new Error("subagent-unavailable");
    const page = await this.events(child, cursor, limit);
    const runtime = this.#controlRuntime(child);
    return {
      ...page,
      version: 1,
      sessionId: id,
      subagentId: childId,
      // Paging starts over when another DSH process serves the child.
      epoch: this.#childId(childId, runtime?.runtimeId ?? "offline"),
    };
  }
  /** Asks the running DSH about this session's unconfirmed commands, at most once an interval. */
  #autoReconcile(nativeId: string): void {
    const now = Date.now();
    const interval = this.options.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    if (
      this.#reconciling.has(nativeId) ||
      now - (this.#reconciledAt.get(nativeId) ?? 0) < interval ||
      !this.#controlRuntime(nativeId) ||
      !this.#catalog.has(nativeId)
    )
      return;
    this.#reconciledAt.set(nativeId, now);
    this.#reconciling.add(nativeId);
    void this.#reconcile(this.options.sessionId(nativeId), nativeId, true)
      .catch(() => undefined)
      .finally(() => this.#reconciling.delete(nativeId));
  }
  /**
   * Settle commands whose result never came back. A sent message carries its request ID into
   * DSH's record, so finding it means accepted; once DSH no longer works on it and enough time
   * passed, its absence means it never ran. Other controls leave no record: long overdue, the
   * state they act on tells. Every later control is checked against the current state, so
   * ending a wait this way cannot repeat an action, and nothing is ever resent.
   */
  async #reconcile(id: string, nativeId: string, controls: boolean) {
    const runtime = this.#controlRuntime(nativeId);
    const unknown = readUnknownManagedCommands(this.options.dataDir, id);
    const giveUp = this.options.reconcileGiveUpMs ?? RECONCILE_GIVE_UP_MS;
    let reconciled = false;
    const settle = (requestId: string, outcome: "accepted" | "not-dispatched", reason?: string) => {
      finishManagedCommand(
        this.options.dataDir,
        requestId,
        this.#result(id, requestId, outcome, reason),
      );
      this.#unknownSince.delete(requestId);
      reconciled = true;
    };
    for (const command of unknown) {
      // A command still waiting for its result is not unconfirmed yet.
      if (!runtime || this.#inflight.get(id)?.requestId === command.requestId) continue;
      const evidence = command.evidence ?? {};
      const operation = String(evidence.operation);
      // This session is listed, so the create that reserved its ID ran.
      if (operation === "create") {
        if (this.#settleCreate(id, command.requestId)) reconciled = true;
        continue;
      }
      const since = this.#unknownSince.get(command.requestId) ?? Date.now();
      this.#unknownSince.set(command.requestId, since);
      const overdue = Date.now() - since >= giveUp;
      // The plugin keeps the requests of the slash commands it ran (`/compact` among them) until
      // DSH restarts; a sent message carries its request ID into DSH's record.
      if (["send", "steer", "queue-add", "compact"].includes(operation)) {
        const result = await this.#command(runtime, {
          commandId: randomUUID(),
          type: "verify",
          sessionId: nativeId,
          requestId: command.requestId,
        });
        const found = result.ok
          ? (result.value as { present?: boolean; inFlight?: boolean } | null)
          : null;
        if (found?.present === true) settle(command.requestId, "accepted");
        else if (found?.present === false && found.inFlight !== true && overdue)
          settle(command.requestId, "not-dispatched", "dsh-message-not-recorded");
        continue;
      }
      if (!overdue) continue;
      const state = this.#state(nativeId).state;
      const row = this.#catalog.get(nativeId);
      let selected: DshModels["selected"] = null;
      if (operation === "settings" && typeof evidence.provider === "string") {
        const models = await this.#command(runtime, {
          commandId: randomUUID(),
          type: "models",
          sessionId: nativeId,
        });
        const parsed = models.ok ? modelsSchema.safeParse(models.value) : null;
        selected = parsed?.success ? parsed.data.selected : null;
      }
      let preset: string | null = null;
      let plan: boolean | null = null;
      if (
        operation === "settings" &&
        (typeof evidence.preset === "string" || typeof evidence.plan === "boolean")
      ) {
        const permissions = await this.#command(runtime, {
          commandId: randomUUID(),
          type: "permissions",
          sessionId: nativeId,
        });
        const parsed = permissions.ok ? permissionsSchema.safeParse(permissions.value) : null;
        preset = parsed?.success ? parsed.data.current : null;
        plan = parsed?.success ? planSelected(parsed.data.plan) : null;
      }
      const goal = state?.goal ?? null;
      // A fork leaves no trace on its source, so it settles as not dispatched once overdue; a
      // copy that was made anyway still shows up in the session list.
      const applied = ["queue-delete", "queue-update", "queue-steer"].includes(operation)
        ? !queuedFor(state).some((item) => item.id === evidence.itemId)
        : operation === "stop"
          ? !(state?.status === "running" && turnIdOf(state.turn) === evidence.turnId)
          : ["approve", "answer"].includes(operation)
            ? !this.#interactions(nativeId).some((item) => item.id === evidence.interactionId)
            : operation === "rename"
              ? row?.title === evidence.title
              : operation === "archive" || operation === "unarchive"
                ? (row?.archived === true) === (evidence.archived === true)
                : operation === "settings"
                  ? (typeof evidence.preset !== "string" || preset === evidence.preset) &&
                    (typeof evidence.plan !== "boolean" || plan === evidence.plan) &&
                    (typeof evidence.provider !== "string" ||
                      (selected?.provider === evidence.provider &&
                        selected?.model === evidence.model &&
                        (selected?.reasoningEffort ?? null) === (evidence.reasoningEffort ?? null)))
                  : // A goal leaves its state: cleared, paused, continuing, or a new revision.
                    operation.startsWith("goal-")
                    ? evidence.goalAction === "clear"
                      ? !goal
                      : evidence.goalAction === "pause"
                        ? goal?.phase === "paused"
                        : evidence.goalAction === "resume"
                          ? goal?.phase === "active" && goal.activation === "armed"
                          : !!goal && goal.revision !== evidence.goalRevision
                    : false;
      settle(
        command.requestId,
        applied ? "accepted" : "not-dispatched",
        applied ? undefined : "control-outcome-expired",
      );
    }
    if (!readUnknownManagedCommands(this.options.dataDir, id).length) {
      this.#unknownSessions.delete(nativeId);
      this.#reconciledAt.delete(nativeId);
    }
    if (reconciled) {
      this.#touch(nativeId);
      this.#publish(nativeId, true);
      // Clients fencing these requests read their receipts again.
      this.options.publish(id, "invalidate", { domains: ["receipts"] }, this.live(id, controls));
    }
    return {
      accepted: false,
      completed: false,
      reconciled,
      sessionId: id,
      live: this.live(id, controls),
      reason: readUnknownManagedCommands(this.options.dataDir, id).length
        ? "control-outcome-unconfirmed"
        : undefined,
    };
  }
  receipt(value: unknown): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      (value as { executionMode?: unknown }).executionMode !== DSH_EXECUTION_MODE
    )
      return value;
    let result = value as Record<string, unknown>;
    // The new-session dialog that sent an unconfirmed create waits on this receipt.
    if (result.operation === "create" && result.status === "unknown") {
      const ack = this.#settleCreate(String(result.sessionId), String(result.requestId));
      if (ack)
        result = { ...result, status: ack.accepted === true ? "accepted" : "not-dispatched", ack };
    }
    return {
      ...result,
      completionObserved: (result.ack as Record<string, unknown> | undefined)?.completed === true,
    };
  }
  /** Revoked device authorization also fences commands not yet delivered to the plugin. */
  invalidate(deviceId?: string, sessionId?: string): void {
    void deviceId;
    for (const runtime of this.#runtimes.values())
      for (const waiter of runtime.commands.values()) {
        if (waiter.delivered) continue;
        const command = waiter.command as { sessionId?: string };
        if (
          sessionId &&
          command.sessionId &&
          this.options.sessionId(command.sessionId) !== sessionId
        )
          continue;
        const index = runtime.queue.indexOf(waiter.command);
        if (index >= 0) runtime.queue.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.settle({ ok: false, error: "not-dispatched" });
      }
  }

  #result(
    id: string,
    requestId: string,
    outcome: string,
    reason?: string,
  ): Record<string, unknown> {
    return {
      accepted: outcome === "accepted",
      completed: false,
      requestId,
      sessionId: id,
      runtimeBootId: this.options.bootId,
      controlOutcome: outcome,
      ...(outcome === "unknown"
        ? { reason: "control-outcome-unconfirmed" }
        : reason
          ? { reason }
          : {}),
      live: this.live(id, true),
    };
  }

  async #control(
    value: Record<string, unknown>,
    id: string,
    nativeId: string,
  ): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "text",
      "input",
      "turnId",
      "queuedSubmissionId",
      "approvalId",
      "decision",
      "nativeDecision",
      "questionId",
      "answers",
      "publicInputHash",
      "historyInputHash",
      "historyReferences",
      // Rename and model settings.
      "name",
      "model",
      "effort",
      "resetDefaults",
      // Permission preset, goals, and whether the device may run every DSH command.
      "commandAccess",
      "policyId",
      "mode",
      "goal",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw new Error("invalid-managed-control");
    const requestId = uuid.parse(value.requestId);
    const deviceId = z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .parse(value.deviceId);
    const revision = z.number().safe().int().nonnegative().parse(value.expectedRevision);
    const fingerprint = digest(stable({ ...value, runtimeBootId: undefined })).toString("hex");
    const replay = replayManagedCommand(this.options.dataDir, requestId, fingerprint);
    if (replay) return replay;
    // Sending, renaming or forking while no DSH runs starts one in the background. The request
    // was decided on the state the client saw then; DSH registering moves the revision on.
    let started = false;
    if (
      STARTING_CONTROLS.has(String(value.operation)) &&
      value.experimentalEnabled === true &&
      value.runtimeBootId === this.options.bootId &&
      !this.#controlRuntime(nativeId) &&
      this.#startable()
    ) {
      if (revision !== this.live(id, true).revision)
        return this.#result(id, requestId, "not-dispatched", "stale-dsh-revision");
      if (this.#inflight.has(id))
        return this.#result(id, requestId, "not-dispatched", "session-busy");
      try {
        await this.#ensureManaged();
      } catch (error) {
        return this.#result(id, requestId, "not-dispatched", preflightReason(error));
      }
      started = true;
    }
    const prepare = () => {
      if (
        this.#closed ||
        !this.supported ||
        value.experimentalEnabled !== true ||
        value.runtimeBootId !== this.options.bootId
      )
        throw new Error("control-unavailable");
      const live = this.live(id, true);
      const runtime = this.#controlRuntime(nativeId);
      if (!runtime) throw new Error("dsh-runtime-offline");
      if (revision !== live.revision && !started) throw new Error("stale-dsh-revision");
      if (this.#inflight.has(id)) throw new Error("session-busy");
      const text = (): string => {
        const input = value.text ?? value.input;
        if (
          typeof input !== "string" ||
          !input.trim() ||
          input.length > 16_000 ||
          Buffer.byteLength(input) > 16_384
        )
          throw new Error("invalid-text-input");
        return input;
      };
      // A message with attachments arrives as content the Host's attachment store built.
      const content = (): DshBridgePromptPart[] => {
        if (!Array.isArray(value.input)) return [{ type: "text", text: text() }];
        const parts = promptContentSchema.parse(value.input);
        if (!parts.some((part) => part.type === "image" || part.text.trim()))
          throw new Error("invalid-text-input");
        if (parts.some((part) => part.type === "image") && runtime.services.images !== true)
          throw new Error("dsh-attachments-unavailable");
        return parts;
      };
      const commandId = randomUUID();
      // A message naming one of the session's slash commands runs as that command, as in DSH's
      // own window, also while a turn runs. The plugin decides with the session's own registry;
      // the Host says whether the device may run the commands that need full access.
      const message = (mode: "queue" | "steer"): Command => ({
        commandId,
        type: "prompt",
        sessionId: nativeId,
        requestId,
        mode,
        content: content(),
        ...(value.commandAccess === "all" ? { fullAccess: true } : {}),
      });
      let command: Command;
      // A preset and a model change are two native steps; this is the second.
      let then: Command | undefined;
      switch (value.operation) {
        case "send":
          if (live.sendEnabled !== true) throw new Error("session-busy");
          command = message("queue");
          break;
        case "queue-add":
          if (live.queueEnabled !== true) throw new Error("session-busy");
          command = message("queue");
          break;
        case "steer":
          if (live.steerEnabled !== true || value.turnId !== live.turnId)
            throw new Error("stale-turn");
          command = message("steer");
          break;
        case "queue-delete":
        case "queue-update":
        case "queue-steer": {
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          if (value.operation === "queue-steer" && live.steerEnabled !== true)
            throw new Error("stale-turn");
          const itemId = z.string().min(1).max(256).parse(value.queuedSubmissionId);
          if (!queuedFor(this.#state(nativeId).state).some((item) => item.id === itemId))
            throw new Error("queue-item-unavailable");
          command = {
            commandId,
            type: "queue",
            sessionId: nativeId,
            itemId,
            action:
              value.operation === "queue-delete"
                ? { kind: "remove" }
                : value.operation === "queue-steer"
                  ? { kind: "steer" }
                  : { kind: "edit", text: text() },
          };
          break;
        }
        case "stop":
          if (live.stopEnabled !== true || value.turnId !== live.turnId)
            throw new Error("stale-turn");
          command = { commandId, type: "cancel", sessionId: nativeId };
          break;
        case "approve": {
          const approval = this.#interactions(nativeId).find(
            (item) => item.kind === "approval" && item.id === value.approvalId,
          );
          if (!approval)
            throw new Error(
              this.#answered.has(String(value.approvalId))
                ? "interaction-answered-elsewhere"
                : "approval-unavailable",
            );
          const decision = value.nativeDecision ?? value.decision;
          if (decision !== "accept" && decision !== "decline") throw new Error("invalid-decision");
          command = {
            commandId,
            type: "answer",
            interactionId: approval.id,
            value: { outcome: decision === "accept" ? "allowed-once" : "rejected" },
          };
          break;
        }
        case "answer": {
          const question = this.#interactions(nativeId).find(
            (item) => item.kind === "question" && item.id === value.questionId,
          ) as Extract<DshBridgeInteraction, { kind: "question" }> | undefined;
          if (!question)
            throw new Error(
              this.#answered.has(String(value.questionId))
                ? "interaction-answered-elsewhere"
                : "question-unavailable",
            );
          const answers = z
            .record(z.string(), z.array(z.string().max(16_000)).max(32))
            .parse(value.answers);
          command = {
            commandId,
            type: "answer",
            interactionId: question.id,
            value: {
              answers: question.questions.map((item) => {
                const values = answers[item.id] ?? [];
                const labels = new Set(item.options.map((option) => option.label));
                if (item.intent?.kind === "approval" && item.intent.always)
                  labels.add(item.intent.always);
                const selected = values.filter((entry) => labels.has(entry));
                const custom = values
                  .filter((entry) => !labels.has(entry))
                  .join("\n")
                  .trim();
                return { id: item.id, selected, ...(custom ? { custom } : {}) };
              }),
            },
          };
          break;
        }
        case "rename": {
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          const title = typeof value.name === "string" ? value.name.trim() : "";
          if (!title || title.length > 200) throw new Error("invalid-name");
          command = { commandId, type: "rename", sessionId: nativeId, title };
          break;
        }
        case "archive":
        case "unarchive":
          if (runtime.services.workspaceController !== true)
            throw new Error("operation-unavailable");
          // DSH refuses to archive an active session rather than stop its work.
          if (live.queueEditEnabled !== true || live.status !== "idle")
            throw new Error("session-busy");
          command = {
            commandId,
            type: "archive",
            sessionId: nativeId,
            archived: value.operation === "archive",
          };
          break;
        case "fork":
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          command = { commandId, type: "fork", sessionId: nativeId };
          break;
        case "settings": {
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          const steps: Command[] = [];
          if (value.mode !== undefined) {
            // A plan switch goes alone, as DSH's own composer chip and `/plan` make it.
            if (
              value.policyId !== undefined ||
              value.model !== undefined ||
              value.effort !== undefined ||
              value.resetDefaults === true
            )
              throw new Error("invalid-settings");
            if (!this.#commandsFor(runtime, nativeId).some((entry) => entry.name === "plan"))
              throw new Error("operation-unavailable");
            const mode = z.enum(["default", "plan"]).parse(value.mode);
            // Read moments before by the same request, so this is the mode the user saw.
            const permissions = this.#permissions.get(nativeId);
            if (!permissions || planSelected(permissions.plan) === null)
              throw new Error("stale-settings");
            command = {
              commandId,
              type: "command",
              sessionId: nativeId,
              requestId,
              line: mode === "plan" ? "/plan" : "/plan off",
            };
            break;
          }
          // A preset applies to the next approval, also in a running turn, as in DSH's window.
          if (value.policyId !== undefined) {
            if (!this.#presets(runtime, nativeId)) throw new Error("operation-unavailable");
            // Read moments before by the same request, so this is a preset the user saw.
            const permissions = this.#permissions.get(nativeId);
            if (!permissions) throw new Error("stale-settings");
            const preset = z.string().min(1).max(128).parse(value.policyId);
            if (!permissions.options.some((option) => option.value === preset))
              throw new Error("invalid-policy");
            if (preset !== permissions.current)
              steps.push({
                commandId,
                type: "command",
                sessionId: nativeId,
                requestId,
                line: `/permission ${preset}`,
              });
          }
          if (
            value.model !== undefined ||
            value.effort !== undefined ||
            value.resetDefaults === true ||
            !steps.length
          ) {
            if (runtime.services.modelCatalog !== true) throw new Error("operation-unavailable");
            // Read moments before by the same request, so this is the selection the user saw.
            const catalog = this.#models.get(nativeId);
            if (!catalog) throw new Error("stale-settings");
            const current = catalog.selected ?? catalog.default;
            // The Host offers "restore defaults" whenever DSH reports a default model.
            const reset = value.resetDefaults === true;
            const target = reset
              ? catalog.default
              : value.model === undefined
                ? current
                : parseModelId(value.model);
            if (!target) throw new Error("invalid-model");
            const model = catalog.models.find(
              (entry) => entry.provider === target.provider && entry.model === target.model,
            );
            if (!model) throw new Error("invalid-model");
            // An effort change keeps the model; a new model starts at its own default effort.
            const effort = reset
              ? (catalog.default?.reasoningEffort ?? null)
              : typeof value.effort === "string"
                ? value.effort
                : value.model === undefined
                  ? (current?.reasoningEffort ?? null)
                  : null;
            if (effort !== null && !model.efforts.some((entry) => entry.id === effort))
              throw new Error("invalid-effort");
            const unchanged =
              current?.provider === model.provider &&
              current.model === model.model &&
              (current.reasoningEffort ?? null) === effort;
            // The settings dialog sends the model it shows along with a new preset.
            if (!unchanged || !steps.length) {
              // A running turn keeps its model until it ends.
              if (live.status !== "idle" || live.activity === "compacting")
                throw new Error("session-busy");
              steps.push({
                commandId: steps.length ? randomUUID() : commandId,
                type: "selectModel",
                sessionId: nativeId,
                provider: model.provider,
                model: model.model,
                ...(effort !== null ? { reasoningEffort: effort } : {}),
              });
            }
          }
          [command, then] = steps as [Command, Command | undefined];
          break;
        }
        case "goal-set":
        case "goal-pause":
        case "goal-resume":
        case "goal-clear": {
          if (runtime.services.goals !== true) throw new Error("operation-unavailable");
          if (live.queueEditEnabled !== true) throw new Error("session-busy");
          const goal = value.goal as { objective?: unknown; tokenBudget?: unknown } | undefined;
          if (value.operation === "goal-set") {
            const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
            if (!objective || objective.length > 16_000) throw new Error("invalid-objective");
            // DSH bounds a goal by rounds, not tokens.
            if (goal?.tokenBudget !== undefined && goal.tokenBudget !== null)
              throw new Error("goal-token-budget-unavailable");
          }
          // The goal this DSH runs; a change made meanwhile in DSH's window bumped the revision.
          const ref = this.#state(nativeId).state?.goal;
          command = {
            commandId,
            type: "goal-control",
            sessionId: nativeId,
            action: value.operation.slice("goal-".length) as "set" | "pause" | "resume" | "clear",
            ...(value.operation === "goal-set"
              ? { objective: (goal!.objective as string).trim() }
              : {}),
            ...(ref ? { goalId: ref.id, goalRevision: ref.revision } : {}),
          };
          break;
        }
        case "compact":
          // DSH's own `/compact`, which needs the session idle.
          if (!this.#commandsFor(runtime, nativeId).some((entry) => entry.name === "compact"))
            throw new Error("operation-unavailable");
          if (live.queueEditEnabled !== true || live.status !== "idle" || live.activity)
            throw new Error("session-busy");
          command = {
            commandId,
            type: "command",
            sessionId: nativeId,
            requestId,
            line: "/compact",
          };
          break;
        default:
          throw new Error("operation-unavailable");
      }
      return { live, runtime, command, commandId, then };
    };
    let prepared: ReturnType<typeof prepare>;
    try {
      prepared = prepare();
    } catch (error) {
      // Refused before anything reached DSH. Saying so keeps the client's draft and does not
      // fence the session as if the outcome were unknown.
      return this.#result(id, requestId, "not-dispatched", preflightReason(error));
    }
    const { live, runtime, command, commandId, then } = prepared;
    const selection = [command, then].find((step) => step?.type === "selectModel");
    const preset =
      command.type === "command" &&
      value.operation === "settings" &&
      command.line.startsWith("/permission ")
        ? command.line.slice("/permission ".length)
        : null;
    const plan =
      command.type === "command" &&
      value.operation === "settings" &&
      command.line.startsWith("/plan")
        ? command.line === "/plan"
        : null;
    const evidence = {
      operation: value.operation,
      commandId,
      runtimeId: runtime.runtimeId,
      nativeId,
      workspaceId: live.workspaceId,
      runtimeBootId: this.options.bootId,
      expectedRevision: revision,
      turnId: value.turnId ?? null,
      executionMode: DSH_EXECUTION_MODE,
      ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      ...(value.historyInputHash ? { historyInputHash: value.historyInputHash } : {}),
      // What an unconfirmed control acted on, for settling it from the state later.
      ...(command.type === "queue" ? { itemId: command.itemId } : {}),
      ...(command.type === "answer" ? { interactionId: command.interactionId } : {}),
      ...(command.type === "rename" ? { title: command.title } : {}),
      ...(command.type === "archive" ? { archived: command.archived } : {}),
      ...(selection?.type === "selectModel"
        ? {
            provider: selection.provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort ?? null,
          }
        : {}),
      ...(preset ? { preset } : {}),
      ...(plan !== null ? { plan } : {}),
      ...(command.type === "goal-control"
        ? { goalAction: command.action, goalRevision: command.goalRevision ?? null }
        : {}),
    };
    const prior = claimManagedCommand(
      this.options.dataDir,
      requestId,
      id,
      fingerprint,
      deviceId,
      evidence,
    );
    if (prior) return prior;
    this.#inflight.set(id, { requestId, commandId, runtime: runtime.token });
    this.#touch(nativeId);
    this.#publish(nativeId);
    try {
      let result = await this.#command(runtime, command, undefined, () =>
        dispatchManagedCommand(this.options.dataDir, requestId),
      );
      // A command a person typed ran once DSH matched it; its answer is in the session's
      // history, as in DSH's own window. One AgentKib runs for its own control must succeed.
      const typed = ["send", "steer", "queue-add"].includes(String(value.operation));
      const refusal = (step: Command, reply: typeof result) => {
        const answer = reply.value as {
          command?: unknown;
          matched?: unknown;
          running?: unknown;
          ok?: unknown;
        } | null;
        // A message that ran as a command says which; any other message went to the model.
        if (!reply.ok || (step.type === "prompt" ? !answer?.command : step.type !== "command"))
          return null;
        if (answer?.matched !== true) return "dsh-command-unavailable";
        return !typed && answer.running !== true && answer.ok !== true
          ? "dsh-command-failed"
          : null;
      };
      const refused = refusal(command, result);
      // The preset is set; a model change refused now leaves it, and the settings read again.
      let partial = false;
      if (result.ok && !refused && then) {
        const second = await this.#command(runtime, then);
        if (second.ok || second.error === "unknown") result = second;
        else partial = true;
      }
      if (!result.ok && command.type === "goal-control")
        result = { ...result, error: goalRefusal(result.error) };
      // Clients open a fork from the reply, as they do a Codex fork; still in flight, wait for
      // DSH to list it first.
      const child = result.ok ? (result.value as { sessionId?: unknown } | null)?.sessionId : null;
      const forked = command.type === "fork" && typeof child === "string" && child ? child : null;
      if (forked) await this.#listed(forked);
      this.#inflight.delete(id);
      let outcome: Record<string, unknown>;
      if (result.ok && refused) {
        outcome = this.#result(id, requestId, "not-dispatched", refused);
        finishManagedCommand(this.options.dataDir, requestId, outcome);
      } else if (result.ok) {
        const found = (result.value as { found?: boolean } | null)?.found;
        if (command.type === "answer" && found === false) {
          this.#answered.set(command.interactionId, { by: "native", at: Date.now() });
          outcome = this.#result(id, requestId, "not-dispatched", "interaction-answered-elsewhere");
        } else if (partial) {
          outcome = this.#result(id, requestId, "accepted", "dsh-settings-partial");
        } else {
          if (command.type === "answer")
            this.#answered.set(command.interactionId, { by: "agentkib", at: Date.now() });
          outcome = this.#result(id, requestId, "accepted");
          if (forked)
            outcome = { ...outcome, sessionId: this.options.sessionId(forked), completed: true };
        }
        finishManagedCommand(this.options.dataDir, requestId, outcome);
      } else if (result.error === "unknown") {
        // Delivered, but the plugin never reported back. Keep it unknown; never resend. The
        // running DSH is asked about it again until its record or state settles it.
        outcome = this.#result(id, requestId, "unknown");
        this.#unknownSessions.add(nativeId);
        this.#unknownSince.set(requestId, Date.now());
      } else {
        outcome = this.#result(id, requestId, "not-dispatched", dshRefusal(result.error));
        finishManagedCommand(this.options.dataDir, requestId, outcome);
      }
      this.#touch(nativeId);
      this.#publish(nativeId, result.ok);
      const settled = { ...outcome, live: this.live(id, true) };
      // The stored result was built while this request still counted as unconfirmed, so its
      // snapshot says "outcome-unknown". A replay or a receipt would hand that to a client,
      // which would take it as the session's state.
      if (outcome.controlOutcome !== "unknown")
        finishManagedCommand(this.options.dataDir, requestId, settled);
      return settled;
    } finally {
      this.#inflight.delete(id);
    }
  }

  // ---- management -------------------------------------------------------------------------

  management(value: Record<string, unknown>): Record<string, unknown> {
    z.object({ operation: z.literal("dsh-bridge-status"), deviceId: z.literal(LOCAL_OWNER) })
      .strip()
      .parse(value);
    const runtimes = this.#online().map((runtime) => ({
      runtimeId: runtime.runtimeId,
      dshVersion: runtime.dshVersion,
      compatibility: dshBridgeCompatibility(runtime.dshVersion),
      pluginVersion: runtime.pluginVersion,
      sessionController: runtime.services.sessionController,
      sessions: runtime.summaries.size,
      managed: runtime.managed,
      running: [...runtime.states.values()].filter(
        (state) => state.live && state.status === "running",
      ).length,
    }));
    const directory = this.options.pluginDirectory.replaceAll("'", "'\\''");
    const managed = this.options.managed;
    const status = managed?.runtime.status();
    const availability = managed && this.supported ? this.#managedAvailability() : null;
    return {
      supported: this.supported,
      listening: !!this.#server?.listening,
      reason: !this.supported
        ? "platform-unsupported"
        : this.#startupFailed
          ? "dsh-bridge-unavailable"
          : undefined,
      pluginVersion: DSH_BRIDGE_PLUGIN_VERSION,
      pluginDirectory: this.options.pluginDirectory,
      runtimes,
      // Starting DSH in the background when none of the user's runs.
      autoStart:
        managed && status && availability
          ? {
              enabled: managed.enabled(),
              available: availability.available,
              ...(availability.available ? {} : { reason: availability.reason }),
              phase: status.phase,
              launcher: status.launcher,
              version: status.version,
              failure: status.failure?.reason ?? null,
            }
          : null,
      installInstructions: [
        `dsh plugin --profile web add '${directory}'`,
        "# Restart DeepSeek Harness afterwards.",
      ].join("\n"),
    };
  }

  // ---- transport --------------------------------------------------------------------------

  async #listen(): Promise<void> {
    if (this.#closed) throw new Error("dsh-bridge-unavailable");
    if (this.#server?.listening) return;
    if (this.#listening) return this.#listening;
    this.#listening = (async () => {
      privatePath(this.root, true);
      this.#releaseLock = acquirePortableFileLease(path.join(this.root, "broker.lock"));
      const identity = digest(realpathSync(this.root)).toString("hex").slice(0, 20);
      const directory = path.join(
        realpathSync("/tmp"),
        `akdsh-${process.getuid?.() ?? 0}-${identity}`,
      );
      privatePath(directory, true);
      const socket = path.join(directory, "b.sock");
      if (Buffer.byteLength(socket) >= 104) throw new Error("dsh-bridge-socket-path-too-long");
      if (existsSync(socket)) {
        const stat = lstatSync(socket);
        if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
          throw new Error("unsafe-dsh-bridge-socket");
        // The persistent file lease excludes another broker for this exact data directory.
        rmSync(socket);
      }
      const server = createServer((request, response) => void this.#http(request, response));
      server.requestTimeout = POLL_MS + 10_000;
      server.headersTimeout = 5_000;
      server.maxConnections = 64;
      this.#socketPath = socket;
      this.#socketDirectory = directory;
      this.#server = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(socket, 0o600);
      this.#startupFailed = false;
      const file = this.options.discoveryFile;
      if (file)
        try {
          privateJson(file, { protocol: 1, socketPath: socket, key: this.#key });
        } catch {
          // Without discovery the plugin cannot find this Runtime; status reports it.
          this.#startupFailed = true;
        }
    })()
      .catch((error) => {
        this.#startupFailed = true;
        this.#releaseLock?.();
        this.#releaseLock = undefined;
        throw error;
      })
      .finally(() => {
        this.#listening = undefined;
      });
    return this.#listening;
  }

  #runtimeFor(token: string): Runtime {
    const runtime = this.#runtimes.get(token);
    if (!runtime) throw new BridgeHttpError(401, "unknown-runtime");
    runtime.lastSeen = Date.now();
    return runtime;
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    try {
      if (
        this.#closed ||
        request.method !== "POST" ||
        request.headers.host !== "localhost" ||
        request.headers.origin
      ) {
        reply(403, { error: "bridge-request-rejected" });
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const raw of request) {
        const chunk = Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > MAX_BODY) {
          reply(413, { error: "bridge-body-too-large" });
          return;
        }
        chunks.push(chunk);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      switch (request.url) {
        case DSH_BRIDGE_PATHS.register: {
          const hello = registerSchema.parse(value);
          const expected = Buffer.from(this.#key);
          const actual = Buffer.from(hello.key);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw new BridgeHttpError(403, "invalid-key");
          if (hello.protocol !== DSH_BRIDGE_PROTOCOL)
            throw new BridgeHttpError(409, "dsh-bridge-protocol-unsupported");
          // A plugin of another release connects too; what it does not report stays off.
          if (dshBridgePluginCompatibility(hello.pluginVersion) !== "supported")
            throw new BridgeHttpError(409, "dsh-bridge-plugin-update-required");
          if (dshBridgeCompatibility(hello.dshVersion) === "too-old")
            throw new BridgeHttpError(409, "dsh-version-too-old");
          // A background DSH being stopped stays out; it exits in a moment.
          if (this.#managedStopping !== null && this.#managedStopping === hello.pid)
            throw new BridgeHttpError(409, "dsh-runtime-stopping");
          for (const runtime of [...this.#runtimes.values()])
            if (runtime.runtimeId === hello.runtimeId) this.#drop(runtime);
          if (this.#runtimes.size >= MAX_RUNTIMES)
            throw new BridgeHttpError(429, "dsh-bridge-busy");
          const first = this.#online().length === 0;
          const token = randomBytes(32).toString("hex");
          // The DSH this AgentKib started is known by its process, not by what the plugin says.
          const managed =
            this.options.managed !== undefined && this.options.managed.runtime.pid === hello.pid;
          if (managed) this.options.managed!.runtime.started();
          this.#runtimes.set(token, {
            token,
            runtimeId: hello.runtimeId,
            dshVersion:
              dshBridgeCompatibility(hello.dshVersion) === "invalid" ? "unknown" : hello.dshVersion,
            pluginVersion: hello.pluginVersion,
            pid: hello.pid,
            managed,
            services: hello.services,
            lastSeen: Date.now(),
            listedAt: 0,
            reportedAt: 0,
            summaries: new Map(),
            states: new Map(),
            interactions: new Map(),
            slashCommands: [],
            sessionCommands: new Map(),
            queue: [],
            commands: new Map(),
          });
          reply(200, { token, bootId: this.options.bootId });
          // Listings refresh their marks once a runtime can serve and continue these sessions.
          if (first) this.options.sessionsChanged(this.#workspaceIds(this.#catalog.keys()));
          return;
        }
        case DSH_BRIDGE_PATHS.report: {
          const report = reportSchema.parse(value);
          const runtime = this.#runtimeFor(report.token);
          reply(200, { watch: this.#apply(runtime, report) });
          return;
        }
        case DSH_BRIDGE_PATHS.poll: {
          const { token } = z.object({ token: z.string() }).strip().parse(value);
          const runtime = this.#runtimeFor(token);
          if (!runtime.queue.length)
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, POLL_MS);
              runtime.waiting = () => {
                clearTimeout(timer);
                resolve();
              };
              response.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          runtime.waiting = undefined;
          if (response.destroyed) {
            // The plugin dropped its poll. A live one polls again at once; silence means DSH
            // quit, so its sessions stop showing as connected well before OFFLINE_MS.
            const seen = runtime.lastSeen;
            setTimeout(() => {
              if (this.#runtimes.get(runtime.token) === runtime && runtime.lastSeen === seen)
                this.#drop(runtime);
            }, this.options.disconnectGraceMs ?? DISCONNECT_GRACE_MS).unref();
            return;
          }
          if (!this.#runtimes.has(runtime.token)) return;
          const commands = runtime.queue.splice(0);
          for (const command of commands) {
            const waiter = runtime.commands.get(command.commandId);
            if (!waiter) continue;
            waiter.delivered = true;
            waiter.onDelivered?.();
          }
          runtime.lastSeen = Date.now();
          reply(200, { commands });
          return;
        }
        case DSH_BRIDGE_PATHS.result: {
          const result = resultSchema.parse(value);
          const runtime = this.#runtimeFor(result.token);
          const waiter = runtime.commands.get(result.commandId);
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.settle(
              result.ok
                ? { ok: true, value: result.value }
                : { ok: false, error: result.error ?? "error" },
            );
          }
          reply(200, { ok: true });
          return;
        }
        default:
          reply(404, { error: "not-found" });
      }
    } catch (error) {
      if (error instanceof BridgeHttpError) reply(error.status, { error: error.message });
      else reply(400, { error: "bridge-request-invalid" });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    clearInterval(this.#managedTimer);
    // The DSH this AgentKib started goes with it; a turn still running there is recorded by DSH
    // as interrupted. The user was told before quitting.
    await this.options.managed?.runtime.stop().catch(() => undefined);
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      try {
        privateJson(path.join(this.root, "sessions-v1.json"), {
          version: 1,
          sessions: [...this.#catalog.values()].slice(0, CATALOG_LIMIT),
        });
      } catch {
        // Offline listing only.
      }
    }
    await this.#listening?.catch(() => undefined);
    const file = this.options.discoveryFile;
    if (file)
      try {
        // Another AgentKib instance may own the file by now; remove only our own key.
        if (JSON.parse(readFileSync(file, "utf8"))?.key === this.#key)
          rmSync(file, { force: true });
      } catch {
        /* Missing or foreign discovery files are left alone. */
      }
    for (const runtime of [...this.#runtimes.values()]) this.#drop(runtime);
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closing;
    }
    if (this.#socketPath) rmSync(this.#socketPath, { force: true });
    if (this.#socketDirectory && existsSync(this.#socketDirectory))
      rmdirSync(this.#socketDirectory);
    this.#releaseLock?.();
    this.#releaseLock = undefined;
  }
}
