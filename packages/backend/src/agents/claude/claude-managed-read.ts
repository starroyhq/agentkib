import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { ClaudeStartupDiscovery } from "./claude-startup-discovery";
import { claudeResumeCommand } from "./claude-resume-command";
import { completedClaudeForkResult, readClaudeForkHistory } from "./claude-fork-history";
import { ClaudeTranscriptProofs, sameClaudeTranscript } from "./claude-transcript-proof";
import { conversationReadKey, ReadStateLedger } from "../../read-state-ledger";
import type { ReadStateTarget } from "../../conversation-read-state";
import { ClaudeSessionOwnerProbe, type ClaudeOwnerObservationShare } from "./claude-session-owner";
import { validHistoryControl } from "../../history-control-schema";
import { Commands } from "../../commands";
import type { ClaudeControlMetadataShare, SessionReaders } from "../../session-readers";
import type { BackendStore } from "../../store";
import { canonicalize, lexicalPathIdentity, pathIdentity } from "../../paths";
import { within } from "../../files";
import { restrictRemotePath } from "../../remote-tls";
import { acquirePortableFileLease } from "../../managed-session-lock";
import {
  LEAD_ALLOWED_TOOLS,
  mergeMcpConfigs,
  type LaneEndedTurn,
  type WorkerObserver,
  type WorkerRestartRequest,
  type WorkerRestartResult,
} from "../../orchestration-service";
import { userHome } from "../../mcp-config-read";
import {
  CLAUDE_BACKGROUND_TASKS_MINIMUM,
  readClaudeInstallation,
  supportsClaudeVersion,
  type ClaudeInstallation,
} from "./claude-version";
import {
  REMOTE_ERROR_CODES,
  CLAUDE_COMMAND_REFUSALS,
  CLAUDE_CREATION_PERMISSION_MODES,
  isClaudePermissionMode,
  claudeInputCommandRefusal,
  claudeModelOption,
  isClaudeCommandRefusal,
  type ClaudeCommandEntry,
  type ConversationTurnMeta,
} from "@agentkib/runtime-protocol";
import { isClaudeToolItemId, terminationCodeOf } from "./claude-frame-policy";
import {
  claudeDesktopClaims,
  claudeDesktopSessionRecords,
  removeClaudeSessionFiles,
} from "./claude-session-files";
import { ClaudeTurnMetaStore } from "./claude-turn-meta";
import {
  claudeWorkerHistoryHasOpenTurn,
  claudeWorkerHistoryTurns,
  claudeWorkerUnobservedTurns,
} from "./claude-worker-turns";
import type { ConversationEventPage } from "../../session-events";
import {
  assertClaudeConfigWritable,
  isClaudeConfigDirSet,
  resolveClaudeConfig,
} from "./claude-config";
import {
  ClaudeHostStateStore,
  claudeSessionTitle,
  validClaudeDeviceId,
  claudeCommandFingerprintInput,
  canSteerClaudeQueueItem,
  type ClaudeHostWork,
  type ClaudeLocalTitleScope,
  type ClaudeSettings,
} from "./claude-host-state";
import {
  AUTO_CONTINUE_TEXT,
  armUsageLimit,
  usageLimitArmable,
  usageLimitAutoContinue,
  usageLimitContinue,
  usageLimitView,
} from "../../usage-limit";
import { createClaudeGoalReportEndpoint } from "./claude-goal-report";
import { projectContextUsage } from "../../context-usage";
import { prepareClaudeActivities } from "../../session-activities";
import {
  readClaudeTranscriptModel,
  readClaudeTranscriptObservation,
  type ClaudeTranscriptObservation,
} from "./claude-context-usage";
import {
  projectSubagentObservations,
  type SubagentObservation,
  type SubagentParent,
} from "../../session-subagents";
import {
  ClaudeManagedRunnerProcess,
  ClaudeUndispatchedError,
  type ClaudeObservedPermissionMode,
  type ClaudeRunnerOptionsSnapshot,
  type ClaudeRunnerSnapshot,
  type ClaudeStartupCleanupProof,
  validateClaudeContent,
} from "./claude-managed-runner";
import {
  beginManagedLedgerWrite,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  readUnknownManagedCommands,
  openManagedLedger,
} from "../../managed-ledger";
import { admitControlReceipt, bindControlReceipt } from "../../sessions/control-receipts";
import { acceptNativeControlReceipt, isPendingNativeReceipt } from "../../control-receipt";
import { claudePromptRecorded } from "../../native-control-evidence";
import { LeadReportNotDispatched } from "../../message-lead-reports";
import type {
  ClaudeBridge,
  ClaudeTerminalExitSource,
  ClaudeTerminalHandoverSource,
} from "./claude-bridge";

// Defined in claude-version.ts (imported above for this file's own checks); still exported from here.
export { supportsClaudeVersion } from "./claude-version";

/**
 * Devices that act for the person at this computer, as the terminal does: the desktop app,
 * through its own Web view or the local bridge. Paired browsers are remote devices.
 */
const CLAUDE_OWNER_DEVICES: ReadonlySet<string> = new Set([
  "desktop-local",
  "agentkib-local-owner",
]);

/** Throws why AgentKib does not send this input for the device (see claude-commands). */
function assertClaudeCommandAllowed(
  input: unknown,
  deviceId: string,
  commands: readonly ClaudeCommandEntry[],
): void {
  const refusal = claudeInputCommandRefusal(input, {
    owner: CLAUDE_OWNER_DEVICES.has(deviceId),
    commands,
  });
  if (refusal) throw new Error(refusal);
}

/** What every goal step sends: the objective, then how to report the step. */
function goalStepInput(objective: string, stepId: string): string {
  return `${objective}\n\nContinue the authorized goal. Before finishing this step, call the AgentKib report_goal_step MCP tool for step ${stepId}. Report continue, complete, or blocked with evidence and remaining work. A normal text reply does not complete the goal.`;
}

/** The requested mutation is durably rejected before any external effect. */
export class ClaudeHostControlPreflightError extends Error {
  constructor(
    message: string,
    readonly result: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClaudeHostControlPreflightError";
  }
}
/** Settings rejections clients explain: the receipt names them instead of a generic reason. */
const EXPLAINED_SETTINGS_REASONS = new Set(["unsupported-model", "unsupported-effort"]);
const FILE_LIMIT = 2 * 1024 * 1024;
const TERMINAL_CONTINUE_TEXT =
  "Continue the unfinished turn from this same session. If you were waiting for an answer or approval, ask for it again without assuming any decision.";
type TerminalHandoverBridge = Pick<
  ClaudeBridge,
  | "terminalHandoverSource"
  | "remoteTerminalExitSource"
  | "requestTerminalExit"
  | "confirmRemoteTerminalExit"
  | "finishTerminalHandover"
