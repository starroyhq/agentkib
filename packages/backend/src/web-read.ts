import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  SESSION_COLLECTIONS,
  sessionProviderCapabilities,
  type ConversationReadResult,
} from "@agentkib/runtime-protocol";
import { historyReferenceSchema, validHistoryControl } from "./history-control-schema";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import type { ReadStateTarget } from "./conversation-read-state";
import { enrichLedgerImages } from "./session-image-matching";
import type { ConversationImage } from "./session-events";
import type { SessionIndex } from "./session-index";
import {
  hasManagedCatalogWorkspace,
  managedCatalogAliases,
  managedCatalogProjection,
  managedRecordSchema,
  readManagedCatalog,
} from "./managed-session-catalog";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { catalogCheckouts } from "./git-checkouts";
import { conversationReadKey, ReadStateLedger } from "./read-state-ledger";
import { codexTurnMeta, isCodexTurnEndEvent } from "./codex-turn-end";
import { codexExecutable } from "./codex-executable";
import {
  CodexAppServerReader,
  CodexAppServerSession,
  codexThreadMissing,
  codexWriterBusy,
} from "./codex-app-server";
import {
  CodexRuntimePreflight,
  codexReleaseSupportsWriterLock,
  codexServerVersion,
} from "./codex-runtime-preflight";
import { CodexCatalogCache } from "./codex-catalog-cache";
import { CodexExternalTurns, type EndedTurn, type ExternalTurn } from "./codex-external-turns";
import { codexResumeCommand } from "./codex-resume-command";
import { CodexFollowerBridge } from "./codex-follower-bridge";
import { CodexFollowerConnection } from "./codex-follower-connection";
import { CodexDesktopApp } from "./codex-desktop-app";
import {
  parseFollowerModelSettings,
  sameFollowerModelSettings,
  type CodexFollowerState,
  type FollowerModelSettings,
} from "./codex-follower-state";
import { CodexFollowerStream } from "./codex-follower-stream";
import { AcpUndispatchedError } from "./antigravity-acp";
import { AntigravityManagedRunner } from "./antigravity-managed-runner";
import { devinExecutable } from "./devin-executable";
import { devinSessionHome } from "./devin-sessions";
import { devinLimitReset, readDevinUsage, type DevinUsageWindow } from "./devin-usage";
import { DEVIN_DEFAULT_PERMISSION_MODE, DevinSessionSettings } from "./devin-session-settings";
import {
  DEVIN_EXECUTION_MODE,
  DEVIN_MAX_PROMPT_BYTES,
  DEVIN_MODEL_EFFORTS,
  DEVIN_PERMISSION_MODES,
  DevinManagedRunner,
  devinChildEnvironment,
  devinItemInTurn,
  devinModelCatalog,
  devinModelVariant,
  emptyDevinModelCatalog,
  resolveDevinModel,
  type DevinModelCatalog,
  type DevinModelVariant,
  type DevinRunnerHost,
  type DevinTurnEnd,
  type DevinTurnSettings,
} from "./devin-managed-runner";
import { ManagedCodexState, elicitationResponse } from "./managed-codex-state";
import { ManagedCodexEventBridge } from "./managed-codex-state";
import { projectContextUsage, type ContextUsage } from "./context-usage";
import { SerialSessionQueue } from "./serial-session-queue";
import { SessionProviderRegistry, type SessionProvider } from "./session-provider";
import { activityBlocks, assertActivityAllows } from "./session-activity";
import { acquireManagedSessionLease, existingFileLeaseBusy } from "./managed-session-lock";
import { acquireCodexFollowerOperationLock } from "./codex-follower-operation-lock";
import {
  acknowledgeDispatchedManagedCommand,
  annotateManagedCommand,
  claimManagedCommand,
  createManagedSnapshotWriter,
  deleteManagedSessions,
  dispatchManagedCommand,
  finishManagedCommand,
  listManagedRecords,
  managedSessionHasUnknownCommands,
  openManagedLedger,
  persistManagedGoal,
  readManagedEvents,
  readManagedRecord,
  readManagedUsageLimit,
  readUnknownManagedCommands,
  replayManagedCommand,
  saveManagedRecord,
  saveManagedSettingsReceipt,
  saveManagedUsageLimit,
} from "./managed-ledger";
import { CodexLeadTurns } from "./lead-turn-origin";
import { CodexTitleThreads, codexUserMessageText, threadTitleModel } from "./codex-thread-title";
import {
  AUTO_CONTINUE_TEXT,
  armUsageLimit,
  codexUsageLimitHit,
  holdUsageLimit,
  parseUsageLimit,
  usageLimitArmable,
  usageLimitAutoContinue,
  usageLimitContinue,
  usageLimitView,
  type UsageLimit,
  type UsageLimitHit,
} from "./usage-limit";

const FOLLOWER_RETRY_MS = 5_000;
const FOLLOWER_IDLE_MS = 30_000;
const LEGACY_ADOPT_RECHECK_MS = 5_000;
/** How long a send waits for the Codex app to take a thread it was asked to show. */
const HANDOFF_TIMEOUT_MS = 8_000;
const HANDOFF_POLL_MS = 250;

/** Owner discovery answered, and nobody answers for the thread. */
function codexOwnerMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    ["Codex session owner was not found", "no Codex session owner found"].includes(error.message)
  );
}

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("catalog") }).strict(),
  z.object({ operation: z.literal("context"), sessionId: z.string().min(1).max(256) }).strict(),
  z
    .object({ operation: z.literal("resume-command"), sessionId: z.string().min(1).max(256) })
    .strict(),
  z.object({ operation: z.literal("usage"), sessionId: z.string().min(1).max(256) }).strict(),
  z.object({ operation: z.literal("goal"), sessionId: z.string().min(1).max(256) }).strict(),
  z.object({ operation: z.literal("resources"), sessionId: z.string().min(1).max(256) }).strict(),
  z
    .object({
      operation: z.literal("session-image"),
      sessionId: z.string().min(1).max(256),
      imageId: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ operation: z.literal("subagents"), sessionId: z.string().min(1).max(256) }).strict(),
  z
    .object({
      operation: z.literal("subagent-events"),
      sessionId: z.string().min(1).max(256),
      subagentId: z.string().regex(/^[a-f0-9]{64}$/),
      cursor: z.string().max(1024).nullable().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  z
    .object({ operation: z.literal("session-directory"), sessionId: z.string().min(1).max(256) })
    .strict(),
  z
    .object({
      operation: z.literal("live"),
      sessionId: z.string().min(1).max(256),
      experimentalEnabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("events"),
      sessionId: z.string().min(1).max(256),
      cursor: z.string().max(1024).nullable().optional(),
      limit: z.number().int().min(1).max(100).default(50),
      /** False for stream snapshots: no cursor is kept for the page (see SessionPaging.read). */
      retainCursor: z.boolean().optional(),
    })
    .strict(),
]);

const managedReconcileSchema = z
  .object({
    operation: z.literal("reconcile"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    sessionId: z.string().min(1).max(256),
  })
  .strict();

const managedResumeSchema = z
  .object({
    operation: z.literal("resume"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    sessionId: z.string().min(1).max(256),
    runtimeBootId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative().optional(),
    experimentalEnabled: z.boolean(),
  })
  .strict();

const managedQueueSchema = z
  .object({
    operation: z.literal("queue-list"),
    sessionId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const managedUnarchiveSchema = z
  .object({
    operation: z.literal("unarchive"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    sessionId: z.string().min(1).max(256),
    runtimeBootId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
    experimentalEnabled: z.boolean(),
  })
  .strict();

const managedDeleteSchema = z
  .object({
    operation: z.literal("delete"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    sessionId: z.string().min(1).max(256),
    runtimeBootId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
    experimentalEnabled: z.boolean(),
  })
  .strict();

const managedSettingsStateSchema = z
  .object({
    operation: z.literal("settings-state"),
    sessionId: z.string().min(1).max(256),
    includeHistorical: z.boolean().optional(),
  })
  .strict();

const sessionProviderOptionsScopeSchema = z
  .object({ workspaceId: z.string().min(1).max(256).optional() })
  .strict();

const managedQuerySchema = z
  .object({
    operation: z.enum(["capabilities", "inspect"]),
    sessionId: z.string().min(1).max(256),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .optional(),
    experimentalEnabled: z.boolean().optional(),
  })
  .strict();

/** A Devin session starts with its first message: Devin stores a session only once a turn runs. */
const devinCreateSchema = z
  .object({
    operation: z.literal("devin-create"),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/),
    workspaceId: z.string().min(1).max(256),
    prompt: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= DEVIN_MAX_PROMPT_BYTES),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:@/+-]{1,128}$/)
      .optional(),
    effort: z.string().min(1).max(64).optional(),
    serviceTier: z.string().min(1).max(128).optional(),
    permissionMode: z.enum(DEVIN_PERMISSION_MODES).optional(),
  })
  .strict();

const managedLifecycleSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("create"),
      requestId: z.string().uuid(),
      deviceId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_:-]+$/),
      workspaceId: z.string().min(1).max(256),
      policyId: z.enum([
        "workspace-write-on-request",
        "full-access-on-request",
        "workspace-write-auto-review",
      ]),
      model: z.string().min(1).max(256).optional(),
      effort: z.string().min(1).max(64).optional(),
      serviceTier: z.string().min(1).max(128).optional(),
      mode: z.literal("plan").optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("release"),
      requestId: z.string().uuid(),
      deviceId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_:-]+$/),
      sessionId: z.string().min(1).max(256),
    })
    .strict(),
]);

