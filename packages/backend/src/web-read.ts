import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { historyReferenceSchema, validHistoryControl } from "./history-control-schema";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import type { SessionIndex } from "./session-index";
import {
  hasManagedCatalogWorkspace,
  managedCatalogProjection,
  managedRecordSchema,
  readManagedCatalog,
} from "./managed-session-catalog";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { resolveCommand } from "./command-resolution";
import { CodexAppServerReader, CodexAppServerSession, codexWriterBusy } from "./codex-app-server";
import { CodexRuntimePreflight } from "./codex-runtime-preflight";
import { codexResumeCommand } from "./codex-resume-command";
import { CodexFollowerBridge } from "./codex-follower-bridge";
import type { CodexFollowerState } from "./codex-follower-state";
import { AntigravityManagedRunner } from "./antigravity-managed-runner";
import { ManagedCodexState } from "./managed-codex-state";
import { ManagedCodexEventBridge } from "./managed-codex-state";
import { projectContextUsage } from "./context-usage";
import { activityBlocks, assertActivityAllows } from "./session-activity";
import { acquireManagedSessionLease, existingFileLeaseBusy } from "./managed-session-lock";
import { acquireCodexFollowerOperationLock } from "./codex-follower-operation-lock";
import {
  claimManagedCommand,
  createManagedSnapshotWriter,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  openManagedLedger,
  persistManagedGoal,
  readManagedEvents,
  readUnknownManagedCommands,
  replayManagedCommand,
  saveManagedRecord,
} from "./managed-ledger";

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
    handoffConfirmed: z.boolean().optional(),
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

const managedSettingsStateSchema = z
  .object({ operation: z.literal("settings-state"), sessionId: z.string().min(1).max(256) })
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
    })
    .strict(),
  z
    .object({
      operation: z.literal("adopt"),
      requestId: z.string().uuid(),
      deviceId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_:-]+$/),
      sessionId: z.string().min(1).max(256),
      handoffConfirmed: z.boolean().optional(),
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
    effort: z.string().min(1).max(64).optional(),
    serviceTier: z.string().min(1).max(128).optional(),
    mode: z.string().min(1).max(128).optional(),
    policyId: z
      .enum(["workspace-write-on-request", "full-access-on-request", "workspace-write-auto-review"])
      .optional(),
    resetDefaults: z.boolean().optional(),
    goal: z.unknown().optional(),
  })
  .strict()
  .refine(validHistoryControl);

type ManagedRecord = z.infer<typeof managedRecordSchema>;

type ManagedRunner = {
  session: CodexAppServerSession;
  state: ManagedCodexState;
  bridge: ManagedCodexEventBridge;
  persist: ReturnType<typeof createManagedSnapshotWriter>;
  release: () => void;
  planVerified: boolean;
  idleSince: number | null;
  observed: boolean;
  retiring?: boolean;
  retirementFailed?: boolean;
  leaseReleased?: boolean;
};

