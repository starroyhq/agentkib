import { createHash, randomUUID } from "node:crypto";
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
import { claudeResumeCommand } from "./claude-resume-command";
import { ClaudeSessionOwnerProbe, type ClaudeOwnerObservationShare } from "./claude-session-owner";
import { resolveCommand } from "./command-resolution";
import { validHistoryControl } from "./history-control-schema";
import type { Commands } from "./commands";
import type { ClaudeControlMetadataShare, SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";
import { canonicalize, pathIdentity } from "./paths";
import { restrictRemotePath } from "./remote-tls";
import { acquirePortableFileLease } from "./managed-session-lock";
import { readClaudeVersion, supportsClaudeVersion } from "./claude-version";
import {
  CLAUDE_COMMAND_REFUSALS,
  claudeInputCommandRefusal,
  claudeModelOption,
  isClaudeCommandRefusal,
  type ClaudeCommandEntry,
  type ConversationTurnMeta,
} from "@agentkib/runtime-protocol";
import { terminationCodeOf } from "./claude-frame-policy";
import {
  claudeDesktopClaims,
  claudeDesktopSessionRecords,
  removeClaudeSessionFiles,
} from "./claude-session-files";
import { ClaudeTurnMetaStore } from "./claude-turn-meta";
import type { ConversationEventPage } from "./session-events";
import {
  assertClaudeConfigWritable,
  isClaudeConfigDirSet,
  resolveClaudeConfig,
} from "./claude-config";
import {
  ClaudeHostStateStore,
  validClaudeDeviceId,
  claudeCommandFingerprint,
  type ClaudeHostWork,
  type ClaudeSettings,
} from "./claude-host-state";
import { createClaudeGoalReportEndpoint } from "./claude-goal-report";
import { projectContextUsage } from "./context-usage";
import {
  ClaudeManagedRunnerProcess,
  ClaudeUndispatchedError,
  type ClaudeObservedPermissionMode,
  type ClaudeRunnerSnapshot,
  type ClaudeStartupCleanupProof,
  validateClaudeContent,
} from "./claude-managed-runner";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  replayManagedCommand,
  readUnknownManagedCommands,
  openManagedLedger,
} from "./managed-ledger";

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
  type: "state" | "text-delta" | "item-upsert" | "snapshot",
  payload: Record<string, unknown>,
  live: Record<string, unknown>,
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

export type ClaudeContinuationOptions = {
  idleTimeoutMs?: number;
  maintenanceIntervalMs?: number;
  isSessionObserved?: (sessionId: string) => boolean;
  isSessionBridged?: (sessionId: string) => boolean;
};