>;
type StagedTerminalAdoption = {
  bridge: NonNullable<ClaudeContinuationOptions["terminalHandover"]>;
  bindingId: string;
};
type ClaudeRecord = {
  version: 1;
  id: string;
  workspaceId: string;
  workspace: string;
  registeredWorkspace: string | null;
  home: string;
  nativeId: string;
  title: string;
  createdAt: string;
  adopted: boolean;
  terminalHandover?: true;
  terminalHandoverLeaseId?: string;
  terminalAutoAdoptedAt?: string;
  released: boolean;
  fresh: boolean;
  fingerprint: string | null;
  snapshot: Record<string, unknown>;
  completedRequests: string[];
  forkSourceNativeId?: string;
  forkCutoff?: string;
  nativeTitle?: string;
};
const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sessionIdPattern = /^[A-Za-z0-9-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type QuitEvidence = {
  turnId: string;
  nativeId: string;
  workspaceId: string;
  createdAt: string;
  fingerprint: string;
  settingsKey: string;
  resumeQueue: boolean;
  launch: ClaudeSettings & {
    model: string;
    permissionMode: NonNullable<ClaudeSettings["permissionMode"]>;
  };
};

function quitEvidence(value: Record<string, unknown>): QuitEvidence | undefined {
  const {
    turnId,
    nativeId,
    workspaceId,
    createdAt,
    fingerprint,
    settingsKey,
    resumeQueue,
    launch,
  } = value;
  if (
    typeof turnId !== "string" ||
    !uuidPattern.test(turnId) ||
    typeof nativeId !== "string" ||
    !uuidPattern.test(nativeId) ||
    typeof workspaceId !== "string" ||
    typeof createdAt !== "string" ||
    typeof fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(fingerprint) ||
    typeof settingsKey !== "string" ||
    typeof resumeQueue !== "boolean" ||
    !isObject(launch) ||
    typeof launch.model !== "string" ||
    !launch.model ||
    Buffer.byteLength(launch.model) > 256 ||
    !isClaudePermissionMode(launch.permissionMode) ||
    (launch.effort !== undefined &&
      !["low", "medium", "high", "xhigh", "max"].includes(launch.effort))
  )
    return;
  return {
    turnId,
    nativeId,
    workspaceId,
    createdAt,
    fingerprint,
    settingsKey,
    resumeQueue,
    launch: {
      model: launch.model,
      permissionMode: launch.permissionMode,
      ...(launch.effort ? { effort: launch.effort } : {}),
    },
  };
}
/** A stored snapshot of a turn the CLI started by itself that had not ended when it was stored. */
const interruptedSelfTurn = (snapshot: Record<string, unknown>): boolean =>
  snapshot.turnOrigin === "self" &&
  ["running", "waiting-approval", "waiting-input"].includes(String(snapshot.status));
/**
 * What clients see of the worker's background tasks: what runs and since when. The CLI's task and
 * tool ids stay in the host, as with sub-agents.
 */
const publicBackgroundTasks = (tasks: unknown): Record<string, unknown>[] =>
  Array.isArray(tasks)
    ? tasks.filter(isObject).map((task) => ({
        kind: task.kind === "agent" ? "agent" : "command",
        description: typeof task.description === "string" ? task.description : null,
        startedAt: typeof task.startedAt === "string" ? task.startedAt : null,
      }))
    : [];
const startupFailureCodes = new Set([
  "initialize-timeout",
  "initialize-write-failed",
  "process-start-failed",
  "process-exited",
  "stream-closed",
]);
const supportedStartupCleanupKind = (kind: unknown) =>
  kind === "not-started" || (kind === "mac-owned-process-tree" && process.platform === "darwin");

const supportsClaudeManagedRunner = () =>
  process.platform === "darwin" || process.platform === "linux";
type ClaudeConversationPublisher = (
  sessionId: string,
  type: "state" | "text-delta" | "item-upsert" | "snapshot" | "invalidate",
  payload: Record<string, unknown>,
  live?: Record<string, unknown>,
) => void;
type ClaudeConversationAliaser = (
  sessionId: string,
  previousId: string,
  itemId: string,
  live: Record<string, unknown>,
) => void;
/** Display-only: which permission mode a managed session runs in (see `Live.permission`). */
type ClaudePermissionView = {
  mode: ClaudeObservedPermissionMode | null;
  previous?: true;
  possiblyAuto?: true;
};

/** What tells two sets of lead tools apart; undefined for none. */
const toolKey = (tools: Record<string, unknown> | null | undefined): string | undefined =>
  tools ? JSON.stringify(tools) : undefined;

export type ClaudeContinuationOptions = {
  idleTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  /** Ownership checks still need to run after the backend's ordinary commands are stopped. */
  quitCommands?: () => Commands;
  /** Whether the person lets managed sessions do background work; read when a worker starts. */
  backgroundTasks?: () => boolean;
  /**
   * The `--mcp-config` content of a lead's delegation tools (see `orchestration-service.ts`),
   * or null when the session directs no lanes. Read when a worker starts.
   */
  leadTools?: (sessionId: string) => Promise<Record<string, unknown> | null>;
  /** The person sent a message to this session themselves, not a queued or automatic one. */
  userSent?: (sessionId: string) => void;
  /** The CLI started a turn by itself; false stops it (a Project Agent past its turn limit). */
  selfTurn?: (sessionId: string) => boolean;
  isSessionObserved?: (sessionId: string) => boolean;
  isSessionBridged?: (sessionId: string) => boolean;
  terminalHandover?: {
    source: TerminalHandoverBridge["terminalHandoverSource"];
    finish: TerminalHandoverBridge["finishTerminalHandover"];
    reportOwner: (sessionId: string) => string | undefined;
  };
  retainedTerminalUsage?: (
    sessionId: string,
    source: { nativeId: string; workspace: string; workspaceId: string },
    observation: ClaudeTranscriptObservation,
    readEarlier?: () => ClaudeTranscriptObservation,
  ) => ClaudeTranscriptObservation["usage"] | undefined;
  isCatalogObserved?: () => boolean;
};

export type ClaudeManagedSessionOperation = (value: Record<string, unknown>) => Promise<unknown>;
type ClaudeManagedOperation = (value: Record<string, unknown>, sessionId?: string) => unknown;
type ClaudeManagedOperationScope = {
  value: Record<string, unknown>;
  id: string;
};

/** Manages Claude session ownership, CLI runners, and read-side state. */
export class ClaudeManagedReadOwner {
  /** The installation managed sessions run; `value` is its version line when it qualifies. */
  #version?: { at: number; value: string | null; installation: ClaudeInstallation };
  #startupDiscovery = new ClaudeStartupDiscovery();
  #runners = new Map<string, ClaudeManagedRunnerProcess>();
  // A worker's acknowledged selection can lag the durable selection while a turn runs.
  #runnerSelections = new WeakMap<ClaudeManagedRunnerProcess, ClaudeSettings>();
  /** The lead tools each runner's workers start with, as JSON; absent for none. */
  #leadToolKeys = new Map<string, string>();
  #hostState: ClaudeHostStateStore;
  #turnMeta: ClaudeTurnMetaStore;
  #transcriptProofs = new ClaudeTranscriptProofs((nativeId, workspace) =>
    this.sessions.verifiedClaudeControlTarget(nativeId, workspace),
  );
  #workerObserver?: WorkerObserver;
  // Bumped when a turn end is stored, so cached history projections are read again with it.
  #turnMetaRevisions = new Map<string, number>();
  #scheduleEpoch = 0;
  #sessionScheduleEpochs = new Map<string, number>();
  #deviceScheduleEpochs = new Map<string, number>();
  #permits = new Map<
    string,
    { sessionId: string; item: ClaudeHostWork; expiresAt: number; revision: number }
  >();
  #goalEndpoints = new Map<string, { close(): Promise<void> }>();
  #goalRunners = new Set<string>();
  #ownerLocks = new Map<string, () => void>();
  #sessionQueues = new Map<string, Promise<void>>();
  // Last mode each session's worker reported in this process. Memory only: it survives a
  // retired worker so the UI keeps showing it (marked as earlier), and a backend restart or a
  // release forgets it rather than presenting a stale mode as current.
  #lastPermission = new Map<string, ClaudeObservedPermissionMode>();
  #publishConversationEvent?: ClaudeConversationPublisher;
  #aliasConversationItem?: ClaudeConversationAliaser;
  #catalogChanged?: () => void;
  #forgetIndexed?: (ids: string[]) => void;
  // Claude Desktop's session records, read for the delete capability at most every 10 s.
  #desktopClaims?: { at: number; claims: Set<string> | null };
  #ownership: ClaudeSessionOwnerProbe;
  #ownershipReasons = new Map<string, { at: number; reason: string | null }>();
  #externalTurns = new Map<string, { status: "running"; startedAt: string }>();
  #externalTurnsAt = 0;
  #externalTurnsRead?: Promise<void>;
  /**
   * The observation behind the displayed ownership of every session in one interval. Each open
   * Claude session used to start its own `claude agents` and `ps` every few seconds; a status
   * is display only, unlike the fresh check made before a worker starts.
   */
  #displayObservation?: { at: number; share: ClaudeOwnerObservationShare };
  /** The next status of this session is read from a new observation, not a shared older one. */
  #forgetOwnership(id: string): void {
    this.#ownershipReasons.delete(id);
    this.#displayObservation = undefined;
  }
  #freshObservation(): ClaudeOwnerObservationShare {
    const share: ClaudeOwnerObservationShare = {};
    this.#displayObservation = { at: Date.now(), share };
    return share;
  }
  // A live read can fence an otherwise idle runner because another host command
  // is unresolved. Catalog reads reuse that proof without opening the ledger.
  #catalogUnconfirmed = new Set<string>();
  #idleSince = new Map<string, number>();
  #observed = new Set<string>();
  #starting = new Set<string>();
  #quitInterruptions = new Map<string, string>();
  #activeHostClaims = new Map<string, string>();
  #continuationNotices = new Map<string, string>();
  #continuationNoticeIds = new Map<string, string>();
  // The device whose message each session's runner last took: a limit it meets is held for it.
  #senders = new Map<string, string>();
  #maintenanceTimer: ReturnType<typeof setInterval>;
  #maintenance?: Promise<void>;
  #shuttingDown = false;
  #idleTimeoutMs: number;

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly commands: Commands,
    readonly dataDir: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly bootId = randomUUID(),
    publishers?: {
      publish: ClaudeConversationPublisher;
      alias: ClaudeConversationAliaser;
      catalogChanged?: () => void;
      /** Drops deleted sessions from the conversation index (and what it feeds). */
      forgetIndexed?: (ids: string[]) => void;
    },
    readonly continuation: ClaudeContinuationOptions = {},
  ) {
    this.#hostState = new ClaudeHostStateStore(dataDir, bootId);
    this.#turnMeta = new ClaudeTurnMetaStore(dataDir);
    this.#publishConversationEvent = publishers?.publish;
    this.#aliasConversationItem = publishers?.alias;
    this.#catalogChanged = publishers?.catalogChanged;
    this.#forgetIndexed = publishers?.forgetIndexed;
    this.#ownership = new ClaudeSessionOwnerProbe(commands, environment);
    const configuredIdle =
      continuation.idleTimeoutMs ??
      (environment.AGENTKIB_CLAUDE_IDLE_TIMEOUT_MS === undefined
        ? 600_000
        : Number(environment.AGENTKIB_CLAUDE_IDLE_TIMEOUT_MS));
    const interval = continuation.maintenanceIntervalMs ?? 3000;
    if (
      !Number.isSafeInteger(configuredIdle) ||
      configuredIdle < 1 ||
      !Number.isSafeInteger(interval) ||
      interval < 1
    )
      throw new Error("invalid-Claude-continuation-timeout");
    this.#idleTimeoutMs = configuredIdle;
    this.#maintenanceTimer = setInterval(() => {
      if (this.#maintenance || this.#shuttingDown) return;
      this.#maintenance = this.#maintain().finally(() => {
        this.#maintenance = undefined;
      });
    }, interval);
    this.#maintenanceTimer.unref();
  }

  close(): void {
    void this.shutdown().catch(() => undefined);
  }

  observeWorkers(observer: WorkerObserver): void {
    this.#workerObserver = observer;
  }

  externalTurn(sessionId: string) {
    return this.#externalTurns.get(sessionId);
  }

  /** One registry sample for both the directory and all open detail views. */
  refreshExternalTurns(): Promise<void> {
    if (this.#externalTurnsRead) return this.#externalTurnsRead;
    if (this.#shuttingDown || Date.now() - this.#externalTurnsAt < 1_500) return Promise.resolve();
    const read = this.#ownership
      .activeRegistryTurns()
      .catch(() => [])
      .then((turns) => {
        if (this.#shuttingDown) return;
        this.#externalTurnsAt = Date.now();
        const next = new Map<string, { status: "running"; startedAt: string }>();
        const counts = new Map<string, number>();
        for (const turn of turns) counts.set(turn.nativeId, (counts.get(turn.nativeId) ?? 0) + 1);
        const records = turns.length ? this.#listRecords() : [];
        const indexed =
          turns.length > 0 &&
          !!this.store.sessions.sql.one(
            "SELECT value FROM schema_meta WHERE key='conversation_salt'",
          );
        for (const turn of turns) {
          if (counts.get(turn.nativeId) !== 1) continue;
          try {
            const cwd = canonicalize(turn.cwd);
            const projected = { status: "running", startedAt: turn.startedAt } as const;
            if (indexed) {
              const id = this.store.sessions.id("claude-code", turn.nativeId);
              const row = this.store.sessions.get(id);
              if (
                row?.agent === "claude-code" &&
                !row.sidechain &&
                within(cwd, canonicalize(this.store.workspacePath(row.workspace_id)))
              )
                next.set(id, projected);
            }
            for (const row of records)
              if (
                row.nativeId === turn.nativeId &&
                pathIdentity(row.workspace) === pathIdentity(cwd) &&
                !this.#runners.get(row.id)?.hasWorker
              )
                next.set(row.id, projected);
          } catch {
            // A disappearing directory cannot establish ownership of a visible chat.
          }
        }
        const changed =
          next.size !== this.#externalTurns.size ||
          [...next].some(([id, turn]) => this.#externalTurns.get(id)?.startedAt !== turn.startedAt);
        this.#externalTurns = next;
        if (changed) this.#catalogChanged?.();
      })
      .finally(() => {
        this.#externalTurnsRead = undefined;
      });
    this.#externalTurnsRead = read;
    return read;
  }

  invalidateSchedulePermits(sessionId?: string, deviceId?: string): void {
    if (sessionId)
      this.#sessionScheduleEpochs.set(
        sessionId,
        (this.#sessionScheduleEpochs.get(sessionId) ?? 0) + 1,
      );
    else if (deviceId)
      this.#deviceScheduleEpochs.set(deviceId, (this.#deviceScheduleEpochs.get(deviceId) ?? 0) + 1);
    else this.#scheduleEpoch++;
    for (const [key, permit] of this.#permits)
      if (
        (!sessionId || permit.sessionId === sessionId) &&
        (!deviceId || permit.item.deviceId === deviceId)
      ) {
        this.#permits.delete(key);
        this.#hostState.releaseClaim(permit.sessionId, permit.item.id);
      }
  }

  #scheduleGeneration(sessionId: string, deviceId: string): string {
    return `${this.#scheduleEpoch}:${this.#sessionScheduleEpochs.get(sessionId) ?? 0}:${this.#deviceScheduleEpochs.get(deviceId) ?? 0}`;
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    clearInterval(this.#maintenanceTimer);
    await this.#maintenance;
    // Pending guards must finish before their metadata lease is released.
    await Promise.allSettled([...this.#sessionQueues.values()]);
    this.invalidateSchedulePermits();
    await Promise.allSettled([...this.#goalEndpoints.values()].map((endpoint) => endpoint.close()));
    this.#goalEndpoints.clear();
    const runners = [...this.#runners.entries()];
    const results = await Promise.allSettled([
      this.#startupDiscovery.shutdown(),
      ...runners.map(async ([id, runner]) => {
        await runner.shutdown();
        if (this.#runners.get(id) !== runner) return;
        this.#runners.delete(id);
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const [id, release] of this.#ownerLocks) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
      this.#ownerLocks.delete(id);
    }
    if (failures.length)
      throw new AggregateError(failures, "Claude managed runner shutdown failed");
  }

  #operation(run: ClaudeManagedOperation): ClaudeManagedSessionOperation {
    return (value) => this.#requestOperation(value, run);
  }

  #sessionOperation(
    run: (scope: ClaudeManagedOperationScope) => unknown,
  ): ClaudeManagedSessionOperation {
    return this.#operation((value, id) => {
      if (!id) throw new Error("missing-session");
      return run({ value, id });
    });
  }

  readonly #sessionControl = this.#sessionOperation(({ value, id }) => this.#control(value, id));
  readonly #hostOperation = this.#sessionOperation(({ value, id }) => this.#hostControl(value, id));
  readonly #scheduleOperation = this.#sessionOperation(({ value, id }) =>
    this.#schedule(value, id),
  );
  readonly #subagentOperation = this.#sessionOperation(({ value, id }) =>
    this.subagents(id, value),
  );

  /** The typed and legacy routes run the same native operation under the same session locks. */
  readonly sessionOperations: ReadonlyMap<string, ClaudeManagedSessionOperation> = new Map([
    ["options", this.#operation((value) => this.options(value.workspaceId))],
    [
      "workspace-resources",
      this.#operation((value) => this.#workspaceResources(value.workspaceId as string)),
    ],
    ["create", this.#operation((value) => this.#create(value))],
    ["release", this.#sessionOperation(({ value, id }) => this.#release(value, id))],
    ["send", this.#sessionControl],
    ["steer", this.#sessionControl],
    ["stop", this.#sessionControl],
    ["approve", this.#sessionControl],
    ["answer", this.#sessionControl],
    [
      "live",
      this.#sessionOperation(({ id, value }) => this.live(id, value.experimentalEnabled === true)),
    ],
    [
      "capabilities",
      this.#sessionOperation(({ id, value }) =>
        this.capabilities(id, value.experimentalEnabled === true),
      ),
    ],
    [
      "inspect",
      this.#sessionOperation(({ id, value }) =>
        this.inspect(id, value.experimentalEnabled === true),
      ),
    ],
    ["resume-command", this.#sessionOperation(({ id }) => this.resumeCommand(id))],
    ["context", this.#sessionOperation(({ id }) => this.context(id))],
    [
      "events",
      this.#sessionOperation(({ id, value }) =>
        this.events(id, value.cursor, value.limit, value.retainCursor !== false),
      ),
    ],
    ["subagents", this.#subagentOperation],
    ["subagent-events", this.#subagentOperation],
    ["settings-state", this.#sessionOperation(({ id }) => this.settingsState(id))],
    [
      "settings-prepare",
      this.#sessionOperation(({ value, id }) => this.#prepareSettings(value, id)),
    ],
    [
      "goal",
      this.#sessionOperation(async ({ id }) => {
        await this.#live(id, false);
        return {
          available: true,
          goal: this.#hostState.read(id).goal,
          revision: (await this.#live(id, false)).revision,
          executionMode: "claude-managed",
        };
      }),
    ],
    ["resources", this.#sessionOperation(({ id }) => this.#resources(id))],
    [
      "queue-list",
      this.#sessionOperation(async ({ id }) => {
        await this.#live(id, false);
        return this.#queue(id);
      }),
    ],
    ["schedule-list", this.#operation((_value, id) => this.#scheduleList(id))],
    [
      "schedule-invalidate",
      this.#operation((value, id) => {
        this.invalidateSchedulePermits(id, value.deviceId as string | undefined);
        return { ok: true };
      }),
    ],
    ["schedule-prepare", this.#scheduleOperation],
    ["schedule-dispatch", this.#scheduleOperation],
    ["schedule-pause", this.#scheduleOperation],
    ["schedule-resume", this.#scheduleOperation],
    ["schedule-continue", this.#sessionOperation(({ id }) => this.#continueAfterLimit(id))],
    ["settings", this.#hostOperation],
    ["queue-add", this.#hostOperation],
    ["queue-update", this.#hostOperation],
    ["queue-delete", this.#hostOperation],
    ["queue-steer", this.#hostOperation],
    ["queue-reorder", this.#hostOperation],
    ["queue-resume", this.#hostOperation],
    ["queue-pause", this.#hostOperation],
    ["usage-limit-cancel", this.#hostOperation],
    ["usage-limit-continue", this.#hostOperation],
    ["rename", this.#hostOperation],
    ["goal-set", this.#hostOperation],
    ["goal-pause", this.#hostOperation],
    ["goal-resume", this.#hostOperation],
    ["goal-clear", this.#hostOperation],
    ["fork", this.#hostOperation],
    [
      "usage",
      this.#sessionOperation(async ({ id }) => {
        const live = await this.#live(id, false);
        const usage =
          !this.#runners.get(id)?.hasWorker &&
          (!isObject(live.usage) || live.usage.available !== true)
            ? this.#savedTranscriptObservation(id, { searchEarlier: true }).usage
            : live.usage;
        return {
          ...projectContextUsage(
            usage ?? { available: false, state: "unavailable" },
            Number(live.revision),
          ),
          executionMode: "claude-managed",
        };
      }),
    ],
    ["reconcile", this.#sessionOperation(({ value, id }) => this.#reconcile(value, id))],
    ["delete", this.#sessionOperation(({ value, id }) => this.#delete(value, id))],
    [
      "session-image",
      this.#operation((value, id) => {
        if (
          !id ||
          typeof value.imageId !== "string" ||
          !value.imageId ||
          value.imageId.length > 512
        )
          throw new Error(REMOTE_ERROR_CODES.sessionImageInvalid);
        return this.image(id, value.imageId);
      }),
    ],
  ]);

  async request(value: unknown): Promise<unknown> {
    if (!isObject(value) || typeof value.operation !== "string")
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const operation = this.sessionOperations.get(value.operation);
    if (operation) return operation(value);
    return this.#requestOperation(value, () => {
      throw new Error(`unsupported-Claude-managed-operation:${value.operation}`);
    });
  }

  async #requestOperation(
    value: Record<string, unknown>,
    operation: ClaudeManagedOperation,
  ): Promise<unknown> {
    if (!isObject(value) || typeof value.operation !== "string")
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const { operation: name } = value;
    const id = typeof value.sessionId === "string" ? value.sessionId : undefined;
    if (name === "schedule-pause" || name === "schedule-invalidate")
      this.invalidateSchedulePermits(
        id,
        typeof value.deviceId === "string" ? value.deviceId : undefined,
      );
    if (this.#shuttingDown) throw new Error("session-unavailable");
    // Media reads do not acquire execution ownership or wait for controls.
    if (name === "session-image") return operation(value, id);
    if (id && this.continuation.isSessionObserved?.(id)) this.#observed.add(id);
    const run = () => this.#requestLocked(name, () => operation(value, id), id);
    return id ? this.#serializeSession(id, run) : run();
  }

  async #requestLocked(operation: string, run: () => unknown, id?: string): Promise<unknown> {
    const readOperations = new Set([
      "live",
      "capabilities",
      "inspect",
      "context",
      "events",
      "subagents",
      "subagent-events",
      "settings-state",
      "usage",
      "goal",
      "resources",
      "reconcile",
      "queue-list",
    ]);
    const hasRecord = id !== undefined && this.#load(id) !== null;
    const ownedHere = id !== undefined && this.#ownerLocks.has(id);
    const hasRunner = id !== undefined && this.#runners.has(id);
    const release =
      hasRecord && readOperations.has(operation) && !ownedHere && !hasRunner
        ? this.#tryLock(id!)
        : null;
    if (hasRecord && readOperations.has(operation) && !release && !ownedHere && !hasRunner)
      throw new Error("session-managed-by-another-runtime");
    if (release) this.#ownerLocks.set(id!, release);
    try {
      return await run();
    } finally {
      if (release && !this.#runners.has(id!)) {
        this.#ownerLocks.delete(id!);
        release();
      }
    }
  }

  async #serializeSession<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#sessionQueues.get(id) ?? Promise.resolve();
    const current = previous.then(run);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.#sessionQueues.set(id, tail);
    try {
      return await current;
    } finally {
      if (this.#sessionQueues.get(id) === tail) this.#sessionQueues.delete(id);
    }
  }

  #savedTranscriptObservation(
    id: string,
    options: {
      source?: ReturnType<SessionReaders["verifiedClaudeReadSource"]>;
      searchEarlier?: boolean;
    } = {},
  ) {
    try {
      const source = options.source ?? this.sessions.verifiedClaudeReadSource(id);
      const observation = readClaudeTranscriptObservation(
        source.transcript,
        source.nativeId,
        options.searchEarlier,
      );
      const retained = this.continuation.retainedTerminalUsage?.(id, source, observation, () =>
        readClaudeTranscriptObservation(source.transcript, source.nativeId, "terminal-usage"),
      );
      return retained ? { ...observation, usage: retained } : observation;
    } catch {
      return { usage: { available: false, state: "unavailable" as const }, model: undefined };
    }
  }

  #savedTranscriptModel(id: string) {
    try {
      const source = this.sessions.verifiedClaudeReadSource(id);
      return readClaudeTranscriptModel(source.transcript, source.nativeId);
    } catch {
      // A missing display observation does not fail the settings read.
      return undefined;
    }
  }

  async #control(
    value: Record<string, any>,
    id: string,
    quit?: QuitEvidence,
  ): Promise<Record<string, unknown>> {
    const owned = this.#ownerLocks.has(id);
    try {
      return await this.#controlImpl(value, id, quit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (
        !["send", "steer", "approve", "answer"].includes(value.operation) ||
        ![
          "claude-owner-busy",
          "claude-background-session-running",
          "claude-owner-check-unavailable",
          "session-already-bridged",
          "claude-bridge-registry-invalid",
          "claude-terminal-handover-unavailable",
          "claude-terminal-handover-workspace-unavailable",
          "claude-terminal-handover-model-unconfirmed",
          "claude-terminal-handover-permission-unconfirmed",
          "claude-terminal-report-unconfirmed",
          "claude-terminal-report-owner-unavailable",
          ...CLAUDE_COMMAND_REFUSALS,
        ].includes(reason) ||
        managedSessionHasUnknownCommands(this.dataDir, id)
      )
        throw error;
      // These guards run before the original control is claimed or written to stdin. Record
      // that proof under the public request ID, so a host can safely retain the draft/retry.
      const logical = { ...value };
      delete logical.runtimeBootId;
      delete logical.schedulePermitId;
      const receipt = admitControlReceipt(this.dataDir, value.requestId, stableJson(logical));
      if (receipt.previous) return receipt.previous;
      const claimed = receipt.claim(id, value.deviceId, {
        operation: value.operation,
        executionMode: "claude-managed",
        runtimeBootId: this.bootId,
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      });
      if (claimed) return claimed;
      const result = {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        requestId: value.requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        error: reason,
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      };
      receipt.finish(result);
      return result;
    } finally {
      if (!owned && !this.#runners.get(id)?.hasWorker) {
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }
    }
  }

  async #controlImpl(
    value: Record<string, any>,
    id: string,
    quit?: QuitEvidence,
  ): Promise<Record<string, unknown>> {
    const operation = value.operation as string;
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
      "resourceRefs",
      "historyReferences",
      "historyInputHash",
      "turnId",
      "approvalId",
      "questionId",
      "answers",
      "answerNotes",
      "decision",
      "schedulePermitId",
      "publicInputHash",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      value.runtimeBootId !== this.bootId ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      value.experimentalEnabled !== true
    )
      throw new Error("invalid-managed-control");
    if (
      value.publicInputHash !== undefined &&
      (typeof value.publicInputHash !== "string" || !/^[a-f0-9]{64}$/.test(value.publicInputHash))
    )
      throw new Error("invalid-public-input-hash");
    if (!validHistoryControl({ ...value, operation })) throw new Error("invalid-history-reference");
    const logical = { ...value };
    delete logical.runtimeBootId;
    delete logical.schedulePermitId;
    const receipt = admitControlReceipt(this.dataDir, requestId, stableJson(logical));
    if (receipt.previous) return receipt.previous;
    if (
      operation === "steer" &&
      !supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286")
    )
      throw new Error("unsupported-Claude-version");
    // Refused commands must leave the native session and its scheduled work untouched.
    if (operation === "send" || operation === "steer")
      assertClaudeCommandAllowed(
        value.input ?? (typeof value.text === "string" ? value.text : undefined),
        value.deviceId,
        this.#commandCatalog(id),
      );

    let record = this.#load(id);
    let terminalAdoption: StagedTerminalAdoption | undefined;
    if (operation === "send" && (!record || record.released)) {
      const prepared = await this.#sessionForSend(
        id,
        value.expectedRevision,
        !value.schedulePermitId && !quit ? this.continuation.terminalHandover : undefined,
      );
      record = prepared.record;
      terminalAdoption = prepared.terminalAdoption;
    }
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    this.#validate(record);
    let existingRunner = this.#runners.get(id);
    if (operation !== "send" && !existingRunner) throw new Error("session-runner-unavailable");
    if (managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    this.#forgetOwnership(id);
    let live = await this.#live(id, true);
    if (live.status === "outcome-unknown") throw new Error("control-outcome-unconfirmed");
    if (
      operation !== "stop" &&
      ["claude-owner-busy", "claude-background-session-running"].includes(
        String(live.ownershipReason),
      )
    ) {
      if (existingRunner?.hasWorker) await this.#stopForExternalOwner(id, existingRunner);
      throw new Error(String(live.ownershipReason));
    }

    if (operation === "send" && live.activity === "compacting")
      return this.#compactingResult(id, requestId);
    if (value.expectedRevision !== live.revision) throw new Error("stale-Claude-revision");
    if (
      operation === "send" &&
      live.status === "idle" &&
      this.#goalRunners.has(id) &&
      !this.#goalEndpoints.has(id)
    ) {
      await this.#retireGoalRunner(id);
      existingRunner = undefined;
      record.snapshot = this.#load(id)!.snapshot;
      live = await this.#live(id, true);
    }
    const leadTools = operation === "send" ? await this.#leadTools(id) : undefined;
    if (
      operation === "send" &&
      live.status === "idle" &&
      existingRunner &&
      this.#leadToolKeys.get(id) !== toolKey(leadTools)
    ) {
      // It became a lead, or stopped being one, since its worker started.
      await this.#retireGoalRunner(id);
      existingRunner = undefined;
      record.snapshot = this.#load(id)!.snapshot;
      live = await this.#live(id, true);
    }

    const notePersonSent = () => {
      try {
        this.continuation.userSent?.(id);
      } catch {
        /* Bookkeeping of others never blocks the person's message. */
      }
      // The person answered what the notice asked for; the worker it was about is still there.
      if (this.#continuationNotices.get(id) === "lead-turn-limit") {
        this.#continuationNotices.delete(id);
        this.#continuationNoticeIds.delete(id);
      }
      // The person's message takes over from a continue armed after a usage limit.
      this.#hostState.personSent(id);
      const host = this.#hostState.read(id);
      if (host.goal?.status === "active")
        this.#hostState.update(id, (state) => {
          state.goal!.status = "paused";
          state.goal!.reason = "user-message";
        });
      this.invalidateSchedulePermits(id);
    };
    const personalSend = operation === "send" && !value.schedulePermitId && !quit;
    if (personalSend && !terminalAdoption) notePersonSent();
    let content: unknown;
    let executable: string | null | undefined;
    let newlyAcquiredOwnerLock = false;
    if (operation === "send" || operation === "steer") {
      if (operation === "send" && live.sendEnabled !== true)
        throw new Error(
          typeof live.ownershipReason === "string" ? live.ownershipReason : "session-busy",
        );

      if (value.resourceRefs !== undefined && !Array.isArray(value.resourceRefs))
        throw new Error("invalid-resource-references");
      content = this.#resourceInput(
        record,
        value.input ?? (typeof value.text === "string" ? value.text : undefined),
        value.resourceRefs,
      );
      if (content === undefined) throw new Error("missing-input");
      validateClaudeContent(content);
      executable = await this.#installationExecutable();
      if (operation === "send" && (await this.#retireForSelectedSettings(id))) {
        existingRunner = undefined;
        record.snapshot = this.#load(id)!.snapshot;
      }
      if (!existingRunner?.hasWorker) {
        // Preparing an idle session may already retain this runtime's lease.
        // A second file-lock acquisition would reject our own first send.
        if (!this.#ownerLocks.has(id)) {
          const release = this.#tryLock(id);
          if (!release) throw new Error("session-managed-by-another-runtime");
          this.#ownerLocks.set(id, release);
          newlyAcquiredOwnerLock = true;
        }
        try {
          await this.#ensureNoExternalOwner(record.nativeId);
          this.#refreshIdleHistory(record, !terminalAdoption);
        } catch (error) {
          if (newlyAcquiredOwnerLock) {
            const release = this.#ownerLocks.get(id);
            this.#ownerLocks.delete(id);
            release?.();
          }
          throw error;
        }
      }
    }
    const inputFingerprint =
      content === undefined ? null : createHash("sha256").update(stableJson(content)).digest("hex");
    const evidence = {
      operation,
      workspaceId: record.workspaceId,
      runtimeBootId: this.bootId,
      expectedRevision: value.expectedRevision,
      turnId: value.turnId ?? null,
      inputFingerprint,
      executionMode: "claude-managed",
      ...(value.historyInputHash ? { historyInputHash: value.historyInputHash } : {}),
      ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
    };
    const prepareAdoption = terminalAdoption
      ? await this.#prepareTerminalSend(record, terminalAdoption)
      : undefined;
    const claimed = receipt.claim(id, value.deviceId, evidence);
    if (claimed) {
      if (newlyAcquiredOwnerLock) {
        const release = this.#ownerLocks.get(id);
        this.#ownerLocks.delete(id);
        release?.();
      }
      return claimed;
    }
    if (prepareAdoption) {
      prepareAdoption();
      notePersonSent();
    }

    const previousSnapshot = structuredClone(record.snapshot);
    record.snapshot = { ...live, status: "outcome-unknown" };
    this.#save(record);
    let dispatched = operation !== "send";
    let nativeAccepted = false;
    if (dispatched) receipt.dispatch();
    let runner = existingRunner;
    if (!runner) {
      runner = this.#newRunner(record, { leadTools }, quit?.launch);
      if (quit) this.#runnerSelections.set(runner, this.#hostState.read(id).settings);
    }

    try {
      switch (operation) {
        case "send": {
          const dispatch = runner.send(
            executable!,
            content,
            requestId,
            runner.snapshot().revision,
            () => {
              if (quit) this.#assertQuitDispatch(id, runner, quit);
              if (runner.snapshot().activity === "compacting") throw new ClaudeUndispatchedError();
              // A new worker has just reported its catalog at initialize. A command it marks
              // built-in may have been unknown when this message was accepted.
              const refusal = claudeInputCommandRefusal(content, {
                owner: CLAUDE_OWNER_DEVICES.has(value.deviceId),
                commands: runner.optionsSnapshot.commands,
              });
              if (refusal) throw new ClaudeUndispatchedError(refusal);
              if (value.schedulePermitId) {
                const permit = this.#permits.get(value.schedulePermitId);
                if (
                  !permit ||
                  permit.sessionId !== id ||
                  permit.item.requestId !== requestId ||
                  permit.item.deviceId !== value.deviceId ||
                  permit.expiresAt < Date.now()
                )
                  throw new ClaudeUndispatchedError();
                this.#hostState.dispatched(id, permit.item.id);
                this.#permits.delete(value.schedulePermitId);
              }
              receipt.dispatch();
              dispatched = true;
              this.#senders.set(id, value.deviceId);
            },
            quit
              ? async () => {
                  try {
                    await this.#ensureNoExternalOwner(quit.nativeId, runner.processId);
                  } catch {
                    throw new ClaudeUndispatchedError("quit-continuation-stale");
                  }
                }
              : undefined,
          );
          try {
            await dispatch;
          } finally {
            this.#starting.delete(id);
          }
          record.fresh = false;
          break;
        }
        case "steer":
          if (typeof value.turnId !== "string") throw new Error("missing-turn");
          await runner.steer(content, requestId, value.turnId, runner.snapshot().revision);
          break;
        case "stop":
          if (typeof value.turnId !== "string") throw new Error("missing-turn");
          if (!(await runner.stop(value.turnId, runner.snapshot().revision))) break;
          nativeAccepted = true;
          new ReadStateLedger(this.dataDir).record(
            conversationReadKey("claude-code", record.home, record.nativeId),
            {
              id: `turn:${value.turnId}`,
              turnId: value.turnId,
              itemId: null,
              outcome: "cancelled",
              completedAt: new Date().toISOString(),
            },
          );
          this.#hostState.complete(id, value.turnId, {
            success: false,
            usage: null,
            cancelled: true,
          });
          this.#hostState.pause(id, "cancelled");
          this.invalidateSchedulePermits(id);
          break;
        case "approve":
          if (typeof value.turnId !== "string") throw new Error("missing-turn");
          await runner.approve(
            value.approvalId,
            value.turnId,
            value.decision,
            runner.snapshot().revision,
          );
          break;
        case "answer":
          if (typeof value.turnId !== "string") throw new Error("missing-turn");
          await runner.answer(
            value.questionId,
            value.turnId,
            value.answers,
            runner.snapshot().revision,
            value.answerNotes,
          );
          break;
        default:
          throw new Error("unsupported-Claude-control");
      }
      nativeAccepted = true;
      const snapshot = runner.snapshot();
      const current = this.#load(id)!;
      current.snapshot = snapshot as unknown as Record<string, unknown>;
      if (operation === "send") current.fresh = false;
      this.#save(current);
      // This optional projection cannot change the outcome of an accepted native control.
      const nextLive = await this.#live(id, true).catch(() => undefined);
      const result = {
        accepted: true,
        completed: false,
        requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        controlOutcome: "accepted",
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
        ...(nextLive ? { live: nextLive } : {}),
      };
      receipt.finish(result);
      return result;
    } catch (error) {
      if (quit && !dispatched && error instanceof ClaudeUndispatchedError) {
        // An idle CLI opened solely to verify this continuation must release its native lease.
        await this.#retireGoalRunner(id).catch(() => undefined);
      }
      const current = this.#load(id);
      if (current) {
        current.snapshot =
          quit && !dispatched && !runner.hasWorker
            ? previousSnapshot
            : (runner.snapshot() as unknown as Record<string, unknown>);
        this.#save(current);
      } else {
        record.snapshot = previousSnapshot;
      }
      const unknown =
        nativeAccepted ||
        (operation === "send" && dispatched) ||
        ((dispatched || !(error instanceof ClaudeUndispatchedError)) &&
          current?.snapshot.status === "outcome-unknown");
      const result = {
        accepted: false,
        completed: false,
        requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        controlOutcome: unknown ? "unknown" : "not-dispatched",
        error: error instanceof Error ? error.message : String(error),
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      };
      if (!unknown) receipt.finish(result);
      try {
        const terminal = this.#streamLive(id, runner.snapshot(), current);
        this.#publishConversationEvent?.(id, "state", terminal, terminal);
      } catch {
        // The durable result is authoritative; a later read can recover this projection.
      }
      return result;
    }
  }
  #recordStartupCleanup(record: ClaudeRecord, proof: ClaudeStartupCleanupProof): void {
    if (!supportedStartupCleanupKind(proof.cleanupKind))
      throw new Error("Claude startup cleanup method unconfirmed");
    const current = this.#load(record.id);
    if (
      !current ||
      current.released ||
      current.nativeId !== record.nativeId ||
      current.createdAt !== record.createdAt ||
      current.workspace !== record.workspace ||
      current.home !== record.home ||
      current.snapshot.status !== "outcome-unknown" ||
      current.snapshot.revision !== proof.failedRevision ||
      current.snapshot.turnId !== proof.requestId
    )
      throw new Error("Claude startup cleanup identity unconfirmed");
    this.#validate(current);
    const database = openManagedLedger(this.dataDir);
    if (!database) throw new Error("session-unavailable");
    try {
      beginManagedLedgerWrite(database);
      const other = database
        .prepare(
          "SELECT EXISTS(SELECT 1 FROM managed_commands WHERE session_id=? AND request_id<>? AND phase<>'resolved') AS found",
        )
        .get(record.id, proof.requestId) as { found: number };
      const row = database
        .prepare(
          "SELECT evidence FROM managed_commands WHERE request_id=? AND session_id=? AND phase='prepared' AND result IS NULL",
        )
        .get(proof.requestId, record.id) as { evidence: string | null } | undefined;
      const evidence: unknown = row?.evidence ? JSON.parse(row.evidence) : null;
      if (
        other.found ||
        !isObject(evidence) ||
        evidence.operation !== "send" ||
        evidence.executionMode !== "claude-managed" ||
        evidence.runtimeBootId !== this.bootId ||
        evidence.workspaceId !== record.workspaceId
      )
        throw new Error("Claude startup dispatch state unconfirmed");
      database
        .prepare("UPDATE managed_commands SET evidence=? WHERE request_id=? AND phase='prepared'")
        .run(
          JSON.stringify({
            ...evidence,
            startupCleanup: {
              version: 2,
              nativeId: record.nativeId,
              recordCreatedAt: record.createdAt,
              workspace: record.workspace,
              home: record.home,
              userDispatched: false,
              cleanupConfirmed: true,
              cleanupKind: proof.cleanupKind,
              code: proof.code,
              failedRevision: proof.failedRevision,
              checkpoint: proof.checkpoint,
            },
          }),
          proof.requestId,
        );
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the original proof write failure.
      }
      throw error;
    } finally {
      database.close();
    }
  }

  /** Only a durable, identity-bound receipt may settle an interrupted startup. Old reasons
   * and an absent runner cannot prove that a detached MCP child has stopped. */
  #recoverStartupCleanup(record: ClaudeRecord, ownerLeaseHeld = false): ClaudeRecord {
    if (this.#runners.has(record.id)) return record;
    const held = ownerLeaseHeld || this.#ownerLocks.has(record.id);
    const release = held ? null : this.#tryLock(record.id);
    if (!release && !held) return record;
    try {
      const current = this.#load(record.id);
      if (!current) throw new Error("session-unavailable");
      this.#validate(current);
      // Acquiring a lease does not make a snapshot read before that lease current.
      // Another runtime may have completed and released it in that interval.
      if (
        current.nativeId !== record.nativeId ||
        current.createdAt !== record.createdAt ||
        current.workspace !== record.workspace ||
        current.home !== record.home ||
        current.released !== record.released ||
        current.snapshot.revision !== record.snapshot.revision ||
        current.snapshot.status !== record.snapshot.status ||
        current.snapshot.turnId !== record.snapshot.turnId
      )
        return current;
      record = current;
      const database = openManagedLedger(this.dataDir);
      if (!database) return record;
      try {
        const rows = database
          .prepare(
            "SELECT request_id,phase,evidence,result FROM managed_commands WHERE session_id=? AND json_extract(evidence,'$.startupCleanup.cleanupConfirmed')=1",
          )
          .all(record.id) as Array<{
          request_id: string;
          phase: string;
          evidence: string;
          result: string | null;
        }>;
        for (const row of rows) {
          const evidence: unknown = JSON.parse(row.evidence);
          const result: unknown = row.result ? JSON.parse(row.result) : null;
          if (!isObject(evidence)) continue;
          const proof = evidence.startupCleanup;
          if (
            !isObject(proof) ||
            (proof.version !== 1 && proof.version !== 2) ||
            proof.cleanupConfirmed !== true ||
            proof.userDispatched !== false ||
            proof.nativeId !== record.nativeId ||
            proof.recordCreatedAt !== record.createdAt ||
            proof.workspace !== record.workspace ||
            proof.home !== record.home ||
            evidence.workspaceId !== record.workspaceId ||
            evidence.operation !== "send" ||
            evidence.executionMode !== "claude-managed" ||
            !startupFailureCodes.has(proof.code) ||
            !Number.isSafeInteger(proof.failedRevision) ||
            proof.failedRevision >= Number.MAX_SAFE_INTEGER ||
            !isObject(proof.checkpoint) ||
            !Number.isSafeInteger(proof.checkpoint.revision) ||
            proof.checkpoint.revision < 0 ||
            proof.checkpoint.revision >= proof.failedRevision ||
            (proof.checkpoint.turnId !== "" &&
              (typeof proof.checkpoint.turnId !== "string" ||
                !uuidPattern.test(proof.checkpoint.turnId))) ||
            !(
              (row.phase === "prepared" && row.result === null) ||
              (row.phase === "resolved" &&
                isObject(result) &&
                result.accepted === false &&
                result.controlOutcome === "not-dispatched")
            )
          )
            continue;
          const failed =
            record.snapshot.status === "outcome-unknown" &&
            record.snapshot.revision === proof.failedRevision &&
            record.snapshot.turnId === row.request_id;
          const restored =
            record.snapshot.status === "idle" &&
            record.snapshot.revision === proof.failedRevision + 1 &&
            record.snapshot.turnId === proof.checkpoint.turnId;
          if (!failed && !restored) continue;
          const other = database
            .prepare(
              "SELECT EXISTS(SELECT 1 FROM managed_commands WHERE session_id=? AND request_id<>? AND phase<>'resolved') AS found",
            )
            .get(record.id, row.request_id) as { found: number };
          if (other.found) return record;
          if (proof.version !== 2 || !supportedStartupCleanupKind(proof.cleanupKind)) {
            if (restored) {
              // Older group-only cleanup may already have saved idle and settled its command.
              // Quarantine only that exact restoration, never a later owner's progressed state.
              record.snapshot = {
                ...record.snapshot,
                status: "outcome-unknown",
                revision: Math.min(proof.failedRevision + 2, Number.MAX_SAFE_INTEGER),
                sendEnabled: false,
                stopEnabled: false,
                approvals: [],
                questions: [],
                streamText: "",
                terminalResult: null,
                reason: "Claude process cleanup unconfirmed",
              };
              this.#save(record);
              this.#catalogChanged?.();
              return record;
            }
            continue;
          }
          if (record.released) return record;
          const reason = failed
            ? record.snapshot.reason
            : isObject(result) && typeof result.error === "string"
              ? result.error
              : record.snapshot.reason;
          const rejected = {
            accepted: false,
            completed: false,
            requestId: row.request_id,
            sessionId: record.id,
            runtimeBootId: evidence.runtimeBootId,
            controlOutcome: "not-dispatched",
            error: reason,
            ...(typeof evidence.publicInputHash === "string"
              ? { publicInputHash: evidence.publicInputHash }
              : {}),
          };
          // Save the outcome first. If the metadata write is interrupted, the same receipt
          // still restores the matching failed revision on the next read.
          if (row.phase === "prepared")
            finishManagedCommand(this.dataDir, row.request_id, rejected);
          if (failed) {
            record.snapshot = {
              ...record.snapshot,
              status: "idle",
              revision: proof.failedRevision + 1,
              turnId: proof.checkpoint.turnId,
              sendEnabled: true,
              stopEnabled: false,
              approvals: [],
              questions: [],
              streamText: "",
              terminalResult: null,
              reason,
            };
            this.#save(record);
            this.#catalogChanged?.();
          }
          return record;
        }
      } finally {
        database.close();
      }
    } finally {
      release?.();
    }
    return record;
  }

  #newRunner(
    record: ClaudeRecord,
    {
      leadTools,
      ...options
    }: { mcpConfig?: Record<string, unknown>; leadTools?: Record<string, unknown> | null } = {},
    settings = this.#hostState.read(record.id).settings,
  ): ClaudeManagedRunnerProcess {
    const id = record.id;
    const mcpConfig = mergeMcpConfigs(options.mcpConfig, leadTools);
    let activeTurn: { id: string; startedAt: string } | undefined;
    let lastWaiting: string | undefined;
    const runner = new ClaudeManagedRunnerProcess(
      record.workspace,
      record.nativeId,
      record.fresh,
      Number(record.snapshot.revision ?? 0),
      this.environment,
      (snapshot: ClaudeRunnerSnapshot) => {
        const current = this.#load(id);
        if (!current || current.released) throw new Error("Claude session unavailable");
        if (snapshot.status === "idle" && !snapshot.activity && !snapshot.backgroundTasks.length)
          this.#idleSince.set(id, this.#idleSince.get(id) ?? Date.now());
        else this.#idleSince.delete(id);
        const turnId = snapshot.turnId;
        const quitting = this.#quitInterruptions.get(id) === turnId;
        let completed = false;
        if (
          snapshot.status === "idle" &&
          typeof turnId === "string" &&
          turnId.length > 0 &&
          !current.completedRequests.includes(turnId)
        ) {
          try {
            current.fingerprint = this.#targetFingerprint(current.nativeId, current.workspace);
            const { title, localTitle } = this.#hostState.read(id);
            if (!quitting && !localTitle && title && title !== current.nativeTitle) {
              // Keep completion publication synchronous; native title updates await the same
              // ownership proof as explicit renames, after the current control releases its queue.
              void this.#serializeSession(id, async () => {
                const pending = this.#load(id);
                if (!pending || pending.released) return;
                const host = this.#hostState.peek(id);
                if (host?.localTitle || host?.title !== title) return;
                await this.#persistNativeTitle(pending, title);
                this.#save(pending);
              }).catch(() => {
                /* The host title remains available for a later retry. */
              });
            }
          } catch {
            // Completion is still recorded; a missing transcript cannot prove a subsequent write is safe.
          }
          current.completedRequests.push(turnId);
          completed = true;
        }
        current.snapshot = snapshot as unknown as Record<string, unknown>;
        if (snapshot.status === "outcome-unknown" && snapshot.turnId)
          this.#hostState.complete(id, snapshot.turnId, {
            success: false,
            usage: null,
            unknown: true,
          });
        this.#save(current);
        if (completed) this.#recoverCompletions(current);
        if (turnId && ["running", "waiting-approval", "waiting-input"].includes(snapshot.status)) {
          if (activeTurn?.id !== turnId)
            activeTurn = { id: turnId, startedAt: new Date().toISOString() };
          const waiting =
            snapshot.status === "waiting-approval" ? "awaiting-approval" : snapshot.status;
          const key = `${turnId}:${waiting}`;
          if (waiting !== "running" && key !== lastWaiting) {
            lastWaiting = key;
            try {
              if (this.#workerObserver?.isWorker(id))
                this.#workerObserver.waiting(id, turnId, waiting);
            } catch {
              // Reporting must not affect the runner or its approval.
            }
          }
        }
        if (
          completed &&
          snapshot.lastOutcome === "cancelled" &&
          !snapshot.terminalResult &&
          !quitting
        )
          this.#reportWorkerTurn(id, turnId, "cancelled", null);
        const streamLive = this.#streamLive(id, snapshot, current);
        this.#publishConversationEvent?.(id, "state", streamLive, streamLive);
      },
      supportsClaudeVersion(this.#version?.value ?? "", "2.1.285"),
      (type, payload, live) => {
        if (type === "item-alias")
          this.#aliasConversationItem?.(
            id,
            String(payload.previousId),
            String(payload.itemId),
            this.#streamLive(id, live),
          );
        else {
          if (type === "item-upsert") this.#rememberTurnEnd(id, record.nativeId, payload);
          const streamLive = this.#streamLive(id, live);
          this.#publishConversationEvent?.(id, type, payload, streamLive);
        }
      },
      {
        ...settings,
        ...(record.fresh && record.forkSourceNativeId
          ? { forkSourceNativeId: record.forkSourceNativeId, forkCutoff: record.forkCutoff }
          : {}),
        ...options,
        ...(mcpConfig ? { mcpConfig } : {}),
        ...(leadTools ? { allowedTools: [...LEAD_ALLOWED_TOOLS] } : {}),
        onUndispatchedStartup: (proof) => this.#recordStartupCleanup(record, proof),
        beforeStart: () => this.#beforeRunnerStart(id),
        ...(record.terminalHandover ? { terminalHandover: true } : {}),
        ...(this.#version?.value ? { cliVersion: this.#version.value } : {}),
        backgroundTasks:
          this.continuation.backgroundTasks?.() === true &&
          supportsClaudeVersion(this.#version?.value ?? "", CLAUDE_BACKGROUND_TASKS_MINIMUM),
        onSelfTurnLimit: () => {
          this.#continuationNotices.set(id, "background-limit");
          this.#continuationNoticeIds.set(id, randomUUID());
        },
        onSelfTurn: () => {
          let allowed = true;
          try {
            allowed = this.continuation.selfTurn?.(id) !== false;
          } catch {
            /* Bookkeeping of others never stops the session's own work. */
          }
          if (!allowed) {
            this.#continuationNotices.set(id, "lead-turn-limit");
            this.#continuationNoticeIds.set(id, randomUUID());
          }
          return allowed;
        },
        onResult: (result, observation) => {
          const cancelled =
            !result.success &&
            (runner.state.lastOutcome === "cancelled" ||
              ["cancelled", "aborted", "interrupted"].includes(result.terminalReason ?? ""));
          new ReadStateLedger(this.dataDir).record(
            conversationReadKey("claude-code", record.home, record.nativeId),
            {
              id: `turn:${result.turnId}`,
              turnId: result.turnId,
              itemId:
                runner.state.streamItemId && !runner.state.streamItemId.startsWith("live:")
                  ? runner.state.streamItemId
                  : null,
              outcome: result.success ? "completed" : cancelled ? "cancelled" : "failed",
              completedAt: new Date().toISOString(),
            },
            false,
            activeTurn?.id === result.turnId ? activeTurn.startedAt : null,
          );
          this.#reportWorkerTurn(
            id,
            result.turnId,
            result.success ? "completed" : cancelled ? "cancelled" : "failed",
            observation.durationMs,
            observation.itemId,
            observation.replyText,
          );
          this.#catalogChanged?.();
          this.#hostState.complete(id, result.turnId, {
            success: result.success,
            ...(cancelled ? { cancelled: true } : {}),
            usage: result.usage,
            usageLimit: result.success ? null : runner.state.usageLimit,
            deviceId: this.#senders.get(id) ?? null,
            autoContinue: usageLimitAutoContinue(this.dataDir),
          });
          void this.#goalEndpoints
            .get(id)
            ?.close()
            .catch(() => this.#hostState.pause(id, "goal-report-close-failed"));
          this.#goalEndpoints.delete(id);
        },
      },
    );
    this.#runnerSelections.set(runner, settings);
    this.#runners.set(id, runner);
    if (this.continuation.isSessionObserved?.(id)) this.#observed.add(id);
    if (options.mcpConfig) this.#goalRunners.add(id);
    const key = toolKey(leadTools);
    if (key === undefined) this.#leadToolKeys.delete(id);
    else this.#leadToolKeys.set(id, key);
    return runner;
  }

  #reportWorkerTurn(
    id: string,
    turnId: string,
    outcome: string,
    durationMs: number | null,
    historyItemId?: string,
    replyText?: string,
  ): void {
    try {
      if (this.#workerObserver?.isWorker(id))
        this.#workerObserver.turnEnded(id, turnId, outcome, durationMs, historyItemId, replyText);
    } catch {
      // Reporting must not affect a finished turn.
    }
  }

  /** A lead's delegation tools; none when the lookup fails, so the session still runs. */
  async #leadTools(id: string): Promise<Record<string, unknown> | null> {
    try {
      return (await this.continuation.leadTools?.(id)) ?? null;
    } catch {
      return null;
    }
  }

  /** Keeps a turn end the transcript will not have, so history shows it after the live rows go. */
  #rememberTurnEnd(id: string, nativeId: string, item: Record<string, unknown>): void {
    if (typeof item.id !== "string" || !isObject(item.turn_meta)) return;
    if (
      item.kind !== "agent-message" &&
      !(
        item.kind === "tool-summary" &&
        (item.tool_status === "completed" || item.tool_status === "failed") &&
        isClaudeToolItemId(item.id) &&
        item.turn_meta.summary
      )
    )
      return;
    try {
      if (this.#turnMeta.record(nativeId, item.id, item.turn_meta))
        this.#turnMetaRevisions.set(id, (this.#turnMetaRevisions.get(id) ?? 0) + 1);
    } catch (error) {
      // Display metadata only: the live row still shows it, and the turn is unaffected.
      console.warn(
        `Claude turn duration not stored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** History pages with the stored turn ends added; a duration the transcript has is kept. */
  #withTurnEnds(nativeId: string, page: ConversationEventPage): ConversationEventPage {
    const anchors = new Set(
      page.events.filter(
        (event) =>
          !event.turn_meta &&
          (event.kind === "agent-message" ||
            (event.kind === "tool-summary" &&
              isClaudeToolItemId(event.id) &&
              (event.tool_status === "completed" || event.tool_status === "failed"))),
      ),
    );
    if (!anchors.size) return page;
    let stored: Map<string, ConversationTurnMeta>;
    try {
      stored = this.#turnMeta.read(
        nativeId,
        [...anchors].map((event) => event.id),
      );
    } catch {
      return page;
    }
    if (!stored.size) return page;
    return {
      ...page,
      events: page.events.map((event) => {
        const meta = anchors.has(event) ? stored.get(event.id) : undefined;
        return meta ? { ...event, turn_meta: meta } : event;
      }),
    };
  }

  async #retireGoalRunner(id: string): Promise<void> {
    const runner = this.#runners.get(id);
    if (runner) await runner.shutdown();
    this.#runners.delete(id);
    this.#goalRunners.delete(id);
    this.#leadToolKeys.delete(id);
  }

  #canStageRunningSettings(id: string, live: Record<string, unknown>): boolean {
    const runner = this.#runners.get(id);
    // The first frame of a native self-turn arrives after Claude can start using its settings.
    return (
      ["running", "waiting-approval", "waiting-input"].includes(String(live.status)) &&
      live.activity !== "compacting" &&
      !live.ownershipReason &&
      runner?.hasWorker === true &&
      !runner.state.backgroundTasksEnabled &&
      !runner.state.hasScheduledWork() &&
      runner.optionsSnapshot.settingsAcknowledged
    );
  }

  #runnerSelectionPending(runner: ClaudeManagedRunnerProcess, settings: ClaudeSettings): boolean {
    return stableJson(this.#runnerSelections.get(runner)) !== stableJson(settings);
  }

  /** A staged selection is used by the next worker, at the serialized send admission. */
  async #retireForSelectedSettings(id: string): Promise<boolean> {
    const runner = this.#runners.get(id);
    if (!runner || !this.#runnerSelectionPending(runner, this.#hostState.read(id).settings))
      return false;
    if (runner.hasWorker) {
      if (this.#goalEndpoints.has(id)) throw new Error("session-busy");
      const release = runner.retireIfInactive();
      if (!release || !(await release)) throw new Error("session-busy");
    }
    await this.#retireGoalRunner(id);
    return true;
  }

  #queue(id: string): Record<string, unknown> {
    const state = this.#hostState.read(id);
    return {
      available: true,
      revision: state.revision,
      paused: state.paused,
      requiresResume: state.paused,
      reason: state.reason,
      data: state.work
        .filter(
          (item) =>
            item.kind === "queue" &&
            ["pending", "claimed", "dispatched", "unknown"].includes(item.status),
        )
        .map((item) => ({
          id: item.id,
          clientUserMessageId: item.originRequestId,
          requestId: item.requestId,
          deviceId: item.deviceId,
          input: typeof item.input === "string" ? [{ type: "text", text: item.input }] : item.input,
          status: item.status,
          createdAt: item.createdAt,
          requiresAttachments: item.requiresAttachments,
          actions: { steer: { available: canSteerClaudeQueueItem(item) } },
          queueSteerDeviceId: item.deviceId,
        })),
      nextCursor: null,
    };
  }

  #settings(value: Record<string, unknown>, previous: ClaudeSettings = {}): ClaudeSettings {
    if (value.resetDefaults === true) return {};
    const result = { ...previous };
    if (value.model !== undefined) {
      if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 256)
        throw new Error("invalid-model");
      result.model = value.model;
    }
    if (value.effort !== undefined) {
      if (value.effort === null) delete result.effort;
      else if (!["low", "medium", "high", "xhigh", "max"].includes(String(value.effort)))
        throw new Error("unsupported-effort");
      else result.effort = value.effort as ClaudeSettings["effort"];
    }
    if (value.permissionMode !== undefined) {
      if (!isClaudePermissionMode(value.permissionMode))
        throw new Error("unsupported-permission-mode");
      result.permissionMode = value.permissionMode;
    }
    return result;
  }

  async #prepareRunner(
    record: ClaudeRecord,
    options: { mcpConfig?: Record<string, unknown> } = {},
    settings?: ClaudeSettings,
  ): Promise<ClaudeManagedRunnerProcess> {
    if (
      !options.mcpConfig &&
      this.#goalRunners.has(record.id) &&
      !this.#goalEndpoints.has(record.id)
    ) {
      await this.#retireGoalRunner(record.id);
      record = this.#load(record.id)!;
    }
    if (!this.#ownerLocks.has(record.id)) {
      const release = this.#tryLock(record.id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(record.id, release);
    }
    const leadTools = await this.#leadTools(record.id);
    let runner = this.#runners.get(record.id);
    if (runner && !runner.hasWorker && this.#leadToolKeys.get(record.id) !== toolKey(leadTools)) {
      await this.#retireGoalRunner(record.id);
      record = this.#load(record.id)!;
      runner = undefined;
    }
    if (!runner?.hasWorker) {
      await this.#ensureNoExternalOwner(record.nativeId);
      this.#refreshIdleHistory(record);
      if ((await this.#installationVersion()) === null)
        throw new Error(this.#installationMissing());
      runner = this.#newRunner(record, { ...options, leadTools }, settings);
    }
    try {
      const executable = await this.#installationExecutable();
      await runner.prepare(executable);
    } finally {
      this.#starting.delete(record.id);
    }
    return runner;
  }

  async #persistNativeTitle(record: ClaudeRecord, title: string): Promise<void> {
    if (this.#shuttingDown) throw new Error("session-unavailable");
    await this.#ensureNoExternalOwner(
      record.nativeId,
      this.#runners.get(record.id)?.processId ?? null,
    );
    if (this.#shuttingDown) throw new Error("session-unavailable");
    const proof = this.#transcriptProofs.read(record.nativeId, record.workspace);
    if (record.fingerprint !== proof.fingerprint)
      throw new Error("claude-session-fingerprint-changed");
    if (record.nativeTitle === title) return;
    const { transcript } = proof;
    const fd = openSync(
      transcript,
      constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = fstatSync(fd, { bigint: true });
      if (before.nlink !== 1n || !sameClaudeTranscript(proof.metadata, before))
        throw new Error("invalid-Claude-transcript");
      const end = Buffer.allocUnsafe(1);
      if (before.size && readSync(fd, end, 0, 1, Number(before.size) - 1) !== 1)
        throw new Error("invalid-Claude-transcript");
      const row = Buffer.from(
        `${before.size && end[0] !== 10 ? "\n" : ""}${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: record.nativeId })}\n`,
      );
      if (writeSync(fd, row) !== row.length) throw new Error("Claude-title-write-incomplete");
      fsyncSync(fd);
      const written = Buffer.allocUnsafe(row.length);
      const after = fstatSync(fd, { bigint: true });
      const verified = lstatSync(transcript, { bigint: true });
      if (
        after.size !== before.size + BigInt(row.length) ||
        after.nlink !== 1n ||
        verified.nlink !== 1n ||
        !sameClaudeTranscript(after, verified) ||
        readSync(fd, written, 0, row.length, Number(before.size)) !== row.length ||
        !written.equals(row) ||
        !sameClaudeTranscript(after, fstatSync(fd, { bigint: true }))
      )
        throw new Error("Claude-title-write-unconfirmed");
      // We verified the original snapshot and read back exactly this append.
      // Advance the same content digest without rescanning any earlier bytes.
      const hash = proof.hash.copy().update(row);
      record.fingerprint = hash.copy().digest("hex");
      this.#transcriptProofs.remember({
        ...proof,
        metadata: after,
        hash,
        fingerprint: record.fingerprint,
      });
    } finally {
      closeSync(fd);
    }
    record.nativeTitle = title;
    this.#save(record);
  }

  #completedTurnIncludesUser(record: ClaudeRecord, turnId: string, userId: unknown): boolean {
    if (turnId === userId) return true;
    if (typeof userId !== "string" || !uuidPattern.test(userId)) return false;
    const database = openManagedLedger(this.dataDir);
    if (!database) return false;
    try {
      const row = database
        .prepare(
          "SELECT evidence,result FROM managed_commands WHERE request_id=? AND session_id=? AND phase='resolved'",
        )
        .get(userId, record.id) as { evidence: string | null; result: string | null } | undefined;
      if (!row?.evidence || !row.result) return false;
      const evidence: unknown = JSON.parse(row.evidence);
      const result: unknown = JSON.parse(row.result);
      return (
        isObject(evidence) &&
        ["steer", "queue-steer"].includes(String(evidence.operation)) &&
        evidence.executionMode === "claude-managed" &&
        evidence.turnId === turnId &&
        isObject(result) &&
        result.accepted === true &&
        result.controlOutcome === "accepted"
      );
    } finally {
      database.close();
    }
  }

  async #hostControl(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const owned = this.#ownerLocks.has(id);
    let externalClaimStarted = false;
    try {
      return await this.#hostControlImpl(value, id, () => {
        externalClaimStarted = true;
      });
    } catch (error) {
      if (
        externalClaimStarted ||
        !sessionIdPattern.test(id) ||
        !validClaudeDeviceId(value.deviceId) ||
        typeof value.requestId !== "string" ||
        !uuidPattern.test(value.requestId)
      )
        throw error;
      try {
        // An existing claim or committed receipt is stronger evidence than local exception timing.
        const database = openManagedLedger(this.dataDir);
        if (database) {
          try {
            if (
              database
                .prepare("SELECT request_id FROM managed_commands WHERE request_id=?")
                .get(value.requestId)
            )
              throw error;
          } finally {
            database.close();
          }
        }
        const record = this.#load(id);
        if (
          record?.released ||
          !this.#ownerLocks.has(id) ||
          (!record && value.operation !== "settings")
        )
          throw error;
        if (record) this.#validate(record);
        const workspaceId =
          record?.workspaceId ?? this.sessions.verifiedClaudeReadSource(id).workspaceId;
        const reason = error instanceof Error ? error.message : "";
        const result = this.#hostState.command(id, value, workspaceId, () => ({
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          // A refused command, or a model or effort Claude Code does not offer, is explained to
          // the user; other preflight details stay inside.
          error:
            isClaudeCommandRefusal(reason) || EXPLAINED_SETTINGS_REASONS.has(reason)
              ? reason
              : "control-preflight-rejected",
        }));
        if (result.controlOutcome !== "not-dispatched") throw error;
        throw new ClaudeHostControlPreflightError(
          error instanceof Error ? error.message : "control-preflight-rejected",
          result,
        );
      } catch (recordingError) {
        if (recordingError instanceof ClaudeHostControlPreflightError) throw recordingError;
        throw error;
      }
    } finally {
      if (this.#activeHostClaims.get(id) === value.requestId) this.#activeHostClaims.delete(id);
      // Settings need only a commit lease; a preexisting scheduled-work lease stays owned.
      if (
        (!this.#load(id) || (value.operation === "settings" && !owned)) &&
        !this.#runners.get(id)?.hasWorker
      ) {
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }
    }
  }

  async #hostControlImpl(
    value: Record<string, any>,
    id: string,
    onExternalClaim: () => void,
  ): Promise<Record<string, unknown>> {
    const operation = value.operation as string;
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "name",
      "model",
      "effort",
      "permissionMode",
      "resetDefaults",
      "goal",
      "text",
      "input",
      "resourceRefs",
      "historyReferences",
      "historyInputHash",
      "queuedSubmissionId",
      "queuedSubmissionIds",
      "turnId",
      "publicInputHash",
    ]);
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof value.requestId !== "string" ||
      !uuidPattern.test(value.requestId) ||
      value.runtimeBootId !== this.bootId ||
      value.experimentalEnabled !== true ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-control");
    if (!validHistoryControl({ ...value, operation })) throw new Error("invalid-history-reference");
    if (
      value.publicInputHash !== undefined &&
      (typeof value.publicInputHash !== "string" || !/^[a-f0-9]{64}$/.test(value.publicInputHash))
    )
      throw new Error("invalid-public-input-hash");
    const receipt = admitControlReceipt(
      this.dataDir,
      value.requestId,
      claudeCommandFingerprintInput(value),
    );
    if (receipt.previous) return receipt.previous;
    if (operation === "rename" && !this.managedWorkspace(id)) {
      const live = await this.#live(id, true);
      if (this.managedWorkspace(id)) throw new Error("stale-Claude-revision");
      const { workspaceId } = this.#nativeTarget(id, true);
      return this.renameLocalTitle(value, {
        sessionId: id,
        workspaceId,
        revision: Number(live.revision),
        executionMode: "claude-managed",
      }).receipt;
    }
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
    let record = this.#load(id);
    if (operation === "settings" && !this.#runners.get(id)?.hasWorker)
      return this.#stageInactiveSettings(value, id);
    if (operation === "fork" && !record) {
      const target = this.#resolveNative(id);
      record = {
        version: 1,
        id,
        ...target,
        registeredWorkspace: canonicalize(this.store.workspacePath(target.workspaceId)),
        home: this.#home(),
        title: this.#nativeMetadata(target.nativeId, target.workspace)?.title ?? "Claude Code",
        createdAt: new Date().toISOString(),
        adopted: false,
        released: false,
        fresh: false,
        snapshot: { status: "idle", revision: 0 },
        completedRequests: [],
      };
    }
    if (!record || (record.released && operation !== "fork"))
      throw new Error("session-unavailable");
    this.#validate(record);
    if (!this.#ownerLocks.has(id)) {
      if (operation === "fork") this.#privateDirectory(true);
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    const live = await this.#live(id, true);
    if (live.status === "outcome-unknown" || managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    if (live.revision !== value.expectedRevision) throw new Error("stale-Claude-revision");
    if (
      ["goal-set", "goal-resume", "queue-resume", "usage-limit-continue"].includes(operation) &&
      live.ownershipReason
    )
      throw new Error(String(live.ownershipReason));
    const state = this.#hostState.read(id);
    const idle = live.status === "idle" && live.activity !== "compacting";
    const settingsRunner = this.#runners.get(id);
    const stageSettings =
      operation === "settings" &&
      settingsRunner &&
      (this.#canStageRunningSettings(id, live) ||
        (idle && this.#runnerSelectionPending(settingsRunner, state.settings)));
    if ((operation === "settings" || operation === "rename") && live.ownershipReason)
      throw new Error(String(live.ownershipReason));
    if (
      ["settings", "rename", "fork", "goal-set", "goal-resume", "queue-resume"].includes(
        operation,
      ) &&
      !idle &&
      !stageSettings
    )
      throw new Error("session-busy");
    let nextSettings: ClaudeSettings | undefined;
    let renamedTitle: string | undefined;
    let localRename = false;
    let externallyDispatched = false;
    const claimExternalEffect = (steer?: { item: ClaudeHostWork; turnId: string }) => {
      const externalReceipt = bindControlReceipt(
        this.dataDir,
        value.requestId,
        claudeCommandFingerprintInput(value),
      );
      const evidence = {
        operation,
        ...(steer ? { turnId: steer.turnId } : {}),
        workspaceId: record.workspaceId,
        executionMode: "claude-managed",
        runtimeBootId: this.bootId,
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      };
      if (steer) {
        this.#hostState.dispatchQueueSteer(
          id,
          steer.item,
          value.requestId,
          externalReceipt.fingerprint,
          evidence,
        );
        onExternalClaim();
      } else {
        onExternalClaim();
        const prior = externalReceipt.claim(id, value.deviceId, evidence);
        if (prior) throw new Error("control-outcome-unconfirmed");
        externalReceipt.dispatch();
      }
      this.#activeHostClaims.set(id, value.requestId);
      externallyDispatched = true;
    };
    if (operation === "queue-steer") {
      const runner = this.#runners.get(id);
      const turnId = live.turnId;
      if (
        !runner?.hasWorker ||
        live.status !== "running" ||
        live.activity === "compacting" ||
        live.ownershipReason ||
        typeof turnId !== "string"
      )
        throw new Error("session-requires-running-turn");
      const item = state.work.find((work) => work.id === value.queuedSubmissionId);
      if (!item || !canSteerClaudeQueueItem(item) || item.deviceId !== value.deviceId)
        throw new Error("queue-item-unavailable");
      if (value.input !== undefined || value.text !== undefined || value.resourceRefs !== undefined)
        throw new Error("invalid-queue-steer-input");
      assertClaudeCommandAllowed(item.input, item.deviceId, this.#commandCatalog(id));
      await runner.steer(item.input, value.requestId, turnId, runner.snapshot().revision, () =>
        claimExternalEffect({ item, turnId }),
      );
    }
    if (operation === "settings") {
      nextSettings = this.#settings(value, state.settings);
      if (
        value.permissionMode !== undefined ||
        value.model !== undefined ||
        value.resetDefaults === true
      )
        this.#startupDiscovery.invalidateAutoPermission(record.workspace);
      let runner = stageSettings ? settingsRunner : await this.#prepareRunner(record);
      const models = runner.optionsSnapshot.models;
      // `/model` passes the name as typed; keep the listed value it means.
      let requested = value;
      if (typeof value.model === "string" && value.resetDefaults !== true) {
        const option = claudeModelOption(models, value.model);
        if (!option) throw new Error("unsupported-model");
        requested = { ...value, model: option.value };
        nextSettings = this.#settings(requested, state.settings);
      }
      const model = nextSettings.model ?? runner.optionsSnapshot.settings.model;
      if (nextSettings.model && !models.some((model) => model.value === nextSettings!.model))
        throw new Error("unsupported-model");
      if (
        nextSettings.effort &&
        !models
          .find((option) => option.value === model || option.resolvedModel === model)
          ?.supportedEffortLevels?.includes(nextSettings.effort)
      )
        throw new Error("unsupported-effort");
      if (
        nextSettings.permissionMode === "auto" &&
        (value.permissionMode === "auto" || value.model !== undefined) &&
        !(await this.#autoPermissionAvailable(record.workspace, model, true))
      )
        throw new Error("unsupported-permission-mode");
      if (!stageSettings) claimExternalEffect();
      if (!stageSettings && (value.resetDefaults === true || value.effort === null)) {
        // Native effortLevel:null selects CLI defaults rather than inherited host settings.
        // Relaunch without only the cleared override so live and restarted behavior agree.
        await runner.shutdown();
        this.#runners.delete(id);
        runner = await this.#prepareRunner(this.#load(id)!, {}, nextSettings);
      } else if (!stageSettings) {
        await runner.configure(this.#settings(requested), runner.snapshot().revision);
        this.#runnerSelections.set(runner, nextSettings);
      }
    }
    if (operation === "rename") {
      renamedTitle = claudeSessionTitle(value.name);
      if (!record.fresh) {
        const proof = this.#transcriptProofs.readForRename(record.nativeId, record.workspace);
        localRename = proof === null;
        if (proof) {
          if (record.fingerprint !== proof.fingerprint)
            throw new Error("claude-session-fingerprint-changed");
          claimExternalEffect();
          await this.#persistNativeTitle(record, renamedTitle!);
        }
      }
    }
    let fork: ClaudeRecord | undefined;
    if (operation === "fork") {
      if (record.fresh) throw new Error("fork-history-unavailable");
      // A fork only reads its source. External ownership forbids resuming the source,
      // but not continuing a verified completed turn under a new native session ID.
      const owner = await this.#ownership.check(
        record.nativeId,
        this.#runners.get(record.id)?.processId ?? null,
        this.#freshObservation(),
      );
      const target = this.#resolveNative(id);
      if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
        throw new Error("unverified-session-identity");
      const fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
      if (target.fingerprint !== fingerprint) throw new Error("claude-session-fingerprint-changed");
      const transcript = this.sessions.verifiedClaudeControlTarget(
        record.nativeId,
        record.workspace,
      );
      const { anchor: last, userUuid } = await readClaudeForkHistory(
        transcript,
        record.nativeId,
        uuidPattern,
        owner.kind === "idle",
      );
      if (this.#targetFingerprint(record.nativeId, record.workspace) !== fingerprint)
        throw new Error("claude-session-fingerprint-changed");
      const terminal = record.snapshot.terminalResult;
      const confirmedManagedTurn =
        isObject(terminal) &&
        terminal.success === true &&
        typeof terminal.turnId === "string" &&
        this.#completedTurnIncludesUser(record, terminal.turnId, userUuid) &&
        record.completedRequests.includes(terminal.turnId);
      if (
        last?.type !== "assistant" ||
        (!confirmedManagedTurn && !completedClaudeForkResult(last.stopReason))
      )
        throw new Error("fork-cutoff-unavailable");
      const existingFork = this.#load(value.requestId);
      if (
        existingFork &&
        (existingFork.forkSourceNativeId !== record.nativeId ||
          existingFork.forkCutoff !== last.uuid)
      )
        throw new Error("fork-request-conflict");
      claimExternalEffect();
      fork = existingFork ?? {
        ...record,
        id: value.requestId,
        nativeId: value.requestId,
        createdAt: new Date().toISOString(),
        adopted: false,
        released: false,
        title:
          this.#nativeMetadata(record.nativeId, record.workspace)?.title ??
          state.localTitle ??
          state.title ??
          record.title,
        nativeTitle: undefined,
        fresh: true,
        fingerprint: null,
        forkSourceNativeId: record.nativeId,
        forkCutoff: last.uuid,
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
        completedRequests: [],
      };
      this.#save(fork);
      this.#hostState.update(fork.id, (target) => {
        target.settings = { ...state.settings };
      });
    }
    // Read before the host-state transaction below, which must not open another one.
    const commands = ["queue-add", "queue-update", "goal-set"].includes(operation)
      ? this.#commandCatalog(id)
      : [];
    const result = this.#hostState.command(
      id,
      value,
      record.workspaceId,
      (host) => {
        switch (operation) {
          case "settings":
            if (stageSettings && host.revision !== state.revision)
              throw new Error("stale-Claude-revision");
            host.settings = nextSettings!;
            return {
              settings: host.settings,
              ...(stageSettings ? { appliesTo: "next-turn" } : {}),
            };
          case "rename": {
            if (localRename) host.localTitle = renamedTitle!;
            else {
              host.title = renamedTitle!;
              delete host.localTitle;
            }
            return { name: renamedTitle };
          }
          case "fork":
            return {
              sessionId: fork!.id,
              sourceSessionId: fork!.nativeId,
              forkSourceSessionId: record.nativeId,
            };
          case "queue-add": {
            if (
              host.work.filter((work) =>
                ["pending", "claimed", "dispatched", "unknown"].includes(work.status),
              ).length >= 100
            )
              throw new Error("queue-limit");
            const input = this.#resourceInput(
              record,
              value.input ?? value.text,
              value.resourceRefs,
            );
            validateClaudeContent(input);
            assertClaudeCommandAllowed(input, value.deviceId, commands);
            const item: ClaudeHostWork = {
              id: randomUUID(),
              requestId: randomUUID(),
              originRequestId: value.requestId,
              deviceId: value.deviceId,
              originDeviceId: value.deviceId,
              kind: "queue",
              status: "pending",
              input,
              requiresAttachments: Array.isArray(value.input),
              createdAt: new Date().toISOString(),
              report: null,
              usage: null,
            };
            if (
              Buffer.byteLength(JSON.stringify(host.work)) +
                Buffer.byteLength(JSON.stringify(item)) >
              64 * 1024 * 1024
            )
              throw new Error("queue-storage-limit");
            host.work.push(item);
            return {
              completed: false,
              queuedSubmission: {
                id: item.id,
                requestId: item.requestId,
                clientUserMessageId: item.originRequestId,
                status: item.status,
              },
            };
          }
          case "queue-update":
          case "queue-delete": {
            const item = host.work.find(
              (work) => work.id === value.queuedSubmissionId && work.kind === "queue",
            );
            if (!item || item.status !== "pending") throw new Error("queue-item-unavailable");
            if (item.originRequestId) host.settledRequests.push(item.originRequestId);
            if (operation === "queue-delete") {
              item.status = "cancelled";
              item.input = "";
              return {};
            }
            if (item.requiresAttachments || Array.isArray(item.input))
              throw new Error("queue-attachment-item-not-editable");
            if (typeof (value.input ?? value.text) !== "string")
              throw new Error("queue-update-requires-text");
            const input = this.#resourceInput(
              record,
              value.input ?? value.text,
              value.resourceRefs,
            );
            validateClaudeContent(input);
            // The item is still sent as the device that queued it, so the edit must suit both.
            assertClaudeCommandAllowed(input, value.deviceId, commands);
            assertClaudeCommandAllowed(input, item.deviceId, commands);
            item.input = input;
            item.originRequestId = value.requestId;
            if (Buffer.byteLength(JSON.stringify(host.work)) > 64 * 1024 * 1024)
              throw new Error("queue-storage-limit");
            return {
              completed: false,
              queuedSubmission: {
                id: item.id,
                requestId: item.requestId,
                clientUserMessageId: item.originRequestId,
                status: item.status,
              },
            };
          }
          case "queue-steer":
            return { completed: false };
          case "queue-reorder": {
            const queue = host.work.filter(
              (work) => work.kind === "queue" && work.status === "pending",
            );
            const ids = value.queuedSubmissionIds;
            if (
              !Array.isArray(ids) ||
              ids.length !== queue.length ||
              new Set(ids).size !== ids.length ||
              queue.some((work) => !ids.includes(work.id))
            )
              throw new Error("stale-queue-order");
            const order = new Map(ids.map((itemId: string, index: number) => [itemId, index]));
            const ordered = [...queue].sort(
              (a, b) => Number(order.get(a.id)) - Number(order.get(b.id)),
            );
            let index = 0;
            host.work = host.work.map((work) =>
              work.kind === "queue" && work.status === "pending" ? ordered[index++]! : work,
            );
            return {};
          }
          case "queue-pause":
            host.paused = true;
            host.reason = "user-paused";
            return {};
          case "usage-limit-cancel":
            // The person turned the automatic continue off; the session waits for them.
            if (!host.usageLimit || host.usageLimit.continueAt === null)
              throw new Error("usage-limit-continue-unavailable");
            host.usageLimit = { ...host.usageLimit, continueAt: null, manual: "cancelled" };
            return {};
          case "usage-limit-continue": {
            // The person wants the continue this time after all; the queue waits for it.
            const armed = armUsageLimit(host.usageLimit, { bootId: this.bootId });
            if (!armed) throw new Error("usage-limit-continue-unavailable");
            host.usageLimit = armed;
            if (!host.paused) {
              host.paused = true;
              host.reason = "usage-limit";
            }
            return {};
          }
          case "queue-resume":
          case "goal-resume": {
            if (host.work.some((work) => work.status === "unknown" || work.status === "dispatched"))
              throw new Error("control-outcome-unconfirmed");
            host.paused = false;
            host.reason = null;
            if (operation === "goal-resume") {
              if (!host.goal || host.goal.status === "completed")
                throw new Error("goal-unavailable");
              if (host.goal.tokenBudget !== null && host.goal.usageIncomplete)
                throw new Error("usage-unavailable");
              if (host.goal.tokenBudget !== null && host.goal.tokensUsed >= host.goal.tokenBudget)
                throw new Error("token-budget-exhausted");
              host.goal.status = "active";
              host.goal.reason = null;
            }
            return {};
          }
          case "goal-set": {
            if (
              !isObject(value.goal) ||
              typeof value.goal.objective !== "string" ||
              !value.goal.objective.trim() ||
              Buffer.byteLength(value.goal.objective) > 16384
            )
              throw new Error("invalid-goal-objective");
            const intent = value.goal.intent ?? "start";
            if (intent !== "start" && intent !== "update") throw new Error("invalid-goal-intent");
            if (intent === "start" && host.goal) throw new Error("goal-already-exists");
            if (intent === "update" && !host.goal) throw new Error("goal-unavailable");
            // Each step starts with the objective and is sent as the goal's device.
            const step = goalStepInput(value.goal.objective, "pending");
            assertClaudeCommandAllowed(step, value.deviceId, commands);
            if (intent === "update")
              assertClaudeCommandAllowed(step, host.goal!.deviceId, commands);
            const budget =
              intent === "update" && value.goal.tokenBudget === undefined
                ? host.goal!.tokenBudget
                : (value.goal.tokenBudget ?? null);
            if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0))
              throw new Error("invalid-goal-budget");
            for (const work of host.work)
              if (work.kind === "goal" && work.status === "pending") work.status = "cancelled";
            host.goal = {
              id: host.goal?.id ?? randomUUID(),
              generation: randomUUID(),
              objective: value.goal.objective,
              deviceId: intent === "update" ? host.goal!.deviceId : value.deviceId,
              tokenBudget: budget,
              tokensUsed: intent === "update" ? (host.goal?.tokensUsed ?? 0) : 0,
              elapsedMs: intent === "update" ? (host.goal?.elapsedMs ?? 0) : 0,
              usageIncomplete: intent === "update" ? (host.goal?.usageIncomplete ?? false) : false,
              missingUsageStepIds:
                intent === "update" ? [...(host.goal?.missingUsageStepIds ?? [])] : [],
              noProgressCount: intent === "update" ? (host.goal?.noProgressCount ?? 0) : 0,
              status: intent === "update" && host.goal?.status !== "active" ? "paused" : "active",
              reason: null,
              lastReport: intent === "update" ? (host.goal?.lastReport ?? null) : null,
            };
            if (host.goal.tokenBudget !== null && host.goal.usageIncomplete) {
              host.goal.status = "paused";
              host.goal.reason = "usage-unavailable";
            }
            if (intent === "start") {
              host.paused = false;
              host.reason = null;
            }
            return { goal: host.goal };
          }
          case "goal-pause":
            if (!host.goal) throw new Error("goal-unavailable");
            host.goal.status = "paused";
            host.goal.reason = "user-paused";
            return { goal: host.goal };
          case "goal-clear":
            if (!host.goal) throw new Error("goal-unavailable");
            host.goal = null;
            for (const work of host.work)
              if (work.kind === "goal" && work.status === "pending") work.status = "cancelled";
            return { goal: null };
          default:
            throw new Error("unsupported-Claude-managed-operation");
        }
      },
      externallyDispatched,
    );
    this.invalidateSchedulePermits(id);
    if (["goal-pause", "goal-clear"].includes(operation)) {
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
    }
    const currentLive = await this.#live(id, true);
    this.#publishConversationEvent?.(id, "state", currentLive, currentLive);
    if (operation === "rename") this.#catalogChanged?.();
    return result;
  }

  async #scheduleList(id?: string): Promise<Record<string, unknown>> {
    for (const [permitId, permit] of this.#permits) {
      if (permit.expiresAt >= Date.now()) continue;
      this.#permits.delete(permitId);
      this.#hostState.releaseClaim(permit.sessionId, permit.item.id);
    }
    const records = id
      ? [this.#load(id)].filter((record): record is ClaudeRecord => !!record)
      : this.#listRecords();
    const sessions: Array<Record<string, unknown>> = [];
    for (const record of records) {
      if (record.released) continue;
      try {
        this.#validate(record);
        if (!this.#ownerLocks.has(record.id)) {
          const release = this.#tryLock(record.id);
          if (!release) continue;
          this.#ownerLocks.set(record.id, release);
        }
        const before = await this.#live(record.id, true);
        const next =
          before.status === "idle" && before.activity !== "compacting"
            ? this.#hostState.next(record.id)
            : null;
        const live = await this.#live(record.id, true);
        const host = this.#hostState.read(record.id);
        sessions.push({
          sessionId: record.id,
          workspaceId: record.workspaceId,
          runtimeBootId: this.bootId,
          revision: live.revision,
          scheduleRevision: host.revision,
          paused: host.paused,
          reason: host.reason,
          // When a continue armed after a usage limit is due; the scheduler asks for it then.
          continueAt:
            host.paused &&
            host.reason === "usage-limit" &&
            usageLimitContinue(host.usageLimit, this.bootId) !== "never"
              ? host.usageLimit!.continueAt
              : null,
          next: next
            ? {
                itemId: next.id,
                requestId: next.requestId,
                originRequestId: next.originRequestId,
                deviceId: next.deviceId,
                originDeviceId: next.originDeviceId,
                kind: next.kind,
                requiresAttachments: next.requiresAttachments,
                goalGeneration: next.goalGeneration,
              }
            : null,
        });
      } catch {
        /* Invalid or concurrently owned sessions are never scheduled. */
      }
    }
    return { sessions };
  }

  /**
   * The scheduler found a continue armed after a usage limit due (`usage-limit.ts`): the session
   * resumes and AgentKib's continue is queued. Sending it is then ordinary scheduled work,
   * authorized in the name of the device whose turn met the limit.
   */
  async #continueAfterLimit(id: string): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    if (!record || record.released) throw new Error("session-unavailable");
    this.#validate(record);
    const outcome = this.#hostState.continueAfterLimit(id, AUTO_CONTINUE_TEXT["claude-code"]);
    if (outcome === "continued" || outcome === "stale") this.#catalogChanged?.();
    return { accepted: outcome === "continued", outcome };
  }

  async #schedule(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof value.requestId !== "string" ||
      !uuidPattern.test(value.requestId) ||
      value.runtimeBootId !== this.bootId
    )
      throw new Error("invalid-schedule-request");
    const record = this.#load(id);
    if (!record || record.released) throw new Error("session-unavailable");
    this.#validate(record);
    if (!this.#ownerLocks.has(id)) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    if (value.operation === "schedule-pause") {
      this.invalidateSchedulePermits(id);
      const current = this.#hostState
        .read(id)
        .work.find((work) => work.status === "dispatched" && work.deviceId === value.deviceId);
      const running = this.#runners.get(id);
      if (
        current &&
        running &&
        running.snapshot().turnId === current.requestId &&
        running.snapshot().stopEnabled
      ) {
        try {
          await running.stop(current.requestId, running.snapshot().revision);
          this.#hostState.complete(id, current.requestId, {
            success: false,
            usage: null,
            cancelled: true,
          });
        } catch {
          this.#hostState.complete(id, current.requestId, {
            success: false,
            usage: null,
            unknown: true,
          });
        }
      }
      this.#hostState.pause(
        id,
        typeof value.reason === "string" ? value.reason.slice(0, 256) : "authorization-ended",
      );
      return {
        accepted: true,
        completed: true,
        sessionId: id,
        requestId: value.requestId,
        runtimeBootId: this.bootId,
      };
    }
    if (value.operation === "schedule-resume")
      return this.#hostControl(
        { ...value, operation: "queue-resume", experimentalEnabled: true },
        id,
      );
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
    const live = await this.#live(id, true);
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== live.revision)
      throw new Error("stale-Claude-revision");
    if (value.operation === "schedule-dispatch") {
      const permit = this.#permits.get(value.permitId);
      if (
        !permit ||
        permit.sessionId !== id ||
        permit.item.id !== value.itemId ||
        permit.item.requestId !== value.requestId ||
        permit.item.deviceId !== value.deviceId ||
        permit.expiresAt < Date.now() ||
        permit.revision !== value.expectedRevision
      )
        throw new Error("schedule-permit-unavailable");
      try {
        return await this.#control(
          {
            operation: "send",
            sessionId: id,
            requestId: value.requestId,
            deviceId: value.deviceId,
            runtimeBootId: this.bootId,
            expectedRevision: value.expectedRevision,
            experimentalEnabled: true,
            input: permit.item.input,
            schedulePermitId: value.permitId,
          },
          id,
        );
      } finally {
        this.#permits.delete(value.permitId);
        this.#hostState.releaseClaim(id, permit.item.id);
      }
    }
    if (live.status !== "idle" || live.activity === "compacting") throw new Error("session-busy");
    const prepareEpoch = this.#scheduleGeneration(id, value.deviceId);
    const item = this.#hostState.claim(id, value.itemId, value.deviceId);
    if (item.requestId !== value.requestId) {
      this.#hostState.releaseClaim(id, item.id);
      throw new Error("stale-schedule-item");
    }
    try {
      let options: { mcpConfig?: Record<string, unknown> } = {};
      await this.#retireForSelectedSettings(id);
      if (item.kind === "goal") {
        const goal = this.#hostState.read(id).goal!;
        const old = this.#runners.get(id);
        if (old) {
          await old.shutdown();
          this.#runners.delete(id);
          this.#goalRunners.delete(id);
        }
        await this.#goalEndpoints.get(id)?.close();
        const endpoint = await createClaudeGoalReportEndpoint(
          {
            goalId: goal.id,
            goalGeneration: goal.generation,
            stepId: item.id,
            bootId: this.bootId,
          },
          (report) => this.#hostState.report(id, item.id, report),
        );
        this.#goalEndpoints.set(id, endpoint);
        options = { mcpConfig: endpoint.mcpConfig };
        item.input = goalStepInput(goal.objective, item.id);
      }
      await this.#prepareRunner(this.#load(id)!, options);
      const latest = await this.#live(id, true);
      if (
        prepareEpoch !== this.#scheduleGeneration(id, value.deviceId) ||
        this.#hostState.read(id).paused
      )
        throw new Error("schedule-paused");
      const permitId = randomUUID();
      const expiresAt = Date.now() + 15_000;
      this.#permits.set(permitId, {
        sessionId: id,
        item,
        expiresAt,
        revision: Number(latest.revision),
      });
      return {
        accepted: true,
        permitId,
        itemId: item.id,
        requestId: item.requestId,
        deviceId: item.deviceId,
        sessionId: id,
        runtimeBootId: this.bootId,
        expectedRevision: latest.revision,
        expiresAt,
      };
    } catch (error) {
      this.#hostState.releaseClaim(id, item.id);
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
      throw error;
    }
  }

  /**
   * The slash-command catalog the CLI reported: the worker's, else the last one a worker
   * confirmed, else empty. Reading never starts a worker.
   */
  #commandCatalog(id: string): ClaudeCommandEntry[] {
    const options = this.#runners.get(id)?.optionsSnapshot;
    if (options?.settingsAcknowledged) return options.commands;
    const confirmed = this.#hostState.peek(id)?.lastConfirmedOptions?.options.commands;
    if (confirmed) return confirmed;
    const version = this.#version?.value;
    if (!version) return [];
    try {
      const record = this.#load(id);
      if (record) this.#validate(record);
      const source = record ? null : this.sessions.verifiedClaudeReadSource(id);
      if (source?.directoryMissing) return [];
      const workspace = record?.workspace ?? source!.workspace;
      return this.#cachedNewSessionCatalog(workspace, version)?.commands ?? [];
    } catch {
      // An optional cached catalog never supplies identity or grants execution permission.
      return [];
    }
  }

  #resourceInput(record: ClaudeRecord, content: unknown, references: unknown): unknown {
    if (references === undefined || (Array.isArray(references) && references.length === 0))
      return content;
    if (!Array.isArray(references) || references.length > 32)
      throw new Error("invalid-resource-references");
    const pieces: string[] = [];
    for (const reference of references) {
      if (!isObject(reference) || !["file", "directory", "skill"].includes(reference.kind))
        throw new Error("unsupported-resource-reference");
      if (reference.kind === "skill") {
        const skill = this.#projectSkills(record.workspace, this.#commandCatalog(record.id)).find(
          (item) => item.id === reference.id,
        );
        if (!skill) throw new Error("resource-skill-unavailable");
        pieces.push(`Use the project skill /${skill.id} for this request.`);
        continue;
      }
      const relative = reference.relativePath ?? reference.id;
      if (
        typeof relative !== "string" ||
        !relative ||
        path.isAbsolute(relative) ||
        relative.includes("\\") ||
        relative.includes("\0") ||
        relative.split("/").includes("..")
      )
        throw new Error("invalid-resource-path");
      const target = path.join(record.workspace, relative);
      let current = record.workspace;
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        if (lstatSync(current).isSymbolicLink()) throw new Error("resource-outside-workspace");
      }
      const resolved = canonicalize(target);
      const inside = path.relative(record.workspace, resolved);
      if (
        inside === ".." ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside) ||
        lstatSync(target).isSymbolicLink()
      )
        throw new Error("resource-outside-workspace");
      const info = lstatSync(resolved);
      if (reference.kind === "file") {
        if (!info.isFile() || info.nlink !== 1 || info.size > 64 * 1024)
          throw new Error("resource-file-unavailable");
        const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
        let text: string;
        try {
          const before = fstatSync(fd);
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > 64 * 1024 ||
            before.dev !== info.dev ||
            before.ino !== info.ino
          )
            throw new Error("resource-file-changed");
          const bytes = Buffer.alloc(before.size + 1);
          const size = readSync(fd, bytes, 0, bytes.length, 0);
          const after = fstatSync(fd);
          if (
            size !== before.size ||
            after.nlink !== 1 ||
            after.mtimeMs !== before.mtimeMs ||
            after.size !== before.size ||
            canonicalize(target) !== resolved
          )
            throw new Error("resource-file-changed");
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
        } finally {
          closeSync(fd);
        }
        if (text.includes("\0")) throw new Error("resource-file-unavailable");
        pieces.push(`Referenced file ${relative}:\n${text}`);
      } else {
        if (!info.isDirectory()) throw new Error("resource-directory-unavailable");
        pieces.push(
          `Referenced directory ${relative}:\n${readdirSync(resolved).slice(0, 100).join("\n")}`,
        );
      }
    }
    const context = pieces.join("\n\n");
    if (typeof content === "string") return `${content}\n\n${context}`;
    if (Array.isArray(content)) return [...content, { type: "text", text: context }];
    return context;
  }

  async #resources(id: string): Promise<Record<string, unknown>> {
    const context = await this.context(id);
    const live = await this.#live(id, false);
    if (!this.#runners.get(id)?.hasWorker) {
      if (managedSessionHasUnknownCommands(this.dataDir, id))
        throw new Error("control-outcome-unconfirmed");
      if (!this.#inactiveDraftAvailable(id, live))
        throw new Error(typeof live.reason === "string" ? live.reason : "session-busy");
    }
    return {
      available: true,
      revision: live.revision,
      executionMode: "claude-managed",
      skills: this.#projectSkills(String(context.cwd), this.#commandCatalog(id)),
      plugins: [],
      apps: [],
      // The host enumerates files through ArtifactService, which owns remote path
      // grants, sensitive-path filtering, identity checks and revision-bound IDs.
      contextReferences: [],
    };
  }

  async #workspaceResources(workspaceId: string) {
    const version = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    if (!version || !supportsClaudeVersion(version, "2.1.286")) return { skills: [] };
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const catalog = await this.#readNewSessionCatalog(workspace, version);
    if (
      pathIdentity(canonicalize(this.store.workspacePath(workspaceId))) !== pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");
    return { skills: this.#projectSkills(workspace, catalog?.commands) };
  }

  #projectSkills(
    workspace: string,
    commands: readonly ClaudeCommandEntry[] = [],
  ): Array<{
    id: string;
    name: string;
    description?: string;
    available: true;
  }> {
    return commands.flatMap((command) => {
      if (!/^[A-Za-z0-9_-]+$/.test(command.name)) return [];
      const file = path.join(workspace, ".claude", "skills", command.name, "SKILL.md");
      try {
        const resolved = canonicalize(file);
        const relative = path.relative(workspace, resolved);
        if (
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          lstatSync(file).isSymbolicLink() ||
          !lstatSync(resolved).isFile()
        )
          return [];
        return [
          {
            id: command.name,
            name: command.name,
            description: command.description,
            available: true as const,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  async #create(value: Record<string, any>): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "workspaceId",
      "requestId",
      "deviceId",
      "name",
      "model",
      "effort",
      "permissionMode",
      "verifyStartupModel",
    ]);
    const requestId = value.requestId;
    const workspaceId = value.workspaceId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      (value.verifyStartupModel !== undefined && value.verifyStartupModel !== true) ||
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.name !== undefined &&
        (typeof value.name !== "string" || Buffer.byteLength(value.name) > 512))
    )
      throw new Error("invalid-managed-create");
    const installation = await this.#installationVersion();
    if (installation === null) throw new Error(this.#installationMissing());
    // Before the request is claimed or dispatched: nothing may be left half-recorded.
    this.#home();
    const selectedSettings = this.#settings(value);
    if (selectedSettings.permissionMode === "auto") throw new Error("unsupported-permission-mode");
    if (Object.keys(selectedSettings).length && !supportsClaudeVersion(installation, "2.1.286"))
      throw new Error("unsupported-Claude-version");
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const logical = { ...value };
    delete logical.runtimeBootId;
    const receipt = admitControlReceipt(this.dataDir, requestId, stableJson(logical));
    if (receipt.previous) return receipt.previous;

    if (value.verifyStartupModel && (selectedSettings.model || selectedSettings.effort)) {
      const catalog = await this.#readNewSessionCatalog(workspace, installation, true).catch(
        () => undefined,
      );
      const rejected = (reason: string) => ({
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        requestId,
        reason,
      });
      if (this.#shuttingDown || !catalog?.settingsAcknowledged || !catalog.models.length)
        return rejected("claude-startup-models-unavailable");
      try {
        if (
          pathIdentity(canonicalize(this.store.workspacePath(workspaceId))) !==
          pathIdentity(workspace)
        )
          return rejected("claude-startup-models-unavailable");
      } catch {
        return rejected("claude-startup-models-unavailable");
      }
      const chosen = selectedSettings.model ?? catalog.settings.model;
      const model = chosen ? claudeModelOption(catalog.models, chosen) : undefined;
      if (selectedSettings.model) {
        if (!model) return rejected("unsupported-model");
        selectedSettings.model = model.value;
      }
      if (
        selectedSettings.effort &&
        !model?.supportedEffortLevels?.includes(selectedSettings.effort)
      )
        return rejected("unsupported-effort");
    }

    const id = randomUUID();
    const nativeId = randomUUID();
    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      const evidence = {
        operation: "create",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = receipt.claim(id, value.deviceId, evidence);
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      receipt.dispatch();
      const now = new Date().toISOString();
      const name =
        typeof value.name === "string" && value.name.trim().length > 0 ? value.name : "Claude Code";
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: workspace,
        home: this.#home(),
        nativeId,
        title: Buffer.byteLength(name) <= 512 ? name : "Claude Code",
        createdAt: now,
        adopted: false,
        released: false,
        fresh: true,
        fingerprint: null,
        snapshot: {
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: true,
          stopEnabled: false,
          approvals: [],
          questions: [],
          streamText: "",
        },
        completedRequests: [],
      };
      this.#save(record);
      const explicitlyNamed = typeof value.name === "string" && value.name.trim().length > 0;
      if (Object.keys(selectedSettings).length || explicitlyNamed)
        this.#hostState.update(id, (host) => {
          host.settings = selectedSettings;
          // A user-chosen create name has the same precedence as a later explicit rename.
          if (explicitlyNamed) host.title = record.title;
        });
      const cliVersion = await this.#installationVersion();
      const permission = this.#permissionView(
        id,
        cliVersion,
        () => selectedSettings.permissionMode,
      );
      const live = {
        ...record.snapshot,
        revision: Number(record.snapshot.revision ?? 0) + this.#hostState.read(id).revision,
        sessionId: id,
        workspaceId,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        cliVersion,
        permissionMode: "cli-configured",
        ...(permission ? { permission } : {}),
      };
      const result = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId,
        sessionId: id,
        sourceSessionId: nativeId,
        runtimeBootId: this.bootId,
        live,
      };
      receipt.finish(result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
  }

  #compactingResult(id: string, requestId: string): Record<string, unknown> {
    return {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId,
      sessionId: id,
      runtimeBootId: this.bootId,
      error: "session-compacting",
      reason: "session-compacting",
    };
  }

  async terminalHandoverAvailability(
    id: string,
    live: Record<string, unknown>,
    source?: ClaudeTerminalHandoverSource,
    remote?: ClaudeTerminalExitSource,
  ): Promise<{ available: boolean; reason?: string; remoteAvailable?: true } | undefined> {
    if (!source || this.managedWorkspace(id)) return;
    const reason =
      source.reason ??
      (typeof live.ownershipReason === "string" ? live.ownershipReason : null) ??
      (typeof live.reason === "string" ? live.reason : null);
    if (reason) {
      if (remote && supportsClaudeManagedRunner()) {
        try {
          this.#terminalHandoverSettings(source);
          if (!this.#displayObservation || Date.now() - this.#displayObservation.at >= 3000)
            this.#displayObservation = { at: Date.now(), share: {} };
          if (
            (await this.#installationVersion()) &&
            (await this.#ownership.foregroundProcess(
              remote.target.nativeId,
              this.#displayObservation.share,
            ))
          )
            return { available: false, reason, remoteAvailable: true };
        } catch {
          // The remote entry requires positive foreground and settings evidence.
        }
      }
      return { available: false, reason };
    }
    try {
      this.#terminalHandoverSettings(source);
      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "claude-terminal-handover-unavailable",
      };
    }
  }

  #terminalHandoverSettings({
    target,
    bindingId,
    model: observedModel,
  }: ClaudeTerminalHandoverSource) {
    this.validateNativeBridgeTarget(target, false, bindingId);
    const historyWorkspace = this.sessions.claudeControlWorkspace(
      target.nativeId,
      target.registeredWorkspace,
    );
    // A migrated worktree sometimes still has its history under the opening cwd.
    // Resume there would silently change the session's working directory.
    if (historyWorkspace !== target.workspace)
      throw new Error("claude-terminal-handover-workspace-unavailable");
    const transcript = this.sessions.verifiedClaudeControlTarget(target.nativeId, target.workspace);
    const { permissionMode } = readClaudeTranscriptObservation(
      transcript,
      target.nativeId,
      "terminal-usage",
    );
    const model = observedModel ?? readClaudeTranscriptModel(transcript, target.nativeId);
    if (!model) throw new Error("claude-terminal-handover-model-unconfirmed");
    if (!isClaudePermissionMode(permissionMode))
      throw new Error("claude-terminal-handover-permission-unconfirmed");
    return { model, permissionMode };
  }

  async autoAdoptTerminalLead(
    id: string,
    bridge: TerminalHandoverBridge,
    reportOwner: (id: string) => string | undefined,
    canAdopt: () => boolean,
  ): Promise<boolean> {
    if (this.#shuttingDown || !canAdopt()) return false;
    const record = this.#load(id);
    if (record && !record.released) return false;
    const source = bridge.terminalHandoverSource(id);
    if (!source || source.reason !== null) return false;
    // A manual release is not a terminal exit. Require a new bridge connection first.
    if (
      record?.released &&
      (!source.lastLeaseId || source.lastLeaseId === record.terminalHandoverLeaseId)
    )
      return false;
    const live = await this.request({
      operation: "live",
      sessionId: id,
      experimentalEnabled: true,
    });
    if (!isObject(live) || live.sendEnabled !== true || !canAdopt()) return false;
    const result = await this.adoptTerminal(
      {
        operation: "adopt-terminal",
        sessionId: id,
        requestId: randomUUID(),
        deviceId: "agentkib-local-owner",
        runtimeBootId: this.bootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
      },
      bridge,
      reportOwner,
      { canAdopt, bindingId: source.bindingId },
    );
    return isObject(result) && result.accepted === true;
  }

  adoptTerminal(
    value: Record<string, unknown>,
    bridge: TerminalHandoverBridge,
    reportOwner: (id: string) => string | undefined,
    automatic?: { canAdopt: () => boolean; bindingId: string },
  ) {
    return this.#sessionOperation(async ({ value, id }) => {
      const { requestId, deviceId, runtimeBootId, expectedRevision, turnId, publicInputHash } =
        value;
      const remote = value.operation === "handover-terminal";
      if (
        typeof requestId !== "string" ||
        !uuidPattern.test(requestId) ||
        !validClaudeDeviceId(deviceId) ||
        (remote
          ? value.confirmed !== true ||
            (turnId !== undefined && (typeof turnId !== "string" || !uuidPattern.test(turnId)))
          : !CLAUDE_OWNER_DEVICES.has(deviceId)) ||
        value.experimentalEnabled !== true ||
        typeof runtimeBootId !== "string" ||
        !Number.isSafeInteger(expectedRevision) ||
        Number(expectedRevision) < 0 ||
        (publicInputHash !== undefined &&
          (typeof publicInputHash !== "string" || !/^[0-9a-f]{64}$/.test(publicInputHash))) ||
        Object.keys(value).some(
          (key) =>
            ![
              "operation",
              "sessionId",
              "requestId",
              "deviceId",
              "runtimeBootId",
              "expectedRevision",
              "experimentalEnabled",
              "publicInputHash",
              ...(remote ? ["confirmed", "turnId"] : []),
            ].includes(key),
        )
      )
        throw new Error("invalid-claude-terminal-handover");
      const receipt = admitControlReceipt(
        this.dataDir,
        requestId,
        claudeCommandFingerprintInput(value),
      );
      if (receipt.previous) return receipt.previous;
      if (runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
      this.#privateDirectory(true);
      const owned = this.#ownerLocks.has(id);
      const release = owned ? null : this.#tryLock(id);
      if (!owned && !release) throw new Error("session-managed-by-another-runtime");
      if (release) this.#ownerLocks.set(id, release);
      const result = (
        controlOutcome: "accepted" | "not-dispatched" | "unknown",
        reason?: string,
      ) => ({
        accepted: controlOutcome === "accepted",
        completed: controlOutcome === "accepted",
        controlOutcome,
        sessionId: id,
        requestId,
        runtimeBootId,
        ...(reason ? { reason } : {}),
      });
      let externalEffect = false;
      try {
        const source = bridge.terminalHandoverSource(id);
        if (!source) throw new Error("claude-terminal-handover-unavailable");
        if (automatic && (source.bindingId !== automatic.bindingId || !automatic.canAdopt()))
          return result("not-dispatched", "report-authorization-changed");
        const modelAtAdmission = source.model;
        if (source.reason && !remote) throw new Error(source.reason);
        if (this.managedWorkspace(id)) throw new Error("session-already-managed");
        if (!supportsClaudeManagedRunner() || !(await this.#installationVersion()))
          throw new Error("claude-terminal-handover-unavailable");
        const evidence = {
          operation: value.operation,
          workspaceId: source.target.workspaceId,
          runtimeBootId,
          expectedRevision,
          turnId: turnId ?? null,
          inputFingerprint: null,
          executionMode: remote ? "claude-follower" : "claude-managed",
          ...(publicInputHash ? { publicInputHash } : {}),
        };
        let continueId: string | undefined;
        let autoModelAtAdmission: string | undefined;
        let localRevision = Number(expectedRevision);
        if (remote) {
          const terminal = bridge.remoteTerminalExitSource(id);
          if (
            !terminal ||
            terminal.bindingId !== source.bindingId ||
            terminal.revision !== expectedRevision ||
            terminal.turnId !== (turnId ?? null)
          )
            throw new Error("stale-Claude-revision");
          const settings = this.#terminalHandoverSettings(source);
          if (settings.permissionMode === "auto") autoModelAtAdmission = settings.model;
          const autoReady =
            autoModelAtAdmission === undefined ||
            (await this.#autoPermissionAvailable(
              source.target.workspace,
              autoModelAtAdmission,
              true,
            ));
          const process = await this.#ownership.foregroundProcess(terminal.target.nativeId);
          if (!process) throw new Error("claude-terminal-foreground-unconfirmed");
          const current = bridge.remoteTerminalExitSource(id);
          if (
            !current ||
            current.bindingId !== terminal.bindingId ||
            current.leaseId !== terminal.leaseId ||
            current.revision !== terminal.revision
          )
            throw new Error("stale-Claude-revision");
          const commandId = randomUUID();
          continueId = randomUUID();
          const replay = receipt.claim(id, deviceId, {
            ...evidence,
            bindingId: terminal.bindingId,
            nativeId: terminal.target.nativeId,
            commandId,
            continuationRequestId: continueId,
          });
          if (replay) return replay;
          if (!autoReady) {
            const refused = result(
              "not-dispatched",
              "claude-terminal-handover-permission-unconfirmed",
            );
            receipt.finish(refused);
            return refused;
          }
          const exit = await bridge.requestTerminalExit(
            current,
            requestId,
            deviceId,
            commandId,
            () => {
              receipt.dispatch();
              externalEffect = true;
            },
          );
          if (!externalEffect || exit.controlOutcome === "not-dispatched") {
            const refused = result("not-dispatched", "claude-terminal-exit-refused");
            receipt.finish(refused);
            return refused;
          }
          const deadline = Date.now() + 8000;
          while (!(await this.#ownership.foregroundProcessExited(process))) {
            if (Date.now() >= deadline)
              return result("unknown", "claude-terminal-exit-unconfirmed");
            await sleep(150);
          }
          await this.#ensureNoExternalOwner(source.target.nativeId);
          bridge.confirmRemoteTerminalExit(terminal);
          const released = this.#load(id);
          localRevision =
            Number(released?.snapshot.revision ?? 0) + this.#hostState.read(id).revision;
        } else {
          this.#forgetOwnership(id);
          const previous = await this.#live(id, true);
          if (previous.revision !== expectedRevision) throw new Error("stale-Claude-revision");
          if (previous.sendEnabled !== true)
            throw new Error(String(previous.reason ?? "session-busy"));
        }
        // Check the native owner again under the same managed lock used by sends.
        await this.#ensureNoExternalOwner(source.target.nativeId);
        const current = bridge.terminalHandoverSource(id, remote ? requestId : undefined);
        if (!current || current.bindingId !== source.bindingId)
          throw new Error("unverified-session-identity");
        if (current.reason) throw new Error(current.reason);
        const target = {
          ...current.target,
          fingerprint: this.#transcriptProofs.resume(
            current.target.nativeId,
            current.target.workspace,
          ).fingerprint,
        };
        this.#assertNativeAliasesConfirmed(id, target.nativeId, target.workspace);
        const existing = this.#load(id);
        const record = this.#adoptedRecord(
          id,
          existing,
          target,
          Math.max(localRevision, current.revision) - this.#hostState.read(id).revision,
        );
        const handoverSource = { ...current, model: current.model ?? modelAtAdmission };
        let settings;
        try {
          settings = this.#terminalHandoverSettings(handoverSource);
        } catch (error) {
          if (autoModelAtAdmission === undefined) throw error;
        }
        if (
          !settings ||
          (remote &&
            (autoModelAtAdmission !== undefined || settings.permissionMode === "auto") &&
            (settings.permissionMode !== "auto" ||
              settings.model !== autoModelAtAdmission ||
              target.workspace !== source.target.workspace ||
              target.nativeId !== source.target.nativeId))
        ) {
          const refused = result(
            "not-dispatched",
            "claude-terminal-handover-permission-unconfirmed",
          );
          receipt.finish(refused);
          return refused;
        }
        const adoption = this.#prepareTerminalAdoption(
          record,
          handoverSource,
          reportOwner,
          settings,
        );
        if (!remote) {
          if (automatic) {
            // Ownership checks awaited subprocesses. The lead can be paused or removed meanwhile.
            if (this.#shuttingDown || !automatic.canAdopt())
              return result("not-dispatched", "report-authorization-changed");
            if (
              existing?.released &&
              (!current.lastLeaseId || current.lastLeaseId === existing.terminalHandoverLeaseId)
            )
              return result("not-dispatched", "claude-terminal-handover-unavailable");
            record.terminalAutoAdoptedAt = new Date().toISOString();
          }
          const replay = receipt.claim(id, deviceId, evidence);
          if (replay) return replay;
          receipt.dispatch();
          externalEffect = true;
        }
        adoption(
          continueId ? { id: continueId, deviceId, text: TERMINAL_CONTINUE_TEXT } : undefined,
        );
        bridge.finishTerminalHandover(current);
        const accepted = result("accepted");
        receipt.finish(accepted);
        this.#catalogChanged?.();
        if (automatic && this.continuation.isSessionObserved?.(id)) {
          try {
            const live = await this.#live(id, true);
            this.#publishConversationEvent?.(id, "state", live, live);
          } catch {
            // The activity is already durable and will appear on the next successful live read.
          }
        }
        return accepted;
      } catch (error) {
        if (externalEffect) return result("unknown", "control-outcome-unconfirmed");
        throw error;
      } finally {
        if (release) {
          this.#ownerLocks.delete(id);
          release();
        }
      }
    })(value);
  }

  #prepareTerminalAdoption(
    record: ClaudeRecord,
    source: ClaudeTerminalHandoverSource,
    reportOwner: (id: string) => string | undefined,
    settings: ClaudeSettings = this.#terminalHandoverSettings(source),
  ) {
    const id = record.id;
    const reportDeviceId = reportOwner(id);
    if (source.reports.length && !validClaudeDeviceId(reportDeviceId))
      throw new Error("claude-terminal-report-owner-unavailable");
    return (continuation?: { id: string; deviceId: string; text: string }) => {
      record.terminalHandover = true;
      if (source.lastLeaseId) record.terminalHandoverLeaseId = source.lastLeaseId;
      this.#hostState.importTerminalHandover(
        id,
        settings,
        source.reports,
        reportDeviceId,
        continuation,
      );
      this.#save(record);
    };
  }

  /** Establish the verified execution identity as part of this message's preparation. */
  async #sessionForSend(
    id: string,
    expectedRevision: number,
    handover?: ClaudeContinuationOptions["terminalHandover"],
  ): Promise<{ record: ClaudeRecord; terminalAdoption?: StagedTerminalAdoption }> {
    const previous = await this.#live(id, true);
    if (previous.activity === "compacting") throw new Error("session-compacting");
    if (previous.status === "outcome-unknown" || managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    if (previous.revision !== expectedRevision) throw new Error("stale-Claude-revision");
    if (previous.sendEnabled !== true)
      throw new Error(
        typeof previous.ownershipReason === "string" ? previous.ownershipReason : "session-busy",
      );
    if ((await this.#installationVersion()) === null) throw new Error(this.#installationMissing());
    this.#privateDirectory(true);
    const owned = this.#ownerLocks.has(id);
    if (!owned) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    try {
      const existing = this.#load(id);
      if (existing && !existing.released) throw new Error("stale-Claude-revision");
      if (existing) this.#validate(existing);
      const target = existing?.fresh ? existing : this.#nativeTarget(id);
      const before = existing?.fresh
        ? null
        : this.#transcriptProofs.resume(target.nativeId, target.workspace);
      await this.#ensureNoExternalOwner(target.nativeId);
      if (
        before &&
        before.version !== this.#transcriptProofs.resume(target.nativeId, target.workspace).version
      )
        throw new Error("claude-session-fingerprint-changed");
      this.#assertNativeAliasesConfirmed(id, target.nativeId, target.workspace);
      const source = handover?.source(id);
      if (
        source &&
        (source.target.nativeId !== target.nativeId || source.target.workspace !== target.workspace)
      )
        throw new Error("claude-terminal-handover-unavailable");
      if (source?.reason) throw new Error(source.reason);
      const record = this.#adoptedRecord(
        id,
        existing,
        { ...target, fingerprint: before?.fingerprint ?? existing?.fingerprint ?? null },
        expectedRevision - this.#hostState.read(id).revision,
      );
      // Keep the binding and its reports intact until this send passes admission.
      if (source && handover)
        return { record, terminalAdoption: { bridge: handover, bindingId: source.bindingId } };
      this.#save(record);
      return { record };
    } catch (error) {
      if (!owned && !this.#runners.has(id)) {
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }
      throw error;
    }
  }

  async #prepareTerminalSend(record: ClaudeRecord, { bridge, bindingId }: StagedTerminalAdoption) {
    await this.#ensureNoExternalOwner(record.nativeId);
    const source = bridge.source(record.id);
    if (
      !source ||
      source.bindingId !== bindingId ||
      source.target.nativeId !== record.nativeId ||
      source.target.workspace !== record.workspace
    )
      throw new Error("claude-terminal-handover-unavailable");
    if (source.reason) throw new Error(source.reason);
    const adopt = this.#prepareTerminalAdoption(record, source, bridge.reportOwner);
    return () => {
      adopt();
      bridge.finish(source);
      this.#catalogChanged?.();
    };
  }

  #adoptedRecord(
    id: string,
    existing: ClaudeRecord | null,
    target: Pick<ClaudeRecord, "workspaceId" | "workspace" | "nativeId" | "fingerprint">,
    revision: number,
  ): ClaudeRecord {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("stale-Claude-revision");
    const namedCreate = existing && !existing.adopted && existing.title !== "Claude Code";
    return {
      version: 1,
      id,
      workspaceId: target.workspaceId,
      workspace: target.workspace,
      nativeId: target.nativeId,
      fingerprint: target.fingerprint,
      registeredWorkspace: canonicalize(this.store.workspacePath(target.workspaceId)),
      home: this.#home(),
      title:
        existing && (existing.forkSourceNativeId || namedCreate)
          ? existing.title
          : (this.#nativeMetadata(target.nativeId, target.workspace)?.title ??
            existing?.title ??
            "Claude Code"),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      adopted: existing?.adopted ?? true,
      released: false,
      fresh: existing?.fresh ?? false,
      ...(existing?.terminalHandover ? { terminalHandover: true } : {}),
      ...(existing?.terminalHandoverLeaseId
        ? { terminalHandoverLeaseId: existing.terminalHandoverLeaseId }
        : {}),
      ...(existing?.terminalAutoAdoptedAt
        ? { terminalAutoAdoptedAt: existing.terminalAutoAdoptedAt }
        : {}),
      ...(existing?.forkSourceNativeId
        ? { forkSourceNativeId: existing.forkSourceNativeId, forkCutoff: existing.forkCutoff }
        : {}),
      completedRequests: existing?.completedRequests ?? [],
      snapshot: {
        ...existing?.snapshot,
        status: "idle",
        revision,
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
      },
    };
  }

  async #release(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      typeof value.runtimeBootId !== "string" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-release");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const receipt = admitControlReceipt(this.dataDir, requestId, stableJson(logical));
    if (receipt.previous) return receipt.previous;

    this.#privateDirectory(false);
    const ownerRelease = this.#ownerLocks.get(id);
    const releaseLock = ownerRelease ? null : this.#tryLock(id);
    if (!ownerRelease && !releaseLock) throw new Error("session-managed-by-another-runtime");
    let releasedOwned = false;
    try {
      const record = this.#load(id);
      if (!record) throw new Error("session-unavailable");
      this.#validate(record);
      if (record.released) throw new Error("session-released");
      const live = await this.#live(id, true);
      if (value.runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
      if (managedSessionHasUnknownCommands(this.dataDir, id) || live.status === "outcome-unknown")
        throw new Error("control-outcome-unconfirmed");
      if (live.activity === "compacting") return this.#compactingResult(id, requestId);
      if (Number(value.expectedRevision) !== live.revision)
        throw new Error("stale-Claude-revision");
      if (live.status !== "idle") throw new Error("session-busy");
      const evidence = {
        operation: "release",
        workspaceId: record.workspaceId,
        runtimeBootId: this.bootId,
        expectedRevision: value.expectedRevision,
        turnId: null,
        inputFingerprint: null,
        executionMode: "claude-managed",
      };
      const claimed = receipt.claim(id, value.deviceId, evidence);
      if (claimed) return claimed;
      receipt.dispatch();
      const runner = this.#runners.get(id);
      if (runner) {
        await runner.shutdown();
        this.#runners.delete(id);
      }
      this.invalidateSchedulePermits(id);
      this.#hostState.pause(id, "released");
      record.released = true;
      this.#save(record);
      releasedOwned = true;
      const result = {
        accepted: true,
        completed: true,
        requestId,
        sessionId: id,
        runtimeBootId: this.bootId,
        controlOutcome: "accepted",
      };
      receipt.finish(result);
      await this.#publishReleasedPermission(id);
      return result;
    } finally {
      if (releaseLock) releaseLock();
      if (ownerRelease && releasedOwned) {
        this.#ownerLocks.delete(id);
        ownerRelease();
      }
    }
  }

  /**
   * Permanently deletes a Claude Code session: its transcript, its folder and the per-session
   * files Claude Desktop's own delete removes, then AgentKib's records of it. Refused while a
   * Claude Code process or the terminal bridge has the session, or a Claude Desktop record
   * names it (deleting the transcript would break Desktop's session).
   */
  async #delete(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
      "publicInputHash",
    ]);
    const requestId = value.requestId;
    if (
      !sessionIdPattern.test(id) ||
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      value.experimentalEnabled !== true ||
      !Number.isSafeInteger(value.expectedRevision) ||
      Number(value.expectedRevision) < 0 ||
      (value.publicInputHash !== undefined &&
        (typeof value.publicInputHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.publicInputHash))) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-control");
    const receipt = admitControlReceipt(
      this.dataDir,
      requestId,
      claudeCommandFingerprintInput(value),
    );
    if (receipt.previous) return receipt.previous;
    if (value.runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
    let workspaceId: string | null = null;
    const outcome = (fields: Record<string, unknown>, request = requestId) => ({
      ...fields,
      requestId: request,
      sessionId: id,
      runtimeBootId: this.bootId,
    });
    const claim = () =>
      receipt.claim(id, value.deviceId, {
        operation: "delete",
        workspaceId,
        executionMode: "claude-managed",
        runtimeBootId: this.bootId,
        expectedRevision: value.expectedRevision,
        turnId: null,
        ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
      });
    // Refusals keep a receipt as well, so a lost answer replays instead of looking unknown.
    const reject = (reason: string) => {
      const result = outcome({
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        error: reason,
        reason,
      });
      const claimed = claim();
      if (claimed) return claimed;
      receipt.finish(result);
      return result;
    };
    if (!supportsClaudeManagedRunner()) return reject("platform-unsupported");
    this.#privateDirectory(true);
    const held = this.#ownerLocks.get(id);
    const lock = held ? null : this.#tryLock(id);
    if (!held && !lock) return reject("session-managed-by-another-runtime");
    let deleted = false;
    try {
      const record = this.#load(id);
      let nativeId: string;
      let workspace: string;
      try {
        if (record) {
          this.#validate(record);
          ({ nativeId, workspace, workspaceId } = record);
        } else ({ nativeId, workspace, workspaceId } = this.#resolveNative(id));
      } catch (error) {
        return reject(error instanceof Error ? error.message : "session-unavailable");
      }
      const home = this.#home();
      // Only an earlier delete may still be unconfirmed: retrying it is how that outcome resolves.
      const unconfirmed = readUnknownManagedCommands(this.dataDir, id);
      if (unconfirmed.some((command) => command.evidence?.operation !== "delete"))
        return reject("control-outcome-unconfirmed");
      if ((await this.#installationVersion()) === null) return reject(this.#installationMissing());
      const live = await this.#live(id, true);
      if (live.revision !== value.expectedRevision) return reject("stale-Claude-revision");
      const runner = this.#runners.get(id);
      if (
        this.#starting.has(id) ||
        (runner && (live.status !== "idle" || live.activity === "compacting"))
      )
        return reject("session-busy");
      try {
        await this.#ensureNoExternalOwner(nativeId, runner?.processId ?? null);
      } catch (error) {
        return reject(error instanceof Error ? error.message : "claude-owner-check-unavailable");
      }
      const target = record ?? ({ id, nativeId, home, workspace } as ClaudeRecord);
      if (this.#isSessionBridged(target)) return reject("session-already-bridged");
      let claims: Set<string>;
      try {
        claims = claudeDesktopClaims(claudeDesktopSessionRecords(this.environment));
      } catch {
        return reject("claude-desktop-check-unavailable");
      }
      if (claims.has(nativeId.toLowerCase())) return reject("claude-desktop-session");
      let transcript: string | null;
      try {
        transcript = this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
      } catch (error) {
        // A session AgentKib created that Claude Code never wrote has no transcript yet; an
        // earlier unconfirmed delete may have removed it already.
        if (!record?.fresh && unconfirmed.length === 0)
          return reject(error instanceof Error ? error.message : "session-unavailable");
        transcript = null;
      }
      const claimed = claim();
      if (claimed) return claimed;
      receipt.dispatch();
      // AgentKib's own worker and its scheduled work end first; nothing writes the session after.
      this.invalidateSchedulePermits(id);
      if (record) this.#hostState.pause(id, "delete-requested");
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
      if (runner) {
        await runner.shutdown();
        this.#runners.delete(id);
        this.#goalRunners.delete(id);
      }
      let removal: ReturnType<typeof removeClaudeSessionFiles>;
      try {
        removal = removeClaudeSessionFiles(home, transcript, nativeId);
      } catch {
        removal = { transcriptGone: false, leftBehind: [] };
      }
      if (!removal.transcriptGone) {
        const result = outcome({
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          error: "claude-delete-failed",
          reason: "claude-delete-failed",
        });
        receipt.finish(result);
        return result;
      }
      deleted = true;
      this.#forgetDeletedSession(id, nativeId, home);
      const result = outcome({
        accepted: true,
        completed: true,
        deleted: true,
        controlOutcome: "accepted",
      });
      receipt.finish(result);
      for (const earlier of unconfirmed)
        finishManagedCommand(
          this.dataDir,
          earlier.requestId,
          outcome({ accepted: true, completed: true, deleted: true }, earlier.requestId),
        );
      return result;
    } finally {
      if (deleted) {
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }
      lock?.();
      if (deleted)
        try {
          unlinkSync(this.#path(id).replace(/\.json$/, ".lock"));
        } catch {
          // A lock file left behind names no session and is reused by none.
        }
    }
  }

  /** Every AgentKib copy of a deleted session: its records, aliases, host state and index rows. */
  #forgetDeletedSession(id: string, nativeId: string, home: string): void {
    const ids = new Set([id]);
    for (const alias of this.#listRecords())
      if (alias.nativeId.toLowerCase() === nativeId.toLowerCase() && alias.home === home)
        ids.add(alias.id);
    for (const sessionId of ids) {
      try {
        unlinkSync(this.#path(sessionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.#hostState.forget(sessionId);
      this.#forgetOwnership(sessionId);
      this.#catalogUnconfirmed.delete(sessionId);
      this.#idleSince.delete(sessionId);
      this.#observed.delete(sessionId);
      this.#continuationNotices.delete(sessionId);
      this.#continuationNoticeIds.delete(sessionId);
      this.#lastPermission.delete(sessionId);
      this.#turnMetaRevisions.delete(sessionId);
    }
    this.#turnMeta.forget(nativeId);
    const indexed = [...ids, this.store.sessions.id("claude-code", nativeId)];
    if (this.#forgetIndexed) this.#forgetIndexed(indexed);
    else this.store.sessions.forget(indexed);
    this.#catalogChanged?.();
  }

  #freshFingerprint(record: ClaudeRecord): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          record.id,
          record.nativeId,
          record.workspace,
          record.home,
          record.fresh,
          record.released,
          ...(record.forkSourceNativeId ? [record.forkSourceNativeId, record.forkCutoff] : []),
        ]),
      )
      .digest("hex");
  }

  #targetFingerprint(nativeId: string, workspace: string): string {
    return this.#transcriptProofs.read(nativeId, workspace).fingerprint;
  }

  async #ensureNoExternalOwner(
    nativeId: string,
    ownedPid: number | null = null,
    probe = this.#ownership,
  ): Promise<void> {
    const owner = await probe.check(nativeId, ownedPid, this.#freshObservation());
    if (owner.kind !== "idle")
      throw new Error(
        owner.kind === "background" ? "claude-background-session-running" : "claude-owner-busy",
      );
  }

  #assertNativeAliasesConfirmed(id: string, nativeId: string, workspace: string): void {
    const home = this.#home();
    for (const alias of this.#listRecords()) {
      if (
        alias.id === id ||
        alias.nativeId !== nativeId ||
        alias.workspace !== workspace ||
        alias.home !== home
      )
        continue;
      const held = this.#ownerLocks.has(alias.id);
      const release = held ? null : this.#tryLock(alias.id);
      if (!release && !held) throw new Error("session-managed-by-another-runtime");
      try {
        const current = this.#recoverStartupCleanup(alias, true);
        if (
          current.nativeId !== nativeId ||
          current.workspace !== workspace ||
          current.home !== home
        )
          continue;
        if (
          current.snapshot.status !== "idle" ||
          managedSessionHasUnknownCommands(this.dataDir, current.id)
        )
          throw new Error("control-outcome-unconfirmed");
      } finally {
        release?.();
      }
    }
  }

  #refreshIdleHistory(record: ClaudeRecord, persist = true): void {
    this.#validate(record);
    if (record.fresh) return;
    const target = this.#nativeTarget(record.id);
    if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
      throw new Error("unverified-session-identity");
    const { fingerprint } = this.#transcriptProofs.resume(record.nativeId, record.workspace);
    if (fingerprint === null) return;
    record.fingerprint = fingerprint;
    if (persist) this.#save(record);
  }

  async #ownershipReason(
    id: string,
    nativeId: string,
    ownedPid: number | null,
  ): Promise<string | null> {
    const interval = this.continuation.maintenanceIntervalMs ?? 3000;
    const cached = this.#ownershipReasons.get(id);
    if (cached && Date.now() - cached.at < interval) return cached.reason;
    if (!this.#displayObservation || Date.now() - this.#displayObservation.at >= interval)
      this.#displayObservation = { at: Date.now(), share: {} };
    // Dated by the shared observation, so no status is older than one interval.
    const observedAt = this.#displayObservation.at;
    let reason: string | null;
    try {
      const owner = await this.#ownership.check(nativeId, ownedPid, this.#displayObservation.share);
      reason =
        owner.kind === "idle"
          ? null
          : owner.kind === "background"
            ? "claude-background-session-running"
            : "claude-owner-busy";
    } catch {
      reason = "claude-owner-check-unavailable";
    }
    this.#ownershipReasons.set(id, { at: observedAt, reason });
    if (cached?.reason !== reason) this.#catalogChanged?.();
    return reason;
  }

  async #beforeRunnerStart(id: string): Promise<void> {
    if (this.#shuttingDown) throw new Error("session-unavailable");
    const record = this.#load(id);
    if (!record || record.released) throw new Error("session-unavailable");
    this.#validate(record);
    if (
      readUnknownManagedCommands(this.dataDir, id).some(
        (command) => command.requestId !== this.#activeHostClaims.get(id),
      )
    )
      throw new Error("control-outcome-unconfirmed");
    if (this.#isSessionBridged(record)) throw new Error("session-already-bridged");
    const runner = this.#runners.get(id);
    this.#starting.add(id);
    const starting = runner ? this.#streamLive(id, runner.snapshot(), record) : null;
    if (starting) this.#publishConversationEvent?.(id, "state", starting, starting);
    if ((await this.#installationVersion()) === null) throw new Error(this.#installationMissing());
    await this.#ensureNoExternalOwner(record.nativeId);
    if (this.#shuttingDown || this.#runners.get(id) !== runner)
      throw new Error("session-unavailable");
    const current = this.#load(id);
    if (!current || current.released || current.nativeId !== record.nativeId)
      throw new Error("session-unavailable");
    if (this.#isSessionBridged(record)) throw new Error("session-already-bridged");
    this.#refreshIdleHistory(record);
    // Recheck ownership after resolving the transcript, before spawning.
    await this.#ensureNoExternalOwner(record.nativeId);
    if (this.#shuttingDown || this.#runners.get(id) !== runner)
      throw new Error("session-unavailable");
    if (this.#isSessionBridged(record)) throw new Error("session-already-bridged");
    this.#assertNativeAliasesConfirmed(id, record.nativeId, record.workspace);
    this.#ownershipReasons.set(id, { at: Date.now(), reason: null });
    this.#continuationNotices.delete(id);
    this.#continuationNoticeIds.delete(id);
    this.#idleSince.delete(id);
    if (this.continuation.isSessionObserved?.(id)) this.#observed.add(id);
  }

  #isSessionBridged(record: ClaudeRecord): boolean {
    if (!this.continuation.isSessionBridged) return false;
    const aliases = new Set([
      record.id,
      this.store.sessions.id("claude-code", record.nativeId),
      ...this.#listRecords()
        .filter(
          (other) =>
            other.nativeId === record.nativeId &&
            other.home === record.home &&
            other.workspace === record.workspace,
        )
        .map((other) => other.id),
    ]);
    return [...aliases].some((id) => this.continuation.isSessionBridged!(id));
  }

  /** Called synchronously when a session subscription is installed. */
  observeSession(id: string): void {
    if (this.#runners.has(id) || this.#sessionQueues.has(id) || this.#starting.has(id))
      this.#observed.add(id);
  }

  *runningSessionIds(): Iterable<string> {
    for (const [id, runner] of this.#runners)
      if (runner.hasWorker && !runner.isRetiring && runner.state.status === "running") yield id;
  }

  async #stopForExternalOwner(id: string, runner: ClaudeManagedRunnerProcess): Promise<void> {
    const snapshot = runner.snapshot();
    try {
      await runner.shutdown();
    } catch {
      this.#ownershipReasons.set(id, {
        at: Date.now(),
        reason: "control-outcome-unconfirmed",
      });
      throw new Error("control-outcome-unconfirmed");
    }
    if (runner.hasWorker) throw new Error("control-outcome-unconfirmed");
    this.#goalRunners.delete(id);
    await this.#goalEndpoints.get(id)?.close();
    this.#goalEndpoints.delete(id);
    if (snapshot.turnId)
      this.#hostState.complete(id, snapshot.turnId, {
        success: false,
        usage: null,
        cancelled: true,
      });
    this.#hostState.pause(id, "owner-opened-elsewhere");
    this.invalidateSchedulePermits(id);
    const current = this.#load(id);
    if (!current) return;
    current.snapshot = {
      ...snapshot,
      status: "idle",
      turnId: null,
      sendEnabled: true,
      stopEnabled: false,
      approvals: [],
      questions: [],
      activity: null,
      reason: null,
    };
    this.#save(current);
    this.#ownershipReasons.set(id, { at: Date.now(), reason: "owner-opened-elsewhere" });
    this.#continuationNotices.set(id, "owner-opened-elsewhere");
    this.#runners.delete(id);
    const live = await this.#live(id, false);
    this.#publishConversationEvent?.(id, "state", live, live);
  }

  async #maintain(): Promise<void> {
    const external = this.continuation.isCatalogObserved?.()
      ? this.refreshExternalTurns()
      : undefined;
    // One read-only observation per tick serves every live worker, so the patrol cost does not
    // grow with the number of sessions. Each worker is still evaluated with its own process.
    const share = this.#freshObservation();
    const runners = [...this.#runners];
    const workers = new Map(runners.map(([id, runner]) => [id, runner.processId] as const));
    await Promise.allSettled([
      external,
      ...runners.map(async ([id, runner]) => {
        if (this.#shuttingDown || runner.isRetiring) return;
        await this.#serializeSession(id, async () => {
          if (this.#shuttingDown || this.#runners.get(id) !== runner || !runner.hasWorker) return;
          const record = this.#load(id);
          if (!record || record.released) return;
          const observed = this.continuation.isSessionObserved?.(id) === true;
          if (observed) this.#observed.add(id);
          // A worker started during this tick waits for the next one: the shared observation
          // may predate it and still show its predecessor writing the same session.
          if (runner.processId !== workers.get(id)) return;
          let owner;
          try {
            owner = await this.#ownership.check(record.nativeId, runner.processId, share);
          } catch {
            // An unreadable ownership source is never treated as evidence of freedom.
            this.#ownershipReasons.set(id, {
              at: Date.now(),
              reason: "claude-owner-check-unavailable",
            });
            return;
          }
          if (this.#shuttingDown || this.#runners.get(id) !== runner) return;
          const snapshot = runner.snapshot();
          if (owner.kind !== "idle") {
            await this.#stopForExternalOwner(id, runner);
            return;
          }
          this.#ownershipReasons.set(id, { at: Date.now(), reason: null });
          if (
            snapshot.status !== "idle" ||
            snapshot.activity ||
            snapshot.approvals.length ||
            snapshot.questions.length ||
            // Background work is the session still working, with nobody watching it or not.
            snapshot.backgroundTasks.length
          ) {
            this.#idleSince.delete(id);
            return;
          }
          const since = this.#idleSince.get(id) ?? Date.now();
          this.#idleSince.set(id, since);
          const left = this.#observed.has(id) && !observed;
          // After a rejected login or key the next send must start a worker that reads it again.
          const requested = runner.retireRequested;
          if (!left && !requested && Date.now() - since < this.#idleTimeoutMs) return;
          const retirement = runner.retireIfInactive();
          if (retirement && (await retirement)) {
            this.#idleSince.delete(id);
            if (!requested && observed && this.continuation.isSessionObserved?.(id) === true) {
              this.#continuationNotices.set(id, "background-ended");
              this.#continuationNoticeIds.set(id, randomUUID());
            } else {
              this.#continuationNotices.delete(id);
              this.#continuationNoticeIds.delete(id);
            }
            const live = await this.#live(id, false);
            this.#publishConversationEvent?.(id, "state", live, live);
          }
        });
      }),
    ]);
  }

  async #reconcile(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const requestId = value.requestId;
    const allowed = new Set(["operation", "sessionId", "requestId", "deviceId"]);
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-reconcile");
    const logical = { ...value };
    delete logical.runtimeBootId;
    const receipt = admitControlReceipt(this.dataDir, requestId, stableJson(logical));
    if (receipt.previous) return receipt.previous;
    const record = this.#load(id);
    if (!record || record.released || !this.#validateForReconcile(record))
      throw new Error("session-unavailable");
    const live = await this.#live(id, false);
    const evidence = {
      operation: "reconcile",
      workspaceId: record.workspaceId,
      executionMode: "claude-managed",
      runtimeBootId: this.bootId,
    };
    const claimed = receipt.claim(id, value.deviceId, evidence);
    if (claimed) return claimed;
    const result = {
      accepted: true,
      completed: true,
      requestId,
      sessionId: id,
      runtimeBootId: this.bootId,
      controlOutcome: "accepted",
      reconciled: live.status === "idle",
      live,
    };
    receipt.finish(result);
    return result;
  }

  #validateForReconcile(record: ClaudeRecord): boolean {
    try {
      this.#validate(record);
      return true;
    } catch {
      return false;
    }
  }

  #tryLock(id: string): (() => void) | null {
    if (!supportsClaudeManagedRunner()) return null;
    this.#privateDirectory(false);
    const file = this.#path(id).replace(/\.json$/, ".lock");
    try {
      return acquirePortableFileLease(file);
    } catch (error) {
      if (error instanceof Error && error.message === "session-managed-by-another-runtime")
        return null;
      throw error;
    }
  }

  #setCatalogUnconfirmed(id: string, value: boolean): void {
    const previous = this.#catalogUnconfirmed.has(id);
    if (value) this.#catalogUnconfirmed.add(id);
    else this.#catalogUnconfirmed.delete(id);
    if (previous !== value) this.#catalogChanged?.();
  }

  /**
   * Whether managed sessions may keep background tasks: the person's preference, and whether this
   * computer's Claude Code can (macOS, where the worker's whole process tree ends with it, and a
   * CLI that reports when the turn of a message starts). A change applies from the next worker.
   */
  async backgroundTasksStatus(): Promise<{
    enabled: boolean;
    available: boolean;
    reason: "platform-unsupported" | "claude-cli-unavailable" | "claude-cli-too-old" | null;
    minimumVersion: string;
    cliVersion: string | null;
  }> {
    const enabled = this.continuation.backgroundTasks?.() === true;
    const status = { enabled, minimumVersion: CLAUDE_BACKGROUND_TASKS_MINIMUM };
    if (process.platform !== "darwin" || !supportsClaudeManagedRunner())
      return { ...status, available: false, reason: "platform-unsupported", cliVersion: null };
    const version = await this.#installationVersion();
    if (!version) {
      const old = this.#installationMissing() === "claude-cli-too-old";
      const found = this.#version?.installation.version;
      return {
        ...status,
        available: false,
        reason: old ? "claude-cli-too-old" : "claude-cli-unavailable",
        cliVersion: old && found ? found.replace(/ \(Claude Code\)$/, "") : null,
      };
    }
    const cliVersion = version.replace(/ \(Claude Code\)$/, "");
    if (!supportsClaudeVersion(version, CLAUDE_BACKGROUND_TASKS_MINIMUM))
      return { ...status, available: false, reason: "claude-cli-too-old", cliVersion };
    return { ...status, available: true, reason: null, cliVersion };
  }

  /** Read only the resident worker that provided the caller's live turn. */
  workerObservation(id: string, turnId: unknown) {
    const runner = this.#runners.get(id);
    return runner?.hasWorker && runner.state.turnId === turnId
      ? runner.state.workerObservation()
      : {};
  }

  /** Catalog presentation never probes processes or starts a runner. */
  catalogContinuation(
    id: string,
    persisted?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const runner = this.#runners.get(id);
    const runnerStatus = this.#catalogUnconfirmed.has(id)
      ? "outcome-unknown"
      : (runner?.status ??
        (persisted && interruptedSelfTurn(persisted) ? "idle" : persisted?.status));
    const status = runnerStatus === "waiting-approval" ? "awaiting-approval" : runnerStatus;
    // A cached external owner cannot turn an unresolved outcome into a fork choice.
    if (status === "outcome-unknown")
      return {
        status,
        executionLocation: runner?.hasWorker ? "agentkib" : null,
        ownershipReason: null,
        reason: "control-outcome-unconfirmed",
      };
    if (runner?.isRetiring)
      return {
        status: status ?? "idle",
        executionLocation: "agentkib",
        ownershipReason: null,
        reason: "session-retiring",
      };
    const ownership = this.#ownershipReasons.get(id);
    const reason = ownership && Date.now() - ownership.at < 5000 ? ownership.reason : null;
    if (runner?.hasWorker || this.#starting.has(id))
      return {
        status: this.#starting.has(id) ? "starting" : (status ?? "idle"),
        executionLocation: "agentkib",
        ownershipReason: reason,
        ...(runner?.backgroundTaskCount ? { backgroundTasks: runner.backgroundTaskCount } : {}),
      };
    if (reason)
      return {
        status: "idle",
        executionLocation: [
          "claude-owner-busy",
          "claude-background-session-running",
          "owner-opened-elsewhere",
        ].includes(reason)
          ? "external"
          : null,
        ownershipReason: reason,
        reason,
      };
    if (!supportsClaudeManagedRunner())
      return { status: "unsupported", executionLocation: null, reason: "platform-unsupported" };
    if (this.#version && this.#version.value === null)
      return {
        status: "unsupported",
        executionLocation: null,
        reason: this.#installationMissing(),
      };
    return undefined;
  }

  #nativeMetadata(nativeId: string, workspace: string, share?: ClaudeControlMetadataShare) {
    try {
      return this.sessions.verifiedClaudeControlMetadata(nativeId, workspace, share);
    } catch {
      // Display-only fallback: unavailable or mismatched native history must never lend a
      // title/activity time to this record. Control retains its separate mandatory proof.
      return undefined;
    }
  }

  catalogScopes(sessionId: string, includeNativeAliases: boolean) {
    return this.catalog(sessionId, includeNativeAliases, true);
  }

  catalog(sessionId?: string, includeNativeAliases = true, scopeOnly = false) {
    const direct =
      sessionId && !includeNativeAliases
        ? sessionIdPattern.test(sessionId) && this.#load(sessionId)
        : undefined;
    const records = direct === undefined ? this.#listRecords() : direct ? [direct] : [];
    const metadataShare: ClaudeControlMetadataShare = {};
    return records.flatMap<Record<string, unknown>>((record) => {
      const indexedSessionId = this.store.sessions.id("claude-code", record.nativeId);
      if (sessionId && record.id !== sessionId && indexedSessionId !== sessionId) return [];
      try {
        this.#validate(record);
        if (record.released && record.adopted) return [];
        const identity = { id: record.id, indexedSessionId, workspace_id: record.workspaceId };
        if (scopeOnly) return [{ ...identity, agent: "claude-code" }];
        const native = record.fresh
          ? undefined
          : this.#nativeMetadata(record.nativeId, record.workspace, metadataShare);
        // Older named creates predate host.title initialization. Keep their explicit name;
        // adopted native sessions still follow the verified native display title.
        const namedCreateTitle =
          !record.adopted && !record.forkSourceNativeId && record.title !== "Claude Code"
            ? record.title
            : undefined;
        const legacyForkTitle =
          record.forkSourceNativeId && record.title === "Claude Code (fork)"
            ? this.#nativeMetadata(record.forkSourceNativeId, record.workspace, metadataShare)
                ?.title
            : undefined;
        const forkSources = record.forkSourceNativeId
          ? records.filter(
              (source) =>
                source.nativeId === record.forkSourceNativeId &&
                source.workspace === record.workspace &&
                source.home === record.home,
            )
          : [];
        const forkSourceId = record.forkSourceNativeId
          ? forkSources.length === 1
            ? forkSources[0]!.id
            : this.store.sessions.id("claude-code", record.forkSourceNativeId)
          : null;
        const host = this.#hostState.peek(record.id);
        return [
          {
            ...identity,
            agent: "claude-code",
            title:
              host?.localTitle ??
              host?.title ??
              (record.forkSourceNativeId
                ? (legacyForkTitle ?? record.title)
                : (namedCreateTitle ?? native?.title ?? record.title)),
            origin: "interactive",
            created_at: record.createdAt,
            updated_at: native?.updated_at ?? record.createdAt,
            forked_from_session_id: forkSourceId,
            spawned_by_session_id: null,
            message_count: null,
            git_branch: null,
            // Only Claude Desktop archives Claude sessions, in its own list.
            archived: false,
            sidechain: false,
            availability: "readable",
            executionMode: "claude-managed",
            continuation: this.catalogContinuation(record.id, record.snapshot),
            sourceSessionId: record.nativeId,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  projectAgentToolsReady(id: string): boolean | null {
    return this.#runners.get(id)?.hasWorker && !this.#leadToolKeys.has(id) ? false : null;
  }

  hasManagedSession(id: string): boolean {
    return sessionIdPattern.test(id) && this.#load(id) !== null;
  }

  async hasRunningNativeTerminal(id: string, shareObservation = false): Promise<boolean> {
    try {
      if (this.hasManagedSession(id)) return false;
      const target = this.sessions.verifiedClaudeReadSource(id);
      if (target.directoryMissing || this.#desktopClaimed(target.nativeId) !== false) return false;
      const cached = shareObservation ? this.#displayObservation : undefined;
      const observation =
        cached && Date.now() - cached.at < 3_000 ? cached.share : this.#freshObservation();
      const owner = await this.#ownership.check(target.nativeId, null, observation);
      const terminal =
        owner.kind === "interactive" &&
        (owner.source === "ps" ||
          !!(await this.#ownership.foregroundProcess(target.nativeId, observation)));
      return terminal && !this.hasManagedSession(id);
    } catch {
      return false;
    }
  }

  /**
   * Queues a lead's report from its lanes; it is sent as a turn of its own once the session is
   * idle, after the person's own queued messages (`ClaudeHostStateStore.addReport`).
   */
  /** Returns whether it joined a report still waiting, so that no new turn is needed. */
  queueReport(id: string, deviceId: string, text: string, reportId?: string): boolean {
    if (!this.hasManagedSession(id)) throw new LeadReportNotDispatched("session-unavailable");
    return this.#hostState.addReport(id, deviceId, text, reportId);
  }

  /** Reports waiting to start a turn of this session, or starting it now (read only). */
  queuedReports(id: string): number {
    return (
      this.#hostState
        .peek(id)
        ?.work.filter(
          (work) =>
            work.kind === "report" && ["pending", "claimed", "dispatched"].includes(work.status),
        ).length ?? 0
    );
  }

  renameLocalTitle(value: Record<string, unknown>, scope: ClaudeLocalTitleScope) {
    const result = this.#hostState.renameLocalTitle(value, scope);
    if (result.changed) this.#catalogChanged?.();
    return result;
  }

  projectLocalTitles(rows: unknown[]) {
    return this.#hostState.projectLocalTitles(rows);
  }

  /** The workspace a managed session belongs to, also before its first turn is indexed. */
  managedWorkspace(id: string): string | null {
    if (!sessionIdPattern.test(id)) return null;
    const record = this.#load(id);
    return record && !record.released ? record.workspaceId : null;
  }

  readStateTarget(id: string): ReadStateTarget | null {
    if (!sessionIdPattern.test(id)) return null;
    const record = this.#load(id);
    if (!record || (record.released && record.adopted)) return null;
    this.#validate(record);
    let transcript: string | null = null;
    try {
      transcript = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
    } catch {
      /* A fresh turn may not have a transcript yet. */
    }
    return {
      provider: "claude-code",
      home: record.home,
      nativeId: record.nativeId,
      workspace: record.workspace,
      transcript,
    };
  }

  /**
   * Native IDs this catalog lists. They run with `--print`, so Claude Code records them as
   * `sdk-cli`; the index keeps them as conversations instead of hiding them like other SDK runs.
   */
  managedNativeIds(): Set<string> {
    return new Set(
      this.#listRecords().flatMap((record) =>
        record.released && record.adopted ? [] : [record.nativeId.toLowerCase()],
      ),
    );
  }

  #directory(): string {
    return path.join(this.dataDir, "claude-managed");
  }

  #path(id: string): string {
    if (!sessionIdPattern.test(id)) throw new Error("invalid-session");
    return path.join(this.#directory(), `${id}.json`);
  }

  /** The CLI writes the session files here, so an unusable CLAUDE_CONFIG_DIR fails closed. */
  #home(): string {
    const config = resolveClaudeConfig(this.environment, this.environment.HOME ?? homedir());
    assertClaudeConfigWritable(config);
    const configured = config.dir;
    if (lstatSync(configured, { throwIfNoEntry: false })) return canonicalize(configured);
    const parent = path.dirname(configured);
    return path.join(canonicalize(parent), path.basename(configured));
  }

  #privateDirectory(create: boolean): void {
    const directory = this.#directory();
    if (create) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    for (let current = directory; ; current = path.dirname(current)) {
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (info.isSymbolicLink()) throw new Error("Claude metadata path is a symlink");
      }
      if (path.dirname(current) === current) break;
    }
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Claude metadata directory unavailable");
    restrictRemotePath(directory, true);
  }

  #load(id: string): ClaudeRecord | null {
    const file = this.#path(id);
    if (!existsSync(file)) return null;
    this.#privateDirectory(false);
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT)
      throw new Error("invalid-Claude-metadata");
    restrictRemotePath(file);
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isObject(value) ||
      value.version !== 1 ||
      value.id !== id ||
      typeof value.workspaceId !== "string" ||
      typeof value.workspace !== "string" ||
      typeof value.home !== "string" ||
      typeof value.nativeId !== "string" ||
      !uuidPattern.test(value.nativeId) ||
      ((value.forkSourceNativeId !== undefined || value.forkCutoff !== undefined) &&
        (typeof value.forkSourceNativeId !== "string" ||
          !uuidPattern.test(value.forkSourceNativeId) ||
          value.forkSourceNativeId === value.nativeId ||
          typeof value.forkCutoff !== "string" ||
          !uuidPattern.test(value.forkCutoff))) ||
      typeof value.title !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.adopted !== "boolean" ||
      (value.terminalHandover !== undefined && value.terminalHandover !== true) ||
      (value.terminalHandoverLeaseId !== undefined &&
        (typeof value.terminalHandoverLeaseId !== "string" ||
          !uuidPattern.test(value.terminalHandoverLeaseId))) ||
      (value.terminalAutoAdoptedAt !== undefined &&
        (typeof value.terminalAutoAdoptedAt !== "string" ||
          !Number.isFinite(Date.parse(value.terminalAutoAdoptedAt)))) ||
      typeof value.released !== "boolean" ||
      typeof value.fresh !== "boolean" ||
      !isObject(value.snapshot) ||
      !Array.isArray(value.completedRequests)
    )
      throw new Error("invalid-Claude-metadata");
    return value as ClaudeRecord;
  }

  #save(record: ClaudeRecord): void {
    this.#privateDirectory(true);
    const target = this.#path(record.id);
    if (existsSync(target)) {
      const info = lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid-Claude-metadata");
    }
    const temporary = path.join(this.#directory(), `.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(fd, JSON.stringify(record));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, target);
      const directoryFd = openSync(this.#directory(), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  #listRecords(): ClaudeRecord[] {
    const directory = this.#directory();
    if (!existsSync(directory)) return [];
    this.#privateDirectory(false);
    const entries = readdirSync(directory, { withFileTypes: true }) as Array<{
      name: string;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    if (entries.length > 20_000) throw new Error("Claude managed catalog exceeds limit");
    return entries.flatMap((entry) => {
      if (!entry.name.endsWith(".json") || entry.isSymbolicLink() || !entry.isFile()) return [];
      const record = this.#load(path.basename(entry.name, ".json"));
      return record ? [record] : [];
    });
  }

  #validate(record: ClaudeRecord): void {
    const root = canonicalize(this.store.workspacePath(record.workspaceId));
    const expected = record.registeredWorkspace ?? record.workspace;
    if (pathIdentity(root) !== pathIdentity(canonicalize(expected)))
      throw new Error("session-workspace-mismatch");
    const actual = pathIdentity(canonicalize(record.workspace));
    const registered = pathIdentity(root);
    const relative = path.relative(registered, actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("session-workspace-mismatch");
    const home = lexicalPathIdentity(this.#home());
    // Direct records capture the canonical location, even before Claude creates the directory.
    // Forks inherit the source record's home. Resolve it only while that entry still exists.
    const recordedHome =
      record.forkSourceNativeId && lstatSync(record.home, { throwIfNoEntry: false })
        ? canonicalize(record.home)
        : record.home;
    if (home !== lexicalPathIdentity(recordedHome)) throw new Error("claude-home-changed");
  }

  async #installationVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000) return this.#version.value;
    const installation = await readClaudeInstallation(this.commands, this.environment);
    const value = installation.reason === null ? installation.version : null;
    this.#version = { at: Date.now(), value, installation };
    return value;
  }

  /** The Claude Code CLI managed sessions run, or why there is none. */
  async #installationExecutable(): Promise<string> {
    if ((await this.#installationVersion()) === null) throw new Error(this.#installationMissing());
    const executable = this.#version?.installation.executable;
    if (!executable) throw new Error("claude-cli-unavailable");
    return executable;
  }

  /** Why no installation qualifies: none found, or only one that is too old. */
  #installationMissing(): "claude-cli-unavailable" | "claude-cli-too-old" {
    return this.#version?.installation.reason ?? "claude-cli-unavailable";
  }

  #cachedNewSessionCatalog(workspace: string, cliVersion: string) {
    const executable = this.#version?.value && this.#version.installation.executable;
    if (executable)
      return this.#startupDiscovery.cached(workspace, executable, cliVersion, this.#home());
  }

  async #readNewSessionCatalog(
    workspace: string,
    cliVersion: string,
    revalidate = false,
    autoModel?: string | null,
  ) {
    const executable = this.#version?.value && this.#version.installation.executable;
    if (executable && !this.#shuttingDown)
      return this.#startupDiscovery.read(
        workspace,
        executable,
        cliVersion,
        this.#home(),
        this.environment,
        revalidate,
        autoModel,
      );
  }

  #observeAutoPermission(id: string, workspace: string, cliVersion: string, model: string | null) {
    const executable = this.#version?.installation.executable;
    return (
      !!executable &&
      this.#startupDiscovery.observeAutoPermission(
        workspace,
        executable,
        cliVersion,
        this.#home(),
        this.environment,
        model,
        id,
        () => this.#publishConversationEvent?.(id, "invalidate", { domains: ["settings"] }),
      )
    );
  }

  async #autoPermissionAvailable(workspace: string, model: string | null, revalidate: boolean) {
    const version = await this.#installationVersion();
    if (!version) return false;
    const snapshot = await this.#readNewSessionCatalog(workspace, version, revalidate, model).catch(
      () => undefined,
    );
    return snapshot?.autoPermissionAvailable === true;
  }

  async options(workspaceId?: unknown): Promise<Record<string, unknown>> {
    const cliVersion = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    const available = cliVersion !== null;
    const supportsSettings = cliVersion !== null && supportsClaudeVersion(cliVersion, "2.1.286");
    if (
      workspaceId !== undefined &&
      (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > 256)
    )
      throw new Error("invalid-workspace-id");
    const catalog =
      supportsSettings && typeof workspaceId === "string"
        ? await this.#readNewSessionCatalog(
            canonicalize(this.store.workspacePath(workspaceId)),
            cliVersion,
          ).catch(() => undefined)
        : undefined;
    const models = catalog?.settingsAcknowledged ? catalog.models : [];
    const reportedModel = catalog?.settings.model;
    const model = reportedModel ? claudeModelOption(models, reportedModel) : undefined;
    const effort = catalog?.settings.effort;
    return {
      available,
      ...(available ? {} : { reason: "unverified-installation" }),
      workspaces: available
        ? (this.store.listWorkspaces() as Array<Record<string, unknown>>).map(({ id, name }) => ({
            id,
            name,
          }))
        : [],
      models: models.map((option) => ({
        id: option.value,
        name: option.displayName,
        ...(option.resolvedModel !== undefined ? { resolvedModel: option.resolvedModel } : {}),
        efforts: option.supportedEffortLevels ?? [],
      })),
      ...(model
        ? {
            defaults: {
              model: model.value,
              effort: effort && model.supportedEffortLevels?.includes(effort) ? effort : null,
            },
          }
        : {}),
      permissionModes: supportsSettings
        ? CLAUDE_CREATION_PERMISSION_MODES.map((id) => ({ id, name: id }))
        : [],
      cliVersion,
      permissionMode: "cli-configured",
    };
  }

  async #live(
    id: string,
    controls: boolean,
    ownershipReadAttempt = 0,
  ): Promise<Record<string, unknown>> {
    if (
      this.#continuationNotices.get(id) === "background-ended" &&
      this.continuation.isSessionObserved?.(id) !== true
    ) {
      this.#continuationNotices.delete(id);
      this.#continuationNoticeIds.delete(id);
    }
    let record = this.#load(id);
    const version = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    if (!record) {
      // A status observation needs identity, not a complete history document or
      // a control fingerprint. Mutations retain their fresh #resolveNative proof.
      const target = this.sessions.verifiedClaudeReadSource(id);
      // Claude Code resumes in the session's directory, so a deleted worktree is view only.
      const reason = target.directoryMissing
        ? "session-directory-missing"
        : !supportsClaudeManagedRunner()
          ? "platform-unsupported"
          : !version
            ? this.#installationMissing()
            : await this.#ownershipReason(id, target.nativeId, null);
      if (this.#load(id)) {
        this.#forgetOwnership(id);
        if (ownershipReadAttempt > 0) throw new Error("claude-owner-check-unavailable");
        return this.#live(id, controls, ownershipReadAttempt + 1);
      }
      return {
        sessionId: id,
        workspaceId: target.workspaceId,
        sourceSessionId: target.nativeId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
        executionLocation:
          reason === "claude-owner-busy" || reason === "claude-background-session-running"
            ? "external"
            : null,
        ownershipReason: reason,
        status: version ? "idle" : "unsupported",
        revision: this.#hostState.read(id).revision,
        turnId: null,
        sendEnabled: controls && !reason,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason,
        cliVersion: version,
        permissionMode: "cli-configured",
        usage: this.#savedTranscriptObservation(id, { source: target }).usage,
      };
    }
    this.#validate(record);
    const ownershipRunner = this.#runners.get(id);
    const ownedPid = ownershipRunner?.hasWorker ? ownershipRunner.processId : null;
    const starting = this.#starting.has(id);
    const startupPending = ownershipRunner?.startupPending === true;
    const ownershipReason = !supportsClaudeManagedRunner()
      ? "platform-unsupported"
      : !version
        ? this.#installationMissing()
        : await this.#ownershipReason(id, record.nativeId, ownedPid);
    const current = this.#load(id);
    if (!current) throw new Error("session-unavailable");
    const runner = this.#runners.get(id);
    if (
      current.createdAt !== record.createdAt ||
      current.nativeId !== record.nativeId ||
      current.home !== record.home ||
      current.workspaceId !== record.workspaceId ||
      current.workspace !== record.workspace ||
      current.released !== record.released ||
      runner !== ownershipRunner ||
      (runner?.hasWorker ? runner.processId : null) !== ownedPid ||
      (runner?.startupPending === true) !== startupPending ||
      this.#starting.has(id) !== starting
    ) {
      // The observation excluded the previous worker. A replacement or completed
      // startup needs a fresh check, never the old worker's cached idle result.
      this.#forgetOwnership(id);
      if (ownershipReadAttempt > 0) throw new Error("claude-owner-check-unavailable");
      return this.#live(id, controls, ownershipReadAttempt + 1);
    }
    // No later await may let a captured starting snapshot outlive cleanup/retirement.
    record = current;
    this.#validate(record);
    record = this.#recoverStartupCleanup(record);
    this.#recoverCompletions(record);
    let observations: ClaudeRunnerSnapshot["subagents"];
    if (runner) {
      const snapshot = runner.snapshot();
      if (runner.hasWorker) observations = snapshot.subagents;
      const turnId = snapshot.turnId;
      if (
        snapshot.status === "idle" &&
        typeof turnId === "string" &&
        turnId.length > 0 &&
        !record.completedRequests.includes(turnId)
      ) {
        // The runner records the content fingerprint on completion. Replaying its
        // snapshot here must not hash the transcript again or grant write authority.
        record.completedRequests.push(turnId);
      }
      record.snapshot = snapshot as unknown as Record<string, unknown>;
      this.#save(record);
      this.#recoverCompletions(record);
    }
    if (!runner && interruptedSelfTurn(record.snapshot)) {
      // The worker is gone and no command is pending. Its persisted running state
      // cannot establish how the round actually ended.
      record.snapshot = {
        ...record.snapshot,
        status: "idle",
        lastOutcome: null,
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        streamTextTruncated: false,
        activity: null,
        apiRetry: null,
        revision: Number(record.snapshot.revision ?? 0) + 1,
      };
      this.#save(record);
    }
    const unconfirmed = managedSessionHasUnknownCommands(this.dataDir, id);
    this.#setCatalogUnconfirmed(id, unconfirmed);
    let live: Record<string, unknown>;
    if ((!runner && record.snapshot.status !== "idle") || unconfirmed) {
      // A session AgentKib stopped for a stated reason keeps that reason across a restart, unless a
      // command is also unresolved: then the generic "outcome unconfirmed" matters more.
      const stopped =
        !runner &&
        record.snapshot.status === "outcome-unknown" &&
        terminationCodeOf(record.snapshot.reason) !== null &&
        !unconfirmed;
      live = {
        ...record.snapshot,
        status: "outcome-unknown",
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason: stopped ? record.snapshot.reason : "control-outcome-unconfirmed",
      };
    } else {
      live = { ...record.snapshot };
    }
    if (record.released && live.status !== "outcome-unknown") {
      live.status = "idle";
      live.reason = null;
      live.sendEnabled = true;
    }
    live.sessionId = record.id;
    // Runner observations carry native ids internally; only the parent-scoped projection is public.
    delete live.subagents;
    // Background work lives in the worker: without one none runs, whatever was last stored.
    const backgroundTasks = runner?.hasWorker ? live.backgroundTasks : [];
    live.backgroundTasks = publicBackgroundTasks(backgroundTasks);
    this.#projectActivities(live, { id, record, tasks: backgroundTasks, observations });
    if (live.turnOrigin !== "self") live.turnOrigin = "host";
    live.sourceSessionId = record.nativeId;
    live.workspaceId = record.workspaceId;
    live.runtimeBootId = this.bootId;
    live.executionMode = "claude-managed";
    live.permissionMode = "cli-configured";
    live.cliVersion = version;
    if (!runner?.hasWorker && isObject(live.usage))
      live.usage = projectContextUsage(
        {
          ...live.usage,
          // Persisted reports can belong to another backend process; only a resident runner
          // owns a generation in this runtime, including when its worker has retired.
          reportGeneration: runner ? live.usage.reportGeneration : undefined,
          state: "stale",
          reason: "connection-unavailable",
        },
        Number(live.revision),
      );
    live.executionLocation = runner?.hasWorker ? "agentkib" : null;
    live.ownershipReason = ownershipReason;
    live.continuationNotice = this.#continuationNotices.get(id) ?? null;
    live.continuationNoticeId = this.#continuationNoticeIds.get(id) ?? null;
    if (this.#starting.has(id) && (live.status !== "outcome-unknown" || runner?.startupPending)) {
      live.status = "starting";
      live.executionLocation = "agentkib";
      live.sendEnabled = false;
      live.stopEnabled = false;
      if (runner?.startupPending) live.reason = null;
    }
    if (ownershipReason) {
      live.sendEnabled = false;
      if (live.status !== "outcome-unknown") live.reason = ownershipReason;
      if (
        [
          "claude-owner-busy",
          "claude-background-session-running",
          "owner-opened-elsewhere",
        ].includes(ownershipReason)
      )
        live.executionLocation = "external";
    } else if (
      typeof live.reason === "string" &&
      [
        "claude-owner-busy",
        "claude-background-session-running",
        "owner-opened-elsewhere",
        "claude-owner-check-unavailable",
      ].includes(live.reason)
    )
      live.reason = null;
    if (!controls) {
      live.sendEnabled = false;
      live.stopEnabled = false;
      for (const key of ["approvals", "questions"])
        if (Array.isArray(live[key]))
          live[key] = (live[key] as Array<Record<string, unknown>>).map((item) => ({
            ...item,
            supported: false,
          }));
    }
    this.#rememberConfirmedOptions(id);
    const host = this.#hostState.read(id);
    live.revision = Number(live.revision ?? 0) + host.revision;
    live.goal = host.goal;
    live.schedule = { paused: host.paused, reason: host.reason, revision: host.revision };
    live.usageLimit = usageLimitView(host.usageLimit, this.bootId);
    const options = runner?.optionsSnapshot.settingsAcknowledged
      ? runner.optionsSnapshot
      : host.lastConfirmedOptions?.options;
    const confirmed =
      live.status !== "outcome-unknown" &&
      (!runner?.hasWorker || runner.optionsSnapshot.settingsAcknowledged) &&
      options !== undefined &&
      stableJson(host.lastConfirmedOptions?.selection) === stableJson(host.settings);
    live.settings = {
      current: options?.settings ?? { model: null, effort: null, permissionMode: null },
      selected: host.settings,
      applicationStatus: confirmed ? "confirmed" : "pending",
    };
    const permission = record.released
      ? this.#releasedPermission(id)
      : this.#permissionView(id, version, () => host.settings.permissionMode);
    if (permission) live.permission = permission;
    return live;
  }

  #projectActivities(
    live: Record<string, unknown>,
    {
      id,
      record,
      tasks,
      observations = [],
      includeSubagents = false,
    }: {
      id: string;
      record: Pick<ClaudeRecord, "nativeId" | "workspace" | "terminalAutoAdoptedAt"> | null;
      tasks: unknown;
      observations?: ClaudeRunnerSnapshot["subagents"];
      includeSubagents?: boolean;
    },
  ): void {
    let salt: string | undefined;
    const identitySalt = () => (salt ??= this.store.sessions.identitySalt());
    const nativeId = record?.nativeId ?? "";
    const subagents = observations.length
      ? projectSubagentObservations(
          {
            sessionId: id,
            nativeId,
            workspace: record?.workspace ?? "",
            transcript: "",
            agent: "claude-code",
          },
          identitySalt(),
          observations,
        )
      : undefined;
    if (includeSubagents)
      live.subagents = subagents ?? {
        version: 1,
        sessionId: id,
        agents: [],
        truncated: false,
        partial: true,
      };
    prepareClaudeActivities(
      live,
      {
        tasks,
        observations,
        sessionId: id,
        nativeId,
        bootId: this.bootId,
        identitySalt,
        terminalAutoAdoptedAt: record?.terminalAutoAdoptedAt,
      },
      subagents,
    );
  }

  #streamLive(
    id: string,
    snapshot: ClaudeRunnerSnapshot,
    record = this.#load(id),
  ): Record<string, unknown> {
    // Streaming frames only publish progress; persist the options catalog at idle ACK/turn boundaries.
    if (snapshot.status === "idle") this.#rememberConfirmedOptions(id);
    const host = this.#hostState.read(id);
    // Same version source as #live: the cached value, never a fresh probe per CLI frame.
    const version = this.#version?.value ?? null;
    const permission = this.#permissionView(id, version, () => host.settings.permissionMode);
    const pendingStartup = this.#runners.get(id)?.startupPending;
    const live: Record<string, unknown> = {
      ...snapshot,
      backgroundTasks: publicBackgroundTasks(snapshot.backgroundTasks),
      ...(this.#starting.has(id) && (snapshot.status !== "outcome-unknown" || pendingStartup)
        ? {
            status: "starting",
            sendEnabled: false,
            stopEnabled: false,
            ...(pendingStartup ? { reason: null } : {}),
          }
        : {}),
      revision: snapshot.revision + host.revision,
      sessionId: id,
      sourceSessionId: record?.nativeId ?? null,
      workspaceId: record?.workspaceId ?? null,
      runtimeBootId: this.bootId,
      executionMode: "claude-managed",
      executionLocation:
        this.#runners.get(id)?.hasWorker || this.#starting.has(id) ? "agentkib" : null,
      ownershipReason: this.#ownershipReasons.get(id)?.reason ?? null,
      continuationNotice: this.#continuationNotices.get(id) ?? null,
      continuationNoticeId: this.#continuationNoticeIds.get(id) ?? null,
      permissionMode: "cli-configured",
      cliVersion: version,
      ...(permission ? { permission } : {}),
    };
    this.#projectActivities(live, {
      id,
      record,
      tasks: snapshot.backgroundTasks,
      observations: snapshot.subagents,
      includeSubagents: true,
    });
    return live;
  }

  /**
   * Which permission mode this session runs in, for display only. The CLI's own report wins;
   * a retired worker keeps showing its last report (marked `previous`); only a session whose
   * mode was never observed and that has no selection can carry the "possibly auto" hint.
   * Nothing here is inferred: an unknown mode stays `mode: null`. Every observation passing
   * through also becomes the session's last report.
   *
   * Total on purpose. The runner reports a failing snapshot callback as a session failure and
   * kills the process, and #streamLive runs inside that callback for every CLI frame, so this
   * returns undefined (no `permission` field) instead of ever throwing.
   */
  #permissionView(
    id: string,
    version: string | null,
    selected: () => ClaudeSettings["permissionMode"],
  ): ClaudePermissionView | undefined {
    try {
      const runner = this.#runners.get(id);
      const observed = runner?.hasWorker ? runner.observedPermissionMode : null;
      if (observed !== null && observed !== undefined) {
        this.#lastPermission.set(id, observed);
        return { mode: observed };
      }
      const previous = this.#lastPermission.get(id);
      if (previous !== undefined) return { mode: previous, previous: true };
      const cached = this.#hostState.read(id).lastConfirmedOptions?.permissionMode;
      if (cached !== null && cached !== undefined) return { mode: cached, previous: true };
      // Documented start-mode rule: without feature flags (third-party provider, telemetry off)
      // `claude -p` starts in auto from 2.1.285. Organization policy can change this, so the
      // hint says "possibly" and only marks the unknown mode.
      return {
        mode: null,
        ...(selected() === undefined && supportsClaudeVersion(version ?? "", "2.1.285")
          ? { possiblyAuto: true as const }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  /** A released session runs nothing here: clear the view explicitly and forget the last mode. */
  #releasedPermission(id: string): ClaudePermissionView {
    this.#lastPermission.delete(id);
    return { mode: null };
  }

  /**
   * `state` patches merge shallowly, so a subscriber only drops its permission notice when told
   * to. Best effort: the release is already durable, and a client that misses this patch re-reads
   * `live`, where a released session carries the same explicit clear.
   */
  async #publishReleasedPermission(id: string): Promise<void> {
    // Forget first: the live read below can fail without undoing the release.
    this.#lastPermission.delete(id);
    try {
      const released = await this.#live(id, false);
      this.#publishConversationEvent?.(id, "state", { permission: { mode: null } }, released);
    } catch {
      /* The release already committed; nothing to roll back. */
    }
  }

  async live(id: string, controls = false) {
    return this.#live(id, controls);
  }

  #runningForQuit(id: string) {
    const record = this.#load(id);
    const runner = this.#runners.get(id);
    const pid = runner?.processId;
    if (
      this.#shuttingDown ||
      !record ||
      record.released ||
      record.fresh ||
      !runner?.canInterruptForQuit() ||
      pid == null ||
      !this.#ownerLocks.has(id) ||
      this.#starting.has(id) ||
      this.#isSessionBridged(record) ||
      managedSessionHasUnknownCommands(this.dataDir, id)
    )
      return;
    this.#validate(record);
    const host = this.#hostState.peek(id);
    const settings = host?.settings ?? {};
    if (host?.reason === "usage-limit" || this.#runnerSelectionPending(runner, settings)) return;
    const snapshot = runner.snapshot();
    const { settings: effective, settingsAcknowledged } = runner.optionsSnapshot;
    const model = snapshot.model ?? effective.model;
    if (
      !uuidPattern.test(snapshot.turnId) ||
      !settingsAcknowledged ||
      !model ||
      !effective.permissionMode
    )
      return;
    return {
      record,
      runner,
      pid,
      snapshot,
      settingsKey: stableJson(settings),
      launch: {
        model,
        permissionMode: effective.permissionMode,
        ...(effective.effort ? { effort: effective.effort } : {}),
      },
    };
  }

  #quitHistoryOpen(record: ClaudeRecord, turnId: string): boolean {
    const transcript = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
    return claudeWorkerHistoryHasOpenTurn(transcript, record.nativeId, turnId);
  }

  async quitCandidate(sessionId: string): Promise<{ turnId: string } | undefined> {
    try {
      const candidate = this.#runningForQuit(sessionId);
      if (!candidate) return;
      await this.#ensureNoExternalOwner(candidate.record.nativeId, candidate.pid);
      const current = this.#runningForQuit(sessionId);
      if (
        !current ||
        current.runner !== candidate.runner ||
        current.pid !== candidate.pid ||
        current.snapshot.turnId !== candidate.snapshot.turnId ||
        !this.#quitHistoryOpen(current.record, current.snapshot.turnId)
      )
        return;
      return { turnId: current.snapshot.turnId };
    } catch {
      // A missing native transcript or ownership proof makes this task ineligible.
      return undefined;
    }
  }

  interruptForQuit(
    sessionId: string,
    turnId: string,
  ): Promise<Record<string, unknown> | undefined> {
    return this.#serializeSession(sessionId, async () => {
      try {
        const candidate = this.#runningForQuit(sessionId);
        if (!candidate || candidate.snapshot.turnId !== turnId) return;
        // Shutdown already closed the shared command supervisor as it drained pending RPCs.
        const commands = this.continuation.quitCommands?.() ?? new Commands();
        try {
          const probe = new ClaudeSessionOwnerProbe(commands, this.environment);
          await this.#ensureNoExternalOwner(candidate.record.nativeId, candidate.pid, probe);
        } finally {
          commands.close();
        }
        const current = this.#runningForQuit(sessionId);
        if (
          !current ||
          current.runner !== candidate.runner ||
          current.pid !== candidate.pid ||
          current.snapshot.turnId !== turnId
        )
          return;
        const { record, runner, snapshot, launch, settingsKey } = current;
        if (!this.#quitHistoryOpen(record, turnId)) return;
        // Reuse the owned-process retirement, including its guards against native-only work.
        // The quit journal will report this interruption once, with the continuation outcome.
        let resumeQueue = false;
        await runner.restartForDelegation(snapshot.revision, () => {
          resumeQueue = this.#hostState.pauseQueueForQuit(sessionId);
          this.#quitInterruptions.set(sessionId, turnId);
        });
        if (runner.hasWorker) return;
        const stopped = runner.snapshot();
        if (stopped.turnId !== turnId || stopped.lastOutcome !== "cancelled") return;
        this.#hostState.complete(sessionId, turnId, {
          success: false,
          usage: null,
          cancelled: true,
        });
        this.invalidateSchedulePermits(sessionId);
        await this.#goalEndpoints.get(sessionId)?.close();
        this.#goalEndpoints.delete(sessionId);
        await this.#retireGoalRunner(sessionId);
        // Claude can flush progress while stopping. The post-stop transcript must still prove
        // the same open turn, and its final fingerprint anchors the next boot's revalidation.
        const fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
        if (!this.#quitHistoryOpen(record, turnId)) return;
        return {
          turnId,
          nativeId: record.nativeId,
          workspaceId: record.workspaceId,
          createdAt: record.createdAt,
          fingerprint,
          settingsKey,
          resumeQueue,
          launch,
        } satisfies QuitEvidence;
      } catch {
        // Ambiguous retirement, completion or identity can never authorize a new prompt.
        return undefined;
      } finally {
        this.#quitInterruptions.delete(sessionId);
      }
    });
  }

  #matchingQuitRecord(id: string, evidence: QuitEvidence): ClaudeRecord | undefined {
    const record = this.#load(id);
    const host = this.#hostState.peek(id);
    if (
      this.#shuttingDown ||
      !record ||
      record.released ||
      record.fresh ||
      record.nativeId !== evidence.nativeId ||
      record.workspaceId !== evidence.workspaceId ||
      record.createdAt !== evidence.createdAt ||
      this.#isSessionBridged(record) ||
      host?.reason === "usage-limit" ||
      stableJson(host?.settings ?? {}) !== evidence.settingsKey
    )
      return;
    this.#validate(record);
    return record;
  }

  async #canResumeQuit(id: string, evidence: QuitEvidence): Promise<boolean> {
    try {
      const record = this.#matchingQuitRecord(id, evidence);
      if (!record) return false;
      await this.#ensureNoExternalOwner(record.nativeId);
      const current = this.#matchingQuitRecord(id, evidence);
      return (
        !!current &&
        !this.#runners.has(id) &&
        !managedSessionHasUnknownCommands(this.dataDir, id) &&
        current.snapshot.status === "idle" &&
        current.snapshot.lastOutcome === "cancelled" &&
        current.snapshot.turnId === evidence.turnId &&
        this.#targetFingerprint(current.nativeId, current.workspace) === evidence.fingerprint
      );
    } catch {
      return false;
    }
  }

  async checkAfterQuit(id: string, value: Record<string, unknown>): Promise<boolean> {
    const evidence = quitEvidence(value);
    return evidence ? this.#canResumeQuit(id, evidence) : false;
  }

  /** Called once there is a durable receipt proving the continuation prompt reached Claude. */
  restoreQuitQueue(id: string, value: Record<string, unknown>): void {
    try {
      const evidence = quitEvidence(value);
      if (evidence?.resumeQueue && this.#matchingQuitRecord(id, evidence))
        this.#hostState.resumeQueueAfterQuit(id);
    } catch {
      // The prompt was accepted. If this write fails, the queue stays paused for the user.
    }
  }

  #assertQuitDispatch(
    id: string,
    runner: ClaudeManagedRunnerProcess,
    evidence: QuitEvidence,
  ): void {
    try {
      const current = this.#matchingQuitRecord(id, evidence);
      const options = runner.optionsSnapshot;
      if (
        current &&
        this.#runners.get(id) === runner &&
        this.#ownerLocks.has(id) &&
        options.settingsAcknowledged &&
        options.settings.model === evidence.launch.model &&
        options.settings.permissionMode === evidence.launch.permissionMode &&
        (options.settings.effort ?? undefined) === evidence.launch.effort &&
        this.#targetFingerprint(current.nativeId, current.workspace) === evidence.fingerprint
      )
        return;
    } catch {
      // The normal send path records that the continuation did not reach the worker.
    }
    throw new ClaudeUndispatchedError("quit-continuation-stale");
  }

  resumeAfterQuit(
    sessionId: string,
    value: Record<string, unknown>,
    requestId: string,
    text: string,
  ): Promise<"continued" | "skipped" | "unknown"> {
    return this.#serializeSession(sessionId, async () => {
      const evidence = quitEvidence(value);
      if (!evidence || !(await this.#canResumeQuit(sessionId, evidence))) return "skipped";
      try {
        const live = await this.#live(sessionId, true);
        const result = await this.#control(
          {
            operation: "send",
            sessionId,
            requestId,
            deviceId: "desktop-local",
            runtimeBootId: this.bootId,
            expectedRevision: live.revision,
            experimentalEnabled: true,
            text,
          },
          sessionId,
          evidence,
        );
        if (result.accepted === true) {
          // Regular scheduler sends still require idle; pending messages stay behind this turn.
          this.restoreQuitQueue(sessionId, evidence);
          return "continued";
        }
        return result.controlOutcome === "unknown" ? "unknown" : "skipped";
      } catch {
        // Once a receipt is unresolved, never replay the prompt.
        return managedSessionHasUnknownCommands(this.dataDir, sessionId) ? "unknown" : "skipped";
      }
    });
  }

  /** Host-internal control. End only this session's owned process, keeping its queue and history. */
  restartWorker(
    request: WorkerRestartRequest,
    beforeDispatch: () => void,
  ): Promise<WorkerRestartResult> {
    const { sessionId: id, requestId, deviceId } = request;
    return this.#serializeSession(id, async () => {
      const refused = (
        reason: string,
        controlOutcome: "not-dispatched" | "unknown" = "not-dispatched",
      ): WorkerRestartResult => ({
        accepted: false,
        controlOutcome,
        requestId,
        reason,
      });
      let dispatched = false;
      let finishReceipt: ((result: Record<string, unknown>) => void) | undefined;
      let replay: WorkerRestartResult | undefined;
      try {
        if (
          !sessionIdPattern.test(id) ||
          !uuidPattern.test(requestId) ||
          !validClaudeDeviceId(deviceId) ||
          request.experimentalEnabled !== true ||
          !Number.isSafeInteger(request.expectedRevision) ||
          request.expectedRevision < 0
        )
          return refused("invalid-managed-control");
        const value = { ...request, operation: "worker-restart" };
        const receipt = admitControlReceipt(
          this.dataDir,
          requestId,
          claudeCommandFingerprintInput(value),
        );
        if (receipt.previous) return receipt.previous as WorkerRestartResult;
        if (this.#shuttingDown) return refused("session-unavailable");
        if (request.runtimeBootId !== this.bootId) return refused("stale-runtime-boot");

        const record = this.#load(id);
        if (!record || record.released || this.#isSessionBridged(record))
          return refused("worker-restart-user-only");
        this.#validate(record);
        if (request.workspaceId !== record.workspaceId) return refused("workspace-not-allowed");
        if (managedSessionHasUnknownCommands(this.dataDir, id))
          return refused("control-outcome-unconfirmed", "unknown");
        const runner = this.#runners.get(id);
        const pid = runner?.processId;
        if (!runner?.hasWorker || !this.#ownerLocks.has(id) || pid == null)
          return refused("worker-restart-not-ready");

        const live = await this.#live(id, true);
        const owner = await this.#ownership.check(record.nativeId, pid, this.#freshObservation());
        if (owner.kind !== "idle") return refused("worker-restart-user-only");
        const snapshot = runner.snapshot();
        if (live.status === "outcome-unknown" || snapshot.status === "outcome-unknown")
          return refused("control-outcome-unconfirmed", "unknown");
        if (live.executionLocation === "external" || this.#isSessionBridged(record))
          return refused("worker-restart-user-only");
        if (
          this.#shuttingDown ||
          this.#runners.get(id) !== runner ||
          runner.processId !== pid ||
          live.workspaceId !== record.workspaceId ||
          live.executionLocation !== "agentkib" ||
          live.ownershipReason ||
          this.#starting.has(id)
        )
          return refused("worker-restart-not-ready");
        const hostRevision = this.#hostState.peek(id)?.revision ?? 0;
        if (
          request.expectedRevision !== live.revision ||
          request.expectedRevision !== snapshot.revision + hostRevision ||
          request.turnId !== (snapshot.turnId || null)
        )
          return refused("stale-Claude-revision");

        await runner.restartForDelegation(snapshot.revision, () => {
          const prior = receipt.claim(id, deviceId, {
            operation: value.operation,
            workspaceId: record.workspaceId,
            executionMode: "claude-managed",
            runtimeBootId: this.bootId,
            expectedRevision: request.expectedRevision,
            turnId: request.turnId,
          });
          if (prior) {
            replay = prior as WorkerRestartResult;
            throw new Error("worker-restart-already-claimed");
          }
          finishReceipt = receipt.finish;
          beforeDispatch();
          receipt.dispatch();
          dispatched = true;
        });
        if (runner.hasWorker) throw new Error("control-outcome-unconfirmed");
        if (snapshot.status !== "idle" && snapshot.turnId) {
          new ReadStateLedger(this.dataDir).record(
            conversationReadKey("claude-code", record.home, record.nativeId),
            {
              id: `turn:${snapshot.turnId}`,
              turnId: snapshot.turnId,
              itemId: null,
              outcome: "cancelled",
              completedAt: new Date().toISOString(),
            },
          );
          this.#hostState.complete(id, snapshot.turnId, {
            success: false,
            usage: null,
            cancelled: true,
          });
        }
        this.invalidateSchedulePermits(id);
        await this.#goalEndpoints.get(id)?.close();
        this.#goalEndpoints.delete(id);
        await this.#retireGoalRunner(id);
        const result = {
          accepted: true,
          completed: true,
          controlOutcome: "accepted",
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
        } as const;
        receipt.finish(result);
        return result;
      } catch (error) {
        if (replay) return replay;
        if (dispatched) return refused("control-outcome-unconfirmed", "unknown");
        const result = refused(error instanceof Error ? error.message : "worker-restart-failed");
        finishReceipt?.(result);
        return result;
      }
    });
  }

  /** Bounded identity discovery for a borrowed native host; this never transfers execution. */
  async nativeBridgeTarget(id: string, nativeId?: string, activeWorkspace?: string) {
    const record = this.#load(id);
    this.#assertBridgeAvailable(id, record);
    if (record) {
      this.#validate(record);
      if (nativeId && nativeId !== record.nativeId) throw new Error("unverified-session-identity");
      this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
      return {
        sessionId: id,
        nativeId: record.nativeId,
        workspaceId: record.workspaceId,
        workspace: record.workspace,
        registeredWorkspace: canonicalize(this.store.workspacePath(record.workspaceId)),
      };
    }
    const indexed = this.store.sessions.get(id);
    if (!indexed || indexed.agent !== "claude-code" || indexed.sidechain)
      throw new Error("session-not-controllable");
    if (nativeId && this.store.sessions.id("claude-code", nativeId) !== id)
      throw new Error("unverified-session-identity");
    const registeredWorkspace = canonicalize(this.store.workspacePath(indexed.workspace_id));
    if (!nativeId) {
      const listing = await this.sessions.list("claude-code", registeredWorkspace);
      nativeId = listing.sessions.find(
        (candidate) =>
          this.store.sessions.id("claude-code", candidate.native_ref) === id &&
          !candidate.sidechain,
      )?.native_ref;
    }
    if (!nativeId) throw new Error("session-unavailable");
    const sourceWorkspace = this.sessions.claudeControlWorkspace(nativeId, registeredWorkspace);
    const workspace = activeWorkspace ?? sourceWorkspace;
    this.#verifyClaudeBridgeWorkspace(nativeId, sourceWorkspace, workspace);
    this.#assertBridgeAvailable(id, record, nativeId, workspace);
    return {
      sessionId: id,
      nativeId,
      workspaceId: indexed.workspace_id,
      workspace,
      registeredWorkspace,
    };
  }

  validateNativeBridgeTarget(
    target: {
      sessionId: string;
      nativeId: string;
      workspaceId: string;
      workspace: string;
      registeredWorkspace: string;
    },
    forControl: boolean,
    bindingId?: string,
  ): void {
    const record = this.#load(target.sessionId);
    this.#assertBridgeAvailable(
      target.sessionId,
      record,
      target.nativeId,
      target.workspace,
      bindingId ? { bindingId, workspaceId: target.workspaceId } : undefined,
    );
    if (record) {
      this.#validate(record);
      if (
        record.nativeId !== target.nativeId ||
        record.workspaceId !== target.workspaceId ||
        record.workspace !== target.workspace ||
        canonicalize(this.store.workspacePath(record.workspaceId)) !== target.registeredWorkspace
      )
        throw new Error("unverified-session-identity");
      if (forControl) this.sessions.verifiedClaudeControlTarget(target.nativeId, target.workspace);
      return;
    }
    const indexed = this.store.sessions.get(target.sessionId);
    if (
      !indexed ||
      indexed.agent !== "claude-code" ||
      indexed.sidechain ||
      indexed.workspace_id !== target.workspaceId ||
      this.store.sessions.id("claude-code", target.nativeId) !== target.sessionId ||
      canonicalize(this.store.workspacePath(target.workspaceId)) !== target.registeredWorkspace ||
      canonicalize(target.workspace) !== target.workspace
    )
      throw new Error("unverified-session-identity");
    if (forControl) {
      const sourceWorkspace = this.sessions.claudeControlWorkspace(
        target.nativeId,
        target.registeredWorkspace,
      );
      this.#verifyClaudeBridgeWorkspace(target.nativeId, sourceWorkspace, target.workspace);
    }
  }

  #verifyClaudeBridgeWorkspace(nativeId: string, source: string, workspace: string): void {
    if (source === workspace) this.sessions.verifiedClaudeControlTarget(nativeId, source);
    else this.sessions.verifyClaudeBridgeWorktree(nativeId, source, workspace);
  }

  #assertBridgeAvailable(
    id: string,
    record: ClaudeRecord | null,
    nativeId = record?.nativeId,
    workspace = record?.workspace,
    binding?: { bindingId: string; workspaceId: string },
  ): void {
    if (this.#shuttingDown) throw new Error("session-unavailable");
    const aliases = new Map([[id, record]]);
    if (nativeId)
      for (const other of this.#listRecords())
        if (
          other.nativeId === nativeId &&
          (other.workspace === workspace ||
            (workspace !== undefined &&
              path.dirname(workspace) === path.join(other.workspace, ".claude", "worktrees"))) &&
          other.home === this.#home()
        )
          aliases.set(other.id, other);
    for (const [alias, candidate] of aliases) {
      const runner = this.#runners.get(alias);
      if (
        (candidate?.terminalHandover && !candidate.released) ||
        runner?.hasWorker ||
        runner?.isRetiring ||
        this.#starting.has(alias)
      )
        throw new Error("session-already-managed");
      if (
        readUnknownManagedCommands(this.dataDir, alias).some((command) => {
          const evidence = command.evidence;
          // An authenticated terminal may report completion of its own dispatched command.
          // Admission and managed startup still reject every unresolved command.
          return !(
            binding &&
            alias === id &&
            evidence?.executionMode === "claude-follower" &&
            evidence.bindingId === binding.bindingId &&
            evidence.nativeId === nativeId &&
            evidence.workspaceId === binding.workspaceId
          );
        }) ||
        (candidate && candidate.snapshot.status !== "idle")
      )
        throw new Error("control-outcome-unconfirmed");
    }
  }

  async receipt(value: unknown, deviceId: string): Promise<unknown> {
    if (
      !isObject(value) ||
      value.found !== true ||
      value.executionMode !== "claude-managed" ||
      typeof value.sessionId !== "string" ||
      typeof value.requestId !== "string"
    )
      return value;
    const record = this.#load(value.sessionId);
    if (!record) return value;
    if (
      isPendingNativeReceipt(value) &&
      value.workspaceId === record.workspaceId &&
      ["send", "steer", "queue-steer"].includes(value.operation)
    ) {
      try {
        this.#validate(record);
        const file = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
        if (claudePromptRecorded(file, record.nativeId, value.requestId)) {
          const recovered = acceptNativeControlReceipt(this.dataDir, deviceId, value);
          if (!isPendingNativeReceipt(recovered)) {
            this.#setCatalogUnconfirmed(
              record.id,
              managedSessionHasUnknownCommands(this.dataDir, record.id),
            );
            return recovered;
          }
        }
      } catch {
        // An unavailable or still unwritten transcript supplies no evidence.
      }
    }
    await this.request({ operation: "live", sessionId: value.sessionId }).catch(() => {
      // Live refresh can recover more evidence, but the device's durable receipt remains valid.
    });
    const current = this.#load(value.sessionId);
    const completionObserved = Boolean(
      current?.completedRequests.includes(value.requestId) ||
      (["steer", "queue-steer"].includes(String(value.operation)) &&
        value.status === "accepted" &&
        typeof value.turnId === "string" &&
        current?.completedRequests.includes(value.turnId)) ||
      this.#hostState.read(value.sessionId).settledRequests.includes(value.requestId),
    );
    const receipt: Record<string, any> = { ...value, completionObserved };
    if (typeof value.ack?.publicInputHash === "string")
      receipt.publicInputHash = value.ack.publicInputHash;
    if (completionObserved && value.operation === "send" && value.status === "unknown" && current) {
      receipt.ack = {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: value.requestId,
        sessionId: current.id,
        sourceSessionId: current.nativeId,
        runtimeBootId: typeof value.runtimeBootId === "string" ? value.runtimeBootId : this.bootId,
        completionObserved: true,
      };
      receipt.status = "accepted";
    }
    return receipt;
  }

  #recoverCompletions(record: ClaudeRecord): void {
    if (record.completedRequests.length === 0) return;
    let unconfirmed = false;
    for (const command of readUnknownManagedCommands(this.dataDir, record.id)) {
      if (
        command.evidence?.operation !== "send" ||
        !record.completedRequests.includes(command.requestId)
      ) {
        unconfirmed = true;
        continue;
      }
      finishManagedCommand(this.dataDir, command.requestId, {
        accepted: true,
        completed: true,
        controlOutcome: "accepted",
        requestId: command.requestId,
        sessionId: record.id,
        sourceSessionId: record.nativeId,
        runtimeBootId:
          typeof command.evidence.runtimeBootId === "string"
            ? command.evidence.runtimeBootId
            : this.bootId,
        completionObserved: true,
      });
    }
    // The existing completion scan is authoritative for the remaining ledger
    // identities. An ordinary idle frame alone cannot clear another host's fence.
    this.#setCatalogUnconfirmed(record.id, unconfirmed);
  }

  async capabilities(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    const version = supportsClaudeManagedRunner() && (await this.#installationVersion()) !== null;
    const owned = Boolean(record && !record.released);
    const continuable = !live.ownershipReason && live.status !== "outcome-unknown";
    const host = owned ? this.#hostState.read(id) : null;
    const writable = version && controls && owned && live.status !== "outcome-unknown";
    const idle =
      writable && live.status === "idle" && live.activity !== "compacting" && !live.ownershipReason;
    const unconfirmed = managedSessionHasUnknownCommands(this.dataDir, id);
    const inactiveDraft =
      version && controls && this.#inactiveDraftAvailable(id, live) && !unconfirmed;
    const readableResources =
      (owned && (this.#runners.get(id)?.hasWorker || !unconfirmed)) || inactiveDraft;
    const goalBudgetReason =
      host?.goal && host.goal.tokenBudget !== null
        ? host.goal.usageIncomplete
          ? "usage-unavailable"
          : host.goal.tokensUsed >= host.goal.tokenBudget
            ? "token-budget-exhausted"
            : null
        : null;
    const map: Record<string, boolean> = {
      send: version && controls && continuable && live.sendEnabled === true,
      stop: writable && live.stopEnabled === true,
      steer:
        writable &&
        !live.ownershipReason &&
        live.status === "running" &&
        live.activity !== "compacting",
      approve:
        writable &&
        !live.ownershipReason &&
        Array.isArray(live.approvals) &&
        live.approvals.length > 0,
      answer:
        writable &&
        !live.ownershipReason &&
        Array.isArray(live.questions) &&
        live.questions.length > 0,
      attachments: (writable || inactiveDraft) && live.activity !== "compacting",
      files: true,
      release: idle,
      inspect: true,
      reconcile: owned,
      usage: true,
      context: readableResources,
      resources: readableResources,
      settings: idle || inactiveDraft || (writable && this.#canStageRunningSettings(id, live)),
      "settings-state": owned || inactiveDraft,
      queue: writable,
      "queue-list": owned,
      "queue-add": writable,
      "queue-update": writable,
      "queue-steer":
        writable &&
        !unconfirmed &&
        !live.ownershipReason &&
        live.status === "running" &&
        live.activity !== "compacting" &&
        this.#runners.get(id)?.hasWorker === true,
      "queue-delete": writable,
      "queue-reorder": writable,
      "queue-resume": idle && host?.paused === true,
      "queue-pause": writable && host?.paused !== true,
      "usage-limit-cancel": writable && typeof host?.usageLimit?.continueAt === "number",
      "usage-limit-continue":
        writable && !live.ownershipReason && usageLimitArmable(host?.usageLimit, this.bootId),
      fork:
        version &&
        controls &&
        live.status === "idle" &&
        live.activity !== "compacting" &&
        record?.fresh !== true,
      rename: owned
        ? idle && supportsClaudeVersion(this.#version?.value ?? "", "2.1.286")
        : controls,
      goal: owned,
      "goal-draft": inactiveDraft && (!owned || !idle),
      "goal-set": idle,
      "goal-pause": writable && host?.goal?.status === "active",
      "goal-resume":
        idle &&
        !!host?.goal &&
        !goalBudgetReason &&
        ["paused", "blocked", "budget-exhausted"].includes(host.goal.status),
      "goal-clear": writable && !!host?.goal,
    };
    if (!supportsClaudeVersion(this.#version?.value ?? "", "2.1.286")) {
      // Reading the queue only needs the local ledger.
      for (const feature of [
        "steer",
        "settings",
        "settings-state",
        "queue",
        "queue-add",
        "queue-update",
        "queue-steer",
        "queue-delete",
        "queue-reorder",
        "queue-resume",
        "queue-pause",
        "usage-limit-cancel",
        "usage-limit-continue",
        "fork",
        "goal",
        "goal-draft",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "context",
        "resources",
      ])
        map[feature] = false;
    }
    const features: Record<string, { available: boolean; reason?: unknown }> = Object.fromEntries(
      Object.entries(map).map(([key, available]) => [
        key,
        available
          ? { available: true }
          : {
              available: false,
              reason:
                key === "goal-resume" && goalBudgetReason
                  ? goalBudgetReason
                  : !version
                    ? "unverified-installation"
                    : !owned
                      ? (live.reason ?? "operation-unavailable")
                      : (live.ownershipReason ?? "operation-unavailable"),
            },
      ]),
    );
    // Deleting needs no worker. It waits for AgentKib's own to be idle, and refuses while
    // Claude Code or Claude Desktop still has the session.
    const nativeId = record?.nativeId ?? live.sourceSessionId;
    const desktopClaimed = this.#desktopClaimed(nativeId);
    const deleteReason = !supportsClaudeManagedRunner()
      ? "platform-unsupported"
      : !version
        ? "unverified-installation"
        : !controls
          ? "control-disabled"
          : live.status === "outcome-unknown" ||
              readUnknownManagedCommands(this.dataDir, id).some(
                (command) => command.evidence?.operation !== "delete",
              )
            ? "control-outcome-unconfirmed"
            : typeof live.ownershipReason === "string"
              ? live.ownershipReason
              : this.#starting.has(id) ||
                  (this.#runners.has(id) &&
                    (live.status !== "idle" || live.activity === "compacting"))
                ? "session-busy"
                : desktopClaimed === null
                  ? "claude-desktop-check-unavailable"
                  : desktopClaimed
                    ? "claude-desktop-session"
                    : null;
    features.delete = deleteReason
      ? { available: false, reason: deleteReason }
      : { available: true };
    return {
      sessionId: id,
      executionMode: live.executionMode,
      status: live.status,
      reason: live.reason,
      // For the `/` menu. Clients filter it with the rules the backend enforces on send.
      commands: this.#commandCatalog(id),
      features,
    };
  }

  /** Whether a Claude Desktop record names this session; null when its records cannot be read. */
  #desktopClaimed(nativeId: unknown): boolean | null {
    if (typeof nativeId !== "string") return null;
    if (!this.#desktopClaims || Date.now() - this.#desktopClaims.at >= 10_000) {
      let claims: Set<string> | null;
      try {
        claims = claudeDesktopClaims(claudeDesktopSessionRecords(this.environment));
      } catch {
        claims = null;
      }
      this.#desktopClaims = { at: Date.now(), claims };
    }
    return this.#desktopClaims.claims?.has(nativeId.toLowerCase()) ?? null;
  }

  async inspect(id: string, controls = false): Promise<Record<string, unknown>> {
    const live = await this.#live(id, controls);
    const record = this.#load(id);
    if (record?.fresh)
      return {
        sessionId: id,
        live,
        workspaceId: record.workspaceId,
        sourceSessionId: record.nativeId,
        reconciled: false,
      };
    const target = this.#nativeTarget(id, true);
    return {
      sessionId: id,
      workspaceId: target.workspaceId,
      sourceSessionId: target.nativeId,
      live,
      reconciled: false,
    };
  }

  async resumeCommand(id: string) {
    const target = async () => {
      const native = this.#nativeTarget(id, true);
      const config = this.#home();
      const configOverridden = isClaudeConfigDirSet(this.environment);
      const directories = [native.workspace, config].map((directory) => {
        const info = lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("claude-context-unavailable");
        return [pathIdentity(directory), info.dev, info.ino];
      });
      return {
        ...native,
        config,
        configOverridden,
        key: JSON.stringify([native.workspaceId, native.nativeId, directories, configOverridden]),
      };
    };
    const before = await target();
    const after = await target();
    if (before.key !== after.key) throw new Error("session-unavailable");
    // Generating a command must remain possible on unsupported CLI/platforms and
    // while another client owns the session. It never checks out a runner or a lease.
    return claudeResumeCommand(
      after.workspace,
      after.configOverridden ? after.config : undefined,
      after.nativeId,
    );
  }

  async context(id: string): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const native = record ? null : this.sessions.verifiedClaudeReadSource(id);
    if (native?.directoryMissing) throw new Error("session-directory-missing");
    const workspace = record ? (this.#validate(record), record.workspace) : native!.workspace;
    let sourceFile: string | null = null;
    if (!record?.fresh) {
      try {
        sourceFile = this.sessions.verifiedClaudeControlTarget(
          record?.nativeId ?? native!.nativeId,
          workspace,
        );
      } catch {
        // The source is optional display metadata. If it cannot be verified, omit
        // it without blocking the workspace context validated above. Never infer
        // a path or relax the separate control-path identity checks.
      }
    }
    return { available: true, cwd: workspace, sourceFile, projectId: null, branchAtCreation: null };
  }

  /** `retain` false keeps no cursor for the page, for stream snapshots (see SessionPaging.read). */
  async image(id: string, imageId: string) {
    const record = this.#load(id);
    if (!record || record.fresh) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    this.#validate(record);
    const result = await this.sessions.imageForNative(
      "claude-code",
      record.nativeId,
      record.workspace,
      imageId,
    );
    const latest = this.#load(id);
    if (
      !latest ||
      latest.nativeId !== record.nativeId ||
      latest.workspace !== record.workspace ||
      latest.workspaceId !== record.workspaceId ||
      latest.home !== record.home
    )
      throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
    this.#validate(latest);
    return result;
  }

  async endedTurns(id: string): Promise<LaneEndedTurn[]> {
    const record = this.#load(id);
    if (record) this.#validate(record);
    const native = record ? undefined : this.sessions.verifiedClaudeReadSource(id);
    const nativeId = record?.nativeId ?? native!.nativeId;
    const home =
      record?.home ?? resolveClaudeConfig(this.environment, userHome(this.environment)).dir;
    const transcript =
      record && !record.fresh
        ? this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace)
        : native?.transcript;
    const observed = new ReadStateLedger(this.dataDir)
      .recentTerminalResults(conversationReadKey("claude-code", home, nativeId))
      .flatMap(({ result, startedAt }): LaneEndedTurn[] =>
        result.turnId && result.completedAt
          ? [
              {
                turnId: result.turnId,
                outcome: result.outcome === "ended" ? "completed" : result.outcome,
                startedAt,
                endedAt: result.completedAt,
                ...(result.itemId ? { historyTurnId: result.itemId } : {}),
              },
            ]
          : [],
      );
    const history = transcript ? claudeWorkerHistoryTurns(transcript, nativeId) : [];
    return [
      ...observed.filter((turn) => turn.startedAt !== null),
      ...claudeWorkerUnobservedTurns(history, observed),
    ]
      .sort((a, b) => Date.parse(a.endedAt!) - Date.parse(b.endedAt!))
      .slice(-50);
  }

  #mayAwaitFirstTranscript(record: ClaudeRecord): boolean {
    return !record.adopted && !record.forkSourceNativeId && record.fingerprint === null;
  }

  async events(id: string, cursor: unknown, limit: unknown, retain = true): Promise<unknown> {
    const record = this.#load(id);
    if (record) {
      this.#validate(record);
      if (record.fresh) return { events: [], next_cursor: null, warnings: [] };
      const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
      const page =
        typeof cursor !== "string" && this.#mayAwaitFirstTranscript(record)
          ? await this.sessions.claudeFirstEvents(record.nativeId, record.workspace, count, retain)
          : await this.sessions.eventsForNative(
              "claude-code",
              record.nativeId,
              record.workspace,
              typeof cursor === "string" ? cursor : null,
              count,
              undefined,
              retain,
            );
      const runner = typeof cursor !== "string" ? this.#runners.get(id) : undefined;
      const firstTurn = runner?.firstTurnItems() ?? [];
      if (!page) return { events: firstTurn.slice(-count), warnings: [] };
      const history = this.#withTurnEnds(record.nativeId, page);
      if (firstTurn.length && history.next_cursor === null) {
        const ids = new Set(history.events.map((item) => item.id));
        const pending = firstTurn.filter((item) => !ids.has(String(item.id)));
        if (pending.length)
          // The verified file may already have the prompt and still be waiting for its reply.
          return {
            events: [
              ...pending.filter((item) => item.kind === "user-message"),
              ...history.events,
              ...pending.filter((item) => item.kind === "agent-message"),
            ].slice(-count),
            warnings: history.warnings,
          };
        runner?.forgetFirstTurnItems();
      }
      return history;
    }
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
    return this.sessions.claudeEventsForSession(
      id,
      typeof cursor === "string" ? cursor : null,
      count,
      retain,
    );
  }

  /** Read-only children are always resolved from this verified parent, never from a supplied path. */
  async subagents(id: string, value: Record<string, unknown>): Promise<unknown> {
    const childId = value.operation === "subagent-events" ? value.subagentId : undefined;
    if (childId !== undefined && (typeof childId !== "string" || !/^[a-f0-9]{64}$/.test(childId)))
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    if (
      value.cursor !== undefined &&
      value.cursor !== null &&
      (typeof value.cursor !== "string" || value.cursor.length > 1024)
    )
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    if (
      value.limit !== undefined &&
      (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)
    )
      throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
    const record = this.#load(id);
    const runner = this.#runners.get(id);
    let parent: SubagentParent;
    if (record) {
      this.#validate(record);
      parent = {
        sessionId: id,
        nativeId: record.nativeId,
        workspace: record.workspace,
        agent: "claude-code",
        transcript: record.fresh
          ? ""
          : this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace),
      };
    } else {
      const source = this.sessions.verifiedClaudeReadSource(id);
      parent = {
        sessionId: id,
        nativeId: source.nativeId,
        workspace: source.workspace,
        transcript: source.transcript,
        agent: "claude-code",
      };
    }
    const observed = (runner?.snapshot() ?? record?.snapshot)?.subagents;
    const observations: SubagentObservation[] = Array.isArray(observed)
      ? observed.map((entry: SubagentObservation) => ({
          ...entry,
          // A saved spawn is not proof that its worker survived this backend process.
          ...(!runner?.hasWorker &&
          ["starting", "running", "waiting-input", "waiting-approval"].includes(entry.status)
            ? { status: "unknown" as const, readable: false }
            : {}),
        }))
      : [];
    const cursor = typeof value.cursor === "string" ? value.cursor : null;
    const limit = typeof value.limit === "number" ? value.limit : 50;
    if (typeof childId !== "string")
      return this.sessions.subagentsForNative(parent, undefined, null, limit, observations);
    const callId = this.sessions.subagentObservationId(parent, childId, observations);
    const memory = callId ? runner?.subagentEvents(callId) : null;
    if (!cursor?.startsWith("subagent-memory-v1:")) {
      try {
        return await this.sessions.subagentsForNative(parent, childId, cursor, limit, observations);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== REMOTE_ERROR_CODES.subagentUnavailableDetail ||
          !memory
        )
          throw error;
      }
    }
    if (memory && (cursor === null || cursor.startsWith("subagent-memory-v1:"))) {
      const epoch = createHmac("sha256", this.store.sessions.identitySalt())
        .update(
          JSON.stringify([
            "subagent-memory",
            parent.sessionId,
            parent.nativeId,
            childId,
            runner!.subagentEpoch,
          ]),
        )
        .digest("hex");
      const prefix = `subagent-memory-v1:${childId}:${epoch}:`;
      if (cursor && !cursor.startsWith(prefix))
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      const encoded = cursor?.slice(prefix.length);
      if (encoded !== undefined && !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorInvalid);
      const anchor = encoded ? Buffer.from(encoded, "base64url").toString("utf8") : null;
      const offset =
        anchor === null ? memory.length : memory.findIndex((item) => item.id === anchor);
      if (offset < 0) throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      const start = Math.max(0, offset - limit);
      return {
        version: 1,
        sessionId: id,
        subagentId: childId,
        epoch,
        events: memory.slice(start, offset),
        next_cursor: start ? prefix + Buffer.from(memory[start].id).toString("base64url") : null,
        warnings: ["SUBAGENT_LIVE_WINDOW"],
      };
    }
    return this.sessions.subagentsForNative(parent, childId, cursor, limit, observations);
  }

  /** Only invalidates observation projections; never proves ownership or control admission. */
  async historyVersion(id: string): Promise<string | null> {
    const record = this.#load(id);
    const indexed = this.store.sessions.get(id);
    const indexedIdentity = indexed
      ? [
          indexed.agent,
          indexed.workspace_id,
          indexed.sidechain,
          this.store.workspacePath(indexed.workspace_id),
        ]
      : null;
    let transcript: string;
    let identity: unknown[];
    if (record) {
      this.#validate(record);
      identity = [
        record.createdAt,
        record.nativeId,
        record.workspaceId,
        record.workspace,
        record.home,
        record.fresh,
      ];
      if (record.fresh) return JSON.stringify([id, indexedIdentity, identity, "empty"]);
      // Stored turn ends are part of what a history read returns.
      identity.push(this.#turnMetaRevisions.get(id) ?? 0);
      const verified = this.#mayAwaitFirstTranscript(record)
        ? this.sessions.claudeFirstTranscript(record.nativeId, record.workspace)
        : this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
      // The first turn's live projection can change independently of the native transcript.
      if (!verified || this.#runners.get(id)?.firstTurnItems().length) return null;
      transcript = verified;
    } else {
      const source = this.sessions.verifiedClaudeReadSource(id);
      transcript = source.transcript;
      identity = [source.nativeId, source.workspaceId, source.workspace];
    }
    const stat = lstatSync(transcript, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid-Claude-transcript");
    return JSON.stringify([
      id,
      indexedIdentity,
      identity,
      transcript,
      ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String),
    ]);
  }

  #rememberConfirmedOptions(id: string): void {
    const runner = this.#runners.get(id);
    if (!runner?.hasWorker) return;
    const native = runner.optionsSnapshot;
    if (!native.settingsAcknowledged) return;
    const host = this.#hostState.read(id);
    const { settingsAcknowledged: _acknowledged, ...options } = native;
    let permissionMode: ClaudeObservedPermissionMode | null;
    try {
      permissionMode = runner.observedPermissionMode;
    } catch {
      // Permission is a display-only observation; a broken view cannot fail a turn.
      permissionMode = host.lastConfirmedOptions?.permissionMode ?? null;
    }
    const confirmed = {
      options,
      selection: this.#runnerSelections.get(runner) ?? host.settings,
      permissionMode,
    };
    // Native frames frequently repeat identical settings. They must not advance the CAS
    // revision or turn a harmless read into a steady stream of host-state mutations.
    if (stableJson(host.lastConfirmedOptions) === stableJson(confirmed)) return;
    this.#hostState.update(id, (state) => {
      state.lastConfirmedOptions = structuredClone(confirmed);
    });
  }

  async #prepareSettings(value: Record<string, unknown>, id: string) {
    const allowed = new Set([
      "operation",
      "sessionId",
      "deviceId",
      "runtimeBootId",
      "expectedRevision",
      "experimentalEnabled",
    ]);
    if (
      !validClaudeDeviceId(value.deviceId) ||
      value.runtimeBootId !== this.bootId ||
      value.experimentalEnabled !== true ||
      typeof value.expectedRevision !== "number" ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-settings-prepare");
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    const cliVersion = await this.#installationVersion();
    if (!cliVersion || !supportsClaudeVersion(cliVersion, "2.1.286"))
      throw new Error("unsupported-Claude-version");
    if (!this.#runners.get(id)?.hasWorker) {
      const { source } = await this.#inactiveSettingsSource(id, value.expectedRevision);
      const catalog = await this.#readNewSessionCatalog(source.workspace, cliVersion);
      if (!catalog?.settingsAcknowledged) throw new Error("claude-startup-models-unavailable");
      await this.#inactiveSettingsSource(id, value.expectedRevision, source);
      return this.settingsState(id, catalog);
    }
    const owned = this.#ownerLocks.has(id);
    if (!owned) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    try {
      // The record may have changed while acquiring the lease. As with send, validate the
      // authoritative record after acquiring it before any process is prepared.
      let record = this.#load(id);
      if (!record || record.released) throw new Error("session-unavailable");
      this.#validate(record);
      const live = await this.#live(id, true);
      if (live.status === "outcome-unknown" || managedSessionHasUnknownCommands(this.dataDir, id))
        throw new Error("control-outcome-unconfirmed");
      if (live.revision !== value.expectedRevision) throw new Error("stale-Claude-revision");
      if (live.status !== "idle" || live.activity === "compacting") throw new Error("session-busy");
      if (live.ownershipReason) throw new Error(String(live.ownershipReason));
      // The live read can recover a proved, interrupted startup. Prepare from that durable
      // revision rather than the pre-recovery snapshot captured above.
      record = this.#load(id);
      if (!record || record.released) throw new Error("session-unavailable");
      this.#validate(record);
      const publishCurrentState = async () => {
        const currentLive = await this.#live(id, true);
        this.#publishConversationEvent?.(id, "state", currentLive, currentLive);
      };
      try {
        await this.#prepareRunner(record);
      } catch (error) {
        // A fresh startup probe can reject ownership after the cached idle preflight.
        this.#forgetOwnership(id);
        try {
          await publishCurrentState();
        } catch {
          // A failed best-effort notification must not replace the original startup error.
        }
        throw error;
      }
      // Success and cleanup callbacks run before the startup guard clears. Publish the
      // authoritative terminal state afterward, including any new unknown/owner fence.
      await publishCurrentState();
      return this.settingsState(id);
    } finally {
      if (!owned && !this.#runners.has(id)) {
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }
    }
  }

  #inactiveDraftAvailable(id: string, live: Record<string, unknown>): boolean {
    const ownership = live.ownershipReason;
    const externalOwner =
      ownership === "claude-owner-busy" ||
      ownership === "claude-background-session-running" ||
      ownership === "owner-opened-elsewhere";
    return (
      !this.#runners.get(id)?.hasWorker &&
      live.status === "idle" &&
      live.activity !== "compacting" &&
      (!ownership || externalOwner) &&
      (!live.reason || (externalOwner && live.reason === ownership))
    );
  }

  async #inactiveSettingsSource(
    id: string,
    expectedRevision: number,
    previous?: {
      workspaceId: string;
      workspace: string;
      nativeId: string;
      generation: string | null;
    },
  ) {
    this.#forgetOwnership(id);
    const live = await this.#live(id, true);
    const record = this.#load(id);
    if (this.#runners.get(id)?.hasWorker) throw new Error("stale-Claude-revision");
    if (managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    if (live.revision !== expectedRevision) throw new Error("stale-Claude-revision");
    if (!this.#inactiveDraftAvailable(id, live))
      throw new Error(typeof live.reason === "string" ? live.reason : "session-busy");
    if (record) this.#validate(record);
    const native = record ? null : this.sessions.verifiedClaudeReadSource(id);
    const source = {
      workspaceId: record?.workspaceId ?? native!.workspaceId,
      workspace: record?.workspace ?? native!.workspace,
      nativeId: record?.nativeId ?? native!.nativeId,
      generation: record ? stableJson([record.createdAt, record.released, record.fresh]) : null,
    };
    if (
      native?.directoryMissing ||
      source.nativeId !== live.sourceSessionId ||
      source.workspaceId !== live.workspaceId ||
      (previous &&
        (source.nativeId !== previous.nativeId ||
          source.workspaceId !== previous.workspaceId ||
          source.generation !== previous.generation ||
          pathIdentity(source.workspace) !== pathIdentity(previous.workspace)))
    )
      throw new Error("unverified-session-identity");
    return { source, live };
  }

  /** Without a worker, settings are applied when the next turn restores the native session. */
  async #stageInactiveSettings(value: Record<string, unknown>, id: string) {
    this.#privateDirectory(true);
    if (!this.#ownerLocks.has(id)) {
      const release = this.#tryLock(id);
      if (!release) throw new Error("session-managed-by-another-runtime");
      this.#ownerLocks.set(id, release);
    }
    const expectedRevision = value.expectedRevision as number;
    const { source } = await this.#inactiveSettingsSource(id, expectedRevision);
    const state = this.#hostState.read(id);
    let next = this.#settings(value, state.settings);
    if (
      value.permissionMode !== undefined ||
      value.model !== undefined ||
      value.resetDefaults === true
    )
      this.#startupDiscovery.invalidateAutoPermission(source.workspace);
    if (
      value.resetDefaults !== true &&
      (value.model !== undefined || typeof value.effort === "string")
    ) {
      const version = await this.#installationVersion();
      if (!version || !supportsClaudeVersion(version, "2.1.286"))
        throw new Error("unsupported-Claude-version");
      const catalog = await this.#readNewSessionCatalog(source.workspace, version);
      if (!catalog?.settingsAcknowledged || !catalog.models.length)
        throw new Error("claude-startup-models-unavailable");
      const selected = next.model ?? catalog.settings.model;
      const model = selected ? claudeModelOption(catalog.models, selected) : undefined;
      if (next.model) {
        if (!model) throw new Error("unsupported-model");
        next = { ...next, model: model.value };
      }
      if (next.effort && !model?.supportedEffortLevels?.includes(next.effort))
        throw new Error("unsupported-effort");
    }
    if (
      next.permissionMode === "auto" &&
      (value.permissionMode === "auto" || value.model !== undefined) &&
      !(await this.#autoPermissionAvailable(
        source.workspace,
        next.model ?? this.#savedTranscriptModel(id) ?? null,
        true,
      ))
    )
      throw new Error("unsupported-permission-mode");
    const { live } = await this.#inactiveSettingsSource(id, expectedRevision, source);
    const result = this.#hostState.command(id, value, source.workspaceId, (host) => {
      // The public revision also includes the persisted native snapshot. The transaction
      // compares only the host baseline captured before the asynchronous catalog read.
      if (host.revision !== state.revision) throw new Error("stale-Claude-revision");
      host.settings = next;
      return { settings: next, appliesTo: "next-turn" };
    });
    // A retired runner retains its original launch overrides. Discard that inactive
    // configuration so the next send constructs a runner from the saved host settings.
    this.#runners.delete(id);
    this.#goalRunners.delete(id);
    this.#leadToolKeys.delete(id);
    const currentLive = {
      ...live,
      revision: expectedRevision + 1,
      settings: {
        ...(isObject(live.settings) ? live.settings : {}),
        selected: next,
        applicationStatus: "pending",
      },
    };
    this.#publishConversationEvent?.(id, "state", currentLive, currentLive);
    return result;
  }

  async settingsState(
    id: string,
    prepared?: ClaudeRunnerOptionsSnapshot,
  ): Promise<Record<string, unknown>> {
    const record = this.#load(id);
    const live = await this.#live(id, true);
    const cliVersion = await this.#installationVersion();
    if (!cliVersion || !supportsClaudeVersion(cliVersion, "2.1.286"))
      return { available: false, reason: "unsupported-Claude-version", revision: live.revision };
    const inactiveDraft =
      this.#inactiveDraftAvailable(id, live) && !managedSessionHasUnknownCommands(this.dataDir, id);
    const importedCatalog = inactiveDraft
      ? (prepared ??
        this.#cachedNewSessionCatalog(
          record?.workspace ?? this.sessions.verifiedClaudeReadSource(id).workspace,
          cliVersion,
        ))
      : undefined;
    const state = this.#hostState.read(id);
    const runner = this.#runners.get(id);
    const native = runner?.optionsSnapshot.settingsAcknowledged
      ? runner.optionsSnapshot
      : state.lastConfirmedOptions?.options;
    const selected = {
      model: state.settings.model ?? null,
      effort: state.settings.effort ?? null,
      permissionMode: state.settings.permissionMode ?? null,
    };
    const confirmed =
      live.status !== "outcome-unknown" &&
      (!runner?.hasWorker || runner.optionsSnapshot.settingsAcknowledged) &&
      native !== undefined &&
      stableJson(state.lastConfirmedOptions?.selection) === stableJson(state.settings);
    const current = native?.settings ?? { model: null, effort: null, permissionMode: null };
    const historicalModel =
      !runner?.hasWorker && !current.model ? this.#savedTranscriptModel(id) : undefined;
    const models = importedCatalog?.models ?? native?.models ?? [];
    const reportedDefault = importedCatalog?.settings.model;
    const defaultModel = reportedDefault ? claudeModelOption(models, reportedDefault) : undefined;
    const defaultEffort = importedCatalog?.settings.effort;
    const mutable =
      inactiveDraft ||
      (this.#runners.get(id)?.hasWorker === true &&
        record?.released === false &&
        !live.ownershipReason &&
        ((live.status === "idle" && live.activity !== "compacting") ||
          this.#canStageRunningSettings(id, live)));
    const autoModel = selected.model ?? current.model ?? historicalModel ?? reportedDefault;
    const autoOption = claudeModelOption(models, autoModel ?? "default");
    const autoAvailable =
      mutable &&
      autoOption?.supportsAutoMode === true &&
      this.#observeAutoPermission(
        id,
        record?.workspace ?? this.sessions.verifiedClaudeReadSource(id).workspace,
        cliVersion,
        autoModel ?? null,
      );
    return {
      available: true,
      executionMode: "claude-managed",
      revision: live.revision,
      tokenUsage: live.tokenUsage ?? null,
      current,
      selected,
      ...(historicalModel ? { historicalSettings: { model: historicalModel } } : {}),
      settings: selected,
      defaults: {
        model: defaultModel?.value ?? null,
        effort:
          defaultEffort && defaultModel?.supportedEffortLevels?.includes(defaultEffort)
            ? defaultEffort
            : null,
        permissionMode: null,
      },
      applicationStatus: confirmed ? "confirmed" : "pending",
      models: models.map((model) => ({
        id: model.value,
        ...(model.resolvedModel !== undefined ? { resolvedModel: model.resolvedModel } : {}),
        name: model.displayName,
        efforts: model.supportedEffortLevels ?? [],
      })),
      permissionModes: [
        ...CLAUDE_CREATION_PERMISSION_MODES.map((id) => ({ id, name: id })),
        { id: "auto", name: "auto", available: autoAvailable },
      ],
      writable: {
        model: { available: mutable && models.length > 0 },
        effort: {
          available: mutable && models.some((model) => model.supportedEffortLevels?.length),
        },
        permissionMode: { available: mutable },
        restoreDefaults: { available: mutable },
      },
      skills: [],
      plugins: [],
      apps: [],
      contextReferences: { supportedTypes: ["file", "directory", "skill"] },
    };
  }

  #nativeTarget(
    id: string,
    verifyStoredTranscript = false,
  ): Pick<ClaudeRecord, "workspaceId" | "workspace" | "nativeId"> {
    const managed = this.#load(id);
    if (managed) {
      this.#validate(managed);
      const { workspaceId, workspace, nativeId } = managed;
      if (verifyStoredTranscript && !managed.fresh)
        this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
      return { workspaceId, workspace, nativeId };
    }
    const { workspaceId, workspace, nativeId, directoryMissing } =
      this.sessions.verifiedClaudeReadSource(id);
    if (directoryMissing) throw new Error("session-directory-missing");
    if (this.store.sessions.get(id)?.availability !== "readable")
      throw new Error("session-unavailable");
    return { workspaceId, workspace, nativeId };
  }

  #resolveNative(id: string) {
    const target = this.#nativeTarget(id);
    const managed = this.#load(id);
    return {
      ...target,
      fingerprint: managed?.fresh
        ? this.#freshFingerprint(managed)
        : this.#targetFingerprint(target.nativeId, target.workspace),
    };
  }
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