type CodexFollowerRecord = {
  bridge: CodexFollowerBridge;
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

export class WebReadRequests {
  #codex: CodexAppServerReader;
  #preflight: CodexRuntimePreflight;
  #ownership = new Map<string, { checkedAt: number; reason: string | null }>();
  #catalogObservations = new Map<string, { at: number; status: string; reason: string | null }>();
  #retirementTimer: ReturnType<typeof setInterval>;
  #retiring = false;
  #controlSessions = new Map<string, { count: number; observed: boolean }>();
  #closing?: Promise<void>;
  #shuttingDown = false;
  #operations = new Set<Promise<unknown>>();
  #bootId = randomUUID();
  #managedRunners = new Map<string, ManagedRunner>();
  #startingRunners = new Map<string, ManagedRunner>();
  #transientSessions = new Set<CodexAppServerSession>();
  #codexFollowers = new Map<string, CodexFollowerRecord>();
  #codexFollowerFlights = new Map<string, Promise<CodexFollowerRecord>>();
  #antigravityRunners = new Map<string, AntigravityRunnerRecord>();
  #antigravityRunnerFlights = new Map<string, Promise<AntigravityRunnerRecord>>();

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly dataDir: string,
    readonly indexGeneration: () => bigint,
    readonly environment: NodeJS.ProcessEnv,
    readonly publishConversationEvent?: (
      sessionId: string,
      type: "state" | "text-delta" | "item-upsert" | "snapshot",
      payload: Record<string, unknown>,
      live: Record<string, unknown>,
    ) => void,
    readonly isSessionObserved?: (sessionId: string) => boolean,
    readonly sessionIndex?: SessionIndex,
    readonly catalogChanged?: () => void,
  ) {
    this.#codex = new CodexAppServerReader(environment);
    this.#preflight = new CodexRuntimePreflight(environment);
    this.#retirementTimer = setInterval(() => void this.#retireIdleRunners(), 1000);
    this.#retirementTimer.unref();
  }

  close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  closeAsync(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#shuttingDown = true;
    clearInterval(this.#retirementTimer);
    this.#preflight.close();
    return (this.#closing = this.#close());
  }

  async #close(): Promise<void> {
    const pending = [this.#codex.closeAsync()];
    for (const record of this.#antigravityRunners.values()) record.runner.close();
    this.#antigravityRunners.clear();
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

  managedOptions() {
    return this.#runOperation(() => this.#managedOptions());
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
      const [response] = await this.#codex.requestMany(executable, home, home, [
        ["model/list", { limit: 100 }],
      ]);
      const rows = isObject(response) && Array.isArray(response.data) ? response.data : null;
      if (!rows) throw new Error("invalid-model-catalog");
      const models = rows
        .filter((model) => isObject(model) && model.hidden !== true)
        .slice(0, 100)
        .map((model) => ({
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
          serviceTiers: Array.isArray(model.serviceTiers)
            ? model.serviceTiers
                .slice(0, 16)
                .map((tier: unknown) =>
                  isObject(tier)
                    ? { id: tier.id, name: tier.name, description: tier.description }
                    : {},
                )
            : [],
        }));
      const defaultModel = models.find((model) => model.isDefault === true);
      return {
        available: true,
        executionMode: "codex-managed",
        models,
        defaults: {
          model: defaultModel?.id ?? null,
          effort: defaultModel?.defaultEffort ?? null,
          serviceTier: defaultModel?.defaultServiceTier ?? null,
        },
        policies: managedPolicyCatalog(),
      };
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
    let id: string;
    let workspaceId: string;
    let nativeId: string | null = null;
    let title = "Codex";
    let adopted = false;
    let policyId = "workspace-write-on-request";
    let model: string | null = null;
    let effort: string | null = null;

    if (request.operation === "create") {
      id = createHash("sha256").update(`managed:${request.requestId}`).digest("hex");
      workspaceId = request.workspaceId;
      policyId = request.policyId;
      model = request.model ?? null;
      effort = request.effort ?? null;
      if (effort && !model) throw new Error("effort-requires-model");
    } else {
      const summary = this.store.sessions.get(request.sessionId);
      if (!summary) throw new Error("session-unavailable");
      if (summary.agent !== "codex" || summary.sidechain) throw new Error("session-not-adoptable");
      if (records.some((record) => record.id === request.sessionId && !record.released))
        throw new Error("session-already-managed");
      const resolved = await this.sessions.resolve(request.sessionId);
      if (resolved.summary.agent !== "codex" || resolved.native.agent !== "codex")
        throw new Error("session-not-adoptable");
      nativeId = resolved.native.native_ref;
      const verified = this.sessions.verifiedCodexControlIds([nativeId]);
      if (!verified.has(nativeId.toLowerCase())) throw new Error("unverified-session");
      if (
        records.some(
          (record) => (!record.released || !record.adopted) && record.native_id === nativeId,
        )
      )
        throw new Error("session-already-managed");
      id = request.sessionId;
      workspaceId = summary.workspace_id;
      title = summary.title ?? "Codex";
      adopted = true;
    }

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
      native_id: nativeId,
      model,
      effort,
      service_tier: null,
      policy_id: policyId,
      default_model: null,
      default_effort: null,
      default_service_tier: null,
      native_settings: null,
      mode: null,
      source_session_id: null,
      title,
      created_at: new Date().toISOString(),
      released: false,
      adopted,
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

  managedResume(value: unknown, automatic = false) {
    return this.#runOperation(() => this.#managedResume(value, automatic));
  }

  async #managedResume(value: unknown, automatic = false) {
    const request = managedResumeSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    const record = readManagedRecords(this.dataDir, this.store, true).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) {
      if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
        throw new Error("stale-or-disabled-control");
      return this.managedLifecycle(
        {
          operation: "adopt",
          requestId: request.requestId,
          deviceId: request.deviceId,
          sessionId: request.sessionId,
          handoffConfirmed: request.handoffConfirmed,
        },
        fingerprint,
      );
    }
    if (!record.released && !automatic) throw new Error("session-not-released");
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
      (!latest.released && !automatic) ||
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

  managedQueueList(value: unknown) {
    return this.#runOperation(() => this.#managedQueueList(value));
  }

  async #managedQueueList(value: unknown) {
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
      const executable = resolveCommand("codex", this.environment);
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
      const executable = resolveCommand("codex", this.environment);
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

  managedSettingsState(value: unknown) {
    return this.#runOperation(() => this.#managedSettingsState(value));
  }

  async #managedSettingsState(value: unknown) {
    const request = managedSettingsStateSchema.parse(value);
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    const record = stored ?? (await this.#inactiveRecord(request.sessionId));
    const ownerSnapshot = await this.#managedLive(request.sessionId);
    const settings = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.#bootId,
      false,
    ).settings;
    const settingsObject = isObject(settings) ? settings : {};
    const runner = this.#managedRunners.get(request.sessionId);
    if (!runner?.session.connected) {
      if (ownerSnapshot.reason)
        return {
          available: false,
          executionMode: "codex-managed",
          reason: ownerSnapshot.reason,
          settings: settingsObject,
        };
      const checked = await this.#preflight.check();
      if (!checked.executable || checked.reason)
        return {
          available: false,
          executionMode: "codex-managed",
          reason: checked.reason,
          settings: settingsObject,
        };
      const models = projectManagedModels(
        await this.#codex.request(
          checked.executable,
          this.#managedCwd(record),
          this.#assertManagedHome(record),
          "model/list",
          { limit: 100 },
        ),
      );
      return {
        available: true,
        executionMode: "codex-managed",
        models,
        policies: managedPolicyCatalog(),
        collaborationModes: [],
        revision: record.snapshot?.revision ?? 0,
        runtimeBootId: this.#bootId,
        settings: {
          ...settingsObject,
          writable: {
            model: true,
            effort: true,
            mode: { available: false, reason: "native-collaboration-modes-unavailable" },
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
    let collaborationModes: Array<{ id: string; name: string }> = [];
    let modeWritable: Record<string, unknown> = {
      available: false,
      reason: "native-collaboration-modes-unavailable",
    };
    if (runner.planVerified) {
      const value = await runner.session.request("collaborationMode/list", {});
      const rows = isObject(value) && Array.isArray(value.data) ? value.data : [];
      collaborationModes = rows
        .filter(
          (row): row is Record<string, unknown> =>
            isObject(row) &&
            (row.mode === "default" || row.mode === "plan") &&
            typeof row.name === "string" &&
            row.name.length > 0 &&
            Buffer.byteLength(row.name, "utf8") <= 256,
        )
        .map((row) => ({ id: row.mode as string, name: row.name as string }));
      if (collaborationModes.length > 0) modeWritable = { available: true };
    }
    const live = await runner.bridge.snapshot(this.#bootId, false);
    return {
      available: true,
      executionMode: "codex-managed",
      settings: {
        ...settingsObject,
        writable: {
          model: true,
          effort: true,
          mode: modeWritable,
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

  managedQuery(value: unknown) {
    return this.#runOperation(() => this.#managedQuery(value));
  }

  async #managedQuery(value: unknown) {
    const request = managedQuerySchema.parse(value);
    if (this.store.sessions.get(request.sessionId)?.agent === "antigravity") {
      let runner: AntigravityRunnerRecord;
      try {
        runner = await this.#antigravityRunner(request.sessionId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "open-in-original-client";
        const operations = ["send", "stop", "approve", "answer", "inspect", "resume", "usage"];
        if (request.operation === "capabilities")
          return {
            sessionId: request.sessionId,
            executionMode: "acp-managed",
            runtimeBootId: this.#bootId,
            status: "unsupported",
            reason,
            features: Object.fromEntries(
              operations.map((operation) => [operation, { available: false, reason }]),
            ),
          };
        return {
          sessionId: request.sessionId,
          executionMode: "acp-managed",
          runtimeBootId: this.#bootId,
          status: "unsupported",
          revision: 0,
          turnId: null,
          approvals: [],
          reason,
        };
      }
      const live = runner.runner.snapshot();
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
                  live.activity === "compacting"
                    ? "session-compacting"
                    : (reason ?? "session-busy"),
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
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (request.operation === "capabilities") {
      if (!record || !this.#managedRunners.get(request.sessionId)?.session.connected) {
        const source = record ?? (await this.#inactiveRecord(request.sessionId));
        const live = await this.#inactiveLive(source, request.experimentalEnabled === true);
        const checked = await this.#preflight.check();
        const controls = request.experimentalEnabled === true;
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
          "resources",
          "attachments",
          "worktree-create",
          "branch-switch",
          "usage",
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
        // Settings can be applied before the first turn by starting our own runner.
        for (const operation of ["settings", "rename", "archive"])
          features[operation] = allowed ? { available: true } : features.send!;
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
      for (const operation of ["send", "rename", "archive", "fork"])
        set(operation, idleControls, controlReason);
      set("settings", idleControls, controlReason);
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
      set("queue-list", managed && verified && healthy && runnerConnected, controlReason);
      set(
        "queue-add",
        managed && verified && healthy && running && !unknown,
        "session-requires-running-turn",
      );
      for (const operation of ["queue-update", "queue-delete", "queue-reorder"])
        set(
          operation,
          managed && verified && healthy && runnerConnected && !unknown,
          controlReason,
        );
      for (const operation of ["queue-start", "worktree-create", "branch-switch"])
        set(operation, false, "native-operation-not-integrated");
      set("approve", managed && verified && healthy && runnerConnected && !unknown, controlReason);
      set("answer", managed && verified && healthy && runnerConnected && !unknown, controlReason);
      set("attachments", false, "native-operation-not-integrated");
      return {
        sessionId: request.sessionId,
        executionMode: "codex-managed",
        status: live.status,
        reason: live.reason,
        features,
      };
    }

    this.#ownership.delete(request.sessionId);

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
    const executable = resolveCommand("codex", this.environment);
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
        if (
          !managedSettingsEvidenceMatches(unknown.evidence, latest) &&
          !nativeRequestResolved &&
          !queuedAddResolved &&
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
      for (const unknown of readUnknownManagedCommands(this.dataDir, request.sessionId)) {
        if (managedCommandReconciles(unknown.requestId, unknown.evidence, thread))
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

  managedControl(value: unknown) {
    return this.#runOperation(() => this.#managedControlAdmission(value));
  }

  async #managedControlAdmission(value: unknown) {
    const request = managedControlSchema.parse(value);
    const id = request.sessionId;
    const admission = this.#controlSessions.get(id) ?? { count: 0, observed: false };
    admission.count += 1;
    admission.observed ||= this.isSessionObserved?.(id) === true;
    this.#controlSessions.set(id, admission);
    const runner = this.#managedRunners.get(id);
    if (runner && admission.observed) runner.observed = true;
    try {
      return await this.#managedControl(value);
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

  async #managedControl(value: unknown) {
    const request = managedControlSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;
    if (this.store.sessions.get(request.sessionId)?.agent === "antigravity")
      return this.#antigravityControl(request, fingerprint);

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
    let runner = this.#managedRunners.get(request.sessionId);
    let resumedControlState: string | undefined;
    if (!runner?.session.connected || runner.retiring) {
      const inactive = record ?? (await this.#inactiveRecord(request.sessionId));
      const reject = (reason: string) => {
        const result = {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason,
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
        // This acknowledgement may itself be lost between the backend, host and
        // browser. Give the unsent parent operation a device-bound receipt too;
        // never overwrite a concurrent claim or the child's unknown resume.
        const claimed = claimManagedCommand(
          this.dataDir,
          request.requestId,
          request.sessionId,
          fingerprint,
          request.deviceId ?? null,
          {
            operation: request.operation,
            workspaceId: inactive.workspace_id,
            runtimeBootId: request.runtimeBootId,
            expectedRevision: request.expectedRevision,
            executionMode: "codex-managed",
            turnId: null,
            nativeRequestId: null,
            ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
          },
        );
        if (claimed) return claimed;
        finishManagedCommand(this.dataDir, request.requestId, result);
        return result;
      };
      if (runner?.retiring || managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        return reject("control-outcome-unconfirmed");
      if (request.expectedRevision !== (inactive.snapshot?.revision ?? 0))
        return reject("stale-or-disabled-control");
      if (!["send", "settings", "rename", "archive"].includes(request.operation))
        return reject("session-not-running");
      const checked = await this.#preflight.check();
      if (checked.reason) return reject(checked.reason);
      // Only resume is authoritative: the earlier focus probe can race another client.
      try {
        const resumed: unknown = await this.managedResume(
          {
            operation: "resume",
            sessionId: request.sessionId,
            requestId: randomUUID(),
            deviceId: request.deviceId ?? "agentkib-local-owner",
            runtimeBootId: this.#bootId,
            expectedRevision: request.expectedRevision,
            experimentalEnabled: true,
          },
          true,
        );
        if (!isObject(resumed) || resumed.accepted !== true) {
          const reason =
            isObject(resumed) && typeof resumed.reason === "string"
              ? resumed.reason
              : "recovery-required";
          if (reason === "codex-owner-busy")
            this.#ownership.set(request.sessionId, { checkedAt: Date.now(), reason });
          // The native resume has its own durable receipt. Even if its reply is
          // lost, this user operation has not reached turn/start (or another
          // user mutation). Keep the child uncertainty as the session fence,
          // while allowing the caller to clear this unsent message's receipt.
          return reject(reason);
        }
        runner = this.#managedRunners.get(request.sessionId);
        record = readManagedRecords(this.dataDir, this.store).find(
          (item) => item.id === request.sessionId,
        );
        if (runner) {
          request.expectedRevision = runner.state.revision;
          if (request.operation === "send") resumedControlState = managedControlState(runner.state);
        }
      } catch (error) {
        return reject(
          codexWriterBusy(error)
            ? "codex-owner-busy"
            : error instanceof Error
              ? error.message
              : "recovery-required",
        );
      }
    }
    if (!record) throw new Error("session-unavailable");
    if (!runner || !runner.session.connected) throw new Error("session-runner-unavailable");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");

    const workspace = canonicalize(this.store.workspacePath(record.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(record.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(record);
    if (!record.native_id || record.native_id !== runner.state.nativeId)
      throw new Error("native-session-unconfirmed");
    const cwd = this.#managedCwd(record);
    const snapshot = await runner.bridge.snapshot(this.#bootId, true);
    if (activityBlocks(snapshot, request.operation))
      return compactingRejection(request, this.#bootId);
    if (
      resumedControlState !== undefined &&
      managedControlState(runner.state) === resumedControlState
    )
      request.expectedRevision = Number(snapshot.revision);
    if (snapshot.reason || snapshot.revision !== request.expectedRevision)
      throw new Error("stale-or-disabled-control");
    if (request.operation === "fork")
      return this.#managedFork(request, record, runner, fingerprint);

    const evidence = {
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
      workspaceId: record.workspace_id,
      ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
    };
    const claimed = claimManagedCommand(
      this.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      evidence,
    );
    if (claimed) return claimed;

    try {
      // Fork/resume can retain a native model outside the current picker so the
      // user can inspect it or change next-turn settings without running it.
      // Operations that can request inference still validate before dispatch.
      if (
        ["send", "steer", "queue-add", "queue-start", "goal-set", "goal-resume"].includes(
          request.operation,
        )
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
        if (record.mode) {
          if (!runner.planVerified) throw new Error("native-collaboration-modes-unavailable");
          const modesResult = await runner.session.request("collaborationMode/list", {});
          const modes =
            isObject(modesResult) && Array.isArray(modesResult.data)
              ? modesResult.data.filter(isObject)
              : [];
          if (!modes.some((mode) => mode.mode === record.mode))
            throw new Error("unsupported-collaboration-mode");
        }
        const input = await this.#managedInput(request, record, runner);
        params = {
          threadId: record.native_id,
          clientUserMessageId: request.requestId,
          input,
          ...managedTurnSettings(record, cwd),
        };
        method = "turn/start";
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
        if (snapshot.status !== "idle") throw new Error("session-busy");
        const models = projectManagedModels(
          await runner.session.request("model/list", { limit: 100 }),
        );
        const defaultModel = models.find((item) => item.isDefault);
        const model = request.resetDefaults
          ? record.default_model
          : (request.model ?? record.model);
        const selected =
          models.find((item) => item.id === model) ?? (model ? undefined : defaultModel);
        if (!selected) throw new Error("unsupported-model");
        const effort = request.resetDefaults
          ? record.default_effort
          : (request.effort ?? record.effort);
        if (effort && !selected.efforts.includes(effort)) throw new Error("unsupported-effort");
        const serviceTier = request.resetDefaults
          ? record.default_service_tier
          : (request.serviceTier ?? record.service_tier);
        if (serviceTier && !selected.serviceTiers.includes(serviceTier))
          throw new Error("unsupported-service-tier");
        if (
          request.policyId &&
          !managedPolicyCatalog().some((policy) => policy.id === request.policyId)
        )
          throw new Error("unsupported-policy");
        const mode = request.mode ?? record.mode ?? null;
        if (request.mode) {
          if (!runner.planVerified) throw new Error("native-collaboration-modes-unavailable");
          const catalog = await runner.session.request("collaborationMode/list", {});
          const modes = isObject(catalog) && Array.isArray(catalog.data) ? catalog.data : [];
          if (!modes.some((entry) => isObject(entry) && entry.id === request.mode))
            throw new Error("unsupported-collaboration-mode");
        }
        localMutation = {
          model: selected.id,
          effort,
          service_tier: serviceTier,
          policy_id: request.policyId ?? record.policy_id,
          mode,
        };
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
        params = approval.method === "item/permissions/requestApproval" ? decision : { decision };
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
      const beforeDispatch = () => {
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
          (request.operation === "send" && currentSnapshot.sendEnabled !== true) ||
          (request.operation === "stop" &&
            (currentSnapshot.stopEnabled !== true || currentSnapshot.turnId !== request.turnId)) ||
          (["steer", "approve", "answer"].includes(request.operation) &&
            currentSnapshot.turnId !== request.turnId)
        )
          throw new Error("stale-or-disabled-control");
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
        beforeDispatch();
        runner.state.commitManagedMutation(localMutation);
        runner.persist(runner.state);
        response = { appliesTo: "next-turn" };
      } else {
        response = await runner.session.request(method, params, beforeDispatch);
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
        runner.persist(runner.state);
      }
      const result = {
        accepted: true,
        completed: !["send", "stop", "steer"].includes(request.operation),
        ...(request.operation === "settings" ? { appliesTo: "next-turn" } : {}),
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

  // Retained for the separately approved Desktop-follower cleanup.
  // oxlint-disable-next-line no-unused-private-class-members
  async #reconcileCodexFollower(
    request: z.infer<typeof managedReconcileSchema>,
  ): Promise<Record<string, unknown>> {
    const summary = this.store.sessions.get(request.sessionId);
    if (!summary || summary.agent !== "codex") throw new Error("session-unavailable");
    const unknown = readUnknownManagedCommands(this.dataDir, request.sessionId);
    if (unknown.length === 0)
      return { sessionId: request.sessionId, reconciled: true, unresolvedCount: 0 };

    const resolved = await this.sessions.resolve(request.sessionId);
    const nativeId = resolved.native.native_ref;
    if (!this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
      throw new Error("unverified-session-identity");
    const workspace = canonicalize(resolved.workspace);
    if (
      pathIdentity(canonicalize(this.store.workspacePath(summary.workspace_id))) !==
      pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");

    const needsHistory = unknown.some(({ evidence }) =>
      ["send", "stop"].includes(String(evidence?.operation)),
    );
    let thread: Record<string, unknown> | null = null;
    if (needsHistory) {
      const executable = resolveCommand("codex", this.environment);
      if (!executable) throw new Error("codex-cli-unavailable");
      const response = await this.#codex.request(
        executable,
        workspace,
        canonicalize(this.sessions.codexHome()),
        "thread/read",
        { threadId: nativeId, includeTurns: true },
      );
      const candidate = isObject(response) ? response.thread : null;
      if (!isObject(candidate) || candidate.id !== nativeId)
        throw new Error("thread-identity-mismatch");
      if (typeof candidate.cwd !== "string" || !within(canonicalize(candidate.cwd), workspace))
        throw new Error("codex-context-outside-workspace");
      thread = candidate;
    }

    const follower = await this.#codexFollower(request.sessionId);
    const state = await follower.bridge.refresh();
    let unresolvedCount = 0;
    for (const command of unknown) {
      const evidence = command.evidence;
      let reconciled = false;
      if (
        evidence?.executionMode === "codex-follower" &&
        ["send", "stop"].includes(String(evidence.operation)) &&
        thread
      ) {
        reconciled = managedCommandReconciles(command.requestId, evidence, thread);
      } else if (
        evidence?.executionMode === "codex-follower" &&
        ["approve", "answer"].includes(String(evidence.operation)) &&
        evidence.nativeRequestId != null &&
        typeof evidence.turnId === "string"
      ) {
        reconciled = !state.hasPendingRequest(evidence.nativeRequestId, evidence.turnId);
      } else if (
        evidence?.executionMode === "codex-follower" &&
        evidence.operation === "settings" &&
        isObject(evidence.expectedNativeSettings)
      ) {
        reconciled = managedFollowerSettingsMatch(
          evidence.expectedNativeSettings,
          state.snapshot(),
        );
      }
      if (!reconciled) {
        unresolvedCount += 1;
        continue;
      }
      finishManagedCommand(this.dataDir, command.requestId, {
        accepted: true,
        completed: false,
        reconciled: true,
        requestId: command.requestId,
        runtimeBootId: this.#bootId,
        sessionId: request.sessionId,
      });
    }
    return {
      sessionId: request.sessionId,
      reconciled: unresolvedCount === 0,
      reason: unresolvedCount === 0 ? null : "control-outcome-unconfirmed",
      unresolvedCount,
      nativeStatus: thread?.status ?? state.status,
      context: await this.#context(request.sessionId),
      executionUnchanged: true,
    };
  }

  // Retained for the separately approved Desktop-follower cleanup.
  // oxlint-disable-next-line no-unused-private-class-members
  async #codexFollowerControl(
    request: z.infer<typeof managedControlSchema>,
    fingerprint: string,
  ): Promise<Record<string, unknown>> {
    let dispatched = false;
    try {
      if (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId)
        throw new Error("stale-or-disabled-control");
      if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
        throw new Error("control-outcome-unconfirmed");
      const follower = await this.#codexFollower(request.sessionId);
      const state = await follower.bridge.observeLive();
      if (state.revision !== request.expectedRevision) throw new Error("stale-or-disabled-control");
      const live = state.live(true);
      assertActivityAllows(live, request.operation);
      const turnId = request.turnId;
      let method: string;
      let params: Record<string, unknown>;
      let responseId: string | number | null = null;
      let expectedNativeSettings: Record<string, unknown> | undefined;

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
        const options = Array.isArray(approval.decisionOptions) ? approval.decisionOptions : [];
        if (
          !options.some(
            (option) => isObject(option) && stableJson(option.decision) === stableJson(decision),
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
      } else if (request.operation === "answer") {
        if (!turnId || state.activeTurn() !== turnId) throw new Error("missing-question");
        const questionId = request.questionId;
        if (questionId === undefined) throw new Error("missing-question");
        const question = state
          .questions(true)
          .find(
            (item) =>
              managedRequestKey(item.requestId) === managedRequestKey(questionId) &&
              item.turnId === turnId,
          );
        if (!question || question.supported !== true || !Array.isArray(question.questions))
          throw new Error("unsupported-question");
        if (!request.answers) throw new Error("missing-answers");
        responseId = questionId;
        method = "thread-follower-submit-user-input";
        params = {
          conversationId: state.conversationId,
          requestId: questionId,
          response: followerAnswerPayload(question.questions, request.answers),
        };
      } else {
        if (!follower.bridge.supportsThreadSettings)
          throw new Error("follower-operation-unverified");
        if (live.status !== "idle") throw new Error("session-busy");
        if (request.model || request.effort || request.serviceTier || request.resetDefaults)
          throw new Error("follower-setting-read-only");
        const native = state.snapshot();
        if (!native) throw new Error("state-unavailable");
        const threadSettings = followerThreadSettings(
          native,
          follower.workspace,
          request.mode,
          request.policyId,
        );
        expectedNativeSettings = threadSettings;
        method = "thread-follower-update-thread-settings";
        params = {
          conversationId: state.conversationId,
          threadSettings,
          activeTurnId: null,
          condition: {
            ifModelEquals: native.latestModel,
            ifEffortEquals: native.latestReasoningEffort ?? null,
          },
        };
      }

      const claimed = claimManagedCommand(
        this.dataDir,
        request.requestId,
        request.sessionId,
        fingerprint,
        request.deviceId ?? null,
        {
          operation: request.operation,
          turnId: turnId ?? null,
          nativeRequestId: responseId,
          expectedNativeSettings: expectedNativeSettings ?? null,
          runtimeBootId: request.runtimeBootId,
          expectedRevision: request.expectedRevision,
          executionMode: "codex-follower",
          ...(request.historyInputHash ? { historyInputHash: request.historyInputHash } : {}),
        },
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
        if (request.operation === "settings" && (!isObject(result) || result.applied !== true))
          throw new Error("owner rejected stale settings");
        if (request.operation === "stop") {
          if (!isObject(result) || result.ok !== true || result.interruptedTurnId !== turnId)
            throw new Error("unconfirmed-turn");
        }
        const accepted = {
          accepted: true,
          completed: !["send", "stop"].includes(request.operation),
          ...(request.operation === "settings" ? { appliesTo: "next-turn" } : {}),
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
          : request.expectedRevision !== (source.snapshot?.revision ?? 0)
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

  // Retained without callers until removal of Desktop following is separately approved.
  // oxlint-disable-next-line no-unused-private-class-members
  async #legacyCodexOwnershipPreflight(
    request: { sessionId: string; requestId: string },
    operation: "adopt" | "resume",
  ) {
    const observer = this.#codexFollowers.get(request.sessionId);
    if (observer) {
      const observed = await observer.bridge.observeLive();
      if (activityBlocks(observed.live(false), operation))
        return compactingRejection(request, this.#bootId);
    }
  }

  // Legacy Desktop observation and its final write-boundary recheck are kept
  // intact for that cleanup review; native writer locks now govern the main path.
  // oxlint-disable-next-line no-unused-private-class-members
  async #legacyCodexOwnershipDispatch(
    record: ManagedRecord,
    nativeId: string | null,
    fork: { nativeId: string; lastTurnId: string } | undefined,
    dispatch?: () => void,
  ): Promise<() => void> {
    const ownershipObserver = nativeId && !fork ? this.#codexFollowers.get(record.id) : undefined;
    let observedOwnershipState: CodexFollowerState | undefined;
    if (ownershipObserver) {
      const observed = await ownershipObserver.bridge.observeLive();
      assertActivityAllows(observed.live(false), record.adopted ? "adopt" : "resume");
      observedOwnershipState = observed;
    }
    return () => {
      if (ownershipObserver) {
        const selected = ownershipObserver.bridge.selectedState;
        if (
          this.#codexFollowers.get(record.id) !== ownershipObserver ||
          !ownershipObserver.bridge.connected ||
          !selected ||
          selected !== observedOwnershipState ||
          selected.conversationId !== nativeId ||
          selected.revision === null
        )
          throw new Error("recovery-required");
        assertActivityAllows(selected.live(false), record.adopted ? "adopt" : "resume");
        if (
          ["waiting-for-snapshot", "unsupported", "disconnected", "outcome-unknown"].includes(
            selected.status,
          )
        )
          throw new Error("recovery-required");
      }
      dispatch?.();
    };
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
    const persist = createManagedSnapshotWriter(this.dataDir, record);
    let previousStreamText = "";
    let startingRunner: ManagedRunner | undefined;
    const captureRunner = (session: CodexAppServerSession) => {
      if (startingRunner) return;
      const bridge = new ManagedCodexEventBridge(
        session,
        state,
        persist,
        (value, result, current) => {
          const live = current.snapshot(this.#bootId, session.connected);
          const envelope = isObject(value) ? value : {};
          const method = typeof envelope.method === "string" ? envelope.method : "";
          const params = isObject(envelope.params) ? envelope.params : {};
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
      );
      startingRunner = {
        session,
        state,
        bridge,
        persist,
        release: release ?? (() => {}),
        planVerified: false,
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
      const runner = startingRunner!;
      const bridge = runner.bridge;
      this.#assertOpen();
      const modelsResult = await session.request("model/list", { limit: 100 });
      const models = projectManagedModels(modelsResult);
      const requestedModel = record.model ?? null;
      const requestedEffort = record.effort ?? null;
      // Creating a new thread is an explicit model choice. Attaching an existing
      // thread or its fork must also work when its inherited model left the picker;
      // send and explicit settings changes validate their own model selection.
      if (!nativeId && !fork) validateManagedModelSelection(record, models);
      const tier = record.service_tier ?? null;

      let goal: Record<string, unknown> | null = null;
      if (nativeId) {
        const goalResult = await session.request("thread/goal/get", { threadId: nativeId });
        goal = isObject(goalResult) && isObject(goalResult.goal) ? goalResult.goal : null;
        if (goal?.status === "active") throw new Error("pause-original-goal-before-handoff");
      }

      const params = managedResumeParams(record, cwd);
      if (requestedModel) params.model = requestedModel;
      if (requestedEffort)
        (params.config as Record<string, unknown>).model_reasoning_effort = requestedEffort;
      if (tier) params.serviceTier = tier;
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

      const mutableRecord = state.record as ManagedRecord;
      mutableRecord.model = model;
      mutableRecord.effort = effort;
      mutableRecord.service_tier = normalizeManagedTier(response.serviceTier);
      mutableRecord.native_settings = {
        model,
        effort,
        serviceTier: response.serviceTier ?? null,
        approvalPolicy: response.approvalPolicy,
        approvalsReviewer: response.approvalsReviewer,
        sandboxPolicy: response.sandbox,
        collaborationMode: null,
      };
      mutableRecord.goal = goal;
      const defaultModel = models.find((entry) => entry.isDefault === true);
      mutableRecord.default_model = defaultModel?.id ?? null;
      mutableRecord.default_effort = defaultModel?.defaultEffort ?? null;
      mutableRecord.default_service_tier = defaultModel?.defaultServiceTier ?? null;
      await bridge.flush();
      this.#assertOpen();
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

  async #request(value: unknown) {
    const request = requestSchema.parse(value);
    if (request.operation === "live") {
      const session = this.store.sessions.get(request.sessionId);
      if (session?.agent === "antigravity") return this.#antigravityLive(request.sessionId);
      if (session && session.agent !== "codex" && session.agent !== "claude-code")
        return {
          sessionId: request.sessionId,
          runtimeBootId: this.#bootId,
          executionMode: "codex-follower",
          status: "idle",
          revision: 0,
          turnId: null,
          sendEnabled: false,
          stopEnabled: false,
          approvals: [],
          questions: [],
          reason: "control-disabled",
        };
      return this.#managedLive(request.sessionId, request.experimentalEnabled === true);
    }
    if (request.operation === "context") return this.#context(request.sessionId);
    if (request.operation === "resume-command") return this.#resumeCommand(request.sessionId);
    if (request.operation === "usage") {
      const live =
        this.store.sessions.get(request.sessionId)?.agent === "antigravity"
          ? await this.#antigravityLive(request.sessionId)
          : await this.#managedLive(request.sessionId, false);
      return (
        projectContextUsage(live.usage) ?? {
          available: false,
          state: "unavailable",
          reason: typeof live.reason === "string" ? live.reason : "usage-not-reported",
        }
      );
    }
    if (request.operation === "goal") return this.#goal(request.sessionId);
    if (request.operation === "resources") return this.#resources(request.sessionId);
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
        let events;
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
          );
          events = {
            ...page,
            next_cursor: page.next_cursor ? nativePrefix + page.next_cursor : null,
          };
        } else {
          events = readManagedEvents(
            this.dataDir,
            request.sessionId,
            request.cursor,
            request.limit,
          );
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
        return { workspaces: [], sessions: [], indexEnabled: false };
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
          title: record.title,
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
      const runtime = needsRuntime ? await this.#preflight.check() : null;
      if (this.indexGeneration() !== generation || indexEnabled(this.dataDir) !== enabled)
        return { workspaces: [], sessions: [], indexEnabled: false };
      return {
        codexRuntimeReason: runtime?.reason === "codex-cli-version-too-old" ? runtime.reason : null,
        workspaces: workspaces
          .filter((workspace) => registered.has(workspace.id))
          .map(({ id, name, path }) => ({ id, name, path })),
        sessions: sessions.map((session) => {
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
          return continuation ? { ...session, continuation } : session;
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

  async #inactiveLive(record: ManagedRecord, controls: boolean): Promise<Record<string, unknown>> {
    const checked = await this.#preflight.check();
    let reason = checked.reason;
    try {
      this.#managedCwd(record);
    } catch (error) {
      reason = error instanceof Error ? error.message : "codex-session-directory-unverified";
    }
    if (!reason && record.native_id) {
      let ownership = this.#ownership.get(record.id);
      if (!ownership || Date.now() - ownership.checkedAt >= 4000) {
        try {
          ownership = {
            checkedAt: Date.now(),
            reason: existingFileLeaseBusy(
              path.join(record.home, "thread-writer-locks", `${record.native_id}.lock`),
            )
              ? "codex-owner-busy"
              : null,
          };
        } catch {
          ownership = { checkedAt: Date.now(), reason: "codex-owner-check-unavailable" };
        }
        this.#ownership.set(record.id, ownership);
      }
      reason = ownership.reason;
    }
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
      sendEnabled: controls && reason === null && !starting,
      stopEnabled: false,
      approvals: [],
      questions: [],
      turnId: null,
      activity: null,
      reason,
    };
  }

  async #retireIdleRunners(): Promise<void> {
    if (this.#closing || this.#retiring) return;
    this.#retiring = true;
    try {
      for (const [id, runner] of this.#managedRunners) {
        if (runner.retiring || this.#controlSessions.has(id)) continue;
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

  async #managedLive(
    sessionId: string,
    experimentalEnabled = false,
  ): Promise<Record<string, unknown>> {
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (!managed) {
      try {
        return await this.#inactiveLive(await this.#inactiveRecord(sessionId), experimentalEnabled);
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
      return resident.bridge.snapshot(
        this.#bootId,
        !managedSessionHasUnknownCommands(this.dataDir, sessionId),
      );
    }
    if (resident) {
      await this.#closeManagedRunner(sessionId, resident);
    }

    return this.#inactiveLive(managed, experimentalEnabled);
  }

  async #antigravityLive(sessionId: string): Promise<Record<string, unknown>> {
    try {
      const record = await this.#antigravityRunner(sessionId);
      return {
        ...record.runner.snapshot(),
        sessionId,
        runtimeBootId: this.#bootId,
      };
    } catch (error) {
      return {
        sessionId,
        executionMode: "acp-managed",
        runtimeBootId: this.#bootId,
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

  async #antigravityRunner(sessionId: string): Promise<AntigravityRunnerRecord> {
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
    if (resolved.native.sidechain) throw new Error("auxiliary-session-not-controllable");
    const nativeId = resolved.native.native_ref;
    const workspace = canonicalize(resolved.workspace);
    const workspaceId = summary.workspace_id;
    const registeredWorkspace = canonicalize(this.store.workspacePath(workspaceId));
    if (!within(workspace, registeredWorkspace)) throw new Error("session-workspace-mismatch");
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
    if (cached) {
      this.#antigravityRunners.delete(sessionId);
      cached.runner.close();
    }
    const pending = this.#antigravityRunnerFlights.get(sessionId);
    if (pending) return pending;
    const flight = this.#connectAntigravityRunner(sessionId, workspaceId, workspace, nativeId);
    this.#antigravityRunnerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#antigravityRunnerFlights.get(sessionId) === flight)
        this.#antigravityRunnerFlights.delete(sessionId);
    }
  }

  async #connectAntigravityRunner(
    sessionId: string,
    workspaceId: string,
    workspace: string,
    nativeId: string,
  ): Promise<AntigravityRunnerRecord> {
    if (this.#antigravityRunners.size >= 8) {
      const candidates = [...this.#antigravityRunners.entries()]
        .filter(([, value]) => ["idle", "failed"].includes(String(value.runner.snapshot().status)))
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const [retireId, retire] = candidates[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-limit");
      this.#antigravityRunners.delete(retireId);
      retire.runner.close();
    }
    const runner = await AntigravityManagedRunner.connect(
      this.sessions.antigravityControlExecutable(),
      workspace,
      nativeId,
      { ...process.env, ...this.environment },
      (type, payload, live) => {
        const current = { ...live, sessionId, runtimeBootId: this.#bootId };
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

  async #antigravityControl(request: z.infer<typeof managedControlSchema>, fingerprint: string) {
    const runtimeBootId = this.#bootId;
    if (!request.experimentalEnabled || request.runtimeBootId !== runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
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
    let dispatched = false;
    const beforeDispatch = () => {
      assertActivityAllows(record.runner.snapshot(), request.operation);
      dispatchManagedCommand(this.dataDir, request.requestId);
      dispatched = true;
    };
    try {
      if (request.operation === "send") {
        if (typeof request.text !== "string") throw new Error("missing-text");
        await record.runner.send(request.text, request.expectedRevision, beforeDispatch);
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
      return result;
    } catch (error) {
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

  async #codexFollower(sessionId: string): Promise<CodexFollowerRecord> {
    if (process.platform !== "darwin") throw new Error("platform-unsupported");
    const resolved = await this.sessions.resolve(sessionId);
    if (resolved.summary.agent !== "codex") throw new Error("session-not-codex");
    const nativeId = resolved.native.native_ref;
    if (!this.sessions.verifiedCodexControlIds([nativeId]).has(nativeId.toLowerCase()))
      throw new Error("unverified-session-identity");
    const workspace = canonicalize(resolved.workspace);
    const workspaceId = resolved.summary.workspace_id;
    if (
      pathIdentity(canonicalize(this.store.workspacePath(workspaceId))) !== pathIdentity(workspace)
    )
      throw new Error("session-workspace-mismatch");

    const cached = this.#codexFollowers.get(sessionId);
    if (
      cached?.bridge.connected &&
      cached.nativeId === nativeId &&
      cached.workspaceId === workspaceId &&
      pathIdentity(cached.workspace) === pathIdentity(workspace)
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
    const flight = this.#connectCodexFollower(sessionId, workspaceId, workspace, nativeId);
    this.#codexFollowerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#codexFollowerFlights.get(sessionId) === flight)
        this.#codexFollowerFlights.delete(sessionId);
    }
  }

  async #connectCodexFollower(
    sessionId: string,
    workspaceId: string,
    workspace: string,
    nativeId: string,
  ): Promise<CodexFollowerRecord> {
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
    const home = canonicalize(this.sessions.codexHome());
    const endpoint = path.join(home, "ipc", "ipc.sock");
    const bridge = await CodexFollowerBridge.connect(endpoint, nativeId, (snapshot) => {
      const live = {
        ...snapshot.live,
        sessionId,
        runtimeBootId: this.#bootId,
      };
      this.publishConversationEvent?.(
        sessionId,
        "snapshot",
        {
          live,
          items: snapshot.items,
          replaceItems: true,
          preserveItemsOutsideCoverage: true,
        },
        live,
      );
    });
    try {
      const latest = await this.sessions.resolve(sessionId);
      if (
        latest.summary.agent !== "codex" ||
        latest.summary.workspace_id !== workspaceId ||
        latest.native.native_ref !== nativeId ||
        pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
        pathIdentity(canonicalize(this.store.workspacePath(workspaceId))) !==
          pathIdentity(workspace)
      )
        throw new Error("session-unavailable");
      const record = { bridge, workspaceId, workspace, nativeId, lastUsed: Date.now() };
      this.#codexFollowers.set(sessionId, record);
      return record;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }

  // Retained for the separately approved Desktop-follower cleanup.
  // oxlint-disable-next-line no-unused-private-class-members
  async #codexFollowerLive(
    sessionId: string,
    experimentalEnabled: boolean,
  ): Promise<Record<string, unknown>> {
    try {
      const follower = await this.#codexFollower(sessionId);
      const state = await follower.bridge.observeLive();
      follower.lastUsed = Date.now();
      return {
        ...state.live(experimentalEnabled),
        sessionId,
        runtimeBootId: this.#bootId,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "session-not-codex",
          "session-workspace-mismatch",
          "session-unavailable",
          "unverified-session-identity",
        ].includes(error.message)
      )
        throw error;
      return {
        sessionId,
        runtimeBootId: this.#bootId,
        executionMode: "codex-follower",
        status: "unsupported",
        revision: null,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        reason: followerReason(error),
      };
    }
  }

  // Retained for the separately approved Desktop-follower cleanup.
  // oxlint-disable-next-line no-unused-private-class-members
  async #followerCapabilities(
    sessionId: string,
    experimentalEnabled: boolean,
  ): Promise<Record<string, unknown>> {
    const operations = [
      "send",
      "stop",
      "approve",
      "answer",
      "inspect",
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
      "usage",
      "goal",
      "goal-set",
      "goal-pause",
      "goal-resume",
      "goal-clear",
      "resources",
      "attachments",
      "worktree-create",
      "branch-switch",
    ];
    let follower: CodexFollowerRecord;
    let state: CodexFollowerState;
    try {
      follower = await this.#codexFollower(sessionId);
      state = await follower.bridge.observeLive();
    } catch (error) {
      const reason = followerReason(error);
      return {
        sessionId,
        executionMode: "codex-follower",
        status: "unsupported",
        reason,
        features: Object.fromEntries(
          operations.map((operation) => [operation, { available: false, reason }]),
        ),
      };
    }
    const live = state.live(experimentalEnabled);
    const verified = resolveCommand("codex", this.environment) !== null;
    const idle = live.status === "idle";
    const compacting = live.activity === "compacting";
    const set = (operation: string, available: boolean, reason = "follower-operation-unverified") =>
      [operation, available ? { available: true } : { available: false, reason }] as const;
    const controlReason = !verified
      ? "unsupported-codex-cli-version"
      : !experimentalEnabled
        ? "control-disabled"
        : typeof live.reason === "string"
          ? live.reason
          : live.status === "outcome-unknown"
            ? "control-outcome-unconfirmed"
            : compacting
              ? "session-compacting"
              : "session-busy";
    const features = Object.fromEntries([
      set("send", live.sendEnabled === true, controlReason),
      set("stop", live.stopEnabled === true, controlReason),
      set(
        "approve",
        experimentalEnabled && state.approvals(true).some((item) => item.supported === true),
        controlReason,
      ),
      set(
        "answer",
        experimentalEnabled && state.questions(true).some((item) => item.supported === true),
        controlReason,
      ),
      set("inspect", verified, "unsupported-codex-cli-version"),
      set("resume", experimentalEnabled && verified, controlReason),
      ...operations
        .filter(
          (operation) =>
            ![
              "send",
              "stop",
              "approve",
              "answer",
              "inspect",
              "resume",
              "settings",
              "usage",
            ].includes(operation),
        )
        .map((operation) => set(operation, false)),
      set(
        "settings",
        follower.bridge.supportsThreadSettings && experimentalEnabled && idle && !compacting,
        follower.bridge.supportsThreadSettings ? controlReason : "follower-operation-unverified",
      ),
      set("usage", isObject(live.usage) && live.usage.available === true, "usage-not-reported"),
    ]);
    return {
      sessionId,
      executionMode: "codex-follower",
      status: live.status,
      reason: live.reason,
      features,
    };
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
    const executable = resolveCommand("codex", this.environment);
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
    const stored = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    const managed = stored ?? (await this.#inactiveRecord(sessionId));
    const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const codexHome = this.#assertManagedHome(managed);
    const executionCwd = this.#managedCwd(managed);
    const executable = resolveCommand("codex", this.environment);
    if (!executable) throw new Error("codex-cli-unavailable");
    const result = await this.#codex.request(executable, executionCwd, codexHome, "skills/list", {
      cwds: [executionCwd],
      forceReload: false,
    });
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
    const executable = resolveCommand("codex", this.environment);
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
  if (record.service_tier) params.serviceTier = record.service_tier;
  if (record.mode) {
    params.collaborationMode = {
      mode: record.mode,
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

function followerThreadSettings(
  snapshot: Record<string, unknown>,
  workspace: string,
  requestedMode: string | undefined,
  requestedPolicy: string | undefined,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (requestedMode !== undefined) {
    if (requestedMode !== "default" && requestedMode !== "plan")
      throw new Error("invalid-collaboration-mode");
    const saved = isObject(snapshot.latestThreadSettings) ? snapshot.latestThreadSettings : {};
    const model = typeof saved.model === "string" ? saved.model : snapshot.latestModel;
    if (typeof model !== "string" || !model || model.length > 256)
      throw new Error("invalid-collaboration-mode");
    const effort = Object.hasOwn(saved, "effort")
      ? saved.effort
      : (snapshot.latestReasoningEffort ?? null);
    if (
      effort !== null &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(
        String(effort),
      )
    )
      throw new Error("invalid-collaboration-mode");
    settings.model = model;
    settings.effort = effort;
    settings.collaborationMode = {
      mode: requestedMode,
      settings: { model, reasoning_effort: effort, developer_instructions: null },
    };
  }
  if (requestedPolicy !== undefined) {
    const profiles: Record<string, Record<string, unknown>> = {
      "workspace-write-on-request": {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
      },
      "full-access-on-request": {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      "workspace-write-auto-review": {
        approvalPolicy: "on-request",
        approvalsReviewer: "agent",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false },
      },
    };
    const profile = profiles[requestedPolicy];
    if (!profile) throw new Error("unsupported-policy");
    if (isObject(profile.sandboxPolicy) && profile.sandboxPolicy.type === "workspaceWrite") {
      if (
        typeof snapshot.cwd !== "string" ||
        pathIdentity(canonicalize(snapshot.cwd)) !== pathIdentity(canonicalize(workspace))
      )
        throw new Error("owner-workspace-unavailable");
    }
    Object.assign(settings, profile);
  }
  if (Object.keys(settings).length === 0) throw new Error("empty-thread-settings");
  return settings;
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

function followerAnswerPayload(
  questions: unknown[],
  answers: Record<string, string[]>,
): Record<string, unknown> {
  if (
    questions.length === 0 ||
    questions.length > 32 ||
    Object.keys(answers).length !== questions.length ||
    Buffer.byteLength(JSON.stringify(answers), "utf8") > 65_536
  )
    throw new Error("answer-keys-mismatch");
  const normalized: Record<string, unknown> = {};
  const ids = new Set<string>();
  for (const question of questions) {
    if (!isObject(question) || typeof question.id !== "string" || ids.has(question.id))
      throw new Error("invalid-question-id");
    ids.add(question.id);
    const choices = answers[question.id];
    if (
      !Array.isArray(choices) ||
      choices.length !== 1 ||
      typeof choices[0] !== "string" ||
      !choices[0].trim() ||
      choices[0].includes("\0") ||
      Buffer.byteLength(choices[0], "utf8") > 8192
    )
      throw new Error("invalid-answer");
    if (
      question.allowCustom !== true &&
      (!Array.isArray(question.options) ||
        !question.options.some((option) => isObject(option) && option.label === choices[0]))
    )
      throw new Error("answer-not-offered");
    normalized[question.id] = { answers: choices };
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
  if (!evidence || evidence.operation !== "settings" || !isObject(evidence.settings)) return false;
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

function managedFollowerSettingsMatch(
  expected: Record<string, unknown>,
  snapshot: Record<string, unknown> | null,
): boolean {
  if (!snapshot) return false;
  const current = isObject(snapshot.latestThreadSettings) ? snapshot.latestThreadSettings : {};
  const aliases: Record<string, unknown> = {
    model: Object.hasOwn(current, "model") ? current.model : (snapshot.latestModel ?? null),
    effort: Object.hasOwn(current, "effort")
      ? current.effort
      : (snapshot.latestReasoningEffort ?? null),
    serviceTier: current.serviceTier ?? null,
    collaborationMode: current.collaborationMode ?? null,
    approvalPolicy: current.approvalPolicy ?? null,
    approvalsReviewer: current.approvalsReviewer ?? null,
    sandboxPolicy: current.sandboxPolicy ?? null,
  };
  return Object.entries(expected).every(
    ([key, value]) => Object.hasOwn(aliases, key) && stableJson(aliases[key]) === stableJson(value),
  );
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

function followerReason(error: unknown): string {
  if (!(error instanceof Error)) return "codex-connection-failed";
  if (error.message === "platform-unsupported") return "platform-unsupported";
  if (error.message.includes("unverified Codex Desktop")) return "unverified-installation";
  if (error.message === "live-session-busy") return "live-session-busy";
  if (error.message === "no Codex session owner found") return "open-in-original-client";
  if (error.message.includes("owner changed")) return "codex-owner-changed";
  if (/revision|invalidated/.test(error.message)) return "recovery-required";
  if (/unverified|peer|package|ASAR|permissions are unsafe/.test(error.message))
    return "unverified-installation";
  if (
    /compatible|schema|invalid-change|unsupported|initialization|client ID|acknowledgement/.test(
      error.message,
    )
  )
    return "codex-protocol-incompatible";
  return "codex-connection-failed";
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

// Retained with the dormant Desktop-follower implementation.
// oxlint-disable-next-line no-unused-vars
function followerUnavailable(error: unknown): Record<string, unknown> {
  return {
    available: false,
    executionMode: "codex-follower",
    reason: followerReason(error),
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