const managedControlSchema = z
  .object({
    operation: z.enum([
      "send",
      "stop",
      "approve",
      "answer",
      "steer",
      "queue-add",
      "queue-update",
      "queue-delete",
      "queue-reorder",
      "rename",
      "archive",
      "settings",
      "goal-set",
      "goal-pause",
      "goal-resume",
      "goal-clear",
      "fork",
      "compact",
      "terminals-clean",
      "usage-limit-cancel",
      "usage-limit-continue",
    ]),
    sessionId: z.string().min(1).max(256),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .optional(),
    runtimeBootId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
    experimentalEnabled: z.boolean(),
    turnId: z.string().min(1).max(256).optional(),
    text: z
      .string()
      .max(128 * 1024)
      .optional(),
    input: z.array(z.unknown()).max(11).optional(),
    historyReferences: z.array(historyReferenceSchema).max(5).optional(),
    historyInputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resourceRefs: z
      .array(
        z
          .object({
            kind: z.string(),
            id: z.string().optional(),
            relativePath: z.string().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    approvalId: z.union([z.string().min(1).max(256), z.number().safe().nonnegative()]).optional(),
    questionId: z.union([z.string().min(1).max(256), z.number().safe().nonnegative()]).optional(),
    decision: z.string().max(256).optional(),
    nativeDecision: z.unknown().optional(),
    answers: z.record(z.string(), z.array(z.string().max(8192))).optional(),
    name: z.string().max(256).optional(),
    queuedSubmissionId: z.string().min(1).max(256).optional(),
    queuedSubmissionIds: z.array(z.string().min(1).max(256)).max(100).optional(),
    model: z.string().min(1).max(256).optional(),
    /** Devin: the permission mode its next turns run with. */
    permissionMode: z.enum(DEVIN_PERMISSION_MODES).optional(),
    effort: z.string().min(1).max(64).nullable().optional(),
    serviceTier: z.string().min(1).max(128).nullable().optional(),
    mode: z.string().min(1).max(128).nullable().optional(),
    policyId: z
      .enum(["workspace-write-on-request", "full-access-on-request", "workspace-write-auto-review"])
      .optional(),
    resetDefaults: z.boolean().optional(),
    expectedSettingsScope: z.string().uuid().optional(),
    goal: z.unknown().optional(),
  })
  .strict()
  .refine(validHistoryControl)
  .refine(
    (request) => request.operation === "settings" || request.expectedSettingsScope === undefined,
  )
  .refine(
    (request) =>
      request.operation === "settings" || (request.effort !== null && request.serviceTier !== null),
  );

type SettingsRead = z.infer<typeof managedSettingsStateSchema>;
type SettingsControl = z.infer<typeof managedControlSchema>;
type ApplyManagedSettings = (request: SettingsControl, fingerprint: string) => Promise<unknown>;

function normalizeContextUsage(snapshot: { usage?: unknown; reason?: unknown }): ContextUsage {
  return (
    projectContextUsage(snapshot.usage) ?? {
      available: false,
      state: "unavailable",
      reason: typeof snapshot.reason === "string" ? snapshot.reason : "usage-not-reported",
    }
  );
}

type DevinModelSelection = {
  model?: string;
  effort?: string | null;
  serviceTier?: string | null;
};

const DEVIN_SPEED_NAMES = {
  fast: "Fast",
  priority: "Priority",
  lightning: "Lightning",
};

function devinModelOptions(catalog: DevinModelCatalog) {
  const exact: Array<{
    id: string;
    name?: string;
    efforts: string[];
    serviceTierIds: string[];
    maxContextTokens?: number;
    variants: DevinModelVariant[];
  }> = [];
  const exactLimit = 256 - catalog.families.length;
  const familyIds = new Set(catalog.families.map(({ id }) => id));
  const families = catalog.families.map((family) => {
    const allVariants = catalog.variantsByFamily.get(family.id) ?? [];
    const variants = allVariants.slice(0, 128);
    const maxContextTokens = variants[0]?.maxContextTokens;
    const sameCapacity =
      maxContextTokens !== undefined &&
      allVariants.every((variant) => variant.maxContextTokens === maxContextTokens);
    for (const variant of variants) {
      // Native variants without normal effort/tier controls (for example Thinking + 1M)
      // remain selectable by their own IDs.
      if (
        exact.length < exactLimit &&
        variants.length > 1 &&
        !variant.effort &&
        !variant.serviceTierId &&
        !familyIds.has(variant.id)
      )
        exact.push({
          id: variant.id,
          name: variant.name,
          efforts: [],
          serviceTierIds: [],
          maxContextTokens: variant.maxContextTokens,
          variants: [variant],
        });
    }
    return {
      ...family,
      efforts: DEVIN_MODEL_EFFORTS.filter((effort) =>
        variants.some((variant) => variant.effort === effort),
      ),
      serviceTierIds: [
        ...new Set(
          variants.flatMap((variant) => (variant.serviceTierId ? [variant.serviceTierId] : [])),
        ),
      ],
      variants,
      ...(sameCapacity ? { maxContextTokens } : {}),
    };
  });
  const serviceTiers = [...new Set(families.flatMap((model) => model.serviceTierIds))].map(
    (id) => ({ id, name: DEVIN_SPEED_NAMES[id] }),
  );
  return { models: [...families, ...exact], serviceTiers };
}

function devinSelectedVariant(
  catalog: DevinModelCatalog,
  selectedModel?: string | null,
  nativeModel?: string | null,
) {
  const native = nativeModel ? devinModelVariant(catalog, nativeModel) : undefined;
  if (!selectedModel) return native;
  // A family previously saved by AgentKib still goes to the CLI as a family. Its last actual
  // variant can identify the existing effort, as long as that variant belongs to this family.
  return (
    devinModelVariant(catalog, selectedModel) ??
    (native?.familyId === selectedModel ? native : undefined)
  );
}

function devinSettingsModel(
  choice: DevinModelSelection,
  catalog: DevinModelCatalog,
  currentId?: string | null,
  nativeModel?: string | null,
) {
  const { model, effort, serviceTier } = choice;
  const target = model ?? currentId ?? nativeModel;
  if (!target) throw new Error("unsupported-model");
  const current = devinSelectedVariant(catalog, currentId, nativeModel);
  const proposed = devinModelVariant(catalog, target);
  const familyId = proposed?.familyId ?? target;
  const previous = proposed ?? (current?.familyId === familyId ? current : undefined);
  const selectedEffort = effort === undefined ? previous?.effort : (effort ?? undefined);
  const selectedTier =
    serviceTier === undefined ? previous?.serviceTierId : (serviceTier ?? undefined);
  const variants = catalog.variantsByFamily.get(familyId);
  if (!variants?.length) throw new Error("unsupported-model");
  if (selectedEffort && !variants.some((variant) => variant.effort === selectedEffort))
    throw new Error("unsupported-effort");
  // Turning off Fast is an explicit choice of a standard variant even without a known effort.
  if (serviceTier === null && !selectedEffort) {
    const standard = variants.filter((variant) => !variant.serviceTierId);
    if (standard.length !== 1) throw new Error("unsupported-service-tier");
    return standard[0]!.id;
  }
  const resolved = resolveDevinModel(catalog, {
    modelId: familyId,
    effort: selectedEffort,
    serviceTierId: selectedTier,
  });
  if (!resolved)
    throw new Error(serviceTier !== undefined ? "unsupported-service-tier" : "unsupported-effort");
  return resolved;
}

type ManagedRecord = z.infer<typeof managedRecordSchema>;

type ManagedRunner = {
  session: CodexAppServerSession;
  state: ManagedCodexState;
  bridge: ManagedCodexEventBridge;
  persist: ReturnType<typeof createManagedSnapshotWriter>;
  release: () => void;
  planVerified: boolean;
  /**
   * Whether thread/queue/* answered at start; null until then. 0.147.0, the writer-lock
   * minimum, has no native queue.
   */
  queueVerified: boolean | null;
  idleSince: number | null;
  observed: boolean;
  retiring?: boolean;
  retirementFailed?: boolean;
  leaseReleased?: boolean;
  /** The Project Agent worker tools this thread was started with, or null. */
  leadUrl?: string | null;
  /** Restart once idle, keeping the session AgentKib's: its worker tools changed. */
  restartWhenIdle?: boolean;
  /**
   * Whether Codex has written the thread: resumed ones are, a new one once a turn starts. A thread
   * it has not written cannot be resumed, so it is not restarted before.
   */
  written?: boolean;
};

type CodexFollowerRecord = {
  bridge: CodexFollowerBridge;
  stream: CodexFollowerStream;
  workspaceId: string;
  workspace: string;
  nativeId: string;
  lastUsed: number;
};

type AntigravityRunnerRecord = {
  runner: AntigravityManagedRunner;
  nativeId: string;
  workspaceId: string;
  workspace: string;
  lastUsed: number;
};

type ManagedModelOption = {
  id: string;
  isDefault: boolean;
  defaultEffort: string | null;
  defaultServiceTier: string | null;
  efforts: string[];
  serviceTiers: string[];
};

/** A usage limit's notice kept longer than this is not shown after a restart. */
const KEPT_LIMIT_MS = 7 * 24 * 60 * 60_000;
/** Longer waits are taken a day at a time: a timer cannot wait much more than 24 days. */
const LIMIT_TIMER_MS = 24 * 60 * 60_000;
/** A read of Devin's `/usage`; `known` once it ended, whether it named any window. */
type DevinUsageRead = { at: number; read: Promise<DevinUsageWindow[] | null>; known?: boolean };

/** See `WebReadRequests.observeLanes`. */
export type LaneObserver = {
  turnEnded(
    sessionId: string,
    turnId: string,
    outcome: string,
    durationMs: number | null,
    historyTurnId?: string,
    replyText?: string | null,
  ): void;
  waiting(sessionId: string, turnId: string | null, status: string): void;
  /**
   * A turn Codex started by itself, as a goal continues (`CodexLeadTurns`), told for any session
   * AgentKib runs; the observer counts it when the session is a Project Agent.
   */
  ownTurn?(sessionId: string, turnId: string): void;
  /** The session's usage limit is over: AgentKib's continue, or a later turn, went through. */
  limitEnded?(sessionId: string): void;
};

export class WebReadRequests {
  #codex: CodexAppServerReader;
  #preflight: CodexRuntimePreflight;
  readonly #sessionProviders = new SessionProviderRegistry({
    codex: {
      agent: "codex",
      createOperation: "create",
      options: () => this.#managedOptions(),
      live: (sessionId, enabled) => this.#codexLiveWithLimits(sessionId, enabled),
      query: (request) => this.#codexQuery(request),
      workspaceResources: (workspaceId) => this.#codexWorkspaceResources(workspaceId),
      create: (request) => this.managedLifecycle(request),
      settingsState: (request) =>
        this.#managedSettingsState(managedSettingsStateSchema.parse(request)),
      control: (request) =>
        this.#managedControlAdmission(request, (validated, fingerprint) =>
          this.#codexControl(validated, fingerprint),
        ),
      updateSettings: (request) =>
        this.#managedControlAdmission(request, (validated, fingerprint) =>
          this.#codexControl(validated, fingerprint),
        ),
      contextUsage: async (sessionId) =>
        normalizeContextUsage(await this.#managedLive(sessionId, false)),
    },
    "claude-code": {
      agent: "claude-code",
      live: (sessionId, experimentalEnabled) =>
        this.#claudeProvider({ operation: "live", sessionId, experimentalEnabled }),
      query: (request) => this.#claudeProvider({ ...request }),
      createOperation: "create",
      options: ({ workspaceId }) => this.#claudeProvider({ operation: "options", workspaceId }),
      workspaceResources: (workspaceId) =>
        this.#claudeProvider({ operation: "workspace-resources", workspaceId }),
      create: (request) => this.#claudeProvider(request),
      settingsState: (request) => this.#claudeProvider(request),
      prepareSettings: (request) => this.#claudeProvider(request),
      control: (request) => this.#claudeProvider(request),
      updateSettings: (request) => this.#claudeProvider(request),
      contextUsage: (sessionId) => this.#claudeProvider({ operation: "usage", sessionId }),
    },
    "deepseek-harness": {
      agent: "deepseek-harness",
      live: (sessionId, experimentalEnabled) =>
        this.#dshProvider({ operation: "live", sessionId, experimentalEnabled }),
      query: (request) => this.#dshProvider({ ...request }),
      createOperation: "dsh-create",
      options: ({ workspaceId, includeModels }) =>
        this.#dshProvider({
          operation: "dsh-options",
          includeModels: workspaceId !== undefined || includeModels === true,
        }),
      create: (request) => this.#dshProvider(request),
      settingsState: (request) => this.#dshProvider(request),
      control: (request) => this.#dshProvider(request),
      updateSettings: (request) => this.#dshProvider(request),
      contextUsage: (sessionId) => this.#dshProvider({ operation: "usage", sessionId }),
    },
    devin: {
      agent: "devin",
      live: (sessionId) => this.#devinLive(sessionId),
      query: (request) => this.#devinQuery(request),
      createOperation: "devin-create",
      options: () => this.#devinOptions(),
      create: (request) => this.#devinCreate(request),
      settingsState: (request) =>
        this.#devinSettingsState(managedSettingsStateSchema.parse(request).sessionId),
      control: (request) =>
        this.#managedControlAdmission(request, (validated, fingerprint) =>
          this.#devinControl(validated, fingerprint),
        ),
      updateSettings: (request) =>
        this.#managedControlAdmission(request, (validated, fingerprint) =>
          this.#devinControl(validated, fingerprint),
        ),
      contextUsage: (sessionId) => this.#devinContextUsage(sessionId),
    },
    antigravity: {
      agent: "antigravity",
      live: (sessionId) => this.#antigravityLive(sessionId),
      query: (request) => this.#antigravityQuery(request),
      control: (request) =>
        this.#managedControlAdmission(request, (validated, fingerprint) =>
          this.#antigravityControl(validated, fingerprint),
        ),
      contextUsage: async (sessionId) =>
        normalizeContextUsage(await this.#antigravityLive(sessionId)),
    },
  });
  // New-session options and settings without a runner each start an app-server.
  #optionsCatalog = new CodexCatalogCache<Record<string, unknown>>();
  #settingsCatalog = new CodexCatalogCache<{
    models: ManagedModelOption[];
    collaborationModes: CollaborationModeOption[];
  }>();
  #followerSettingsCatalog = new CodexCatalogCache<ManagedModelOption[]>();
  #ownership = new Map<string, { checkedAt: number; reason: string | null }>();
  /** Turns that the Codex app or CLI runs, for the catalog and live state to show. */
  #externalTurns = new CodexExternalTurns(() => canonicalize(this.sessions.codexHome()));
  #catalogObservations = new Map<string, { at: number; status: string; reason: string | null }>();
  #catalogRuntime?: Awaited<ReturnType<CodexRuntimePreflight["check"]>>;
  #catalogRuntimeCheck?: Promise<void>;
  #retirementTimer: ReturnType<typeof setInterval>;
  #retiring = false;
  #controlSessions = new Map<string, { count: number; observed: boolean }>();
  #laneObserver?: LaneObserver;
  readonly #serialQueue: SerialSessionQueue;
  #closing?: Promise<void>;
  #shuttingDown = false;
  #operations = new Set<Promise<unknown>>();
  #bootId = randomUUID();
  #managedRunners = new Map<string, ManagedRunner>();
  #codexReceiptChecks = new Map<
    string,
    { retryAt: number; live: Promise<Record<string, unknown> | undefined> }
  >();
  /**
   * The usage limit each managed Codex session's last turn met, and the continue armed for it
   * (`usage-limit.ts`). In memory only: as Claude Code's own wait does, it ends with AgentKib.
   * `continuing` is the request of the continue AgentKib sent, until that turn ends.
   */
  #codexLimits = new Map<
    string,
    { limit: UsageLimit; timer?: ReturnType<typeof setTimeout>; continuing?: string }
  >();
  /** The device whose message each managed Codex session last took. */
  #codexSenders = new Map<string, string>();
  /** The temporary threads that name managed Codex threads (`codex-thread-title.ts`). */
  #titleThreads = new CodexTitleThreads();
  /**
   * The native threads AgentKib tried to name while it runs, at most once each, and whether the
   * person renamed one meanwhile: their name is never replaced.
   */
  #titleAttempts = new Map<string, { renamed: boolean }>();
  #managedImagePages = new Map<
    string,
    {
      at: number;
      pending: Promise<{
        images: Map<string, { images: ConversationImage[]; attachment_count: number }>;
        warnings: string[];
      }>;
    }
  >();
  #startingRunners = new Map<string, ManagedRunner>();
  #transientSessions = new Set<CodexAppServerSession>();
  #codexFollowers = new Map<string, CodexFollowerRecord>();
  #codexFollowerFlights = new Map<string, Promise<CodexFollowerRecord>>();
  #subagentObservers = new WeakMap<object, { identity: string; id: string }>();
  #followerMisses = new Map<string, number>();
  /** Sessions whose last owner discovery answered that nobody holds the thread's window. */
  #ownerMissing = new Set<string>();
  /** When a send last asked the Codex app for a thread and the app did not take it. */
  #handoffFailures = new Map<string, number>();
  #desktopApp: CodexDesktopApp;
  #handoffTimeoutMs: number;
  #handoffFlights = new Map<
    string,
    Promise<{ follower: CodexFollowerRecord; revision: number } | undefined>
  >();
  #antigravityRunners = new Map<string, AntigravityRunnerRecord>();
  #antigravityRetiredRevisions = new Map<string, number>();
  #antigravityRunnerFlights = new Map<string, Promise<AntigravityRunnerRecord>>();
  #devinRunners = new Map<
    string,
    {
      runner: DevinManagedRunner;
      lastUsed: number;
      settings: DevinTurnSettings;
      /** The workspace the session belongs to; its live state names it for access checks. */
      workspaceId: string;
    }
  >();
  #devinSavedSettings: DevinSessionSettings | undefined;
  /**
   * The usage limit each Devin session AgentKib runs last met, and the continue armed for it, as
   * `#codexLimits` holds Codex's. The notice is also kept in the managed ledger, so that it
   * outlives a restart. `continuing` is the request of the continue AgentKib sent, until that
   * turn ends.
   */
  #devinLimits = new Map<
    string,
    { limit: UsageLimit; timer?: ReturnType<typeof setTimeout>; continuing?: string }
  >();
  /** The device whose message each Devin session last took. */
  #devinSenders = new Map<string, string>();
  /** The last read of Devin's `/usage`, shared by sessions that meet a limit together. */
  #devinUsage?: DevinUsageRead;
  #devinUsageAbort = new AbortController();
  /** See `observeResults`. */
  #resultObserver?: (
    target: Omit<ReadStateTarget, "transcript">,
    result: ConversationReadResult,
    options: { turnStartedAt: string },
  ) => void;

  #devinSaved() {
    this.#devinSavedSettings ??= new DevinSessionSettings(this.dataDir);
    return this.#devinSavedSettings;
  }

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly dataDir: string,
    readonly indexGeneration: () => bigint,
    readonly environment: NodeJS.ProcessEnv,
    readonly publishConversationEvent?: (
      sessionId: string,
      type: "state" | "text-delta" | "item-upsert" | "snapshot" | "invalidate",
      payload: Record<string, unknown>,
      live?: Record<string, unknown>,
      textItem?: Record<string, unknown>,
    ) => void,
    readonly isSessionObserved?: (sessionId: string) => boolean,
    readonly sessionIndex?: SessionIndex,
    readonly catalogChanged?: () => void,
    readonly requestClaudeProvider?: (request: Record<string, unknown>) => Promise<unknown>,
    readonly requestDshProvider?: (request: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.#codex = new CodexAppServerReader(environment);
    this.#preflight = new CodexRuntimePreflight(environment);
    this.#desktopApp = new CodexDesktopApp(environment);
    this.#serialQueue = new SerialSessionQueue(
      dataDir,
      this.#bootId,
      (id) => this.#serialQueueTarget(id),
      (id) => this.#serialQueueLive(id),
      (value, beforeDispatch) => this.#dispatchSerialQueue(value, beforeDispatch),
      (id) =>
        this.publishConversationEvent?.(id, "invalidate", {
          domains: ["queue", "receipts", "capabilities"],
        }),
    );
    const handoffTimeout = Number(environment.AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS);
    this.#handoffTimeoutMs =
      environment.AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS !== undefined &&
      Number.isSafeInteger(handoffTimeout) &&
      handoffTimeout > 0
        ? handoffTimeout
        : HANDOFF_TIMEOUT_MS;
    this.#retirementTimer = setInterval(() => void this.#retireIdleRunners(), 1000);
    this.#retirementTimer.unref();
  }

  async #claudeProvider(request: Record<string, unknown>) {
    if (!this.requestClaudeProvider) throw new Error("claude-managed-unavailable");
    return this.requestClaudeProvider(request);
  }

  async #dshProvider(request: Record<string, unknown>) {
    if (!this.requestDshProvider) throw new Error("session-unavailable");
    return this.requestDshProvider(request);
  }

  close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  /** Resident native overlays also seed subscriptions that have not received any events yet. */
  readFollowerSnapshot(sessionId: string): ReturnType<CodexFollowerStream["snapshot"]> | undefined {
    const follower = this.#codexFollowers.get(sessionId);
    if (!follower?.bridge.connected || follower.bridge.selectedState?.revision == null)
      return undefined;
    return follower.stream.snapshot();
  }

  closeAsync(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#shuttingDown = true;
    clearInterval(this.#retirementTimer);
    for (const entry of this.#codexLimits.values()) clearTimeout(entry.timer);
    for (const entry of this.#devinLimits.values()) clearTimeout(entry.timer);
    this.#devinUsageAbort.abort();
    this.#preflight.close();
    this.#desktopApp.close();
    return (this.#closing = this.#close());
  }

  async #close(): Promise<void> {
    const pending = [this.#codex.closeAsync()];
    for (const record of this.#antigravityRunners.values()) record.runner.close();
    this.#antigravityRunners.clear();
    this.#antigravityRetiredRevisions.clear();
    for (const record of this.#devinRunners.values()) record.runner.close();
    this.#devinRunners.clear();
    for (const follower of this.#codexFollowers.values()) follower.bridge.close();
    this.#codexFollowers.clear();
    const closeRunners = () => {
      for (const session of this.#transientSessions) pending.push(session.close());
      for (const [id, runner] of new Map([...this.#startingRunners, ...this.#managedRunners])) {
        runner.state.fail("codex-disconnected");
        try {
          runner.persist(runner.state);
        } catch {
          // Do not replace the persisted snapshot if another process changed it.
        }
        pending.push(this.#closeManagedRunner(id, runner));
      }
    };
    closeRunners();
    const initialClose = Promise.allSettled(pending);
    // Keep the store and ledger alive until cancelled startups and controls have
    // recorded their real dispatch outcomes. Admission is fenced synchronously.
    await Promise.allSettled([...this.#operations]);
    // A startup can finish between returning its runner and its caller registering
    // it. The operation drain covers that microtask boundary before this last sweep.
    pending.length = 0;
    closeRunners();
    const results = [...(await initialClose), ...(await Promise.allSettled(pending))];
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  #assertOpen(): void {
    if (this.#shuttingDown) throw new Error("backend-closing");
  }

  #trackTransientSession(session: CodexAppServerSession, release?: () => void): void {
    this.#transientSessions.add(session);
    session.once("close", () => {
      this.#transientSessions.delete(session);
      release?.();
    });
  }

  #runOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#shuttingDown) return Promise.reject(new Error("backend-closing"));
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    // Track before calling the operation, while preserving synchronous admission
    // so a subscription installed immediately after this call cannot be missed.
    this.#operations.add(pending);
    void pending.then(
      () => this.#operations.delete(pending),
      () => this.#operations.delete(pending),
    );
    try {
      resolve(run());
    } catch (error) {
      reject(error);
    }
    return pending;
  }

  /**
   * Tells the orchestration service when a Codex session's turn ends or starts waiting for the
   * person, so a lead hears about its lanes. Never part of running the session.
   */
  observeLanes(observer: LaneObserver | undefined): void {
    this.#laneObserver = observer;
  }

  /**
   * Where the turns AgentKib runs record their results when the agent's history marks no turn's
   * end (Devin): the read state takes unread results and the phone's alerts from them.
   */
  observeResults(
    observer:
      | ((
          target: Omit<ReadStateTarget, "transcript">,
          result: ConversationReadResult,
          options: { turnStartedAt: string },
        ) => void)
      | undefined,
  ): void {
    this.#resultObserver = observer;
  }

  #observeLane(notify: (observer: LaneObserver) => void): void {
    const observer = this.#laneObserver;
    if (!observer) return;
    try {
      notify(observer);
    } catch {
      /* A lead's bookkeeping must not disturb its lane. */
    }
  }

  /** Whether AgentKib runs this Codex session (it was created or taken over, not released). */
  #leadEndpoint: ((sessionId: string) => Promise<string | null>) | undefined;

  /**
   * Where a Codex Project Agent's worker tools are served (`OrchestrationService.leadTools`): its
   * thread starts with that MCP server in its configuration.
   */
  leadEndpoints(source: ((sessionId: string) => Promise<string | null>) | undefined): void {
    this.#leadEndpoint = source;
  }

  /**
   * Whether a Codex session could be a Project Agent: AgentKib runs it, now or once resumed. A
   * session it just created may not be in the catalog yet; its record says it is Codex.
   */
  codexLeadCapable(sessionId: string): boolean {
    const agent = this.store.sessions.get(sessionId)?.agent;
    return (
      (agent === undefined || agent === "codex") &&
      readManagedRecords(this.dataDir, this.store).some(
        (record) => record.id === sessionId && !record.archived,
      )
    );
  }

  /** Whether the Codex process running this session has the worker tools; null when none runs. */
  runnerHasLeadTools(sessionId: string): boolean | null {
    const runner = this.#managedRunners.get(sessionId);
    return runner ? Boolean(runner.leadUrl) : null;
  }

  /** The workspace of a Codex session AgentKib runs, also before the catalog lists it. */
  managedWorkspace(sessionId: string): string | null {
    return (
      readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === sessionId && !record.archived,
      )?.workspace_id ?? null
    );
  }

  /**
   * The session became a Project Agent or stopped being one: its thread restarts with or without
   * the worker tools, now when idle, else once its turn ends. It stays AgentKib's.
   */
  async restartManagedRunner(sessionId: string): Promise<void> {
    const runner = this.#managedRunners.get(sessionId);
    if (!runner || runner.retiring) return;
    const live = runner.state.snapshot(this.#bootId, false);
    if (
      live.status !== "idle" ||
      live.activity ||
      runner.written === false ||
      this.#controlSessions.has(sessionId)
    ) {
      runner.restartWhenIdle = true;
      return;
    }
    await this.#closeManagedRunner(sessionId, runner);
  }

  isManagedSession(sessionId: string): boolean {
    return readManagedRecords(this.dataDir, this.store).some(
      (record) => record.id === sessionId && !record.released,
    );
  }

  /**
   * The latest turns of a Codex session AgentKib manages whose end Codex recorded, whoever ran
   * them: a Project Agent hears of those its worker ran while AgentKib did not watch it.
   */
  endedTurns(sessionId: string): EndedTurn[] {
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === sessionId && !item.released,
    );
    return record?.native_id ? this.#externalTurns.endedTurns(record.native_id) : [];
  }

  /** Existing execution evidence for the read-side observer. No follow or resume is initiated. */
  codexActiveTurn(target: { home: string; workspace: string; nativeId: string }): string | null {
    if (!this.#isCodexHome(target.home)) return null;
    const workspace = pathIdentity(target.workspace);
    for (const runner of this.#managedRunners.values()) {
      const { state } = runner;
      if (
        runner.session.connected &&
        state.nativeId === target.nativeId &&
        typeof state.record.workspace === "string" &&
        pathIdentity(state.record.workspace) === workspace &&
        ["running", "awaiting-approval", "waiting-input"].includes(state.status)
      )
        return state.turnId;
    }
    for (const follower of this.#codexFollowers.values()) {
      if (
        follower.nativeId === target.nativeId &&
        pathIdentity(follower.workspace) === workspace &&
        follower.bridge.connected
      ) {
        const state = follower.bridge.selectedState;
        if (state?.status === "running" || state?.status === "awaiting-approval") {
          const turnId = state.activeTurn();
          if (turnId) return turnId;
        }
      }
    }
    return this.#externalTurns.turnOf(target.nativeId)?.turnId ?? null;
  }

  managedOptions() {
    return this.sessionProviderOptions("codex");
  }

  sessionProviderOptions(agent: unknown, scope: unknown = {}): Promise<Record<string, unknown>> {
    return this.#runOperation(async () => {
      const provider = this.#sessionProviders.require(agent);
      const options = await provider.options(sessionProviderOptionsScopeSchema.parse(scope));
      return this.#withProviderCapabilities(provider, options, true);
    });
  }

  sessionProviderWorkspaceResources(agent: unknown, scope: unknown) {
    return this.#runOperation(async () => {
      const provider = this.#sessionProviders.require(agent);
      const { workspaceId } = sessionProviderOptionsScopeSchema.required().parse(scope);
      if (!sessionProviderCapabilities(provider.agent)?.create.workspaceResources)
        throw new Error("unsupported-session-provider-operation");
      return provider.workspaceResources?.(workspaceId) ?? {};
    });
  }

  async sessionProviderCreate(agent: unknown, fields: Record<string, unknown>) {
    const provider = this.#sessionProviders.require(agent);
    return provider.create({ ...fields, operation: provider.createOperation });
  }

  #sessionProviderForSession(sessionId: string) {
    // Newly created Codex sessions may only be present in the managed ledger until indexed.
    return this.#sessionProviders.get(this.store.sessions.get(sessionId)?.agent ?? "codex");
  }

  #withProviderCapabilities(
    provider: SessionProvider,
    value: unknown,
    creating = false,
  ): Record<string, unknown> {
    if (!isObject(value)) throw new Error("invalid-provider-response");
    const declared = sessionProviderCapabilities(provider.agent)!;
    if (!creating) return { ...value, provider: declared };
    const { nativePlan, nativeGoals, ...options } = value;
    const { planMode, goal, goalBudget, workspaceResources, ...create } = declared.create;
    const available = value.available === true;
    const claudePlan =
      provider.agent === "claude-code" &&
      Array.isArray(value.permissionModes) &&
      value.permissionModes.some((item) => isObject(item) && item.id === "plan");
    return {
      ...options,
      provider: {
        ...declared,
        create: {
          ...create,
          ...(available && planMode && (nativePlan === true || claudePlan) ? { planMode } : {}),
          ...(available && workspaceResources ? { workspaceResources } : {}),
          ...(available && goal && (nativeGoals === true || claudePlan)
            ? { goal, ...(goalBudget ? { goalBudget } : {}) }
            : {}),
        },
      },
    };
  }

  /** The backend transport resolves the bridge owner before sending its native request here. */
  async bridgedSessionProviderRequest(
    agent: "claude-code" | "deepseek-harness",
    value: Record<string, unknown>,
  ): Promise<unknown> {
    const provider = this.#sessionProviders.require(agent);
    switch (value.operation) {
      case "options":
        return this.#withProviderCapabilities(provider, await provider.options(value), true);
      case "dsh-options":
        return this.#withProviderCapabilities(
          provider,
          await provider.options({ includeModels: value.includeModels === true }),
          true,
        );
      case "create":
      case "dsh-create":
        return provider.create(value);
      case "settings-state":
        return this.#withProviderCapabilities(provider, await provider.settingsState(value));
      case "settings-prepare":
        if (!provider.prepareSettings) throw new Error("unsupported-session-provider-operation");
        return this.#withProviderCapabilities(provider, await provider.prepareSettings(value));
      case "settings":
        return provider.updateSettings(value);
      case "live": {
        if (typeof value.sessionId !== "string") throw new Error("invalid-request");
        return provider.live(value.sessionId, value.experimentalEnabled === true);
      }
      case "capabilities":
      case "inspect":
        return provider.query(managedQuerySchema.parse(value));
      case "send":
      case "stop":
      case "approve":
      case "answer":
      case "steer":
      case "queue-add":
        return provider.control(value);
      case "usage":
        if (typeof value.sessionId === "string") return provider.contextUsage(value.sessionId);
        return agent === "claude-code" ? this.#claudeProvider(value) : this.#dshProvider(value);
      default:
        throw new Error("unsupported-session-provider-operation");
    }
  }

  /** A Codex CLI for reads: the one the last version check chose, else the first found. */
  #codexReader(): string | null {
    return this.#preflight.preferred() ?? codexExecutable(this.environment);
  }

  async #managedOptions() {
    const checked = await this.#preflight.check();
    const executable = checked.executable;
    if (!executable || checked.reason)
      return { available: false, reason: checked.reason, models: [], policies: [] };
    try {
      const home = canonicalize(
        this.environment.CODEX_HOME ?? path.join(this.environment.HOME ?? homedir(), ".codex"),
      );
      return await this.#optionsCatalog.read(codexCatalogKey(executable, home, home), async () => {
        const [response, collaborationModes] = await this.#readCodexRawCatalog(
          executable,
          home,
          home,
        );
        const rows = isObject(response) && Array.isArray(response.data) ? response.data : null;
        if (!rows) throw new Error("invalid-model-catalog");
        const catalogTiers = new Map<string, { id: string; name: string; description?: string }>();
        const models = rows
          .filter((model) => isObject(model) && model.hidden !== true)
          .slice(0, 100)
          .map((model) => {
            const serviceTiers = Array.isArray(model.serviceTiers)
              ? model.serviceTiers.slice(0, 16).flatMap((tier: unknown) => {
                  if (!isObject(tier) || typeof tier.id !== "string" || !tier.id) return [];
                  const entry = {
                    id: tier.id,
                    name: typeof tier.name === "string" ? tier.name : tier.id,
                    ...(typeof tier.description === "string"
                      ? { description: tier.description }
                      : {}),
                  };
                  if (!catalogTiers.has(tier.id)) catalogTiers.set(tier.id, entry);
                  return [entry];
                })
              : [];
            return {
              id: model.model,
              name: model.displayName,
              isDefault: model.isDefault,
              defaultEffort: model.defaultReasoningEffort,
              defaultServiceTier: model.defaultServiceTier,
              efforts: Array.isArray(model.supportedReasoningEfforts)
                ? model.supportedReasoningEfforts
                    .filter(isObject)
                    .map((effort: Record<string, unknown>) => effort.reasoningEffort)
                : [],
              serviceTiers,
              serviceTierIds: serviceTiers.map(({ id }: { id: string }) => id),
            };
          });
        const defaultModel = models.find((model) => model.isDefault === true);
        return {
          available: true,
          executionMode: "codex-managed",
          models,
          serviceTiers: [...catalogTiers.values()],
          defaults: {
            model: defaultModel?.id ?? null,
            effort: defaultModel?.defaultEffort ?? null,
            serviceTier: defaultModel?.defaultServiceTier ?? null,
          },
          policies: managedPolicyCatalog(),
          nativePlan: verifiedCollaborationModes(collaborationModes).length > 0,
          // The goal methods are required by the minimum supported Codex writer protocol.
          nativeGoals: true,
        };
      });
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "codex-app-server-unavailable",
        models: [],
        policies: [],
      };
    }
  }

  managedReconcile(value: unknown) {
    return this.#runOperation(() => this.#managedReconcile(value));
  }

  async #managedReconcile(value: unknown) {
    const request = managedReconcileSchema.parse(value);
    const records = readManagedRecords(this.dataDir, this.store);
    const record = records.find((item) => item.id === request.sessionId);
    if (!record || !this.#managedRunners.get(request.sessionId)?.session.connected)
      return this.managedQuery({
        operation: "inspect",
        sessionId: request.sessionId,
        deviceId: request.deviceId,
      });

    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;

    let runner = this.#managedRunners.get(request.sessionId);
    if (runner && !runner.session.connected) {
      await this.#closeManagedRunner(request.sessionId, runner);
      runner = undefined;
    }
    let release: (() => void) | undefined;
    if (!runner) release = acquireManagedSessionLease(this.dataDir, request.sessionId);

    const current = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (
      !current ||
      current.workspace_id !== record.workspace_id ||
      current.native_id !== record.native_id ||
      current.released ||
      current.archived
    ) {
      release?.();
      throw new Error("session-unavailable");
    }
    let workspace: string;
    let home: string;
    try {
      workspace = canonicalize(this.store.workspacePath(current.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(current.workspace)))
        throw new Error("session-workspace-mismatch");
      home = this.#assertManagedHome(current);
      this.#managedCwd(current);
    } catch (error) {
      release?.();
      throw error;
    }
    const nativeId = current.native_id;
    if (!nativeId) {
      release?.();
      return { sessionId: current.id, reconciled: false, reason: "native-session-unconfirmed" };
    }

    const evidence = managedCommandContext(request, current.workspace_id);
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      current.id,
      fingerprint,
      request.deviceId,
      evidence,
    );
    if (claimed) {
      release?.();
      return claimed;
    }

    try {
      runner = this.#managedRunners.get(current.id);
      if (!runner) {
        runner = await this.#attachManagedRunner(current, workspace, home, release);
        release = undefined;
        this.#managedRunners.set(current.id, runner);
      }

      const readRevision = runner.state.revision;
      const response = await runner.session.request("thread/read", {
        threadId: nativeId,
        includeTurns: true,
      });
      const thread = isObject(response) ? response.thread : null;
      if (!isObject(thread) || thread.id !== nativeId) throw new Error("thread-identity-mismatch");
      if (typeof thread.cwd !== "string") throw new Error("codex-context-unavailable");
      if (!within(canonicalize(thread.cwd), workspace))
        throw new Error("codex-context-outside-workspace");

      const unknown = readUnknownManagedCommands(this.dataDir, current.id);
      if (
        !unknown.every(
          ({ requestId, evidence: command }) =>
            managedSettingsEvidenceMatches(command, current) ||
            managedCommandReconciles(requestId, command, thread),
        )
      ) {
        const result = {
          sessionId: current.id,
          reconciled: false,
          reason: "control-outcome-unconfirmed",
        };
        finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      }
      for (const command of unknown)
        finishManagedCommand(this.dataDir, command.requestId, {
          accepted: true,
          completed: false,
          reconciled: true,
          requestId: command.requestId,
          runtimeBootId: this.#bootId,
          sessionId: current.id,
        });

      await runner.bridge.flush();
      if (runner.state.turnId === null) {
        const hydrated = runner.state.hydrate(thread, true, readRevision);
        runner.persist(runner.state, hydrated.events);
      } else if (runner.state.restoreReconciledTurn()) {
        runner.persist(runner.state);
      }
      const live = await runner.bridge.snapshot(this.#bootId, true);
      const result = { sessionId: current.id, reconciled: live.reason === null, live };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      if (release && !this.#managedRunners.has(current.id)) release();
      const existing = this.#managedRunners.get(current.id);
      if (!existing) {
        const result = {
          sessionId: current.id,
          reconciled: false,
          reason: "native-resume-unavailable",
        };
        finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      }
      throw error;
    }
  }

  managedLifecycle(value: unknown, fingerprintOverride?: string) {
    return this.#runOperation(() => this.#managedLifecycle(value, fingerprintOverride));
  }

  async #managedLifecycle(value: unknown, fingerprintOverride?: string) {
    const request = managedLifecycleSchema.parse(value);
    const fingerprint =
      fingerprintOverride ?? createHash("sha256").update(stableJson(value)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (prior) return prior;
    const records = readManagedRecords(this.dataDir, this.store);
    if (request.operation === "release") {
      const record = records.find((item) => item.id === request.sessionId);
      if (!record) throw new Error("session-unavailable");
      if (record.released) throw new Error("session-released");
      if (record.archived) throw new Error("session-archived");
      let runner = this.#managedRunners.get(request.sessionId);
      if (!runner?.session.connected) {
        const recovery = (await this.managedReconcile({
          operation: "reconcile",
          requestId: randomUUID(),
          deviceId: request.deviceId,
          sessionId: request.sessionId,
        })) as Record<string, unknown>;
        if (!isObject(recovery) || recovery.reconciled !== true)
          return {
            sessionId: request.sessionId,
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            reason:
              isObject(recovery) && typeof recovery.reason === "string"
                ? recovery.reason
                : "recovery-required",
            requestId: request.requestId,
            runtimeBootId: this.#bootId,
          };
        runner = this.#managedRunners.get(request.sessionId);
      }
      if (!runner?.session.connected)
        return {
          sessionId: request.sessionId,
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason: "recovery-required",
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
      if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(record);
      const live = await runner.bridge.snapshot(this.#bootId, true);
      if (activityBlocks(live, "release")) return compactingRejection(request, this.#bootId);
      if (live.reason || live.status !== "idle") throw new Error("session-busy");
      const claimed = claimManagedCommand(
        this.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId,
        {
          operation: "release",
          workspaceId: record.workspace_id,
          runtimeBootId: null,
          expectedRevision: null,
          turnId: null,
          nativeRequestId: null,
          executionMode: "codex-managed",
        },
      );
      if (claimed) return claimed;
      try {
        await runner.bridge.flush();
        if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
          throw new Error("control-outcome-unconfirmed");
        const current = await runner.bridge.snapshot(this.#bootId, true);
        assertActivityAllows(current, "release");
        if (current.reason || current.status !== "idle" || current.revision !== live.revision)
          throw new Error("session-busy");
        dispatchManagedCommand(this.dataDir, request.requestId);
        await this.#closeManagedRunner(request.sessionId, runner, () => {
          const latest = readManagedRecords(this.dataDir, this.store).find(
            (item) => item.id === request.sessionId,
          );
          if (!latest || latest.native_id !== record.native_id)
            throw new Error("session-unavailable");
          latest.released = true;
          latest.snapshot = {
            ...(isObject(latest.snapshot) ? latest.snapshot : {}),
            status: "released",
            sendEnabled: false,
          };
          saveManagedRecord(this.dataDir, latest as unknown as Record<string, unknown>);
        });
        const result = {
          sessionId: request.sessionId,
          released: true,
          accepted: true,
          completed: true,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
        finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      } catch (error) {
        if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
          return {
            sessionId: request.sessionId,
            accepted: false,
            completed: false,
            controlOutcome: "unknown",
            reason: "control-outcome-unconfirmed",
            requestId: request.requestId,
            runtimeBootId: this.#bootId,
          };
        const result = {
          sessionId: request.sessionId,
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason: error instanceof Error ? error.message : "control-preflight-rejected",
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
        finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      }
    }
    if (this.#managedRunners.size >= 8) throw new Error("managed-session-limit");
    const id = createHash("sha256").update(`managed:${request.requestId}`).digest("hex");
    const { workspaceId, policyId } = request;
    const model = request.model ?? null;
    const effort = request.effort ?? null;
    if (effort && !model) throw new Error("effort-requires-model");
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const home = canonicalize(this.sessions.codexHome());
    const workspaceRow = (this.store.listWorkspaces() as Array<{ id: string; path: string }>).find(
      (row) => row.id === workspaceId,
    );
    if (
      !workspaceRow ||
      pathIdentity(canonicalize(workspaceRow.path)) !== pathIdentity(workspace)
    ) {
      throw new Error("session-workspace-mismatch");
    }
    const record: ManagedRecord = {
      id,
      workspace_id: workspaceId,
      workspace,
      home,
      native_id: null,
      model,
      effort,
      service_tier: request.serviceTier ?? null,
      policy_id: policyId,
      default_model: null,
      default_effort: null,
      default_service_tier: null,
      native_settings: null,
      mode: request.mode ?? null,
      source_session_id: null,
      title: "Codex",
      created_at: new Date().toISOString(),
      released: false,
      adopted: false,
      archived: false,
      token_usage: null,
      goal: null,
      snapshot: { status: "starting", revision: 0 },
    };
    record.cwd = this.#managedCwd(record);
    openManagedLedger(this.dataDir, true)?.close();
    let release: (() => void) | undefined = acquireManagedSessionLease(this.dataDir, id);
    const evidence = {
      operation: request.operation,
      workspaceId,
      turnId: null,
      nativeRequestId: null,
      runtimeBootId: null,
      expectedRevision: null,
      executionMode: "codex-managed",
    };
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      id,
      fingerprint,
      request.deviceId,
      evidence,
    );
    if (claimed) {
      release();
      return claimed;
    }

    saveManagedRecord(this.dataDir, record);
    let dispatched = false;
    let failureFinalized = false;
    let runner: ManagedRunner | undefined;
    const finalizeFailure = (error: unknown, ownsLease: boolean) => {
      if (failureFinalized) return;
      if (ownsLease) this.#recordStartupFailure(id, error, dispatched, "unsupported");
      failureFinalized = true;
    };
    try {
      runner = await this.#attachManagedRunner(
        record,
        workspace,
        home,
        release,
        () => {
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
        undefined,
        finalizeFailure,
      );
      release = undefined;
      this.#managedRunners.set(id, runner);
      const live = await runner.bridge.snapshot(this.#bootId, true);
      const result = {
        sessionId: id,
        accepted: true,
        completed: true,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        live,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      finalizeFailure(
        error,
        release !== undefined ||
          (runner !== undefined &&
            this.#managedRunners.get(id) === runner &&
            !runner.leaseReleased),
      );
      if (!this.#managedRunners.has(id)) release?.();
      const definite = !dispatched || codexWriterBusy(error);
      const result = {
        sessionId: id,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  managedResume(value: unknown) {
    return this.#runOperation(() => this.#managedResume(value));
  }

  async #managedResume(value: unknown) {
    const request = managedResumeSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    const record = readManagedRecords(this.dataDir, this.store, true).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (!record.released) throw new Error("session-not-released");
    if (record.archived) throw new Error("session-archived");
    if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(record);
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    let release: (() => void) | undefined = acquireManagedSessionLease(
      this.dataDir,
      request.sessionId,
    );
    const latest = readManagedRecords(this.dataDir, this.store, true).find(
      (item) => item.id === request.sessionId,
    );
    if (
      !latest ||
      !latest.released ||
      latest.archived ||
      latest.native_id !== record.native_id ||
      latest.workspace_id !== record.workspace_id ||
      pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
      pathIdentity(canonicalize(latest.home)) !== pathIdentity(home) ||
      (request.expectedRevision !== undefined &&
        (latest.snapshot?.revision ?? 0) !== request.expectedRevision)
    ) {
      release();
      throw new Error("session-unavailable");
    }
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId,
      {
        operation: "resume",
        turnId: null,
        nativeRequestId: null,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: "codex-managed",
        workspaceId: record.workspace_id,
      },
    );
    if (claimed) {
      release();
      return claimed;
    }
    const resumed: ManagedRecord = { ...latest, released: false };
    resumed.snapshot = {
      ...(isObject(latest.snapshot) ? latest.snapshot : {}),
      status: "starting",
      reason: null,
    };
    saveManagedRecord(this.dataDir, resumed as unknown as Record<string, unknown>);
    let dispatched = false;
    let failureFinalized = false;
    let runner: ManagedRunner | undefined;
    const finalizeFailure = (error: unknown, ownsLease: boolean) => {
      if (failureFinalized) return;
      if (ownsLease) this.#recordStartupFailure(request.sessionId, error, dispatched, "released");
      failureFinalized = true;
    };
    try {
      // Persist the re-proven execution directory while resume owns the lease,
      // so later readers keep it separate from the registration boundary.
      resumed.cwd = this.#managedCwd(resumed);
      saveManagedRecord(this.dataDir, resumed as unknown as Record<string, unknown>);
      runner = await this.#attachManagedRunner(
        resumed,
        workspace,
        home,
        release,
        () => {
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
        undefined,
        finalizeFailure,
      );
      release = undefined;
      this.#managedRunners.set(request.sessionId, runner);
      const live = await runner.bridge.snapshot(this.#bootId, true);
      const result = {
        sessionId: request.sessionId,
        accepted: true,
        completed: true,
        live,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      finalizeFailure(
        error,
        release !== undefined ||
          (runner !== undefined &&
            this.#managedRunners.get(request.sessionId) === runner &&
            !runner.leaseReleased),
      );
      if (!this.#managedRunners.has(request.sessionId)) release?.();
      const definite = !dispatched || codexWriterBusy(error);
      const result = {
        sessionId: request.sessionId,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  #serialQueueTarget(sessionId: string) {
    const summary = this.store.sessions.get(sessionId);
    if (
      !summary ||
      summary.archived ||
      summary.sidechain ||
      (summary.agent !== "devin" && summary.agent !== "antigravity")
    )
      return;
    return {
      agent: summary.agent,
      workspaceId: summary.workspace_id,
      // The catalog ID is generated from the native reference without exposing it.
      nativeId: summary.id,
    } as const;
  }

  async #serialQueueLive(sessionId: string): Promise<Record<string, unknown>> {
    switch (this.#serialQueueTarget(sessionId)?.agent) {
      case "devin":
        return this.#devinLive(sessionId);
      case "antigravity":
        return this.#antigravityLive(sessionId);
      default:
        throw new Error("session-unavailable");
    }
  }

  #dispatchSerialQueue(value: Record<string, unknown>, beforeDispatch: () => void) {
    return this.#runOperation(() => {
      const target =
        typeof value.sessionId === "string" ? this.#serialQueueTarget(value.sessionId) : null;
      if (!target || value.operation !== "send") throw new Error("invalid-scheduled-operation");
      return this.#managedControlAdmission(value, (request, fingerprint) =>
        target.agent === "devin"
          ? this.#devinControl(request, fingerprint, beforeDispatch)
          : this.#antigravityControl(request, fingerprint, beforeDispatch),
      );
    });
  }

  serialScheduleList() {
    return this.#runOperation(() => this.#serialQueue.scheduleList());
  }

  serialSchedule(request: Record<string, unknown>) {
    return this.#runOperation(() => this.#serialQueue.schedule(request));
  }

  invalidateSerialSchedule(deviceId: string, quitting: boolean) {
    return this.#serialQueue.invalidate(deviceId, quitting);
  }

  managedQueueList(value: unknown) {
    return this.#runOperation(() => this.#managedQueueList(value));
  }

  async #managedQueueList(value: unknown) {
    if (
      isObject(value) &&
      typeof value.sessionId === "string" &&
      this.#serialQueueTarget(value.sessionId)
    )
      return this.#serialQueue.list(value.sessionId);
    const request = managedQueueSchema.parse(value);
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    if (record.archived) throw new Error("session-archived");
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(record);
    const cwd = this.#managedCwd(record);
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    let runner = this.#managedRunners.get(request.sessionId);
    if (runner && !runner.session.connected) {
      await this.#closeManagedRunner(request.sessionId, runner);
      runner = undefined;
    }
    if (runner?.session.connected) {
      if (record.native_id !== runner.state.nativeId) throw new Error("native-session-unconfirmed");
      if (runner.queueVerified === false) throw new Error("unsupported-codex-cli-version");
      return readManagedQueue(runner.session, record.native_id, request.limit ?? 100);
    }

    let release: (() => void) | undefined;
    let session: CodexAppServerSession | undefined;
    try {
      release = acquireManagedSessionLease(this.dataDir, request.sessionId);
      const latest = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (
        !latest ||
        latest.released ||
        latest.archived ||
        latest.native_id !== record.native_id ||
        latest.workspace_id !== record.workspace_id
      )
        throw new Error("session-unavailable");
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(latest.workspace)))
        throw new Error("session-workspace-mismatch");
      const executable = this.#codexReader();
      if (!executable) throw new Error("codex-cli-unavailable");
      const home = this.#assertManagedHome(latest);
      this.#assertOpen();
      session = await CodexAppServerSession.start(
        executable,
        cwd,
        home,
        { ...process.env, ...this.environment },
        undefined,
        (started) => {
          session = started;
          this.#trackTransientSession(started, release);
        },
      );
      this.#assertOpen();
      const response = await session.request("thread/read", {
        threadId: latest.native_id,
        includeTurns: false,
      });
      const thread = isObject(response) ? response.thread : null;
      if (!isObject(thread) || thread.id !== latest.native_id)
        throw new Error("thread-identity-mismatch");
      if (typeof thread.cwd !== "string" || !within(canonicalize(thread.cwd), workspace))
        throw new Error("codex-context-outside-workspace");
      return await readManagedQueue(session, latest.native_id, request.limit ?? 100);
    } finally {
      try {
        await session?.close();
      } finally {
        if (!session || session.closed) release?.();
      }
    }
  }

  managedUnarchive(value: unknown) {
    return this.#runOperation(() => this.#managedUnarchive(value));
  }

  async #managedUnarchive(value: unknown) {
    const request = managedUnarchiveSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (!record.archived) throw new Error("session-not-archived");
    if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(record);
    const cwd = this.#managedCwd(record);
    let release: (() => void) | undefined = acquireManagedSessionLease(
      this.dataDir,
      request.sessionId,
    );
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId,
      {
        operation: "unarchive",
        turnId: null,
        nativeRequestId: null,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: "codex-managed",
        workspaceId: record.workspace_id,
      },
    );
    if (claimed) {
      release();
      return claimed;
    }
    let dispatched = false;
    let session: CodexAppServerSession | undefined;
    try {
      const latest = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (!latest || !latest.archived || latest.native_id !== record.native_id)
        throw new Error("session-unavailable");
      const executable = this.#codexReader();
      if (!executable) throw new Error("codex-cli-unavailable");
      this.#assertOpen();
      session = await CodexAppServerSession.start(
        executable,
        cwd,
        home,
        { ...process.env, ...this.environment },
        undefined,
        (started) => {
          session = started;
          // Unarchive still has a durable state change to finish after native close.
          this.#trackTransientSession(started);
        },
      );
      this.#assertOpen();
      const response = await session.request(
        "thread/unarchive",
        { threadId: latest.native_id },
        () => {
          this.#assertOpen();
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
      );
      if (
        !isObject(response) ||
        !isObject(response.thread) ||
        response.thread.id !== latest.native_id
      )
        throw new Error("native-session-unconfirmed");
      await session.close();
      latest.archived = false;
      latest.released = true;
      latest.snapshot = {
        ...(isObject(latest.snapshot) ? latest.snapshot : {}),
        status: "released",
        reason: "session-released",
        sendEnabled: false,
      };
      saveManagedRecord(this.dataDir, latest as unknown as Record<string, unknown>);
      const result = {
        sessionId: request.sessionId,
        accepted: true,
        completed: true,
        requiresResume: true,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      const definite = !dispatched || codexWriterBusy(error);
      const result = {
        sessionId: request.sessionId,
        accepted: false,
        completed: false,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "control-preflight-rejected"
          : "control-outcome-unconfirmed",
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } finally {
      try {
        await session?.close();
      } finally {
        if (!session || session.closed) release?.();
        else session.once("close", () => release?.());
      }
    }
  }

  /** Permanently deletes the conversation in Codex (thread/delete) and AgentKib's copies of it. */
  managedDelete(value: unknown) {
    return this.#runOperation(async () => {
      const request = managedDeleteSchema.parse(value);
      const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
      // Like a control, this keeps idle retirement away from a runner the delete closes itself.
      const admission = this.#controlSessions.get(request.sessionId) ?? {
        count: 0,
        observed: false,
      };
      admission.count += 1;
      this.#controlSessions.set(request.sessionId, admission);
      try {
        return await this.#managedDelete(request, fingerprint);
      } finally {
        admission.count -= 1;
        if (admission.count === 0) this.#controlSessions.delete(request.sessionId);
      }
    });
  }

  async #managedDelete(request: z.infer<typeof managedDeleteSchema>, fingerprint: string) {
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
      throw new Error("stale-or-disabled-control");
    let workspaceId: string | null = null;
    const evidence = () => ({
      operation: "delete",
      workspaceId,
      runtimeBootId: request.runtimeBootId,
      expectedRevision: request.expectedRevision,
      executionMode: "codex-managed",
      turnId: null,
      nativeRequestId: null,
    });
    const outcome = (fields: Record<string, unknown>, requestId = request.requestId) => ({
      sessionId: request.sessionId,
      ...fields,
      requestId,
      runtimeBootId: this.#bootId,
    });
    // Refusals keep a receipt as well, so a lost answer replays instead of looking unknown.
    const reject = (reason: string) => {
      const result = outcome({
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        reason,
      });
      const claimed = claimManagedCommand(
        this.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId,
        evidence(),
      );
      if (claimed) return claimed;
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    };
    let source: ManagedRecord;
    let home: string;
    let workspace: string;
    try {
      source = await this.#inactiveRecord(request.sessionId);
      home = this.#assertManagedHome(source);
      workspace = canonicalize(this.store.workspacePath(source.workspace_id));
    } catch (error) {
      return reject(error instanceof Error ? error.message : "session-unavailable");
    }
    workspaceId = source.workspace_id;
    const nativeId = source.native_id ?? null;
    // Only an earlier delete may still be unconfirmed: retrying it is how that outcome resolves.
    const unconfirmed = readUnknownManagedCommands(this.dataDir, source.id);
    if (unconfirmed.some((command) => command.evidence?.operation !== "delete"))
      return reject("control-outcome-unconfirmed");
    let writer: string | undefined;
    if (nativeId) {
      const checked = await this.#preflight.check();
      if (checked.reason) return reject(checked.reason);
      writer = checked.executable;
    }
    if (this.#startingRunners.has(source.id)) return reject("session-busy");
    const runner = this.#managedRunners.get(source.id);
    if (runner?.retiring || (runner && !runner.session.connected))
      return reject(runner.retirementFailed ? "control-outcome-unconfirmed" : "session-retiring");
    if (runner) {
      const snapshot = await runner.bridge.snapshot(this.#bootId, true);
      if (activityBlocks(snapshot, "delete")) return reject("session-compacting");
      if (snapshot.reason || snapshot.status !== "idle") return reject("session-busy");
      if (snapshot.revision !== request.expectedRevision)
        return reject("stale-or-disabled-control");
    } else if (request.expectedRevision !== (source.snapshot?.revision ?? 0))
      return reject("stale-or-disabled-control");
    // Codex lets one process write a thread. Another one holding it (Codex Desktop, a terminal)
    // refuses the delete, so say so before starting anything.
    const lock = nativeId ? path.join(home, "thread-writer-locks", `${nativeId}.lock`) : null;
    const ownerBusy = () => {
      try {
        return lock !== null && existingFileLeaseBusy(lock);
      } catch {
        throw new Error("codex-owner-check-unavailable");
      }
    };
    if (!runner) {
      try {
        if (ownerBusy()) {
          this.#ownership.set(source.id, { checkedAt: Date.now(), reason: "codex-owner-busy" });
          return reject("codex-owner-busy");
        }
      } catch (error) {
        return reject(error instanceof Error ? error.message : "codex-owner-check-unavailable");
      }
    }
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      source.id,
      fingerprint,
      request.deviceId,
      evidence(),
    );
    if (claimed) return claimed;
    let dispatched = false;
    let session: CodexAppServerSession | undefined;
    let release: (() => void) | undefined;
    try {
      if (runner) {
        await runner.bridge.flush();
        const current = await runner.bridge.snapshot(this.#bootId, true);
        assertActivityAllows(current, "delete");
        if (
          current.reason ||
          current.status !== "idle" ||
          current.revision !== request.expectedRevision
        )
          throw new Error("session-busy");
        // AgentKib's own app-server holds the thread; its lock frees once that process exits.
        await this.#closeManagedRunner(source.id, runner, () => {
          const latest = readManagedRecords(this.dataDir, this.store).find(
            (item) => item.id === source.id,
          );
          if (!latest || latest.native_id !== source.native_id)
            throw new Error("session-unavailable");
          latest.released = true;
          latest.snapshot = {
            ...(isObject(latest.snapshot) ? latest.snapshot : {}),
            status: "released",
            sendEnabled: false,
          };
          saveManagedRecord(this.dataDir, latest as unknown as Record<string, unknown>);
        });
        if (ownerBusy()) throw new Error("codex-owner-busy");
      }
      release = acquireManagedSessionLease(this.dataDir, source.id);
      if (nativeId) {
        const executable = writer;
        if (!executable) throw new Error("codex-cli-unavailable");
        this.#assertOpen();
        session = await CodexAppServerSession.start(
          executable,
          workspace,
          home,
          { ...process.env, ...this.environment },
          undefined,
          (started) => {
            session = started;
            this.#trackTransientSession(started);
          },
        );
        this.#assertOpen();
        try {
          await session.request("thread/delete", { threadId: nativeId }, () => {
            this.#assertOpen();
            dispatchManagedCommand(this.dataDir, request.requestId);
            dispatched = true;
          });
        } catch (error) {
          // A retry after an unconfirmed delete, or a thread already deleted in Codex, finds
          // no rollout: the conversation is gone either way.
          if (!dispatched || !codexThreadMissing(error)) throw error;
        }
      } else {
        // No thread was ever confirmed and no command is unconfirmed: nothing exists in Codex.
        dispatchManagedCommand(this.dataDir, request.requestId);
        dispatched = true;
      }
      this.#forgetDeletedSession(source, home);
      const result = outcome({ accepted: true, completed: true, deleted: true });
      finishManagedCommand(this.dataDir, request.requestId, result);
      for (const prior of unconfirmed)
        finishManagedCommand(
          this.dataDir,
          prior.requestId,
          outcome({ accepted: true, completed: true, deleted: true }, prior.requestId),
        );
      return result;
    } catch (error) {
      const busy =
        codexWriterBusy(error) || (error instanceof Error && error.message === "codex-owner-busy");
      if (busy)
        this.#ownership.set(source.id, { checkedAt: Date.now(), reason: "codex-owner-busy" });
      const definite = !dispatched || codexWriterBusy(error);
      const result = outcome({
        accepted: false,
        completed: false,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? busy
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "control-preflight-rejected"
          : "control-outcome-unconfirmed",
      });
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } finally {
      try {
        await session?.close();
      } finally {
        if (!session || session.closed) release?.();
        else session.once("close", () => release?.());
      }
    }
  }

  /** Remove every AgentKib copy of a deleted conversation: ledger, index and its aliases. */
  #forgetDeletedSession(source: ManagedRecord, home: string) {
    const nativeId = source.native_id?.toLowerCase() ?? null;
    const ids = new Set([source.id]);
    if (nativeId)
      for (const record of listManagedRecords(this.dataDir)) {
        if (
          typeof record.id !== "string" ||
          typeof record.native_id !== "string" ||
          record.native_id.toLowerCase() !== nativeId
        )
          continue;
        try {
          if (
            typeof record.home === "string" &&
            pathIdentity(canonicalize(record.home)) === pathIdentity(home)
          )
            ids.add(record.id);
        } catch {
          // A record for a home that no longer exists names another Codex install.
        }
      }
    deleteManagedSessions(this.dataDir, [...ids]);
    const refs = new Set([source.native_id, nativeId].filter((ref): ref is string => !!ref));
    const indexed = [...ids, ...[...refs].map((ref) => this.store.sessions.id("codex", ref))];
    if (this.sessionIndex) this.sessionIndex.forget(indexed);
    else this.store.sessions.forget(indexed);
    for (const id of ids) {
      this.#ownership.delete(id);
      this.#catalogObservations.delete(id);
    }
    this.catalogChanged?.();
  }

  managedSettingsState(value: unknown) {
    return this.#runOperation(async () => {
      const provider = this.#sessionProviders.require("codex");
      if (!isObject(value)) throw new Error("invalid-request");
      return this.#withProviderCapabilities(provider, await provider.settingsState(value));
    });
  }

  sessionProviderSettingsState(value: Record<string, unknown>) {
    return this.#runOperation(async () => {
      const provider =
        typeof value.sessionId === "string"
          ? this.#sessionProviders.creatable(
              this.#sessionProviderForSession(value.sessionId)?.agent,
            )
          : undefined;
      if (!provider) throw new Error("unsupported-session-provider-operation");
      return this.#withProviderCapabilities(provider, await provider.settingsState(value));
    });
  }

  async #managedSettingsState(request: SettingsRead) {
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    const record = stored ?? (await this.#inactiveRecord(request.sessionId));
    const ownerSnapshot = await this.#managedLive(request.sessionId);
    if (ownerSnapshot.executionMode === "codex-follower") {
      const follower = this.#attachedCodexFollower(record);
      if (!follower?.bridge.selectedState) throw new Error("session-state-unavailable");
      const access = await this.#codexFollowerSettingsAccess(record, follower);
      const state = follower.bridge.selectedState;
      if (!state || this.#attachedCodexFollower(record) !== follower)
        throw new Error("session-state-unavailable");
      const projection = state.settingsState();
      const settings = isObject(projection.settings) ? projection.settings : {};
      const writable = isObject(settings.writable) ? settings.writable : {};
      const error = access.reason;
      return {
        ...projection,
        ...(access.models.length > 0 ? { models: access.models } : {}),
        ...(!error ? { writeScope: state.settingsWriteScope } : {}),
        settings: {
          ...settings,
          writable: {
            ...writable,
            model: error ? { available: false, reason: error } : true,
            effort: error ? { available: false, reason: error } : access.effortWritable,
          },
        },
        runtimeBootId: this.#bootId,
      };
    }
    const settings = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.#bootId,
      false,
    ).settings;
    const settingsObject = isObject(settings) ? settings : {};
    const runner = this.#managedRunners.get(request.sessionId);
    if (!runner?.session.connected) {
      const history =
        request.includeHistorical &&
        record.native_id &&
        ownerSnapshot.executionLocation === null &&
        (ownerSnapshot.status === "idle" || ownerSnapshot.status === "unsupported") &&
        this.#isCodexHome(record.home)
          ? this.sessions.codexHistoricalSettings(record.native_id, record.workspace)
          : undefined;
      const historical = {
        ...(history && (history.modelId || history.effort)
          ? { historicalSettings: { modelId: history.modelId, effort: history.effort } }
          : {}),
        ...(history?.usage
          ? {
              historicalUsage: {
                ...history.usage,
                available: true,
                state: "stale",
                historical: true,
              },
            }
          : {}),
      };
      const unavailable = (reason: unknown) => ({
        available: false,
        executionMode: "codex-managed",
        reason,
        settings: settingsObject,
        ...historical,
      });
      if (ownerSnapshot.reason) return unavailable(ownerSnapshot.reason);
      const checked = await this.#preflight.check();
      if (!checked.executable || checked.reason) return unavailable(checked.reason);
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const executable = checked.executable;
      const catalog = await this.#readCodexSettingsCatalog(executable, home, cwd).catch(
        (error: unknown) => {
          if (!history) throw error;
          return undefined;
        },
      );
      if (!catalog) return unavailable("request_failed");
      const { models, collaborationModes } = catalog;
      return {
        available: true,
        executionMode: "codex-managed",
        models,
        policies: managedPolicyCatalog(),
        collaborationModes,
        revision: record.snapshot?.revision ?? 0,
        runtimeBootId: this.#bootId,
        ...historical,
        settings: {
          ...settingsObject,
          writable: {
            model: true,
            effort: true,
            mode:
              collaborationModes.length || record.mode != null
                ? { available: true }
                : { available: false, reason: "native-collaboration-modes-unavailable" },
            serviceTier: true,
            policy: true,
          },
        },
      };
    }
    if (record.archived)
      return {
        available: false,
        executionMode: "codex-managed",
        reason: "recovery-required",
        settings: {
          ...settingsObject,
          applicationStatus: "unknown",
        },
      };
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(record);
    this.#managedCwd(record);
    const models = projectManagedModels(await runner.session.request("model/list", { limit: 100 }));
    let collaborationModes: CollaborationModeOption[] = [];
    if (runner.planVerified) {
      try {
        collaborationModes = verifiedCollaborationModes(
          await runner.session.request("collaborationMode/list", {}),
        );
      } catch (error) {
        // An unavailable preset directory still allows clearing a saved local selection.
        if (!runner.session.connected) throw error;
      }
    }
    const live = await runner.bridge.snapshot(this.#bootId, false);
    if (
      this.#managedRunners.get(request.sessionId) !== runner ||
      !runner.session.connected ||
      runner.retiring ||
      runner.state.nativeId !== record.native_id
    )
      throw new Error("session-state-unavailable");
    const liveSettings = isObject(live.settings) ? live.settings : {};
    const storedMode = isObject(liveSettings.selected) ? liveSettings.selected.mode : null;
    return {
      available: true,
      executionMode: "codex-managed",
      settings: {
        ...liveSettings,
        writable: {
          model: true,
          effort: true,
          mode:
            collaborationModes.length || storedMode != null
              ? { available: true }
              : { available: false, reason: "native-collaboration-modes-unavailable" },
          serviceTier: true,
          policy: true,
        },
      },
      models,
      collaborationModes,
      policies: managedPolicyCatalog(),
      revision: live.revision,
      runtimeBootId: this.#bootId,
    };
  }

  #readCodexSettingsCatalog(executable: string, home: string, cwd: string) {
    return this.#settingsCatalog.read(codexCatalogKey(executable, home, cwd), async () => {
      const catalog = await this.#readCodexRawCatalog(executable, home, cwd);
      return {
        models: projectManagedModels(catalog[0]),
        collaborationModes: verifiedCollaborationModes(catalog[1]),
      };
    });
  }

  async #readCodexFollowerCatalog(
    executable: string,
    home: string,
    cwd: string,
    modelProvider: string,
  ): Promise<ManagedModelOption[]> {
    const [configResult, modelsResult] = await this.#codex.requestMany(executable, cwd, home, [
      ["config/read", { cwd }],
      ["model/list", { limit: 100 }],
    ]);
    const config = isObject(configResult) ? configResult.config : null;
    if (!isObject(config) || (config.model_provider ?? "openai") !== modelProvider)
      throw new Error("follower-operation-unverified");
    return projectManagedModels(modelsResult);
  }

  async #readCodexRawCatalog(executable: string, home: string, cwd: string) {
    let models: unknown;
    try {
      return await this.#codex.requestMany(
        executable,
        cwd,
        home,
        [
          ["model/list", { limit: 100 }],
          ["collaborationMode/list", {}],
        ],
        (index, result) => {
          if (index === 0) models = result;
        },
      );
    } catch {
      // A CLI that rejects the presets still lists its models.
      return [
        models ?? (await this.#codex.request(executable, cwd, home, "model/list", { limit: 100 })),
        null,
      ];
    }
  }

  managedQuery(value: unknown) {
    return this.#runOperation(() => this.#managedQuery(value));
  }

  async #managedQuery(value: unknown) {
    const request = managedQuerySchema.parse(value);
    const provider = this.#sessionProviderForSession(request.sessionId);
    if (!provider) throw new Error("unsupported-session-provider");
    const result = await provider.query(request);
    if (
      request.operation !== "capabilities" ||
      !isObject(result) ||
      result.status === "unsupported" ||
      !this.#serialQueueTarget(request.sessionId)
    )
      return result;
    return {
      ...result,
      features: {
        ...(isObject(result.features) ? result.features : {}),
        ...(await this.#serialQueue.features(
          request.sessionId,
          result,
          request.experimentalEnabled === true,
        )),
      },
    };
  }

  async #antigravityQuery(request: z.infer<typeof managedQuerySchema>) {
    const live = await this.#antigravityLive(request.sessionId);
    if (live.status === "unsupported") {
      if (request.operation !== "capabilities") return live;
      return {
        ...live,
        features: Object.fromEntries(
          ["send", "stop", "approve", "answer", "inspect", "resume", "usage"].map((operation) => [
            operation,
            { available: false, reason: live.reason },
          ]),
        ),
      };
    }
    const experimental = request.experimentalEnabled === true;
    const approvals = Array.isArray(live.approvals) ? live.approvals : [];
    const reason = experimental ? live.reason : "control-disabled";
    const features = {
      send:
        experimental && live.status === "idle" && live.sendEnabled === true
          ? { available: true }
          : {
              available: false,
              reason:
                live.activity === "compacting" ? "session-compacting" : (reason ?? "session-busy"),
            },
      stop:
        experimental && live.stopEnabled === true
          ? { available: true }
          : { available: false, reason: reason ?? "session-not-running" },
      approve:
        experimental && approvals.some((item) => isObject(item) && item.supported === true)
          ? { available: true }
          : { available: false, reason: reason ?? "no-supported-approval" },
      answer: { available: false, reason: "unsupported-operation" },
      inspect: { available: true },
      resume: { available: false, reason: "unsupported-operation" },
      usage:
        isObject(live.usage) && live.usage.available === true
          ? { available: true }
          : { available: false, reason: "usage-not-reported" },
    };
    if (request.operation === "capabilities")
      return {
        sessionId: request.sessionId,
        executionMode: "acp-managed",
        runtimeBootId: this.#bootId,
        status: live.status,
        reason: live.reason,
        features,
      };
    return {
      sessionId: request.sessionId,
      executionMode: "acp-managed",
      runtimeBootId: this.#bootId,
      status: live.status,
      revision: live.revision,
      turnId: live.turnId,
      approvals,
      reason: live.reason,
    };
  }

  async #codexQuery(request: z.infer<typeof managedQuerySchema>) {
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (request.operation === "capabilities") {
      if (!record || !this.#managedRunners.get(request.sessionId)?.session.connected) {
        const source = record ?? (await this.#inactiveRecord(request.sessionId));
        const controls = request.experimentalEnabled === true;
        let live = await this.#inactiveLive(source, controls);
        if (controls && live.reason === "control-outcome-unconfirmed")
          live = (await this.#recoverCodexReceipts(source)) ?? live;
        const checked = await this.#preflight.check();
        const followed = await this.#desktopFollowerLive(source, live, controls);
        if (followed) {
          const f = followed;
          const unknown = managedSessionHasUnknownCommands(this.dataDir, source.id);
          const forkable =
            controls &&
            !checked.reason &&
            !source.archived &&
            (f.reason === null || f.reason === "codex-owner-busy") &&
            !unknown &&
            !!source.native_id &&
            !this.#managedRunners.get(source.id)?.retiring;
          const followerUnavailable = (operation: string) => [
            operation,
            { available: false, reason: "follower-operation-unverified" },
          ];
          const deleteReason = !controls
            ? "control-disabled"
            : checked.reason && source.native_id
              ? checked.reason
              : readUnknownManagedCommands(this.dataDir, source.id).some(
                    (command) => command.evidence?.operation !== "delete",
                  )
                ? "control-outcome-unconfirmed"
                : this.#managedRunners.get(source.id)?.retiring
                  ? "session-retiring"
                  : "codex-owner-busy";
          const send =
            f.sendEnabled === true
              ? { available: true }
              : {
                  available: false,
                  reason:
                    source.snapshot?.settingsStaged === true && !f.reason
                      ? "codex-owner-busy"
                      : typeof f.reason === "string"
                        ? f.reason
                        : f.activity === "compacting"
                          ? "session-compacting"
                          : !controls
                            ? "control-disabled"
                            : "session-busy",
                };
          const features = Object.fromEntries([
            followerUnavailable("answer"),
            followerUnavailable("resume"),
            followerUnavailable("steer"),
            followerUnavailable("queue-list"),
            followerUnavailable("queue-add"),
            followerUnavailable("queue-update"),
            followerUnavailable("queue-delete"),
            followerUnavailable("queue-reorder"),
            followerUnavailable("queue-start"),
            followerUnavailable("rename"),
            followerUnavailable("archive"),
            followerUnavailable("unarchive"),
            ["settings", await this.#codexFollowerSettingsFeature(source, controls)],
            followerUnavailable("goal-set"),
            followerUnavailable("goal-pause"),
            followerUnavailable("goal-resume"),
            followerUnavailable("goal-clear"),
            followerUnavailable("worktree-create"),
            followerUnavailable("branch-switch"),
            followerUnavailable("terminals-clean"),
            followerUnavailable("compact"),
            ["send", send],
            // Images go with the message that starts the owner's next turn; the owner reads
            // them by path, as AgentKib's own Codex runner does.
            ["attachments", send],
            [
              "stop",
              f.stopEnabled === true
                ? { available: true }
                : { available: false, reason: "no-active-turn" },
            ],
            [
              "approve",
              controls &&
              !unknown &&
              Array.isArray(f.approvals) &&
              f.approvals.some((item) => isObject(item) && item.supported === true)
                ? { available: true }
                : {
                    available: false,
                    reason: unknown ? "control-outcome-unconfirmed" : "no-supported-approval",
                  },
            ],
            [
              "fork",
              forkable
                ? { available: true }
                : {
                    available: false,
                    reason:
                      checked.reason ??
                      (typeof f.reason === "string" ? f.reason : "codex-owner-busy"),
                  },
            ],
            ["inspect", { available: !!checked.executable, reason: checked.reason ?? undefined }],
            ...["settings-state", "goal", "resources"].map((operation) => [
              operation,
              checked.reason ? { available: false, reason: checked.reason } : { available: true },
            ]),
            [
              "usage",
              isObject(f.usage) && f.usage.available === true
                ? { available: true }
                : { available: false, reason: "usage-not-reported" },
            ],
            ["delete", { available: false, reason: deleteReason }],
          ]);
          return {
            sessionId: source.id,
            executionMode: "codex-follower",
            runtimeBootId: this.#bootId,
            status: f.status,
            reason: f.reason,
            executionLocation: "external",
            ownershipReason: null,
            features,
          };
        }
        const unavailableReason =
          typeof live.reason === "string" ? live.reason : "session-not-running";
        const allowed = controls && live.reason === null;
        const forkAllowed =
          controls &&
          !checked.reason &&
          !source.archived &&
          (live.reason === null || live.reason === "codex-owner-busy") &&
          !managedSessionHasUnknownCommands(this.dataDir, source.id) &&
          !!source.native_id &&
          !this.#managedRunners.get(source.id)?.retiring;
        const features: Record<string, { available: boolean; reason?: string }> = {};
        for (const operation of [
          "send",
          "stop",
          "approve",
          "answer",
          "resume",
          "steer",
          "queue-list",
          "queue-add",
          "queue-update",
          "queue-delete",
          "queue-reorder",
          "queue-start",
          "rename",
          "archive",
          "unarchive",
          "fork",
          "settings",
          "settings-state",
          "goal",
          "goal-set",
          "goal-pause",
          "goal-resume",
          "goal-clear",
          "usage-limit-cancel",
          "usage-limit-continue",
          "resources",
          "attachments",
          "worktree-create",
          "branch-switch",
          "usage",
          "terminals-clean",
        ])
          features[operation] = { available: false, reason: unavailableReason };
        features.send = allowed
          ? { available: true }
          : {
              available: false,
              reason:
                unavailableReason === "session-not-running"
                  ? "control-disabled"
                  : unavailableReason,
            };
        features.fork = forkAllowed
          ? { available: true }
          : {
              available: false,
              reason:
                unavailableReason === "session-not-running"
                  ? "control-disabled"
                  : unavailableReason,
            };
        features.inspect = { available: !!checked.executable, reason: checked.reason ?? undefined };
        for (const operation of ["settings-state", "goal", "resources"])
          features[operation] = checked.reason
            ? { available: false, reason: checked.reason }
            : { available: true };
        features.unarchive =
          controls &&
          !checked.reason &&
          source.archived &&
          !managedSessionHasUnknownCommands(this.dataDir, source.id)
            ? { available: true }
            : { available: false, reason: checked.reason ?? "session-not-archived" };
        // Deleting starts no runner and includes archived conversations, as Codex's own does.
        // Only another process holding the thread blocks it; an unconfirmed earlier delete
        // is retried by the next one.
        const deleteReason = !controls
          ? "control-disabled"
          : checked.reason && source.native_id
            ? checked.reason
            : readUnknownManagedCommands(this.dataDir, source.id).some(
                  (command) => command.evidence?.operation !== "delete",
                )
              ? "control-outcome-unconfirmed"
              : this.#managedRunners.get(source.id)?.retiring
                ? "session-retiring"
                : live.ownershipReason === "codex-owner-busy"
                  ? "codex-owner-busy"
                  : null;
        features.delete = deleteReason
          ? { available: false, reason: deleteReason }
          : { available: true };
        // Model choices can be saved before the first turn. Execution obtains its own writer.
        for (const operation of ["settings", "rename", "archive", "attachments", "compact"])
          features[operation] = allowed ? { available: true } : features.send!;
        // The Codex app holds the thread with no window answering for it: a message (with its
        // attachments, as a follower sends them) asks the app to take it (#desktopHandoff).
        if (await this.#desktopHandoffLive(source, live, controls)) {
          features.send = { available: true };
          features.attachments = { available: true };
        }
        return {
          sessionId: source.id,
          executionMode: "codex-managed",
          runtimeBootId: this.#bootId,
          status: live.status,
          reason: live.reason,
          executionLocation: live.executionLocation,
          ownershipReason: live.ownershipReason,
          features,
        };
      }
      const live = await this.#managedLive(request.sessionId, request.experimentalEnabled === true);
      if (!isObject(live)) throw new Error("session-state-unavailable");
      const controls = request.experimentalEnabled === true;
      const healthy = live.reason === null && controls;
      const idle = live.status === "idle";
      const running = live.status === "running";
      const compacting = live.activity === "compacting";
      const runner = this.#managedRunners.get(request.sessionId);
      const verified = (await this.#preflight.check()).reason === null;
      const unknown = managedSessionHasUnknownCommands(this.dataDir, request.sessionId);
      const features: Record<string, Record<string, unknown>> = {};
      const set = (operation: string, available: boolean, reason = "session-state-unavailable") => {
        features[operation] = available ? { available: true } : { available: false, reason };
      };
      const managed = true;
      const hasNative = typeof record.native_id === "string";
      const runnerConnected = Boolean(runner?.session.connected);
      const controlReason = !verified
        ? "unsupported-codex-cli-version"
        : !controls
          ? "control-disabled"
          : !managed
            ? "follower-operation-unverified"
            : unknown
              ? "control-outcome-unconfirmed"
              : typeof live.reason === "string"
                ? live.reason
                : record.archived
                  ? "session-archived"
                  : compacting
                    ? "session-compacting"
                    : "session-busy";
      set("inspect", verified, "unsupported-codex-cli-version");
      set(
        "resume",
        Boolean(
          controls &&
          verified &&
          !unknown &&
          hasNative &&
          record.released &&
          !record.archived &&
          !runnerConnected,
        ),
        unknown
          ? "control-outcome-unconfirmed"
          : !hasNative
            ? "native-session-unconfirmed"
            : record.archived
              ? "session-archived"
              : "session-already-managed",
      );
      for (const operation of ["settings-state", "goal", "resources"])
        set(
          operation,
          Boolean(managed && verified),
          managed ? "unsupported-codex-cli-version" : "follower-operation-unverified",
        );
      set(
        "usage",
        managed && isObject(live.usage) && live.usage.available === true,
        "usage-not-reported",
      );
      const idleControls =
        managed && verified && healthy && idle && !compacting && !unknown && !record.archived;
      for (const operation of ["send", "rename", "archive", "fork", "compact", "delete"])
        set(operation, idleControls, controlReason);
      set(
        "settings",
        managed &&
          verified &&
          healthy &&
          runnerConnected &&
          !compacting &&
          !unknown &&
          !record.archived &&
          codexCanSetNextTurn(live.status),
        controlReason,
      );
      set(
        "goal-set",
        idleControls &&
          (record.goal != null ||
            (isObject(live.settings) && live.settings.applicationStatus === "confirmed")),
        live.settings && isObject(live.settings) && live.settings.applicationStatus !== "confirmed"
          ? "settings-not-applied"
          : controlReason,
      );
      set(
        "goal-clear",
        idleControls && record.goal != null,
        record.goal == null ? "goal-unavailable" : controlReason,
      );
      set(
        "goal-pause",
        managed &&
          verified &&
          healthy &&
          !compacting &&
          !unknown &&
          isObject(record.goal) &&
          record.goal.status === "active",
        controlReason,
      );
      set(
        "goal-resume",
        managed &&
          verified &&
          healthy &&
          !compacting &&
          !unknown &&
          isObject(record.goal) &&
          ["paused", "blocked", "budgetLimited", "usageLimited"].includes(
            String(record.goal.status),
          ) &&
          isObject(live.settings) &&
          live.settings.applicationStatus === "confirmed",
        controlReason,
      );
      set(
        "unarchive",
        managed && verified && controls && live.status === "archived",
        "session-not-archived",
      );
      set(
        "steer",
        managed && verified && healthy && running && !compacting && !unknown,
        compacting ? "session-compacting" : "session-requires-running-turn",
      );
      set("stop", live.stopEnabled === true, "no-active-turn");
      // false once this runner's CLI declined thread/queue/list; null before it was asked.
      const queueMissing = runner?.queueVerified === false;
      const queueReason = queueMissing ? "unsupported-codex-cli-version" : controlReason;
      set(
        "queue-list",
        managed && verified && healthy && runnerConnected && !queueMissing,
        queueReason,
      );
      set(
        "queue-add",
        managed && verified && healthy && running && !unknown && !queueMissing,
        queueMissing ? queueReason : "session-requires-running-turn",
      );
      for (const operation of ["queue-update", "queue-delete", "queue-reorder"])
        set(
          operation,
          managed && verified && healthy && runnerConnected && !unknown && !queueMissing,
          queueReason,
        );
      for (const operation of ["queue-start", "worktree-create", "branch-switch"])
        set(operation, false, "native-operation-not-integrated");
      set(
        "usage-limit-cancel",
        managed && typeof this.#codexLimits.get(record.id)?.limit.continueAt === "number",
        "usage-limit-continue-unavailable",
      );
      set(
        "usage-limit-continue",
        managed && usageLimitArmable(this.#codexLimits.get(record.id)?.limit, this.#bootId),
        "usage-limit-continue-unavailable",
      );
      set("approve", managed && verified && healthy && runnerConnected && !unknown, controlReason);
      // Background terminals end with the runner's process, so only a running one has any.
      set(
        "terminals-clean",
        managed && verified && healthy && runnerConnected && !unknown,
        controlReason,
      );
      set("answer", managed && verified && healthy && runnerConnected && !unknown, controlReason);
      // Uploads go with send, steer or queue-add, which each check their own state again.
      // Images become native localImage input; other files a path the turn may read.
      set(
        "attachments",
        managed && verified && healthy && runnerConnected && !unknown && !record.archived,
        controlReason,
      );
      return {
        sessionId: request.sessionId,
        executionMode: "codex-managed",
        status: live.status,
        reason: live.reason,
        features,
      };
    }

    this.#ownership.delete(request.sessionId);

    if (
      !this.#managedRunners.get(request.sessionId)?.session.connected &&
      readUnknownManagedCommands(this.dataDir, request.sessionId).some(({ evidence }) =>
        isObject(evidence?.followerSettings),
      )
    ) {
      const source = record ?? (await this.#inactiveRecord(request.sessionId));
      await this.#checkPendingCodexFollowerSettings(source).catch(() => undefined);
    }

    let workspace: string;
    let nativeId: string;
    let home: string;
    if (record) {
      workspace = canonicalize(this.store.workspacePath(record.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
        throw new Error("session-workspace-mismatch");
      home = this.#assertManagedHome(record);
      if (!record.native_id) throw new Error("native-session-unconfirmed");
      nativeId = record.native_id;
    } else {
      const summary = this.store.sessions.get(request.sessionId);
      if (!summary) throw new Error("session-unavailable");
      if (summary.agent !== "codex") throw new Error("session-not-codex");
      const resolved = await this.sessions.resolve(request.sessionId);
      nativeId = resolved.native.native_ref;
      if (!this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
        throw new Error("unverified-session-identity");
      workspace = canonicalize(resolved.workspace);
      home = canonicalize(this.sessions.codexHome());
    }
    const executionCwd = this.#managedCwd(
      record ?? (await this.#inactiveRecord(request.sessionId)),
    );
    const executable = this.#codexReader();
    if (!executable) throw new Error("codex-cli-unavailable");
    const readRevision = this.#managedRunners.get(request.sessionId)?.state.revision;
    const response = await this.#codex.request(executable, executionCwd, home, "thread/read", {
      threadId: nativeId,
      includeTurns: true,
    });
    const thread = isObject(response) ? response.thread : null;
    if (!isObject(thread) || thread.id !== nativeId) throw new Error("thread-identity-mismatch");
    if (typeof thread.cwd !== "string" || !within(canonicalize(thread.cwd), workspace))
      throw new Error("codex-context-outside-workspace");
    let unresolvedCount = 0;
    if (record) {
      const latest = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === record.id,
      );
      if (!latest || latest.native_id !== nativeId || latest.workspace_id !== record.workspace_id)
        throw new Error("session-unavailable");
      const unknownCommands = readUnknownManagedCommands(this.dataDir, record.id);
      const runner = this.#managedRunners.get(record.id);
      let queue: Awaited<ReturnType<typeof readManagedQueue>> | null = null;
      if (unknownCommands.some((command) => command.evidence?.operation === "queue-add")) {
        let queueSession = runner?.session.connected ? runner.session : undefined;
        const ownsQueueSession = !queueSession;
        try {
          if (!queueSession) {
            this.#assertOpen();
            queueSession = await CodexAppServerSession.start(
              executable,
              executionCwd,
              home,
              { ...process.env, ...this.environment },
              undefined,
              (started) => {
                queueSession = started;
                this.#trackTransientSession(started);
              },
            );
            this.#assertOpen();
          }
          queue = await readManagedQueue(queueSession, nativeId, 100);
        } catch {
          queue = null;
        } finally {
          if (ownsQueueSession) await queueSession?.close();
        }
      }
      const followerState = this.#attachedCodexFollower(record)?.bridge.selectedState ?? null;
      for (const unknown of unknownCommands) {
        const evidence = unknown.evidence;
        const nativeRequestResolved =
          evidence?.runtimeBootId === this.#bootId &&
          typeof evidence.turnId === "string" &&
          evidence.nativeRequestId != null &&
          runner?.state.nativeId === nativeId &&
          runner.state.hasResolvedRequest(evidence.turnId, evidence.nativeRequestId);
        const queuedAddResolved =
          evidence?.operation === "queue-add" &&
          queue?.complete === true &&
          queue.data.some((row) => isObject(row) && row.clientUserMessageId === unknown.requestId);
        const followerApproveResolved =
          evidence?.executionMode === "codex-follower" &&
          evidence.operation === "approve" &&
          evidence.nativeRequestId != null &&
          typeof evidence.turnId === "string" &&
          followerState !== null &&
          followerState.revision !== null &&
          !followerState.hasPendingRequest(evidence.nativeRequestId, evidence.turnId);
        if (
          !managedSettingsEvidenceMatches(unknown.evidence, latest) &&
          !nativeRequestResolved &&
          !queuedAddResolved &&
          !followerApproveResolved &&
          !managedCommandReconciles(unknown.requestId, evidence, thread)
        )
          unresolvedCount += 1;
        else
          finishManagedCommand(this.dataDir, unknown.requestId, {
            accepted: true,
            completed: false,
            reconciled: true,
            requestId: unknown.requestId,
            runtimeBootId: this.#bootId,
            sessionId: record.id,
          });
      }
    } else {
      // Older Desktop-follower receipts still need a conservative, read-only
      // reconciliation path after that transport leaves the main flow.
      const followerState =
        this.#attachedCodexFollower({ id: request.sessionId, native_id: nativeId })?.bridge
          .selectedState ?? null;
      for (const unknown of readUnknownManagedCommands(this.dataDir, request.sessionId)) {
        const evidence = unknown.evidence;
        const followerApproveResolved =
          evidence?.executionMode === "codex-follower" &&
          evidence.operation === "approve" &&
          evidence.nativeRequestId != null &&
          typeof evidence.turnId === "string" &&
          followerState !== null &&
          followerState.revision !== null &&
          !followerState.hasPendingRequest(evidence.nativeRequestId, evidence.turnId);
        if (
          followerApproveResolved ||
          managedCommandReconciles(unknown.requestId, unknown.evidence, thread)
        )
          finishManagedCommand(this.dataDir, unknown.requestId, {
            accepted: true,
            completed: false,
            reconciled: true,
            requestId: unknown.requestId,
            runtimeBootId: this.#bootId,
            sessionId: request.sessionId,
          });
        else unresolvedCount += 1;
      }
    }
    const context = await this.#context(request.sessionId);
    const runner = this.#managedRunners.get(request.sessionId);
    if (record && runner?.session.connected && unresolvedCount === 0) {
      await runner.bridge.flush();
      if (runner.state.turnId === null) {
        const hydrated = runner.state.hydrate(thread, true, readRevision);
        runner.persist(runner.state, hydrated.events);
      } else if (runner.state.restoreReconciledTurn()) runner.persist(runner.state);
    }
    const ownership = await this.#managedLive(request.sessionId);
    return {
      sessionId: request.sessionId,
      reconciled: unresolvedCount === 0,
      reason: unresolvedCount === 0 ? ownership.reason : "control-outcome-unconfirmed",
      executionLocation: ownership.executionLocation,
      ownershipReason: ownership.ownershipReason,
      unresolvedCount,
      context,
      nativeStatus: thread.status ?? null,
      executionUnchanged: true,
    };
  }

  /**
   * After a managed Codex turn: one that met the account's usage limit is held, with the continue
   * armed as `usage-limit.ts` says; a turn that completes ends the hold.
   */
  #codexTurnLimit(
    sessionId: string,
    session: CodexAppServerSession,
    state: ManagedCodexState,
    turn: Record<string, unknown>,
  ): void {
    const limited = state.limitedTurn;
    if (limited && limited.turnId === turn.id) {
      void this.#holdCodexLimit(sessionId, session, limited.message);
      return;
    }
    if (turn.status === "completed" && !turn.error && this.#codexLimits.has(sessionId)) {
      this.#armCodexLimit(sessionId, null);
      this.#observeLane((observer) => observer.limitEnded?.(sessionId));
    }
  }

  /** Whether a managed Codex session waits for its usage limit to reset. */
  usageLimited(sessionId: string): boolean {
    const held = this.#codexLimits.get(sessionId);
    return !!held && !held.continuing;
  }

  async #holdCodexLimit(
    sessionId: string,
    session: CodexAppServerSession,
    message: string,
  ): Promise<void> {
    // Codex's error carries no reset time; the account's limits do, as the Codex app reads them.
    const read = await session
      .request("account/rateLimits/read", { excludeResetCreditDetails: true })
      .catch(() => null);
    const held = this.#codexLimits.get(sessionId);
    this.#armCodexLimit(
      sessionId,
      holdUsageLimit("codex", codexUsageLimitHit(read, message), {
        deviceId: this.#codexSenders.get(sessionId) ?? held?.limit.deviceId ?? "",
        bootId: this.#bootId,
        // Only a turn AgentKib's continue started counts toward the three in a row.
        previous: held?.continuing ? held.limit : null,
        autoContinue: usageLimitAutoContinue(this.dataDir),
      }),
    );
  }

  /**
   * Holds `limit` (null ends the hold) and arms its continue; `show` puts it on the live state,
   * which moves its revision, so never in the middle of a control.
   */
  #armCodexLimit(
    sessionId: string,
    limit: UsageLimit | null,
    continuing?: string,
    show = true,
  ): void {
    const held = this.#codexLimits.get(sessionId);
    clearTimeout(held?.timer);
    if (!limit) this.#codexLimits.delete(sessionId);
    else {
      const timer =
        limit.continueAt === null
          ? undefined
          : setTimeout(
              () => void this.#fireCodexContinue(sessionId).catch(() => undefined),
              Math.max(0, limit.continueAt - Date.now()),
            );
      timer?.unref?.();
      this.#codexLimits.set(sessionId, { limit, timer, continuing });
    }
    const runner = this.#managedRunners.get(sessionId);
    if (show && runner?.state.showUsageLimit(usageLimitView(limit, this.#bootId))) {
      const live = runner.state.snapshot(this.#bootId, runner.session.connected);
      this.publishConversationEvent?.(sessionId, "state", live, live);
    }
  }

  /**
   * The continue armed after a usage limit is due: AgentKib resumes a goal Codex paused for the
   * limit, or sends its continue, in the name of the device whose turn met the limit.
   */
  async #fireCodexContinue(sessionId: string): Promise<void> {
    const held = this.#codexLimits.get(sessionId);
    if (!held || this.#shuttingDown) return;
    const due = usageLimitContinue(held.limit, this.#bootId);
    if (due === "never") return;
    if (due === "wait") return this.#armCodexLimit(sessionId, held.limit);
    if (due === "stale")
      return this.#armCodexLimit(sessionId, { ...held.limit, continueAt: null, manual: "stale" });
    const requestId = randomUUID();
    this.#armCodexLimit(
      sessionId,
      { ...held.limit, continueAt: null, autoContinues: held.limit.autoContinues + 1 },
      requestId,
      false,
    );
    const live = (await this.#managedLive(sessionId, true).catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!live || live.status !== "idle") {
      // Something else runs: look again shortly.
      return this.#armCodexLimit(sessionId, { ...held.limit, continueAt: Date.now() + 60_000 });
    }
    const goal = isObject(live.goal) && live.goal.status === "usageLimited";
    const result = (await this.managedControl({
      operation: goal ? "goal-resume" : "send",
      sessionId,
      requestId,
      ...(held.limit.deviceId ? { deviceId: held.limit.deviceId } : {}),
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      ...(goal ? {} : { text: AUTO_CONTINUE_TEXT.codex }),
    }).catch(() => null)) as Record<string, unknown> | null;
    const current = this.#codexLimits.get(sessionId);
    if (result?.accepted !== true && current?.continuing === requestId)
      // Refused: the person continues.
      this.#armCodexLimit(sessionId, { ...current.limit, manual: "stale" });
  }

  /** The person's choice about the continue: off this time (`usage-limit-cancel`), or on. */
  #codexLimitChoice(
    request: z.infer<typeof managedControlSchema>,
    record: ManagedRecord | undefined,
    fingerprint: string,
    choose: (limit: UsageLimit) => UsageLimit | null,
  ): Record<string, unknown> {
    const held = this.#codexLimits.get(request.sessionId);
    const next = held ? choose(held.limit) : null;
    if (!record || !next) throw new Error("usage-limit-continue-unavailable");
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: record.workspace_id,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: "codex-managed",
        turnId: null,
        nativeRequestId: null,
      },
    );
    if (claimed) return claimed;
    this.#armCodexLimit(request.sessionId, next);
    const result = {
      sessionId: request.sessionId,
      accepted: true,
      completed: true,
      requestId: request.requestId,
      runtimeBootId: this.#bootId,
    };
    finishManagedCommand(this.dataDir, request.requestId, result);
    return result;
  }

  /** A device lost access: AgentKib no longer continues in its name after a usage limit. */
  invalidateUsageLimitDevice(deviceId: string): void {
    for (const [sessionId, held] of this.#codexLimits)
      if (held.limit.deviceId === deviceId && held.limit.continueAt !== null)
        this.#armCodexLimit(sessionId, { ...held.limit, continueAt: null, manual: "cancelled" });
    for (const [sessionId, held] of this.#devinLimits)
      if (held.limit.deviceId === deviceId && held.limit.continueAt !== null)
        this.#armDevinLimit(sessionId, { ...held.limit, continueAt: null, manual: "cancelled" });
  }

  managedControl(value: unknown) {
    return this.#runOperation(() => {
      if (!isObject(value) || typeof value.sessionId !== "string")
        throw new Error("invalid-request");
      const provider = this.#sessionProviderForSession(value.sessionId);
      if (!provider) throw new Error("unsupported-session-provider");
      if (
        this.#serialQueueTarget(value.sessionId) &&
        ["queue-add", "queue-update", "queue-delete", "queue-pause", "queue-resume"].includes(
          String(value.operation),
        )
      )
        return this.#serialQueue.control(value);
      if (value.operation === "settings" && "updateSettings" in provider)
        return provider.updateSettings(value);
      return provider.control(value);
    });
  }

  async #managedControlAdmission(value: unknown, execute: ApplyManagedSettings) {
    const request = managedControlSchema.parse(value);
    const id = request.sessionId;
    const admission = this.#controlSessions.get(id) ?? { count: 0, observed: false };
    admission.count += 1;
    admission.observed ||= this.isSessionObserved?.(id) === true;
    this.#controlSessions.set(id, admission);
    const runner = this.#managedRunners.get(id);
    if (runner && admission.observed) runner.observed = true;
    try {
      const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
      const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
      return previous ?? (await execute(request, fingerprint));
    } finally {
      const current = this.#managedRunners.get(id);
      if (current && admission.observed) current.observed = true;
      admission.count -= 1;
      if (admission.count === 0) this.#controlSessions.delete(id);
    }
  }

  /** A short-lived subscription must be recorded even between retirement timer ticks. */
  observeSession(sessionId: string): void {
    const runner = this.#managedRunners.get(sessionId);
    if (runner) runner.observed = true;
    const admission = this.#controlSessions.get(sessionId);
    if (admission) admission.observed = true;
  }

  async #inactiveCodexControlRecord(source: ManagedRecord, expectedRevision: number) {
    const records = readManagedRecords(this.dataDir, this.store);
    const record =
      records.find((item) => item.id === source.id) ?? (await this.#inactiveRecord(source.id));
    if (
      !record.native_id ||
      record.native_id !== source.native_id ||
      record.archived ||
      record.workspace_id !== source.workspace_id ||
      (record.snapshot?.revision ?? 0) !== expectedRevision ||
      managedSessionHasUnknownCommands(this.dataDir, source.id)
    )
      throw new Error("stale-or-disabled-control");
    if (
      records.some(
        (item) =>
          item.id !== record.id &&
          item.native_id === record.native_id &&
          (!item.released || !item.adopted),
      )
    )
      throw new Error("session-already-managed");
    return { ...record, native_id: record.native_id };
  }

  async #connectCodexForControl(source: ManagedRecord, request: SettingsControl) {
    const unlock = acquireManagedSessionLease(this.dataDir, source.id);
    let ownsLease = true;
    const release = () => {
      if (!ownsLease) return;
      ownsLease = false;
      unlock();
    };
    let prior: ManagedRecord | undefined;
    const restore = (_error: unknown, ownsLease: boolean) => {
      if (prior && ownsLease) {
        saveManagedRecord(this.dataDir, prior);
        prior = undefined;
      }
    };
    try {
      const record = await this.#inactiveCodexControlRecord(source, request.expectedRevision);
      if (this.#managedRunners.size >= 8) throw new Error("managed-session-limit");
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      this.#assertOpen();
      const starting: ManagedRecord = {
        ...record,
        cwd,
        released: false,
        snapshot: { ...record.snapshot, status: "starting", reason: null },
      };
      saveManagedRecord(this.dataDir, starting);
      prior = record;
      const runner = await this.#attachManagedRunner(
        starting,
        record.workspace,
        home,
        release,
        undefined,
        undefined,
        restore,
      );
      this.#managedRunners.set(source.id, runner);
      return runner;
    } catch (error) {
      if (!this.#managedRunners.has(source.id)) {
        try {
          restore(error, ownsLease);
        } finally {
          release();
        }
      }
      throw error;
    }
  }

  async #stageCodexSettings(source: ManagedRecord, request: SettingsControl) {
    const release = acquireManagedSessionLease(this.dataDir, source.id);
    try {
      const record = await this.#inactiveCodexControlRecord(source, request.expectedRevision);
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const policyOnly = codexPolicyOnly(request);
      const modeOnly = request.mode !== undefined && !changesCodexModel(request);
      let settings: Partial<ManagedRecord>;
      if (policyOnly) settings = { policy_id: policyOnly };
      else if (modeOnly && request.mode === null) settings = { mode: null };
      else {
        const checked = await this.#preflight.check();
        if (!checked.executable || checked.reason)
          throw new Error(checked.reason ?? "codex-cli-unavailable");
        const { models, collaborationModes } = await this.#readCodexSettingsCatalog(
          checked.executable,
          home,
          cwd,
        );
        if (request.mode != null) {
          if (!collaborationModes.length) throw new Error("native-collaboration-modes-unavailable");
          if (!collaborationModes.some((item) => item.id === request.mode))
            throw new Error("unsupported-collaboration-mode");
        }
        if (modeOnly) settings = { mode: request.mode };
        else {
          const defaults = models.find((model) => model.isDefault);
          const withDefaults = {
            default_model: defaults?.id ?? null,
            default_effort: defaults?.defaultEffort ?? null,
            default_service_tier: defaults?.defaultServiceTier ?? null,
          };
          settings = {
            ...withDefaults,
            ...codexSettingsMutation(request, { ...record, ...withDefaults }, models),
          };
        }
      }
      // A policy can accompany any selection without opening the native thread.
      if (request.policyId !== undefined) settings.policy_id = request.policyId;
      const snapshot: Record<string, unknown> = {
        ...record.snapshot,
        status: "idle",
        reason: null,
        settingsStaged: true,
        revision: request.expectedRevision + 1,
      };
      // This flag also covers mode-only writes so resume keeps the inherited model settings.
      if ((policyOnly || modeOnly) && !hasStagedCodexModelSettings(record))
        snapshot.policyOnlyStaged = true;
      else delete snapshot.policyOnlyStaged;
      const staged: ManagedRecord = {
        ...record,
        ...settings,
        snapshot,
      };
      this.#assertOpen();
      if (this.#assertManagedHome(record) !== home || this.#managedCwd(record) !== cwd)
        throw new Error("codex-workspace-mismatch");
      if (existingFileLeaseBusy(path.join(home, "thread-writer-locks", `${record.native_id}.lock`)))
        throw new Error("codex-owner-busy");
      if (managedSessionHasUnknownCommands(this.dataDir, source.id))
        throw new Error("control-outcome-unconfirmed");
      const result = {
        accepted: true,
        completed: true,
        appliesTo: "next-turn",
        sessionId: source.id,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      saveManagedSettingsReceipt(this.dataDir, staged, request.requestId, result);
      this.publishConversationEvent?.(source.id, "invalidate", {
        domains: ["settings", "ownership", "receipts"],
      });
      return result;
    } finally {
      release();
    }
  }

  async #codexControl(request: SettingsControl, fingerprint: string) {
    let record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
      throw new Error("stale-or-disabled-control");
    if (
      !this.#managedRunners.get(request.sessionId)?.session.connected &&
      request.operation === "fork"
    )
      return this.#inactiveFork(
        request,
        await this.#inactiveRecord(request.sessionId),
        fingerprint,
      );
    if (record?.archived) throw new Error("session-archived");
    if (record && (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId))
      throw new Error("stale-or-disabled-control");
    if (request.operation === "usage-limit-cancel")
      return this.#codexLimitChoice(request, record, fingerprint, (limit) =>
        limit.continueAt === null ? null : { ...limit, continueAt: null, manual: "cancelled" },
      );
    if (request.operation === "usage-limit-continue")
      return this.#codexLimitChoice(request, record, fingerprint, (limit) =>
        armUsageLimit(limit, { bootId: this.#bootId }),
      );
    if (["send", "queue-add", "steer", "goal-resume"].includes(request.operation)) {
      // The person's message takes over from a continue armed after a usage limit.
      // Only the record changes here: the live revision this control was checked against stays,
      // and the turn it starts clears what the state shows.
      const held = this.#codexLimits.get(request.sessionId);
      if (held && held.continuing !== request.requestId)
        this.#armCodexLimit(request.sessionId, null, undefined, false);
      if (request.deviceId) this.#codexSenders.set(request.sessionId, request.deviceId);
    }
    let runner = this.#managedRunners.get(request.sessionId);
    let resumedControlState: string | undefined;
    let prepared = false;
    const claim = (workspaceId: string) =>
      claimManagedCommand(
        this.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId ?? null,
        codexCommandEvidence(request, workspaceId),
      );
    const reject = (reason: string, workspaceId: string) => {
      if (!prepared) {
        const prior = claim(workspaceId);
        if (prior) return prior;
      }
      const result = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        reason,
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    };
    if (!runner?.session.connected || runner.retiring) {
      const inactive = record ?? (await this.#inactiveRecord(request.sessionId));
      const rejectInactive = (reason: string) => reject(reason, inactive.workspace_id);
      if (runner?.retiring || managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        return rejectInactive("control-outcome-unconfirmed");
      const observedFollower = this.#attachedCodexFollower(inactive);
      const owner = observedFollower ? this.#codexWriterOwnership(inactive, true) : null;
      const follower = owner === "codex-owner-busy" ? observedFollower : undefined;
      if (observedFollower && owner && !follower) return rejectInactive(owner);
      if (follower) {
        if (request.operation === "settings")
          return this.#updateCodexFollowerSettings(request, fingerprint, inactive, follower);
        if (!["send", "stop", "approve"].includes(request.operation))
          return rejectInactive("follower-operation-unverified");
        if (request.operation === "send" && inactive.snapshot?.settingsStaged === true)
          return rejectInactive("codex-owner-busy");
        return this.#codexFollowerControl(request, fingerprint, follower, inactive.workspace_id);
      }
      if (request.expectedSettingsScope !== undefined)
        return rejectInactive("stale-or-disabled-control");
      if (request.expectedRevision !== (inactive.snapshot?.revision ?? 0))
        return rejectInactive("stale-or-disabled-control");
      if (!["send", "settings", "rename", "archive", "compact"].includes(request.operation))
        return rejectInactive("session-not-running");
      const policyOnly = codexPolicyOnly(request);
      if (!policyOnly) {
        const checked = await this.#preflight.check();
        if (checked.reason) return rejectInactive(checked.reason);
      }
      const prior = claim(inactive.workspace_id);
      if (prior) return prior;
      prepared = true;
      // Only resume is authoritative: the earlier focus probe can race another client.
      try {
        if (request.operation === "settings")
          return await this.#stageCodexSettings(inactive, request);
        runner = await this.#connectCodexForControl(inactive, request);
        record = { ...(runner.state.record as ManagedRecord) };
        request.expectedRevision = runner.state.revision;
        if (request.operation === "send") resumedControlState = managedControlState(runner.state);
      } catch (error) {
        const busy = codexWriterBusy(error);
        if (busy)
          this.#ownership.set(request.sessionId, {
            checkedAt: Date.now(),
            reason: "codex-owner-busy",
          });
        if (busy && request.operation === "send" && inactive.snapshot?.settingsStaged !== true) {
          const handed = await this.#desktopHandoff(inactive).catch(() => undefined);
          if (handed)
            return this.#codexFollowerControl(
              { ...request, expectedRevision: handed.revision },
              fingerprint,
              handed.follower,
              inactive.workspace_id,
              true,
            );
        }
        return rejectInactive(
          busy ? "codex-owner-busy" : error instanceof Error ? error.message : "recovery-required",
        );
      }
    }
    if (!record || !runner) throw new Error("session-unavailable");
    if (request.expectedSettingsScope !== undefined)
      return reject("stale-or-disabled-control", record.workspace_id);
    let cwd: string;
    let snapshot: Record<string, unknown>;
    try {
      if (!runner.session.connected) throw new Error("session-runner-unavailable");
      if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      this.#assertManagedHome(record);
      if (!record.native_id || record.native_id !== runner.state.nativeId)
        throw new Error("native-session-unconfirmed");
      cwd = this.#managedCwd(record);
      snapshot = await runner.bridge.snapshot(this.#bootId, true);
      if (activityBlocks(snapshot, request.operation)) {
        const result = compactingRejection(request, this.#bootId);
        if (prepared) finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      }
      if (
        resumedControlState !== undefined &&
        managedControlState(runner.state) === resumedControlState
      )
        request.expectedRevision = Number(snapshot.revision);
      if (snapshot.reason || snapshot.revision !== request.expectedRevision)
        throw new Error("stale-or-disabled-control");
    } catch (error) {
      if (prepared)
        return reject(
          error instanceof Error ? error.message : "control-preflight-rejected",
          record.workspace_id,
        );
      throw error;
    }
    if (request.operation === "fork")
      return this.#managedFork(request, record, runner, fingerprint);

    const claimed = prepared ? null : claim(record.workspace_id);
    if (claimed) return claimed;

    try {
      // Fork/resume can retain a native model outside the current picker so the
      // user can inspect it or change next-turn settings without running it.
      // Operations that can request inference still validate before dispatch.
      if (
        [
          "send",
          "steer",
          "queue-add",
          "queue-start",
          "goal-set",
          "goal-resume",
          "compact",
        ].includes(request.operation)
      )
        validateManagedModelSelection(
          record,
          projectManagedModels(await runner.session.request("model/list", { limit: 100 })),
        );
      let method: string;
      let params: unknown;
      let responseId: unknown;
      let localMutation:
        | Partial<
            Pick<
              ManagedRecord,
              | "model"
              | "effort"
              | "service_tier"
              | "policy_id"
              | "mode"
              | "title"
              | "goal"
              | "archived"
            >
          >
        | undefined;
      if (request.operation === "send") {
        if (snapshot.status !== "idle" || snapshot.sendEnabled !== true)
          throw new Error("session-busy");
        const turnMode = managedTurnMode(record);
        if (turnMode) {
          if (!runner.planVerified) throw new Error("native-collaboration-modes-unavailable");
          const modes = verifiedCollaborationModes(
            await runner.session.request("collaborationMode/list", {}),
          );
          if (!modes.some((mode) => mode.id === turnMode))
            throw new Error("unsupported-collaboration-mode");
          // The preset's settings name the turn's model, which the runner always confirms.
          if (!record.model) throw new Error("native-model-unconfirmed");
        }
        const input = await this.#managedInput(request, record, runner);
        params = {
          threadId: record.native_id,
          clientUserMessageId: request.requestId,
          input,
          ...managedTurnSettings(record, cwd),
        };
        method = "turn/start";
      } else if (request.operation === "compact") {
        // Manual compaction runs as a turn of its own, like the TUI's /compact.
        if (snapshot.status !== "idle" || snapshot.sendEnabled !== true)
          throw new Error("session-busy");
        params = { threadId: record.native_id };
        method = "thread/compact/start";
      } else if (request.operation === "terminals-clean") {
        // The TUI's /stop: ends the commands still running in the background. Stopping a turn
        // leaves them running, as Esc does in the terminal.
        params = { threadId: record.native_id };
        method = "thread/backgroundTerminals/clean";
      } else if (request.operation === "stop") {
        if (
          request.turnId !== runner.state.turnId ||
          !request.turnId ||
          snapshot.stopEnabled !== true
        )
          throw new Error("stale-turn");
        params = { threadId: record.native_id, turnId: request.turnId };
        method = "turn/interrupt";
      } else if (request.operation === "steer" || request.operation === "queue-add") {
        if (request.operation === "queue-add" && !runner.queueVerified)
          throw new Error("unsupported-codex-cli-version");
        const allowedStatus =
          request.operation === "steer"
            ? snapshot.status === "running"
            : ["running", "awaiting-approval", "waiting-input"].includes(String(snapshot.status));
        if (!allowedStatus || (!request.turnId && request.operation === "steer"))
          throw new Error("session-requires-running-turn");
        const input = await this.#managedInput(request, record, runner);
        params =
          request.operation === "steer"
            ? {
                threadId: record.native_id,
                expectedTurnId: request.turnId,
                clientUserMessageId: request.requestId,
                input,
              }
            : {
                threadId: record.native_id,
                clientUserMessageId: request.requestId,
                input,
              };
        method = request.operation === "steer" ? "turn/steer" : "thread/queue/add";
      } else if (["queue-update", "queue-delete", "queue-reorder"].includes(request.operation)) {
        if (!runner.queueVerified) throw new Error("unsupported-codex-cli-version");
        const queue = await readManagedQueue(runner.session, record.native_id!, 100);
        const rows = queue.data.filter(isObject);
        if (!queue.complete) throw new Error("queue-too-large");
        if (request.operation === "queue-update") {
          const target = rows.find((row) => row.id === request.queuedSubmissionId);
          if (!target) throw new Error("queued-submission-unavailable");
          if (
            !Array.isArray(target.input) ||
            target.input.length !== 1 ||
            !isObject(target.input[0]) ||
            target.input[0].type !== "text" ||
            String(target.input[0].text ?? "").startsWith("User attached file ")
          )
            throw new Error("queue-attachments-edit-unsupported");
          params = {
            threadId: record.native_id,
            queuedSubmissionId: request.queuedSubmissionId,
            input: await this.#managedInput(request, record, runner),
          };
          method = "thread/queue/update";
        } else if (request.operation === "queue-delete") {
          if (!rows.some((row) => row.id === request.queuedSubmissionId))
            throw new Error("queued-submission-unavailable");
          params = { threadId: record.native_id, queuedSubmissionId: request.queuedSubmissionId };
          method = "thread/queue/delete";
        } else {
          const current = rows
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string");
          const desired = request.queuedSubmissionIds ?? [];
          if (
            current.length !== desired.length ||
            new Set(desired).size !== desired.length ||
            current.some((id) => !desired.includes(id))
          )
            throw new Error("stale-queue-order");
          params = { threadId: record.native_id, queuedSubmissionIds: desired };
          method = "thread/queue/reorder";
        }
      } else if (request.operation === "rename") {
        if (snapshot.status !== "idle") throw new Error("session-busy");
        if (
          !request.name?.trim() ||
          [...request.name].some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          })
        )
          throw new Error("invalid-session-name");
        params = { threadId: record.native_id, name: request.name };
        method = "thread/name/set";
        // The person's name wins over a title still being made for the thread.
        const naming = record.native_id ? this.#titleAttempts.get(record.native_id) : undefined;
        if (naming) naming.renamed = true;
      } else if (request.operation === "archive") {
        if (snapshot.status !== "idle") throw new Error("session-busy");
        params = { threadId: record.native_id };
        method = "thread/archive";
      } else if (request.operation.startsWith("goal-")) {
        if (request.operation === "goal-set") {
          if (snapshot.status !== "idle") throw new Error("session-busy");
          if (!isObject(request.goal)) throw new Error("missing-goal");
          const objective = request.goal.objective;
          if (
            typeof objective !== "string" ||
            !objective.trim() ||
            Buffer.byteLength(objective, "utf8") > 16 * 1024
          )
            throw new Error("invalid-goal-objective");
          const intent = request.goal.intent === undefined ? "start" : request.goal.intent;
          if (intent !== "start" && intent !== "update") throw new Error("invalid-goal-intent");
          if (intent === "start" && record.goal != null) throw new Error("goal-already-exists");
          if (intent === "update" && record.goal == null) throw new Error("goal-unavailable");
          if (
            intent === "start" &&
            (!isObject(snapshot.settings) || snapshot.settings.applicationStatus !== "confirmed")
          )
            throw new Error("settings-not-applied");
          const budget = request.goal.tokenBudget;
          if (
            budget !== undefined &&
            budget !== null &&
            (!Number.isSafeInteger(budget) || Number(budget) <= 0)
          )
            throw new Error("invalid-goal-budget");
          params = { threadId: record.native_id, objective };
          if (budget !== undefined) (params as Record<string, unknown>).tokenBudget = budget;
          if (intent === "start") (params as Record<string, unknown>).status = "active";
          method = "thread/goal/set";
        } else if (request.operation === "goal-clear") {
          if (record.goal == null) throw new Error("goal-unavailable");
          params = { threadId: record.native_id };
          method = "thread/goal/clear";
        } else {
          const currentGoal = isObject(record.goal) ? record.goal : null;
          if (!currentGoal) throw new Error("goal-unavailable");
          const target = request.operation === "goal-pause" ? "paused" : "active";
          const currentStatus = currentGoal.status;
          if (
            (target === "paused" && currentStatus !== "active") ||
            (target === "active" &&
              !["paused", "blocked", "budgetLimited", "usageLimited"].includes(
                String(currentStatus),
              ))
          )
            throw new Error("goal-state-changed");
          if (
            target === "active" &&
            (!isObject(snapshot.settings) || snapshot.settings.applicationStatus !== "confirmed")
          )
            throw new Error("settings-not-applied");
          params = { threadId: record.native_id, status: target };
          method = "thread/goal/set";
        }
      } else if (request.operation === "settings") {
        if (!codexCanSetNextTurn(snapshot.status)) throw new Error("session-busy");
        if (request.mode === null && !changesCodexModel(request) && request.policyId === undefined)
          localMutation = { mode: null };
        else {
          const models = projectManagedModels(
            await runner.session.request("model/list", { limit: 100 }),
          );
          localMutation = codexSettingsMutation(request, record, models);
        }
        const clearsInheritedEffort =
          localMutation.effort === null &&
          isObject(record.native_settings) &&
          typeof record.native_settings.effort === "string";
        const effectiveMode = clearsInheritedEffort
          ? managedTurnMode({ ...record, ...localMutation })
          : localMutation.mode;
        if (request.mode || clearsInheritedEffort) {
          if (!runner.planVerified) throw new Error("native-collaboration-modes-unavailable");
          // The presets are `{mode, name}` rows (0.163.0 CollaborationModeMask); AgentKib's
          // option id is the native mode.
          const modes = verifiedCollaborationModes(
            await runner.session.request("collaborationMode/list", {}),
          );
          if (!modes.some((entry) => entry.id === effectiveMode))
            throw new Error("unsupported-collaboration-mode");
        }
        method = "";
        params = {};
      } else if (request.operation === "approve") {
        const approvalId = request.approvalId;
        if (approvalId === undefined || !request.turnId || request.turnId !== runner.state.turnId)
          throw new Error("missing-approval");
        const approval = (Array.isArray(snapshot.approvals) ? snapshot.approvals : [])
          .filter(isObject)
          .find(
            (item) =>
              managedRequestKey(item.requestId) === managedRequestKey(approvalId) &&
              item.turnId === request.turnId,
          );
        if (!approval || approval.supported !== true) throw new Error("unsupported-approval");
        const decision = request.nativeDecision ?? request.decision;
        if (decision === undefined) throw new Error("missing-decision");
        const options = Array.isArray(approval.decisionOptions) ? approval.decisionOptions : [];
        const offered = options.some(
          (option) => isObject(option) && stableJson(option.decision) === stableJson(decision),
        );
        const legacy =
          typeof decision === "string" &&
          Array.isArray(approval.availableDecisions) &&
          approval.availableDecisions.includes(decision);
        if (!offered && !legacy) throw new Error("unsupported-decision");
        responseId = approvalId;
        params =
          approval.method === "item/permissions/requestApproval"
            ? decision
            : approval.method === "mcpServer/elicitation/request"
              ? elicitationResponse(decision)
              : { decision };
        method = "";
      } else {
        const questionId = request.questionId;
        if (questionId === undefined || !request.turnId || request.turnId !== runner.state.turnId)
          throw new Error("missing-question");
        const question = (Array.isArray(snapshot.questions) ? snapshot.questions : [])
          .filter(isObject)
          .find(
            (item) =>
              managedRequestKey(item.requestId) === managedRequestKey(questionId) &&
              item.turnId === request.turnId,
          );
        if (!question || question.supported !== true || !Array.isArray(question.questions))
          throw new Error("unsupported-question");
        if (!request.answers) throw new Error("missing-answers");
        params = managedAnswerPayload(question.questions, request.answers);
        responseId = questionId;
        method = "";
      }

      await runner.bridge.flush();
      const dispatchRunner = runner;
      // Read the live state synchronously at the write boundary; an awaited snapshot can
      // become stale before its caller resumes. Rejected writes must remain undispatched.
      const assertDispatchable = () => {
        this.#assertOpen();
        const latest = readManagedRecords(this.dataDir, this.store).find(
          (item) => item.id === request.sessionId,
        );
        if (
          this.#managedRunners.get(request.sessionId) !== dispatchRunner ||
          !dispatchRunner.session.connected ||
          !latest ||
          latest.native_id !== record.native_id ||
          latest.native_id !== dispatchRunner.state.nativeId ||
          latest.workspace_id !== record.workspace_id ||
          latest.released ||
          latest.archived
        )
          throw new Error("session-unavailable");
        this.#assertManagedHome(latest);
        if (pathIdentity(this.#managedCwd(latest)) !== pathIdentity(cwd))
          throw new Error("codex-workspace-mismatch");
        if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
          throw new Error("control-outcome-unconfirmed");
        const currentSnapshot = dispatchRunner.state.snapshot(this.#bootId, true);
        assertActivityAllows(currentSnapshot, request.operation);
        // The just-resumed send may observe late startup/usage notifications.
        // Only observation-only revision changes are safe: preserve exact CAS
        // for identity, native settings, goals, lifecycle and every other field.
        if (
          resumedControlState !== undefined &&
          managedControlState(dispatchRunner.state) === resumedControlState
        )
          request.expectedRevision = Number(currentSnapshot.revision);
        if (
          currentSnapshot.reason ||
          currentSnapshot.revision !== request.expectedRevision ||
          (["send", "compact"].includes(request.operation) &&
            currentSnapshot.sendEnabled !== true) ||
          (request.operation === "stop" &&
            (currentSnapshot.stopEnabled !== true || currentSnapshot.turnId !== request.turnId)) ||
          (["steer", "approve", "answer"].includes(request.operation) &&
            currentSnapshot.turnId !== request.turnId)
        )
          throw new Error("stale-or-disabled-control");
      };
      const beforeDispatch = () => {
        assertDispatchable();
        dispatchManagedCommand(this.dataDir, request.requestId);
      };
      let response: unknown;
      if (responseId !== undefined) {
        beforeDispatch();
        runner.session.respond(responseId, params);
        const until = Date.now() + 12_000;
        while (!runner.state.hasResolvedRequest(request.turnId!, responseId)) {
          await runner.bridge.flush();
          if (runner.state.reason || Date.now() >= until)
            throw new Error("control-outcome-unconfirmed");
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        response = {};
      } else if (request.operation === "settings" && localMutation) {
        assertDispatchable();
        const result = {
          accepted: true,
          completed: true,
          appliesTo: "next-turn",
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
        runner.state.commitSettings(localMutation, () =>
          runner.persist(runner.state, undefined, { requestId: request.requestId, result }),
        );
        return result;
      } else {
        const turnsBefore = runner.state.turnsStarted;
        response = await runner.session.request(method, params, beforeDispatch);
        // thread/compact/start answers before its turn starts (0.163.0). Hold this operation,
        // which the host does not overlap with others, until that turn shows; no send can
        // then start in between. A later start is still followed as usual.
        const until = Date.now() + 5_000;
        while (
          request.operation === "compact" &&
          runner.state.turnsStarted === turnsBefore &&
          !runner.state.reason &&
          Date.now() < until
        ) {
          await runner.bridge.flush();
          if (runner.state.turnsStarted !== turnsBefore) break;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      await runner.bridge.flush();
      if (runner.state.reason) throw new Error("control-outcome-unconfirmed");

      if (
        request.operation === "steer" &&
        (!isObject(response) || response.turnId !== request.turnId)
      )
        throw new Error("unconfirmed-turn");
      if (["queue-add", "queue-update"].includes(request.operation)) {
        const queued = isObject(response) ? response.queuedSubmission : null;
        if (!isObject(queued) || typeof queued.id !== "string")
          throw new Error("unconfirmed-queue-mutation");
        if (request.operation === "queue-add" && queued.clientUserMessageId !== request.requestId)
          throw new Error("unconfirmed-queue-mutation");
      }
      if (request.operation === "queue-delete") {
        const queue = await readManagedQueue(runner.session, record.native_id!, 100);
        if (!queue.complete || queue.data.some((row) => row.id === request.queuedSubmissionId))
          throw new Error("unconfirmed-queue-mutation");
      }
      if (request.operation === "queue-reorder") {
        const queue = await readManagedQueue(runner.session, record.native_id!, 100);
        if (
          !queue.complete ||
          queue.data.map((row) => row.id).join("\0") !==
            (request.queuedSubmissionIds ?? []).join("\0")
        )
          throw new Error("unconfirmed-queue-mutation");
      }

      if (request.operation === "rename") {
        const verified = await runner.session.request("thread/read", {
          threadId: record.native_id,
          includeTurns: false,
        });
        if (
          !isObject(verified) ||
          !isObject(verified.thread) ||
          verified.thread.name !== request.name
        )
          throw new Error("native-name-unconfirmed");
        runner.state.commitManagedMutation({ title: request.name });
        runner.persist(runner.state);
      }
      if (request.operation === "archive") {
        runner.state.commitManagedMutation({ archived: true }, "archived");
        runner.persist(runner.state);
        await this.#closeManagedRunner(request.sessionId, runner);
      }
      if (["goal-set", "goal-pause", "goal-resume"].includes(request.operation)) {
        if (!isObject(response) || !isObject(response.goal))
          throw new Error("native-goal-unconfirmed");
        runner.state.commitManagedMutation({ goal: response.goal });
        runner.persist(runner.state);
      }
      if (request.operation === "goal-clear") {
        if (runner.state.record.goal != null) throw new Error("native-goal-unconfirmed");
        runner.persist(runner.state);
      }

      if (request.operation === "send") {
        if (
          !isObject(response) ||
          !isObject(response.turn) ||
          typeof response.turn.id !== "string" ||
          response.turn.status !== "inProgress"
        )
          throw new Error("unconfirmed-turn");
        if (runner.state.turnId === null && runner.state.revision === request.expectedRevision)
          runner.state.acceptStartedTurn(response.turn.id, request.expectedRevision);
        runner.written = true;
        runner.persist(runner.state);
      }
      const result = {
        accepted: true,
        completed: !["send", "stop", "steer", "compact"].includes(request.operation),
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId)) {
        runner.state.fail("control-outcome-unconfirmed");
        try {
          runner.persist(runner.state);
        } catch {
          // Preserve the ledger snapshot when another writer has advanced it.
        }
        return {
          accepted: false,
          completed: false,
          controlOutcome: "unknown",
          reason: "control-outcome-unconfirmed",
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
      }
      const result = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        error: error instanceof Error ? error.message : "control-preflight-rejected",
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  async #codexFollowerSettingsFeature(record: ManagedRecord, controls: boolean) {
    if (!controls) return { available: false, reason: "control-disabled" };
    const follower = this.#attachedCodexFollower(record);
    if (!follower) return { available: false, reason: "follower-operation-unverified" };
    const { reason } = await this.#codexFollowerSettingsAccess(record, follower);
    return reason ? { available: false, reason } : { available: true };
  }

  async #codexFollowerSettingsAccess(record: ManagedRecord, follower: CodexFollowerRecord) {
    const unavailable = (reason: string) => ({ models: [], effortWritable: false, reason });
    const state = follower.bridge.selectedState;
    const executable = follower.bridge.connection.settingsCatalogExecutable;
    if (!state || !follower.bridge.supportsThreadSettings || !executable)
      return unavailable("follower-operation-unverified");
    const settings = state.nativeModelSettings();
    if (!settings) return unavailable("follower-operation-unverified");
    const revision = state.revision;
    try {
      const { home, cwd, catalogKey } = this.#codexFollowerSettingsTarget(record, follower, state);
      const [observed, models] = await Promise.all([
        follower.bridge.readModelSettings(),
        this.#followerSettingsCatalog.read(catalogKey, () =>
          this.#readCodexFollowerCatalog(executable, home, cwd, settings.modelProvider),
        ),
      ]);
      if (
        follower.bridge.selectedState !== state ||
        state.revision !== revision ||
        this.#attachedCodexFollower(record) !== follower ||
        !models.length ||
        !sameFollowerModelSettings(observed, settings)
      )
        return unavailable("follower-operation-unverified");
      const tier = normalizeManagedTier(state.nativeServiceTier());
      return {
        models: tier
          ? models.filter(
              (model) => model.id === settings.model || model.serviceTiers.includes(tier),
            )
          : models,
        effortWritable: models.some(
          (model) => model.id === settings.model && model.efforts.length > 0,
        ),
        reason: this.#codexFollowerSettingsBlocked(record, state),
      };
    } catch {
      return unavailable("follower-operation-unverified");
    }
  }

  #codexFollowerSettingsBlocked(record: ManagedRecord, state: CodexFollowerState): string | null {
    if (managedSessionHasUnknownCommands(this.dataDir, record.id))
      return "control-outcome-unconfirmed";
    if (record.snapshot?.settingsStaged === true) return "codex-owner-busy";
    if (state.activity) return "session-compacting";
    if (state.status === "unsupported") return "follower-operation-unverified";
    return state.canSetNextTurnModel() ? null : "session-busy";
  }

  #codexFollowerSettingsTarget(
    record: ManagedRecord,
    follower: CodexFollowerRecord,
    state: CodexFollowerState,
  ) {
    const executable = follower.bridge.connection.settingsCatalogExecutable;
    const settings = state.nativeModelSettings();
    const home = this.#assertManagedHome(record);
    const cwd = this.#managedCwd(record);
    if (
      record.archived ||
      !settings ||
      !executable ||
      this.#attachedCodexFollower(record) !== follower ||
      follower.bridge.selectedState !== state ||
      state.conversationId !== record.native_id ||
      follower.workspaceId !== record.workspace_id ||
      follower.bridge.connection.endpoint !== path.join(home, "ipc", "ipc.sock") ||
      realpathSync(executable) !== executable ||
      pathIdentity(this.#checkedCodexDirectory(settings.cwd)) !== pathIdentity(cwd)
    )
      throw new Error("session-state-unavailable");
    return {
      executable,
      settings,
      home,
      cwd,
      catalogKey: JSON.stringify([codexCatalogKey(executable, home, cwd), settings.modelProvider]),
    };
  }

  async #updateCodexFollowerSettings(
    request: SettingsControl,
    fingerprint: string,
    record: ManagedRecord,
    follower: CodexFollowerRecord,
  ): Promise<Record<string, unknown>> {
    const receipt = {
      sessionId: record.id,
      requestId: request.requestId,
      runtimeBootId: this.#bootId,
    };
    let claimed = false;
    let dispatched = false;
    const evidence = {
      ...codexCommandEvidence(request, record.workspace_id),
      executionMode: "codex-follower",
    };
    try {
      if (
        !follower.bridge.supportsThreadSettings ||
        request.serviceTier !== undefined ||
        request.policyId !== undefined ||
        request.permissionMode !== undefined ||
        request.mode !== undefined ||
        request.resetDefaults ||
        (request.model === undefined && request.effort === undefined)
      )
        throw new Error("follower-operation-unverified");
      const previous = claimManagedCommand(
        this.dataDir,
        request.requestId,
        record.id,
        fingerprint,
        request.deviceId ?? null,
        evidence,
      );
      if (previous) return previous;
      claimed = true;
      const release = acquireCodexFollowerOperationLock(
        follower.bridge.connection.endpoint,
        follower.nativeId,
      );
      try {
        const state = await follower.bridge.observeLive();
        const target = this.#codexFollowerSettingsTarget(record, follower, state);
        const check = () => {
          this.#assertOpen();
          const latest =
            readManagedRecords(this.dataDir, this.store).find((item) => item.id === record.id) ??
            record;
          const blocked = this.#codexFollowerSettingsBlocked(latest, state);
          if (blocked) throw new Error(blocked);
          const summary = this.store.sessions.get(record.id);
          if (
            !summary ||
            summary.agent !== "codex" ||
            summary.archived ||
            summary.sidechain ||
            summary.workspace_id !== record.workspace_id ||
            this.#managedRunners.get(record.id)?.session.connected ||
            this.#codexWriterOwnership(latest, true) !== "codex-owner-busy" ||
            request.expectedSettingsScope !== state.settingsWriteScope ||
            state.revision !== request.expectedRevision ||
            this.#codexFollowerSettingsTarget(latest, follower, state).catalogKey !==
              target.catalogKey
          )
            throw new Error("stale-or-disabled-control");
        };
        check();
        const { executable, home, cwd, settings } = target;
        const models = await this.#readCodexFollowerCatalog(
          executable,
          home,
          cwd,
          settings.modelProvider,
        );
        const model = models.find((item) => item.id === (request.model ?? settings.model));
        if (!model) throw new Error("unsupported-model");
        const tier = normalizeManagedTier(state.nativeServiceTier());
        if (model.id !== settings.model && tier && !model.serviceTiers.includes(tier))
          throw new Error("unsupported-service-tier");
        const effort =
          request.effort !== undefined
            ? request.effort
            : model.id === settings.model ||
                (settings.effort !== null && model.efforts.includes(settings.effort))
              ? settings.effort
              : model.defaultEffort;
        if (
          (request.effort === null && model.efforts.length === 0) ||
          (effort !== null && !model.efforts.includes(effort))
        )
          throw new Error("unsupported-effort");
        check();
        const next = { model: model.id, effort, modelProvider: settings.modelProvider };
        const settingsEvidence = {
          ...evidence,
          followerSettings: {
            model: next.model,
            reasoningEffort: next.effort,
            modelProvider: next.modelProvider,
            nativeId: state.conversationId,
            ownerClientId: state.ownerClientId,
            cwd,
            home,
          },
        };
        const unchanged = sameFollowerModelSettings(settings, next);
        if (unchanged) {
          if (!sameFollowerModelSettings(await follower.bridge.readModelSettings(), next))
            throw new Error("stale-or-disabled-control");
          check();
        }
        const applied =
          unchanged ||
          (await follower.bridge.updateModelSettings({
            expectedScope: state.settingsWriteScope,
            expectedRevision: request.expectedRevision,
            current: settings,
            next,
            onDispatch: () => {
              check();
              dispatchManagedCommand(this.dataDir, request.requestId);
              dispatched = true;
            },
            onApplied: () =>
              acknowledgeDispatchedManagedCommand(
                this.dataDir,
                request.requestId,
                settingsEvidence,
              ),
          }));
        if (applied) {
          const latest = await this.#inactiveRecord(record.id);
          const confirmed = this.#codexFollowerSettingsTarget(latest, follower, state);
          if (
            this.#codexWriterOwnership(latest, true) !== "codex-owner-busy" ||
            confirmed.catalogKey !== target.catalogKey ||
            !sameFollowerModelSettings(confirmed.settings, next)
          )
            throw new Error("native-settings-unconfirmed");
        }
        const result = applied
          ? { ...receipt, accepted: true, completed: true, appliesTo: "next-turn" }
          : {
              ...receipt,
              accepted: false,
              completed: false,
              controlOutcome: "not-dispatched",
              reason: "stale-or-disabled-control",
            };
        finishManagedCommand(this.dataDir, request.requestId, result);
        this.publishConversationEvent?.(record.id, "invalidate", {
          domains: ["settings", "receipts"],
        });
        return result;
      } finally {
        release();
      }
    } catch (error) {
      const result = {
        ...receipt,
        accepted: false,
        completed: false,
        controlOutcome: dispatched ? "unknown" : "not-dispatched",
        reason: dispatched
          ? "control-outcome-unconfirmed"
          : error instanceof Error
            ? error.message
            : "control-preflight-rejected",
      };
      if (claimed && !dispatched) finishManagedCommand(this.dataDir, request.requestId, result);
      if (dispatched)
        this.publishConversationEvent?.(record.id, "invalidate", {
          domains: ["settings", "receipts"],
        });
      return result;
    }
  }

  async #codexFollowerControl(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    follower: CodexFollowerRecord,
    workspaceId: string,
    prepared = false,
  ): Promise<Record<string, unknown>> {
    let dispatched = false;
    try {
      if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
        throw new Error("stale-or-disabled-control");
      if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      const state = await follower.bridge.observeLive();
      if (state.revision !== request.expectedRevision) throw new Error("stale-or-disabled-control");
      const live = state.live(true);
      assertActivityAllows(live, request.operation);
      const turnId = request.turnId;
      let method: string;
      let params: Record<string, unknown>;
      let responseId: string | number | null = null;

      if (request.operation === "send") {
        if (live.sendEnabled !== true) throw new Error("session-busy");
        const input = followerInput(request.input, request.text, request.resourceRefs);
        method = "thread-follower-start-turn";
        params = {
          conversationId: state.conversationId,
          turnStart: {
            request: {
              threadId: state.conversationId,
              clientUserMessageId: request.requestId,
              input,
            },
          },
        };
      } else if (request.operation === "stop") {
        if (!turnId || state.activeTurn() !== turnId || live.stopEnabled !== true)
          throw new Error("stale-turn");
        method = "thread-follower-interrupt-turn";
        params = {
          conversationId: state.conversationId,
          mode: "user-stop",
          expectedTurnId: turnId,
        };
      } else if (request.operation === "approve") {
        if (!turnId || state.activeTurn() !== turnId) throw new Error("missing-approval");
        const approvalId = request.approvalId;
        if (approvalId === undefined) throw new Error("missing-approval");
        const approval = state
          .approvals(true)
          .find(
            (item) =>
              managedRequestKey(item.requestId) === managedRequestKey(approvalId) &&
              item.turnId === turnId,
          );
        if (!approval || approval.supported !== true) throw new Error("unsupported-approval");
        const decision = request.nativeDecision ?? request.decision;
        if (decision === undefined) throw new Error("missing-decision");
        const options = Array.isArray(approval.decisionOptions)
          ? approval.decisionOptions
          : Array.isArray(approval.availableDecisions)
            ? approval.availableDecisions
            : [];
        if (
          !options.some(
            (option) =>
              stableJson(isObject(option) ? option.decision : option) === stableJson(decision),
          )
        )
          throw new Error("unsupported-decision");
        responseId = approvalId;
        method =
          approval.method === "item/commandExecution/requestApproval"
            ? "thread-follower-command-approval-decision"
            : approval.method === "item/fileChange/requestApproval"
              ? "thread-follower-file-approval-decision"
              : "";
        if (!method) throw new Error("unsupported-approval");
        params = { conversationId: state.conversationId, requestId: approvalId, decision };
      } else {
        throw new Error("follower-operation-unverified");
      }

      const evidence = {
        ...codexCommandEvidence(request, workspaceId),
        nativeRequestId: responseId,
        executionMode: "codex-follower",
      };
      if (prepared) annotateManagedCommand(this.dataDir, request.requestId, evidence);
      const claimed = prepared
        ? null
        : claimManagedCommand(
            this.dataDir,
            request.requestId,
            request.sessionId,
            fingerprint,
            request.deviceId ?? null,
            evidence,
          );
      if (claimed) return claimed;

      const release = acquireCodexFollowerOperationLock(
        follower.bridge.connection.endpoint,
        state.conversationId,
      );
      try {
        dispatched = false;
        const result = await follower.bridge.mutate(
          method,
          params,
          request.expectedRevision,
          () => {
            dispatchManagedCommand(this.dataDir, request.requestId);
            dispatched = true;
          },
        );
        if (request.operation === "stop") {
          if (!isObject(result) || result.ok !== true || result.interruptedTurnId !== turnId)
            throw new Error("unconfirmed-turn");
        }
        const accepted = {
          accepted: true,
          completed: !["send", "stop"].includes(request.operation),
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
        finishManagedCommand(this.dataDir, request.requestId, accepted);
        return accepted;
      } finally {
        release();
      }
    } catch (error) {
      const unknown = managedSessionHasUnknownCommands(this.dataDir, request.sessionId);
      const result = unknown
        ? {
            accepted: false,
            completed: false,
            controlOutcome: "unknown",
            reason: "control-outcome-unconfirmed",
            sessionId: request.sessionId,
            requestId: request.requestId,
            runtimeBootId: this.#bootId,
          }
        : {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            error: error instanceof Error ? error.message : "control-preflight-rejected",
            reason: error instanceof Error ? error.message : "control-preflight-rejected",
            sessionId: request.sessionId,
            requestId: request.requestId,
            runtimeBootId: this.#bootId,
          };
      if (!unknown && dispatched === false) {
        try {
          finishManagedCommand(this.dataDir, request.requestId, result);
        } catch {
          // A preflight may fail before the durable command was claimed.
        }
      }
      return result;
    }
  }

  async #inactiveFork(
    request: z.infer<typeof managedControlSchema>,
    source: ManagedRecord,
    fingerprint: string,
  ) {
    const checked = await this.#preflight.check();
    const reason =
      checked.reason ??
      (this.#managedRunners.get(source.id)?.retiring ? "control-outcome-unconfirmed" : null) ??
      (source.archived
        ? "session-archived"
        : managedSessionHasUnknownCommands(this.dataDir, source.id)
          ? "control-outcome-unconfirmed"
          : request.expectedRevision !==
              (this.#attachedCodexFollower(source)?.bridge.selectedState?.revision ??
                source.snapshot?.revision ??
                0)
            ? "stale-or-disabled-control"
            : null);
    if (reason)
      return {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        reason,
        requestId: request.requestId,
        sessionId: source.id,
        runtimeBootId: this.#bootId,
      };
    return this.#managedFork(request, source, undefined, fingerprint);
  }

  async #managedFork(
    request: z.infer<typeof managedControlSchema>,
    source: ManagedRecord,
    sourceRunner: ManagedRunner | undefined,
    fingerprint: string,
  ) {
    if (this.#managedRunners.size >= 8) throw new Error("managed-session-limit");
    if (sourceRunner) {
      const sourceSnapshot = await sourceRunner.bridge.snapshot(this.#bootId, true);
      assertActivityAllows(sourceSnapshot, "fork");
      if (sourceSnapshot.status !== "idle" || sourceSnapshot.reason)
        throw new Error("session-busy");
    }
    const nativeId = source.native_id;
    if (!nativeId) throw new Error("native-session-unconfirmed");
    const cwd = this.#managedCwd(source);
    const params = { threadId: nativeId, includeTurns: true };
    const history = sourceRunner
      ? await sourceRunner.session.request("thread/read", params)
      : await this.#codex.request(
          (await this.#preflight.check()).executable!,
          cwd,
          this.#assertManagedHome(source),
          "thread/read",
          params,
        );
    if (!isObject(history) || !isObject(history.thread) || history.thread.id !== nativeId)
      throw new Error("thread-identity-mismatch");
    const turns = Array.isArray(history.thread.turns) ? history.thread.turns.filter(isObject) : [];
    if (
      typeof history.thread.cwd !== "string" ||
      !within(canonicalize(history.thread.cwd), canonicalize(source.workspace))
    )
      throw new Error("codex-context-outside-workspace");
    const last = turns
      .filter((turn) => ["completed", "interrupted", "failed"].includes(String(turn.status)))
      .at(-1);
    if (!last) throw new Error("no-completed-turn");
    if (typeof last.id !== "string") throw new Error("no-completed-turn");
    const rejectSourceSettings = (reason: string) => {
      const claimed = claimManagedCommand(
        this.dataDir,
        request.requestId,
        source.id,
        fingerprint,
        request.deviceId ?? null,
        {
          operation: "fork",
          turnId: null,
          nativeRequestId: null,
          runtimeBootId: request.runtimeBootId,
          expectedRevision: request.expectedRevision,
          executionMode: "codex-managed",
          workspaceId: source.workspace_id,
        },
      );
      if (claimed) return claimed;
      const result = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        reason,
        sessionId: source.id,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    };
    const sourceModel = boundedText(history.thread.model, 256) ?? boundedText(source.model, 256);
    if (!sourceModel) return rejectSourceSettings("native-model-unconfirmed");
    const nativeSettings = isObject(source.native_settings) ? source.native_settings : {};
    // Native null means unset or unavailable, and app-server cannot accept a null
    // config override. Only a matching source selection can safely fill that gap.
    const sourceEffort =
      boundedText(history.thread.reasoningEffort, 64) ??
      (source.model === sourceModel ? boundedText(source.effort, 64) : null) ??
      (nativeSettings.model === sourceModel ? boundedText(nativeSettings.effort, 64) : null);
    if (!sourceEffort) return rejectSourceSettings("native-effort-unconfirmed");
    const childId = createHash("sha256").update(`managed-fork:${request.requestId}`).digest("hex");
    openManagedLedger(this.dataDir, true)?.close();
    let release: (() => void) | undefined = acquireManagedSessionLease(this.dataDir, childId);
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      source.id,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: "fork",
        turnId: null,
        nativeRequestId: null,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: "codex-managed",
        workspaceId: source.workspace_id,
      },
    );
    if (claimed) {
      release();
      return claimed;
    }
    const child: ManagedRecord = {
      ...structuredClone(source),
      id: childId,
      source_session_id: source.id,
      native_id: null,
      model: sourceModel,
      effort: sourceEffort,
      adopted: false,
      released: false,
      archived: false,
      created_at: new Date().toISOString(),
      snapshot: { status: "starting", revision: 0 },
    };
    saveManagedRecord(this.dataDir, child as unknown as Record<string, unknown>);
    let dispatched = false;
    let failureFinalized = false;
    let runner: ManagedRunner | undefined;
    const finalizeFailure = (error: unknown, ownsLease: boolean) => {
      if (failureFinalized) return;
      if (ownsLease) this.#recordStartupFailure(childId, error, dispatched, "unsupported");
      failureFinalized = true;
    };
    try {
      runner = await this.#attachManagedRunner(
        child,
        canonicalize(source.workspace),
        this.#assertManagedHome(source),
        release,
        () => {
          if (sourceRunner) {
            const current = sourceRunner.state.snapshot(this.#bootId, true);
            assertActivityAllows(current, "fork");
            if (current.status !== "idle" || current.reason) throw new Error("session-busy");
          } else if (managedSessionHasUnknownCommands(this.dataDir, source.id))
            throw new Error("control-outcome-unconfirmed");
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
        { nativeId, lastTurnId: last.id },
        finalizeFailure,
      );
      release = undefined;
      this.#managedRunners.set(childId, runner);
      const live = await runner.bridge.snapshot(this.#bootId, true);
      const result = {
        accepted: true,
        completed: true,
        sessionId: childId,
        sourceSessionId: source.id,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        live,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      finalizeFailure(
        error,
        release !== undefined ||
          (runner !== undefined &&
            this.#managedRunners.get(childId) === runner &&
            !runner.leaseReleased),
      );
      if (!this.#managedRunners.has(childId)) release?.();
      const definite = !dispatched || codexWriterBusy(error);
      const result = {
        sessionId: childId,
        sourceSessionId: source.id,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  async #managedInput(
    request: z.infer<typeof managedControlSchema>,
    record: ManagedRecord,
    runner: ManagedRunner,
  ): Promise<Record<string, unknown>[]> {
    const rows = request.input
      ? [...request.input]
      : request.text !== undefined
        ? [{ type: "text", text: request.text }]
        : [];
    if (request.input && request.text !== undefined) throw new Error("ambiguous-input");
    if (rows.length === 0 || rows.length > 11) throw new Error("invalid-input-count");
    for (const reference of request.resourceRefs ?? []) {
      if (reference.kind === "skill" && reference.id)
        rows.push({ type: "skill", id: reference.id });
      else if (
        (reference.kind === "file" || reference.kind === "directory") &&
        reference.relativePath
      )
        rows.push({
          type: "computerPath",
          kind: reference.kind,
          workspaceRelativePath: reference.relativePath,
        });
      else throw new Error("invalid-resource-reference");
    }
    if (rows.length > 43) throw new Error("invalid-input-count");

    let textBytes = 0;
    const result: Record<string, unknown>[] = [];
    const workspace = canonicalize(record.workspace);
    const cwd = this.#managedCwd(record);
    for (const value of rows) {
      if (!isObject(value)) throw new Error("unsupported-input-type");
      if (value.type === "text") {
        if (
          typeof value.text !== "string" ||
          !value.text.trim() ||
          Buffer.byteLength(value.text) > 16_384
        )
          throw new Error("invalid-text-input");
        textBytes += Buffer.byteLength(value.text);
        result.push({ type: "text", text: value.text });
      } else if (value.type === "localImage") {
        if (
          typeof value.path !== "string" ||
          !path.isAbsolute(value.path) ||
          value.path.split(path.sep).includes("..")
        )
          throw new Error("invalid-image-path");
        const imagePath = canonicalize(value.path);
        const image = statSync(imagePath);
        if (!image.isFile()) throw new Error("attachment-unavailable");
        if (image.size > 25 * 1024 * 1024) throw new Error("attachment-too-large");
        result.push({ type: "localImage", path: imagePath });
      } else if (value.type === "computerPath") {
        if (typeof value.workspaceRelativePath !== "string")
          throw new Error("invalid-resource-path");
        const relative = value.workspaceRelativePath;
        if (
          !relative ||
          Buffer.byteLength(relative, "utf8") > 4096 ||
          path.isAbsolute(relative) ||
          relative.includes("\0") ||
          relative.split(/[\\/]/).some((part) => part === "..")
        )
          throw new Error("invalid-resource-path");
        const resource = canonicalize(path.join(workspace, relative));
        if (!within(resource, workspace)) throw new Error("resource-outside-workspace");
        const info = statSync(resource);
        if (
          (value.kind === "file" && !info.isFile()) ||
          (value.kind === "directory" && !info.isDirectory()) ||
          !["file", "directory"].includes(String(value.kind))
        )
          throw new Error("resource-kind-mismatch");
        const name = path.basename(resource);
        if (!name) throw new Error("invalid-resource-name");
        result.push({ type: "mention", name, path: resource });
      } else if (value.type === "skill") {
        if (typeof value.id !== "string") throw new Error("invalid-skill-id");
        const listed = await runner.session.request("skills/list", {
          cwds: [cwd],
          forceReload: false,
        });
        const data = isObject(listed) && Array.isArray(listed.data) ? listed.data : [];
        let match: { name: string; path: string } | undefined;
        for (const entry of data) {
          if (!isObject(entry) || typeof entry.cwd !== "string") continue;
          if (pathIdentity(canonicalize(entry.cwd)) !== pathIdentity(cwd)) continue;
          if (!Array.isArray(entry.skills)) continue;
          for (const skill of entry.skills) {
            if (!isObject(skill) || typeof skill.path !== "string") continue;
            const skillPath = canonicalize(skill.path);
            const id = createHash("sha256").update(Buffer.from(skillPath, "utf8")).digest("hex");
            if (id === value.id && skill.enabled === true && typeof skill.name === "string")
              match = { name: skill.name, path: skillPath };
          }
        }
        if (!match) throw new Error("skill-unavailable");
        result.push({ type: "skill", ...match });
      } else throw new Error("unsupported-input-type");
    }
    if (textBytes > 128 * 1024) throw new Error("input-too-large");
    return result;
  }

  #recordStartupFailure(
    id: string,
    error: unknown,
    dispatched: boolean,
    definiteStatus: "released" | "unsupported",
  ): void {
    const definite = !dispatched || codexWriterBusy(error);
    const current = readManagedRecords(this.dataDir, this.store).find((item) => item.id === id);
    if (!current) return;
    current.snapshot = {
      ...(isObject(current.snapshot) ? current.snapshot : {}),
      status: definite ? definiteStatus : "outcome-unknown",
      reason: definite
        ? codexWriterBusy(error)
          ? "codex-owner-busy"
          : error instanceof Error
            ? error.message
            : "codex-app-server-unavailable"
        : "control-outcome-unconfirmed",
    };
    if (definite) current.released = true;
    saveManagedRecord(this.dataDir, current as unknown as Record<string, unknown>);
  }

  /**
   * Gives a managed Codex thread that has no name the title Codex's terminal client would give
   * it (`codex-thread-title.ts`), from its first message: at most once per thread while AgentKib
   * runs, in the background of the turn that started. Any failure leaves Codex's own title.
   */
  #nameCodexThread(
    session: CodexAppServerSession,
    threadId: string,
    cwd: string,
    observedMessage: string,
  ): void {
    if (this.#shuttingDown || this.#titleAttempts.has(threadId)) return;
    const attempt = { renamed: false };
    this.#titleAttempts.set(threadId, attempt);
    /** The thread while Codex says it has no name; one it says nothing about is left alone. */
    const unnamed = async () => {
      const read = await session.request("thread/read", { threadId, includeTurns: false });
      const thread = isObject(read) && isObject(read.thread) ? read.thread : null;
      const nameless =
        thread?.id === threadId &&
        (thread.name === null || (typeof thread.name === "string" && !thread.name.trim()));
      return nameless && !attempt.renamed && !this.#shuttingDown ? thread : null;
    };
    void (async () => {
      const thread = await unnamed();
      if (!thread) return;
      // Codex's preview is the thread's first message; a new thread may not show it yet.
      const message =
        (typeof thread.preview === "string" ? thread.preview.trim() : "") || observedMessage.trim();
      if (!message) return;
      const choice = threadTitleModel(
        await session.request("model/list", { limit: 100 }),
        typeof thread.model === "string" ? thread.model : null,
      );
      if (!choice || this.#shuttingDown) return;
      const title = await this.#titleThreads.generate(session, {
        threadId,
        cwd,
        message,
        ...choice,
      });
      // The person, or a Codex client, may have named the thread meanwhile.
      if (!title || !(await unnamed()) || attempt.renamed) return;
      await session.request("thread/name/set", { threadId, name: title });
      if (!this.#shuttingDown) this.catalogChanged?.();
    })().catch(() => undefined);
  }

  async #attachManagedRunner(
    record: ManagedRecord,
    workspace: string,
    home: string,
    release: (() => void) | undefined,
    dispatch?: () => void,
    fork?: { nativeId: string; lastTurnId: string },
    onFailure?: (error: unknown, ownsLease: boolean) => void,
  ): Promise<ManagedRunner> {
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const cwd = this.#managedCwd(record);
    // Startup can outlive the last subscriber; retain the observation before any await.
    const observedAtStart =
      this.#controlSessions.get(record.id)?.observed === true ||
      this.isSessionObserved?.(record.id) === true;
    const checked = await this.#preflight.check();
    const executable = checked.executable;
    if (!executable || checked.reason) throw new Error(checked.reason ?? "codex-cli-unavailable");
    this.#assertOpen();
    const nativeId = record.native_id ?? null;
    const state = new ManagedCodexState(record, record.snapshot?.revision ?? 0);
    state.showUsageLimit(usageLimitView(this.#codexLimits.get(record.id)?.limit, this.#bootId));
    const persist = createManagedSnapshotWriter(this.dataDir, record);
    let previousStreamText = "";
    let startingRunner: ManagedRunner | undefined;
    const captureRunner = (session: CodexAppServerSession) => {
      if (startingRunner) return;
      // A Project Agent's turns without the person count toward its limit, and one that leads
      // only later is followed from now on.
      const ownTurns = new CodexLeadTurns();
      session.on("notification", (value: unknown) => {
        // The temporary thread that names this one runs no turn of the session's.
        if (this.#titleThreads.owns(value)) return;
        const turnId = ownTurns.observe(value);
        if (turnId) this.#observeLane((observer) => observer.ownTurn?.(record.id, turnId));
        // A user message in the session's thread: one without a name gets a title once.
        const message = codexUserMessageText(value, state.nativeId);
        if (message !== null) this.#nameCodexThread(session, state.nativeId!, cwd, message);
      });
      const bridge = new ManagedCodexEventBridge(
        session,
        state,
        persist,
        (value, result, current) => {
          const live = current.snapshot(this.#bootId, session.connected);
          const envelope = isObject(value) ? value : {};
          const method = typeof envelope.method === "string" ? envelope.method : "";
          const params = isObject(envelope.params) ? envelope.params : {};
          if (
            method === "turn/completed" &&
            isObject(params.turn) &&
            typeof params.turn.id === "string" &&
            record.native_id
          ) {
            const turn = params.turn;
            const outcome = codexTurnMeta(turn)?.outcome;
            new ReadStateLedger(this.dataDir).record(
              conversationReadKey("codex", record.home, record.native_id),
              {
                id: `turn:${turn.id}`,
                turnId: String(turn.id),
                itemId:
                  typeof result.event?.id === "string" && !isCodexTurnEndEvent(result.event)
                    ? result.event.id
                    : null,
                outcome: outcome === "aborted" ? "cancelled" : (outcome ?? "ended"),
                completedAt: new Date().toISOString(),
              },
            );
            this.catalogChanged?.();
          }
          if (method === "turn/completed" && isObject(params.turn))
            this.#codexTurnLimit(record.id, session, current, params.turn);
          // Also for a session created by this runner, whose native ID the record does not hold
          // yet: a lead hears of its new worker's first turn too.
          if (
            method === "turn/completed" &&
            isObject(params.turn) &&
            typeof params.turn.id === "string"
          ) {
            const turn = params.turn;
            const outcome = codexTurnMeta(turn)?.outcome;
            this.#observeLane((observer) =>
              observer.turnEnded(
                record.id,
                String(turn.id),
                outcome === "aborted" ? "cancelled" : (outcome ?? "ended"),
                codexTurnMeta(turn)?.duration_ms ?? null,
              ),
            );
          }
          if (live.status === "awaiting-approval" || live.status === "waiting-input")
            this.#observeLane((observer) =>
              observer.waiting(
                record.id,
                typeof live.turnId === "string" ? live.turnId : null,
                String(live.status),
              ),
            );
          if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
            const delta = typeof params.delta === "string" ? params.delta : "";
            const streamText = typeof live.streamText === "string" ? live.streamText : "";
            if (delta && streamText === previousStreamText + delta) {
              this.publishConversationEvent?.(
                record.id,
                "text-delta",
                {
                  text: delta,
                  offset: previousStreamText.length,
                  ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
                  ...(typeof params.itemId === "string" ? { itemId: params.itemId } : {}),
                  ephemeral: true,
                },
                live,
              );
            }
            previousStreamText = streamText;
            return;
          }
          previousStreamText = typeof live.streamText === "string" ? live.streamText : "";
          if (result.event) {
            this.publishConversationEvent?.(record.id, "item-upsert", result.event, live);
            // turn/completed returns the last row with its duration; subscribers
            // still need the idle state that the same notification produced.
            if (method !== "turn/completed") return;
          }
          this.publishConversationEvent?.(record.id, "state", live, live);
        },
        // Its live state, history, lane reports and usage limits are the session's thread's only.
        (value) => this.#titleThreads.owns(value),
      );
      startingRunner = {
        session,
        state,
        bridge,
        persist,
        release: release ?? (() => {}),
        planVerified: false,
        queueVerified: null,
        idleSince: null,
        observed: observedAtStart,
      };
      this.#startingRunners.set(record.id, startingRunner);
    };
    try {
      const session = await CodexAppServerSession.start(
        executable,
        cwd,
        home,
        { ...process.env, ...this.environment },
        undefined,
        captureRunner,
      );
      captureRunner(session);
      // The version check above may have tried a CLI whose `--version` it could not read;
      // the release the server reports settles it before the first turn.
      const served = codexServerVersion(session.userAgent);
      if (served && !codexReleaseSupportsWriterLock(served))
        throw new Error("codex-cli-version-too-old");
      const runner = startingRunner!;
      const bridge = runner.bridge;
      this.#assertOpen();
      const modelsResult = await session.request("model/list", { limit: 100 });
      const models = projectManagedModels(modelsResult);
      // Plan uses the native presets. Their turn/start mapping and the confirming
      // thread/settings/updated were checked with CLI 0.163.0; a CLI without them keeps
      // the mode unavailable rather than failing the session.
      try {
        runner.planVerified =
          verifiedCollaborationModes(await session.request("collaborationMode/list", {})).length ===
          2;
      } catch (error) {
        if (!session.connected) throw error;
        runner.planVerified = false;
      }
      if (!nativeId && !fork && record.mode === "plan" && !runner.planVerified)
        throw new Error("native-collaboration-modes-unavailable");
      const requestedModel = record.model ?? null;
      const requestedEffort = record.effort ?? null;
      const stagedModelSettings = hasStagedCodexModelSettings(record);
      const clearingEffort =
        requestedEffort === null &&
        ((isObject(record.native_settings) && typeof record.native_settings.effort === "string") ||
          (stagedModelSettings && record.effort === null));
      // Creating a new thread is an explicit model choice. Attaching an existing
      // thread or its fork must also work when its inherited model left the picker;
      // send and explicit settings changes validate their own model selection.
      if ((!nativeId && !fork) || stagedModelSettings)
        validateManagedModelSelection(record, models);
      const tier = record.service_tier ?? null;

      let goal: Record<string, unknown> | null = null;
      if (nativeId) {
        const goalResult = await session.request("thread/goal/get", { threadId: nativeId });
        goal = isObject(goalResult) && isObject(goalResult.goal) ? goalResult.goal : null;
        if (goal?.status === "active") throw new Error("pause-original-goal-before-handoff");
      }

      const params = managedResumeParams(record, cwd);
      // A Project Agent's worker tools: an MCP server for this thread only, never the user's
      // Codex configuration.
      const leadUrl = this.#leadEndpoint
        ? await this.#leadEndpoint(record.id).catch(() => null)
        : null;
      if (leadUrl)
        (params.config as Record<string, unknown>)["mcp_servers.agentkib_workers.url"] = leadUrl;
      if (startingRunner) startingRunner.leadUrl = leadUrl;
      if (requestedModel) params.model = requestedModel;
      if (requestedEffort)
        (params.config as Record<string, unknown>).model_reasoning_effort = requestedEffort;
      if (
        tier ||
        isObject(record.native_settings) ||
        (record.service_tier === null && stagedModelSettings)
      )
        params.serviceTier = tier;
      if (fork) {
        params.threadId = fork.nativeId;
        params.lastTurnId = fork.lastTurnId;
        params.deferGoalContinuation = true;
      } else if (nativeId) params.threadId = nativeId;
      const beforeDispatch = () => {
        this.#assertOpen();
        if (pathIdentity(this.#managedCwd(record)) !== pathIdentity(cwd))
          throw new Error("codex-workspace-mismatch");
        dispatch?.();
      };
      const readRevision = state.revision;
      const responseValue = await session.request(
        fork ? "thread/fork" : nativeId ? "thread/resume" : "thread/start",
        params,
        beforeDispatch,
      );
      if (startingRunner) startingRunner.written = Boolean(fork || nativeId);
      if (!isObject(responseValue) || !isObject(responseValue.thread))
        throw new Error("native-session-unconfirmed");
      const response = responseValue;
      const nativeThread = response.thread as Record<string, unknown>;
      const attachedId = nativeThread.id;
      if (
        typeof attachedId !== "string" ||
        attachedId.length === 0 ||
        (nativeId && attachedId !== nativeId)
      )
        throw new Error("native-session-unconfirmed");
      (state.record as ManagedRecord).native_id = attachedId;
      if (
        typeof response.cwd !== "string" ||
        pathIdentity(canonicalize(response.cwd)) !== pathIdentity(cwd) ||
        typeof nativeThread.cwd !== "string" ||
        pathIdentity(canonicalize(nativeThread.cwd)) !== pathIdentity(cwd)
      )
        throw new Error("codex-workspace-mismatch");
      verifyManagedPolicy(record, response);
      if (
        Array.isArray(nativeThread.environments) &&
        nativeThread.environments.some((environment: unknown) => {
          const environmentId = isObject(environment)
            ? (environment.id ?? environment.environmentId)
            : null;
          return environmentId !== "local";
        })
      )
        throw new Error("remote-environment-not-supported");
      const model =
        typeof response.model === "string" && response.model.length > 0 ? response.model : null;
      if (!model) throw new Error("native-model-unconfirmed");
      const effort =
        response.reasoningEffort === null || typeof response.reasoningEffort === "string"
          ? response.reasoningEffort
          : undefined;
      if (effort === undefined) throw new Error("native-effort-unconfirmed");
      if (stagedModelSettings) {
        if (requestedModel && model !== requestedModel) throw new Error("native-model-unconfirmed");
        if (requestedEffort && effort !== requestedEffort)
          throw new Error("native-effort-unconfirmed");
      }

      const mutableRecord = state.record as ManagedRecord;
      mutableRecord.model = model;
      // A resume can report the old inherited effort before the pending clear is
      // applied with the verified collaboration mode on the next turn.
      mutableRecord.effort = clearingEffort ? null : effort;
      mutableRecord.service_tier =
        stagedModelSettings && record.service_tier === null
          ? null
          : normalizeManagedTier(response.serviceTier);
      mutableRecord.native_settings = {
        model,
        effort,
        serviceTier: response.serviceTier ?? null,
        approvalPolicy: response.approvalPolicy,
        approvalsReviewer: response.approvalsReviewer,
        sandboxPolicy: response.sandbox,
        // thread/resume reports the effective mode; start and fork apply one with the next turn.
        collaborationMode: isObject(response.collaborationMode) ? response.collaborationMode : null,
      };
      mutableRecord.goal = goal;
      const defaultModel = models.find((entry) => entry.isDefault === true);
      mutableRecord.default_model = defaultModel?.id ?? null;
      mutableRecord.default_effort = defaultModel?.defaultEffort ?? null;
      mutableRecord.default_service_tier = defaultModel?.defaultServiceTier ?? null;
      // Queued messages use thread/queue/*, which 0.148.0 adds after the writer-lock minimum:
      // 0.147.0 answers this read with -32600 "unknown variant" and stays connected. Only a
      // read is tried, since a write to a missing method would leave its outcome unknown.
      // It needs the loaded thread: 0.163.0 cannot list an unloaded one's queue.
      try {
        await session.request("thread/queue/list", { threadId: attachedId, limit: 1 });
        runner.queueVerified = true;
      } catch (error) {
        if (!session.connected) throw error;
        runner.queueVerified = false;
      }
      await bridge.flush();
      this.#assertOpen();
      if (mutableRecord.snapshot) {
        delete mutableRecord.snapshot.settingsStaged;
        delete mutableRecord.snapshot.policyOnlyStaged;
      }
      const hydrated = state.hydrate(nativeThread, true, readRevision);
      persist(state, hydrated.events);
      runner.idleSince = Date.now();
      runner.observed =
        observedAtStart ||
        this.#controlSessions.get(record.id)?.observed === true ||
        this.isSessionObserved?.(record.id) === true;
      this.#startingRunners.delete(record.id);
      return runner;
    } catch (error) {
      if (startingRunner) {
        // Shutdown may already have closed and transferred this generation's lease.
        // Its delayed startup failure must not rewrite a successor's durable state.
        if (startingRunner.leaseReleased) {
          onFailure?.(error, false);
          throw error;
        }
        this.#managedRunners.set(record.id, startingRunner);
        this.#startingRunners.delete(record.id);
        try {
          await this.#closeManagedRunner(record.id, startingRunner, () => onFailure?.(error, true));
        } catch {
          /* Preserve the original native failure and retain the closing runner. */
        }
        if (startingRunner.leaseReleased) onFailure?.(error, false);
      }
      throw error;
    }
  }

  request(value: unknown) {
    return this.#runOperation(() => this.#request(value));
  }

  /** Revalidate access on every poll, but parse unchanged indexed history only once.
   * Managed sessions keep their event-ledger path, and live/control reads are never cached. */
  indexedCodexHistoryVersion(sessionId: string): Promise<string | null> {
    return this.#runOperation(async () => {
      const generation = this.indexGeneration();
      let resolved: ReturnType<SessionReaders["resolve"]> | undefined;
      const resolve = () => (resolved ??= this.sessions.resolve(sessionId));
      const before = await this.#indexedCodexEventScope(sessionId, resolve);
      if (!before) return null;
      const source = await resolve();
      if (source.summary.agent !== "codex" || !source.transcript) return null;
      const info = lstatSync(source.transcript, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("session-unavailable");
      const after = await this.#indexedCodexEventScope(sessionId, resolve);
      if (before !== after || generation !== this.indexGeneration())
        throw new Error("session-unavailable");
      return JSON.stringify([
        String(generation),
        before,
        this.sessions.codexHome(),
        source.native.native_ref,
        source.workspace,
        source.transcript,
        String(info.dev),
        String(info.ino),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
      ]);
    });
  }

  /** Serve an indexed Codex page without assembling the directory. Managed and
   * unverified records still go through the regular catalog authorization. */
  indexedCodexEvents(value: unknown) {
    return this.#runOperation(async () => {
      const request = requestSchema.parse(value);
      if (request.operation !== "events") throw new Error("invalid-request");
      const generation = this.indexGeneration();
      const before = await this.#indexedCodexEventScope(request.sessionId);
      if (!before) return { handled: false as const };
      const page = await this.sessions.events({
        sessionId: request.sessionId,
        cursor: request.cursor ?? null,
        limit: request.limit,
        retainCursor: request.retainCursor !== false,
      });
      const after = await this.#indexedCodexEventScope(request.sessionId);
      if (before !== after || generation !== this.indexGeneration())
        throw new Error("session-unavailable");
      return { handled: true as const, page };
    });
  }

  async #indexedCodexEventScope(
    sessionId: string,
    resolve = () => this.sessions.resolve(sessionId),
  ): Promise<string | null> {
    const row = this.store.sessions.get(sessionId);
    if (
      row?.agent !== "codex" ||
      row.availability !== "readable" ||
      !indexEnabled(this.dataDir) ||
      this.store.sessions.codexClassificationStale(sessionId)
    )
      return null;
    // Registration uses the exact catalog ID. workspacePath also accepts a manifest alias.
    const workspace = this.store.sessions.sql.one(
      "SELECT canonical_path FROM workspaces WHERE id=?",
      row.workspace_id,
    )?.canonical_path;
    if (typeof workspace !== "string") return null;
    const catalog = readManagedCatalog(this.dataDir);
    // An incomplete ledger cannot attest that the indexed ID is safe to open directly.
    if (!catalog.complete || catalog.records.some((record) => record.id === sessionId)) return null;
    if (catalog.records.some((record) => record.native_id)) {
      const source = await resolve();
      const ref = source.native.native_ref.toLowerCase();
      const candidates = catalog.records.filter(
        (record) => record.native_id?.toLowerCase() === ref,
      );
      if (candidates.length) {
        const aliases = await managedCatalogAliases(this.store, this.sessions, {
          records: candidates,
          complete: true,
        });
        if ([...aliases.values()].some((owned) => owned.has(sessionId))) return null;
      }
    }
    return JSON.stringify([row.workspace_id, workspace, row.created_at]);
  }

  async #codexLiveWithLimits(sessionId: string, enabled: boolean) {
    const live = await this.#managedLive(sessionId, enabled);
    const limit = this.#codexLimits.get(sessionId)?.limit;
    return live.executionMode === "codex-managed"
      ? { ...live, usageLimit: usageLimitView(limit, this.#bootId) }
      : live;
  }

  async #request(value: unknown) {
    const request = requestSchema.parse(value);
    if (request.operation === "subagents" || request.operation === "subagent-events") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      const child = request.operation === "subagent-events" ? request : null;
      if (managed) {
        this.#assertManagedHome(managed);
        if (!managed.native_id)
          return { version: 1, sessionId: request.sessionId, agents: [], truncated: false };
        const parent = this.sessions.verifiedCodexSubagentParent(
          managed.id,
          managed.native_id,
          managed.workspace,
        );
        Object.assign(parent, this.#subagentObservation(request.sessionId, managed.native_id));
        return this.sessions.subagentsForNative(
          parent,
          child?.subagentId,
          child?.cursor ?? null,
          child?.limit ?? 50,
        );
      }
      const source = await this.sessions.resolve(request.sessionId);
      const observation = this.#subagentObservation(request.sessionId, source.native.native_ref);
      return this.sessions.subagentsForSession(
        request.sessionId,
        child?.subagentId,
        child?.cursor ?? null,
        child?.limit ?? 50,
        observation.running,
        observation.turnId,
        observation,
      );
    }
    if (request.operation === "live") {
      const provider = this.#sessionProviderForSession(request.sessionId);
      if (!provider) throw new Error("unsupported-session-provider");
      return provider.live(request.sessionId, request.experimentalEnabled === true);
    }
    if (request.operation === "context") return this.#context(request.sessionId);
    if (request.operation === "resume-command") return this.#resumeCommand(request.sessionId);
    if (request.operation === "usage") {
      const provider = this.#sessionProviderForSession(request.sessionId);
      if (!provider) throw new Error("unsupported-session-provider");
      return provider.contextUsage(request.sessionId);
    }
    if (request.operation === "goal") return this.#goal(request.sessionId);
    if (request.operation === "resources") return this.#resources(request.sessionId);
    if (request.operation === "session-directory") return this.#sessionDirectory(request.sessionId);
    if (request.operation === "session-image") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      if (managed) {
        this.#assertManagedHome(managed);
        if (!managed.native_id) throw new Error("session-image-unavailable");
        const identity = this.sessions.verifiedCodexControlDirectory(managed.native_id);
        if (!identity || identity.id !== managed.native_id.toLowerCase())
          throw new Error("unverified-session-identity");
        const cwd = canonicalize(managed.cwd ?? identity.cwd);
        const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
        const result = await this.sessions.imageForNative(
          "codex",
          managed.native_id,
          workspace,
          request.imageId,
          { codexDirectory: cwd },
        );
        const latest = readManagedRecords(this.dataDir, this.store).find(
          (record) => record.id === request.sessionId,
        );
        if (
          !latest ||
          latest.workspace_id !== managed.workspace_id ||
          latest.native_id !== managed.native_id ||
          latest.cwd !== managed.cwd
        )
          throw new Error("session-image-unavailable");
        this.#assertManagedHome(latest);
        return result;
      }
      const generation = this.indexGeneration();
      const summary = this.store.sessions.get(request.sessionId);
      if (!indexEnabled(this.dataDir) || !summary) throw new Error("session-image-unavailable");
      const result = await this.sessions.image(request.sessionId, request.imageId);
      const latest = this.store.sessions.get(request.sessionId);
      if (
        !indexEnabled(this.dataDir) ||
        generation !== this.indexGeneration() ||
        !latest ||
        latest.workspace_id !== summary.workspace_id ||
        latest.agent !== summary.agent
      )
        throw new Error("session-image-unavailable");
      return result;
    }
    if (request.operation === "events") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      if (managed) {
        this.#assertManagedHome(managed);
        const nativeHistory =
          !!managed.native_id && !this.#managedRunners.get(managed.id)?.session.connected;
        const nativePrefix = "codex-native-v1:";
        if (request.cursor && nativeHistory !== request.cursor.startsWith(nativePrefix))
          throw new Error("TRANSCRIPT_CURSOR_STALE");
        let events: {
          events: Array<Record<string, unknown>>;
          next_cursor: string | null;
          warnings: string[];
        };
        if (nativeHistory) {
          const identity = this.sessions.verifiedCodexControlDirectory(managed.native_id!);
          if (!identity || identity.id !== managed.native_id!.toLowerCase())
            throw new Error("unverified-session-identity");
          const cwd = canonicalize(managed.cwd ?? identity.cwd);
          const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
          if (
            !within(cwd, workspace) ||
            pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
          )
            throw new Error("session-workspace-mismatch");
          const page = await this.sessions.eventsForNative(
            "codex",
            managed.native_id!,
            workspace,
            request.cursor?.slice(nativePrefix.length) ?? null,
            request.limit,
            { codexDirectory: cwd },
            request.retainCursor !== false,
          );
          events = {
            ...page,
            events: page.events.map((event) => ({ ...event })),
            next_cursor: page.next_cursor ? nativePrefix + page.next_cursor : null,
          };
        } else {
          events = readManagedEvents(
            this.dataDir,
            request.sessionId,
            request.cursor,
            request.limit,
          );
          // Codex writes a started thread only with its first message. Until then this
          // connected runner's ledger is the whole history, with no native images to add.
          if (managed.native_id && this.sessions.codexThreadWritten(managed.native_id)) {
            const identity = this.sessions.verifiedCodexControlDirectory(managed.native_id);
            if (!identity || identity.id !== managed.native_id.toLowerCase())
              throw new Error("unverified-session-identity");
            const cwd = canonicalize(managed.cwd ?? identity.cwd);
            const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
            if (
              !within(cwd, workspace) ||
              pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
            )
              throw new Error("session-workspace-mismatch");
            let sourceRevision: string | null = null;
            const transcript = this.sessions.verifiedCodexReadTranscript(
              managed.native_id,
              workspace,
            );
            if (transcript) {
              try {
                const stat = statSync(transcript, { bigint: true });
                sourceRevision = `${transcript}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
              } catch {
                /* Compressed/missing sources still get a fresh verified read below. */
              }
            }
            const cacheKey = createHash("sha256")
              .update(
                JSON.stringify([
                  managed.id,
                  managed.native_id,
                  managed.home,
                  workspace,
                  cwd,
                  sourceRevision,
                  events.events,
                ]),
              )
              .digest("hex");
            const cached = sourceRevision ? this.#managedImagePages.get(cacheKey) : undefined;
            const read = () =>
              enrichLedgerImages(events, (cursor, imageScanBudget) =>
                this.sessions.eventsForNative("codex", managed.native_id!, workspace, cursor, 100, {
                  codexDirectory: cwd,
                  imageScanBudget,
                }),
              );
            const pending =
              cached && Date.now() - cached.at < 5_000
                ? cached.pending
                : read().then((page) => ({
                    images: new Map(
                      page.events
                        .filter((event) => Array.isArray(event.images))
                        .map((event) => [
                          String(event.id),
                          {
                            images: event.images as ConversationImage[],
                            attachment_count: Number(event.attachment_count) || 0,
                          },
                        ]),
                    ),
                    warnings: page.warnings,
                  }));
            if (sourceRevision && (!cached || pending !== cached.pending)) {
              while (this.#managedImagePages.size >= 32)
                this.#managedImagePages.delete(this.#managedImagePages.keys().next().value!);
              this.#managedImagePages.set(cacheKey, { at: Date.now(), pending });
            }
            const projection = await pending;
            events = {
              ...events,
              events: events.events.map((event) => ({
                ...event,
                ...projection.images.get(String(event.id)),
              })),
              warnings: projection.warnings,
            };
          }
        }
        const latest = readManagedRecords(this.dataDir, this.store).find(
          (record) => record.id === request.sessionId,
        );
        if (
          !latest ||
          latest.workspace_id !== managed.workspace_id ||
          latest.native_id !== managed.native_id ||
          latest.cwd !== managed.cwd
        )
          throw new Error("session-unavailable");
        this.#assertManagedHome(latest);
        return events;
      }
    }
    const generation = this.indexGeneration();
    const enabled = indexEnabled(this.dataDir);
    if (request.operation === "catalog") {
      const catalog = readManagedCatalog(this.dataDir);
      const managed = catalog.records.filter((record) =>
        hasManagedCatalogWorkspace(this.store, record),
      );
      if (!enabled && managed.length === 0)
        return {
          workspaces: [],
          sessions: [],
          indexEnabled: false,
          complete: catalog.complete,
          ...(catalog.complete ? { incompleteSources: [] } : {}),
        };
      const allWorkspaces = this.store.listWorkspaces() as Array<{
        id: string;
        name: string;
        path: string;
        status: string;
        asset_count: number;
        warning_count: number;
        last_active_at: string | null;
        last_scanned_at: string | null;
      }>;
      const sessionRows: unknown[] = [];
      if (enabled)
        for (const workspace of allWorkspaces) {
          sessionRows.push(
            ...(this.sessionIndex
              ? await this.sessionIndex.read(workspace.id)
              : this.store.sessions.list(workspace.id)),
          );
          if (sessionRows.length > 20_000) throw new Error("response-too-large");
        }
      const registered = new Set(
        (this.store.listWorkspaces() as Array<{ id: string }>).map((workspace) => workspace.id),
      );
      const managedWorkspaceIds = new Set(managed.map((record) => record.workspace_id));
      const workspaces = allWorkspaces.filter(
        (workspace) => enabled || managedWorkspaceIds.has(workspace.id),
      );
      const { aliases: aliasesByOwner, nativeByOwner } = await managedCatalogProjection(
        this.store,
        this.sessions,
        catalog,
      );
      const aliases = new Set([...aliasesByOwner.values()].flatMap((owned) => [...owned]));
      const sessions = sessionRows.filter((session) => {
        if (!isSessionSummary(session)) return false;
        return registered.has(session.workspace_id) && !aliases.has(session.id);
      });
      sessions.push(
        ...managed.map((record) => ({
          id: record.id,
          workspace_id: record.workspace_id,
          agent: "codex",
          // The thread's title as Codex lists it: the name the person or a Codex client gave
          // it, else Codex's own title from its first message. The record's title (a
          // placeholder for a session AgentKib created) shows only until Codex has the thread.
          title: nativeByOwner.get(record.id)?.title?.trim() || record.title,
          created_at: record.created_at,
          updated_at: nativeByOwner.get(record.id)?.updated_at ?? record.created_at,
          message_count: null,
          git_branch: null,
          origin: "interactive",
          archived: record.archived,
          sidechain: false,
          availability: "readable",
          indexedSessionIds: [...(aliasesByOwner.get(record.id) ?? [])],
          executionMode: "codex-managed",
          sourceSessionId: record.source_session_id ?? null,
          forked_from_session_id: record.source_session_id ?? null,
        })),
      );
      const needsRuntime =
        sessions.some((session) => {
          if (
            !isSessionSummary(session) ||
            !("agent" in session) ||
            session.agent !== "codex" ||
            this.#managedRunners.has(session.id)
          )
            return false;
          const observation = this.#catalogObservations.get(session.id);
          return (
            !observation ||
            Date.now() - observation.at >= 5000 ||
            !["control-outcome-unconfirmed", "session-retiring"].includes(observation.reason ?? "")
          );
        }) ||
        (enabled &&
          Object.values(SESSION_COLLECTIONS).some((collection) =>
            this.store.sessions
              .list(collection)
              .some((row) => row.agent === "codex" && row.workspace_id === collection),
          ));
      // Directory display is read-only. A slow/missing CLI must not delay the
      // persisted catalog; controls still perform their own mandatory preflight.
      const runtime = needsRuntime ? (this.#catalogRuntime ?? null) : null;
      if (needsRuntime && !this.#catalogRuntimeCheck) {
        const check = this.#preflight
          .check()
          .then((value) => {
            if (this.#shuttingDown) return;
            const changed = this.#catalogRuntime?.reason !== value.reason;
            this.#catalogRuntime = value;
            if (changed) this.catalogChanged?.();
          })
          .catch(() => undefined);
        this.#catalogRuntimeCheck = check;
        void check.finally(() => {
          if (this.#catalogRuntimeCheck === check) this.#catalogRuntimeCheck = undefined;
        });
      }
      if (this.indexGeneration() !== generation || indexEnabled(this.dataDir) !== enabled)
        throw new Error("catalog-stale");
      const incompleteSources = enabled
        ? (this.sessionIndex?.incompleteSources(allWorkspaces.map((workspace) => workspace.id)) ??
          [])
        : [];
      const checkouts = catalogCheckouts(this.store, this.environment);
      const externalTurns = this.#externalTurnsBySession(managed, aliasesByOwner, enabled);
      return {
        codexRuntimeReason: runtime?.reason === "codex-cli-version-too-old" ? runtime.reason : null,
        complete: catalog.complete && incompleteSources.length === 0,
        ...(catalog.complete ? { incompleteSources } : {}),
        workspaces: checkouts.workspaces(
          workspaces
            .filter((workspace) => registered.has(workspace.id))
            .map(({ id, name, path }) => ({ id, name, path })),
        ),
        sessions: checkouts.sessions(sessions).map((session) => {
          if (isSessionSummary(session) && "agent" in session && session.agent === "devin")
            return this.#devinContinuation(session);
          if (isSessionSummary(session) && "agent" in session && session.agent === "antigravity")
            return this.#antigravityContinuation(session);
          if (!isSessionSummary(session) || !("agent" in session) || session.agent !== "codex")
            return session;
          const runner = this.#managedRunners.get(session.id);
          const ownership = this.#ownership.get(session.id);
          const reason =
            ownership && Date.now() - ownership.checkedAt < 5000 ? ownership.reason : null;
          const observation = this.#catalogObservations.get(session.id);
          const observed =
            observation && Date.now() - observation.at < 5000
              ? {
                  status: observation.status,
                  executionLocation: null,
                  ownershipReason: null,
                  reason: observation.reason,
                }
              : undefined;
          const unsafeObservation =
            observed &&
            ["control-outcome-unconfirmed", "session-retiring"].includes(observed.reason ?? "");
          const continuation = runner?.retiring
            ? {
                status: runner.retirementFailed ? "outcome-unknown" : "idle",
                executionLocation: "agentkib",
                ownershipReason: null,
                reason: runner.retirementFailed
                  ? "control-outcome-unconfirmed"
                  : "session-retiring",
              }
            : runner
              ? {
                  status: runner.state.status,
                  executionLocation: "agentkib",
                  ownershipReason: null,
                  ...(runner.state.status === "outcome-unknown"
                    ? { reason: "control-outcome-unconfirmed" }
                    : {}),
                }
              : unsafeObservation
                ? observed
                : runtime?.reason
                  ? {
                      status: "unsupported",
                      executionLocation: null,
                      ownershipReason: null,
                      reason: runtime.reason,
                    }
                  : reason
                    ? {
                        status: "idle",
                        executionLocation: reason === "codex-owner-busy" ? "external" : null,
                        ownershipReason: reason,
                        reason,
                      }
                    : observed;
          // A resident runner reports its own turns, so only a session without one shows a
          // turn that runs elsewhere.
          const externalTurn = runner ? undefined : externalTurns.get(session.id);
          const shown = externalTurn ? { ...session, externalTurn } : session;
          return continuation ? { ...shown, continuation } : shown;
        }),
        indexEnabled: enabled || managed.length > 0,
      };
    }

    if (!enabled) throw new Error("index-disabled");
    const summary = this.store.sessions.get(request.sessionId);
    let managedRecord: ManagedRecord | undefined;
    let result;
    if (summary) {
      result = await this.sessions.events({
        sessionId: request.sessionId,
        cursor: request.cursor ?? null,
        limit: request.limit,
        retainCursor: request.retainCursor !== false,
      });
    } else {
      managedRecord = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (!managedRecord?.native_id) throw new Error("session-unavailable");
      const workspace = this.store.workspacePath(managedRecord.workspace_id);
      result = await this.sessions.eventsForNative(
        "codex",
        managedRecord.native_id,
        workspace,
        request.cursor ?? null,
        request.limit,
        undefined,
        request.retainCursor !== false,
      );
    }
    if (
      this.indexGeneration() !== generation ||
      !indexEnabled(this.dataDir) ||
      (!summary &&
        (!managedRecord ||
          !readManagedRecords(this.dataDir, this.store).some(
            (item) =>
              item.id === request.sessionId &&
              item.native_id === managedRecord.native_id &&
              item.workspace_id === managedRecord.workspace_id,
          ))) ||
      (summary && !this.store.sessions.get(request.sessionId))
    )
      throw new Error("session-unavailable");
    return result;
  }

  /** A child run belongs to the resident native connection and owner, across parent turns. */
  #subagentObservation(sessionId: string, nativeId: string) {
    const resident = this.#managedRunners.get(sessionId);
    const follower = this.#codexFollowers.get(sessionId);
    const state = resident?.state.snapshot(this.#bootId, false);
    const followed = follower?.bridge.selectedState;
    const residentStatus = String(state?.status);
    const followedStatus = String(followed?.status);
    const owned =
      resident?.session.connected === true &&
      !resident.retiring &&
      resident.state.record.native_id === nativeId &&
      !["unsupported", "disconnected", "outcome-unknown"].includes(residentStatus);
    const external =
      !owned &&
      follower?.nativeId === nativeId &&
      follower.bridge.connected &&
      followed != null &&
      followed.revision !== null &&
      !["unsupported", "disconnected", "outcome-unknown", "waiting-for-snapshot"].includes(
        followedStatus,
      );
    const connection = owned
      ? resident.session
      : external
        ? follower!.bridge.connection
        : undefined;
    const owner = owned
      ? `managed:${nativeId}`
      : external
        ? `${nativeId}:${followed!.ownerClientId}`
        : "";
    let observerId: string | undefined;
    if (connection) {
      const previous = this.#subagentObservers.get(connection);
      const current =
        previous?.identity === owner ? previous : { identity: owner, id: randomUUID() };
      this.#subagentObservers.set(connection, current);
      observerId = current.id;
    }
    return {
      connected: !!connection,
      observerId,
      running:
        !!connection &&
        ["running", "awaiting-approval", "waiting-approval", "waiting-input"].includes(
          owned ? residentStatus : followedStatus,
        ),
      turnId:
        owned && typeof state?.turnId === "string"
          ? state.turnId
          : external
            ? followed!.activeTurn()
            : null,
    };
  }

  async #inactiveRecord(sessionId: string): Promise<ManagedRecord> {
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (stored) {
      if (
        pathIdentity(canonicalize(this.store.workspacePath(stored.workspace_id))) !==
        pathIdentity(canonicalize(stored.workspace))
      )
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(stored);
      return stored;
    }
    const summary = this.store.sessions.get(sessionId);
    if (!summary || summary.agent !== "codex" || summary.sidechain)
      throw new Error("session-not-adoptable");
    const resolved = await this.sessions.resolve(sessionId);
    const nativeId = resolved.native.native_ref;
    if (
      resolved.summary.agent !== "codex" ||
      resolved.native.agent !== "codex" ||
      !this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase())
    )
      throw new Error("unverified-session-identity");
    const workspace = canonicalize(resolved.workspace);
    if (
      pathIdentity(canonicalize(this.store.workspacePath(summary.workspace_id))) !==
      pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");
    return {
      id: sessionId,
      workspace_id: summary.workspace_id,
      workspace,
      cwd: this.sessions.verifiedCodexControlDirectory(nativeId)?.cwd,
      home: canonicalize(this.sessions.codexHome()),
      native_id: nativeId,
      title: summary.title ?? "Codex",
      created_at: new Date().toISOString(),
      policy_id: "workspace-write-on-request",
      released: true,
      adopted: true,
      archived: summary.archived,
      snapshot: { revision: 0 },
    };
  }

  /**
   * The turns that the Codex app or CLI runs now, by catalog session. Display only: controls
   * still follow the session's continuation.
   */
  #externalTurnsBySession(
    managed: ReturnType<typeof readManagedCatalog>["records"],
    aliasesByOwner: Map<string, Set<string>>,
    indexed: boolean,
  ): Map<string, ExternalTurn> {
    const bySession = new Map<string, ExternalTurn>();
    const turns = this.#externalTurns.observe();
    // AgentKib's own runners hold the writer locks of the threads they run.
    for (const runner of [...this.#managedRunners.values(), ...this.#startingRunners.values()]) {
      const native = runner.state.nativeId;
      if (native)
        for (const thread of turns.keys())
          if (thread.toLowerCase() === native.toLowerCase()) turns.delete(thread);
    }
    if (!turns.size) return bySession;
    const byThread = new Map([...turns].map(([thread, turn]) => [thread.toLowerCase(), turn]));
    for (const record of managed) {
      const turn = record.native_id ? byThread.get(record.native_id.toLowerCase()) : undefined;
      if (turn && this.#isCodexHome(record.home)) bySession.set(record.id, turn);
    }
    // Indexed IDs derive from native IDs with the index salt. Reading must not create the salt,
    // and without it nothing is indexed.
    if (
      indexed &&
      typeof this.store.sessions.sql.one(
        "SELECT value FROM schema_meta WHERE key='conversation_salt'",
      )?.value === "string"
    ) {
      const owners = new Map(
        [...aliasesByOwner].flatMap(([owner, aliases]) =>
          [...aliases].map((alias) => [alias, owner] as const),
        ),
      );
      for (const [thread, turn] of turns) {
        const id = this.store.sessions.id("codex", thread);
        bySession.set(owners.get(id) ?? id, turn);
      }
    }
    return bySession;
  }

  #isCodexHome(home: string): boolean {
    try {
      return (
        pathIdentity(canonicalize(home)) === pathIdentity(canonicalize(this.sessions.codexHome()))
      );
    } catch {
      return false;
    }
  }

  async #inactiveLive(record: ManagedRecord, controls: boolean): Promise<Record<string, unknown>> {
    const checked = await this.#preflight.check();
    let reason = checked.reason;
    try {
      this.#managedCwd(record);
    } catch (error) {
      reason = error instanceof Error ? error.message : "codex-session-directory-unverified";
    }
    if (!reason && record.native_id) reason = this.#codexWriterOwnership(record);
    const retiringRunner = this.#managedRunners.get(record.id);
    const retiring = retiringRunner?.retiring === true;
    const ownershipReason = !retiring && reason === "codex-owner-busy" ? reason : null;
    if (record.archived) reason = "session-archived";
    else if (managedSessionHasUnknownCommands(this.dataDir, record.id))
      reason = "control-outcome-unconfirmed";
    else if (!record.native_id) reason = "native-session-unconfirmed";
    if (retiring)
      reason = retiringRunner.retirementFailed ? "control-outcome-unconfirmed" : "session-retiring";
    const starting = this.#controlSessions.has(record.id) && record.snapshot?.status === "starting";
    const previousObservation = this.#catalogObservations.get(record.id);
    this.#catalogObservations.set(record.id, {
      at: Date.now(),
      status: reason && reason !== "codex-owner-busy" ? "unsupported" : "idle",
      reason,
    });
    if (previousObservation?.reason !== reason) this.catalogChanged?.();
    const state = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.#bootId,
      false,
    );
    return {
      ...state,
      status: retiring
        ? retiringRunner.retirementFailed
          ? "outcome-unknown"
          : "idle"
        : starting
          ? "starting"
          : record.archived
            ? "archived"
            : reason && reason !== "codex-owner-busy"
              ? "unsupported"
              : "idle",
      usage: projectContextUsage({
        ...(isObject(record.snapshot?.usage)
          ? record.snapshot.usage
          : { available: true, tokenUsage: record.token_usage }),
        reportGeneration: undefined,
        state: "stale",
      }),
      executionLocation: starting || retiring ? "agentkib" : ownershipReason ? "external" : null,
      ownershipReason,
      externalTurn:
        ownershipReason && record.native_id && this.#isCodexHome(record.home)
          ? this.#externalTurns.turnOf(record.native_id)
          : null,
      sendEnabled: controls && reason === null && !starting,
      stopEnabled: false,
      approvals: [],
      questions: [],
      turnId: null,
      activity: null,
      reason,
    };
  }

  #codexWriterOwnership(record: ManagedRecord, force = false): string | null {
    if (!record.native_id) return "native-session-unconfirmed";
    const current = this.#ownership.get(record.id);
    if (!force && current && Date.now() - current.checkedAt < 4000) return current.reason;
    let reason: string | null;
    try {
      reason = existingFileLeaseBusy(
        path.join(record.home, "thread-writer-locks", `${record.native_id}.lock`),
      )
        ? "codex-owner-busy"
        : null;
    } catch {
      reason = "codex-owner-check-unavailable";
    }
    this.#ownership.set(record.id, { checkedAt: Date.now(), reason });
    const follower = this.#codexFollowers.get(record.id);
    if (follower && reason === null) {
      this.#codexFollowers.delete(record.id);
      follower.bridge.close();
    }
    return reason;
  }

  async #retireIdleRunners(): Promise<void> {
    if (this.#closing || this.#retiring) return;
    this.#retiring = true;
    try {
      for (const [id, runner] of this.#managedRunners) {
        if (runner.retiring || this.#controlSessions.has(id)) continue;
        if (runner.restartWhenIdle && runner.written !== false) {
          const now = runner.state.snapshot(this.#bootId, false);
          if (now.status === "idle" && !now.activity) {
            await this.#closeManagedRunner(id, runner).catch(() => undefined);
            continue;
          }
        }
        const observed = this.isSessionObserved?.(id) === true;
        const left = runner.observed && !observed;
        runner.observed ||= observed;
        const live = runner.state.snapshot(this.#bootId, false);
        // Leaving releases ownership after this turn, even if its longer-lived goal remains active.
        if (
          live.status !== "idle" ||
          live.activity ||
          (!left && live.goal && isObject(live.goal) && live.goal.status === "active")
        ) {
          runner.idleSince = null;
          continue;
        }
        runner.idleSince ??= Date.now();
        if (!left && (runner.idleSince === null || Date.now() - runner.idleSince < 60_000))
          continue;
        runner.retiring = true;
        try {
          await this.#closeManagedRunner(id, runner, () => {
            if (this.#closing) return;
            const latest = readManagedRecords(this.dataDir, this.store).find(
              (record) => record.id === id,
            );
            if (latest) {
              latest.released = true;
              latest.snapshot = {
                ...latest.snapshot,
                status: "idle",
                executionLocation: null,
                ownershipReason: null,
                reason: null,
              };
              saveManagedRecord(this.dataDir, latest);
            }
          });
        } catch {
          // The closing runner stays fenced until its real process-close event.
        }
      }
      for (const [id, follower] of this.#codexFollowers) {
        if (!this.isSessionObserved?.(id) && Date.now() - follower.lastUsed >= FOLLOWER_IDLE_MS) {
          this.#codexFollowers.delete(id);
          follower.bridge.close();
        }
      }
    } finally {
      this.#retiring = false;
    }
  }

  async #closeManagedRunner(
    id: string,
    runner: ManagedRunner,
    beforeRelease?: () => void,
  ): Promise<void> {
    runner.retiring = true;
    let completed = false;
    const complete = () => {
      if (completed) return;
      // Concurrent shutdown/release callers can await the same native close. Only
      // the caller still owning this generation may finalize its durable state.
      if (this.#managedRunners.get(id) !== runner && this.#startingRunners.get(id) !== runner) {
        completed = true;
        return;
      }
      try {
        // Persist retirement while the lease still excludes a new runtime.
        beforeRelease?.();
      } catch (error) {
        runner.retirementFailed = true;
        throw error;
      }
      completed = true;
      if (this.#managedRunners.get(id) === runner) this.#managedRunners.delete(id);
      if (this.#startingRunners.get(id) === runner) this.#startingRunners.delete(id);
      this.#ownership.delete(id);
      runner.leaseReleased = true;
      runner.release();
    };
    let failed = false;
    const closed = () => {
      if (failed) {
        try {
          complete();
        } catch {
          // A failed final write retains ownership rather than escaping an event callback.
        }
      }
    };
    runner.session.once("close", closed);
    try {
      await runner.bridge.close();
      runner.session.off("close", closed);
      complete();
    } catch (error) {
      failed = true;
      runner.retirementFailed = true;
      // A bridge flush may fail before requesting native shutdown. Regardless,
      // keep the lease until process/stdio close is confirmed, even on timeout.
      try {
        await runner.session.close();
      } catch {
        /* The real close event settles ownership. */
      }
      if (runner.session.closed) {
        runner.session.off("close", closed);
        complete();
      }
      throw error;
    }
  }

  #recoverCodexReceipts(record: ManagedRecord, runner?: ManagedRunner) {
    if (this.#controlSessions.has(record.id)) return undefined;
    const now = Date.now();
    const pending = this.#codexReceiptChecks.get(record.id);
    if (pending && now < pending.retryAt) return pending.live;
    for (const [id, check] of this.#codexReceiptChecks) {
      if (check.retryAt <= now) this.#codexReceiptChecks.delete(id);
    }
    const check = {
      retryAt: Infinity,
      live: (async () =>
        (runner ? undefined : await this.#checkPendingCodexFollowerSettings(record)) ??
        (await this.#checkPendingCodexSend(record, runner)) ??
        (runner ? undefined : await this.#checkLegacyAdopt(record)))().catch(() => undefined),
    };
    this.#codexReceiptChecks.set(record.id, check);
    void check.live.then((live) => {
      if (live) this.#codexReceiptChecks.delete(record.id);
      else check.retryAt = Date.now() + LEGACY_ADOPT_RECHECK_MS;
    });
    return check.live;
  }

  async #checkPendingCodexFollowerSettings(record: ManagedRecord) {
    const pending = readUnknownManagedCommands(this.dataDir, record.id).find(
      ({ evidence }) =>
        evidence?.operation === "settings" &&
        evidence.executionMode === "codex-follower" &&
        isObject(evidence.followerSettings),
    );
    const evidence = pending?.evidence;
    const acknowledged = evidence?.followerSettings;
    if (
      !pending ||
      !evidence ||
      !isObject(acknowledged) ||
      !record.native_id ||
      record.archived ||
      evidence.workspaceId !== record.workspace_id ||
      acknowledged.nativeId !== record.native_id ||
      typeof acknowledged.ownerClientId !== "string" ||
      typeof evidence.expectedRevision !== "number" ||
      this.#controlSessions.has(record.id) ||
      this.#codexWriterOwnership(record, true) !== "codex-owner-busy"
    )
      return;
    const expected = parseFollowerModelSettings(acknowledged);
    if (!expected) return;
    const follower = await this.#desktopFollower(record);
    const state = follower.bridge.selectedState;
    if (!state || state.ownerClientId !== acknowledged.ownerClientId) return;
    const { home, cwd } = this.#codexFollowerSettingsTarget(record, follower, state);
    if (home !== acknowledged.home || cwd !== acknowledged.cwd) return;
    const release = acquireCodexFollowerOperationLock(
      follower.bridge.connection.endpoint,
      follower.nativeId,
    );
    try {
      const verified = await follower.bridge.verifyModelSettings(
        {
          nativeId: record.native_id,
          ownerClientId: state.ownerClientId,
          revision: evidence.expectedRevision,
        },
        expected,
      );
      const latest = await this.#inactiveRecord(record.id);
      if (
        !verified ||
        this.#controlSessions.has(record.id) ||
        this.#codexWriterOwnership(latest, true) !== "codex-owner-busy"
      )
        return;
      const target = this.#codexFollowerSettingsTarget(latest, follower, state);
      if (
        target.home !== home ||
        target.cwd !== cwd ||
        !sameFollowerModelSettings(target.settings, expected)
      )
        return;
      finishManagedCommand(this.dataDir, pending.requestId, {
        accepted: true,
        completed: true,
        reconciled: true,
        appliesTo: "next-turn",
        requestId: pending.requestId,
        runtimeBootId: evidence.runtimeBootId ?? this.#bootId,
        sessionId: record.id,
      });
      this.publishConversationEvent?.(record.id, "invalidate", {
        domains: ["settings", "receipts"],
      });
      return this.#inactiveLive(latest, true);
    } finally {
      release();
    }
  }

  async #checkPendingCodexSend(record: ManagedRecord, runner?: ManagedRunner) {
    const nativeId = record.native_id;
    if (!nativeId || record.archived) return;
    const pendingSends = () =>
      readUnknownManagedCommands(this.dataDir, record.id).filter(
        ({ evidence }) =>
          evidence?.operation === "send" &&
          evidence.workspaceId === record.workspace_id &&
          (evidence.executionMode === "codex-follower" ||
            (!record.released && evidence.executionMode === "codex-managed")),
      );
    if (pendingSends().length === 0) return;

    const release = runner ? undefined : acquireManagedSessionLease(this.dataDir, record.id);
    try {
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const readRevision = runner?.state.revision;
      const params = { threadId: nativeId, includeTurns: true };
      const executable = runner ? undefined : this.#codexReader();
      const response = executable
        ? await this.#codex.request(executable, cwd, home, "thread/read", params)
        : await runner?.session.request("thread/read", params);
      const thread = isObject(response) ? response.thread : null;
      if (
        !isObject(thread) ||
        thread.id !== nativeId ||
        typeof thread.cwd !== "string" ||
        pathIdentity(canonicalize(thread.cwd)) !== pathIdentity(cwd)
      )
        return;

      await runner?.bridge.flush();
      const latest = await this.#inactiveRecord(record.id);
      this.#assertOpen();
      if (
        latest.archived ||
        latest.released !== record.released ||
        latest.native_id !== nativeId ||
        latest.workspace_id !== record.workspace_id ||
        pathIdentity(this.#managedCwd(latest)) !== pathIdentity(cwd) ||
        pathIdentity(this.#assertManagedHome(latest)) !== pathIdentity(home) ||
        this.#controlSessions.has(record.id) ||
        this.#managedRunners.get(record.id) !== runner ||
        (runner && (!runner.session.connected || runner.retiring))
      )
        return;
      const resolved = pendingSends().filter(({ requestId, evidence }) =>
        managedCommandReconciles(requestId, evidence, thread),
      );
      if (resolved.length === 0) return;
      for (const { requestId, evidence } of resolved)
        finishManagedCommand(this.dataDir, requestId, {
          accepted: true,
          completed: false,
          reconciled: true,
          requestId,
          runtimeBootId: evidence?.runtimeBootId ?? this.#bootId,
          sessionId: record.id,
        });

      const unknown = managedSessionHasUnknownCommands(this.dataDir, record.id);
      if (runner && !unknown) {
        if (runner.state.turnId === null) {
          const hydrated = runner.state.hydrate(thread, true, readRevision);
          runner.state.restoreReconciledTurn();
          runner.persist(runner.state, hydrated.events);
        } else if (runner.state.restoreReconciledTurn()) runner.persist(runner.state);
      }
      const live = runner
        ? runner.state.snapshot(this.#bootId, !unknown)
        : await this.#inactiveLive(latest, true);
      this.publishConversationEvent?.(record.id, "state", live, live);
      this.publishConversationEvent?.(record.id, "invalidate", { domains: ["receipts"] });
      return live;
    } finally {
      release?.();
    }
  }

  async #checkLegacyAdopt(record: ManagedRecord) {
    const nativeId = record.native_id;
    if (!record.adopted || record.archived || record.released || !nativeId) return;
    const pendingAdopt = () => {
      const commands = readUnknownManagedCommands(this.dataDir, record.id);
      const [command] = commands;
      return commands.length === 1 &&
        command?.evidence?.operation === "adopt" &&
        command.evidence.executionMode === "codex-managed" &&
        command.evidence.workspaceId === record.workspace_id
        ? command.requestId
        : undefined;
    };
    const requestId = pendingAdopt();
    if (!requestId) return;

    const release = acquireManagedSessionLease(this.dataDir, record.id);
    try {
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const lock = path.join(home, "thread-writer-locks", `${nativeId}.lock`);
      if (existingFileLeaseBusy(lock)) return;
      const { executable, reason } = await this.#preflight.check();
      if (!executable || reason) return;
      this.#assertOpen();
      const response = await this.#codex.readThread(executable, cwd, home, nativeId);
      const thread = isObject(response) ? response.thread : null;
      if (
        !isObject(thread) ||
        thread.id !== nativeId ||
        typeof thread.cwd !== "string" ||
        pathIdentity(canonicalize(thread.cwd)) !== pathIdentity(cwd) ||
        !isObject(thread.status) ||
        (thread.status.type !== "idle" && thread.status.type !== "notLoaded")
      )
        return;

      this.#assertOpen();
      const stored = managedRecordSchema.safeParse(readManagedRecord(this.dataDir, record.id));
      if (!stored.success) return;
      const latest = stored.data;
      if (
        latest.archived ||
        latest.released ||
        !latest.adopted ||
        latest.native_id !== nativeId ||
        latest.workspace_id !== record.workspace_id ||
        pathIdentity(this.#managedCwd(latest)) !== pathIdentity(cwd) ||
        pathIdentity(this.#assertManagedHome(latest)) !== pathIdentity(home) ||
        existingFileLeaseBusy(lock) ||
        pendingAdopt() !== requestId
      )
        return;
      // Only the lost attachment acknowledgement is settled. A native read proves the thread
      // can be reached again. Any later write still acquires and verifies the native writer.
      finishManagedCommand(this.dataDir, requestId, {
        accepted: true,
        completed: false,
        reconciled: true,
        requestId,
        runtimeBootId: this.#bootId,
        sessionId: record.id,
      });
      this.#ownership.delete(record.id);
      const live = await this.#inactiveLive(latest, true);
      this.publishConversationEvent?.(record.id, "state", live, live);
      this.publishConversationEvent?.(record.id, "invalidate", {
        domains: ["receipts", "ownership", "settings"],
      });
      return live;
    } finally {
      release();
    }
  }

  async #managedLive(
    sessionId: string,
    experimentalEnabled = false,
  ): Promise<Record<string, unknown>> {
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (!managed) {
      try {
        const record = await this.#inactiveRecord(sessionId);
        let inactive = await this.#inactiveLive(record, experimentalEnabled);
        if (experimentalEnabled && inactive.reason === "control-outcome-unconfirmed")
          inactive = (await this.#recoverCodexReceipts(record)) ?? inactive;
        return (
          (await this.#desktopFollowerLive(record, inactive, experimentalEnabled)) ??
          (await this.#desktopHandoffLive(record, inactive, experimentalEnabled)) ??
          inactive
        );
      } catch (error) {
        // Root/home sessions can live in an unregistered native collection.
        // Explain the proven directory failure without granting collection controls.
        const summary = this.store.sessions.get(sessionId);
        if (summary?.agent === "codex" && !summary.sidechain) {
          const source = await this.sessions.resolve(sessionId);
          const nativeId = source.native.native_ref;
          const identity = this.sessions.verifiedCodexControlDirectory(nativeId);
          if (
            source.native.agent === "codex" &&
            this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()) &&
            identity?.id === nativeId.toLowerCase()
          ) {
            let reason: string | undefined;
            try {
              this.#checkedCodexDirectory(identity.cwd);
            } catch (directoryError) {
              if (directoryError instanceof Error) reason = directoryError.message;
            }
            if (reason && !managedSessionHasUnknownCommands(this.dataDir, sessionId)) {
              this.#catalogObservations.set(sessionId, {
                at: Date.now(),
                status: "unsupported",
                reason,
              });
              return {
                ...new ManagedCodexState({
                  id: sessionId,
                  workspace_id: summary.workspace_id,
                  workspace: source.workspace,
                }).snapshot(this.#bootId, false),
                status: "unsupported",
                executionLocation: null,
                sendEnabled: false,
                reason,
              };
            }
          }
        }
        throw error;
      }
    }
    const liveWorkspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(liveWorkspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(managed);

    const resident = this.#managedRunners.get(sessionId);
    if (this.isSessionObserved?.(sessionId) === true) this.observeSession(sessionId);
    if (resident?.retiring)
      return {
        ...(await this.#inactiveLive(managed, false)),
        status: resident.retirementFailed ? "outcome-unknown" : "idle",
        executionLocation: "agentkib",
        ownershipReason: null,
        reason: resident.retirementFailed ? "control-outcome-unconfirmed" : "session-retiring",
        sendEnabled: false,
      };
    if (resident?.session.connected) {
      const unknown = managedSessionHasUnknownCommands(this.dataDir, sessionId);
      if (experimentalEnabled && unknown) {
        const recovered = await this.#recoverCodexReceipts(managed, resident);
        if (recovered) return recovered;
      }
      return resident.bridge.snapshot(this.#bootId, !unknown);
    }
    if (resident) {
      await this.#closeManagedRunner(sessionId, resident);
    }

    let inactive = await this.#inactiveLive(managed, experimentalEnabled);
    if (experimentalEnabled && inactive.reason === "control-outcome-unconfirmed")
      inactive = (await this.#recoverCodexReceipts(managed)) ?? inactive;
    return (
      (await this.#desktopFollowerLive(managed, inactive, experimentalEnabled)) ??
      (await this.#desktopHandoffLive(managed, inactive, experimentalEnabled)) ??
      inactive
    );
  }

  async #antigravityLive(sessionId: string): Promise<Record<string, unknown>> {
    try {
      const target = await this.#antigravityTarget(sessionId);
      this.sessions.antigravityControlExecutable();
      const cached = this.#antigravityRunners.get(sessionId);
      const unknown =
        cached?.runner.snapshot().status === "outcome-unknown" ||
        managedSessionHasUnknownCommands(this.dataDir, sessionId);
      const snapshot =
        cached?.runner.connected &&
        cached.runner.snapshot().status !== "failed" &&
        cached?.nativeId === target.nativeId &&
        cached.workspaceId === target.workspaceId &&
        pathIdentity(cached.workspace) === pathIdentity(target.workspace)
          ? cached.runner.snapshot()
          : {
              executionMode: "acp-managed",
              status: "idle",
              revision: this.#antigravityInactiveRevision(sessionId, cached),
              turnId: null,
              sendEnabled: true,
              stopEnabled: false,
              approvals: [],
              reason: null,
            };
      return {
        ...snapshot,
        ...(unknown
          ? {
              status: "outcome-unknown",
              sendEnabled: false,
              stopEnabled: false,
              reason: "control-outcome-unconfirmed",
            }
          : {}),
        sessionId,
        runtimeBootId: this.#bootId,
        // Restricted devices may control sessions in their workspaces only.
        workspaceId: target.workspaceId,
      };
    } catch (error) {
      return {
        sessionId,
        executionMode: "acp-managed",
        runtimeBootId: this.#bootId,
        workspaceId: this.store.sessions.get(sessionId)?.workspace_id ?? null,
        status: "unsupported",
        revision: 0,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        reason: error instanceof Error ? error.message : "open-in-original-client",
      };
    }
  }

  async #antigravityTarget(sessionId: string) {
    if (
      process.platform !== "darwin" &&
      process.platform !== "win32" &&
      process.platform !== "linux"
    )
      throw new Error("platform-unsupported");
    const summary = this.store.sessions.get(sessionId);
    if (!summary || summary.agent !== "antigravity" || summary.availability !== "readable")
      throw new Error("session-unavailable");
    const resolved = await this.sessions.resolve(sessionId);
    if (resolved.native.agent !== "antigravity") throw new Error("session-not-antigravity");
    if (resolved.native.native_ref.startsWith("antigravity-local-v1-"))
      throw new Error("session-read-only");
    if (resolved.native.sidechain) throw new Error("auxiliary-session-not-controllable");
    const nativeId = resolved.native.native_ref;
    const workspace = canonicalize(resolved.workspace);
    const workspaceId = summary.workspace_id;
    const registeredWorkspace = canonicalize(this.store.workspacePath(workspaceId));
    if (!within(workspace, registeredWorkspace)) throw new Error("session-workspace-mismatch");
    return { nativeId, workspaceId, workspace };
  }

  async antigravityWorkerAvailable(sessionId: string): Promise<boolean> {
    const live = await this.#antigravityLive(sessionId);
    return ["idle", "running", "waiting-approval"].includes(String(live.status));
  }

  /** Read visible replies not yet persisted by ACP without starting a second transport. */
  async antigravityWorkerEvents(
    sessionId: string,
    limit: number,
  ): Promise<Record<string, unknown>[] | null> {
    try {
      const target = await this.#antigravityTarget(sessionId);
      const cached = this.#antigravityRunners.get(sessionId);
      if (
        !cached?.runner.connected ||
        cached.nativeId !== target.nativeId ||
        cached.workspaceId !== target.workspaceId ||
        pathIdentity(cached.workspace) !== pathIdentity(target.workspace)
      )
        return null;
      const replies = cached.runner.recentWorkerReplies(limit);
      return replies.length ? replies : null;
    } catch {
      // An unavailable native projection can still have readable history.
      return null;
    }
  }

  async #antigravityRunner(sessionId: string): Promise<AntigravityRunnerRecord> {
    const { nativeId, workspaceId, workspace } = await this.#antigravityTarget(sessionId);
    const cached = this.#antigravityRunners.get(sessionId);
    if (
      cached?.runner.connected &&
      !["failed"].includes(String(cached.runner.snapshot().status)) &&
      cached.nativeId === nativeId &&
      cached.workspaceId === workspaceId &&
      pathIdentity(cached.workspace) === pathIdentity(workspace)
    ) {
      cached.lastUsed = Date.now();
      return cached;
    }
    const initialRevision = this.#antigravityInactiveRevision(sessionId, cached);
    if (cached) {
      this.#antigravityRetiredRevisions.set(sessionId, initialRevision - 1);
      this.#antigravityRunners.delete(sessionId);
      cached.runner.close();
    }
    const pending = this.#antigravityRunnerFlights.get(sessionId);
    if (pending) return pending;
    const flight = this.#connectAntigravityRunner(
      sessionId,
      workspaceId,
      workspace,
      nativeId,
      initialRevision,
    );
    this.#antigravityRunnerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#antigravityRunnerFlights.get(sessionId) === flight)
        this.#antigravityRunnerFlights.delete(sessionId);
    }
  }

  #antigravityInactiveRevision(sessionId: string, cached?: AntigravityRunnerRecord): number {
    const last =
      cached?.runner.snapshot().revision ?? this.#antigravityRetiredRevisions.get(sessionId);
    return typeof last === "number" && Number.isSafeInteger(last) && last >= 0 ? last + 1 : 0;
  }

  async #connectAntigravityRunner(
    sessionId: string,
    workspaceId: string,
    workspace: string,
    nativeId: string,
    initialRevision: number,
  ): Promise<AntigravityRunnerRecord> {
    if (this.#antigravityRunners.size >= 8) {
      const candidates = [...this.#antigravityRunners.entries()]
        .filter(([, value]) => ["idle", "failed"].includes(String(value.runner.snapshot().status)))
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const [retireId, retire] = candidates[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-limit");
      this.#antigravityRetiredRevisions.set(
        retireId,
        this.#antigravityInactiveRevision(retireId, retire) - 1,
      );
      this.#antigravityRunners.delete(retireId);
      retire.runner.close();
    }
    const runner = await AntigravityManagedRunner.connect(
      this.sessions.antigravityControlExecutable(),
      workspace,
      nativeId,
      { ...process.env, ...this.environment },
      (type, payload, live) => {
        const current = { ...live, sessionId, runtimeBootId: this.#bootId, workspaceId };
        const eventPayload = isObject(payload.live) ? { ...payload, live: current } : payload;
        this.publishConversationEvent?.(sessionId, type, eventPayload, current);
      },
      async () => {
        const replay = await this.sessions.antigravityReadHandoff(nativeId);
        const events = replay.messages;
        if (events.length > 100_000) throw new Error("Antigravity history recovery limit exceeded");
        let bytes = 0;
        const items = events.map((event) => {
          const item = {
            ...event,
            turn_id: event.turn_id ?? event.id,
            ephemeral: false,
          };
          bytes += Buffer.byteLength(JSON.stringify(item));
          return item;
        });
        if (bytes > 16 * 1024 * 1024)
          throw new Error("Antigravity history recovery limit exceeded");
        return items;
      },
      initialRevision,
      {
        waiting: (turnId) =>
          this.#observeLane((observer) => observer.waiting(sessionId, turnId, "awaiting-approval")),
        ended: (turnId, outcome, durationMs, replyText) =>
          this.#observeLane((observer) =>
            observer.turnEnded(sessionId, turnId, outcome, durationMs, undefined, replyText),
          ),
      },
    );
    try {
      const latest = await this.sessions.resolve(sessionId);
      const latestRoot = canonicalize(this.store.workspacePath(workspaceId));
      if (
        latest.native.agent !== "antigravity" ||
        latest.native.sidechain ||
        latest.native.native_ref !== nativeId ||
        latest.summary.workspace_id !== workspaceId ||
        pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
        !within(canonicalize(latest.workspace), latestRoot)
      )
        throw new Error("session-unavailable");
      const record = { runner, nativeId, workspaceId, workspace, lastUsed: Date.now() };
      this.#antigravityRunners.set(sessionId, record);
      return record;
    } catch (error) {
      runner.close();
      throw error;
    }
  }

  async #antigravityControl(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    beforeNativeDispatch?: () => void,
  ) {
    if (request.effort === null || request.serviceTier === null)
      throw new Error("unsupported-setting-clear");
    const runtimeBootId = this.#bootId;
    if (!request.experimentalEnabled || request.runtimeBootId !== runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const before = await this.#antigravityLive(request.sessionId);
    if (before.revision !== request.expectedRevision) throw new Error("stale-or-disabled-control");
    if (before.status === "unsupported")
      throw new Error(typeof before.reason === "string" ? before.reason : "session-unavailable");
    const cached = this.#antigravityRunners.get(request.sessionId);
    if (!cached?.runner.connected || cached.runner.snapshot().status === "failed") {
      if (request.operation !== "send") throw new Error("session-not-running");
      if (!before.sendEnabled)
        throw new Error(typeof before.reason === "string" ? before.reason : "session-unavailable");
      if (typeof request.text !== "string") throw new Error("missing-text");
    }
    const record = await this.#antigravityRunner(request.sessionId);
    const live = record.runner.snapshot();
    if (activityBlocks(live, request.operation)) return compactingRejection(request, this.#bootId);
    if (request.expectedRevision !== live.revision) throw new Error("stale-or-disabled-control");
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.store.sessions.get(request.sessionId)?.workspace_id ?? null,
        runtimeBootId,
        expectedRevision: request.expectedRevision,
        turnId: request.turnId ?? null,
        nativeRequestId: request.approvalId ?? null,
        executionMode: "antigravity-acp-managed",
        ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
      },
    );
    if (claimed) return claimed;
    let finishReport!: (accepted: boolean) => void;
    const sendAccepted = new Promise<boolean>((resolve) => {
      finishReport = resolve;
    });
    let dispatched = false;
    const beforeDispatch = () => {
      assertActivityAllows(record.runner.snapshot(), request.operation);
      try {
        beforeNativeDispatch?.();
      } catch (error) {
        throw new AcpUndispatchedError(
          error instanceof Error ? error.message : "control-preflight-rejected",
        );
      }
      dispatchManagedCommand(this.dataDir, request.requestId);
      dispatched = true;
    };
    try {
      if (request.operation === "send") {
        if (typeof request.text !== "string") throw new Error("missing-text");
        await record.runner.send(request.text, request.expectedRevision, beforeDispatch, {
          requestId: request.requestId,
          accepted: sendAccepted,
        });
      } else if (request.operation === "stop") {
        if (typeof request.turnId !== "string") throw new Error("missing-turn");
        await record.runner.stop(request.turnId, request.expectedRevision, beforeDispatch);
      } else if (request.operation === "approve") {
        if (
          request.approvalId === undefined ||
          typeof request.turnId !== "string" ||
          typeof request.decision !== "string"
        )
          throw new Error("missing-approval-decision");
        await record.runner.approve(
          String(request.approvalId),
          request.turnId,
          request.decision,
          request.expectedRevision,
          beforeDispatch,
        );
      } else {
        throw new Error("control-unavailable");
      }
      record.lastUsed = Date.now();
      const result = {
        accepted: true,
        completed: false,
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      finishReport(true);
      return result;
    } catch (error) {
      finishReport(false);
      const outcomeUnknown = dispatched || record.runner.snapshot().status === "outcome-unknown";
      const result = {
        accepted: false,
        completed: false,
        sessionId: request.sessionId,
        controlOutcome: outcomeUnknown ? "unknown" : "not-dispatched",
        reason: error instanceof Error ? error.message : "control-preflight-rejected",
        requestId: request.requestId,
        runtimeBootId,
      };
      if (!outcomeUnknown) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  #devinHost(
    workspace: string,
    workspaceId: string,
    sessionId: () => string | null,
  ): DevinRunnerHost {
    const environment = devinChildEnvironment({ ...process.env, ...this.environment });
    const page = (nativeId: string, limit: number) =>
      this.sessions.eventsForNative("devin", nativeId, workspace, null, limit);
    return {
      executable: () => devinExecutable(environment),
      environment,
      latestItems: async (nativeId) =>
        (await page(nativeId, 100)).events.map((event) => ({
          ...event,
          turn_id: event.turn_id ?? event.id,
          ephemeral: false,
        })),
      listSessions: async () =>
        (await this.sessions.list("devin", workspace)).sessions.map((session) => ({
          nativeId: session.native_ref,
          createdAt: Date.parse(session.created_at ?? "") || 0,
        })),
      firstUserText: async (nativeId) =>
        (await page(nativeId, 20)).events.find((event) => event.kind === "user-message")?.content ??
        null,
      turnEnded: (end) => {
        const id = sessionId();
        if (id) this.#devinTurnEnded(id, workspace, end);
      },
      publish: (type, payload, live) => {
        const id = sessionId();
        if (!id) return;
        const current = { ...live, sessionId: id, runtimeBootId: this.#bootId, workspaceId };
        const eventPayload =
          type === "state"
            ? current
            : isObject(payload.live)
              ? { ...payload, live: current }
              : payload;
        this.publishConversationEvent?.(id, type, eventPayload, current);
      },
    };
  }

  /**
   * A Devin turn AgentKib ran ended. Its result goes to the read state, which unread results and
   * the phone's alerts come from; a usage limit it met is held as Codex's are, and any other end
   * is the next turn after a limit, which ends the hold.
   */
  #devinTurnEnded(sessionId: string, workspace: string, end: DevinTurnEnd): void {
    try {
      this.#resultObserver?.(
        {
          provider: "devin",
          home: devinSessionHome(this.environment),
          nativeId: end.nativeId,
          workspace,
        },
        {
          id: `turn:${end.turnId}`,
          turnId: end.historyTurnId,
          itemId: end.answerItemId,
          outcome: end.outcome,
          completedAt: end.endedAt,
        },
        { turnStartedAt: end.startedAt },
      );
    } catch {
      // A result that cannot be recorded changes nothing about the turn.
    }
    this.#observeLane((observer) =>
      observer.turnEnded(
        sessionId,
        end.turnId,
        end.outcome,
        Math.max(0, Date.parse(end.endedAt) - Date.parse(end.startedAt)),
        end.observedHistoryTurnId,
        end.observedReplyText ?? null,
      ),
    );
    if (end.usageLimit) void this.#holdDevinLimit(sessionId, workspace, end.usageLimit);
    else if (this.#devinLimits.has(sessionId)) this.#armDevinLimit(sessionId, null);
  }

  /** Devin's native history has no terminal markers. Only AgentKib-observed results can catch up. */
  async devinEndedTurns(sessionId: string) {
    const source = await this.sessions.resolve(sessionId);
    if (source.native.agent !== "devin") return [];
    const rows = new ReadStateLedger(this.dataDir)
      .recentTerminalResults(
        conversationReadKey("devin", devinSessionHome(this.environment), source.native.native_ref),
      )
      .filter(
        ({ result, startedAt }) => startedAt && result.completedAt && result.id.startsWith("turn:"),
      );
    if (!rows.length) return [];
    const page = await this.sessions
      .eventsForNative("devin", source.native.native_ref, source.workspace, null, 100)
      .catch(() => null);
    const current = this.#serialQueueTarget(sessionId);
    if (
      current?.agent !== "devin" ||
      current.workspaceId !== source.summary.workspace_id ||
      current.nativeId !== this.store.sessions.id("devin", source.native.native_ref)
    )
      return [];
    const events = new Map(page?.events.map((item) => [item.id, item]));
    return rows.map(({ result, startedAt }) => {
      const answer = result.itemId ? events.get(result.itemId) : undefined;
      const hasAnswer =
        answer?.kind === "agent-message" &&
        answer.turn_id === result.turnId &&
        devinItemInTurn(
          answer.timestamp,
          Date.parse(startedAt ?? ""),
          Date.parse(result.completedAt ?? ""),
        );
      return {
        turnId: result.id.slice("turn:".length),
        outcome: result.outcome,
        startedAt,
        endedAt: result.completedAt,
        ...(hasAnswer && result.turnId ? { historyTurnId: result.turnId } : {}),
        replyText: hasAnswer ? answer.content : null,
      };
    });
  }

  /**
   * Holds the limit a Devin turn met. The notice says so at once; when the limit resets follows
   * once Devin's `/usage` has said, and then the continue is armed as for Codex.
   */
  async #holdDevinLimit(sessionId: string, workspace: string, hit: UsageLimitHit): Promise<void> {
    const held = this.#devinLimits.get(sessionId);
    const context = {
      deviceId: this.#devinSenders.get(sessionId) ?? held?.limit.deviceId ?? "",
      bootId: this.#bootId,
      // Only a turn AgentKib's continue started counts toward the three in a row.
      previous: held?.continuing ? held.limit : null,
      autoContinue: usageLimitAutoContinue(this.dataDir),
    };
    const first = holdUsageLimit("devin", hit, context);
    this.#armDevinLimit(sessionId, first);
    const windows = await this.#devinUsageWindows(workspace);
    const reset = windows ? devinLimitReset(windows, hit) : null;
    // A turn that started meanwhile decides instead.
    if (!reset || this.#shuttingDown || this.#devinLimits.get(sessionId)?.limit !== first) return;
    this.#armDevinLimit(sessionId, holdUsageLimit("devin", { ...hit, ...reset }, context));
  }

  /**
   * Devin's `/usage` (`devin-usage.ts`), read in the session's workspace. Sessions that meet the
   * account's limit together share one read; a read that told nothing is not reused.
   */
  #devinUsageWindows(workspace: string): Promise<DevinUsageWindow[] | null> {
    const recent = this.#devinUsage;
    if (recent && recent.known !== false && Date.now() - recent.at < 60_000) return recent.read;
    const environment = devinChildEnvironment({ ...process.env, ...this.environment });
    const executable = devinExecutable(environment);
    const read = executable
      ? readDevinUsage(executable, workspace, environment, {
          signal: this.#devinUsageAbort.signal,
        }).catch(() => null)
      : Promise.resolve(null);
    const entry: DevinUsageRead = { at: Date.now(), read };
    void read.then((windows) => {
      entry.known = !!windows?.length;
    });
    this.#devinUsage = entry;
    return read;
  }

  /**
   * Holds `limit` for a Devin session (null ends the hold), arms its continue, keeps its notice
   * for a later run of AgentKib, and with `show` puts it on the session's live state.
   */
  #armDevinLimit(
    sessionId: string,
    limit: UsageLimit | null,
    continuing?: string,
    show = true,
  ): void {
    const held = this.#devinLimits.get(sessionId);
    clearTimeout(held?.timer);
    if (!limit) this.#devinLimits.delete(sessionId);
    else {
      const timer =
        limit.continueAt === null
          ? undefined
          : setTimeout(
              () => void this.#fireDevinContinue(sessionId).catch(() => undefined),
              Math.min(LIMIT_TIMER_MS, Math.max(0, limit.continueAt - Date.now())),
            );
      timer?.unref?.();
      this.#devinLimits.set(sessionId, { limit, timer, continuing });
    }
    try {
      // What the person is told outlives a restart; a continue on its way is a turn that started.
      saveManagedUsageLimit(this.dataDir, sessionId, limit && !continuing ? limit : null);
    } catch {
      // The notice still shows until AgentKib quits.
    }
    if (show)
      this.#devinRunners.get(sessionId)?.runner.showUsageLimit(usageLimitView(limit, this.#bootId));
  }

  /** A new runner shows the hold for its session, also one an earlier run of AgentKib kept. */
  #showDevinLimit(sessionId: string, runner: DevinManagedRunner): void {
    let limit = this.#devinLimits.get(sessionId)?.limit;
    if (!limit) {
      let kept: ReturnType<typeof readManagedUsageLimit> = null;
      try {
        kept = readManagedUsageLimit(this.dataDir, sessionId);
      } catch {
        kept = null;
      }
      const parsed = kept ? parseUsageLimit(kept.limit, "devin") : null;
      if (parsed && Date.now() - kept!.savedAt < KEPT_LIMIT_MS) {
        // A continue an earlier run armed ended with it: the person continues, or arms it again.
        limit =
          usageLimitContinue(parsed, this.#bootId) === "never" && parsed.continueAt !== null
            ? { ...parsed, continueAt: null, manual: "restarted" }
            : parsed;
        this.#devinLimits.set(sessionId, { limit });
      }
    }
    if (limit) runner.showUsageLimit(usageLimitView(limit, this.#bootId));
  }

  /**
   * The continue armed after a Devin usage limit is due: AgentKib sends its continue in the name
   * of the device whose turn met the limit, as for Codex.
   */
  async #fireDevinContinue(sessionId: string): Promise<void> {
    const held = this.#devinLimits.get(sessionId);
    if (!held || this.#shuttingDown) return;
    const due = usageLimitContinue(held.limit, this.#bootId);
    if (due === "never") return;
    if (due === "wait") return this.#armDevinLimit(sessionId, held.limit);
    if (due === "stale")
      return this.#armDevinLimit(sessionId, { ...held.limit, continueAt: null, manual: "stale" });
    const requestId = randomUUID();
    this.#armDevinLimit(
      sessionId,
      { ...held.limit, continueAt: null, autoContinues: held.limit.autoContinues + 1 },
      requestId,
      false,
    );
    const live = await this.#devinLive(sessionId).catch(() => null);
    if (!live || live.status !== "idle" || live.sendEnabled !== true)
      // Something else runs: look again shortly.
      return this.#armDevinLimit(sessionId, { ...held.limit, continueAt: Date.now() + 60_000 });
    const result = (await this.managedControl({
      operation: "send",
      sessionId,
      requestId,
      ...(held.limit.deviceId ? { deviceId: held.limit.deviceId } : {}),
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text: AUTO_CONTINUE_TEXT.devin,
    }).catch(() => null)) as Record<string, unknown> | null;
    const current = this.#devinLimits.get(sessionId);
    if (result?.accepted !== true && current?.continuing === requestId)
      // Refused: the person continues.
      this.#armDevinLimit(sessionId, { ...current.limit, manual: "stale" });
  }

  /**
   * The person's choice about a Devin session's continue: off this time (`usage-limit-cancel`),
   * or on. Armed again, it goes in the name of the device that asked.
   */
  #devinLimitChoice(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    choose: (limit: UsageLimit) => UsageLimit | null,
  ): Record<string, unknown> {
    const held = this.#devinLimits.get(request.sessionId);
    const next = held && !held.continuing ? choose(held.limit) : null;
    if (!next) throw new Error("usage-limit-continue-unavailable");
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.store.sessions.get(request.sessionId)?.workspace_id ?? null,
        runtimeBootId: request.runtimeBootId,
        expectedRevision: request.expectedRevision,
        executionMode: DEVIN_EXECUTION_MODE,
        turnId: null,
        nativeRequestId: null,
      },
    );
    if (claimed) return claimed;
    this.#armDevinLimit(request.sessionId, next);
    const result = {
      sessionId: request.sessionId,
      accepted: true,
      completed: true,
      requestId: request.requestId,
      runtimeBootId: this.#bootId,
    };
    finishManagedCommand(this.dataDir, request.requestId, result);
    return result;
  }

  /**
   * A Devin row of the catalog while AgentKib holds the session's runner. Its turns run in a
   * `devin -p` AgentKib started, which quitting ends, so the home, menu bar, push and the quit
   * confirmation count a running one as they do the other agents' turns.
   */
  #devinContinuation<T extends { id: string }>(session: T): T {
    const live = this.#devinRunners.get(session.id)?.runner.snapshot();
    if (!live) return session;
    return {
      ...session,
      continuation: {
        // A turn being stopped runs until its process exits.
        status: live.status === "running" || live.status === "stopping" ? "running" : "idle",
        executionLocation: "agentkib",
        ownershipReason: null,
        reason: live.reason ?? null,
      },
    };
  }

  /**
   * An Antigravity row of the catalog while AgentKib holds the session's ACP runner, as for
   * Devin: its turns run in the `antigravity` process AgentKib started, which quitting ends. A
   * turn waiting for a permission waits for the person, as a Codex approval does.
   */
  #antigravityContinuation<T extends { id: string }>(session: T): T {
    const live = this.#antigravityRunners.get(session.id)?.runner.snapshot();
    if (!live) return session;
    const status =
      live.status === "running"
        ? "running"
        : live.status === "waiting-approval"
          ? "awaiting-approval"
          : live.status === "outcome-unknown"
            ? "outcome-unknown"
            : "idle";
    return {
      ...session,
      continuation: {
        status,
        executionLocation: "agentkib",
        ownershipReason: null,
        reason:
          status === "outcome-unknown"
            ? "control-outcome-unconfirmed"
            : typeof live.reason === "string"
              ? live.reason
              : null,
      },
    };
  }

  #addDevinRunner(
    sessionId: string,
    runner: DevinManagedRunner,
    settings: DevinTurnSettings,
    workspaceId: string,
  ) {
    if (this.#devinRunners.size >= 8) {
      const [retireId, retire] =
        [...this.#devinRunners.entries()]
          .filter(([, value]) => value.runner.snapshot().sendEnabled === true)
          .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-limit");
      this.#devinRunners.delete(retireId);
      retire.runner.close();
    }
    const record = { runner, lastUsed: Date.now(), settings, workspaceId };
    this.#devinRunners.set(sessionId, record);
    return record;
  }

  async #devinRunner(sessionId: string) {
    const existing = this.#devinRunners.get(sessionId);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const resolved = await this.sessions.resolve(sessionId);
    if (resolved.native.agent !== "devin") throw new Error("session-unavailable");
    const workspaceId = resolved.summary.workspace_id;
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const runner = new DevinManagedRunner(
      workspace,
      resolved.native.native_ref,
      this.#devinHost(workspace, workspaceId, () => sessionId),
    );
    // Without a saved choice a resumed turn keeps the session's model and edits the workspace.
    const record = this.#addDevinRunner(
      sessionId,
      runner,
      this.#devinSaved().get(resolved.native.native_ref),
      workspaceId,
    );
    this.#showDevinLimit(sessionId, runner);
    return record;
  }

  async #devinLive(sessionId: string): Promise<Record<string, unknown>> {
    try {
      const record = await this.#devinRunner(sessionId);
      return {
        ...record.runner.snapshot(),
        sessionId,
        runtimeBootId: this.#bootId,
        // Restricted devices may control sessions in their workspaces only.
        workspaceId: record.workspaceId,
      };
    } catch (error) {
      return {
        sessionId,
        executionMode: DEVIN_EXECUTION_MODE,
        runtimeBootId: this.#bootId,
        workspaceId: this.store.sessions.get(sessionId)?.workspace_id ?? null,
        status: "unsupported",
        revision: 0,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        reason: error instanceof Error ? error.message : "open-in-original-client",
      };
    }
  }

  async #devinQuery(request: z.infer<typeof managedQuerySchema>) {
    const live = await this.#devinLive(request.sessionId);
    const experimental = request.experimentalEnabled === true;
    const canStageSettings = this.#devinRunners.get(request.sessionId)?.runner.canStageSettings;
    const held = this.#devinLimits.get(request.sessionId);
    const limitChoice = (available: boolean) =>
      experimental && available && !held?.continuing && live.status !== "unsupported"
        ? { available: true }
        : { available: false, reason: "usage-limit-continue-unavailable" };
    const reason =
      live.status === "unsupported"
        ? String(live.reason)
        : experimental
          ? ((live.reason as string | null) ?? null)
          : "control-disabled";
    const unsupported = { available: false, reason: "unsupported-operation" };
    const features = {
      send:
        experimental && live.sendEnabled === true
          ? { available: true }
          : { available: false, reason: reason ?? "session-busy" },
      stop:
        experimental && live.stopEnabled === true
          ? { available: true }
          : { available: false, reason: reason ?? "session-not-running" },
      "settings-state": { available: live.status !== "unsupported" },
      // Host workspace browsing has no native resource-attachment support.
      resources: { available: live.status !== "unsupported" },
      files: { available: live.status !== "unsupported" },
      context: unsupported,
      settings:
        experimental && canStageSettings
          ? { available: true }
          : { available: false, reason: reason ?? "session-unavailable" },
      // Devin runs a turn without asking: there is nothing to approve or answer mid-turn.
      approve: unsupported,
      answer: unsupported,
      inspect: { available: live.status !== "unsupported" },
      resume: unsupported,
      usage: { available: false, reason: "usage-not-reported" },
      // The continue armed after a usage limit, once Devin's `/usage` said when it resets.
      "usage-limit-cancel": limitChoice(typeof held?.limit.continueAt === "number"),
      "usage-limit-continue": limitChoice(usageLimitArmable(held?.limit, this.#bootId)),
    };
    const base = {
      sessionId: request.sessionId,
      executionMode: DEVIN_EXECUTION_MODE,
      runtimeBootId: this.#bootId,
      status: live.status,
      reason: live.reason,
    };
    return request.operation === "capabilities"
      ? { ...base, features }
      : { ...base, revision: live.revision, turnId: live.turnId, approvals: [] };
  }

  async #devinControl(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
    beforeNativeDispatch?: () => void,
  ) {
    const runtimeBootId = this.#bootId;
    if (!request.experimentalEnabled || request.runtimeBootId !== runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (
      !["send", "stop", "settings", "usage-limit-cancel", "usage-limit-continue"].includes(
        request.operation,
      )
    )
      throw new Error("unsupported-operation");
    if (
      request.operation === "usage-limit-cancel" ||
      request.operation === "usage-limit-continue"
    ) {
      // The runner shows the hold, also one kept from before a restart.
      const record = await this.#devinRunner(request.sessionId);
      if (request.expectedRevision !== record.runner.snapshot().revision)
        throw new Error("stale-or-disabled-control");
      return request.operation === "usage-limit-cancel"
        ? this.#devinLimitChoice(request, fingerprint, (limit) =>
            limit.continueAt === null ? null : { ...limit, continueAt: null, manual: "cancelled" },
          )
        : this.#devinLimitChoice(request, fingerprint, (limit) => {
            const armed = armUsageLimit(limit, { bootId: runtimeBootId });
            return armed && request.deviceId ? { ...armed, deviceId: request.deviceId } : armed;
          });
    }
    if (
      request.operation === "settings" &&
      request.model !== undefined &&
      !/^[A-Za-z0-9._:@/+-]{1,128}$/.test(request.model)
    )
      throw new Error("unsupported-model");
    // `devin -p` takes text only; attachments are refused rather than dropped.
    if (request.input?.length || request.historyReferences?.length || request.resourceRefs?.length)
      throw new Error("attachments-unsupported");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const record = await this.#devinRunner(request.sessionId);
    if (request.expectedRevision !== record.runner.snapshot().revision)
      throw new Error("stale-or-disabled-control");
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.store.sessions.get(request.sessionId)?.workspace_id ?? null,
        runtimeBootId,
        expectedRevision: request.expectedRevision,
        turnId: request.turnId ?? null,
        executionMode: DEVIN_EXECUTION_MODE,
        ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
      },
    );
    if (claimed) return claimed;
    let dispatched = false;
    const beforeDispatch = () => {
      beforeNativeDispatch?.();
      dispatchManagedCommand(this.dataDir, request.requestId);
      dispatched = true;
      if (request.operation !== "send") return;
      // The person's message takes over from a continue armed after a usage limit; the turn it
      // starts clears what the live state shows.
      const held = this.#devinLimits.get(request.sessionId);
      if (held && held.continuing !== request.requestId)
        this.#armDevinLimit(request.sessionId, null, undefined, false);
      if (request.deviceId) this.#devinSenders.set(request.sessionId, request.deviceId);
    };
    try {
      if (request.operation === "send") {
        if (typeof request.text !== "string") throw new Error("missing-text");
        await record.runner.send(
          request.text,
          request.expectedRevision,
          beforeDispatch,
          record.settings,
        );
      } else if (request.operation === "settings") {
        const { runner } = record;
        const nativeId = runner.nativeId;
        if (!nativeId || !runner.canStageSettings) throw new Error("session-unavailable");
        let model = request.model ?? record.settings.model;
        if (
          !request.resetDefaults &&
          (request.effort !== undefined || request.serviceTier !== undefined)
        ) {
          const catalog = await this.#readDevinCatalog();
          if (
            this.#devinRunners.get(request.sessionId) !== record ||
            !runner.canStageSettings ||
            runner.snapshot().revision !== request.expectedRevision
          )
            throw new Error("stale-or-disabled-control");
          model = devinSettingsModel(
            request,
            catalog,
            record.settings.model,
            this.sessions.devinSessionModel(nativeId),
          );
        }
        beforeDispatch();
        this.#devinSaved().set(
          nativeId,
          request.resetDefaults
            ? {}
            : {
                ...(model ? { model } : {}),
                permissionMode: request.permissionMode ?? record.settings.permissionMode,
              },
        );
        record.settings = this.#devinSaved().get(nativeId);
        runner.bump();
      } else {
        if (typeof request.turnId !== "string") throw new Error("missing-turn");
        await record.runner.stop(request.turnId, request.expectedRevision, beforeDispatch);
      }
      record.lastUsed = Date.now();
      const result = {
        accepted: true,
        // A settings change is applied when it is saved; the next turn runs with it.
        completed: request.operation === "settings",
        ...(request.operation === "settings" ? { appliesTo: "next-turn" } : {}),
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId,
      };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      const result = {
        accepted: false,
        completed: false,
        sessionId: request.sessionId,
        controlOutcome: dispatched ? "unknown" : "not-dispatched",
        reason: error instanceof Error ? error.message : "control-preflight-rejected",
        requestId: request.requestId,
        runtimeBootId,
      };
      if (!dispatched) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  /**
   * Starts a Devin session with its first message and answers once Devin has stored it, so the
   * new session opens already running. Its model and permission mode apply to later turns too.
   */
  devinCreate(value: Record<string, unknown>) {
    return this.#sessionProviders.require("devin").create(value);
  }

  async #devinCreate(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = devinCreateSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const replay = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (replay) return replay;
    const result = (outcome: "accepted" | "not-dispatched" | "unknown", extra = {}) => ({
      accepted: outcome === "accepted",
      completed: outcome === "accepted",
      requestId: request.requestId,
      runtimeBootId: this.#bootId,
      executionMode: DEVIN_EXECUTION_MODE,
      controlOutcome: outcome,
      ...extra,
    });
    let workspace: string;
    try {
      workspace = canonicalize(this.store.workspacePath(request.workspaceId));
    } catch {
      return result("not-dispatched", { reason: "workspace-unavailable" });
    }
    let created: string | null = null;
    const runner = new DevinManagedRunner(
      workspace,
      null,
      this.#devinHost(workspace, request.workspaceId, () => created),
    );
    const prior = claimManagedCommand(
      this.dataDir,
      request.requestId,
      `devin-create:${request.requestId}`,
      fingerprint,
      request.deviceId,
      {
        operation: "create",
        workspaceId: request.workspaceId,
        runtimeBootId: this.#bootId,
        executionMode: DEVIN_EXECUTION_MODE,
        claimedAt: Date.now(),
      },
    );
    if (prior) return prior;
    let dispatched = false;
    try {
      const model =
        request.effort !== undefined || request.serviceTier !== undefined
          ? devinSettingsModel(request, await this.#readDevinCatalog())
          : request.model;
      const settings: DevinTurnSettings = {
        ...(model ? { model } : {}),
        permissionMode: request.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE,
      };
      await runner.send(
        request.prompt,
        0,
        () => {
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
        settings,
      );
      let timer: NodeJS.Timeout | undefined;
      const nativeId = await Promise.race([
        runner.session(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("devin-session-unconfirmed")), 120_000);
        }),
      ]).finally(() => clearTimeout(timer));
      // Index it now so that its ID resolves before the next catalog refresh.
      this.store.sessions.sync(
        request.workspaceId,
        "devin",
        (await this.sessions.list("devin", workspace)).sessions,
        true,
      );
      created = this.store.sessions.id("devin", nativeId);
      // The choices made when it started apply to its later turns too, also after a restart.
      if (model || request.permissionMode)
        this.#devinSaved().set(nativeId, {
          ...(model ? { model } : {}),
          ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        });
      this.#addDevinRunner(created, runner, settings, request.workspaceId);
      // Its first turn runs already: the catalog lists it in progress without waiting for it.
      this.catalogChanged?.();
      const outcome = result("accepted", { sessionId: created });
      finishManagedCommand(this.dataDir, request.requestId, outcome);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "control-preflight-rejected";
      // A turn that ended without storing a session made nothing, so it may be sent again.
      if (!dispatched || reason !== "devin-session-unconfirmed") {
        runner.close();
        const outcome = result("not-dispatched", { reason });
        finishManagedCommand(this.dataDir, request.requestId, outcome);
        return outcome;
      }
      return result("unknown", { reason: "control-outcome-unconfirmed" });
    }
  }

  #devinModels: { at: number; catalog: DevinModelCatalog } | undefined;

  async #devinContextUsage(sessionId: string): Promise<ContextUsage> {
    const settings = await this.#devinSettingsState(sessionId);
    return normalizeContextUsage({
      usage: settings.historicalUsage ?? (settings.available ? { available: false } : undefined),
      reason: settings.reason,
    });
  }

  /**
   * A Devin session's settings in the shape the composer reads for managed sessions: the model
   * and permission mode its next turn runs with. Without a saved model a resumed turn keeps the
   * one Devin saved for the session.
   */
  async #devinSettingsState(sessionId: string): Promise<Record<string, unknown>> {
    let record: Awaited<ReturnType<WebReadRequests["devinRunnerFor"]>>;
    try {
      record = await this.devinRunnerFor(sessionId);
    } catch (error) {
      return {
        available: false,
        executionMode: DEVIN_EXECUTION_MODE,
        revision: 0,
        reason: error instanceof Error ? error.message : "session-unavailable",
      };
    }
    const catalog = await this.#readDevinCatalog();
    const options = devinModelOptions(catalog);
    const live = record.runner.snapshot();
    const nativeId = record.runner.nativeId;
    const nativeModel = nativeId ? this.sessions.devinSessionModel(nativeId) : null;
    const project = (settings: Readonly<DevinTurnSettings>) => {
      const selectedModel = settings.model ?? nativeModel;
      const variant = devinSelectedVariant(catalog, selectedModel, nativeModel);
      // An exact variant outside the family controls gets its own catalog row if available.
      const exact = variant && options.models.some((option) => option.id === variant.id);
      const model = variant ? (exact ? variant.id : variant.familyId) : selectedModel;
      const capacity =
        variant?.maxContextTokens ??
        options.models.find((option) => option.id === model)?.maxContextTokens;
      return {
        model,
        effort: variant?.effort ?? null,
        ...(variant?.serviceTierId ? { serviceTier: variant.serviceTierId } : {}),
        ...(variant ? { variantId: variant.id } : {}),
        ...(capacity !== undefined ? { maxContextTokens: capacity } : {}),
        permissionMode: settings.permissionMode ?? DEVIN_DEFAULT_PERMISSION_MODE,
      };
    };
    const selected = project(record.settings);
    const running = record.runner.runningSettings;
    const current = running ? project(running) : selected;
    const capacity = selected.maxContextTokens;
    const historicalUsage =
      nativeId &&
      nativeModel &&
      selected.variantId === nativeModel &&
      capacity !== undefined &&
      live.status === "idle"
        ? this.sessions.devinLastContextInput(nativeId, record.runner.workspace, nativeModel)
        : undefined;
    const mutable = record.runner.canStageSettings;
    return {
      available: true,
      executionMode: DEVIN_EXECUTION_MODE,
      revision: live.revision,
      current,
      selected,
      settings: selected,
      defaults: { model: null, effort: null, permissionMode: DEVIN_DEFAULT_PERMISSION_MODE },
      applicationStatus: "confirmed",
      ...options,
      ...(historicalUsage && capacity !== undefined && historicalUsage.usedTokens <= capacity
        ? {
            historicalUsage: {
              available: true,
              state: "stale",
              historical: true,
              reason: "devin-last-model-request",
              contextWindow: capacity,
              ...historicalUsage,
            },
          }
        : {}),
      permissionModes: DEVIN_PERMISSION_MODES.map((id) => ({ id, name: id })),
      writable: {
        model: { available: mutable && options.models.length > 0 },
        effort: { available: mutable && options.models.some((model) => model.efforts.length > 0) },
        serviceTier: { available: mutable && options.serviceTiers.length > 0 },
        permissionMode: { available: mutable },
        restoreDefaults: { available: mutable },
      },
    };
  }

  devinRunnerFor(sessionId: string) {
    return this.#devinRunner(sessionId);
  }

  /**
   * What a new Devin session can start with. Without a CLI login the list is empty and Devin's
   * configured default applies; the login is explained only when a session is started.
   */
  devinOptions() {
    return this.sessionProviderOptions("devin");
  }

  async #devinOptions(): Promise<Record<string, unknown>> {
    const environment = devinChildEnvironment({ ...process.env, ...this.environment });
    const executable = devinExecutable(environment);
    if (!executable) return { available: false, reason: "devin-cli-unavailable" };
    return {
      available: true,
      permissionModes: DEVIN_PERMISSION_MODES.map((id) => ({ id })),
      ...devinModelOptions(await this.#devinCatalog(executable, environment)),
    };
  }

  async #readDevinCatalog() {
    const environment = devinChildEnvironment({ ...process.env, ...this.environment });
    const executable = devinExecutable(environment);
    return executable ? this.#devinCatalog(executable, environment) : emptyDevinModelCatalog();
  }

  async #devinCatalog(executable: string, environment: NodeJS.ProcessEnv) {
    if (!this.#devinModels || Date.now() - this.#devinModels.at > 10 * 60_000)
      this.#devinModels = {
        at: Date.now(),
        catalog: await devinModelCatalog(executable, environment),
      };
    return this.#devinModels.catalog;
  }

  async #desktopFollower(record: ManagedRecord): Promise<CodexFollowerRecord> {
    if (!CodexFollowerConnection.supported()) throw new Error("platform-unsupported");
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(record);
    const nativeId = record.native_id;
    const sessionId = record.id;
    const cached = this.#codexFollowers.get(sessionId);
    if (
      cached?.bridge.connected &&
      cached.nativeId === nativeId &&
      cached.workspaceId === record.workspace_id
    ) {
      cached.lastUsed = Date.now();
      return cached;
    }
    if (cached) {
      this.#codexFollowers.delete(sessionId);
      cached.bridge.close();
    }

    const pending = this.#codexFollowerFlights.get(sessionId);
    if (pending) return pending;
    const flight = this.#connectCodexFollower(record, workspace, nativeId, home);
    this.#codexFollowerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#codexFollowerFlights.get(sessionId) === flight)
        this.#codexFollowerFlights.delete(sessionId);
    }
  }

  async #connectCodexFollower(
    record: ManagedRecord,
    workspace: string,
    nativeId: string,
    home: string,
  ): Promise<CodexFollowerRecord> {
    const sessionId = record.id;
    if (this.#codexFollowers.size >= 8) {
      const candidates = [...this.#codexFollowers.entries()]
        .filter(
          ([id, value]) =>
            id !== sessionId &&
            !this.isSessionObserved?.(id) &&
            value.bridge.selectedState?.status === "idle" &&
            value.bridge.selectedState.approvals(false).length === 0,
        )
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const [retireId, retire] = candidates[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-busy");
      this.#codexFollowers.delete(retireId);
      retire.bridge.close();
    }
    let bridge: CodexFollowerBridge | undefined;
    const stream = new CodexFollowerStream();
    const watch = { running: new Set<string>(), waiting: "" };
    const publish = (snapshot: ReturnType<CodexFollowerState["streamSnapshot"]>) => {
      const state = bridge?.selectedState;
      if (!state) return;
      const live = this.#followerLive(record, state, true);
      stream.publish(snapshot, live, (type, payload, live, item) =>
        this.publishConversationEvent?.(sessionId, type, payload, live, item),
      );
      this.#observeFollowedLane(sessionId, state, live, watch);
    };
    bridge = await CodexFollowerBridge.connect(
      path.join(home, "ipc", "ipc.sock"),
      nativeId,
      publish,
    );
    try {
      const latest =
        readManagedRecords(this.dataDir, this.store).find((item) => item.id === sessionId) ??
        (await this.#inactiveRecord(sessionId));
      if (latest.native_id !== nativeId || latest.workspace_id !== record.workspace_id)
        throw new Error("session-unavailable");
      const follower = {
        bridge,
        stream,
        workspaceId: record.workspace_id,
        workspace,
        nativeId,
        lastUsed: Date.now(),
      };
      this.#codexFollowers.set(sessionId, follower);
      if (bridge.selectedState) publish(bridge.selectedState.streamSnapshot());
      return follower;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }

  /**
   * A turn of a session the Codex app runs, seen through its follower: a lead hears that it
   * ended, or waits for the person, as of the turns AgentKib runs. Only turns this follower saw
   * running count as ended.
   */
  #observeFollowedLane(
    sessionId: string,
    state: CodexFollowerState,
    live: Record<string, unknown>,
    watch: { running: Set<string>; waiting: string },
  ): void {
    if (!this.#laneObserver) return;
    for (const turn of state.turnOutcomes()) {
      if (turn.running) watch.running.add(turn.turnId);
      else if (watch.running.delete(turn.turnId) && turn.meta) {
        const { outcome, duration_ms } = turn.meta;
        this.#observeLane((observer) =>
          observer.turnEnded(
            sessionId,
            turn.turnId,
            outcome === "aborted" ? "cancelled" : (outcome ?? "ended"),
            duration_ms ?? null,
          ),
        );
      }
    }
    const waiting =
      live.status === "awaiting-approval" || live.status === "waiting-input"
        ? `${String(live.turnId ?? "")}:${String(live.status)}`
        : "";
    if (waiting && waiting !== watch.waiting)
      this.#observeLane((observer) =>
        observer.waiting(
          sessionId,
          typeof live.turnId === "string" ? live.turnId : null,
          String(live.status),
        ),
      );
    watch.waiting = waiting;
  }

  /** A connected follower still tracking the record's native conversation with a valid snapshot. */
  #attachedCodexFollower(record: {
    id: string;
    native_id?: string | null;
  }): CodexFollowerRecord | undefined {
    const follower = this.#codexFollowers.get(record.id);
    return follower?.bridge.connected &&
      follower.nativeId === record.native_id &&
      (follower.bridge.selectedState?.revision ?? null) !== null
      ? follower
      : undefined;
  }

  #followerLive(
    record: ManagedRecord,
    state: CodexFollowerState,
    controls: boolean,
  ): Record<string, unknown> {
    const unknown = managedSessionHasUnknownCommands(this.dataDir, record.id);
    const live = state.live(controls && !unknown);
    return {
      ...live,
      ...(record.snapshot?.settingsStaged === true ? { sendEnabled: false } : {}),
      // The follower transport does not forward user-input answers.
      questions: (Array.isArray(live.questions) ? live.questions : []).map((question) => ({
        ...question,
        supported: false,
      })),
      sessionId: record.id,
      runtimeBootId: this.#bootId,
      workspaceId: record.workspace_id,
      executionMode: "codex-follower",
      executionLocation: "external",
      connectionGeneration: state.settingsWriteScope,
      ownershipReason: null,
      ...(unknown
        ? { reason: "control-outcome-unconfirmed", sendEnabled: false, stopEnabled: false }
        : {}),
    };
  }

  async #desktopFollowerLive(
    record: ManagedRecord,
    inactive: Record<string, unknown>,
    controls: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      inactive.ownershipReason !== "codex-owner-busy" ||
      (inactive.reason !== "codex-owner-busy" &&
        (inactive.reason !== "control-outcome-unconfirmed" ||
          !readUnknownManagedCommands(this.dataDir, record.id).some(
            ({ evidence }) =>
              evidence?.operation === "settings" && evidence.executionMode === "codex-follower",
          )))
    )
      return undefined;
    if (!CodexFollowerConnection.supported()) return undefined;
    const miss = this.#followerMisses.get(record.id);
    if (miss !== undefined && Date.now() - miss < FOLLOWER_RETRY_MS) return undefined;
    try {
      const follower = await this.#desktopFollower(record);
      const state = await follower.bridge.observeLive();
      follower.lastUsed = Date.now();
      this.#ownerMissing.delete(record.id);
      return this.#followerLive(record, state, controls);
    } catch (error) {
      const follower = this.#codexFollowers.get(record.id);
      if (follower) {
        this.#codexFollowers.delete(record.id);
        follower.bridge.close();
      }
      this.#followerMisses.set(record.id, Date.now());
      if (codexOwnerMissing(error)) this.#ownerMissing.add(record.id);
      else this.#ownerMissing.delete(record.id);
      return undefined;
    }
  }

  /**
   * The Codex app's server holds the thread and no window answers for it: sending stays open,
   * and a send asks the app to show the thread (#desktopHandoff). The session still reads as in
   * use in Codex; `ownerHandoff` tells a client it may send. Not offered again for a minute
   * after the app did not take the thread.
   */
  async #desktopHandoffLive(
    record: ManagedRecord,
    inactive: Record<string, unknown>,
    controls: boolean,
  ): Promise<Record<string, unknown> | undefined> {
    const failed = this.#handoffFailures.get(record.id);
    if (
      !controls ||
      inactive.reason !== "codex-owner-busy" ||
      inactive.ownershipReason !== "codex-owner-busy" ||
      !record.native_id ||
      record.snapshot?.settingsStaged === true ||
      !this.#ownerMissing.has(record.id) ||
      (failed !== undefined && Date.now() - failed < 60_000) ||
      !CodexFollowerConnection.supported() ||
      managedSessionHasUnknownCommands(this.dataDir, record.id)
    )
      return undefined;
    if (!(await this.#desktopApp.running())) return undefined;
    return { ...inactive, sendEnabled: true, ownerHandoff: true };
  }

  /**
   * Asks the running Codex app to show a thread its server holds with no window answering for
   * it, then follows the app. Only a send asks: opening the session in AgentKib must not move
   * the app's page. Never launches the app, never takes the writer lock and sends nothing by
   * itself; undefined leaves the session in use in Codex.
   */
  async #desktopHandoff(
    record: ManagedRecord,
  ): Promise<{ follower: CodexFollowerRecord; revision: number } | undefined> {
    if (!CodexFollowerConnection.supported() || !record.native_id) return undefined;
    const pending = this.#handoffFlights.get(record.id);
    if (pending) return pending;
    const flight = this.#runDesktopHandoff(record, record.native_id);
    this.#handoffFlights.set(record.id, flight);
    try {
      const handed = await flight;
      if (handed) this.#handoffFailures.delete(record.id);
      else this.#handoffFailures.set(record.id, Date.now());
      return handed;
    } finally {
      if (this.#handoffFlights.get(record.id) === flight) this.#handoffFlights.delete(record.id);
    }
  }

  async #runDesktopHandoff(
    record: ManagedRecord,
    nativeId: string,
  ): Promise<{ follower: CodexFollowerRecord; revision: number } | undefined> {
    const attach = async () => {
      try {
        const follower = await this.#desktopFollower(record);
        const state = await follower.bridge.observeLive();
        follower.lastUsed = Date.now();
        this.#ownerMissing.delete(record.id);
        this.#followerMisses.delete(record.id);
        return state.revision === null ? undefined : { follower, revision: state.revision };
      } catch (error) {
        const follower = this.#codexFollowers.get(record.id);
        if (follower) {
          this.#codexFollowers.delete(record.id);
          follower.bridge.close();
        }
        return codexOwnerMissing(error) ? ("missing" as const) : undefined;
      }
    };
    // A window may have opened the thread since the session was last looked at.
    const first = await attach();
    if (first !== "missing") return first;
    if (!(await this.#desktopApp.running()) || !(await this.#desktopApp.openThread(nativeId)))
      return undefined;
    const deadline = Date.now() + this.#handoffTimeoutMs;
    while (Date.now() < deadline && !this.#shuttingDown) {
      await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
      const attached = await attach();
      if (attached !== "missing") return attached;
    }
    return undefined;
  }

  async #resumeCommand(sessionId: string) {
    const generation = this.indexGeneration();
    const target = async () => {
      const record = await this.#inactiveRecord(sessionId);
      const nativeId = record.native_id;
      if (
        !nativeId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)
      )
        throw new Error("unverified-session-identity");
      // resolve() returns the registered root for ordinary indexed sessions. Preserve
      // the native subdirectory, proven by both SQLite and the bounded rollout header.
      const identity = this.sessions.verifiedCodexResumeIdentity(nativeId);
      if (!identity || identity.id !== nativeId.toLowerCase())
        throw new Error("unverified-session-identity");
      const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
      const home = canonicalize(record.home);
      const cwd = canonicalize(identity.cwd);
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(record);
      if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");
      const directories = [workspace, home, cwd].map((directory) => {
        const info = statSync(directory);
        if (!info.isDirectory()) throw new Error("codex-context-unavailable");
        return [pathIdentity(directory), info.dev, info.ino];
      });
      return {
        cwd,
        home,
        nativeId,
        key: JSON.stringify([record.workspace_id, nativeId, directories]),
      };
    };
    const before = await target();
    const after = await target();
    if (generation !== this.indexGeneration() || before.key !== after.key)
      throw new Error("session-unavailable");
    // This read deliberately performs no CLI/version check, native RPC, or lock probe.
    return codexResumeCommand(after.cwd, after.home, after.nativeId);
  }

  /**
   * The directory a session's relative file references were written against. It only
   * places those references: callers resolve them inside their own file grant, so this
   * read neither verifies nor starts anything. Null means the registered root.
   */
  #sessionDirectory(sessionId: string): { cwd: string | null } {
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (managed) {
      let cwd = managed.cwd;
      // Older ledgers kept only the root; the native rollout header has the directory.
      if (cwd === undefined && managed.native_id)
        try {
          cwd = this.sessions.verifiedCodexControlDirectory(managed.native_id)?.cwd;
        } catch {
          cwd = undefined;
        }
      return { cwd: cwd ?? null };
    }
    return { cwd: this.store.sessions.directories([sessionId]).get(sessionId)?.cwd ?? null };
  }

  async #context(sessionId: string) {
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    let workspaceId: string;
    let workspace: string;
    let nativeId: string | null;
    if (managed) {
      workspaceId = managed.workspace_id;
      workspace = canonicalize(this.store.workspacePath(workspaceId));
      nativeId = managed.native_id ?? null;
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(managed);
    } else {
      const summary = this.store.sessions.get(sessionId);
      if (!summary) throw new Error("session-unavailable");
      if (summary.agent !== "codex") throw new Error("session-not-codex");
      const resolved = await this.sessions.resolve(sessionId);
      workspaceId = resolved.summary.workspace_id;
      workspace = canonicalize(resolved.workspace);
      nativeId = resolved.native.native_ref;
      if (!this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
        throw new Error("unverified-session-identity");
    }
    if (!nativeId) return { available: false, reason: "native-session-unverified" };
    const executionCwd = this.#managedCwd(managed ?? (await this.#inactiveRecord(sessionId)));
    const executable = this.#codexReader();
    if (!executable) throw new Error("codex-cli-unavailable");
    let codexHome: string;
    try {
      codexHome = canonicalize(this.sessions.codexHome());
    } catch {
      throw new Error("codex-home-unavailable");
    }
    const response = await this.#codex.readThread(executable, executionCwd, codexHome, nativeId);
    const thread = isObject(response) ? response.thread : null;
    if (!isObject(thread) || thread.id !== nativeId) throw new Error("thread-identity-mismatch");
    if (
      pathIdentity(canonicalize(this.store.workspacePath(workspaceId))) !== pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");
    if (typeof thread.cwd !== "string") throw new Error("codex-context-unavailable");
    let cwd: string;
    try {
      cwd = canonicalize(thread.cwd);
    } catch {
      throw new Error("codex-context-unavailable");
    }
    if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");
    return {
      available: true,
      cwd,
      projectId: boundedText(thread.projectId, 128),
      branchAtCreation: boundedText(isObject(thread.gitInfo) ? thread.gitInfo.branch : null, 256),
    };
  }

  async #resources(sessionId: string) {
    const indexed = this.store.sessions.get(sessionId);
    if (indexed?.agent === "devin") {
      const source = await this.sessions.resolve(sessionId);
      const workspace = canonicalize(this.store.workspacePath(indexed.workspace_id));
      const latest = this.store.sessions.get(sessionId);
      if (
        source.native.agent !== "devin" ||
        source.native.sidechain ||
        !latest ||
        latest.agent !== "devin" ||
        latest.workspace_id !== indexed.workspace_id ||
        source.summary.workspace_id !== indexed.workspace_id ||
        pathIdentity(canonicalize(source.workspace)) !== pathIdentity(workspace)
      )
        throw new Error("session-workspace-mismatch");
      return {
        available: true,
        executionMode: DEVIN_EXECUTION_MODE,
        revision: this.#devinRunners.get(sessionId)?.runner.snapshot().revision ?? 0,
        skills: [],
        plugins: [],
        apps: [],
        contextReferences: { supportedTypes: [] },
      };
    }
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    const managed = stored ?? (await this.#inactiveRecord(sessionId));
    const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const codexHome = this.#assertManagedHome(managed);
    const executionCwd = this.#managedCwd(managed);
    const skills = await this.#readCodexSkills(executionCwd, codexHome);
    const latest = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (
      stored &&
      (!latest ||
        latest.workspace_id !== managed.workspace_id ||
        latest.native_id !== managed.native_id ||
        pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
        pathIdentity(canonicalize(latest.home)) !== pathIdentity(codexHome))
    )
      throw new Error("session-unavailable");
    return {
      available: true,
      executionMode: "codex-managed",
      skills,
      plugins: [],
      apps: [],
      contextReferences: {
        supportedTypes: ["computerPath", "skill"],
        unavailable: {
          plugin: "unsupported-codex-cli-version",
          app: "unsupported-codex-cli-version",
        },
      },
    };
  }

  async #codexWorkspaceResources(workspaceId: string) {
    const workspace = this.#checkedCodexDirectory(this.store.workspacePath(workspaceId));
    const home = canonicalize(this.sessions.codexHome());
    const skills = await this.#readCodexSkills(workspace, home);
    if (
      pathIdentity(this.#checkedCodexDirectory(this.store.workspacePath(workspaceId))) !==
        pathIdentity(workspace) ||
      pathIdentity(canonicalize(this.sessions.codexHome())) !== pathIdentity(home)
    )
      throw new Error("session-workspace-mismatch");
    return { skills };
  }

  async #readCodexSkills(executionCwd: string, codexHome: string) {
    const executable = this.#codexReader();
    if (!executable) throw new Error("codex-cli-unavailable");
    const result = await this.#codex.request(executable, executionCwd, codexHome, "skills/list", {
      cwds: [executionCwd],
      forceReload: false,
    });
    const entries = isObject(result) && Array.isArray(result.data) ? result.data : [];
    const skills: Record<string, unknown>[] = [];
    for (const entry of entries) {
      if (!isObject(entry) || typeof entry.cwd !== "string") continue;
      let cwd: string;
      try {
        cwd = canonicalize(entry.cwd);
      } catch {
        continue;
      }
      if (pathIdentity(cwd) !== pathIdentity(executionCwd) || !Array.isArray(entry.skills))
        continue;
      for (const skill of entry.skills.slice(0, 256)) {
        if (!isObject(skill) || typeof skill.path !== "string") continue;
        let skillPath: string;
        try {
          skillPath = canonicalize(skill.path);
        } catch {
          continue;
        }
        if (
          typeof skill.name !== "string" ||
          skill.name.length === 0 ||
          Buffer.byteLength(skill.name, "utf8") > 256
        )
          continue;
        skills.push({
          id: createHash("sha256").update(Buffer.from(skillPath, "utf8")).digest("hex"),
          name: skill.name,
          description: skill.description ?? null,
          enabled: skill.enabled === true,
          scope: skill.scope ?? null,
          pluginId: skill.pluginId ?? null,
        });
      }
    }
    return skills;
  }

  async #goal(sessionId: string) {
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    const managed = stored ?? (await this.#inactiveRecord(sessionId));
    const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(managed);
    const executionCwd = this.#managedCwd(managed);
    const storedGoal = isObject(managed.goal) ? managed.goal : null;
    const storedRevision = managed.snapshot?.revision ?? null;
    if (!managed.native_id)
      return {
        available: true,
        executionMode: "codex-managed",
        goal: storedGoal,
        revision: storedRevision,
        reason: "recovery-required",
      };

    let goal = storedGoal;
    let reason: string | null = null;
    const executable = this.#codexReader();
    if (!executable) {
      reason = "recovery-required";
    } else {
      let result: { thread: unknown; goal: unknown } | undefined;
      try {
        result = await this.#codex.readThreadGoal(
          executable,
          executionCwd,
          home,
          managed.native_id,
          (thread) => {
            if (typeof thread.cwd !== "string") throw new Error("codex-context-unavailable");
            let cwd: string;
            try {
              cwd = canonicalize(thread.cwd);
            } catch {
              throw new Error("codex-context-unavailable");
            }
            if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "thread-identity-mismatch",
            "codex-context-unavailable",
            "codex-context-outside-workspace",
          ].includes(error.message)
        )
          throw error;
        reason = "recovery-required";
      }
      if (result) {
        const thread = isObject(result.thread) ? result.thread.thread : null;
        if (!isObject(thread) || thread.id !== managed.native_id)
          throw new Error("thread-identity-mismatch");
        if (typeof thread.cwd !== "string") throw new Error("codex-context-unavailable");
        const cwd = canonicalize(thread.cwd);
        if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");
        goal = isObject(result.goal) && isObject(result.goal.goal) ? result.goal.goal : null;
      }
    }

    if (!stored)
      return {
        available: true,
        executionMode: "codex-managed",
        goal,
        revision: storedRevision,
        ...(reason ? { reason } : {}),
      };

    const latest = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (
      !latest ||
      latest.workspace_id !== managed.workspace_id ||
      latest.native_id !== managed.native_id ||
      pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
      pathIdentity(canonicalize(latest.home)) !== pathIdentity(home)
    )
      throw new Error("session-unavailable");
    let revision = latest.snapshot?.revision ?? null;
    if (!reason) {
      const persistedRevision = persistManagedGoal(
        this.dataDir,
        {
          id: managed.id,
          workspaceId: managed.workspace_id,
          nativeId: managed.native_id,
          workspace: managed.workspace,
          home: managed.home,
          goal: managed.goal ?? null,
        },
        goal,
      );
      if (persistedRevision === null) goal = isObject(latest.goal) ? latest.goal : null;
      else revision = persistedRevision;
    }
    return {
      available: true,
      executionMode: "codex-managed",
      goal,
      revision,
      ...(reason ? { reason } : {}),
    };
  }

  #assertManagedHome(record: ManagedRecord): string {
    let home: string;
    try {
      home = canonicalize(this.sessions.codexHome());
    } catch {
      throw new Error("codex-home-unavailable");
    }
    let recordedHome: string;
    try {
      recordedHome = canonicalize(record.home);
    } catch {
      throw new Error("codex-home-changed");
    }
    if (pathIdentity(home) !== pathIdentity(recordedHome)) throw new Error("codex-home-changed");
    return home;
  }

  #managedCwd(record: ManagedRecord): string {
    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    let value = record.cwd;
    if (value === undefined && record.native_id) {
      // Older ledgers stored only the registration root. Re-prove the native
      // directory instead of treating that broad root as execution authority.
      const identity = this.sessions.verifiedCodexControlDirectory(record.native_id);
      if (!identity || identity.id !== record.native_id.toLowerCase())
        throw new Error("codex-session-directory-unverified");
      value = identity.cwd;
    } else if (value === undefined && !record.adopted) {
      value = record.workspace;
    }
    const cwd = this.#checkedCodexDirectory(value);
    if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");
    record.cwd = cwd;
    return cwd;
  }

  #checkedCodexDirectory(value: string | undefined): string {
    if (!value || !path.isAbsolute(value)) throw new Error("codex-session-directory-unverified");
    let cwd: string;
    try {
      cwd = canonicalize(value);
      if (!statSync(cwd).isDirectory()) throw new Error("codex-session-directory-not-directory");
    } catch (error) {
      if (error instanceof Error && error.message === "codex-session-directory-not-directory")
        throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === "ENOENT" || code === "ENOTDIR"
          ? "codex-session-directory-missing"
          : "codex-session-directory-unavailable",
      );
    }
    const userHomes = [homedir(), this.environment.HOME, this.environment.USERPROFILE].filter(
      (home): home is string => typeof home === "string" && path.isAbsolute(home),
    );
    if (
      pathIdentity(cwd) === pathIdentity(path.parse(cwd).root) ||
      userHomes.some((home) => pathIdentity(cwd) === pathIdentity(home))
    )
      throw new Error("codex-session-directory-unsafe");
    return cwd;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CollaborationModeOption = { id: "plan" | "default"; name: string };

/**
 * The native Plan and Default presets (`collaborationMode/list`), or none unless both are listed:
 * a turn in either mode must be able to return to the other.
 */
function verifiedCollaborationModes(value: unknown): CollaborationModeOption[] {
  const rows = isObject(value) && Array.isArray(value.data) ? value.data : [];
  const modes: CollaborationModeOption[] = [];
  for (const row of rows) {
    if (!isObject(row) || (row.mode !== "plan" && row.mode !== "default")) continue;
    if (modes.some((mode) => mode.id === row.mode)) continue;
    if (typeof row.name !== "string" || !row.name || Buffer.byteLength(row.name, "utf8") > 256)
      continue;
    modes.push({ id: row.mode, name: row.name });
  }
  return modes.length === 2 ? modes : [];
}

/** A resume-local guard; public revisions and native settings ACKs stay intact. */
function managedControlState(state: ManagedCodexState): string {
  const live = state.snapshot("", true);
  delete live.revision;
  delete live.tokenUsage;
  delete live.usage;
  delete live.streamText;
  delete live.apiRetry;
  const record = { ...state.record };
  delete record.snapshot;
  delete record.token_usage;
  return stableJson({ live, record, mutationRevision: state.mutationRevision });
}

function managedPolicyCatalog() {
  return [
    {
      id: "workspace-write-on-request",
      name: "Workspace write · ask when needed",
      description: "Can edit the workspace; risky actions still require user approval.",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
    },
    {
      id: "full-access-on-request",
      name: "Full access · no approval prompts",
      description: "Can access the computer and network without prompting for approvals.",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      networkAccess: true,
    },
    {
      id: "workspace-write-auto-review",
      name: "Workspace write · agent review",
      description: "Can edit the workspace; the native agent reviews approval requests.",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      networkAccess: false,
    },
  ];
}

function codexCommandEvidence(request: SettingsControl, workspaceId: string) {
  return {
    operation: request.operation,
    turnId: request.turnId ?? null,
    nativeRequestId:
      request.operation === "approve"
        ? (request.approvalId ?? null)
        : request.operation === "answer"
          ? (request.questionId ?? null)
          : null,
    runtimeBootId: request.runtimeBootId,
    expectedRevision: request.expectedRevision,
    executionMode: "codex-managed",
    workspaceId,
    ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
  };
}

function changesCodexModel(request: SettingsControl): boolean {
  return (
    request.model !== undefined ||
    request.effort !== undefined ||
    request.serviceTier !== undefined ||
    request.resetDefaults === true
  );
}

function codexPolicyOnly(request: SettingsControl): SettingsControl["policyId"] {
  return request.operation === "settings" &&
    request.mode === undefined &&
    !changesCodexModel(request)
    ? request.policyId
    : undefined;
}

function hasStagedCodexModelSettings(record: ManagedRecord): boolean {
  return record.snapshot?.settingsStaged === true && record.snapshot.policyOnlyStaged !== true;
}

function codexCanSetNextTurn(status: unknown): boolean {
  return (
    status === "idle" ||
    status === "running" ||
    status === "awaiting-approval" ||
    status === "waiting-input"
  );
}

function codexSettingsMutation(
  request: SettingsControl,
  record: ManagedRecord,
  models: ManagedModelOption[],
) {
  const model = request.resetDefaults ? record.default_model : (request.model ?? record.model);
  const selected = model
    ? models.find((item) => item.id === model)
    : models.find((item) => item.isDefault);
  if (!selected) throw new Error("unsupported-model");
  const effort = request.resetDefaults
    ? record.default_effort
    : request.effort === undefined
      ? record.effort
      : request.effort;
  const serviceTier = request.resetDefaults
    ? record.default_service_tier
    : request.serviceTier === undefined
      ? record.service_tier
      : request.serviceTier;
  if (request.policyId && !managedPolicyCatalog().some((policy) => policy.id === request.policyId))
    throw new Error("unsupported-policy");
  const selection = {
    model: selected.id,
    effort,
    service_tier: serviceTier,
    policy_id: request.policyId ?? record.policy_id,
    mode: request.mode === undefined ? (record.mode ?? null) : request.mode,
  };
  validateManagedModelSelection(selection, models);
  return selection;
}

function validateManagedModelSelection(
  record: Pick<ManagedRecord, "model" | "effort" | "service_tier">,
  models: ManagedModelOption[],
): void {
  const selected = record.model
    ? models.find((model) => model.id === record.model)
    : models.find((model) => model.isDefault);
  if (record.model && !selected) throw new Error("unsupported-model");
  if (record.effort && !record.model) throw new Error("effort-requires-model");
  if (record.effort && !selected?.efforts.includes(record.effort))
    throw new Error("unsupported-effort");
  if (record.service_tier && !selected?.serviceTiers.includes(record.service_tier))
    throw new Error("unsupported-service-tier");
}

/** A catalog belongs to the CLI build that listed it, its CODEX_HOME and its directory. */
function codexCatalogKey(executable: string, home: string, cwd: string): string {
  const info = statSync(executable);
  return JSON.stringify([executable, info.mtimeMs, info.size, home, cwd]);
}

function projectManagedModels(value: unknown): ManagedModelOption[] {
  const rows = isObject(value) && Array.isArray(value.data) ? value.data : null;
  if (!rows) throw new Error("invalid-model-catalog");
  return rows
    .filter((model) => isObject(model) && model.hidden !== true)
    .slice(0, 100)
    .map((model) => {
      const row = model as Record<string, unknown>;
      return {
        id: typeof row.model === "string" ? row.model : "",
        isDefault: row.isDefault === true,
        defaultEffort:
          typeof row.defaultReasoningEffort === "string" ? row.defaultReasoningEffort : null,
        defaultServiceTier:
          typeof row.defaultServiceTier === "string" ? row.defaultServiceTier : null,
        efforts: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
              .filter(isObject)
              .map((effort: Record<string, unknown>) => effort.reasoningEffort)
              .filter((effort: unknown): effort is string => typeof effort === "string")
          : [],
        serviceTiers: Array.isArray(row.serviceTiers)
          ? row.serviceTiers
              .slice(0, 16)
              .filter(isObject)
              .map((tier: Record<string, unknown>) => tier.id)
              .filter((id: unknown): id is string => typeof id === "string")
          : [],
      };
    })
    .filter((model) => model.id.length > 0);
}

function managedResumeParams(record: ManagedRecord, workspace: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const params: Record<string, unknown> = { cwd: workspace, config };
  switch (record.policy_id ?? "workspace-write-on-request") {
    case "workspace-write-on-request":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    case "full-access-on-request":
      params.approvalPolicy = "never";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = { type: "dangerFullAccess" };
      params.sandbox = "danger-full-access";
      break;
    case "workspace-write-auto-review":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "auto_review";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    default:
      throw new Error("unsupported-policy");
  }
  return params;
}

function managedTurnMode(record: ManagedRecord): string | null {
  if (record.mode) return record.mode;
  const native = record.native_settings;
  if (record.effort != null || !isObject(native) || typeof native.effort !== "string") return null;
  const mode = isObject(native.collaborationMode) ? native.collaborationMode.mode : null;
  // A null top-level effort inherits the previous native effort. The confirmed mode's
  // settings replace it, without choosing a different mode on the user's behalf.
  if (mode !== "default" && mode !== "plan")
    throw new Error("native-collaboration-modes-unavailable");
  return mode;
}

function managedTurnSettings(record: ManagedRecord, workspace: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const params: Record<string, unknown> = { cwd: workspace, config };
  switch (record.policy_id ?? "workspace-write-on-request") {
    case "workspace-write-on-request":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    case "full-access-on-request":
      params.approvalPolicy = "never";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = { type: "dangerFullAccess" };
      params.sandbox = "danger-full-access";
      break;
    case "workspace-write-auto-review":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "auto_review";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    default:
      throw new Error("unsupported-policy");
  }
  if (record.model) params.model = record.model;
  if (record.effort) params.effort = record.effort;
  // Omission inherits the native thread's previous tier; null explicitly clears Fast.
  params.serviceTier = record.service_tier ?? null;
  const mode = managedTurnMode(record);
  if (mode) {
    params.collaborationMode = {
      mode,
      settings: {
        model: record.model,
        reasoning_effort: record.effort,
        developer_instructions: null,
      },
    };
  }
  return params;
}

function followerInput(
  input: unknown[] | undefined,
  text: string | undefined,
  resourceRefs: Array<{ kind: string; id?: string; relativePath?: string }> | undefined,
): Record<string, unknown>[] {
  if (input && text !== undefined) throw new Error("ambiguous-input");
  if (resourceRefs?.length) throw new Error("follower-resource-input-unsupported");
  const rows = input ? [...input] : text !== undefined ? [{ type: "text", text }] : [];
  if (rows.length === 0 || rows.length > 11) throw new Error("invalid-input-size");
  let textBytes = 0;
  const projected: Record<string, unknown>[] = [];
  for (const value of rows) {
    if (!isObject(value)) throw new Error("invalid-input-item");
    if (value.type === "text") {
      if (
        Object.keys(value).some((key) => !["type", "text", "text_elements"].includes(key)) ||
        typeof value.text !== "string" ||
        !value.text.trim() ||
        Buffer.byteLength(value.text, "utf8") > 16_384 ||
        (value.text_elements !== undefined &&
          (!Array.isArray(value.text_elements) || value.text_elements.length !== 0))
      )
        throw new Error("invalid-text-input");
      textBytes += Buffer.byteLength(value.text, "utf8");
      projected.push({ type: "text", text: value.text, text_elements: [] });
      continue;
    }
    if (value.type !== "localImage" && value.type !== "mention")
      throw new Error("unsupported-input-kind");
    if (
      Object.keys(value).some((key) => !["type", "path", "name"].includes(key)) ||
      typeof value.path !== "string" ||
      value.path.length > 4096 ||
      !path.isAbsolute(value.path) ||
      value.path.split(path.sep).includes("..")
    )
      throw new Error("invalid-file-input");
    const resolved = realpathSync(value.path);
    const file = statSync(resolved);
    if (resolved !== value.path || !file.isFile()) throw new Error("invalid-input-path");
    if (value.type === "mention") {
      if (
        typeof value.name !== "string" ||
        !value.name ||
        Buffer.byteLength(value.name, "utf8") > 255
      )
        throw new Error("invalid-input-name");
      projected.push({ type: "mention", path: resolved, name: value.name });
    } else {
      projected.push({ type: "localImage", path: resolved });
    }
  }
  if (textBytes > 16_384) throw new Error("text-too-large");
  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > 64 * 1024)
    throw new Error("invalid-input-size");
  return projected;
}

function managedRequestKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return stableJson(value);
}

function managedAnswerPayload(
  questions: unknown[],
  answers: Record<string, string[]>,
): Record<string, unknown> {
  if (
    questions.length === 0 ||
    questions.length > 32 ||
    Object.keys(answers).length !== questions.length ||
    Buffer.byteLength(JSON.stringify(answers), "utf8") > 65_536
  )
    throw new Error("invalid-answers");
  const normalized: Record<string, unknown> = {};
  for (const value of questions) {
    if (!isObject(value) || typeof value.id !== "string") throw new Error("invalid-question-id");
    const choices = answers[value.id];
    if (
      !Array.isArray(choices) ||
      choices.length !== 1 ||
      typeof choices[0] !== "string" ||
      !choices[0].trim() ||
      Buffer.byteLength(choices[0], "utf8") > 8192
    )
      throw new Error("invalid-answer");
    const options = Array.isArray(value.options) ? value.options.filter(isObject) : [];
    if (value.allowCustom !== true && !options.some((option) => option.label === choices[0]))
      throw new Error("answer-not-offered");
    normalized[value.id] = { answers: choices };
  }
  return { answers: normalized };
}

function managedWritableRootsMatch(
  cwd: unknown,
  responseCwd: unknown,
  extraRoots: unknown,
): boolean {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !Array.isArray(extraRoots)) return false;
  try {
    const expected = pathIdentity(canonicalize(cwd));
    const effective = new Set<string>();
    // Native WorkspaceWrite roots are additional to cwd. The caller already
    // verified both response cwd fields against the authorized session directory.
    for (const root of [responseCwd, ...extraRoots]) {
      if (typeof root !== "string" || !path.isAbsolute(root) || !statSync(root).isDirectory())
        return false;
      effective.add(pathIdentity(canonicalize(root)));
    }
    return effective.size === 1 && effective.has(expected);
  } catch {
    return false;
  }
}

function verifyManagedPolicy(record: ManagedRecord, response: Record<string, unknown>): void {
  const id = record.policy_id ?? "workspace-write-on-request";
  const full = id === "full-access-on-request";
  const expectedReviewer = id === "workspace-write-auto-review" ? "auto_review" : "user";
  const sandbox = isObject(response.sandbox) ? response.sandbox : {};
  if (
    response.approvalPolicy !== (full ? "never" : "on-request") ||
    response.approvalsReviewer !== expectedReviewer ||
    sandbox.type !== (full ? "dangerFullAccess" : "workspaceWrite")
  )
    throw new Error("codex-policy-mismatch");
  // Native WorkspaceWrite otherwise adds TMPDIR and /tmp outside writableRoots.
  if (
    !full &&
    (sandbox.networkAccess !== false ||
      sandbox.excludeTmpdirEnvVar !== true ||
      sandbox.excludeSlashTmp !== true ||
      !managedWritableRootsMatch(record.cwd, response.cwd, sandbox.writableRoots))
  )
    throw new Error("codex-sandbox-mismatch");
  if (record.service_tier && response.serviceTier !== record.service_tier)
    throw new Error("codex-service-tier-mismatch");
}

function normalizeManagedTier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value !== "default" ? value : null;
}

async function readManagedQueue(session: CodexAppServerSession, nativeId: string, limit: number) {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await session.request("thread/queue/list", {
      threadId: nativeId,
      cursor,
      limit: 100,
    });
    if (!isObject(page) || !Array.isArray(page.data) || page.data.some((item) => !isObject(item)))
      throw new Error("invalid-native-queue");
    rows.push(...(page.data as Record<string, unknown>[]));
    if (rows.length > Math.min(100, limit))
      return { data: [], complete: false, reason: "queue-too-large" };
    const next = page.nextCursor;
    if (next === null || next === undefined)
      return { data: rows, nextCursor: null, complete: true };
    if (typeof next !== "string" || !next || seen.has(next) || page.data.length === 0)
      throw new Error("invalid-native-queue-cursor");
    seen.add(next);
    cursor = next;
  }
}

function managedCommandContext(
  request: z.infer<typeof managedReconcileSchema>,
  workspaceId: string,
): Record<string, unknown> {
  return {
    operation: request.operation,
    turnId: null,
    nativeRequestId: null,
    runtimeBootId: null,
    expectedRevision: null,
    executionMode: "codex-managed",
    workspaceId,
  };
}

function managedCommandReconciles(
  requestId: string,
  evidence: Record<string, unknown> | null,
  thread: Record<string, unknown>,
): boolean {
  if (!evidence) return false;
  if (["create", "adopt", "resume"].includes(String(evidence.operation)))
    return typeof thread.id === "string";
  const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : [];
  if (["send", "steer", "queue-add", "queue-start"].includes(String(evidence.operation)))
    return turns.some((turn) =>
      (Array.isArray(turn.items) ? turn.items.filter(isObject) : []).some(
        (item) => item.type === "userMessage" && item.clientId === requestId,
      ),
    );
  if (evidence.operation === "stop")
    return turns.some(
      (turn) =>
        turn.id === evidence.turnId &&
        ["completed", "interrupted", "failed"].includes(String(turn.status)),
    );
  return false;
}

function managedSettingsEvidenceMatches(
  evidence: Record<string, unknown> | null,
  record: ManagedRecord,
): boolean {
  if (
    !evidence ||
    evidence.operation !== "settings" ||
    evidence.executionMode === "codex-follower" ||
    !isObject(evidence.settings)
  )
    return false;
  const settings = evidence.settings;
  const same =
    settings.model === (record.model ?? null) &&
    settings.effort === (record.effort ?? null) &&
    settings.serviceTier === (record.service_tier ?? null) &&
    settings.policyId === (record.policy_id ?? "workspace-write-on-request") &&
    (settings.mode === (record.mode ?? null) ||
      (settings.mode === undefined && record.mode == null));
  return same;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function boundedText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/\p{Cc}/u.test(value)
    ? value
    : null;
}

function indexEnabled(dataDir: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path.join(dataDir, "preferences.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw new Error("index-disabled");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("index-disabled");
  const enabled = (value as Record<string, unknown>).session_index_enabled;
  return enabled === undefined || enabled === true;
}

function compactingRejection(
  request: { requestId: string; sessionId?: string },
  runtimeBootId: string,
) {
  return {
    accepted: false,
    completed: false,
    controlOutcome: "not-dispatched",
    reason: "session-compacting",
    sessionId: request.sessionId,
    requestId: request.requestId,
    runtimeBootId,
  };
}

function readManagedRecords(
  dataDir: string,
  store: BackendStore,
  includeReleasedAdopted = true,
): ManagedRecord[] {
  const file = path.join(dataDir, "codex-managed", "executions.sqlite");
  if (!existsSync(file)) return [];
  if (!statSync(file).isFile()) throw new Error("Invalid managed Codex session database");
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(file, { readOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const rows = database
      .prepare("SELECT record FROM managed_sessions ORDER BY rowid DESC LIMIT 20000")
      .all();
    const records: ManagedRecord[] = [];
    for (const row of rows) {
      let record: ManagedRecord;
      try {
        record = managedRecordSchema.parse(JSON.parse(String(row.record)));
      } catch {
        throw new Error("Invalid managed Codex session record");
      }
      if (!includeReleasedAdopted && record.released && record.adopted) continue;
      try {
        if (
          pathIdentity(canonicalize(store.workspacePath(record.workspace_id))) !==
          pathIdentity(canonicalize(record.workspace))
        )
          continue;
      } catch {
        continue;
      }
      records.push(record);
    }
    return records;
  } finally {
    database.close();
  }
}

function isSessionSummary(value: unknown): value is { id: string; workspace_id: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "workspace_id" in value &&
    typeof value.workspace_id === "string"
  );
}
