import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  REMOTE_ERROR_CODES,
  SESSION_COLLECTIONS,
  sessionCollection,
} from "@agentkib/runtime-protocol";
import {
  stableJson,
  type ApplyManagedControl,
  type managedControlSchema,
} from "../../sessions/control-admission";
import { sessionIdentity, type NativeSession } from "../../session-store";
import type { BackendStore } from "../../store";
import type { SessionReaders } from "../../session-readers";
import { enrichLedgerImages } from "../../session-image-matching";
import {
  acceptNativeControlReceipt,
  completeAcceptedStopReceipt,
  isAcceptedStopAwaitingCompletion,
  isPendingNativeReceipt,
} from "../../control-receipt";
import { codexPromptRecorded, codexStopRecorded } from "../../native-control-evidence";
import type { ConversationImage } from "../../session-events";
import type { SessionIndex } from "../../session-index";
import {
  managedCatalogAliases,
  managedRecordSchema,
  readManagedCatalog,
} from "./managed-session-catalog";
import { canonicalize, lexicalPathIdentity, pathIdentity } from "../../paths";
import { within } from "../../files";
import { conversationReadKey, ReadStateLedger } from "../../read-state-ledger";
import { codexTurnMeta, isCodexTurnEndEvent } from "./codex-turn-end";
import { CODEX_TURN_START_REJECTED } from "./codex-turn-error";
import { codexExecutable } from "./codex-executable";
import { CODEX_PINNED_SECTION, CodexSessions } from "./codex-sessions";
import {
  CodexAppServerError,
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
import { CodexCatalogCache, codexCatalogKey } from "./codex-catalog-cache";
import { codexLeadAdoptionReason, type CodexLeadReadiness } from "./lead-adoption";
import {
  CodexExternalTurns,
  codexQuitHistoryProof,
  type EndedTurn,
  type ExternalTurn,
} from "./codex-external-turns";
import { codexResumeCommand } from "./codex-resume-command";
import {
  CodexDesktopFollower,
  type CodexFollowerRecord,
  type WorkerLiveRead,
} from "./desktop-follower";
import {
  parseFollowerModelSettings,
  sameFollowerModelSettings,
  type CodexFollowerState,
  type FollowerModelSettings,
} from "./codex-follower-state";
import type { CodexFollowerStream } from "./codex-follower-stream";
import {
  ManagedCodexEventBridge,
  ManagedCodexState,
  elicitationResponse,
} from "./managed-codex-state";
import { workerCompletionSnapshot } from "./codex-worker-completion";
import {
  readCodexRecoveryQueue,
  runExclusiveCodexWorkerRestart,
  confirmCodexWorkerInterrupted,
  restartCodexWorker,
} from "./codex-worker-restart";
import { projectContextUsage, type ContextUsage } from "../../context-usage";
import {
  sessionResultProjectors,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionProviders,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import { validateCodexControl } from "../../sessions/validate/codex";
import { QUIT_WORK_MANUAL_REASON } from "../../sessions/quit-work";
import { legacySessionFields, sessionSettingsStateSchema } from "../../sessions/routing";
import { unconfirmedCodexNativePolicy, type CodexNativePolicy } from "./codex-native-policy";
import {
  canReselectNativePolicy,
  codexPolicyOverride,
  isCodexPolicyId,
  managedPolicyCatalog,
  managedResumeParams,
  managedTurnMode,
  managedTurnSettings,
  matchesConfirmedTurnPolicy,
  nativePolicySettings,
  nativePolicyWriteAccess,
  requireFullAccessForNativePolicy,
  reselectedCodexPolicy,
  verifyManagedPolicy,
  type CodexPolicyId,
} from "./managed-policy";
import { activityBlocks, assertActivityAllows } from "../../session-activity";
import { acquireManagedSessionLease, existingFileLeaseBusy } from "../../managed-session-lock";
import { acquireCodexFollowerOperationLock } from "./codex-follower-operation-lock";
import {
  acknowledgeDispatchedManagedCommand,
  annotateManagedCommand,
  claimManagedCommand,
  createManagedSnapshotWriter,
  deleteManagedSessionRecord,
  deleteManagedSessions,
  dispatchManagedCommand,
  finishManagedCommand,
  listManagedRecords,
  managedSessionHasUnknownCommands,
  openManagedLedger,
  persistManagedGoal,
  readManagedEvents,
  readManagedRecord,
  readUnknownManagedCommands,
  replayManagedCommand,
  saveManagedRecord,
  saveManagedSettingsReceipt,
} from "../../managed-ledger";
import { CodexLeadTurns } from "../../lead-turn-origin";
import { CodexTitleThreads, codexUserMessageText } from "./codex-thread-title";
import {
  CODEX_ACCOUNT_LIMIT_METHOD,
  CODEX_ACCOUNT_LIMIT_PARAMS,
  CodexUsageLimits,
} from "./usage-limits";
import {
  projectManagedModels,
  projectWorkerModelCatalog,
  type ManagedModelOption,
} from "./codex-managed-models";
import type { LaneObserver } from "../../sessions/lane-observer";
import type {
  DeferredCodexSendOwner,
  DeferredCodexSendResult,
  WorkerRestartRequest,
} from "../../orchestration-service";
import {
  CodexOwnerWait,
  codexWriterLockPath,
  isLocalCodexSender,
  OWNER_WAIT_PAUSED,
  OWNER_WAIT_REASON,
  type OwnerWaitEntry,
  type CodexOwnerWaitSchedule,
} from "./owner-wait";
import {
  managedRecordInWorkspace,
  readManagedRecords,
  startupUnconfirmed,
  type ManagedRecord,
} from "./managed-records";
import { sanitizeSessionText } from "../../session-handoff";

const LEGACY_ADOPT_RECHECK_MS = 5_000;

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

const ownerWaitSchedule: z.ZodType<CodexOwnerWaitSchedule> = z.strictObject({
  agent: z.literal("codex"),
  operation: z.enum(["schedule-prepare", "schedule-dispatch", "schedule-pause"]),
  sessionId: z.string().min(1).max(256),
  deviceId: z.string().min(1).max(256),
  runtimeBootId: z.string().min(1).max(256),
  requestId: z.uuid(),
  itemId: z.uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  permitId: z.uuid().optional(),
  restrictNativePolicy: z.boolean().optional(),
  reason: z.string().optional(),
});

const managedQueueSchema = z
  .object({
    operation: z.literal("queue-list"),
    sessionId: z.string().min(1).max(256),
    limit: z.number().int().min(1).max(100).optional(),
    ownerWaitOnly: z.literal(true).optional(),
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

type SettingsRead = z.infer<typeof sessionSettingsStateSchema>;
type SettingsControl = z.infer<typeof managedControlSchema>;

const codexQuitEvidence = z.strictObject({
  turnId: z.string().min(1).max(256),
  nativeId: z.uuid(),
  workspaceId: z.string().min(1).max(256),
  createdAt: z.string().max(128),
  settings: z.string().length(64),
  history: z.string().max(256).nullable(),
  manualOnly: z.literal(true).optional(),
});
type CodexQuitEvidence = z.infer<typeof codexQuitEvidence>;
class CodexQuitQueueManual extends Error {
  constructor() {
    super(QUIT_WORK_MANUAL_REASON);
  }
}

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
  /** A paginated resume hydrated only the latest turn, so older rows come from native history. */
  usesNativeHistory?: boolean;
  /**
   * Whether Codex has written the thread: resumed ones are, a new one once a turn starts. A thread
   * it has not written cannot be resumed, so it is not restarted before.
   */
  written?: boolean;
  confirmedTurnPolicy?: { turnId: string; policyId: CodexPolicyId };
};

type CodexExecutor = SessionProviders["codex"];

type CodexLeadAdoption = {
  transcript: string;
  beforeResume(): void;
  beforePersist(): void;
};

type CodexSessionHost = {
  store: BackendStore;
  sessions: SessionReaders;
  dataDir: string;
  environment: NodeJS.ProcessEnv;
  indexGeneration(): bigint;
  indexEnabled(): boolean;
  sessionIndex?: SessionIndex;
  runtimeBootId: string;
  controlSessions: Map<string, { count: number; observed: boolean }>;
  publishConversationEvent?: (
    sessionId: string,
    type: "state" | "text-delta" | "item-upsert" | "snapshot" | "invalidate",
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
    textItem?: Record<string, unknown>,
  ) => void;
  isSessionObserved?(sessionId: string): boolean | undefined;
  catalogChanged?(): void;
  hasLaneObserver(): boolean;
  observeLane(notify: (observer: LaneObserver) => void): void;
  isShuttingDown(): boolean;
  isClosing(): boolean;
  assertOpen(): void;
  runOperation<T>(run: () => Promise<T>): Promise<T>;
  admitControl(value: Record<string, unknown>, execute: ApplyManagedControl): Promise<unknown>;
  controlSession(value: Record<string, unknown>, restrictNativePolicy?: boolean): Promise<unknown>;
  querySession(value: SessionQuery): Promise<unknown>;
  requestSession?(value: Record<string, unknown>): Promise<unknown>;
  checkDeferredCodexSend?(owner: DeferredCodexSendOwner): "ready" | "paused" | "revoked";
  deferredCodexSendResult?(
    owner: DeferredCodexSendOwner,
    requestId: string,
    result: DeferredCodexSendResult,
  ): void;
  normalizeContextUsage(snapshot: { usage?: unknown; reason?: unknown }): ContextUsage;
  compactingRejection(
    request: { requestId: string; sessionId?: string },
    runtimeBootId: string,
  ): Record<string, unknown>;
};

type CodexEventRead = {
  sessionId: string;
  cursor?: string | null;
  limit: number;
  retainCursor?: boolean;
};

type CodexPinTarget = {
  nativeId: string;
  workspaceId: string;
  home: string;
  cwd: string;
  nativeDirectory: string;
  collection: boolean;
};

export class CodexSessionProvider implements CodexExecutor, TypedSessionProvider {
  readonly agent = "codex" as const;
  readonly validateControl = validateCodexControl;
  readonly createOperation = "create";
  readonly typed = this;
  #codex: CodexAppServerReader;
  #preflight: CodexRuntimePreflight;
  #pinSource?: CodexSessions;
  #pinProjection?: {
    native: NonNullable<ReturnType<CodexSessions["pinSnapshot"]>>;
    indexed: NonNullable<ReturnType<CodexSessions["pinSnapshot"]>>;
  };
  #pinWrites = new Set<string>();

  // New-session options and settings without a runner each start an app-server.
  #optionsCatalog = new CodexCatalogCache<Record<string, unknown>>();
  // Leave a reader slot for other native metadata while Worker listings load.
  #settingsCatalog = new CodexCatalogCache<{
    models: ManagedModelOption[];
    collaborationModes: CollaborationModeOption[];
  }>(3);
  #settingsCatalogNotifications = new Map<string, string>();
  #followerSettingsCatalog = new CodexCatalogCache<ManagedModelOption[]>();
  #ownership = new Map<string, { checkedAt: number; reason: string | null }>();
  /** Turns that the Codex app or CLI runs, for the catalog and live state to show. */
  #externalTurns = new CodexExternalTurns(() => canonicalize(this.host.sessions.codexHome()));
  #catalogObservations = new Map<string, { at: number; status: string; reason: string | null }>();
  #catalogRuntime?: Awaited<ReturnType<CodexRuntimePreflight["check"]>>;
  #catalogRuntimeCheck?: Promise<void>;
  #retirementTimer: ReturnType<typeof setInterval>;
  #retiring = false;
  #managedRunners = new Map<string, ManagedRunner>();
  #restartingWorkers = new Set<string>();
  #quitInterruptions = new Map<string, string>();
  #codexReceiptChecks = new Map<
    string,
    { retryAt: number; live: Promise<Record<string, unknown> | undefined> }
  >();
  readonly #usageLimits: CodexUsageLimits;
  /** The temporary threads that name managed Codex threads (`codex-thread-title.ts`). */
  #titleThreads = new CodexTitleThreads();
  /**
   * The native threads AgentKib tried to name while it runs, at most once each, and whether the
   * person renamed one meanwhile: their name is never replaced.
   */
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
  #subagentObservers = new WeakMap<object, { identity: string; id: string }>();
  readonly #desktopFollower: CodexDesktopFollower;
  readonly #ownerWait: CodexOwnerWait;

  constructor(private readonly host: CodexSessionHost) {
    const { environment } = host;
    this.#codex = new CodexAppServerReader(environment);
    this.#preflight = new CodexRuntimePreflight(environment);
    this.#desktopFollower = new CodexDesktopFollower({
      dataDir: host.dataDir,
      store: host.store,
      environment,
      runtimeBootId: host.runtimeBootId,
      assertManagedHome: (record) => this.#assertManagedHome(record),
      inactiveRecord: (sessionId) => this.#inactiveRecord(sessionId),
      assertOpen: () => host.assertOpen(),
      isShuttingDown: () => host.isShuttingDown(),
      isSessionObserved: (sessionId) => host.isSessionObserved?.(sessionId),
      publishConversationEvent: (sessionId, type, payload, live, item) =>
        host.publishConversationEvent?.(sessionId, type, payload, live, item),
      hasLaneObserver: () => host.hasLaneObserver(),
      observeLane: (notify) => host.observeLane(notify),
    });
    this.#ownerWait = new CodexOwnerWait({
      dataDir: host.dataDir,
      bootId: host.runtimeBootId,
      deliver: (entry, beforeDispatch) =>
        host.runOperation(() => this.#deliverOwnerWait(entry, beforeDispatch)),
      canDeliver: ({ worker }) =>
        worker ? (host.checkDeferredCodexSend?.(worker) ?? "revoked") : "ready",
      changed: (sessionId) =>
        host.publishConversationEvent?.(sessionId, "invalidate", {
          domains: ["queue", "ownership", "receipts"],
        }),
      report: ({ worker, request }, result) => {
        if (worker) host.deferredCodexSendResult?.(worker, request.requestId, result);
      },
    });
    this.#usageLimits = new CodexUsageLimits({
      dataDir: host.dataDir,
      runtimeBootId: host.runtimeBootId,
      isShuttingDown: () => host.isShuttingDown(),
      readLive: (sessionId) => this.#managedLive(sessionId, true),
      controlSession: (value, restrictNativePolicy) =>
        host.controlSession(value, restrictNativePolicy),
      publishLimit: (sessionId, view) => {
        const runner = this.#managedRunners.get(sessionId);
        if (!runner) host.catalogChanged?.();
        if (runner?.state.showUsageLimit(view)) {
          const live = runner.state.snapshot(host.runtimeBootId, runner.session.connected);
          host.publishConversationEvent?.(sessionId, "state", live, live);
        }
      },
      limitEnded: (sessionId) => host.observeLane((observer) => observer.limitEnded?.(sessionId)),
      home: () => host.sessions.codexHome(),
      readAccountLimit: async (id) => {
        const executable = this.#codexReader();
        if (!executable) throw new Error("codex-cli-unavailable");
        const record = await this.#inactiveRecord(id);
        return this.#codex.request(
          executable,
          this.#managedCwd(record),
          this.#assertManagedHome(record),
          CODEX_ACCOUNT_LIMIT_METHOD,
          CODEX_ACCOUNT_LIMIT_PARAMS,
        );
      },
      reloadIdleRunner: async (id) => {
        await this.restartManagedRunner(id);
        if (this.#managedRunners.has(id) || this.#startingRunners.has(id))
          throw new Error("session-busy");
      },
    });
    this.#retirementTimer = setInterval(() => void this.#retireIdleRunners(), 1000);
    this.#retirementTimer.unref();
  }

  create(value: Record<string, unknown>) {
    return this.managedLifecycle(value);
  }

  settingsState(value: Record<string, unknown>) {
    return this.#managedSettingsState(sessionSettingsStateSchema.parse(value));
  }

  control(value: Record<string, unknown>, restrictNativePolicy = false) {
    return this.host.admitControl(value, (request, fingerprint) =>
      this.#codexControl(request, fingerprint, { restrictNativePolicy }),
    );
  }

  deferCodexSend(
    value: Record<string, unknown>,
    owner: DeferredCodexSendOwner,
    desktopOwnerHandoff: boolean,
  ) {
    if (
      value.operation !== "send" ||
      value.sessionId !== owner.sessionId ||
      value.deviceId !== owner.deviceId
    )
      throw new Error("session-unavailable");
    return this.host.runOperation(() =>
      this.host.admitControl(value, (request, fingerprint) =>
        this.#codexControl(request, fingerprint, { desktopOwnerHandoff, workerOwner: owner }),
      ),
    );
  }

  suspendOwnerWaitDevice(deviceId: string): void {
    this.#ownerWait.suspendDevice(deviceId);
  }

  ownerWaitScheduleList() {
    return this.#ownerWait.scheduleList();
  }

  ownerWaitSchedule(value: unknown) {
    return this.host.runOperation(() => this.#ownerWait.schedule(ownerWaitSchedule.parse(value)));
  }

  cancelDeferredCodexSend(owner: DeferredCodexSendOwner, requestId: string): boolean | "dismissed" {
    const entry = this.#ownerWait.read(owner.sessionId);
    if (
      entry?.request.requestId !== requestId ||
      !entry.worker ||
      stableJson(entry.worker) !== stableJson(owner)
    )
      return false;
    if (entry.delivering) return this.#ownerWait.dismissInterrupted(entry) ? "dismissed" : false;
    return this.#ownerWait.cancel(entry);
  }

  /** A delegated send was admitted by the lead after discovery found no window owner. */
  workerDesktopSend(value: Record<string, unknown>) {
    return this.host.runOperation(() =>
      this.host.admitControl(value, (request, fingerprint) =>
        this.#codexControl(request, fingerprint, { desktopOwnerHandoff: true }),
      ),
    );
  }

  /** Only a Project Agent's follow-up to a running managed Worker uses this admission. */
  workerTurnSend(value: Record<string, unknown>) {
    if (value.operation !== "steer" && value.operation !== "queue-add")
      throw new Error("stale-or-disabled-control");
    return this.host.runOperation(() =>
      this.host.admitControl(value, (request, fingerprint) =>
        this.#codexControl(request, fingerprint, { workerTurn: true }),
      ),
    );
  }

  updateSettings(value: Record<string, unknown>) {
    return this.control(value);
  }

  async contextUsage(sessionId: string) {
    return this.host.normalizeContextUsage(await this.#managedLive(sessionId, false));
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
    source?: "worker",
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(
    request: SessionProviderRequest,
    source?: "worker",
  ): Promise<SessionProviderResponse> {
    const operation = request.operation;
    const raw =
      source === "worker" && operation === "settings-state"
        ? await this.host.runOperation(() => this.#managedSettingsState(request, true))
        : await this.#request(request);
    return {
      operation,
      result: sessionResultProjectors[operation](this.agent, raw),
    } as SessionProviderResponse;
  }

  async #request(request: SessionProviderRequest): Promise<unknown> {
    if (request.operation === "create") {
      const { prompt: _prompt, ...fields } = request;
      return this.create(fields);
    }
    if (request.operation === "settings-prepare")
      throw new Error("unsupported-session-provider-operation");
    // The backend's raw route still owns the host envelopes and Project Agent notifications.
    if (this.host.requestSession) return this.host.requestSession(legacySessionFields(request));
    switch (request.operation) {
      case "capabilities":
      case "inspect":
        return this.query(request);
      case "live":
        return this.live(request.sessionId, request.experimentalEnabled === true);
      case "usage":
        return this.contextUsage(request.sessionId);
      case "queue-list":
        return this.queue(request);
      case "settings-state":
        return this.settingsState(request);
      default:
        return this.control(request);
    }
  }

  stopTimers(): void {
    clearInterval(this.#retirementTimer);
    this.#usageLimits.stopTimers();
    this.#ownerWait.stop();
  }

  closeDiscovery(): void {
    this.#preflight.close();
    this.#desktopFollower.closeDiscovery();
  }

  closeReader(): Promise<void> {
    this.#pinSource?.close();
    this.#pinProjection = undefined;
    return this.#codex.closeAsync();
  }

  closeFollowers(): void {
    this.#desktopFollower.closeFollowers();
  }

  closeRunners(): Promise<void>[] {
    const pending: Promise<void>[] = [];
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
    return pending;
  }

  #trackTransientSession(session: CodexAppServerSession, release?: () => void): void {
    this.#transientSessions.add(session);
    session.once("close", () => {
      this.#transientSessions.delete(session);
      release?.();
    });
  }

  runnerObservation(sessionId: string): { observed: boolean } | undefined {
    return this.#managedRunners.get(sessionId);
  }

  *runningSessionIds(): Iterable<string> {
    for (const [id, runner] of new Map([...this.#startingRunners, ...this.#managedRunners]))
      if (runner.session.connected && !runner.retiring && runner.state.status === "running")
        yield id;
  }

  /** Resident native overlays also seed subscriptions that have not received any events yet. */
  readFollowerSnapshot(sessionId: string): ReturnType<CodexFollowerStream["snapshot"]> | undefined {
    return this.#desktopFollower.readSnapshot(sessionId);
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
    const agent = this.host.store.sessions.get(sessionId)?.agent;
    const record = managedRecordInWorkspace(this.host.dataDir, this.host.store, sessionId);
    return (
      (agent === undefined || agent === "codex") &&
      !!record?.native_id &&
      !record.archived &&
      !record.released &&
      !startupUnconfirmed(record)
    );
  }

  /** Whether the Codex process running this session has the worker tools; null when none runs. */
  runnerHasLeadTools(sessionId: string): boolean | null {
    const runner = this.#managedRunners.get(sessionId);
    return runner?.session.connected && !runner.retiring ? Boolean(runner.leadUrl) : null;
  }

  /** An eligibility read may verify history and leases, but never starts a writer. */
  async codexLeadReadiness(sessionId: string): Promise<CodexLeadReadiness | undefined> {
    const index = this.host.store.sessions.get(sessionId);
    if (index && index.agent !== "codex") return;
    let workspaceId = index?.workspace_id;
    let requiresAdoption = true;
    const toolsReady = this.runnerHasLeadTools(sessionId) === true;
    try {
      const stored = readManagedRecord(this.host.dataDir, sessionId);
      if (!index && !stored) return;
      const row = stored ? managedRecordSchema.parse(stored) : null;
      workspaceId ??= row?.workspace_id;
      requiresAdoption = !row || row.released;
      const record = await this.#inactiveRecord(sessionId, row);
      this.#checkCodexLead(record);
      if (requiresAdoption) this.#verifiedCodexLeadAdoption(record);
      const { reason } = await this.#preflight.check();
      if (reason) throw new Error(reason);
      return { canDesignate: true, toolsReady, requiresAdoption, workspaceId };
    } catch (error) {
      const reason = codexLeadAdoptionReason(error);
      return { canDesignate: false, toolsReady, requiresAdoption, workspaceId, reason };
    }
  }

  /** Take the native writer only during a confirmed assignment, and hold it through registration. */
  adoptCodexLead<T>(
    sessionId: string,
    workspaceId: string,
    remote: boolean,
    confirm: () => T,
  ): Promise<T> {
    return this.host
      .runOperation(async () => {
        const unlock = acquireManagedSessionLease(this.host.dataDir, sessionId);
        let ownsLease = true;
        const release = () => {
          if (!ownsLease) return;
          ownsLease = false;
          unlock();
        };
        let previous: ManagedRecord | null = null;
        let saved = false;
        let runner: ManagedRunner | undefined;
        const restore = () => {
          if (!saved || !ownsLease) return;
          if (previous) saveManagedRecord(this.host.dataDir, previous);
          else deleteManagedSessionRecord(this.host.dataDir, sessionId);
          saved = false;
        };
        try {
          const stored = readManagedRecord(this.host.dataDir, sessionId);
          previous = stored ? managedRecordSchema.parse(stored) : null;
          const source = await this.#inactiveRecord(sessionId, previous);
          if (source.workspace_id !== workspaceId) throw new Error("session-workspace-mismatch");
          this.#checkCodexLead(source);
          if (!source.released) return await confirm();
          const verified = await this.#inactiveCodexControlRecord(
            source,
            source.snapshot?.revision ?? 0,
          );
          const { transcript, policy, version } = this.#verifiedCodexLeadAdoption(verified);
          if (remote) requireFullAccessForNativePolicy(policy);
          // A native owner may have changed model, effort, tier or mode after the last release.
          const record = {
            ...verified,
            released: false,
            model: null,
            effort: null,
            service_tier: null,
            mode: null,
            native_settings: null,
          };
          runner = await this.#attachManagedRunner(
            record,
            record.workspace,
            this.#assertManagedHome(record),
            release,
            undefined,
            undefined,
            {
              inheritNativePolicy: true,
              restrictNativePolicy: remote,
              onFailure: restore,
              leadAdoption: {
                transcript,
                beforeResume: () => {
                  if (version !== this.#verifiedCodexLeadAdoption(verified).version)
                    throw new Error("stale-or-disabled-control");
                },
                beforePersist: () => {
                  saveManagedRecord(this.host.dataDir, record);
                  saved = true;
                },
              },
            },
          );
          this.#managedRunners.set(sessionId, runner);
          return await confirm();
        } catch (error) {
          if (runner) await this.#closeManagedRunner(sessionId, runner, restore);
          else if (!this.#managedRunners.has(sessionId)) restore();
          throw error;
        } finally {
          if (!this.#managedRunners.has(sessionId)) release();
        }
      })
      .catch((error) => {
        throw new Error(codexLeadAdoptionReason(error));
      });
  }

  #checkCodexLead(record: ManagedRecord): void {
    this.host.assertOpen();
    if (record.archived) throw new Error("session-archived");
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    if (this.host.controlSessions.has(record.id) || this.#startingRunners.has(record.id))
      throw new Error("session-busy");
    const runner = this.#managedRunners.get(record.id);
    if (
      runner?.retiring ||
      startupUnconfirmed(record) ||
      managedSessionHasUnknownCommands(this.host.dataDir, record.id)
    )
      throw new Error("control-outcome-unconfirmed");
    if (!runner?.session.connected) {
      const reason = this.#probeCodexWriter(record);
      if (reason) throw new Error(reason);
    }
  }

  #verifiedCodexLeadAdoption(record: ManagedRecord) {
    if (record.snapshot?.settingsStaged) throw new Error("stale-or-disabled-control");
    const nativeId = record.native_id!;
    this.#assertManagedHome(record);
    const cwd = this.#managedCwd(record);
    const identity = this.host.sessions.verifiedCodexControlDirectory(nativeId);
    if (
      identity?.id !== nativeId.toLowerCase() ||
      pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
    )
      throw new Error("unverified-session-identity");
    const { transcript } = this.host.sessions.verifiedCodexSubagentParent(
      record.id,
      nativeId,
      record.workspace,
    );
    const version = this.#codexRolloutVersion(record, transcript);
    if (!version || !transcript.endsWith(".jsonl")) throw new Error("native-session-unconfirmed");
    const reason = this.#probeCodexWriter(record);
    if (reason) throw new Error(reason);
    const nativePolicy = this.#nativeCodexPolicy(record, true);
    if (!nativePolicy?.policyId)
      throw new Error(nativePolicy?.reason ?? unconfirmedCodexNativePolicy.reason);
    return { transcript, policy: nativePolicy.policyId, version };
  }

  /** The workspace of a Codex session AgentKib runs, also before the catalog lists it. */
  managedWorkspace(sessionId: string): string | null {
    const record = managedRecordInWorkspace(this.host.dataDir, this.host.store, sessionId);
    return record && !record.archived ? record.workspace_id : null;
  }

  /**
   * The session became a Project Agent or stopped being one: its thread restarts with or without
   * the worker tools, now when idle, else once its turn ends. It stays AgentKib's.
   */
  async restartManagedRunner(sessionId: string): Promise<void> {
    const runner = this.#managedRunners.get(sessionId);
    if (!runner || runner.retiring) return;
    const live = runner.state.snapshot(this.host.runtimeBootId, false);
    if (
      live.status !== "idle" ||
      live.activity ||
      runner.written === false ||
      this.host.controlSessions.has(sessionId)
    ) {
      runner.restartWhenIdle = true;
      return;
    }
    await this.#closeManagedRunner(sessionId, runner);
  }

  #quitSettings(runner: ManagedRunner, record: ManagedRecord): string | undefined {
    const live = runner.state.snapshot(this.host.runtimeBootId, false);
    const settings = live.settings;
    if (
      !isObject(settings) ||
      settings.applicationStatus !== "confirmed" ||
      !isObject(settings.current) ||
      typeof settings.current.model !== "string" ||
      (isObject(live.goal) && live.goal.status === "active")
    )
      return;
    const mode = managedTurnMode(record) ?? "default";
    if ((settings.current.mode ?? "default") !== mode) return;
    const options = managedTurnSettings(record, this.#managedCwd(record));
    return createHash("sha256").update(stableJson(options)).digest("hex");
  }

  #quitQueue(runner: ManagedRunner, record: ManagedRecord) {
    return readCodexRecoveryQueue(
      runner.session,
      runner.queueVerified,
      record.native_id,
      managedTurnMode(record),
    );
  }

  async #dispatchQuitContinuation(
    runner: ManagedRunner,
    record: ManagedRecord,
    params: Record<string, unknown>,
    claimDispatch: () => void,
    assertDispatchable: () => void,
  ): Promise<unknown> {
    const queued = await this.#quitQueue(runner, record);
    if (!queued) throw new CodexQuitQueueManual();
    if (!queued.length) return runner.session.request("turn/start", params, claimDispatch);

    const threadId = record.native_id!;
    const clientUserMessageId = params.clientUserMessageId;
    const queue = () => readManagedQueue(runner.session, threadId, 100);
    const explicitlyRejected = (error: unknown) =>
      error instanceof CodexAppServerError &&
      error.code !== undefined &&
      [-32600, -32601, -32602].includes(error.code);
    let added: unknown;
    try {
      // The cancelled native turn keeps the queue paused across cold resume. Codex
      // does not deduplicate add, so write the dispatch receipt before adding once.
      added = await runner.session.request(
        "thread/queue/add",
        { threadId, input: params.input, clientUserMessageId },
        claimDispatch,
      );
    } catch (error) {
      if (explicitlyRejected(error)) throw new CodexQuitQueueManual();
      throw error;
    }
    const item = isObject(added) && isObject(added.queuedSubmission) && added.queuedSubmission;
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      item.clientUserMessageId !== clientUserMessageId ||
      queued.includes(item.id)
    )
      throw new Error("unconfirmed-queue-mutation");
    const id = item.id;
    const ordered = [id, ...queued];
    const matches = async (ids: string[]) => {
      const current = await queue();
      return (
        current.complete &&
        current.data.length === ids.length &&
        current.data.every((row, index) => row.id === ids[index]) &&
        current.data[ids.indexOf(id)]?.clientUserMessageId === clientUserMessageId
      );
    };
    const abandon = async () => {
      // Only this queued item is ours to remove. Verify that the start was
      // never submitted or was explicitly refused before falling back to manual.
      const current = await queue();
      if (
        !current.complete ||
        !current.data.some(
          (row) => row.id === id && row.clientUserMessageId === clientUserMessageId,
        )
      )
        throw new Error("unconfirmed-queue-mutation");
      await runner.session.request(
        "thread/queue/delete",
        { threadId, queuedSubmissionId: id },
        assertDispatchable,
      );
      const after = await queue();
      if (
        !after.complete ||
        after.data.some((row) => row.id === id || row.clientUserMessageId === clientUserMessageId)
      )
        throw new Error("unconfirmed-queue-mutation");
      throw new CodexQuitQueueManual();
    };
    if (!(await matches([...queued, id]))) return abandon();
    try {
      await runner.session.request(
        "thread/queue/reorder",
        { threadId, queuedSubmissionIds: ordered },
        assertDispatchable,
      );
    } catch (error) {
      if (explicitlyRejected(error)) return abandon();
      throw error;
    }
    if (!(await matches(ordered))) return abandon();
    try {
      return await runner.session.request(
        "thread/queue/start",
        { threadId, queuedSubmissionId: id },
        assertDispatchable,
      );
    } catch (error) {
      if (explicitlyRejected(error)) return abandon();
      throw error;
    }
  }

  #runningForQuit(sessionId: string) {
    const runner = this.#managedRunners.get(sessionId);
    const row = readManagedRecord(this.host.dataDir, sessionId);
    const record = row && managedRecordSchema.parse(row);
    if (
      !runner?.session.connected ||
      runner.retiring ||
      !record?.native_id ||
      !z.uuid().safeParse(record.native_id).success ||
      record.native_id !== runner.state.nativeId ||
      record.released ||
      record.archived ||
      runner.state.activity ||
      this.host.controlSessions.has(sessionId) ||
      this.#ownerWait.read(sessionId) ||
      this.#usageLimits.isLimited(sessionId) ||
      managedSessionHasUnknownCommands(this.host.dataDir, sessionId)
    )
      return;
    const live = runner.state.snapshot(this.host.runtimeBootId, true);
    const turnId = runner.state.turnId;
    if (!turnId || live.stopEnabled !== true) return;
    const settings = this.#quitSettings(runner, record);
    if (!settings) return;
    this.#assertManagedHome(record);
    const transcript = this.host.sessions.verifiedCodexReadTranscript(
      record.native_id,
      record.workspace,
    );
    if (!transcript) return;
    return { runner, record, turnId, settings, transcript };
  }

  async quitCandidate(
    sessionId: string,
  ): Promise<{ turnId: string; manualOnly?: true } | undefined> {
    const candidate = this.#runningForQuit(sessionId);
    if (!candidate) return;
    const queue = await this.#quitQueue(candidate.runner, candidate.record);
    const current = this.#runningForQuit(sessionId);
    if (current?.runner !== candidate.runner || current.turnId !== candidate.turnId) return;
    return { turnId: current.turnId, ...(queue === undefined && { manualOnly: true }) };
  }

  async interruptForQuit(
    sessionId: string,
    turnId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const candidate = this.#runningForQuit(sessionId);
    if (!candidate || candidate.turnId !== turnId) return;
    const { runner, record, settings, transcript } = candidate;
    const manualOnly = (await this.#quitQueue(runner, record)) === undefined;
    const turnsStarted = runner.state.turnsStarted;
    let settle!: (interrupted: boolean) => void;
    const completed = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const onNotification = (event: unknown) => {
      if (
        isObject(event) &&
        event.method === "turn/completed" &&
        isObject(event.params) &&
        event.params.threadId === record.native_id &&
        isObject(event.params.turn) &&
        event.params.turn.id === turnId
      )
        settle(event.params.turn.status === "interrupted");
    };
    const onClose = () => settle(false);
    const deadline = setTimeout(onClose, 3_500);
    runner.session.on("notification", onNotification);
    runner.session.once("close", onClose);
    try {
      this.#quitInterruptions.set(sessionId, turnId);
      // Submit the stop to the resident app-server only. Codex preserves its native
      // FIFO across interruption and cold resume; an explicit turn/start runs ahead of it.
      await runner.session.request(
        "turn/interrupt",
        { threadId: record.native_id, turnId },
        () => {
          const current = this.#runningForQuit(sessionId);
          if (
            current?.runner !== runner ||
            current.turnId !== turnId ||
            current.settings !== settings
          )
            throw new Error("quit-continuation-stale");
        },
        2_500,
      );
      if (!(await completed)) return;
      await runner.bridge.flush();
      if (
        runner.state.status !== "idle" ||
        runner.state.turnsStarted !== turnsStarted ||
        this.#quitSettings(runner, record) !== settings
      )
        return;
      let history: string | null = null;
      try {
        await this.#closeManagedRunner(sessionId, runner);
        if (this.#codexWriterOwnership(record, true) === null)
          history = codexQuitHistoryProof(transcript, turnId) ?? null;
      } catch {
        // The native interruption settled. Keep the worker report even when the
        // process or rollout cannot prove that a continuation would be safe.
      }
      return {
        turnId,
        nativeId: record.native_id!,
        workspaceId: record.workspace_id,
        createdAt: record.created_at,
        settings,
        history,
        ...(manualOnly && { manualOnly: true }),
      } satisfies CodexQuitEvidence;
    } finally {
      clearTimeout(deadline);
      runner.session.off("notification", onNotification);
      runner.session.off("close", onClose);
      this.#quitInterruptions.delete(sessionId);
    }
  }

  #quitRecord(sessionId: string, evidence: CodexQuitEvidence): ManagedRecord | undefined {
    const row = readManagedRecord(this.host.dataDir, sessionId);
    const record = row && managedRecordSchema.parse(row);
    if (
      !record ||
      record.released ||
      record.archived ||
      record.created_at !== evidence.createdAt ||
      record.native_id !== evidence.nativeId ||
      record.workspace_id !== evidence.workspaceId ||
      this.#ownerWait.read(sessionId) ||
      this.#usageLimits.isLimited(sessionId) ||
      managedSessionHasUnknownCommands(this.host.dataDir, sessionId)
    )
      return;
    this.#assertManagedHome(record);
    this.#managedCwd(record);
    return record;
  }

  #quitHistory(record: ManagedRecord, evidence: CodexQuitEvidence, requireUnmatchedAbort = false) {
    const transcript = this.host.sessions.verifiedCodexReadTranscript(
      evidence.nativeId,
      record.workspace,
    );
    return codexQuitHistoryProof(transcript, evidence.turnId, requireUnmatchedAbort);
  }

  #readyAfterQuit(sessionId: string, evidence: CodexQuitEvidence, upgrade = false) {
    const record = this.#quitRecord(sessionId, evidence);
    if (
      !record ||
      this.#managedRunners.has(sessionId) ||
      this.#codexWriterOwnership(record, true) !== null
    )
      return;
    const legacyUpgradeProof = upgrade && evidence.history === null;
    if (evidence.history === null && !legacyUpgradeProof) return;
    const history = this.#quitHistory(record, evidence, legacyUpgradeProof);
    if (history && (legacyUpgradeProof || history === evidence.history))
      return { record, evidence: { ...evidence, history } };
  }

  async checkAfterQuit(
    sessionId: string,
    value: Record<string, unknown>,
  ): Promise<boolean | "open-session"> {
    try {
      const evidence = codexQuitEvidence.safeParse(value).data;
      if (!evidence) return false;
      if (!evidence.manualOnly) return !!this.#readyAfterQuit(sessionId, evidence);
      const record = this.#quitRecord(sessionId, evidence);
      const runner = this.#managedRunners.get(sessionId);
      if (
        record &&
        (runner
          ? runner.session.connected &&
            !runner.retiring &&
            runner.state.nativeId === record.native_id &&
            runner.state.status === "idle" &&
            runner.state.turnsStarted === 0
          : this.#codexWriterOwnership(record, true) === null) &&
        this.#quitHistory(record, evidence)
      )
        return "open-session";
      return false;
    } catch {
      return false;
    }
  }

  async resumeAfterQuit(
    sessionId: string,
    value: Record<string, unknown>,
    requestId: string,
    text: string,
    upgrade = false,
  ): Promise<"continued" | "skipped" | "unknown" | "manual-required"> {
    const interruption = codexQuitEvidence.safeParse(value).data;
    if (!interruption) return "skipped";
    if (interruption.manualOnly) return "manual-required";
    try {
      const ready = this.#readyAfterQuit(sessionId, interruption, upgrade);
      if (!ready) return "skipped";
      const { record, evidence } = ready;
      const request = {
        operation: "send" as const,
        sessionId,
        requestId,
        deviceId: "desktop-local",
        runtimeBootId: this.host.runtimeBootId,
        expectedRevision: record.snapshot?.revision ?? 0,
        experimentalEnabled: true,
        text,
      };
      const result = await this.host.runOperation(() =>
        this.host.admitControl(request, async (control, fingerprint) => {
          const runner = await this.#connectCodexForControl(record, control, false, false, {
            evidence,
            beforeResume: () => {
              if (!this.#readyAfterQuit(sessionId, evidence))
                throw new Error("quit-continuation-stale");
            },
          });
          return this.#codexControl(
            { ...control, expectedRevision: runner.state.revision },
            fingerprint,
            { quitResume: { runner, evidence } },
          );
        }),
      );
      if (isObject(result) && result.accepted === true) return "continued";
      if (isObject(result) && result.reason === QUIT_WORK_MANUAL_REASON) return "manual-required";
      return isObject(result) && result.controlOutcome === "unknown" ? "unknown" : "skipped";
    } catch {
      return managedSessionHasUnknownCommands(this.host.dataDir, sessionId) ? "unknown" : "skipped";
    }
  }

  restartWorker(input: WorkerRestartRequest, beforeDispatch: () => void) {
    return restartCodexWorker(input, beforeDispatch, (control, begin) =>
      this.host.runOperation(() =>
        this.host.admitControl(control, (request, fingerprint) =>
          runExclusiveCodexWorkerRestart(
            this.#restartingWorkers,
            request.sessionId,
            this.host.controlSessions,
            () =>
              this.#codexControl(request, fingerprint, {
                workerRestart: { workspaceId: input.workspaceId, beforeDispatch: begin },
              }),
          ),
        ),
      ),
    );
  }

  isManagedSession(sessionId: string): boolean {
    return readManagedRecords(this.host.dataDir, this.host.store).some(
      (record) => record.id === sessionId && !record.released,
    );
  }

  /** The latest native completions, including those from an indexed Worker we never ran. */
  async endedTurns(sessionId: string): Promise<EndedTurn[]> {
    const row = readManagedRecord(this.host.dataDir, sessionId);
    const stored = row && managedRecordSchema.parse(row);
    try {
      if (stored && !stored.released) {
        const record = await this.#inactiveRecord(sessionId, stored);
        return record.native_id ? this.#externalTurns.endedTurns(record.native_id) : [];
      }
      const { nativeId, transcript } = await this.#indexedCodexSource(sessionId);
      if (!transcript) return [];
      // A completion without a proven start cannot show that the indexed turn began after assignment.
      return (await this.#externalTurns.endedTurns(nativeId, Date.now(), transcript)).filter(
        (turn) => turn.startedAt !== null,
      );
    } catch {
      return [];
    }
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
    return (
      this.#desktopFollower.activeTurn(target.nativeId, workspace) ??
      this.#externalTurns.activeTurnId(target.nativeId)
    );
  }

  /** A Codex CLI for reads: the one the last version check chose, else the first found. */
  #codexReader(): string | null {
    return this.#preflight.preferred() ?? codexExecutable(this.host.environment);
  }

  #readPinSource() {
    return (this.#pinSource ??= new CodexSessions(
      { ...this.host.environment, CODEX_HOME: this.host.sessions.codexHome() },
      { retainDatabase: true },
    )).pinSnapshot();
  }

  pinStates(sessionIds: readonly string[]): Map<string, { pinned: boolean; available: boolean }> {
    const states = new Map<string, { pinned: boolean; available: boolean }>();
    if (!sessionIds.length) return states;
    let available = true;
    try {
      const native = this.#readPinSource();
      if (!native) {
        if (!this.#pinProjection) return states;
        available = false;
      } else if (native !== this.#pinProjection?.native) {
        const salt = this.host.store.sessions.identitySalt();
        const indexed = new Map(
          Array.from(native, ([id, state]) => [sessionIdentity(salt, "codex", id), state]),
        );
        this.#pinProjection = { native, indexed };
      }
    } catch {
      available = false;
    }
    const projection = this.#pinProjection;
    if (!projection) {
      // An unclassified read failure cannot prove that these sessions lack native pin support.
      for (const id of sessionIds) states.set(id, { pinned: false, available: false });
      return states;
    }
    const managed = new Map(
      readManagedRecords(this.host.dataDir, this.host.store).map((record) => [record.id, record]),
    );
    for (const sessionId of sessionIds) {
      const record = managed.get(sessionId);
      const state = record
        ? record.native_id && this.#isCodexHome(record.home)
          ? projection.native.get(record.native_id)
          : undefined
        : projection.indexed.get(sessionId);
      states.set(sessionId, {
        pinned: state?.pinned ?? false,
        available: available && !!state?.available && !record?.archived,
      });
    }
    return states;
  }

  async #pinTarget(sessionId: string): Promise<CodexPinTarget> {
    const row = this.host.store.sessions.get(sessionId);
    if (row && sessionCollection(row.workspace_id)) {
      if (row.agent !== "codex" || row.archived || row.sidechain)
        throw new Error("session-pin-unavailable");
      const resolved = await this.host.sessions.resolve(sessionId);
      const nativeId = resolved.native.native_ref;
      if (
        resolved.summary.workspace_id !== row.workspace_id ||
        resolved.native.agent !== "codex" ||
        this.host.store.sessions.id("codex", nativeId) !== sessionId ||
        !this.host.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase())
      )
        throw new Error("unverified-session-identity");
      const home = canonicalize(this.host.sessions.codexHome());
      // A conversation-only record is never an execution directory for AgentKib.
      // Start the metadata-only app-server in its verified home, not the native cwd.
      if (!path.isAbsolute(resolved.workspace) || !lstatSync(home).isDirectory())
        throw new Error("session-pin-unavailable");
      return {
        nativeId,
        workspaceId: row.workspace_id,
        home,
        cwd: home,
        nativeDirectory: lexicalPathIdentity(resolved.workspace),
        collection: true,
      };
    }
    const record = await this.#inactiveRecord(sessionId);
    if (!record.native_id || record.archived) throw new Error("session-pin-unavailable");
    const cwd = this.#managedCwd(record);
    return {
      nativeId: record.native_id,
      workspaceId: record.workspace_id,
      home: this.#assertManagedHome(record),
      cwd,
      nativeDirectory: pathIdentity(cwd),
      collection: false,
    };
  }

  setPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    return this.host.runOperation(async () => {
      this.host.assertOpen();
      const generation = this.host.indexGeneration();
      const target = await this.#pinTarget(sessionId);
      const { nativeId, home, cwd } = target;
      if (!this.pinStates([sessionId]).get(sessionId)?.available)
        throw new Error("session-pin-unavailable");
      const executable = this.#codexReader();
      if (!executable || this.#pinWrites.has(nativeId.toLowerCase()))
        throw new Error("session-pin-unavailable");
      this.#pinWrites.add(nativeId.toLowerCase());
      let session: CodexAppServerSession | undefined;
      try {
        const opened = await CodexAppServerSession.start(
          executable,
          cwd,
          home,
          { ...process.env, ...this.host.environment },
          undefined,
          (started) => {
            session = started;
            this.#trackTransientSession(started);
          },
        );
        const readPinned = async () => {
          const response = await opened.request("thread/read", {
            threadId: nativeId,
            includeTurns: false,
          });
          this.host.assertOpen();
          if (this.host.indexGeneration() !== generation)
            throw new Error("session-pin-unavailable");
          const thread = isObject(response) ? response.thread : null;
          if (!isObject(thread) || thread.id !== nativeId)
            throw new Error("thread-identity-mismatch");
          if (
            typeof thread.cwd !== "string" ||
            (target.collection
              ? lexicalPathIdentity(thread.cwd)
              : pathIdentity(canonicalize(thread.cwd))) !== target.nativeDirectory
          )
            throw new Error("session-workspace-mismatch");
          if (
            thread.section !== null &&
            (!isObject(thread.section) || typeof thread.section.id !== "string")
          )
            throw new Error("session-pin-unavailable");
          return isObject(thread.section) && thread.section.id === CODEX_PINNED_SECTION;
        };
        if ((await readPinned()) === pinned) return pinned;
        const latest = await this.#pinTarget(sessionId);
        if (
          latest.nativeId !== nativeId ||
          latest.workspaceId !== target.workspaceId ||
          latest.collection !== target.collection ||
          latest.home !== home ||
          latest.nativeDirectory !== target.nativeDirectory
        )
          throw new Error("session-pin-unavailable");
        try {
          await opened.request(
            "thread/section/move",
            {
              threadId: nativeId,
              sectionId: pinned ? CODEX_PINNED_SECTION : null,
              beforeThreadId: null,
            },
            () => {
              this.host.assertOpen();
              if (this.host.indexGeneration() !== generation)
                throw new Error("session-pin-unavailable");
              const current = this.#readPinSource()?.get(nativeId);
              if (!current?.available) throw new Error("session-pin-unavailable");
              if (target.collection) {
                const row = this.host.store.sessions.get(sessionId);
                if (
                  row?.workspace_id !== target.workspaceId ||
                  row.agent !== "codex" ||
                  row.archived ||
                  row.sidechain ||
                  !current.cwd ||
                  lexicalPathIdentity(current.cwd) !== target.nativeDirectory
                )
                  throw new Error("session-pin-unavailable");
              }
              // Don't clear a custom section if Codex unpinned the thread since our first read.
              if (current.pinned === pinned) throw new Error("session-pin-already-applied");
            },
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "session-pin-already-applied")
            throw error;
        } finally {
          this.host.catalogChanged?.();
        }
        if ((await readPinned()) !== pinned) throw new Error("session-pin-unconfirmed");
        return pinned;
      } finally {
        try {
          await session?.close();
        } finally {
          this.#pinWrites.delete(nativeId.toLowerCase());
        }
      }
    });
  }

  async options() {
    const checked = await this.#preflight.check();
    const executable = checked.executable;
    if (!executable || checked.reason)
      return { available: false, reason: checked.reason, models: [], policies: [] };
    try {
      const home = canonicalize(
        this.host.environment.CODEX_HOME ??
          path.join(this.host.environment.HOME ?? homedir(), ".codex"),
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

  managedReconcile(value: unknown, restrictNativePolicy = false) {
    return this.host.runOperation(() => this.#managedReconcile(value, restrictNativePolicy));
  }

  async #managedReconcile(value: unknown, restrictNativePolicy: boolean) {
    const request = managedReconcileSchema.parse(value);
    const records = readManagedRecords(this.host.dataDir, this.host.store);
    const record = records.find((item) => item.id === request.sessionId);
    if (!record || !this.#managedRunners.get(request.sessionId)?.session.connected)
      return this.host.querySession({
        operation: "inspect",
        sessionId: request.sessionId,
        deviceId: request.deviceId,
      });

    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (previous) return previous;

    let runner = this.#managedRunners.get(request.sessionId);
    if (runner && !runner.session.connected) {
      await this.#closeManagedRunner(request.sessionId, runner);
      runner = undefined;
    }
    let release: (() => void) | undefined;
    if (!runner) release = acquireManagedSessionLease(this.host.dataDir, request.sessionId);

    const current = readManagedRecords(this.host.dataDir, this.host.store).find(
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
      workspace = canonicalize(this.host.store.workspacePath(current.workspace_id));
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
      this.host.dataDir,
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
        runner = await this.#attachManagedRunner(
          current,
          workspace,
          home,
          release,
          undefined,
          undefined,
          {
            restrictNativePolicy,
          },
        );
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

      const unknown = readUnknownManagedCommands(this.host.dataDir, current.id);
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
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      }
      for (const command of unknown)
        finishManagedCommand(this.host.dataDir, command.requestId, {
          accepted: true,
          completed: false,
          reconciled: true,
          requestId: command.requestId,
          runtimeBootId: this.host.runtimeBootId,
          sessionId: current.id,
        });

      await runner.bridge.flush();
      if (runner.state.turnId === null) {
        const hydrated = runner.state.hydrate(thread, true, readRevision);
        runner.persist(runner.state, hydrated.events);
      } else if (runner.state.restoreReconciledTurn()) {
        runner.persist(runner.state);
      }
      const live = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      const result = { sessionId: current.id, reconciled: live.reason === null, live };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      }
      throw error;
    }
  }

  managedLifecycle(value: unknown, fingerprintOverride?: string) {
    return this.host.runOperation(() => this.#managedLifecycle(value, fingerprintOverride));
  }

  async #managedLifecycle(value: unknown, fingerprintOverride?: string) {
    const request = managedLifecycleSchema.parse(value);
    const fingerprint =
      fingerprintOverride ?? createHash("sha256").update(stableJson(value)).digest("hex");
    const prior = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (prior) return prior;
    const records = readManagedRecords(this.host.dataDir, this.host.store);
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
            runtimeBootId: this.host.runtimeBootId,
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
          runtimeBootId: this.host.runtimeBootId,
        };
      if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(record);
      const live = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      if (activityBlocks(live, "release"))
        return this.host.compactingRejection(request, this.host.runtimeBootId);
      if (live.reason || live.status !== "idle") throw new Error("session-busy");
      const claimed = claimManagedCommand(
        this.host.dataDir,
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
        if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
          throw new Error("control-outcome-unconfirmed");
        const current = await runner.bridge.snapshot(this.host.runtimeBootId, true);
        assertActivityAllows(current, "release");
        if (current.reason || current.status !== "idle" || current.revision !== live.revision)
          throw new Error("session-busy");
        dispatchManagedCommand(this.host.dataDir, request.requestId);
        await this.#closeManagedRunner(request.sessionId, runner, () => {
          const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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
          saveManagedRecord(this.host.dataDir, latest as unknown as Record<string, unknown>);
        });
        const result = {
          sessionId: request.sessionId,
          released: true,
          accepted: true,
          completed: true,
          requestId: request.requestId,
          runtimeBootId: this.host.runtimeBootId,
        };
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      } catch (error) {
        if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
          return {
            sessionId: request.sessionId,
            accepted: false,
            completed: false,
            controlOutcome: "unknown",
            reason: "control-outcome-unconfirmed",
            requestId: request.requestId,
            runtimeBootId: this.host.runtimeBootId,
          };
        const result = {
          sessionId: request.sessionId,
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason: error instanceof Error ? error.message : "control-preflight-rejected",
          requestId: request.requestId,
          runtimeBootId: this.host.runtimeBootId,
        };
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      }
    }
    const id = createHash("sha256").update(`managed:${request.requestId}`).digest("hex");
    const { workspaceId, policyId } = request;
    const model = request.model ?? null;
    const effort = request.effort ?? null;
    if (effort && !model) throw new Error("effort-requires-model");
    const workspace = canonicalize(this.host.store.workspacePath(workspaceId));
    const home = canonicalize(this.host.sessions.codexHome());
    const workspaceRow = (
      this.host.store.listWorkspaces() as Array<{ id: string; path: string }>
    ).find((row) => row.id === workspaceId);
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
    openManagedLedger(this.host.dataDir, true)?.close();
    let release: (() => void) | undefined = acquireManagedSessionLease(this.host.dataDir, id);
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
      this.host.dataDir,
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

    saveManagedRecord(this.host.dataDir, record);
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
          dispatchManagedCommand(this.host.dataDir, request.requestId);
          dispatched = true;
        },
        undefined,
        {
          onFailure: finalizeFailure,
          validateModelChoice: model !== null || effort !== null || request.serviceTier != null,
        },
      );
      release = undefined;
      this.#managedRunners.set(id, runner);
      const live = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      const result = {
        sessionId: id,
        accepted: true,
        completed: true,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
        live,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        runtimeBootId: this.host.runtimeBootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
  }

  managedResume(value: unknown, restrictNativePolicy = false) {
    return this.host.runOperation(() => this.#managedResume(value, restrictNativePolicy));
  }

  async #managedResume(value: unknown, restrictNativePolicy: boolean) {
    const request = managedResumeSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    const record = readManagedRecords(this.host.dataDir, this.host.store, true).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (!record.released) throw new Error("session-not-released");
    if (record.archived) throw new Error("session-archived");
    if (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(record);
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    let release: (() => void) | undefined = acquireManagedSessionLease(
      this.host.dataDir,
      request.sessionId,
    );
    const latest = readManagedRecords(this.host.dataDir, this.host.store, true).find(
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
      this.host.dataDir,
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
    saveManagedRecord(this.host.dataDir, resumed as unknown as Record<string, unknown>);
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
      saveManagedRecord(this.host.dataDir, resumed as unknown as Record<string, unknown>);
      runner = await this.#attachManagedRunner(
        resumed,
        workspace,
        home,
        release,
        () => {
          dispatchManagedCommand(this.host.dataDir, request.requestId);
          dispatched = true;
        },
        undefined,
        { onFailure: finalizeFailure, restrictNativePolicy },
      );
      release = undefined;
      this.#managedRunners.set(request.sessionId, runner);
      const live = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      const result = {
        sessionId: request.sessionId,
        accepted: true,
        completed: true,
        live,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        runtimeBootId: this.host.runtimeBootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
  }

  async queue(value: unknown) {
    const request = managedQueueSchema.parse(value);
    const waiting = this.#ownerWait.read(request.sessionId);
    if (waiting && !waiting.worker) {
      const source = await this.#inactiveRecord(request.sessionId);
      if (source.native_id !== waiting.nativeId || source.workspace_id !== waiting.workspaceId)
        throw new Error("session-unavailable");
      const paused = this.#ownerWait.paused(waiting);
      const runner = this.#managedRunners.get(request.sessionId);
      const native =
        !request.ownerWaitOnly && runner?.session.connected && runner.queueVerified === true
          ? await readManagedQueue(
              runner.session,
              waiting.nativeId,
              Math.max(1, (request.limit ?? 100) - 1),
            )
          : undefined;
      return {
        complete: native?.complete ?? true,
        nextCursor: null,
        data: [
          {
            id: waiting.request.requestId,
            ownerWait: true,
            ownerWaitDeviceId: waiting.request.deviceId ?? "desktop-local",
            ownerWaitWorkspaceId: waiting.workspaceId,
            status: waiting.delivering ? "unknown" : "pending",
            reason: waiting.delivering
              ? "control-outcome-unconfirmed"
              : paused
                ? OWNER_WAIT_PAUSED
                : OWNER_WAIT_REASON,
            input: waiting.request.input ?? [{ type: "text", text: waiting.request.text ?? "" }],
            actions: {
              update: { available: false, reason: OWNER_WAIT_REASON },
              delete: {
                available: !waiting.delivering || waiting.bootId !== this.host.runtimeBootId,
              },
            },
          },
          ...(request.limit === 1 ? [] : (native?.data ?? [])),
        ],
      };
    }
    if (request.ownerWaitOnly) return { data: [], complete: true, nextCursor: null };
    const record = readManagedRecords(this.host.dataDir, this.host.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    if (record.archived) throw new Error("session-archived");
    const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
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
      release = acquireManagedSessionLease(this.host.dataDir, request.sessionId);
      const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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
      this.host.assertOpen();
      session = await CodexAppServerSession.start(
        executable,
        cwd,
        home,
        { ...process.env, ...this.host.environment },
        undefined,
        (started) => {
          session = started;
          this.#trackTransientSession(started, release);
        },
      );
      this.host.assertOpen();
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
    return this.host.runOperation(() => this.#managedUnarchive(value));
  }

  async #managedUnarchive(value: unknown) {
    const request = managedUnarchiveSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    const record = readManagedRecords(this.host.dataDir, this.host.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) throw new Error("session-unavailable");
    if (!record.archived) throw new Error("session-not-archived");
    if (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(record);
    const cwd = this.#managedCwd(record);
    let release: (() => void) | undefined = acquireManagedSessionLease(
      this.host.dataDir,
      request.sessionId,
    );
    const claimed = claimManagedCommand(
      this.host.dataDir,
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
      const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
        (item) => item.id === request.sessionId,
      );
      if (!latest || !latest.archived || latest.native_id !== record.native_id)
        throw new Error("session-unavailable");
      const executable = this.#codexReader();
      if (!executable) throw new Error("codex-cli-unavailable");
      this.host.assertOpen();
      session = await CodexAppServerSession.start(
        executable,
        cwd,
        home,
        { ...process.env, ...this.host.environment },
        undefined,
        (started) => {
          session = started;
          // Unarchive still has a durable state change to finish after native close.
          this.#trackTransientSession(started);
        },
      );
      this.host.assertOpen();
      const response = await session.request(
        "thread/unarchive",
        { threadId: latest.native_id },
        () => {
          this.host.assertOpen();
          dispatchManagedCommand(this.host.dataDir, request.requestId);
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
      saveManagedRecord(this.host.dataDir, latest as unknown as Record<string, unknown>);
      const result = {
        sessionId: request.sessionId,
        accepted: true,
        completed: true,
        requiresResume: true,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        runtimeBootId: this.host.runtimeBootId,
      };
      if (definite) finishManagedCommand(this.host.dataDir, request.requestId, result);
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
    return this.host.runOperation(async () => {
      const request = managedDeleteSchema.parse(value);
      const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
      // Like a control, this keeps idle retirement away from a runner the delete closes itself.
      const admission = this.host.controlSessions.get(request.sessionId) ?? {
        count: 0,
        observed: false,
      };
      admission.count += 1;
      this.host.controlSessions.set(request.sessionId, admission);
      try {
        return await this.#managedDelete(request, fingerprint);
      } finally {
        admission.count -= 1;
        if (admission.count === 0) this.host.controlSessions.delete(request.sessionId);
      }
    });
  }

  async #managedDelete(request: z.infer<typeof managedDeleteSchema>, fingerprint: string) {
    const previous = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    if (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
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
      runtimeBootId: this.host.runtimeBootId,
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
        this.host.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId,
        evidence(),
      );
      if (claimed) return claimed;
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    };
    let source: ManagedRecord;
    let home: string;
    let workspace: string;
    try {
      source = await this.#inactiveRecord(request.sessionId);
      home = this.#assertManagedHome(source);
      workspace = canonicalize(this.host.store.workspacePath(source.workspace_id));
    } catch (error) {
      return reject(error instanceof Error ? error.message : "session-unavailable");
    }
    workspaceId = source.workspace_id;
    const nativeId = source.native_id ?? null;
    // Only an earlier delete may still be unconfirmed: retrying it is how that outcome resolves.
    const unconfirmed = readUnknownManagedCommands(this.host.dataDir, source.id);
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
      const snapshot = await runner.bridge.snapshot(this.host.runtimeBootId, true);
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
      this.host.dataDir,
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
        const current = await runner.bridge.snapshot(this.host.runtimeBootId, true);
        assertActivityAllows(current, "delete");
        if (
          current.reason ||
          current.status !== "idle" ||
          current.revision !== request.expectedRevision
        )
          throw new Error("session-busy");
        // AgentKib's own app-server holds the thread; its lock frees once that process exits.
        await this.#closeManagedRunner(source.id, runner, () => {
          const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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
          saveManagedRecord(this.host.dataDir, latest as unknown as Record<string, unknown>);
        });
        if (ownerBusy()) throw new Error("codex-owner-busy");
      }
      release = acquireManagedSessionLease(this.host.dataDir, source.id);
      if (nativeId) {
        const executable = writer;
        if (!executable) throw new Error("codex-cli-unavailable");
        this.host.assertOpen();
        session = await CodexAppServerSession.start(
          executable,
          workspace,
          home,
          { ...process.env, ...this.host.environment },
          undefined,
          (started) => {
            session = started;
            this.#trackTransientSession(started);
          },
        );
        this.host.assertOpen();
        try {
          await session.request("thread/delete", { threadId: nativeId }, () => {
            this.host.assertOpen();
            dispatchManagedCommand(this.host.dataDir, request.requestId);
            dispatched = true;
          });
        } catch (error) {
          // A retry after an unconfirmed delete, or a thread already deleted in Codex, finds
          // no rollout: the conversation is gone either way.
          if (!dispatched || !codexThreadMissing(error)) throw error;
        }
      } else {
        // No thread was ever confirmed and no command is unconfirmed: nothing exists in Codex.
        dispatchManagedCommand(this.host.dataDir, request.requestId);
        dispatched = true;
      }
      this.#forgetDeletedSession(source, home);
      const result = outcome({ accepted: true, completed: true, deleted: true });
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      for (const prior of unconfirmed)
        finishManagedCommand(
          this.host.dataDir,
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
      if (definite) finishManagedCommand(this.host.dataDir, request.requestId, result);
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
      for (const record of listManagedRecords(this.host.dataDir)) {
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
    deleteManagedSessions(this.host.dataDir, [...ids]);
    const refs = new Set([source.native_id, nativeId].filter((ref): ref is string => !!ref));
    const indexed = [...ids, ...[...refs].map((ref) => this.host.store.sessions.id("codex", ref))];
    if (this.host.sessionIndex) this.host.sessionIndex.forget(indexed);
    else this.host.store.sessions.forget(indexed);
    for (const id of ids) {
      this.#ownership.delete(id);
      this.#catalogObservations.delete(id);
    }
    this.host.catalogChanged?.();
  }

  async #managedSettingsState(request: SettingsRead, waitForCatalog = false) {
    const stored = readManagedRecords(this.host.dataDir, this.host.store).find(
      (item) => item.id === request.sessionId,
    );
    const record = stored ?? (await this.#inactiveRecord(request.sessionId));
    const runner = this.#managedRunners.get(request.sessionId);
    const nativePolicy = !runner?.session.connected ? this.#nativeCodexPolicy(record) : undefined;
    if (nativePolicy && this.#ownership.get(record.id)?.reason === "codex-owner-busy")
      this.#codexWriterOwnership(record, true);
    const ownerSnapshot = await this.#managedLive(request.sessionId);
    if (ownerSnapshot.executionMode === "codex-follower") {
      const follower = this.#desktopFollower.attached(record);
      if (!follower?.bridge.selectedState) throw new Error("session-state-unavailable");
      const access = await this.#codexFollowerSettingsAccess(record, follower);
      const state = follower.bridge.selectedState;
      if (!state || this.#desktopFollower.attached(record) !== follower)
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
          ...nativePolicySettings(record, settings, nativePolicy, true),
          writable: {
            ...writable,
            ...(nativePolicy
              ? { policy: nativePolicyWriteAccess(nativePolicy, "follower-operation-unverified") }
              : {}),
            model: error ? { available: false, reason: error } : true,
            effort: error ? { available: false, reason: error } : access.effortWritable,
          },
        },
        runtimeBootId: this.host.runtimeBootId,
      };
    }
    const settings = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.host.runtimeBootId,
      false,
    ).settings;
    const projection = isObject(settings) ? settings : {};
    const settingsObject = {
      ...projection,
      ...nativePolicySettings(record, projection, nativePolicy),
    };
    const reselectPolicy = canReselectNativePolicy(nativePolicy);
    if (!runner?.session.connected) {
      const history =
        request.includeHistorical &&
        record.native_id &&
        ownerSnapshot.executionLocation === null &&
        (ownerSnapshot.status === "idle" || ownerSnapshot.status === "unsupported") &&
        this.#isCodexHome(record.home)
          ? this.host.sessions.codexHistoricalSettings(record.native_id, record.workspace)
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
        settings: {
          ...settingsObject,
          ...(nativePolicy
            ? { writable: { policy: nativePolicyWriteAccess(nativePolicy, reason) } }
            : {}),
        },
        ...historical,
      });
      if (ownerSnapshot.reason) return unavailable(ownerSnapshot.reason);
      const checked = await this.#preflight.check();
      if (!checked.executable || checked.reason) return unavailable(checked.reason);
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const executable = checked.executable;
      const key = codexCatalogKey(executable, home, cwd);
      const pending =
        !waitForCatalog && nativePolicy !== undefined && !this.#settingsCatalog.has(key);
      const catalog = pending
        ? undefined
        : await this.#readCodexSettingsCatalog(executable, home, cwd).catch((error: unknown) => {
            if (!history && !nativePolicy) throw error;
            return undefined;
          });
      if (pending) this.#refreshCodexSettingsCatalog(record.id, key, executable, home, cwd);
      else if (!catalog) return unavailable("request_failed");
      const models = catalog?.models ?? [];
      const collaborationModes = catalog?.collaborationModes ?? [];
      const modelAccess = catalog
        ? true
        : { available: false, reason: "codex-settings-catalog-loading" };
      return {
        available: true,
        executionMode: "codex-managed",
        models,
        policies: nativePolicy?.policyId === null && !reselectPolicy ? [] : managedPolicyCatalog(),
        collaborationModes,
        revision: record.snapshot?.revision ?? 0,
        runtimeBootId: this.host.runtimeBootId,
        ...historical,
        settings: {
          ...settingsObject,
          writable: {
            model: modelAccess,
            effort: modelAccess,
            mode:
              collaborationModes.length || record.mode != null
                ? { available: true }
                : { available: false, reason: "native-collaboration-modes-unavailable" },
            serviceTier: modelAccess,
            policy: reselectPolicy
              ? record.snapshot?.policyReselected === true
                ? true
                : { available: true, reason: nativePolicy.reason }
              : nativePolicyWriteAccess(nativePolicy),
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
    const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
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
    const live = await runner.bridge.snapshot(this.host.runtimeBootId, false);
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
      runtimeBootId: this.host.runtimeBootId,
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

  /** Read the catalog without resuming a Worker thread or acquiring its writer. */
  async workerSettingsObservation(sessionId: string, source?: "worker") {
    const resident = this.#managedRunners.get(sessionId);
    if (resident?.session.connected && !resident.retiring) {
      const models = projectManagedModels(
        await resident.session.request("model/list", { limit: 100 }),
      );
      if (
        this.#managedRunners.get(sessionId) !== resident ||
        resident.retiring ||
        !resident.session.connected
      )
        return { available: false };
      return projectWorkerModelCatalog(models);
    }
    try {
      const stored = readManagedRecord(this.host.dataDir, sessionId);
      const record = await this.#inactiveRecord(
        sessionId,
        stored ? managedRecordSchema.parse(stored) : null,
      );
      const followed = this.#desktopFollower.attached(record)?.bridge.selectedState;
      if (followed) return followed.settingsState();
      const executable = this.#codexReader();
      if (!executable) return { available: false };
      const home = this.#assertManagedHome(record);
      const cwd = this.#managedCwd(record);
      const catalog =
        stored && source === "worker"
          ? await this.#readCodexSettingsCatalog(executable, home, cwd)
          : this.#settingsCatalog.peek(codexCatalogKey(executable, home, cwd));
      return projectWorkerModelCatalog(catalog?.models);
    } catch {
      return { available: false };
    }
  }

  #refreshCodexSettingsCatalog(
    sessionId: string,
    key: string,
    executable: string,
    home: string,
    cwd: string,
  ): void {
    if (this.host.isClosing() || this.#settingsCatalogNotifications.get(sessionId) === key) return;
    this.#settingsCatalogNotifications.set(sessionId, key);
    void this.#readCodexSettingsCatalog(executable, home, cwd)
      .then(() => {
        if (!this.host.isClosing() && this.#settingsCatalogNotifications.get(sessionId) === key)
          this.host.publishConversationEvent?.(sessionId, "invalidate", { domains: ["settings"] });
      })
      .catch(() => {
        // Policy remains usable independently of an unavailable model catalog.
      })
      .finally(() => {
        if (this.#settingsCatalogNotifications.get(sessionId) === key)
          this.#settingsCatalogNotifications.delete(sessionId);
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

  async query(request: SessionQuery) {
    const record = readManagedRecords(this.host.dataDir, this.host.store).find(
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
        const followed = await this.#desktopFollower.live(source, live, controls);
        if (followed) {
          const f = followed;
          const waiting = this.#ownerWait.read(source.id);
          const unknown = managedSessionHasUnknownCommands(this.host.dataDir, source.id);
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
              : readUnknownManagedCommands(this.host.dataDir, source.id).some(
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
          if (waiting && !waiting.worker) {
            features["queue-list"] = { available: true };
            features["queue-delete"] = {
              available:
                controls && (!waiting.delivering || waiting.bootId !== this.host.runtimeBootId),
            };
            features.send = {
              available: controls && this.#ownerWait.paused(waiting) && !waiting.delivering,
              reason: OWNER_WAIT_REASON,
            };
          }
          return {
            sessionId: source.id,
            executionMode: "codex-follower",
            ...(waiting && !waiting.worker && { ownerWaitQueue: true }),
            runtimeBootId: this.host.runtimeBootId,
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
          !managedSessionHasUnknownCommands(this.host.dataDir, source.id) &&
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
        features.send =
          allowed && typeof live.sendDisabledReason !== "string"
            ? { available: true }
            : {
                available: false,
                reason:
                  allowed && typeof live.sendDisabledReason === "string"
                    ? live.sendDisabledReason
                    : unavailableReason === "session-not-running"
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
          !managedSessionHasUnknownCommands(this.host.dataDir, source.id)
            ? { available: true }
            : { available: false, reason: checked.reason ?? "session-not-archived" };
        // Deleting starts no runner and includes archived conversations, as Codex's own does.
        // Only another process holding the thread blocks it; an unconfirmed earlier delete
        // is retried by the next one.
        const deleteReason = !controls
          ? "control-disabled"
          : checked.reason && source.native_id
            ? checked.reason
            : readUnknownManagedCommands(this.host.dataDir, source.id).some(
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
        // attachments, as a follower sends them) asks the app to take it (desktop handoff).
        if (await this.#desktopFollower.handoffLive(source, live, controls)) {
          features.send = { available: true };
          features.attachments = { available: true };
        }
        const waiting = this.#ownerWait.read(source.id);
        if (waiting && !waiting.worker) {
          features["queue-list"] = { available: true };
          features["queue-delete"] =
            controls && (!waiting.delivering || waiting.bootId !== this.host.runtimeBootId)
              ? { available: true }
              : { available: false, reason: OWNER_WAIT_REASON };
        }
        if (waiting) {
          features.send =
            controls &&
            this.#ownerWait.paused(waiting) &&
            !waiting.delivering &&
            (live.reason === null || this.#ownerWaitAvailable(live, controls))
              ? { available: true }
              : { available: false, reason: OWNER_WAIT_REASON };
        } else if (this.#ownerWaitAvailable(live, controls)) {
          features.send = { available: true };
          features.attachments = { available: true };
        }
        return {
          sessionId: source.id,
          executionMode: "codex-managed",
          ...(waiting && !waiting.worker && { ownerWaitQueue: true }),
          runtimeBootId: this.host.runtimeBootId,
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
      const unknown = managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId);
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
        managed && this.#usageLimits.canCancel(record.id),
        "usage-limit-continue-unavailable",
      );
      set(
        "usage-limit-continue",
        managed && this.#usageLimits.canContinue(record.id),
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
      readUnknownManagedCommands(this.host.dataDir, request.sessionId).some(({ evidence }) =>
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
      workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
        throw new Error("session-workspace-mismatch");
      home = this.#assertManagedHome(record);
      if (!record.native_id) throw new Error("native-session-unconfirmed");
      nativeId = record.native_id;
    } else {
      const summary = this.host.store.sessions.get(request.sessionId);
      if (!summary) throw new Error("session-unavailable");
      if (summary.agent !== "codex") throw new Error("session-not-codex");
      const resolved = await this.host.sessions.resolve(request.sessionId);
      nativeId = resolved.native.native_ref;
      if (!this.host.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
        throw new Error("unverified-session-identity");
      workspace = canonicalize(resolved.workspace);
      home = canonicalize(this.host.sessions.codexHome());
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
      const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
        (item) => item.id === record.id,
      );
      if (!latest || latest.native_id !== nativeId || latest.workspace_id !== record.workspace_id)
        throw new Error("session-unavailable");
      const unknownCommands = readUnknownManagedCommands(this.host.dataDir, record.id);
      const runner = this.#managedRunners.get(record.id);
      let queue: Awaited<ReturnType<typeof readManagedQueue>> | null = null;
      if (unknownCommands.some((command) => command.evidence?.operation === "queue-add")) {
        let queueSession = runner?.session.connected ? runner.session : undefined;
        const ownsQueueSession = !queueSession;
        try {
          if (!queueSession) {
            this.host.assertOpen();
            queueSession = await CodexAppServerSession.start(
              executable,
              executionCwd,
              home,
              { ...process.env, ...this.host.environment },
              undefined,
              (started) => {
                queueSession = started;
                this.#trackTransientSession(started);
              },
            );
            this.host.assertOpen();
          }
          queue = await readManagedQueue(queueSession, nativeId, 100);
        } catch {
          queue = null;
        } finally {
          if (ownsQueueSession) await queueSession?.close();
        }
      }
      const followerState = this.#desktopFollower.attached(record)?.bridge.selectedState ?? null;
      for (const unknown of unknownCommands) {
        const evidence = unknown.evidence;
        const nativeRequestResolved =
          evidence?.runtimeBootId === this.host.runtimeBootId &&
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
          finishManagedCommand(this.host.dataDir, unknown.requestId, {
            accepted: true,
            completed: false,
            reconciled: true,
            requestId: unknown.requestId,
            runtimeBootId: this.host.runtimeBootId,
            sessionId: record.id,
          });
      }
    } else {
      // Older Desktop-follower receipts still need a conservative, read-only
      // reconciliation path after that transport leaves the main flow.
      const followerState =
        this.#desktopFollower.attached({ id: request.sessionId, native_id: nativeId })?.bridge
          .selectedState ?? null;
      for (const unknown of readUnknownManagedCommands(this.host.dataDir, request.sessionId)) {
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
          finishManagedCommand(this.host.dataDir, unknown.requestId, {
            accepted: true,
            completed: false,
            reconciled: true,
            requestId: unknown.requestId,
            runtimeBootId: this.host.runtimeBootId,
            sessionId: request.sessionId,
          });
        else unresolvedCount += 1;
      }
    }
    const context = await this.context(request.sessionId);
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

  /** Whether a managed Codex session waits for its usage limit to reset. */
  usageLimited(sessionId: string): boolean {
    return this.#usageLimits.isLimited(sessionId);
  }

  refreshWorkerUsageLimit(sessionId: string): Promise<boolean> {
    return this.host.runOperation(() => this.#usageLimits.refreshWorker(sessionId));
  }

  /** A device lost access: AgentKib no longer continues in its name after a usage limit. */
  invalidateUsageLimitDevice(deviceId: string): void {
    this.#usageLimits.invalidateDevice(deviceId);
    this.#ownerWait.invalidateDevice(deviceId);
  }

  /** A short-lived subscription must be recorded even between retirement timer ticks. */
  observeSession(sessionId: string): void {
    const runner = this.#managedRunners.get(sessionId);
    if (runner) runner.observed = true;
    const admission = this.host.controlSessions.get(sessionId);
    if (admission) admission.observed = true;
  }

  async #inactiveCodexControlRecord(
    source: ManagedRecord,
    expectedRevision: number,
    restartRequestId?: string,
  ) {
    const records = readManagedRecords(this.host.dataDir, this.host.store);
    const record =
      records.find((item) => item.id === source.id) ?? (await this.#inactiveRecord(source.id));
    if (
      !record.native_id ||
      record.native_id !== source.native_id ||
      record.archived ||
      (restartRequestId !== undefined && record.released) ||
      record.workspace_id !== source.workspace_id ||
      (record.snapshot?.revision ?? 0) !== expectedRevision ||
      readUnknownManagedCommands(this.host.dataDir, source.id).some(
        (entry) => entry.requestId !== restartRequestId,
      )
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

  async #connectCodexForControl(
    source: ManagedRecord,
    request: SettingsControl,
    restrictNativePolicy: boolean,
    inheritNativePolicy = false,
    resume?: { beforeResume: () => void; evidence?: CodexQuitEvidence; requestId?: string },
  ) {
    const unlock = acquireManagedSessionLease(this.host.dataDir, source.id);
    let ownsLease = true;
    const release = () => {
      if (!ownsLease) return;
      ownsLease = false;
      unlock();
    };
    let prior: ManagedRecord | undefined;
    const restore = (_error: unknown, ownsLease: boolean) => {
      if (prior && ownsLease) {
        saveManagedRecord(this.host.dataDir, prior);
        prior = undefined;
      }
    };
    try {
      const record = await this.#inactiveCodexControlRecord(
        source,
        request.expectedRevision,
        resume?.requestId,
      );
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      this.host.assertOpen();
      // A closed, never-written native thread is not resumable. Keep the logical
      // session and let its first turn open a native thread under the same lease.
      const startNewThread =
        !resume &&
        request.operation === "send" &&
        record.snapshot?.unwrittenNativeThread === true &&
        !record.adopted &&
        !record.source_session_id &&
        !this.host.sessions.codexThreadWritten(record.native_id) &&
        !existingFileLeaseBusy(path.join(home, "thread-writer-locks", `${record.native_id}.lock`));
      const starting: ManagedRecord = {
        ...record,
        ...(startNewThread ? { native_id: null } : {}),
        cwd,
        released: false,
        snapshot: { ...record.snapshot, status: "starting", reason: null },
      };
      saveManagedRecord(this.host.dataDir, starting);
      prior = record;
      const runner = await this.#attachManagedRunner(
        starting,
        record.workspace,
        home,
        release,
        resume?.beforeResume,
        undefined,
        {
          onFailure: restore,
          restrictNativePolicy,
          inheritNativePolicy,
          allowReselectedPolicy: request.operation === "send" && !resume,
          quitResume: resume?.evidence,
        },
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
    const release = acquireManagedSessionLease(this.host.dataDir, source.id);
    try {
      const record = await this.#inactiveCodexControlRecord(source, request.expectedRevision);
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const policyOnly = codexPolicyOnly(request);
      let reselectPolicy = false;
      if (request.policyId !== undefined) {
        const nativePolicy = this.#nativeCodexPolicy(record);
        reselectPolicy = canReselectNativePolicy(nativePolicy);
        if (nativePolicy?.policyId === null && !reselectPolicy)
          throw new Error(nativePolicy.reason);
      }
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
      if (request.policyId !== undefined) {
        settings.policy_id = request.policyId;
        settings.policy_override = true;
      }
      const snapshot: Record<string, unknown> = {
        ...record.snapshot,
        status: "idle",
        reason: null,
        settingsStaged: true,
        revision: request.expectedRevision + 1,
      };
      if (reselectPolicy) snapshot.policyReselected = true;
      else if (request.policyId !== undefined) delete snapshot.policyReselected;
      // This flag also covers mode-only writes so resume keeps the inherited model settings.
      if ((policyOnly || modeOnly) && !hasStagedCodexModelSettings(record))
        snapshot.policyOnlyStaged = true;
      else delete snapshot.policyOnlyStaged;
      const staged: ManagedRecord = {
        ...record,
        ...settings,
        snapshot,
      };
      this.host.assertOpen();
      if (this.#assertManagedHome(record) !== home || this.#managedCwd(record) !== cwd)
        throw new Error("codex-workspace-mismatch");
      if (existingFileLeaseBusy(path.join(home, "thread-writer-locks", `${record.native_id}.lock`)))
        throw new Error("codex-owner-busy");
      if (managedSessionHasUnknownCommands(this.host.dataDir, source.id))
        throw new Error("control-outcome-unconfirmed");
      const result = {
        accepted: true,
        completed: true,
        appliesTo: "next-turn",
        sessionId: source.id,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
      };
      saveManagedSettingsReceipt(this.host.dataDir, staged, request.requestId, result);
      this.host.publishConversationEvent?.(source.id, "invalidate", {
        domains: ["settings", "ownership", "receipts"],
      });
      return result;
    } finally {
      release();
    }
  }

  async #codexControl(
    request: SettingsControl,
    fingerprint: string,
    {
      restrictNativePolicy = false,
      desktopOwnerHandoff = false,
      workerTurn = false,
      workerRestart,
      workerOwner,
      ownerWaitDispatch,
      quitResume,
    }: {
      restrictNativePolicy?: boolean;
      desktopOwnerHandoff?: boolean;
      workerTurn?: boolean;
      workerRestart?: { workspaceId: string; beforeDispatch: () => void };
      workerOwner?: DeferredCodexSendOwner;
      ownerWaitDispatch?: () => void;
      quitResume?: { runner: ManagedRunner; evidence: CodexQuitEvidence };
    } = {},
  ) {
    if (!workerRestart && this.#restartingWorkers.has(request.sessionId))
      throw new Error("worker-restart-in-progress");
    let record = readManagedRecords(this.host.dataDir, this.host.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
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
    if (
      record &&
      (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
    )
      throw new Error("stale-or-disabled-control");
    const waiting = this.#ownerWait.read(request.sessionId);
    if (
      waiting &&
      request.operation === "queue-delete" &&
      !waiting.worker &&
      request.queuedSubmissionId === waiting.request.requestId
    ) {
      const source = record ?? (await this.#inactiveRecord(request.sessionId));
      if (
        source.workspace_id !== waiting.workspaceId ||
        ((restrictNativePolicy || request.ownerWaitOnly) &&
          (request.deviceId ?? "desktop-local") !== (waiting.request.deviceId ?? "desktop-local") &&
          !(
            request.deviceId === "desktop-local" &&
            waiting.delivering &&
            waiting.bootId !== this.host.runtimeBootId
          ))
      )
        throw new Error("session-unavailable");
      const prior = claimManagedCommand(
        this.host.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId ?? null,
        codexCommandEvidence(request, source.workspace_id),
      );
      if (prior) return prior;
      const cancelled = waiting.delivering
        ? this.#ownerWait.dismissInterrupted(waiting)
        : this.#ownerWait.cancel(waiting);
      const result = {
        accepted: cancelled,
        ownerWaitOnly: true,
        completed: cancelled,
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
        ...(!cancelled ? { reason: "control-outcome-unconfirmed" } : {}),
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
    if (request.ownerWaitOnly) throw new Error("queue-item-not-found");
    if (waiting && request.operation === "send" && !ownerWaitDispatch) {
      if (
        this.#ownerWait.paused(waiting) &&
        !waiting.delivering &&
        request.deviceId === waiting.request.deviceId &&
        (workerOwner || isLocalCodexSender(request.deviceId) || request.allowOwnerWait === true) &&
        stableJson(waiting.worker) === stableJson(workerOwner) &&
        sameWaitingCodexInput(request, waiting.request)
      ) {
        const source = record ?? (await this.#inactiveRecord(request.sessionId));
        if (source.native_id !== waiting.nativeId || source.workspace_id !== waiting.workspaceId)
          throw new Error("session-unavailable");
        const current = await this.#managedLive(
          request.sessionId,
          true,
          workerOwner ? "send" : undefined,
        );
        if (current.revision !== request.expectedRevision)
          throw new Error("stale-or-disabled-control");
        const result = {
          accepted: true,
          completed: false,
          status: "waiting-for-owner",
          reason: OWNER_WAIT_REASON,
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.host.runtimeBootId,
        };
        const prior = claimManagedCommand(
          this.host.dataDir,
          request.requestId,
          request.sessionId,
          fingerprint,
          request.deviceId ?? null,
          codexCommandEvidence(request, source.workspace_id),
        );
        if (prior) return prior;
        const resumed = this.#ownerWait.resume(waiting, restrictNativePolicy);
        const receipt = resumed
          ? result
          : {
              ...result,
              accepted: false,
              status: "not-dispatched",
              controlOutcome: "not-dispatched",
              reason: "codex-owner-wait-not-authorized",
            };
        finishManagedCommand(this.host.dataDir, request.requestId, receipt);
        return receipt;
      }
      throw new Error(OWNER_WAIT_REASON);
    }
    if (request.operation === "usage-limit-cancel")
      return this.#usageLimits.cancel(request, record, fingerprint);
    if (request.operation === "usage-limit-continue")
      return this.#usageLimits.continue(request, record, fingerprint);
    this.#usageLimits.beforeControl(request, restrictNativePolicy);
    let runner = this.#managedRunners.get(request.sessionId);
    if (
      quitResume &&
      (runner !== quitResume.runner || !runner.session.connected || runner.retiring)
    )
      throw new Error("quit-continuation-stale");
    if (workerRestart) {
      if (record && record.workspace_id !== workerRestart.workspaceId)
        throw new Error("workspace-not-allowed");
      // A Project Agent may interrupt only the host's own runner. Never follow a different
      // writer or acquire a new one when ownership changed since its live observation.
      if (!record || record.released || !runner) throw new Error("worker-restart-user-only");
      if (!runner.session.connected || runner.retiring)
        throw new Error("worker-restart-unsupported");
    }
    let resumedControlState: string | undefined;
    // Observation-only updates may advance revision, but every control change advances
    // mutationRevision. Keep the original observation and the same native turn at both checks.
    const matchesObservedControl = (state: ManagedCodexState, live: Record<string, unknown>) =>
      workerTurn || workerRestart
        ? Boolean(request.turnId) &&
          request.turnId === live.turnId &&
          request.expectedRevision >= state.mutationRevision &&
          request.expectedRevision <= Number(live.revision)
        : live.revision === request.expectedRevision;
    let prepared = false;
    const claim = (workspaceId: string) =>
      claimManagedCommand(
        this.host.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId ?? null,
        {
          ...codexCommandEvidence(request, workspaceId),
          ...(workerRestart ? { operation: "worker-restart" } : {}),
        },
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
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    };
    if (!runner?.session.connected || runner.retiring) {
      const inactive = record ?? (await this.#inactiveRecord(request.sessionId));
      const rejectInactive = (reason: string) => reject(reason, inactive.workspace_id);
      if (workerTurn) return rejectInactive("stale-or-disabled-control");
      const wait = () =>
        !ownerWaitDispatch &&
        request.operation === "send" &&
        (workerOwner || !desktopOwnerHandoff) &&
        this.#acceptOwnerWait(inactive, request, fingerprint, restrictNativePolicy, workerOwner);
      const waitAfterFollower = () =>
        this.#codexWriterOwnership(inactive, true) === "codex-owner-busy" && wait();
      if (
        runner?.retiring ||
        managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId)
      )
        return rejectInactive("control-outcome-unconfirmed");
      const observedFollower = ownerWaitDispatch
        ? undefined
        : this.#desktopFollower.attached(inactive);
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
        return this.#codexFollowerControl(
          request,
          fingerprint,
          follower,
          inactive.workspace_id,
          false,
          waitAfterFollower,
        );
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
        if (desktopOwnerHandoff && request.operation === "send") {
          const owner = this.#codexWriterOwnership(inactive, true);
          const offered = await this.#desktopFollower.handoffLive(
            inactive,
            { ownershipReason: owner, reason: owner },
            true,
          );
          if (!offered) {
            if (owner === "codex-owner-busy") {
              const queued = wait();
              if (queued) return queued;
            }
            return rejectInactive("codex-desktop-owner-missing");
          }
          const handed = await this.#desktopFollower.handoff(inactive);
          if ("reason" in handed)
            return (isDesktopUnavailable(handed.reason) && wait()) || rejectInactive(handed.reason);
          return this.#codexFollowerControl(
            { ...request, expectedRevision: handed.revision },
            fingerprint,
            handed.follower,
            inactive.workspace_id,
            true,
            waitAfterFollower,
          );
        }
        if (
          !ownerWaitDispatch &&
          request.operation === "send" &&
          this.#codexWriterOwnership(inactive) === "codex-owner-busy" &&
          inactive.snapshot?.settingsStaged !== true
        ) {
          const handed = await this.#desktopFollower.handoff(inactive);
          if ("follower" in handed)
            return this.#codexFollowerControl(
              { ...request, expectedRevision: handed.revision },
              fingerprint,
              handed.follower,
              inactive.workspace_id,
              true,
              waitAfterFollower,
            );
          const queued = isDesktopUnavailable(handed.reason) && wait();
          if (queued) return queued;
          return rejectInactive(handed.reason);
        }
        runner = await this.#connectCodexForControl(
          inactive,
          request,
          restrictNativePolicy,
          ownerWaitDispatch !== undefined,
        );
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
        if (
          busy &&
          !ownerWaitDispatch &&
          request.operation === "send" &&
          inactive.snapshot?.settingsStaged !== true
        ) {
          const handed = await this.#desktopFollower.handoff(inactive).catch(() => undefined);
          if (handed && "follower" in handed)
            return this.#codexFollowerControl(
              { ...request, expectedRevision: handed.revision },
              fingerprint,
              handed.follower,
              inactive.workspace_id,
              true,
              waitAfterFollower,
            );
          const queued =
            handed && "reason" in handed && isDesktopUnavailable(handed.reason) && wait();
          if (queued) return queued;
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
      if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      this.#assertManagedHome(record);
      if (!record.native_id || record.native_id !== runner.state.nativeId)
        throw new Error("native-session-unconfirmed");
      cwd = this.#managedCwd(record);
      snapshot = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      if (activityBlocks(snapshot, request.operation)) {
        const result = this.host.compactingRejection(request, this.host.runtimeBootId);
        if (prepared) finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      }
      if (
        resumedControlState !== undefined &&
        managedControlState(runner.state) === resumedControlState
      )
        request.expectedRevision = Number(snapshot.revision);
      if (snapshot.reason || !matchesObservedControl(runner.state, snapshot))
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
      let method: string;
      let params: unknown;
      let responseId: unknown;
      let restartQueue: string[] | undefined;
      let localMutation:
        | Partial<
            Pick<
              ManagedRecord,
              | "model"
              | "effort"
              | "service_tier"
              | "policy_id"
              | "policy_override"
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
        if (workerRestart) {
          if (isObject(record.goal) && record.goal.status === "active")
            throw new Error("pause-original-goal-before-handoff");
          restartQueue = await this.#quitQueue(runner, record);
          if (!restartQueue) throw new Error("worker-restart-native-queue-unconfirmed");
        }
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
        this.#titleThreads.userRenamed(record.native_id);
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
        const policy = codexPolicyOnly(request);
        if (policy) localMutation = { policy_id: policy, policy_override: true };
        else if (
          request.mode === null &&
          !changesCodexModel(request) &&
          request.policyId === undefined
        )
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
        this.host.assertOpen();
        const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
          (item) => item.id === request.sessionId,
        );
        if (
          this.#managedRunners.get(request.sessionId) !== dispatchRunner ||
          !dispatchRunner.session.connected ||
          ((workerTurn || workerRestart) && dispatchRunner.retiring) ||
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
        const unresolved = quitResume
          ? readUnknownManagedCommands(this.host.dataDir, request.sessionId).some(
              (entry) => entry.requestId !== request.requestId,
            )
          : managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId);
        if (unresolved) throw new Error("control-outcome-unconfirmed");
        const currentSnapshot = dispatchRunner.state.snapshot(this.host.runtimeBootId, true);
        if (
          quitResume &&
          (dispatchRunner.state.turnsStarted !== 0 ||
            this.#quitSettings(dispatchRunner, latest) !== quitResume.evidence.settings ||
            !this.#quitHistory(latest, quitResume.evidence))
        )
          throw new Error("quit-continuation-stale");
        if (
          restrictNativePolicy &&
          latest.adopted &&
          [
            "send",
            "steer",
            "queue-add",
            "queue-update",
            "compact",
            "goal-set",
            "goal-resume",
          ].includes(request.operation)
        ) {
          // send supplies its selected next-turn policy; other operations can use the
          // running thread's native settings, even after a different policy was selected.
          requireFullAccessForNativePolicy(latest.policy_id);
          const settings = currentSnapshot.settings;
          if (request.operation !== "send" && isObject(settings) && isObject(settings.current))
            requireFullAccessForNativePolicy(settings.current.policyId);
        }
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
          !matchesObservedControl(dispatchRunner.state, currentSnapshot) ||
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
        workerRestart?.beforeDispatch();
        ownerWaitDispatch?.();
        dispatchManagedCommand(this.host.dataDir, request.requestId);
      };
      let response: unknown;
      const turnsBefore = runner.state.turnsStarted;
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
          runtimeBootId: this.host.runtimeBootId,
        };
        runner.state.commitSettings(localMutation, () =>
          runner.persist(runner.state, undefined, { requestId: request.requestId, result }),
        );
        return result;
      } else {
        try {
          response =
            quitResume && method === "turn/start" && isObject(params)
              ? await this.#dispatchQuitContinuation(
                  runner,
                  record,
                  params,
                  beforeDispatch,
                  assertDispatchable,
                )
              : await runner.session.request(
                  method,
                  params,
                  beforeDispatch,
                  workerRestart ? 4_000 : undefined,
                );
        } catch (error) {
          // An invalid request or parameters is an explicit refusal, unlike a lost
          // response or an internal error after execution may already have begun.
          if (
            method !== "turn/start" ||
            !(error instanceof CodexAppServerError) ||
            (error.code !== -32600 && error.code !== -32602)
          )
            throw error;
          await runner.bridge.flush();
          const live = runner.state.snapshot(this.host.runtimeBootId, true);
          if (
            !runner.session.connected ||
            runner.state.turnsStarted !== turnsBefore ||
            live.status !== "idle" ||
            live.turnId !== null ||
            live.reason
          )
            throw error;
          const reason = CODEX_TURN_START_REJECTED;
          const nativeError = sanitizeSessionText(error.message, { value: 0 })
            .trim()
            .slice(0, 4096);
          const result = {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            reason,
            nativeError,
            // The Project Agent's send tool reports the existing error string.
            error: nativeError ? `${reason}: ${nativeError}` : reason,
            sessionId: request.sessionId,
            requestId: request.requestId,
            runtimeBootId: this.host.runtimeBootId,
          };
          finishManagedCommand(this.host.dataDir, request.requestId, result);
          runner.state.noteTurnStartRejection(nativeError);
          const failed = runner.state.snapshot(this.host.runtimeBootId, true);
          this.host.publishConversationEvent?.(request.sessionId, "state", failed, failed);
          return result;
        }
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
      if (workerRestart) {
        await confirmCodexWorkerInterrupted(
          runner.bridge,
          request.turnId!,
          turnsBefore,
          () =>
            this.#managedRunners.get(request.sessionId) === dispatchRunner &&
            !dispatchRunner.retiring,
          (nativeId) => this.#externalTurns.endedTurns(nativeId),
          Boolean(restartQueue?.length),
        );
        await this.#closeManagedRunner(request.sessionId, runner);
        const baseline = { ...request, expectedRevision: runner.state.revision };
        const resume = { requestId: request.requestId, beforeResume: workerRestart.beforeDispatch };
        const replacement = await this.#connectCodexForControl(
          record,
          baseline,
          restrictNativePolicy,
          false,
          resume,
        );
        const queuePreserved =
          !restartQueue?.length ||
          (await this.#quitQueue(replacement, record))?.join("\0") === restartQueue.join("\0");
        await replacement.bridge.flush();
        if (
          !queuePreserved ||
          !replacement.session.connected ||
          replacement.state.status !== "idle"
        )
          throw new Error("control-outcome-unconfirmed");
      }

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
        const selectedPolicy = record.policy_id ?? "workspace-write-on-request";
        if (runner.state.lastTurnId === response.turn.id && isCodexPolicyId(selectedPolicy))
          runner.confirmedTurnPolicy = { turnId: response.turn.id, policyId: selectedPolicy };
        runner.written = true;
        runner.persist(runner.state);
      }
      const result = {
        accepted: true,
        completed:
          !!workerRestart || !["send", "stop", "steer", "compact"].includes(request.operation),
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      if (quitResume && error instanceof CodexQuitQueueManual) {
        const result = {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason: QUIT_WORK_MANUAL_REASON,
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.host.runtimeBootId,
        };
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        return result;
      }
      const uncertain = workerRestart
        ? readUnknownManagedCommands(this.host.dataDir, request.sessionId).some(
            (entry) => entry.requestId === request.requestId,
          )
        : managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId);
      if (uncertain) {
        if (!workerRestart || this.#managedRunners.get(request.sessionId) === runner) {
          runner.state.fail("control-outcome-unconfirmed");
          try {
            runner.persist(runner.state);
          } catch {
            // Preserve the ledger snapshot when another writer has advanced it.
          }
        }
        return {
          accepted: false,
          completed: false,
          controlOutcome: "unknown",
          reason: "control-outcome-unconfirmed",
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.host.runtimeBootId,
        };
      }
      const result = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        error: error instanceof Error ? error.message : "control-preflight-rejected",
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
  }

  async #codexFollowerSettingsFeature(record: ManagedRecord, controls: boolean) {
    if (!controls) return { available: false, reason: "control-disabled" };
    const follower = this.#desktopFollower.attached(record);
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
        this.#desktopFollower.attached(record) !== follower ||
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
    if (managedSessionHasUnknownCommands(this.host.dataDir, record.id))
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
      this.#desktopFollower.attached(record) !== follower ||
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
      runtimeBootId: this.host.runtimeBootId,
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
        this.host.dataDir,
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
          this.host.assertOpen();
          const latest =
            readManagedRecords(this.host.dataDir, this.host.store).find(
              (item) => item.id === record.id,
            ) ?? record;
          const blocked = this.#codexFollowerSettingsBlocked(latest, state);
          if (blocked) throw new Error(blocked);
          const summary = this.host.store.sessions.get(record.id);
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
              dispatchManagedCommand(this.host.dataDir, request.requestId);
              dispatched = true;
            },
            onApplied: () =>
              acknowledgeDispatchedManagedCommand(
                this.host.dataDir,
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
        finishManagedCommand(this.host.dataDir, request.requestId, result);
        this.host.publishConversationEvent?.(record.id, "invalidate", {
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
      if (claimed && !dispatched)
        finishManagedCommand(this.host.dataDir, request.requestId, result);
      if (dispatched)
        this.host.publishConversationEvent?.(record.id, "invalidate", {
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
    onUnavailable?: () => false | Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown>> {
    let dispatched = false;
    let claimedHere = false;
    try {
      if (!request.experimentalEnabled || request.runtimeBootId !== this.host.runtimeBootId)
        throw new Error("stale-or-disabled-control");
      if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
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
      if (prepared) annotateManagedCommand(this.host.dataDir, request.requestId, evidence);
      const claimed = prepared
        ? null
        : claimManagedCommand(
            this.host.dataDir,
            request.requestId,
            request.sessionId,
            fingerprint,
            request.deviceId ?? null,
            evidence,
          );
      if (claimed) return claimed;
      claimedHere = true;

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
            dispatchManagedCommand(this.host.dataDir, request.requestId);
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
          runtimeBootId: this.host.runtimeBootId,
        };
        finishManagedCommand(this.host.dataDir, request.requestId, accepted);
        return accepted;
      } finally {
        release();
      }
    } catch (error) {
      const unknown = managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId);
      const result = unknown
        ? {
            accepted: false,
            completed: false,
            controlOutcome: "unknown",
            reason: "control-outcome-unconfirmed",
            sessionId: request.sessionId,
            requestId: request.requestId,
            runtimeBootId: this.host.runtimeBootId,
          }
        : {
            accepted: false,
            completed: false,
            controlOutcome: "not-dispatched",
            error: error instanceof Error ? error.message : "control-preflight-rejected",
            reason: error instanceof Error ? error.message : "control-preflight-rejected",
            sessionId: request.sessionId,
            requestId: request.requestId,
            runtimeBootId: this.host.runtimeBootId,
          };
      if (!unknown && dispatched === false) {
        if (
          request.operation === "send" &&
          onUnavailable &&
          (isDesktopUnavailable(result.reason) || result.reason === "Codex IPC disconnected")
        ) {
          if (!claimedHere && !prepared) {
            const prior = claimManagedCommand(
              this.host.dataDir,
              request.requestId,
              request.sessionId,
              fingerprint,
              request.deviceId ?? null,
              codexCommandEvidence(request, workspaceId),
            );
            if (prior) return prior;
          }
          let queued: ReturnType<typeof onUnavailable> = undefined;
          try {
            queued = onUnavailable();
          } catch {
            // Preserve the definite transport refusal if the wait cannot be recorded.
          }
          if (queued) return queued;
        }
        try {
          finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        : managedSessionHasUnknownCommands(this.host.dataDir, source.id)
          ? "control-outcome-unconfirmed"
          : request.expectedRevision !==
              (this.#desktopFollower.attached(source)?.bridge.selectedState?.revision ??
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
        runtimeBootId: this.host.runtimeBootId,
      };
    return this.#managedFork(request, source, undefined, fingerprint);
  }

  async #managedFork(
    request: z.infer<typeof managedControlSchema>,
    source: ManagedRecord,
    sourceRunner: ManagedRunner | undefined,
    fingerprint: string,
  ) {
    if (sourceRunner) {
      const sourceSnapshot = await sourceRunner.bridge.snapshot(this.host.runtimeBootId, true);
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
        this.host.dataDir,
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
        runtimeBootId: this.host.runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
    openManagedLedger(this.host.dataDir, true)?.close();
    let release: (() => void) | undefined = acquireManagedSessionLease(this.host.dataDir, childId);
    const claimed = claimManagedCommand(
      this.host.dataDir,
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
    saveManagedRecord(this.host.dataDir, child as unknown as Record<string, unknown>);
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
            const current = sourceRunner.state.snapshot(this.host.runtimeBootId, true);
            assertActivityAllows(current, "fork");
            if (current.status !== "idle" || current.reason) throw new Error("session-busy");
          } else if (managedSessionHasUnknownCommands(this.host.dataDir, source.id))
            throw new Error("control-outcome-unconfirmed");
          dispatchManagedCommand(this.host.dataDir, request.requestId);
          dispatched = true;
        },
        { nativeId, lastTurnId: last.id },
        { onFailure: finalizeFailure },
      );
      release = undefined;
      this.#managedRunners.set(childId, runner);
      const live = await runner.bridge.snapshot(this.host.runtimeBootId, true);
      const result = {
        accepted: true,
        completed: true,
        sessionId: childId,
        sourceSessionId: source.id,
        requestId: request.requestId,
        runtimeBootId: this.host.runtimeBootId,
        live,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
        runtimeBootId: this.host.runtimeBootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.host.dataDir, request.requestId, result);
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
    const current = readManagedRecords(this.host.dataDir, this.host.store).find(
      (item) => item.id === id,
    );
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
    saveManagedRecord(this.host.dataDir, current as unknown as Record<string, unknown>);
  }

  async #attachManagedRunner(
    record: ManagedRecord,
    workspace: string,
    home: string,
    release: (() => void) | undefined,
    dispatch?: () => void,
    fork?: { nativeId: string; lastTurnId: string },
    {
      onFailure,
      restrictNativePolicy = false,
      inheritNativePolicy = false,
      allowReselectedPolicy = false,
      validateModelChoice = false,
      quitResume,
      leadAdoption,
    }: {
      onFailure?: (error: unknown, ownsLease: boolean) => void;
      restrictNativePolicy?: boolean;
      inheritNativePolicy?: boolean;
      allowReselectedPolicy?: boolean;
      validateModelChoice?: boolean;
      quitResume?: CodexQuitEvidence;
      leadAdoption?: CodexLeadAdoption;
    } = {},
  ): Promise<ManagedRunner> {
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    const cwd = this.#managedCwd(record);
    const nativePolicy = this.#nativeCodexPolicy(record, inheritNativePolicy);
    const selectedForRecovery =
      allowReselectedPolicy &&
      !inheritNativePolicy &&
      canReselectNativePolicy(nativePolicy) &&
      reselectedCodexPolicy(record);
    if (nativePolicy?.policyId === null && !selectedForRecovery)
      throw new Error(nativePolicy.reason);
    if (restrictNativePolicy)
      requireFullAccessForNativePolicy(
        selectedForRecovery ||
          nativePolicy?.policyId ||
          (record.adopted ? record.policy_id : undefined),
      );
    if (nativePolicy?.policyId && (inheritNativePolicy || !codexPolicyOverride(record))) {
      record = { ...record, policy_id: nativePolicy.policyId, policy_override: false };
    }
    // Resume the verified native policy. An explicit AgentKib selection applies at turn/start.
    const resumePolicy = selectedForRecovery
      ? { ...record, policy_id: "workspace-write-on-request" }
      : nativePolicy?.policyId
        ? { ...record, policy_id: nativePolicy.policyId }
        : record;
    // Startup can outlive the last subscriber; retain the observation before any await.
    const observedAtStart =
      this.host.controlSessions.get(record.id)?.observed === true ||
      this.host.isSessionObserved?.(record.id) === true;
    const checked = await this.#preflight.check();
    const executable = checked.executable;
    if (!executable || checked.reason) throw new Error(checked.reason ?? "codex-cli-unavailable");
    this.host.assertOpen();
    const nativeId = record.native_id ?? null;
    const state = new ManagedCodexState(record, record.snapshot?.revision ?? 0);
    state.showUsageLimit(this.#usageLimits.view(record.id));
    let previousStreamText = "";
    let startingRunner: ManagedRunner | undefined;
    let verifiedLeadAdoption = false;
    const writeSnapshot = createManagedSnapshotWriter(this.host.dataDir, record);
    const persist: ManagedRunner["persist"] = (current, event, receipt) => {
      if (leadAdoption && !verifiedLeadAdoption) return;
      const active = startingRunner;
      const confirmed = active?.confirmedTurnPolicy;
      const managed = state.record as ManagedRecord;
      const previous = managed.snapshot?.confirmedTurnPolicy;
      if (
        isObject(previous) &&
        managed.snapshot &&
        ((state.lastTurnId && previous.turnId !== state.lastTurnId) ||
          (isObject(managed.native_settings) &&
            isCodexPolicyId(previous.policyId) &&
            !matchesConfirmedTurnPolicy(managed, previous.policyId)))
      )
        delete managed.snapshot.confirmedTurnPolicy;
      let stamped = false;
      if (
        confirmed &&
        active.session.connected &&
        state.status === "idle" &&
        state.lastTurnId === confirmed.turnId &&
        matchesConfirmedTurnPolicy(managed, confirmed.policyId)
      ) {
        const version = this.#codexRolloutVersion(managed);
        if (version) {
          managed.snapshot = {
            ...managed.snapshot,
            confirmedTurnPolicy: { version, ...confirmed },
          };
          stamped = true;
        }
      }
      writeSnapshot(current, event, receipt);
      if (active && stamped) active.confirmedTurnPolicy = undefined;
    };
    const captureRunner = (session: CodexAppServerSession) => {
      if (startingRunner) return;
      // A Project Agent's turns without the person count toward its limit, and one that leads
      // only later is followed from now on.
      const ownTurns = new CodexLeadTurns(this.host.dataDir, record.id, () => state.nativeId);
      session.on("notification", (value: unknown) => {
        if (isObject(value) && value.method === "account/updated")
          this.#usageLimits.observeAccount(true);
        if (leadAdoption && !verifiedLeadAdoption) return;
        // The temporary thread that names this one runs no turn of the session's.
        if (this.#titleThreads.owns(value)) return;
        const turnId = ownTurns.observe(value);
        if (turnId) this.host.observeLane((observer) => observer.ownTurn?.(record.id, turnId));
        // A user message in the session's thread: one without a name gets a title once.
        const message = codexUserMessageText(value, state.nativeId);
        if (message !== null)
          this.#titleThreads.nameIfUntitled(
            session,
            state.nativeId!,
            cwd,
            message,
            () => this.host.isShuttingDown(),
            () => this.host.catalogChanged?.(),
          );
      });
      const bridge = new ManagedCodexEventBridge(
        session,
        state,
        persist,
        (value, result, current) => {
          if (leadAdoption && !verifiedLeadAdoption) return;
          const live = current.snapshot(this.host.runtimeBootId, session.connected);
          const envelope = isObject(value) ? value : {};
          const method = typeof envelope.method === "string" ? envelope.method : "";
          const params = isObject(envelope.params) ? envelope.params : {};
          if (
            method === "turn/completed" &&
            isObject(params.turn) &&
            typeof params.turn.id === "string" &&
            record.native_id &&
            !(
              params.turn.status === "interrupted" &&
              this.#quitInterruptions.get(record.id) === params.turn.id
            )
          ) {
            const turn = params.turn;
            const outcome = codexTurnMeta(turn)?.outcome;
            new ReadStateLedger(this.host.dataDir).record(
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
            this.host.catalogChanged?.();
          }
          if (method === "turn/completed" && isObject(params.turn))
            this.#usageLimits.onTurnCompleted(record.id, session, current.limitedTurn, params.turn);
          // Also for a session created by this runner, whose native ID the record does not hold
          // yet: a lead hears of its new worker's first turn too.
          if (
            method === "turn/completed" &&
            isObject(params.turn) &&
            typeof params.turn.id === "string" &&
            !(
              params.turn.status === "interrupted" &&
              this.#quitInterruptions.get(record.id) === params.turn.id
            )
          ) {
            const turn = params.turn;
            const outcome = codexTurnMeta(turn)?.outcome;
            // Paginated resume reads public history from the rollout, which may not have
            // this item yet. The bridge already persisted the completed reply before this callback.
            this.host.observeLane((observer) => {
              const ended = [
                record.id,
                String(turn.id),
                outcome === "aborted" ? "cancelled" : (outcome ?? "ended"),
                codexTurnMeta(turn)?.duration_ms ?? null,
              ] as const;
              if (result.turnReply === undefined) observer.turnEnded(...ended);
              else observer.turnEnded(...ended, undefined, result.turnReply);
            });
          }
          if (live.status === "awaiting-approval" || live.status === "waiting-input")
            this.host.observeLane((observer) =>
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
              this.host.publishConversationEvent?.(
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
            this.host.publishConversationEvent?.(record.id, "item-upsert", result.event, live);
            // Item upserts do not update the subscriber's activity or live state.
            if (method !== "turn/completed" && !result.publishState) return;
          }
          this.host.publishConversationEvent?.(record.id, "state", live, live);
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
        { ...process.env, ...this.host.environment },
        undefined,
        captureRunner,
      );
      captureRunner(session);
      // The version check above may have tried a CLI whose `--version` it could not read;
      // the release the server reports settles it before the first turn.
      const served = codexServerVersion(session.userAgent);
      if (!served && leadAdoption) throw new Error("codex-cli-version-unavailable");
      if (served && !codexReleaseSupportsWriterLock(served))
        throw new Error("codex-cli-version-too-old");
      const runner = startingRunner!;
      const bridge = runner.bridge;
      this.host.assertOpen();
      let models: ManagedModelOption[] | undefined;
      try {
        models = projectManagedModels(await session.request("model/list", { limit: 100 }));
      } catch (error) {
        if (validateModelChoice || !session.connected) throw error;
      }
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
      // An explicit creation choice uses the catalog. A resumed, forked or recreated
      // thread retains its settings, including a previously validated pending choice.
      if (validateModelChoice) validateManagedModelSelection(record, models ?? []);
      const tier = record.service_tier ?? null;

      let goal: Record<string, unknown> | null = null;
      if (nativeId) {
        const goalResult = await session.request("thread/goal/get", { threadId: nativeId });
        goal = isObject(goalResult) && isObject(goalResult.goal) ? goalResult.goal : null;
        if (goal?.status === "active") throw new Error("pause-original-goal-before-handoff");
      }

      const params = managedResumeParams(resumePolicy, cwd);
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
      } else if (nativeId) {
        params.threadId = nativeId;
        params.excludeTurns = true;
        // Hydrate the active/latest turn, including its items for errors and compaction state.
        params.initialTurnsPage = { limit: 1, sortDirection: "desc", itemsView: "full" };
        if (selectedForRecovery || leadAdoption) params.deferGoalContinuation = true;
      }
      const beforeDispatch = () => {
        this.host.assertOpen();
        leadAdoption?.beforeResume();
        if (pathIdentity(this.#managedCwd(record)) !== pathIdentity(cwd))
          throw new Error("codex-workspace-mismatch");
        if (nativePolicy || restrictNativePolicy) {
          const current = this.#nativeCodexPolicy(record, inheritNativePolicy);
          if (restrictNativePolicy) requireFullAccessForNativePolicy(current?.policyId);
          if (
            current?.policyId !== nativePolicy?.policyId ||
            (selectedForRecovery && !canReselectNativePolicy(current))
          )
            throw new Error(
              current?.policyId === null ? current.reason : unconfirmedCodexNativePolicy.reason,
            );
        }
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
      if (
        leadAdoption &&
        (typeof nativeThread.path !== "string" ||
          pathIdentity(canonicalize(nativeThread.path)) !== pathIdentity(leadAdoption.transcript))
      )
        throw new Error("unverified-session-identity");
      (state.record as ManagedRecord).native_id = attachedId;
      if (
        typeof response.cwd !== "string" ||
        pathIdentity(canonicalize(response.cwd)) !== pathIdentity(cwd) ||
        typeof nativeThread.cwd !== "string" ||
        pathIdentity(canonicalize(nativeThread.cwd)) !== pathIdentity(cwd)
      )
        throw new Error("codex-workspace-mismatch");
      verifyManagedPolicy(resumePolicy, response);
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
      if (models) {
        const defaultModel = models.find((entry) => entry.isDefault === true);
        mutableRecord.default_model = defaultModel?.id ?? null;
        mutableRecord.default_effort = defaultModel?.defaultEffort ?? null;
        mutableRecord.default_service_tier = defaultModel?.defaultServiceTier ?? null;
      }
      // Queued messages use thread/queue/*, which 0.148.0 adds after the writer-lock minimum:
      // 0.147.0 answers this read with -32600 "unknown variant" and stays connected. Only a
      // read is tried, since a write to a missing method would leave its outcome unknown.
      // It needs the loaded thread: 0.163.0 cannot list an unloaded one's queue.
      try {
        const queue = await session.request("thread/queue/list", {
          threadId: attachedId,
          limit: 1,
        });
        if (
          leadAdoption &&
          (!isObject(queue) ||
            !Array.isArray(queue.data) ||
            queue.data.length ||
            queue.nextCursor != null)
        )
          throw new Error("session-busy");
        runner.queueVerified = true;
      } catch (error) {
        if (!session.connected || leadAdoption) throw error;
        runner.queueVerified = false;
      }
      await bridge.flush();
      this.host.assertOpen();
      if (mutableRecord.snapshot) {
        delete mutableRecord.snapshot.settingsStaged;
        delete mutableRecord.snapshot.policyOnlyStaged;
      }
      const resumePage =
        nativeId && isObject(response.initialTurnsPage) ? response.initialTurnsPage.data : null;
      const paginatedResume = Array.isArray(resumePage);
      if (quitResume) {
        const latest = paginatedResume
          ? resumePage[0]
          : Array.isArray(nativeThread.turns)
            ? nativeThread.turns.at(-1)
            : undefined;
        if (
          !isObject(latest) ||
          latest.id !== quitResume.turnId ||
          latest.status !== "interrupted" ||
          state.turnsStarted !== 0 ||
          this.#quitSettings(runner, mutableRecord) !== quitResume.settings ||
          !this.#quitHistory(mutableRecord, quitResume)
        )
          throw new Error("quit-continuation-stale");
      }
      const hydrated = state.hydrate(
        paginatedResume ? { ...nativeThread, turns: resumePage } : nativeThread,
        true,
        readRevision,
      );
      runner.usesNativeHistory = paginatedResume;
      if (leadAdoption) {
        if (state.status !== "idle" || state.turnsStarted !== 0 || state.reason)
          throw new Error("session-busy");
        leadAdoption.beforePersist();
        verifiedLeadAdoption = true;
      }
      persist(state, hydrated.events);
      runner.idleSince = Date.now();
      runner.observed =
        observedAtStart ||
        this.host.controlSessions.get(record.id)?.observed === true ||
        this.host.isSessionObserved?.(record.id) === true;
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

  /** Revalidate access on every poll, but parse unchanged indexed history only once.
   * Managed sessions keep their event-ledger path, and live/control reads are never cached. */
  indexedCodexHistoryVersion(sessionId: string): Promise<string | null> {
    return this.host.runOperation(async () => {
      const generation = this.host.indexGeneration();
      let resolved: ReturnType<SessionReaders["resolve"]> | undefined;
      const resolve = () => (resolved ??= this.host.sessions.resolve(sessionId));
      const before = await this.#indexedCodexEventScope(sessionId, resolve);
      if (!before) return null;
      const source = await resolve();
      if (source.summary.agent !== "codex" || !source.transcript) return null;
      const info = lstatSync(source.transcript, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("session-unavailable");
      const after = await this.#indexedCodexEventScope(sessionId, resolve);
      if (before !== after || generation !== this.host.indexGeneration())
        throw new Error("session-unavailable");
      return JSON.stringify([
        String(generation),
        before,
        this.host.sessions.codexHome(),
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

  /** Serve an indexed page without assembling the directory. */
  async indexedCodexEvents(request: CodexEventRead) {
    const generation = this.host.indexGeneration();
    const before = await this.#indexedCodexEventScope(request.sessionId);
    if (!before) return { handled: false as const };
    const page = await this.host.sessions.events({
      sessionId: request.sessionId,
      cursor: request.cursor ?? null,
      limit: request.limit,
      retainCursor: request.retainCursor !== false,
    });
    const after = await this.#indexedCodexEventScope(request.sessionId);
    if (before !== after || generation !== this.host.indexGeneration())
      throw new Error("session-unavailable");
    return { handled: true as const, page };
  }

  /** Resolve only this catalog row and verify native ownership before returning its scope. */
  async indexedCodexCatalogScope(sessionId: string) {
    const generation = this.host.indexGeneration();
    const scope = this.#registeredIndexedCodexScope(sessionId, false);
    if (!scope || !(await this.#distinctIndexedCodexIdentity(sessionId, "catalog"))) return null;
    if (
      generation !== this.host.indexGeneration() ||
      JSON.stringify(scope) !== JSON.stringify(this.#registeredIndexedCodexScope(sessionId, false))
    )
      return null;
    return { id: sessionId, workspace_id: scope[0], agent: this.agent };
  }

  async #indexedCodexEventScope(
    sessionId: string,
    resolve = () => this.host.sessions.resolve(sessionId),
  ): Promise<string | null> {
    const scope = this.#registeredIndexedCodexScope(sessionId, true);
    return scope && (await this.#distinctIndexedCodexIdentity(sessionId, "events", resolve))
      ? JSON.stringify(scope)
      : null;
  }

  #registeredIndexedCodexScope(sessionId: string, requireReadable: boolean) {
    const row = this.host.store.sessions.get(sessionId);
    if (
      row?.agent !== "codex" ||
      (requireReadable && row.availability !== "readable") ||
      !this.host.indexEnabled() ||
      this.host.store.sessions.codexClassificationStale(sessionId)
    )
      return null;
    // Registration uses the exact catalog ID. workspacePath also accepts a manifest alias.
    const workspace = this.host.store.sessions.sql.one(
      "SELECT canonical_path FROM workspaces WHERE id=?",
      row.workspace_id,
    )?.canonical_path;
    return typeof workspace === "string"
      ? ([row.workspace_id, workspace, row.created_at] as const)
      : null;
  }

  async #distinctIndexedCodexIdentity(
    sessionId: string,
    purpose: "catalog" | "events",
    resolve = () => this.host.sessions.resolve(sessionId),
  ): Promise<boolean> {
    const catalog = readManagedCatalog(this.host.dataDir);
    // An incomplete ledger cannot attest that the indexed ID is safe to open directly.
    if (!catalog.complete || catalog.records.some((record) => record.id === sessionId))
      return false;
    if (catalog.records.some((record) => record.native_id)) {
      const source = await resolve();
      const ref = source.native.native_ref.toLowerCase();
      const candidates = catalog.records.filter(
        (record) => record.native_id?.toLowerCase() === ref,
      );
      if (purpose === "catalog" && candidates.length > 1) return false;
      if (candidates.length) {
        const aliases = await managedCatalogAliases(this.host.store, this.host.sessions, {
          records: candidates,
          complete: true,
        });
        if ([...aliases.values()].some((owned) => owned.has(sessionId))) return false;
      }
    }
    return true;
  }

  async live(sessionId: string, enabled: boolean) {
    const live = await this.#managedLive(sessionId, enabled);
    return this.#projectOwnerWait(
      sessionId,
      this.#usageLimits.projectLive(sessionId, live),
      enabled,
    );
  }

  async receipt(value: unknown, deviceId: string): Promise<unknown> {
    const acceptedStop = isAcceptedStopAwaitingCompletion(value);
    if (
      (!acceptedStop && !isPendingNativeReceipt(value)) ||
      (value.executionMode !== "codex-managed" && value.executionMode !== "codex-follower") ||
      !["send", "steer", "queue-start", "stop"].includes(value.operation)
    )
      return value;
    const { sessionId } = value;
    try {
      const stored = managedRecordSchema.safeParse(readManagedRecord(this.host.dataDir, sessionId));
      const source = await this.#inactiveRecord(sessionId, stored.success ? stored.data : null);
      const nativeId = source.native_id;
      const runner = this.#managedRunners.get(sessionId);
      if (
        !nativeId ||
        value.workspaceId !== source.workspace_id ||
        source.archived ||
        this.host.controlSessions.has(sessionId) ||
        this.#startingRunners.has(sessionId) ||
        // Unknown dispatch needs ownership-aware recovery when the runner lost its turn.
        // An accepted stop already identifies the dispatched turn even after it went idle.
        (runner && (runner.retiring || (!acceptedStop && !runner.state.turnId)))
      )
        return value;
      const cwd = this.#managedCwd(source);
      const native = this.host.sessions.verifiedCodexControlDirectory(nativeId);
      if (
        !native ||
        native.id !== nativeId.toLowerCase() ||
        pathIdentity(native.cwd) !== pathIdentity(cwd)
      )
        return value;
      const file = this.host.sessions.verifiedCodexReadTranscript(nativeId, source.workspace);
      if (!file?.endsWith(".jsonl")) return value;
      const turnId = typeof value.turnId === "string" ? value.turnId : undefined;
      const stop = value.operation === "stop";
      if (
        stop
          ? !turnId || !codexStopRecorded(file, turnId)
          : (value.operation === "steer" && !turnId) ||
            !codexPromptRecorded(
              file,
              nativeId,
              value.requestId,
              value.operation === "steer" ? turnId : undefined,
            )
      )
        return value;
      if (acceptedStop) return completeAcceptedStopReceipt(this.host.dataDir, deviceId, value);
      const recovered = acceptNativeControlReceipt(
        this.host.dataDir,
        deviceId,
        value,
        stop ? turnId : undefined,
      );
      if (!isPendingNativeReceipt(recovered)) {
        if (runner && !managedSessionHasUnknownCommands(this.host.dataDir, sessionId)) {
          if (runner.state.restoreReconciledTurn()) runner.persist(runner.state);
        }
        this.host.publishConversationEvent?.(sessionId, "invalidate", { domains: ["receipts"] });
      }
      return recovered;
    } catch {
      return value;
    }
  }

  /** Worker reads need output evidence and external ownership, even when no page is open. */
  workerLive(sessionId: string, controls: boolean, intent?: "send") {
    return this.host.runOperation(async () => {
      const resident = this.#managedRunners.get(sessionId);
      const live =
        !controls && resident?.session.connected && !resident.retiring
          ? await workerCompletionSnapshot(
              resident.bridge,
              this.host.runtimeBootId,
              () =>
                this.#managedRunners.get(sessionId) === resident &&
                !resident.retiring &&
                !this.host.controlSessions.has(sessionId),
              (nativeId) => this.#externalTurns.endedTurns(nativeId),
            )
          : await this.#managedLive(sessionId, controls, intent ?? "read");
      return this.#projectOwnerWait(
        sessionId,
        this.#usageLimits.projectLive(sessionId, live),
        controls,
      );
    });
  }

  /** A child run belongs to the resident native connection and owner, across parent turns. */
  subagentObservation(sessionId: string, nativeId: string) {
    const resident = this.#managedRunners.get(sessionId);
    const follower = this.#desktopFollower.get(sessionId);
    const state = resident?.state.snapshot(this.host.runtimeBootId, false);
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

  async #inactiveRecord(
    sessionId: string,
    stored = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === sessionId,
    ) ?? null,
  ): Promise<ManagedRecord> {
    if (stored) {
      if (
        pathIdentity(canonicalize(this.host.store.workspacePath(stored.workspace_id))) !==
        pathIdentity(canonicalize(stored.workspace))
      )
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(stored);
      return stored;
    }
    const { summary, nativeId, workspace } = await this.#indexedCodexSource(sessionId);
    return {
      id: sessionId,
      workspace_id: summary.workspace_id,
      workspace,
      cwd: this.host.sessions.verifiedCodexControlDirectory(nativeId)?.cwd,
      home: canonicalize(this.host.sessions.codexHome()),
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

  async #indexedCodexSource(sessionId: string) {
    const summary = this.host.store.sessions.get(sessionId);
    if (!summary || summary.agent !== "codex" || summary.sidechain)
      throw new Error("session-not-adoptable");
    const resolved = await this.host.sessions.resolve(sessionId);
    const nativeId = resolved.native.native_ref;
    if (
      resolved.summary.agent !== "codex" ||
      resolved.native.agent !== "codex" ||
      !this.host.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase())
    )
      throw new Error("unverified-session-identity");
    const workspace = canonicalize(resolved.workspace);
    if (
      pathIdentity(canonicalize(this.host.store.workspacePath(summary.workspace_id))) !==
      pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");
    const transcript = "transcript" in resolved ? resolved.transcript : undefined;
    return { summary, nativeId, workspace, transcript };
  }

  #nativeCodexPolicy(record: ManagedRecord, inherit = false): CodexNativePolicy | undefined {
    if ((!inherit && !record.adopted) || !record.native_id || !this.#isCodexHome(record.home))
      return;
    const confirmed = record.snapshot?.confirmedTurnPolicy;
    if (
      isObject(confirmed) &&
      isCodexPolicyId(confirmed.policyId) &&
      typeof confirmed.version === "string" &&
      confirmed.version === this.#codexRolloutVersion(record)
    )
      return { policyId: confirmed.policyId };
    const read = this.host.sessions.codexHistoricalSettings;
    if (!read) return;
    const history = read.call(this.host.sessions, record.native_id, record.workspace);
    return history ? history.nativePolicy : unconfirmedCodexNativePolicy;
  }

  /** Confirmations belong to one version of the native thread, including its workspace identity. */
  #codexRolloutVersion(record: ManagedRecord, transcript?: string): string | undefined {
    if (!record.native_id || !this.#isCodexHome(record.home)) return;
    try {
      transcript ??= this.host.sessions.verifiedCodexSubagentParent(
        record.id,
        record.native_id,
        record.workspace,
      ).transcript;
      const info = lstatSync(transcript, { bigint: true });
      if (!info.isFile()) return;
      return createHash("sha256")
        .update(
          [
            record.native_id,
            record.cwd,
            info.dev,
            info.ino,
            info.size,
            info.mtimeNs,
            info.ctimeNs,
          ].join("\0"),
        )
        .digest("hex");
    } catch {
      return;
    }
  }

  /**
   * The turns that the Codex app or CLI runs now, by catalog session. Display only: controls
   * still follow the session's continuation.
   */
  async externalTurnsBySession(
    managed: ReturnType<typeof readManagedCatalog>["records"],
    aliasesByOwner: Map<string, Set<string>>,
    indexed: boolean,
  ): Promise<Map<string, ExternalTurn>> {
    const bySession = new Map<string, ExternalTurn>();
    const turns = await this.#externalTurns.observe();
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
      typeof this.host.store.sessions.sql.one(
        "SELECT value FROM schema_meta WHERE key='conversation_salt'",
      )?.value === "string"
    ) {
      const owners = new Map(
        [...aliasesByOwner].flatMap(([owner, aliases]) =>
          [...aliases].map((alias) => [alias, owner] as const),
        ),
      );
      for (const [thread, turn] of turns) {
        const id = this.host.store.sessions.id("codex", thread);
        bySession.set(owners.get(id) ?? id, turn);
      }
    }
    return bySession;
  }

  #isCodexHome(home: string): boolean {
    try {
      return (
        pathIdentity(canonicalize(home)) ===
        pathIdentity(canonicalize(this.host.sessions.codexHome()))
      );
    } catch {
      return false;
    }
  }

  async #inactiveLive(
    record: ManagedRecord,
    controls: boolean,
    worker?: WorkerLiveRead,
  ): Promise<Record<string, unknown>> {
    const checked = await this.#preflight.check();
    let reason = checked.reason;
    try {
      this.#managedCwd(record);
    } catch (error) {
      reason = error instanceof Error ? error.message : "codex-session-directory-unverified";
    }
    if (!reason && record.native_id) reason = this.#codexWriterOwnership(record, worker === "send");
    const retiringRunner = this.#managedRunners.get(record.id);
    const retiring = retiringRunner?.retiring === true;
    const ownershipReason = !retiring && reason === "codex-owner-busy" ? reason : null;
    if (record.archived) reason = "session-archived";
    else if (managedSessionHasUnknownCommands(this.host.dataDir, record.id))
      reason = "control-outcome-unconfirmed";
    else if (!record.native_id) reason = "native-session-unconfirmed";
    if (retiring)
      reason = retiringRunner.retirementFailed ? "control-outcome-unconfirmed" : "session-retiring";
    const starting =
      this.host.controlSessions.has(record.id) && record.snapshot?.status === "starting";
    const previousObservation = this.#catalogObservations.get(record.id);
    this.#catalogObservations.set(record.id, {
      at: Date.now(),
      status: reason && reason !== "codex-owner-busy" ? "unsupported" : "idle",
      reason,
    });
    if (previousObservation?.reason !== reason) this.host.catalogChanged?.();
    const state = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.host.runtimeBootId,
      false,
    );
    const externalId =
      ownershipReason && record.native_id && this.#isCodexHome(record.home)
        ? record.native_id
        : null;
    const policy =
      !worker && controls && !reason && !starting ? this.#nativeCodexPolicy(record) : undefined;
    const policyBlocked =
      policy?.policyId === null &&
      !(canReselectNativePolicy(policy) && reselectedCodexPolicy(record));
    const workerTurn =
      worker && externalId ? await this.#externalTurns.workerTurnOf(externalId) : null;
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
      externalTurn: worker
        ? (workerTurn?.externalTurn ?? null)
        : externalId
          ? await this.#externalTurns.turnOf(externalId)
          : null,
      ...(workerTurn
        ? { workerProgress: workerTurn.workerProgress, commands: workerTurn.commands }
        : {}),
      ...(controls &&
      reason === "codex-owner-busy" &&
      record.snapshot?.settingsStaged !== true &&
      this.#ownerLockExists(this.#writerLock(record))
        ? { ownerWaitAvailable: true }
        : {}),
      sendEnabled: controls && reason === null && !starting && !policyBlocked,
      ...(policyBlocked ? { sendDisabledReason: policy.reason } : {}),
      stopEnabled: false,
      approvals: [],
      questions: [],
      turnId: null,
      activity: null,
      reason,
    };
  }

  #writerLock(record: ManagedRecord): string {
    let transcript: string | undefined;
    try {
      transcript = this.host.sessions.verifiedCodexSubagentParent(
        record.id,
        record.native_id!,
        record.workspace,
      ).transcript;
    } catch {
      // Older or unpublished sessions can only prove the unaliased key.
    }
    return codexWriterLockPath(record.home, record.native_id!, transcript);
  }

  #acceptOwnerWait(
    record: ManagedRecord,
    request: SettingsControl,
    fingerprint: string,
    restrictNativePolicy: boolean,
    worker?: DeferredCodexSendOwner,
  ) {
    if (
      !record.native_id ||
      record.archived ||
      record.snapshot?.settingsStaged === true ||
      (!worker && !isLocalCodexSender(request.deviceId) && request.allowOwnerWait !== true) ||
      (worker &&
        (worker.workspaceId !== record.workspace_id ||
          this.host.checkDeferredCodexSend?.(worker) !== "ready"))
    )
      return;
    const home = this.#assertManagedHome(record);
    const lock = this.#writerLock(record);
    // An authoritative busy response may outlive the lock it saw. A known lock path is
    // required for a wait; leave other definite refusals as normal receipts.
    if (!this.#ownerLockExists(lock) || request.historyReferences?.length) return;
    followerInput(request.input, request.text, request.resourceRefs);
    return this.#ownerWait.accept(
      {
        request,
        nativeId: record.native_id,
        workspaceId: record.workspace_id,
        home,
        lock,
        acceptedAt: Date.now(),
        restrictNativePolicy,
        worker,
      },
      fingerprint,
      codexCommandEvidence(request, record.workspace_id),
    );
  }

  #ownerLockExists(lock: string): boolean {
    try {
      return lstatSync(lock).isFile();
    } catch {
      return false;
    }
  }

  #ownerWaitAvailable(live: Record<string, unknown>, controls: boolean): boolean {
    return (
      controls &&
      live.ownerWaitAvailable === true &&
      (live.reason === "codex-owner-busy" || isDesktopUnavailable(live.reason))
    );
  }

  #projectOwnerWait(sessionId: string, live: Record<string, unknown>, controls: boolean) {
    const entry = this.#ownerWait.read(sessionId);
    if (entry) {
      const paused = this.#ownerWait.paused(entry);
      const canResume =
        controls &&
        paused &&
        !entry.delivering &&
        (live.reason === null || this.#ownerWaitAvailable(live, controls));
      return {
        ...live,
        sendEnabled: canResume,
        ownerWaitAvailable: canResume,
        ownerWait: {
          requestId: entry.request.requestId,
          status: paused ? "paused" : "waiting-for-owner",
          source: entry.worker ? "worker" : "user",
          ...(!entry.worker &&
            entry.delivering &&
            entry.bootId !== this.host.runtimeBootId && {
              dismissible: true,
            }),
          ...(entry.worker && { laneId: entry.worker.laneId }),
        },
      };
    }
    if (this.#ownerWaitAvailable(live, controls))
      return {
        ...live,
        ownerWaitAvailable: true,
        // A follower may hold a different revision than the inactive session. The current
        // send path will either verify that follower or verify the inactive record.
        sendEnabled: true,
      };
    return live;
  }

  async #deliverOwnerWait(entry: OwnerWaitEntry, dispatch: () => void) {
    const refused = (reason: string) => ({ status: "refused" as const, reason });
    try {
      const record = await this.#inactiveRecord(entry.request.sessionId);
      if (
        record.archived ||
        record.native_id !== entry.nativeId ||
        record.workspace_id !== entry.workspaceId ||
        pathIdentity(this.#assertManagedHome(record)) !== pathIdentity(entry.home) ||
        pathIdentity(this.#writerLock(record)) !== pathIdentity(entry.lock)
      )
        return refused("session-unavailable");
      if (this.#managedRunners.get(record.id)?.session.connected)
        return { status: "retry" as const };

      let transcript: string | undefined;
      try {
        transcript = this.host.sessions.verifiedCodexSubagentParent(
          record.id,
          entry.nativeId,
          record.workspace,
        ).transcript;
      } catch {
        // Observation must not grant or block a send.
      }
      const interveningExternalTurns =
        !!entry.worker &&
        (await this.#externalTurns.endedTurns(entry.nativeId, Date.now(), transcript)).some(
          (turn) => Date.parse(turn.startedAt ?? turn.endedAt ?? "") >= entry.acceptedAt,
        );
      const result = await this.host.admitControl(
        {
          ...entry.request,
          requestId: randomUUID(),
          runtimeBootId: this.host.runtimeBootId,
          expectedRevision: record.snapshot?.revision ?? 0,
        },
        (request, fingerprint) =>
          this.#codexControl(request, fingerprint, {
            restrictNativePolicy: entry.restrictNativePolicy,
            ownerWaitDispatch: dispatch,
          }),
      );
      if (isObject(result) && result.accepted === true)
        return { status: "sent" as const, interveningExternalTurns };
      const reason =
        isObject(result) && typeof result.reason === "string"
          ? result.reason
          : "control-outcome-unconfirmed";
      if (reason === OWNER_WAIT_PAUSED || reason === "schedule-permit-unavailable")
        return { status: "paused" as const };
      if (
        reason === "codex-owner-busy" &&
        isObject(result) &&
        result.controlOutcome === "not-dispatched"
      )
        return { status: "retry" as const };
      return refused(reason);
    } catch (error) {
      return refused(error instanceof Error ? error.message : "control-outcome-unconfirmed");
    }
  }

  #codexWriterOwnership(record: ManagedRecord, force = false): string | null {
    if (!record.native_id) return "native-session-unconfirmed";
    const current = this.#ownership.get(record.id);
    if (!force && current && Date.now() - current.checkedAt < 4000) return current.reason;
    const reason = this.#probeCodexWriter(record);
    this.#ownership.set(record.id, { checkedAt: Date.now(), reason });
    if (reason === null) this.#desktopFollower.disconnect(record.id);
    return reason;
  }

  #probeCodexWriter(record: ManagedRecord): string | null {
    try {
      return existingFileLeaseBusy(this.#writerLock(record)) ? "codex-owner-busy" : null;
    } catch {
      return "codex-owner-check-unavailable";
    }
  }

  async #retireIdleRunners(): Promise<void> {
    if (this.host.isClosing() || this.#retiring) return;
    this.#usageLimits.observeAccount();
    this.#retiring = true;
    try {
      for (const [id, runner] of this.#managedRunners) {
        if (runner.retiring || this.#quitInterruptions.has(id) || this.host.controlSessions.has(id))
          continue;
        if (runner.restartWhenIdle && runner.written !== false) {
          const now = runner.state.snapshot(this.host.runtimeBootId, false);
          if (now.status === "idle" && !now.activity) {
            await this.#closeManagedRunner(id, runner).catch(() => undefined);
            continue;
          }
        }
        const observed = this.host.isSessionObserved?.(id) === true;
        const left = runner.observed && !observed;
        runner.observed ||= observed;
        const live = runner.state.snapshot(this.host.runtimeBootId, false);
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
            if (this.host.isClosing()) return;
            const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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
              saveManagedRecord(this.host.dataDir, latest);
            }
          });
        } catch {
          // The closing runner stays fenced until its real process-close event.
        }
      }
      this.#desktopFollower.retireIdle();
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
        if (runner.written === false && runner.state.turnsStarted === 0 && runner.state.nativeId) {
          const record = readManagedRecord(this.host.dataDir, id);
          if (
            record?.adopted === false &&
            record.archived !== true &&
            !record.source_session_id &&
            record.workspace_id === runner.state.record.workspace_id &&
            record.home === runner.state.record.home &&
            record.native_id === runner.state.nativeId &&
            isObject(record.snapshot) &&
            record.snapshot.revision === runner.state.revision &&
            !managedSessionHasUnknownCommands(this.host.dataDir, id)
          ) {
            // thread/start allocated an ID, but Codex creates its durable state at
            // the first turn. Record this before giving up the native process.
            record.snapshot = { ...record.snapshot, unwrittenNativeThread: true };
            saveManagedRecord(this.host.dataDir, record);
          }
        }
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
    if (this.host.controlSessions.has(record.id)) return undefined;
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
    const pending = readUnknownManagedCommands(this.host.dataDir, record.id).find(
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
      this.host.controlSessions.has(record.id) ||
      this.#codexWriterOwnership(record, true) !== "codex-owner-busy"
    )
      return;
    const expected = parseFollowerModelSettings(acknowledged);
    if (!expected) return;
    const follower = await this.#desktopFollower.connect(record);
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
        this.host.controlSessions.has(record.id) ||
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
      finishManagedCommand(this.host.dataDir, pending.requestId, {
        accepted: true,
        completed: true,
        reconciled: true,
        appliesTo: "next-turn",
        requestId: pending.requestId,
        runtimeBootId: evidence.runtimeBootId ?? this.host.runtimeBootId,
        sessionId: record.id,
      });
      this.host.publishConversationEvent?.(record.id, "invalidate", {
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
      readUnknownManagedCommands(this.host.dataDir, record.id).filter(
        ({ evidence }) =>
          evidence?.operation === "send" &&
          evidence.workspaceId === record.workspace_id &&
          (evidence.executionMode === "codex-follower" ||
            (!record.released && evidence.executionMode === "codex-managed")),
      );
    if (pendingSends().length === 0) return;

    const release = runner ? undefined : acquireManagedSessionLease(this.host.dataDir, record.id);
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
      this.host.assertOpen();
      if (
        latest.archived ||
        latest.released !== record.released ||
        latest.native_id !== nativeId ||
        latest.workspace_id !== record.workspace_id ||
        pathIdentity(this.#managedCwd(latest)) !== pathIdentity(cwd) ||
        pathIdentity(this.#assertManagedHome(latest)) !== pathIdentity(home) ||
        this.host.controlSessions.has(record.id) ||
        this.#managedRunners.get(record.id) !== runner ||
        (runner && (!runner.session.connected || runner.retiring))
      )
        return;
      const resolved = pendingSends().filter(({ requestId, evidence }) =>
        managedCommandReconciles(requestId, evidence, thread),
      );
      if (resolved.length === 0) return;
      for (const { requestId, evidence } of resolved)
        finishManagedCommand(this.host.dataDir, requestId, {
          accepted: true,
          completed: false,
          reconciled: true,
          requestId,
          runtimeBootId: evidence?.runtimeBootId ?? this.host.runtimeBootId,
          sessionId: record.id,
        });

      const unknown = managedSessionHasUnknownCommands(this.host.dataDir, record.id);
      if (runner && !unknown) {
        if (runner.state.turnId === null) {
          const hydrated = runner.state.hydrate(thread, true, readRevision);
          runner.state.restoreReconciledTurn();
          runner.persist(runner.state, hydrated.events);
        } else if (runner.state.restoreReconciledTurn()) runner.persist(runner.state);
      }
      const live = runner
        ? runner.state.snapshot(this.host.runtimeBootId, !unknown)
        : await this.#inactiveLive(latest, true);
      this.host.publishConversationEvent?.(record.id, "state", live, live);
      this.host.publishConversationEvent?.(record.id, "invalidate", { domains: ["receipts"] });
      return live;
    } finally {
      release?.();
    }
  }

  async #checkLegacyAdopt(record: ManagedRecord) {
    const nativeId = record.native_id;
    if (!record.adopted || record.archived || record.released || !nativeId) return;
    const pendingAdopt = () => {
      const commands = readUnknownManagedCommands(this.host.dataDir, record.id);
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

    const release = acquireManagedSessionLease(this.host.dataDir, record.id);
    try {
      const cwd = this.#managedCwd(record);
      const home = this.#assertManagedHome(record);
      const lock = path.join(home, "thread-writer-locks", `${nativeId}.lock`);
      if (existingFileLeaseBusy(lock)) return;
      const { executable, reason } = await this.#preflight.check();
      if (!executable || reason) return;
      this.host.assertOpen();
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

      this.host.assertOpen();
      const stored = managedRecordSchema.safeParse(readManagedRecord(this.host.dataDir, record.id));
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
      finishManagedCommand(this.host.dataDir, requestId, {
        accepted: true,
        completed: false,
        reconciled: true,
        requestId,
        runtimeBootId: this.host.runtimeBootId,
        sessionId: record.id,
      });
      this.#ownership.delete(record.id);
      const live = await this.#inactiveLive(latest, true);
      this.host.publishConversationEvent?.(record.id, "state", live, live);
      this.host.publishConversationEvent?.(record.id, "invalidate", {
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
    worker?: WorkerLiveRead,
  ): Promise<Record<string, unknown>> {
    // The unattended Worker read only looks up its own row. Ordinary live reads keep their
    // catalog recovery path.
    const row = worker ? readManagedRecord(this.host.dataDir, sessionId) : null;
    const managed = worker
      ? row && managedRecordSchema.parse(row)
      : readManagedRecords(this.host.dataDir, this.host.store).find(
          (record) => record.id === sessionId,
        );
    if (!managed) {
      try {
        const record = await this.#inactiveRecord(sessionId, worker ? null : undefined);
        let inactive = await this.#inactiveLive(record, experimentalEnabled, worker);
        if (experimentalEnabled && inactive.reason === "control-outcome-unconfirmed")
          inactive = (await this.#recoverCodexReceipts(record)) ?? inactive;
        return (
          (await this.#desktopFollower.live(record, inactive, experimentalEnabled, worker)) ??
          (await this.#desktopFollower.handoffLive(
            record,
            inactive,
            experimentalEnabled && worker !== "send",
          )) ??
          inactive
        );
      } catch (error) {
        // Root/home sessions can live in an unregistered native collection.
        // Explain the proven directory failure without granting collection controls.
        const summary = this.host.store.sessions.get(sessionId);
        if (summary?.agent === "codex" && !summary.sidechain) {
          const source = await this.host.sessions.resolve(sessionId);
          const nativeId = source.native.native_ref;
          const identity = this.host.sessions.verifiedCodexControlDirectory(nativeId);
          if (
            source.native.agent === "codex" &&
            this.host.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()) &&
            identity?.id === nativeId.toLowerCase()
          ) {
            let reason: string | undefined;
            try {
              this.#checkedCodexDirectory(identity.cwd);
            } catch (directoryError) {
              if (directoryError instanceof Error) reason = directoryError.message;
            }
            if (reason && !managedSessionHasUnknownCommands(this.host.dataDir, sessionId)) {
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
                }).snapshot(this.host.runtimeBootId, false),
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
    const liveWorkspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
    if (pathIdentity(liveWorkspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(managed);

    const resident = this.#managedRunners.get(sessionId);
    if (this.host.isSessionObserved?.(sessionId) === true) this.observeSession(sessionId);
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
      const unknown = managedSessionHasUnknownCommands(this.host.dataDir, sessionId);
      if (experimentalEnabled && unknown) {
        const recovered = await this.#recoverCodexReceipts(managed, resident);
        if (recovered) return recovered;
      }
      const snapshot = await resident.bridge.snapshot(this.host.runtimeBootId, !unknown);
      return worker && snapshot.turnId === resident.state.turnId
        ? { ...snapshot, ...resident.state.workerObservation() }
        : snapshot;
    }
    if (resident) {
      await this.#closeManagedRunner(sessionId, resident);
    }

    let inactive = await this.#inactiveLive(managed, experimentalEnabled, worker);
    if (experimentalEnabled && inactive.reason === "control-outcome-unconfirmed")
      inactive = (await this.#recoverCodexReceipts(managed)) ?? inactive;
    return (
      (await this.#desktopFollower.live(managed, inactive, experimentalEnabled, worker)) ??
      (await this.#desktopFollower.handoffLive(
        managed,
        inactive,
        experimentalEnabled && worker !== "send",
      )) ??
      inactive
    );
  }

  async resumeCommand(sessionId: string) {
    const generation = this.host.indexGeneration();
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
      const identity = this.host.sessions.verifiedCodexResumeIdentity(nativeId);
      if (!identity || identity.id !== nativeId.toLowerCase())
        throw new Error("unverified-session-identity");
      const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
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
    if (generation !== this.host.indexGeneration() || before.key !== after.key)
      throw new Error("session-unavailable");
    // This read deliberately performs no CLI/version check, native RPC, or lock probe.
    return codexResumeCommand(after.cwd, after.home, after.nativeId);
  }

  /**
   * The directory a session's relative file references were written against. It only
   * places those references: callers resolve them inside their own file grant, so this
   * read neither verifies nor starts anything. Null means the registered root.
   */
  managedSessionDirectory(sessionId: string): { cwd: string | null } | undefined {
    const managed = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === sessionId,
    );
    if (managed) {
      let cwd = managed.cwd;
      // Older ledgers kept only the root; the native rollout header has the directory.
      if (cwd === undefined && managed.native_id)
        try {
          cwd = this.host.sessions.verifiedCodexControlDirectory(managed.native_id)?.cwd;
        } catch {
          cwd = undefined;
        }
      return { cwd: cwd ?? null };
    }
  }

  async context(sessionId: string) {
    const managed = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === sessionId,
    );
    let workspaceId: string;
    let workspace: string;
    let nativeId: string | null;
    if (managed) {
      workspaceId = managed.workspace_id;
      workspace = canonicalize(this.host.store.workspacePath(workspaceId));
      nativeId = managed.native_id ?? null;
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
        throw new Error("session-workspace-mismatch");
      this.#assertManagedHome(managed);
    } else {
      const summary = this.host.store.sessions.get(sessionId);
      if (!summary) throw new Error("session-unavailable");
      if (summary.agent !== "codex") throw new Error("session-not-codex");
      const resolved = await this.host.sessions.resolve(sessionId);
      workspaceId = resolved.summary.workspace_id;
      workspace = canonicalize(resolved.workspace);
      nativeId = resolved.native.native_ref;
      if (!this.host.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
        throw new Error("unverified-session-identity");
    }
    if (!nativeId) return { available: false, reason: "native-session-unverified" };
    const executionCwd = this.#managedCwd(managed ?? (await this.#inactiveRecord(sessionId)));
    const executable = this.#codexReader();
    if (!executable) throw new Error("codex-cli-unavailable");
    let codexHome: string;
    try {
      codexHome = canonicalize(this.host.sessions.codexHome());
    } catch {
      throw new Error("codex-home-unavailable");
    }
    const response = await this.#codex.readThread(executable, executionCwd, codexHome, nativeId);
    const thread = isObject(response) ? response.thread : null;
    if (!isObject(thread) || thread.id !== nativeId) throw new Error("thread-identity-mismatch");
    if (
      pathIdentity(canonicalize(this.host.store.workspacePath(workspaceId))) !==
      pathIdentity(workspace)
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

  async resources(sessionId: string) {
    const stored = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === sessionId,
    );
    const managed = stored ?? (await this.#inactiveRecord(sessionId));
    const workspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const codexHome = this.#assertManagedHome(managed);
    const executionCwd = this.#managedCwd(managed);
    const skills = await this.#readCodexSkills(executionCwd, codexHome);
    const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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

  async workspaceResources(workspaceId: string) {
    const workspace = this.#checkedCodexDirectory(this.host.store.workspacePath(workspaceId));
    const home = canonicalize(this.host.sessions.codexHome());
    const skills = await this.#readCodexSkills(workspace, home);
    if (
      pathIdentity(this.#checkedCodexDirectory(this.host.store.workspacePath(workspaceId))) !==
        pathIdentity(workspace) ||
      pathIdentity(canonicalize(this.host.sessions.codexHome())) !== pathIdentity(home)
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

  async goal(sessionId: string) {
    const stored = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === sessionId,
    );
    const managed = stored ?? (await this.#inactiveRecord(sessionId));
    const workspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
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

    const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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
        this.host.dataDir,
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
      home = canonicalize(this.host.sessions.codexHome());
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
    const workspace = canonicalize(this.host.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    let value = record.cwd;
    if (value === undefined && record.native_id) {
      // Older ledgers stored only the registration root. Re-prove the native
      // directory instead of treating that broad root as execution authority.
      const identity = this.host.sessions.verifiedCodexControlDirectory(record.native_id);
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
    const userHomes = [
      homedir(),
      this.host.environment.HOME,
      this.host.environment.USERPROFILE,
    ].filter((home): home is string => typeof home === "string" && path.isAbsolute(home));
    if (
      pathIdentity(cwd) === pathIdentity(path.parse(cwd).root) ||
      userHomes.some((home) => pathIdentity(cwd) === pathIdentity(home))
    )
      throw new Error("codex-session-directory-unsafe");
    return cwd;
  }

  managedSubagents(
    managed: ManagedRecord,
    child: { subagentId: string; cursor?: string | null; limit: number } | null,
  ) {
    this.#assertManagedHome(managed);
    if (!managed.native_id)
      return { version: 1, sessionId: managed.id, agents: [], truncated: false };
    const parent = this.host.sessions.verifiedCodexSubagentParent(
      managed.id,
      managed.native_id,
      managed.workspace,
    );
    Object.assign(parent, this.subagentObservation(managed.id, managed.native_id));
    return this.host.sessions.subagentsForNative(
      parent,
      child?.subagentId,
      child?.cursor ?? null,
      child?.limit ?? 50,
    );
  }

  async managedImage(managed: ManagedRecord, request: { sessionId: string; imageId: string }) {
    this.#assertManagedHome(managed);
    if (!managed.native_id) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    const identity = this.host.sessions.verifiedCodexControlDirectory(managed.native_id);
    if (!identity || identity.id !== managed.native_id.toLowerCase())
      throw new Error("unverified-session-identity");
    const cwd = canonicalize(managed.cwd ?? identity.cwd);
    const workspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
    const result = await this.host.sessions.imageForNative(
      "codex",
      managed.native_id,
      workspace,
      request.imageId,
      { codexDirectory: cwd },
    );
    const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
      (record) => record.id === request.sessionId,
    );
    if (
      !latest ||
      latest.workspace_id !== managed.workspace_id ||
      latest.native_id !== managed.native_id ||
      latest.cwd !== managed.cwd
    )
      throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    this.#assertManagedHome(latest);
    return result;
  }

  async managedEvents(
    managed: ManagedRecord,
    request: {
      sessionId: string;
      cursor?: string | null;
      limit: number;
      retainCursor?: boolean;
    },
  ) {
    this.#assertManagedHome(managed);
    const runner = this.#managedRunners.get(managed.id);
    const nativeHistory =
      !!managed.native_id && (!runner?.session.connected || runner.usesNativeHistory);
    const nativePrefix = "codex-native-v1:";
    if (request.cursor && nativeHistory !== request.cursor.startsWith(nativePrefix))
      throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
    let events: {
      events: Array<Record<string, unknown>>;
      next_cursor: string | null;
      warnings: string[];
    };
    if (nativeHistory) {
      const identity = this.host.sessions.verifiedCodexControlDirectory(managed.native_id!);
      if (!identity || identity.id !== managed.native_id!.toLowerCase())
        throw new Error("unverified-session-identity");
      const cwd = canonicalize(managed.cwd ?? identity.cwd);
      const workspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
      if (!within(cwd, workspace) || pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd))
        throw new Error("session-workspace-mismatch");
      const page = await this.host.sessions.eventsForNative(
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
        this.host.dataDir,
        request.sessionId,
        request.cursor,
        request.limit,
      );
      // Codex writes a started thread only with its first message. Until then this
      // connected runner's ledger is the whole history, with no native images to add.
      if (managed.native_id && this.host.sessions.codexThreadWritten(managed.native_id)) {
        const identity = this.host.sessions.verifiedCodexControlDirectory(managed.native_id);
        if (!identity || identity.id !== managed.native_id.toLowerCase())
          throw new Error("unverified-session-identity");
        const cwd = canonicalize(managed.cwd ?? identity.cwd);
        const workspace = canonicalize(this.host.store.workspacePath(managed.workspace_id));
        if (
          !within(cwd, workspace) ||
          pathIdentity(canonicalize(identity.cwd)) !== pathIdentity(cwd)
        )
          throw new Error("session-workspace-mismatch");
        let sourceRevision: string | null = null;
        const transcript = this.host.sessions.verifiedCodexReadTranscript(
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
            this.host.sessions.eventsForNative(
              "codex",
              managed.native_id!,
              workspace,
              cursor,
              100,
              {
                codexDirectory: cwd,
                imageScanBudget,
              },
            ),
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
    const latest = readManagedRecords(this.host.dataDir, this.host.store).find(
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

  catalogRows(
    managed: ReturnType<typeof readManagedCatalog>["records"],
    aliasesByOwner: ReadonlyMap<string, ReadonlySet<string>>,
    nativeByOwner: ReadonlyMap<string, Pick<NativeSession, "title" | "updated_at">>,
  ) {
    return managed.map((record) => ({
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
    }));
  }

  catalogRuntime(sessions: readonly { id: string }[], enabled: boolean) {
    const needsRuntime =
      sessions.some((session) => {
        if (
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
          this.host.store.sessions
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
          if (this.host.isShuttingDown()) return;
          const changed = this.#catalogRuntime?.reason !== value.reason;
          this.#catalogRuntime = value;
          if (changed) this.host.catalogChanged?.();
        })
        .catch(() => undefined);
      this.#catalogRuntimeCheck = check;
      void check.finally(() => {
        if (this.#catalogRuntimeCheck === check) this.#catalogRuntimeCheck = undefined;
      });
    }
    return runtime;
  }

  catalogContinuation<T extends { id: string }>(
    session: T,
    runtime: Awaited<ReturnType<CodexRuntimePreflight["check"]>> | null,
    externalTurns: ReadonlyMap<string, ExternalTurn>,
  ) {
    const runner = this.#managedRunners.get(session.id);
    const ownership = this.#ownership.get(session.id);
    const reason = ownership && Date.now() - ownership.checkedAt < 5000 ? ownership.reason : null;
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
          reason: runner.retirementFailed ? "control-outcome-unconfirmed" : "session-retiring",
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
  }
}

function sameWaitingCodexInput(left: SettingsControl, right: SettingsControl): boolean {
  const input = (value: SettingsControl) => [value.text, value.input, value.resourceRefs];
  return stableJson(input(left)) === stableJson(input(right));
}

function isDesktopUnavailable(reason: unknown): boolean {
  return (
    typeof reason === "string" &&
    [
      "codex-desktop-owner-missing",
      "codex-desktop-owner-unavailable",
      "codex-desktop-ipc-unavailable",
      "codex-desktop-ipc-incompatible",
      "codex-desktop-thread-open-failed",
      "platform-unsupported",
    ].includes(reason)
  );
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
  delete live.turnStartError;
  const record = { ...state.record };
  delete record.snapshot;
  delete record.token_usage;
  return stableJson({ live, record, mutationRevision: state.mutationRevision });
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
    ...(request.policyId !== undefined ? { policy_override: true } : {}),
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

function boundedText(value: unknown, maxBytes: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/\p{Cc}/u.test(value)
    ? value
    : null;
}