/** Manages Claude session ownership, CLI runners, and read-side state. */
export class ClaudeManagedReadOwner {
  #version?: { at: number; value: string | null };
  #runners = new Map<string, ClaudeManagedRunnerProcess>();
  #hostState: ClaudeHostStateStore;
  #turnMeta: ClaudeTurnMetaStore;
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
  #runnerReservations = new Set<string>();
  #runnerReservationTail: Promise<void> = Promise.resolve();
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
  // A live read can fence an otherwise idle runner because another host command
  // is unresolved. Catalog reads reuse that proof without opening the ledger.
  #catalogUnconfirmed = new Set<string>();
  #idleSince = new Map<string, number>();
  #observed = new Set<string>();
  #starting = new Set<string>();
  #activeHostClaims = new Map<string, string>();
  #continuationNotices = new Map<string, string>();
  #continuationNoticeIds = new Map<string, string>();
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
    const results = await Promise.allSettled(
      runners.map(async ([id, runner]) => {
        await runner.shutdown();
        if (this.#runners.get(id) !== runner) return;
        this.#runners.delete(id);
        this.#ownerLocks.get(id)?.();
        this.#ownerLocks.delete(id);
      }),
    );
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

  async request(value: unknown): Promise<unknown> {
    if (!isObject(value) || typeof value.operation !== "string") throw new Error("invalid-request");
    const id = typeof value.sessionId === "string" ? value.sessionId : undefined;
    if (value.operation === "schedule-pause" || value.operation === "schedule-invalidate")
      this.invalidateSchedulePermits(
        id,
        typeof value.deviceId === "string" ? value.deviceId : undefined,
      );
    if (this.#shuttingDown) throw new Error("session-unavailable");
    if (id && this.continuation.isSessionObserved?.(id)) this.#observed.add(id);
    const run = () => this.#requestLocked(value, id);
    return id ? this.#serializeSession(id, run) : run();
  }

  async #requestLocked(value: Record<string, any>, id?: string): Promise<unknown> {
    const readOperations = new Set([
      "live",
      "capabilities",
      "inspect",
      "context",
      "events",
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
      hasRecord && readOperations.has(value.operation) && !ownedHere && !hasRunner
        ? this.#tryLock(id!)
        : null;
    if (hasRecord && readOperations.has(value.operation) && !release && !ownedHere && !hasRunner)
      throw new Error("session-managed-by-another-runtime");
    if (release) this.#ownerLocks.set(id!, release);
    try {
      return await this.#requestRead(value, id);
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

  async #requestRead(value: Record<string, any>, id?: string): Promise<unknown> {
    switch (value.operation) {
      case "options":
        return this.options();
      case "create":
        return this.#create(value);
      case "adopt":
        if (!id) throw new Error("missing-session");
        return this.#adopt(value, id);
      case "release":
        if (!id) throw new Error("missing-session");
        return this.#release(value, id);
      case "send":
      case "steer":
      case "stop":
      case "approve":
      case "answer":
        if (!id) throw new Error("missing-session");
        return this.#control(value, id);
      case "live":
        if (!id) throw new Error("missing-session");
        return this.live(id, value.experimentalEnabled === true);
      case "capabilities":
        if (!id) throw new Error("missing-session");
        return this.capabilities(id, value.experimentalEnabled === true);
      case "inspect":
        if (!id) throw new Error("missing-session");
        return this.inspect(id, value.experimentalEnabled === true);
      case "resume-command":
        if (!id) throw new Error("missing-session");
        return this.resumeCommand(id);
      case "context":
        if (!id) throw new Error("missing-session");
        return this.context(id);
      case "events":
        if (!id) throw new Error("missing-session");
        return this.events(id, value.cursor, value.limit);
      case "settings-state":
        if (!id) throw new Error("missing-session");
        return this.settingsState(id);
      case "settings-prepare":
        if (!id) throw new Error("missing-session");
        return this.#prepareSettings(value, id);
      case "goal":
        if (!id) throw new Error("missing-session");
        await this.#live(id, false);
        return {
          available: true,
          goal: this.#hostState.read(id).goal,
          revision: (await this.#live(id, false)).revision,
          executionMode: "claude-managed",
        };
      case "resources":
        if (!id) throw new Error("missing-session");
        return this.#resources(id);
      case "queue-list":
        if (!id) throw new Error("missing-session");
        await this.#live(id, false);
        return this.#queue(id);
      case "schedule-list":
        return this.#scheduleList(id);
      case "schedule-invalidate":
        this.invalidateSchedulePermits(id, value.deviceId);
        return { ok: true };
      case "schedule-prepare":
      case "schedule-dispatch":
      case "schedule-pause":
      case "schedule-resume":
        if (!id) throw new Error("missing-session");
        return this.#schedule(value, id);
      case "settings":
      case "queue-add":
      case "queue-update":
      case "queue-delete":
      case "queue-reorder":
      case "queue-resume":
      case "queue-pause":
      case "rename":
      case "archive":
      case "unarchive":
      case "goal-set":
      case "goal-pause":
      case "goal-resume":
      case "goal-clear":
      case "fork":
        if (!id) throw new Error("missing-session");
        return this.#hostControl(value, id);
      case "usage": {
        if (!id) throw new Error("missing-session");
        const live = await this.#live(id, false);
        return {
          ...projectContextUsage(
            live.usage ?? { available: false, state: "unavailable" },
            Number(live.revision),
          ),
          executionMode: "claude-managed",
        };
      }
      case "reconcile":
        if (!id) throw new Error("missing-session");
        return this.#reconcile(value, id);
      case "delete":
        if (!id) throw new Error("missing-session");
        return this.#delete(value, id);
      default:
        throw new Error(`unsupported-Claude-managed-operation:${value.operation}`);
    }
  }

  async #control(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    try {
      return await this.#controlImpl(value, id);
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
      const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
      const prior = replayManagedCommand(this.dataDir, value.requestId, fingerprint);
      if (prior) return prior;
      const claimed = claimManagedCommand(
        this.dataDir,
        value.requestId,
        id,
        fingerprint,
        value.deviceId,
        {
          operation: value.operation,
          executionMode: "claude-managed",
          runtimeBootId: this.bootId,
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
        },
      );
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
      finishManagedCommand(this.dataDir, value.requestId, result);
      return result;
    }
  }

  async #controlImpl(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
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
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
    if (
      operation === "steer" &&
      !supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286")
    )
      throw new Error("unsupported-Claude-version");
    // Before adopting the session or pausing its goal, so a refused command changes nothing.
    if (operation === "send" || operation === "steer")
      assertClaudeCommandAllowed(
        value.input ?? (typeof value.text === "string" ? value.text : undefined),
        value.deviceId,
        this.#commandCatalog(id),
      );

    let record = this.#load(id);
    let adopted = false;
    if (operation === "send" && (!record || record.released)) {
      const previous = await this.#live(id, true);
      if (previous.activity === "compacting") return this.#compactingResult(id, requestId);
      if (
        previous.status === "outcome-unknown" ||
        managedSessionHasUnknownCommands(this.dataDir, id)
      )
        throw new Error("control-outcome-unconfirmed");
      if (previous.revision !== value.expectedRevision) throw new Error("stale-Claude-revision");
      const digest = createHash("sha256").update(`claude-auto-adopt:${requestId}`).digest("hex");
      const adoptId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      await this.#adopt(
        { operation: "adopt", sessionId: id, requestId: adoptId, deviceId: value.deviceId },
        id,
      );
      record = this.#load(id);
      adopted = true;
    }
    if (!record) throw new Error("session-unavailable");
    if (record.released) throw new Error("session-released");
    this.#validate(record);
    let existingRunner = this.#runners.get(id);
    if (operation !== "send" && !existingRunner) throw new Error("session-runner-unavailable");
    if (managedSessionHasUnknownCommands(this.dataDir, id))
      throw new Error("control-outcome-unconfirmed");
    this.#ownershipReasons.delete(id);
    let live = await this.#live(id, true);
    if (live.status === "archived") throw new Error("session-archived");
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
    if (!adopted && value.expectedRevision !== live.revision)
      throw new Error("stale-Claude-revision");
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

    if (operation === "send" && !value.schedulePermitId) {
      const host = this.#hostState.read(id);
      if (host.goal?.status === "active")
        this.#hostState.update(id, (state) => {
          state.goal!.status = "paused";
          state.goal!.reason = "user-message";
        });
      this.invalidateSchedulePermits(id);
    }
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
      if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
      executable = resolveCommand("claude", this.environment);
      if (!executable) throw new Error("claude-cli-unavailable");
      if (!existingRunner?.hasWorker) {
        // Creating/adopting an idle session already retains this runtime's lease.
        // A second file-lock acquisition would reject our own first send.
        if (!this.#ownerLocks.has(id)) {
          const release = this.#tryLock(id);
          if (!release) throw new Error("session-managed-by-another-runtime");
          this.#ownerLocks.set(id, release);
          newlyAcquiredOwnerLock = true;
        }
        try {
          await this.#ensureNoExternalOwner(record.nativeId);
          if (!record.fresh) {
            const target = await this.#resolveNative(record.id);
            if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
              throw new Error("unverified-session-identity");
            await this.#refreshIdleHistory(record);
          }
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
    let reservedRunnerSlot = false;
    try {
      if (operation === "send") reservedRunnerSlot = await this.#reserveRunner(id);
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        if (newlyAcquiredOwnerLock) {
          const release = this.#ownerLocks.get(id);
          this.#ownerLocks.delete(id);
          release?.();
        }
        return claimed;
      }

      const previousSnapshot = structuredClone(record.snapshot);
      record.snapshot = { ...live, status: "outcome-unknown" };
      this.#save(record);
      let dispatched = false;
      if (operation !== "send") {
        dispatchManagedCommand(this.dataDir, requestId);
        dispatched = true;
      }
      let runner = existingRunner;
      if (!runner) {
        runner = this.#newRunner(record);
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
                if (runner.snapshot().activity === "compacting")
                  throw new ClaudeUndispatchedError();
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
                dispatchManagedCommand(this.dataDir, requestId);
                dispatched = true;
              },
            );
            try {
              await dispatch;
            } finally {
              this.#starting.delete(id);
            }
            if (reservedRunnerSlot) {
              this.#runnerReservations.delete(id);
              reservedRunnerSlot = false;
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
            await runner.stop(value.turnId, runner.snapshot().revision);
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
            );
            break;
          default:
            throw new Error("unsupported-Claude-control");
        }
        const snapshot = runner.snapshot();
        const current = this.#load(id)!;
        current.snapshot = snapshot as unknown as Record<string, unknown>;
        if (operation === "send") current.fresh = false;
        this.#save(current);
        const result = {
          accepted: true,
          completed: false,
          requestId,
          sessionId: id,
          runtimeBootId: this.bootId,
          controlOutcome: "accepted",
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
          live: await this.#live(id, true),
        };
        finishManagedCommand(this.dataDir, requestId, result);
        return result;
      } catch (error) {
        const current = this.#load(id);
        if (current) {
          current.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(current);
        } else {
          record.snapshot = previousSnapshot;
        }
        const unknown =
          !dispatched && error instanceof ClaudeUndispatchedError
            ? false
            : current?.snapshot.status === "outcome-unknown";
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
        if (!unknown) finishManagedCommand(this.dataDir, requestId, result);
        const terminal = this.#streamLive(id, runner.snapshot(), current);
        try {
          this.#publishConversationEvent?.(id, "state", terminal, terminal);
        } catch {
          // The durable result is authoritative; a later read can recover this projection.
        }
        return result;
      }
    } finally {
      // The slot is handed to a live worker when send starts; failures before then
      // release it here so another session can claim the available capacity.
      if (reservedRunnerSlot) this.#runnerReservations.delete(id);
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
      database.exec("BEGIN IMMEDIATE");
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
    options: { mcpConfig?: Record<string, unknown> } = {},
    settings = this.#hostState.read(record.id).settings,
  ): ClaudeManagedRunnerProcess {
    const id = record.id;
    const runner = new ClaudeManagedRunnerProcess(
      record.workspace,
      record.nativeId,
      record.fresh,
      Number(record.snapshot.revision ?? 0),
      this.environment,
      (snapshot: ClaudeRunnerSnapshot) => {
        const current = this.#load(id);
        if (!current || current.released) throw new Error("Claude session unavailable");
        if (snapshot.status === "idle" && !snapshot.activity)
          this.#idleSince.set(id, this.#idleSince.get(id) ?? Date.now());
        else this.#idleSince.delete(id);
        const turnId = snapshot.turnId;
        let completed = false;
        if (
          snapshot.status === "idle" &&
          typeof turnId === "string" &&
          turnId.length > 0 &&
          !current.completedRequests.includes(turnId)
        ) {
          try {
            current.fingerprint = this.#targetFingerprint(current.nativeId, current.workspace);
            const title = this.#hostState.read(id).title;
            if (title && title !== current.nativeTitle) {
              // Keep completion publication synchronous; native title updates await the same
              // ownership proof as explicit renames, after the current control releases its queue.
              void this.#serializeSession(id, async () => {
                const pending = this.#load(id);
                if (!pending || pending.released) return;
                await this.#persistNativeTitle(pending, title);
                this.#save(pending);
              }).catch(() => {
                /* The host title remains available for a later retry. */
              });
            }
          } catch {
            // Completion is still recorded; a missing transcript cannot prove a new handoff.
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
        onUndispatchedStartup: (proof) => this.#recordStartupCleanup(record, proof),
        beforeStart: () => this.#beforeRunnerStart(id),
        ...(this.#version?.value ? { cliVersion: this.#version.value } : {}),
        onResult: (result) => {
          this.#hostState.complete(id, result.turnId, {
            success: result.success,
            usage: result.usage,
          });
          void this.#goalEndpoints
            .get(id)
            ?.close()
            .catch(() => this.#hostState.pause(id, "goal-report-close-failed"));
          this.#goalEndpoints.delete(id);
        },
      },
    );
    this.#runners.set(id, runner);
    if (this.continuation.isSessionObserved?.(id)) this.#observed.add(id);
    if (options.mcpConfig) this.#goalRunners.add(id);
    return runner;
  }

  /** Keeps a turn end the transcript will not have, so history shows it after the live rows go. */
  #rememberTurnEnd(id: string, nativeId: string, item: Record<string, unknown>): void {
    if (item.kind !== "agent-message" || typeof item.id !== "string" || !isObject(item.turn_meta))
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
    const ids = page.events.flatMap((event) =>
      event.kind === "agent-message" && !event.turn_meta ? [event.id] : [],
    );
    if (!ids.length) return page;
    let stored: Map<string, ConversationTurnMeta>;
    try {
      stored = this.#turnMeta.read(nativeId, ids);
    } catch {
      return page;
    }
    if (!stored.size) return page;
    return {
      ...page,
      events: page.events.map((event) => {
        const meta = event.turn_meta ? undefined : stored.get(event.id);
        return meta ? { ...event, turn_meta: meta } : event;
      }),
    };
  }

  async #retireGoalRunner(id: string): Promise<void> {
    const runner = this.#runners.get(id);
    if (runner) await runner.shutdown();
    this.#runners.delete(id);
    this.#goalRunners.delete(id);
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
      if (!["default", "plan", "acceptEdits"].includes(String(value.permissionMode)))
        throw new Error("unsupported-permission-mode");
      result.permissionMode = value.permissionMode as ClaudeSettings["permissionMode"];
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
    let runner = this.#runners.get(record.id);
    if (!runner?.hasWorker) {
      await this.#ensureNoExternalOwner(record.nativeId);
      if (!record.fresh) {
        const target = await this.#resolveNative(record.id);
        if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
          throw new Error("unverified-session-identity");
        await this.#refreshIdleHistory(record);
      }
      if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
      await this.#reserveRunner(record.id);
      runner = this.#newRunner(record, options, settings);
    }
    try {
      const executable = resolveCommand("claude", this.environment);
      if (!executable) throw new Error("claude-cli-unavailable");
      await runner.prepare(executable);
    } finally {
      this.#starting.delete(record.id);
      this.#runnerReservations.delete(record.id);
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
    if (record.fingerprint !== this.#targetFingerprint(record.nativeId, record.workspace))
      throw new Error("Claude-history-changed-requires-handoff");
    if (record.nativeTitle === title) return;
    const transcript = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
    const target = lstatSync(transcript);
    const fd = openSync(transcript, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.dev !== target.dev ||
        before.ino !== target.ino ||
        before.size > 128 * 1024 * 1024
      )
        throw new Error("invalid-Claude-transcript");
      const row = Buffer.from(
        `${before.size && !readFileSync(transcript).subarray(-1).equals(Buffer.from("\n")) ? "\n" : ""}${JSON.stringify({ type: "custom-title", customTitle: title, sessionId: record.nativeId })}\n`,
      );
      if (writeSync(fd, row) !== row.length) throw new Error("Claude-title-write-incomplete");
      fsyncSync(fd);
      const after = fstatSync(fd);
      const verified = lstatSync(transcript);
      if (
        after.size !== before.size + row.length ||
        after.nlink !== 1 ||
        verified.nlink !== 1 ||
        verified.ino !== after.ino ||
        verified.dev !== after.dev ||
        !readFileSync(transcript).subarray(-row.length).equals(row)
      )
        throw new Error("Claude-title-write-unconfirmed");
    } finally {
      closeSync(fd);
    }
    record.fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
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
        evidence.operation === "steer" &&
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
        if (!record || record.released || !this.#ownerLocks.has(id)) throw error;
        this.#validate(record);
        const reason = error instanceof Error ? error.message : "";
        const result = this.#hostState.command(id, value, record.workspaceId, () => ({
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
      // A read-only fork of an indexed source never adopts that source.
      if (!this.#load(id) && !this.#runners.has(id)) {
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
      "handoffConfirmed",
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
    const prior = replayManagedCommand(
      this.dataDir,
      value.requestId,
      claudeCommandFingerprint(value),
    );
    if (prior) return prior;
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
    let record = this.#load(id);
    if (operation === "fork" && !record) {
      const target = await this.#resolveNative(id);
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
    const state = this.#hostState.read(id);
    if (state.archived && operation !== "unarchive") throw new Error("session-archived");
    if (
      [
        "settings",
        "rename",
        "archive",
        "unarchive",
        "fork",
        "goal-set",
        "goal-resume",
        "queue-resume",
      ].includes(operation) &&
      ((live.status !== "idle" && live.status !== "archived") || live.activity === "compacting")
    )
      throw new Error("session-busy");
    let nextSettings: ClaudeSettings | undefined;
    let renamedTitle: string | undefined;
    let externallyDispatched = false;
    const claimExternalEffect = () => {
      onExternalClaim();
      const prior = claimManagedCommand(
        this.dataDir,
        value.requestId,
        id,
        claudeCommandFingerprint(value),
        value.deviceId,
        {
          operation,
          workspaceId: record.workspaceId,
          executionMode: "claude-managed",
          runtimeBootId: this.bootId,
          ...(value.publicInputHash ? { publicInputHash: value.publicInputHash } : {}),
        },
      );
      if (prior) throw new Error("control-outcome-unconfirmed");
      dispatchManagedCommand(this.dataDir, value.requestId);
      this.#activeHostClaims.set(id, value.requestId);
      externallyDispatched = true;
    };
    if (operation === "settings") {
      nextSettings = this.#settings(value, state.settings);
      let runner = await this.#prepareRunner(record);
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
      claimExternalEffect();
      if (value.resetDefaults === true || value.effort === null) {
        // Native effortLevel:null selects CLI defaults rather than inherited host settings.
        // Relaunch without only the cleared override so live and restarted behavior agree.
        await runner.shutdown();
        this.#runners.delete(id);
        runner = await this.#prepareRunner(this.#load(id)!, {}, nextSettings);
      } else {
        await runner.configure(this.#settings(requested), runner.snapshot().revision);
      }
    }
    if (operation === "rename") {
      if (
        typeof value.name !== "string" ||
        !value.name.trim() ||
        Buffer.byteLength(value.name) > 512 ||
        [...value.name].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error("invalid-session-name");
      renamedTitle = value.name;
      if (!record.fresh) {
        if (record.fingerprint !== this.#targetFingerprint(record.nativeId, record.workspace))
          throw new Error("Claude-history-changed-requires-handoff");
        const transcript = this.sessions.verifiedClaudeControlTarget(
          record.nativeId,
          record.workspace,
        );
        if (lstatSync(transcript).nlink !== 1) throw new Error("invalid-Claude-transcript");
        claimExternalEffect();
        await this.#persistNativeTitle(record, renamedTitle!);
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
      );
      const target = await this.#resolveNative(id);
      if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
        throw new Error("unverified-session-identity");
      const fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
      if (target.fingerprint !== fingerprint) throw new Error("handoff-fingerprint-changed");
      const transcript = this.sessions.verifiedClaudeControlTarget(
        record.nativeId,
        record.workspace,
      );
      const lines = readFileSync(transcript, "utf8").trim().split("\n");
      if (this.#targetFingerprint(record.nativeId, record.workspace) !== fingerprint)
        throw new Error("Claude-history-changed-requires-handoff");
      const rows = lines.reverse().map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
      const last = rows.find(
        (row) =>
          row &&
          row.sessionId === record.nativeId &&
          ["assistant", "user"].includes(row.type) &&
          typeof row.uuid === "string" &&
          uuidPattern.test(row.uuid) &&
          (owner.kind === "idle" ||
            (row.type === "assistant" &&
              ["end_turn", "stop_sequence"].includes(row.message?.stop_reason))),
      );
      const lastUser = rows.find(
        (row) => row?.type === "user" && row.sessionId === record.nativeId,
      );
      const terminal = record.snapshot.terminalResult;
      const confirmedManagedTurn =
        isObject(terminal) &&
        terminal.success === true &&
        typeof terminal.turnId === "string" &&
        this.#completedTurnIncludesUser(record, terminal.turnId, lastUser?.uuid) &&
        record.completedRequests.includes(terminal.turnId);
      if (
        last?.type !== "assistant" ||
        (!confirmedManagedTurn &&
          !["end_turn", "stop_sequence"].includes(last.message?.stop_reason))
      )
        throw new Error("fork-cutoff-unavailable");
      if (!last) throw new Error("fork-cutoff-unavailable");
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
            host.settings = nextSettings!;
            return { settings: host.settings };
          case "rename": {
            host.title = renamedTitle!;
            return { name: renamedTitle };
          }
          case "archive":
            host.archived = true;
            host.paused = true;
            host.reason = "archived";
            if (host.goal?.status === "active") {
              host.goal.status = "paused";
              host.goal.reason = "archived";
            }
            return {};
          case "unarchive":
            host.archived = false;
            host.paused = true;
            host.reason = "resume-confirmation-required";
            return {};
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
    if (["goal-pause", "goal-clear", "archive"].includes(operation)) {
      await this.#goalEndpoints.get(id)?.close();
      this.#goalEndpoints.delete(id);
    }
    const currentLive = await this.#live(id, true);
    this.#publishConversationEvent?.(id, "state", currentLive, currentLive);
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
    return this.#hostState.peek(id)?.lastConfirmedOptions?.options.commands ?? [];
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
        const skill = this.#projectSkills(record).find((item) => item.id === reference.id);
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
    await this.context(id);
    const live = await this.#live(id, false);
    const record = this.#load(id);
    return {
      available: true,
      revision: live.revision,
      executionMode: "claude-managed",
      skills: record ? this.#projectSkills(record) : [],
      plugins: [],
      apps: [],
      // The host enumerates files through ArtifactService, which owns remote path
      // grants, sensitive-path filtering, identity checks and revision-bound IDs.
      contextReferences: [],
    };
  }

  #projectSkills(
    record: ClaudeRecord,
  ): Array<{ id: string; name: string; description?: string; available: true }> {
    return (this.#runners.get(record.id)?.optionsSnapshot.commands ?? []).flatMap((command) => {
      if (!/^[A-Za-z0-9_-]+$/.test(command.name)) return [];
      const file = path.join(record.workspace, ".claude", "skills", command.name, "SKILL.md");
      try {
        const resolved = canonicalize(file);
        const relative = path.relative(record.workspace, resolved);
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
      Object.keys(value).some((key) => !allowed.has(key)) ||
      (value.name !== undefined &&
        (typeof value.name !== "string" || Buffer.byteLength(value.name) > 512))
    )
      throw new Error("invalid-managed-create");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    // Before the request is claimed or dispatched: nothing may be left half-recorded.
    this.#home();
    const selectedSettings = this.#settings(value);
    if (
      Object.keys(selectedSettings).length &&
      !supportsClaudeVersion(this.#version?.value ?? "", "2.1.286")
    )
      throw new Error("unsupported-Claude-version");
    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

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
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      dispatchManagedCommand(this.dataDir, requestId);
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
      finishManagedCommand(this.dataDir, requestId, result);
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

  async #adopt(value: Record<string, any>, id: string): Promise<Record<string, unknown>> {
    const allowed = new Set([
      "operation",
      "sessionId",
      "requestId",
      "deviceId",
      "handoffConfirmed",
      "handoffFingerprint",
    ]);
    const requestId = value.requestId;
    if (!supportsClaudeManagedRunner()) throw new Error("platform-unsupported");
    if (
      !validClaudeDeviceId(value.deviceId) ||
      typeof requestId !== "string" ||
      !uuidPattern.test(requestId) ||
      (value.handoffFingerprint !== undefined &&
        (typeof value.handoffFingerprint !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.handoffFingerprint))) ||
      Object.keys(value).some((key) => !allowed.has(key))
    )
      throw new Error("invalid-managed-adopt");
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    // Before the request is claimed or dispatched: nothing may be left half-recorded.
    this.#home();
    const logical = { ...value };
    delete logical.runtimeBootId;
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

    this.#privateDirectory(true);
    const release = this.#tryLock(id);
    if (!release) throw new Error("session-managed-by-another-runtime");
    let retainLock = false;
    try {
      let existing = this.#load(id);
      if (existing?.released) {
        existing = this.#recoverStartupCleanup(existing, true);
        if (existing.snapshot.status === "outcome-unknown")
          throw new Error("control-outcome-unconfirmed");
      }
      if (existing?.snapshot.activity === "compacting") throw new Error("session-compacting");
      if (managedSessionHasUnknownCommands(this.dataDir, id))
        throw new Error("control-outcome-unconfirmed");
      let workspaceId: string;
      let workspace: string;
      let nativeId: string;
      let handoff: string | null;
      let fresh: boolean;
      if (existing && existing.fresh && existing.released) {
        this.#validate(existing);
        if (
          value.handoffFingerprint !== undefined &&
          value.handoffFingerprint !== this.#emptyFingerprint(existing)
        )
          throw new Error("handoff-fingerprint-changed");
        ({ workspaceId, workspace, nativeId } = existing);
        handoff = null;
        fresh = true;
      } else {
        if (existing && !existing.released) throw new Error("session-already-managed");
        const target = await this.#resolveNative(id);
        await this.#ensureNoExternalOwner(target.nativeId);
        const current = this.#targetFingerprint(target.nativeId, target.workspace);
        if (value.handoffFingerprint !== undefined && value.handoffFingerprint !== current)
          throw new Error("handoff-fingerprint-changed");
        // The same proof is required without a user-supplied fingerprint.
        if (target.fingerprint !== current) throw new Error("handoff-fingerprint-changed");
        workspaceId = target.workspaceId;
        workspace = target.workspace;
        nativeId = target.nativeId;
        handoff = current;
        fresh = false;
      }

      this.#assertNativeAliasesConfirmed(id, nativeId, workspace);
      const evidence = {
        operation: "adopt",
        workspaceId,
        runtimeBootId: this.bootId,
        executionMode: "claude-managed",
      };
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) {
        this.#ownerLocks.set(id, release);
        retainLock = true;
        return claimed;
      }
      const previous = this.#load(id);
      const namedCreate = existing && !existing.adopted && existing.title !== "Claude Code";
      const name =
        existing && (existing.forkSourceNativeId || namedCreate)
          ? existing.title
          : (this.#nativeMetadata(nativeId, workspace)?.title ?? previous?.title ?? "Claude Code");
      const record: ClaudeRecord = {
        version: 1,
        id,
        workspaceId,
        workspace,
        registeredWorkspace: canonicalize(this.store.workspacePath(workspaceId)),
        home: this.#home(),
        nativeId,
        title: name,
        createdAt: new Date().toISOString(),
        adopted: previous?.adopted ?? true,
        released: false,
        fresh,
        fingerprint: handoff,
        ...(existing?.forkSourceNativeId
          ? { forkSourceNativeId: existing.forkSourceNativeId, forkCutoff: existing.forkCutoff }
          : {}),
        completedRequests: previous?.completedRequests ?? [],
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
      };
      if (this.#load(id)?.snapshot.activity === "compacting") throw new Error("session-compacting");
      dispatchManagedCommand(this.dataDir, requestId);
      this.#save(record);
      const cliVersion = await this.#installationVersion();
      // The selection lives in host state and survives a release; read lazily so a failure there
      // costs only the hint, never the adoption that has already been recorded.
      const permission = this.#permissionView(
        id,
        cliVersion,
        () => this.#hostState.read(id).settings.permissionMode,
      );
      const live = {
        ...record.snapshot,
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
      finishManagedCommand(this.dataDir, requestId, result);
      this.#ownerLocks.set(id, release);
      retainLock = true;
      return result;
    } finally {
      if (!retainLock) release();
    }
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
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;

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
      const claimed = claimManagedCommand(
        this.dataDir,
        requestId,
        id,
        fingerprint,
        value.deviceId,
        evidence,
      );
      if (claimed) return claimed;
      dispatchManagedCommand(this.dataDir, requestId);
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
      finishManagedCommand(this.dataDir, requestId, result);
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
    const fingerprint = claudeCommandFingerprint(value);
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
    if (value.runtimeBootId !== this.bootId) throw new Error("stale-runtime-boot");
    let workspaceId: string | null = null;
    const outcome = (fields: Record<string, unknown>, request = requestId) => ({
      ...fields,
      requestId: request,
      sessionId: id,
      runtimeBootId: this.bootId,
    });
    const claim = () =>
      claimManagedCommand(this.dataDir, requestId, id, fingerprint, value.deviceId, {
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
      finishManagedCommand(this.dataDir, requestId, result);
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
        } else ({ nativeId, workspace, workspaceId } = await this.#resolveNative(id));
      } catch (error) {
        return reject(error instanceof Error ? error.message : "session-unavailable");
      }
      const home = this.#home();
      // Only an earlier delete may still be unconfirmed: retrying it is how that outcome resolves.
      const unconfirmed = readUnknownManagedCommands(this.dataDir, id);
      if (unconfirmed.some((command) => command.evidence?.operation !== "delete"))
        return reject("control-outcome-unconfirmed");
      if ((await this.#installationVersion()) === null) return reject("claude-cli-unavailable");
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
      dispatchManagedCommand(this.dataDir, requestId);
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
        finishManagedCommand(this.dataDir, requestId, result);
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
      finishManagedCommand(this.dataDir, requestId, result);
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
      this.#ownershipReasons.delete(sessionId);
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

  #emptyFingerprint(record: ClaudeRecord): string {
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
    const transcript = this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
    const read = () => {
      const info = lstatSync(transcript);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024)
        throw new Error("invalid-Claude-transcript");
      const fd = openSync(transcript, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 128n * 1024n * 1024n)
          throw new Error("invalid-Claude-transcript");
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0;
        for (;;) {
          const size = readSync(fd, buffer, 0, buffer.length, null);
          if (size === 0) break;
          total += size;
          if (total > 128 * 1024 * 1024)
            throw new Error("Claude transcript exceeds handoff budget");
          chunks.push(Buffer.from(buffer.subarray(0, size)));
        }
        const after = fstatSync(fd, { bigint: true });
        if (
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          BigInt(total) !== before.size
        )
          throw new Error("Claude history changed during handoff");
        return Buffer.concat(chunks, total);
      } finally {
        closeSync(fd);
      }
    };
    const first = read();
    if (this.sessions.verifiedClaudeControlTarget(nativeId, workspace) !== transcript)
      throw new Error("Claude transcript target changed during handoff");
    const serialized = Buffer.from(
      JSON.stringify([nativeId.toLowerCase(), canonicalize(workspace)]),
    );
    return createHash("sha256").update(serialized).update(first).digest("hex");
  }

  async #ensureNoExternalOwner(nativeId: string, ownedPid: number | null = null): Promise<void> {
    const owner = await this.#ownership.check(nativeId, ownedPid);
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

  async #refreshIdleHistory(record: ClaudeRecord): Promise<void> {
    this.#validate(record);
    if (record.fresh) return;
    const target = await this.#resolveNative(record.id);
    if (target.nativeId !== record.nativeId || target.workspace !== record.workspace)
      throw new Error("unverified-session-identity");
    const fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
    if (fingerprint !== target.fingerprint) throw new Error("handoff-fingerprint-changed");
    record.fingerprint = fingerprint;
    this.#save(record);
  }

  async #ownershipReason(
    id: string,
    nativeId: string,
    ownedPid: number | null,
  ): Promise<string | null> {
    const cached = this.#ownershipReasons.get(id);
    if (cached && Date.now() - cached.at < (this.continuation.maintenanceIntervalMs ?? 3000))
      return cached.reason;
    let reason: string | null;
    try {
      const owner = await this.#ownership.check(nativeId, ownedPid);
      reason =
        owner.kind === "idle"
          ? null
          : owner.kind === "background"
            ? "claude-background-session-running"
            : "claude-owner-busy";
    } catch {
      reason = "claude-owner-check-unavailable";
    }
    this.#ownershipReasons.set(id, { at: Date.now(), reason });
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
    if ((await this.#installationVersion()) === null) throw new Error("claude-cli-unavailable");
    await this.#ensureNoExternalOwner(record.nativeId);
    if (this.#shuttingDown || this.#runners.get(id) !== runner)
      throw new Error("session-unavailable");
    const current = this.#load(id);
    if (!current || current.released || current.nativeId !== record.nativeId)
      throw new Error("session-unavailable");
    if (this.#isSessionBridged(record)) throw new Error("session-already-bridged");
    await this.#refreshIdleHistory(record);
    // Resolving the transcript can await indexed identity. Recheck before spawning.
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
    // One read-only observation per tick serves every live worker, so the patrol cost does not
    // grow with the number of sessions. Each worker is still evaluated with its own process.
    const share: ClaudeOwnerObservationShare = {};
    const runners = [...this.#runners];
    const workers = new Map(runners.map(([id, runner]) => [id, runner.processId] as const));
    await Promise.allSettled(
      runners.map(async ([id, runner]) => {
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
            snapshot.questions.length
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
    );
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
    const fingerprint = createHash("sha256").update(stableJson(logical)).digest("hex");
    const prior = replayManagedCommand(this.dataDir, requestId, fingerprint);
    if (prior) return prior;
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
    const claimed = claimManagedCommand(
      this.dataDir,
      requestId,
      id,
      fingerprint,
      value.deviceId,
      evidence,
    );
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
    finishManagedCommand(this.dataDir, requestId, result);
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

  async #reserveRunner(id: string): Promise<boolean> {
    let release!: () => void;
    const previous = this.#runnerReservationTail;
    this.#runnerReservationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const existing = this.#runners.get(id);
      const needsSlot = !existing?.hasWorker || existing.isRetiring;
      if (needsSlot) {
        if (this.#runnerReservations.has(id)) return false;
        this.#runnerReservations.add(id);
      }
      const retirements: Array<[string, ClaudeManagedRunnerProcess, Promise<boolean>]> = [];
      for (const [otherId, runner] of this.#runners) {
        if (otherId === id) continue;
        const retirement = runner.retireIfInactive();
        if (retirement) retirements.push([otherId, runner, retirement]);
      }
      const retired = await Promise.allSettled(retirements.map(([, , retirement]) => retirement));
      for (const [index, [otherId, runner]] of retirements.entries()) {
        if (retired[index]?.status !== "fulfilled" || !retired[index].value) continue;
        const record = this.#load(otherId);
        if (record) {
          record.snapshot = runner.snapshot() as unknown as Record<string, unknown>;
          this.#save(record);
        }
      }
      const retirementFailure = retired.find(
        (result) =>
          result.status === "rejected" || (result.status === "fulfilled" && !result.value),
      );
      if (retirementFailure?.status === "rejected") throw retirementFailure.reason;
      if (retirementFailure) throw new Error("Claude-runner-limit");
      const active = new Set(this.#runnerReservations);
      for (const [sessionId, runner] of this.#runners)
        if (runner.hasWorker && !runner.isRetiring) active.add(sessionId);
      if (active.size > 8) throw new Error("Claude-runner-limit");
      return needsSlot;
    } catch (error) {
      this.#runnerReservations.delete(id);
      throw error;
    } finally {
      release();
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

  /** Catalog presentation never probes processes or starts a runner. */
  catalogContinuation(
    id: string,
    persisted?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const runner = this.#runners.get(id);
    const status = this.#catalogUnconfirmed.has(id)
      ? "outcome-unknown"
      : (runner?.status ?? persisted?.status);
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
      return { status: "unsupported", executionLocation: null, reason: "claude-cli-unavailable" };
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

  catalog(): Array<Record<string, unknown>> {
    const records = this.#listRecords();
    const metadataShare: ClaudeControlMetadataShare = {};
    return records.flatMap((record) => {
      try {
        this.#validate(record);
        if (record.released && record.adopted) return [];
        const indexedSessionId = this.store.sessions.id("claude-code", record.nativeId);
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
        return [
          {
            id: record.id,
            indexedSessionId,
            workspace_id: record.workspaceId,
            agent: "claude-code",
            title:
              this.#hostState.peek(record.id)?.title ??
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
            archived: this.#hostState.peek(record.id)?.archived ?? false,
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

  hasManagedSession(id: string): boolean {
    return sessionIdPattern.test(id) && this.#load(id) !== null;
  }

  indexedAliases(): Set<string> {
    return new Set(
      this.catalog().flatMap((record) =>
        typeof record.indexedSessionId === "string" ? [record.indexedSessionId] : [],
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
    if (existsSync(configured)) return canonicalize(configured);
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
    if (pathIdentity(this.#home()) !== pathIdentity(canonicalize(record.home)))
      throw new Error("claude-home-changed");
  }

  async #installationVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000) return this.#version.value;
    const version = await readClaudeVersion(this.commands, this.environment);
    const value = version !== null && supportsClaudeVersion(version) ? version : null;
    this.#version = { at: Date.now(), value };
    return value;
  }

  async options(): Promise<Record<string, unknown>> {
    const cliVersion = supportsClaudeManagedRunner() ? await this.#installationVersion() : null;
    const available = cliVersion !== null;
    return {
      available,
      ...(available ? {} : { reason: "unverified-installation" }),
      workspaces: available
        ? (this.store.listWorkspaces() as Array<Record<string, unknown>>).map(({ id, name }) => ({
            id,
            name,
          }))
        : [],
      models: [],
      permissionModes: supportsClaudeVersion(cliVersion ?? "", "2.1.286")
        ? ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id }))
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
      const reason = !supportsClaudeManagedRunner()
        ? "platform-unsupported"
        : !version
          ? "claude-cli-unavailable"
          : await this.#ownershipReason(id, target.nativeId, null);
      if (this.#load(id)) {
        this.#ownershipReasons.delete(id);
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
        sendEnabled: controls && !reason && !this.#hostState.read(id).archived,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        reason,
        cliVersion: version,
        permissionMode: "cli-configured",
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
        ? "claude-cli-unavailable"
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
      this.#ownershipReasons.delete(id);
      if (ownershipReadAttempt > 0) throw new Error("claude-owner-check-unavailable");
      return this.#live(id, controls, ownershipReadAttempt + 1);
    }
    // No later await may let a captured starting snapshot outlive cleanup/retirement.
    record = current;
    this.#validate(record);
    record = this.#recoverStartupCleanup(record);
    this.#recoverCompletions(record);
    if (runner) {
      const snapshot = runner.snapshot();
      const turnId = snapshot.turnId;
      if (
        snapshot.status === "idle" &&
        typeof turnId === "string" &&
        turnId.length > 0 &&
        !record.completedRequests.includes(turnId)
      ) {
        try {
          record.fingerprint = this.#targetFingerprint(record.nativeId, record.workspace);
        } catch {
          // Completion is still recorded; a missing transcript cannot prove a new handoff.
        }
        record.completedRequests.push(turnId);
      }
      record.snapshot = snapshot as unknown as Record<string, unknown>;
      this.#save(record);
      this.#recoverCompletions(record);
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
    live.archived = host.archived;
    live.schedule = { paused: host.paused, reason: host.reason, revision: host.revision };
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
    if (host.archived) {
      live.status = "archived";
      live.sendEnabled = false;
      live.stopEnabled = false;
    }
    return live;
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
    return {
      ...snapshot,
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

  /** Bounded identity discovery for a borrowed native host; this never transfers execution. */
  async nativeBridgeTarget(id: string, nativeId?: string) {
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
    const workspace = this.sessions.claudeControlWorkspace(nativeId, registeredWorkspace);
    this.sessions.verifiedClaudeControlTarget(nativeId, workspace);
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
    if (forControl) this.sessions.verifiedClaudeControlTarget(target.nativeId, target.workspace);
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
          other.workspace === workspace &&
          other.home === this.#home()
        )
          aliases.set(other.id, other);
    for (const [alias, candidate] of aliases) {
      const runner = this.#runners.get(alias);
      if (runner?.hasWorker || runner?.isRetiring || this.#starting.has(alias))
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

  async receipt(value: unknown): Promise<unknown> {
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
    await this.request({ operation: "live", sessionId: value.sessionId });
    const current = this.#load(value.sessionId);
    const completionObserved = Boolean(
      current?.completedRequests.includes(value.requestId) ||
      (value.operation === "steer" &&
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
    const continuable =
      !this.#hostState.read(id).archived &&
      !live.ownershipReason &&
      live.status !== "outcome-unknown";
    const host = owned ? this.#hostState.read(id) : null;
    const writable =
      version && controls && owned && !host?.archived && live.status !== "outcome-unknown";
    const idle = writable && live.status === "idle" && live.activity !== "compacting";
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
      attachments: writable && live.activity !== "compacting",
      files: true,
      adopt: !owned && version && controls,
      release: idle,
      inspect: true,
      reconcile: owned,
      usage: true,
      context: owned,
      resources: owned,
      settings: idle,
      "settings-state": owned,
      queue: writable,
      "queue-list": owned,
      "queue-add": writable,
      "queue-update": writable,
      "queue-delete": writable,
      "queue-reorder": writable,
      "queue-resume": idle && host?.paused === true,
      "queue-pause": writable && host?.paused !== true,
      fork:
        version &&
        controls &&
        !this.#hostState.read(id).archived &&
        live.status === "idle" &&
        live.activity !== "compacting" &&
        record?.fresh !== true,
      archive: idle,
      unarchive: version && controls && host?.archived === true,
      rename: idle,
      goal: owned,
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
      for (const feature of [
        "steer",
        "settings",
        "settings-state",
        "queue",
        "queue-list",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "queue-resume",
        "queue-pause",
        "fork",
        "rename",
        "archive",
        "unarchive",
        "goal",
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
        handoffFingerprint: this.#emptyFingerprint(record),
        reconciled: false,
      };
    const target = await this.#resolveNative(id);
    return {
      sessionId: id,
      workspaceId: target.workspaceId,
      sourceSessionId: target.nativeId,
      handoffFingerprint: target.fingerprint,
      live,
      reconciled: false,
    };
  }

  async resumeCommand(id: string) {
    const target = async () => {
      const native = await this.#resolveNative(id);
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
    const native = record ? null : await this.#resolveNative(id);
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

  async events(id: string, cursor: unknown, limit: unknown): Promise<unknown> {
    const record = this.#load(id);
    if (record) {
      this.#validate(record);
      if (record.fresh) return { events: [], next_cursor: null, warnings: [] };
      const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
      const page = await this.sessions.eventsForNative(
        "claude-code",
        record.nativeId,
        record.workspace,
        typeof cursor === "string" ? cursor : null,
        count,
      );
      return this.#withTurnEnds(record.nativeId, page);
    }
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, Number(limit))) : 50;
    return this.sessions.claudeEventsForSession(
      id,
      typeof cursor === "string" ? cursor : null,
      count,
    );
  }

  /** Only invalidates observation projections; never proves ownership or control admission. */
  async historyVersion(id: string): Promise<string> {
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
      transcript = this.sessions.verifiedClaudeControlTarget(record.nativeId, record.workspace);
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
    const native = runner?.optionsSnapshot;
    if (!native?.settingsAcknowledged) return;
    const host = this.#hostState.read(id);
    const { settingsAcknowledged: _acknowledged, ...options } = native;
    let permissionMode: ClaudeObservedPermissionMode | null;
    try {
      permissionMode = runner?.observedPermissionMode ?? null;
    } catch {
      // Permission is a display-only observation; a broken view cannot fail a turn.
      permissionMode = host.lastConfirmedOptions?.permissionMode ?? null;
    }
    const confirmed = {
      options,
      selection: host.settings,
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
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      throw new Error("unsupported-Claude-version");
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
      if (this.#hostState.read(id).archived) throw new Error("session-archived");
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
        this.#ownershipReasons.delete(id);
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

  async settingsState(id: string): Promise<Record<string, unknown>> {
    const live = await this.#live(id, false);
    if (!supportsClaudeVersion((await this.#installationVersion()) ?? "", "2.1.286"))
      return { available: false, reason: "unsupported-Claude-version", revision: live.revision };
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
    const mutable =
      this.#load(id)?.released === false &&
      live.status === "idle" &&
      live.activity !== "compacting" &&
      !live.ownershipReason &&
      !state.archived;
    return {
      available: true,
      executionMode: "claude-managed",
      revision: live.revision,
      tokenUsage: live.tokenUsage ?? null,
      current,
      selected,
      settings: selected,
      defaults: { model: null, effort: null, permissionMode: null },
      applicationStatus: confirmed ? "confirmed" : "pending",
      models: (native?.models ?? []).map((model) => ({
        id: model.value,
        ...(model.resolvedModel !== undefined ? { resolvedModel: model.resolvedModel } : {}),
        name: model.displayName,
        efforts: model.supportedEffortLevels ?? [],
      })),
      permissionModes: ["default", "plan", "acceptEdits"].map((id) => ({ id, name: id })),
      writable: {
        model: { available: mutable && !!native?.models.length },
        effort: {
          available:
            mutable && !!native?.models.some((model) => model.supportedEffortLevels?.length),
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

  async #resolveNative(
    id: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const managed = this.#load(id);
    if (managed) {
      this.#validate(managed);
      if (managed.fresh)
        return {
          workspaceId: managed.workspaceId,
          workspace: managed.workspace,
          nativeId: managed.nativeId,
          fingerprint: this.#emptyFingerprint(managed),
        };
      return {
        workspaceId: managed.workspaceId,
        workspace: managed.workspace,
        nativeId: managed.nativeId,
        fingerprint: this.#targetFingerprint(managed.nativeId, managed.workspace),
      };
    }
    const session = this.store.sessions.get(id);
    if (!session) throw new Error("session-unavailable");
    if (session.agent !== "claude-code" || session.sidechain)
      throw new Error("session-not-controllable");
    const workspace = canonicalize(this.store.workspacePath(session.workspace_id));
    return this.#findNative(id, session.workspace_id, workspace);
  }

  async #findNative(
    id: string,
    workspaceId: string,
    workspace: string,
  ): Promise<{ workspaceId: string; workspace: string; nativeId: string; fingerprint: string }> {
    const listing = await this.sessions.list("claude-code", workspace);
    const native = listing.sessions.find(
      (candidate) => this.store.sessions.id("claude-code", candidate.native_ref) === id,
    );
    if (!native) throw new Error("session-unavailable");
    const document = await this.sessions.document(id);
    if (
      document.source.agent !== "claude-code" ||
      document.source.workspace_id !== workspaceId ||
      native.sidechain
    )
      throw new Error("unverified-session-identity");
    const nativeWorkspace = this.sessions.claudeControlWorkspace(native.native_ref, workspace);
    const digest = this.#targetFingerprint(native.native_ref, nativeWorkspace);
    return {
      workspaceId,
      workspace: nativeWorkspace,
      nativeId: native.native_ref,
      fingerprint: digest,
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
