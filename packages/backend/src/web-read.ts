import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import { resolveCommand } from "./command-resolution";
import { CodexAppServerReader, CodexAppServerSession } from "./codex-app-server";
import { CodexFollowerBridge } from "./codex-follower-bridge";
import type { CodexFollowerState } from "./codex-follower-state";
import { ManagedCodexState } from "./managed-codex-state";
import { ManagedCodexEventBridge } from "./managed-codex-state";
import { acquireManagedSessionLease } from "./managed-session-lock";
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

const managedRecordSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace: z.string(),
  home: z.string(),
  native_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  policy_id: z.string().optional(),
  default_model: z.string().nullable().optional(),
  default_effort: z.string().nullable().optional(),
  default_service_tier: z.string().nullable().optional(),
  native_settings: z.unknown().optional(),
  mode: z.string().nullable().optional(),
  source_session_id: z.string().nullable().optional(),
  title: z.string(),
  created_at: z.string(),
  released: z.boolean(),
  adopted: z.boolean(),
  archived: z.boolean().default(false),
  token_usage: z.unknown().optional(),
  goal: z.unknown().optional(),
  snapshot: z
    .object({ revision: z.number().int().nonnegative().optional() })
    .passthrough()
    .optional(),
});

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
    handoffConfirmed: z.literal(true),
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
      handoffConfirmed: z.literal(true),
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
  .strict();

type ManagedRecord = z.infer<typeof managedRecordSchema>;

type ManagedRunner = {
  session: CodexAppServerSession;
  state: ManagedCodexState;
  bridge: ManagedCodexEventBridge;
  persist: ReturnType<typeof createManagedSnapshotWriter>;
  release: () => void;
  planVerified: boolean;
};

type CodexFollowerRecord = {
  bridge: CodexFollowerBridge;
  workspaceId: string;
  workspace: string;
  nativeId: string;
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
  #bootId = randomUUID();
  #managedRunners = new Map<string, ManagedRunner>();
  #codexFollowers = new Map<string, CodexFollowerRecord>();
  #codexFollowerFlights = new Map<string, Promise<CodexFollowerRecord>>();

  constructor(
    readonly store: BackendStore,
    readonly sessions: SessionReaders,
    readonly dataDir: string,
    readonly indexGeneration: () => bigint,
    readonly environment: NodeJS.ProcessEnv,
  ) {
    this.#codex = new CodexAppServerReader(environment);
  }

  close(): void {
    this.#codex.close();
    for (const follower of this.#codexFollowers.values()) follower.bridge.close();
    this.#codexFollowers.clear();
    for (const runner of this.#managedRunners.values()) {
      runner.state.fail("codex-disconnected");
      try {
        runner.persist(runner.state);
      } catch {
        // Do not replace the persisted snapshot if another process changed it.
      }
      void runner.bridge.close().finally(runner.release);
    }
    this.#managedRunners.clear();
  }

  async managedOptions() {
    const executable = resolveCommand("codex", this.environment);
    if (!executable)
      return { available: false, reason: "codex-cli-unavailable", models: [], policies: [] };
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

  async managedReconcile(value: unknown) {
    const request = managedReconcileSchema.parse(value);
    const records = readManagedRecords(this.dataDir, this.store);
    const record = records.find((item) => item.id === request.sessionId);
    if (!record) return this.#reconcileCodexFollower(request);

    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;

    let runner = this.#managedRunners.get(request.sessionId);
    if (runner && !runner.session.connected) {
      this.#managedRunners.delete(request.sessionId);
      try {
        await runner.bridge.close();
      } finally {
        runner.release();
      }
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
    const workspace = canonicalize(this.store.workspacePath(current.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(current.workspace))) {
      release?.();
      throw new Error("session-workspace-mismatch");
    }
    const home = this.#assertManagedHome(current);
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
        const hydrated = runner.state.hydrate(thread, true);
        runner.persist(runner.state, hydrated.events);
      } else if (runner.state.restoreReconciledTurn()) {
        runner.persist(runner.state);
      }
      const live = await runner.bridge.snapshot(this.#bootId, true);
      const result = { sessionId: current.id, reconciled: live.reason === null, live };
      finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    } catch (error) {
      if (release) release();
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

  async managedLifecycle(value: unknown, fingerprintOverride?: string) {
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
      let dispatched = false;
      try {
        await runner.bridge.flush();
        if (managedSessionHasUnknownCommands(this.dataDir, request.sessionId))
          throw new Error("control-outcome-unconfirmed");
        dispatchManagedCommand(this.dataDir, request.requestId);
        dispatched = true;
        this.#managedRunners.delete(request.sessionId);
        await runner.bridge.close();
        runner.release();
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
        if (dispatched) runner.release();
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

    openManagedLedger(this.dataDir, true)?.close();
    let release: (() => void) | undefined = acquireManagedSessionLease(this.dataDir, id);

    const workspace = canonicalize(this.store.workspacePath(workspaceId));
    const home = canonicalize(this.sessions.codexHome());
    const workspaceRow = (this.store.listWorkspaces() as Array<{ id: string; path: string }>).find(
      (row) => row.id === workspaceId,
    );
    if (
      !workspaceRow ||
      pathIdentity(canonicalize(workspaceRow.path)) !== pathIdentity(workspace)
    ) {
      release();
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
    try {
      const runner = await this.#attachManagedRunner(record, workspace, home, release, () => {
        dispatchManagedCommand(this.dataDir, request.requestId);
        dispatched = true;
      });
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
      release?.();
      const definite = !dispatched;
      const current = readManagedRecords(this.dataDir, this.store).find((item) => item.id === id);
      if (current) {
        current.snapshot = {
          ...(isObject(current.snapshot) ? current.snapshot : {}),
          status: definite ? "unsupported" : "outcome-unknown",
          reason: definite
            ? error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
            : "control-outcome-unconfirmed",
        };
        if (definite) current.released = true;
        saveManagedRecord(this.dataDir, current as unknown as Record<string, unknown>);
      }
      const result = {
        sessionId: id,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? error instanceof Error
            ? error.message
            : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  async managedResume(value: unknown) {
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
    const latest = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!latest || !latest.released || latest.archived || latest.native_id !== record.native_id) {
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
    try {
      const runner = await this.#attachManagedRunner(resumed, workspace, home, release, () => {
        dispatchManagedCommand(this.dataDir, request.requestId);
        dispatched = true;
      });
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
      release?.();
      const definite = !dispatched;
      const current = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (current) {
        current.snapshot = {
          ...(isObject(current.snapshot) ? current.snapshot : {}),
          status: definite ? "released" : "outcome-unknown",
          reason: definite
            ? error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
            : "control-outcome-unconfirmed",
        };
        if (definite) current.released = true;
        saveManagedRecord(this.dataDir, current as unknown as Record<string, unknown>);
      }
      const result = {
        sessionId: request.sessionId,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? error instanceof Error
            ? error.message
            : "codex-app-server-unavailable"
          : "control-outcome-unconfirmed",
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  async managedQueueList(value: unknown) {
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
    if (!record.native_id) throw new Error("native-session-unconfirmed");
    let runner = this.#managedRunners.get(request.sessionId);
    if (runner && !runner.session.connected) {
      this.#managedRunners.delete(request.sessionId);
      try {
        await runner.bridge.close();
      } finally {
        runner.release();
      }
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
      session = await CodexAppServerSession.start(executable, workspace, home, {
        ...process.env,
        ...this.environment,
      });
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
        release?.();
      }
    }
  }

  async managedUnarchive(value: unknown) {
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
      session = await CodexAppServerSession.start(executable, workspace, home, {
        ...process.env,
        ...this.environment,
      });
      const response = await session.request(
        "thread/unarchive",
        { threadId: latest.native_id },
        () => {
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
      session = undefined;
      release();
      release = undefined;
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
      await session?.close();
      release?.();
      const definite = !dispatched;
      const result = {
        sessionId: request.sessionId,
        accepted: false,
        completed: false,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? error instanceof Error
            ? error.message
            : "control-preflight-rejected"
          : "control-outcome-unconfirmed",
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
      };
      if (definite) finishManagedCommand(this.dataDir, request.requestId, result);
      return result;
    }
  }

  async managedSettingsState(value: unknown) {
    const request = managedSettingsStateSchema.parse(value);
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record) {
      try {
        const follower = await this.#codexFollower(request.sessionId);
        const state = await follower.bridge.observeLive();
        return state.settingsState(follower.bridge.supportsThreadSettings);
      } catch (error) {
        return followerUnavailable(error);
      }
    }
    const ownerSnapshot = await this.#managedLive(request.sessionId);
    const settings = new ManagedCodexState(record, record.snapshot?.revision ?? 0).snapshot(
      this.#bootId,
      false,
    ).settings;
    const settingsObject = isObject(settings) ? settings : {};
    const runner = this.#managedRunners.get(request.sessionId);
    if (!runner?.session.connected || record.released || record.archived)
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

  async managedQuery(value: unknown) {
    const request = managedQuerySchema.parse(value);
    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (request.operation === "capabilities") {
      if (!record)
        return this.#followerCapabilities(request.sessionId, request.experimentalEnabled === true);
      if (record.released && record.adopted)
        return {
          sessionId: request.sessionId,
          executionMode: "codex-follower",
          status: "native-host-required",
          reason: "follower-capabilities-required",
          features: Object.fromEntries(
            [
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
            ].map((operation) => [
              operation,
              { available: false, reason: "follower-operation-unverified" },
            ]),
          ),
        };
      const live = await this.#managedLive(request.sessionId, request.experimentalEnabled === true);
      if (!isObject(live)) throw new Error("session-state-unavailable");
      const controls = request.experimentalEnabled === true;
      const healthy = live.reason === null && controls;
      const idle = live.status === "idle";
      const running = live.status === "running";
      const runner = this.#managedRunners.get(request.sessionId);
      const verified = resolveCommand("codex", this.environment) !== null;
      const unknown = managedSessionHasUnknownCommands(this.dataDir, request.sessionId);
      const features: Record<string, Record<string, unknown>> = {};
      const set = (operation: string, available: boolean, reason = "session-state-unavailable") => {
        features[operation] = available ? { available: true } : { available: false, reason };
      };
      const managed = !record.released || !record.adopted;
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
      for (const operation of ["settings-state", "usage", "goal", "resources"])
        set(
          operation,
          Boolean(managed && verified),
          managed ? "unsupported-codex-cli-version" : "follower-operation-unverified",
        );
      const idleControls = managed && verified && healthy && idle && !unknown && !record.archived;
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
        managed && verified && healthy && running && !unknown,
        "session-requires-running-turn",
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
    const executable = resolveCommand("codex", this.environment);
    if (!executable) throw new Error("codex-cli-unavailable");
    const response = await this.#codex.request(executable, workspace, home, "thread/read", {
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
          queueSession ??= await CodexAppServerSession.start(executable, workspace, home, {
            ...process.env,
            ...this.environment,
          });
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
    }
    const context = await this.#context(request.sessionId);
    const runner = this.#managedRunners.get(request.sessionId);
    if (record && runner?.session.connected && unresolvedCount === 0) {
      await runner.bridge.flush();
      if (runner.state.turnId === null) {
        const hydrated = runner.state.hydrate(thread, true);
        runner.persist(runner.state, hydrated.events);
      } else if (runner.state.restoreReconciledTurn()) runner.persist(runner.state);
    }
    return {
      sessionId: request.sessionId,
      reconciled: unresolvedCount === 0,
      reason: unresolvedCount === 0 ? null : "control-outcome-unconfirmed",
      unresolvedCount,
      context,
      nativeStatus: thread.status ?? null,
      executionUnchanged: true,
    };
  }

  async managedControl(value: unknown) {
    const request = managedControlSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(this.dataDir, request.requestId, fingerprint);
    if (previous) return previous;

    const record = readManagedRecords(this.dataDir, this.store).find(
      (item) => item.id === request.sessionId,
    );
    if (!record && ["send", "stop", "approve", "answer", "settings"].includes(request.operation))
      return this.#codexFollowerControl(request, fingerprint);
    if (record?.released) throw new Error("session-released");
    if (record?.archived) throw new Error("session-archived");
    if (record && (!request.experimentalEnabled || request.runtimeBootId !== this.#bootId))
      throw new Error("stale-or-disabled-control");
    let runner = this.#managedRunners.get(request.sessionId);
    if (record && !runner?.session.connected) {
      const recovery = (await this.managedReconcile({
        operation: "reconcile",
        requestId: randomUUID(),
        deviceId: request.deviceId ?? "agentkib-local-owner",
        sessionId: request.sessionId,
      })) as Record<string, unknown>;
      if (!isObject(recovery) || recovery.reconciled !== true)
        return {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason:
            isObject(recovery) && typeof recovery.reason === "string"
              ? recovery.reason
              : "recovery-required",
          sessionId: request.sessionId,
          requestId: request.requestId,
          runtimeBootId: this.#bootId,
        };
      runner = this.#managedRunners.get(request.sessionId);
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
    const snapshot = await runner.bridge.snapshot(this.#bootId, true);
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
          ...managedTurnSettings(record, workspace),
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

      const latest = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (
        !latest ||
        latest.native_id !== record.native_id ||
        latest.workspace_id !== record.workspace_id ||
        latest.released ||
        latest.archived
      )
        throw new Error("session-unavailable");
      this.#assertManagedHome(latest);
      await runner.bridge.flush();
      const currentSnapshot = await runner.bridge.snapshot(this.#bootId, true);
      if (
        currentSnapshot.reason ||
        currentSnapshot.revision !== request.expectedRevision ||
        (request.operation === "send" && currentSnapshot.sendEnabled !== true) ||
        (request.operation === "stop" &&
          (currentSnapshot.stopEnabled !== true || currentSnapshot.turnId !== request.turnId)) ||
        (["approve", "answer"].includes(request.operation) &&
          currentSnapshot.turnId !== request.turnId)
      )
        throw new Error("stale-or-disabled-control");
      dispatchManagedCommand(this.dataDir, request.requestId);
      let response: unknown;
      if (responseId !== undefined) {
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
        runner.state.commitManagedMutation(localMutation);
        runner.persist(runner.state);
        response = { appliesTo: "next-turn" };
      } else {
        response = await runner.session.request(method, params);
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
        this.#managedRunners.delete(request.sessionId);
        try {
          await runner.bridge.close();
        } finally {
          runner.release();
        }
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

  async #managedFork(
    request: z.infer<typeof managedControlSchema>,
    source: ManagedRecord,
    sourceRunner: ManagedRunner,
    fingerprint: string,
  ) {
    if (this.#managedRunners.size >= 8) throw new Error("managed-session-limit");
    const sourceSnapshot = await sourceRunner.bridge.snapshot(this.#bootId, true);
    if (sourceSnapshot.status !== "idle" || sourceSnapshot.reason) throw new Error("session-busy");
    const nativeId = source.native_id;
    if (!nativeId) throw new Error("native-session-unconfirmed");
    const history = await sourceRunner.session.request("thread/read", {
      threadId: nativeId,
      includeTurns: true,
    });
    if (!isObject(history) || !isObject(history.thread) || history.thread.id !== nativeId)
      throw new Error("thread-identity-mismatch");
    const turns = Array.isArray(history.thread.turns) ? history.thread.turns.filter(isObject) : [];
    const last = turns.at(-1);
    if (!last || !["completed", "interrupted", "failed"].includes(String(last.status)))
      throw new Error("no-completed-turn");
    if (typeof last.id !== "string") throw new Error("no-completed-turn");
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
      adopted: false,
      released: false,
      archived: false,
      created_at: new Date().toISOString(),
      snapshot: { status: "starting", revision: 0 },
    };
    saveManagedRecord(this.dataDir, child as unknown as Record<string, unknown>);
    let dispatched = false;
    try {
      const runner = await this.#attachManagedRunner(
        child,
        canonicalize(source.workspace),
        this.#assertManagedHome(source),
        release,
        () => {
          dispatchManagedCommand(this.dataDir, request.requestId);
          dispatched = true;
        },
        { nativeId, lastTurnId: last.id },
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
      release?.();
      const definite = !dispatched;
      const current = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === childId,
      );
      if (current) {
        current.snapshot = {
          ...(isObject(current.snapshot) ? current.snapshot : {}),
          status: definite ? "unsupported" : "outcome-unknown",
          reason: definite
            ? error instanceof Error
              ? error.message
              : "codex-app-server-unavailable"
            : "control-outcome-unconfirmed",
        };
        if (definite) current.released = true;
        saveManagedRecord(this.dataDir, current as unknown as Record<string, unknown>);
      }
      const result = {
        sessionId: childId,
        sourceSessionId: source.id,
        accepted: false,
        completed: false,
        requestId: request.requestId,
        runtimeBootId: this.#bootId,
        controlOutcome: definite ? "not-dispatched" : "unknown",
        reason: definite
          ? error instanceof Error
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
          cwds: [workspace],
          forceReload: false,
        });
        const data = isObject(listed) && Array.isArray(listed.data) ? listed.data : [];
        let match: { name: string; path: string } | undefined;
        for (const entry of data) {
          if (!isObject(entry) || typeof entry.cwd !== "string") continue;
          if (pathIdentity(canonicalize(entry.cwd)) !== pathIdentity(workspace)) continue;
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

  async #attachManagedRunner(
    record: ManagedRecord,
    workspace: string,
    home: string,
    release: (() => void) | undefined,
    dispatch?: () => void,
    fork?: { nativeId: string; lastTurnId: string },
  ): Promise<ManagedRunner> {
    const executable = resolveCommand("codex", this.environment);
    if (!executable) throw new Error("codex-cli-unavailable");
    const nativeId = record.native_id ?? null;
    const session = await CodexAppServerSession.start(executable, workspace, home, {
      ...process.env,
      ...this.environment,
    });
    const state = new ManagedCodexState(record, record.snapshot?.revision ?? 0);
    const persist = createManagedSnapshotWriter(this.dataDir, record);
    const bridge = new ManagedCodexEventBridge(session, state, persist);
    try {
      const modelsResult = await session.request("model/list", { limit: 100 });
      const models = projectManagedModels(modelsResult);
      const requestedModel = record.model ?? null;
      const requestedEffort = record.effort ?? null;
      const selected = requestedModel
        ? models.find((model) => model.id === requestedModel)
        : models.find((model) => model.isDefault === true);
      if (requestedModel && !selected) throw new Error("unsupported-model");
      if (requestedEffort && !requestedModel) throw new Error("effort-requires-model");
      if (requestedEffort && !selected?.efforts.includes(requestedEffort))
        throw new Error("unsupported-effort");
      const tier = record.service_tier ?? null;
      if (tier && !selected?.serviceTiers.includes(tier))
        throw new Error("unsupported-service-tier");

      let goal: Record<string, unknown> | null = null;
      if (nativeId) {
        const goalResult = await session.request("thread/goal/get", { threadId: nativeId });
        goal = isObject(goalResult) && isObject(goalResult.goal) ? goalResult.goal : null;
        if (goal?.status === "active") throw new Error("pause-original-goal-before-handoff");
      }

      const params = managedResumeParams(record, workspace);
      if (requestedModel) params.model = requestedModel;
      if (requestedEffort)
        (params.config as Record<string, unknown>).model_reasoning_effort = requestedEffort;
      if (tier) params.serviceTier = tier;
      if (fork) {
        params.threadId = fork.nativeId;
        params.lastTurnId = fork.lastTurnId;
        params.deferGoalContinuation = true;
      } else if (nativeId) params.threadId = nativeId;
      const responseValue = await session.request(
        fork ? "thread/fork" : nativeId ? "thread/resume" : "thread/start",
        params,
        dispatch,
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
        pathIdentity(canonicalize(response.cwd)) !== pathIdentity(workspace)
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
      const hydrated = state.hydrate(nativeThread, true);
      persist(state, hydrated.events);
      return {
        session,
        state,
        bridge,
        persist,
        release: release ?? (() => {}),
        planVerified: false,
      };
    } catch (error) {
      try {
        await bridge.close();
      } finally {
        release?.();
      }
      throw error;
    }
  }

  async request(value: unknown) {
    const request = requestSchema.parse(value);
    if (request.operation === "live")
      return this.#managedLive(request.sessionId, request.experimentalEnabled === true);
    if (request.operation === "context") return this.#context(request.sessionId);
    if (request.operation === "usage") {
      const record = readManagedRecords(this.dataDir, this.store).find(
        (item) => item.id === request.sessionId,
      );
      if (!record)
        return {
          available: false,
          executionMode: "codex-follower",
          reason: "follower-operation-unverified",
        };
      this.#assertManagedHome(record);
      const tokenUsage = record.token_usage ?? null;
      return {
        available: tokenUsage !== null,
        executionMode: "codex-managed",
        tokenUsage,
        revision: record.snapshot?.revision ?? null,
        reason: tokenUsage !== null ? null : "recovery-required",
      };
    }
    if (request.operation === "goal") return this.#goal(request.sessionId);
    if (request.operation === "resources") return this.#resources(request.sessionId);
    if (request.operation === "events") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      if (managed) {
        this.#assertManagedHome(managed);
        const events = readManagedEvents(
          this.dataDir,
          request.sessionId,
          request.cursor,
          request.limit,
        );
        const latest = readManagedRecords(this.dataDir, this.store).find(
          (record) => record.id === request.sessionId,
        );
        if (!latest || latest.workspace_id !== managed.workspace_id)
          throw new Error("session-unavailable");
        this.#assertManagedHome(latest);
        return events;
      }
    }
    const generation = this.indexGeneration();
    const enabled = indexEnabled(this.dataDir);
    if (request.operation === "catalog") {
      const managed = readManagedRecords(this.dataDir, this.store);
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
          sessionRows.push(...this.store.sessions.list(workspace.id));
          if (sessionRows.length > 20_000) throw new Error("response-too-large");
        }
      const registered = new Set(
        (this.store.listWorkspaces() as Array<{ id: string }>).map((workspace) => workspace.id),
      );
      const managedWorkspaceIds = new Set(managed.map((record) => record.workspace_id));
      const workspaces = allWorkspaces.filter(
        (workspace) => enabled || managedWorkspaceIds.has(workspace.id),
      );
      const aliases = await this.#managedAliases(managed);
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
          updated_at: record.created_at,
          message_count: null,
          git_branch: null,
          origin: "interactive",
          archived: record.archived,
          sidechain: false,
          availability: "readable",
          executionMode: "codex-managed",
          sourceSessionId: record.source_session_id ?? null,
        })),
      );
      if (this.indexGeneration() !== generation || indexEnabled(this.dataDir) !== enabled)
        return { workspaces: [], sessions: [], indexEnabled: false };
      return {
        workspaces: workspaces
          .filter((workspace) => registered.has(workspace.id))
          .map(({ id, name, path }) => ({ id, name, path })),
        sessions,
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

  async #managedLive(sessionId: string, experimentalEnabled = false) {
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (!managed) return this.#codexFollowerLive(sessionId, experimentalEnabled);
    const liveWorkspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(liveWorkspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    this.#assertManagedHome(managed);

    const resident = this.#managedRunners.get(sessionId);
    if (resident?.session.connected) {
      return resident.bridge.snapshot(
        this.#bootId,
        !managedSessionHasUnknownCommands(this.dataDir, sessionId),
      );
    }
    if (resident) {
      this.#managedRunners.delete(sessionId);
      try {
        await resident.bridge.close();
      } finally {
        resident.release();
      }
    }

    const release = acquireManagedSessionLease(this.dataDir, sessionId);

    try {
      const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
      if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
        throw new Error("session-workspace-mismatch");
      const home = this.#assertManagedHome(managed);
      if (!managed.native_id) return this.#recoverySnapshot(managed, "native-session-unconfirmed");
      const executable = resolveCommand("codex", this.environment);
      if (!executable) return this.#recoverySnapshot(managed, "recovery-required");

      let response: unknown;
      try {
        response = await this.#codex.request(executable, workspace, home, "thread/read", {
          threadId: managed.native_id,
          includeTurns: true,
        });
      } catch {
        return this.#recoverySnapshot(managed, "recovery-required");
      }
      const thread = isObject(response) ? response.thread : null;
      if (!isObject(thread) || thread.id !== managed.native_id)
        throw new Error("thread-identity-mismatch");
      if (typeof thread.cwd !== "string") throw new Error("codex-context-unavailable");
      const cwd = canonicalize(thread.cwd);
      if (!within(cwd, workspace)) throw new Error("codex-context-outside-workspace");

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
      this.#assertManagedHome(latest);

      const state = new ManagedCodexState(latest, latest.snapshot?.revision ?? 0);
      state.hydrate(thread, false);
      return state.snapshot(this.#bootId, false);
    } finally {
      release();
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
    const bridge = await CodexFollowerBridge.connect(endpoint, nativeId);
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
            !["send", "stop", "approve", "answer", "inspect", "resume", "settings"].includes(
              operation,
            ),
        )
        .map((operation) => set(operation, false)),
      set(
        "settings",
        follower.bridge.supportsThreadSettings && idle,
        follower.bridge.supportsThreadSettings ? "session-busy" : "follower-operation-unverified",
      ),
    ]);
    return {
      sessionId,
      executionMode: "codex-follower",
      status: live.status,
      reason: live.reason,
      features,
    };
  }

  #recoverySnapshot(record: ManagedRecord, reason: string) {
    const snapshot = isObject(record.snapshot) ? { ...record.snapshot } : {};
    snapshot.sessionId = record.id;
    snapshot.workspaceId = record.workspace_id;
    snapshot.runtimeBootId = this.#bootId;
    snapshot.executionMode = "codex-managed";
    const settings = isObject(snapshot.settings) ? { ...snapshot.settings } : {};
    settings.applicationStatus = "unknown";
    snapshot.settings = settings;
    snapshot.sendEnabled = false;
    snapshot.stopEnabled = false;
    snapshot.approvals = [];
    snapshot.questions = [];
    snapshot.status = record.archived
      ? "archived"
      : record.released
        ? "released"
        : "outcome-unknown";
    snapshot.reason = record.archived
      ? "session-archived"
      : record.released
        ? "session-released"
        : reason;
    return snapshot;
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
    const executable = resolveCommand("codex", this.environment);
    if (!executable) throw new Error("codex-cli-unavailable");
    let codexHome: string;
    try {
      codexHome = canonicalize(this.sessions.codexHome());
    } catch {
      throw new Error("codex-home-unavailable");
    }
    const response = await this.#codex.readThread(executable, workspace, codexHome, nativeId);
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
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (!managed)
      return {
        available: false,
        executionMode: "codex-follower",
        reason: "follower-operation-unverified",
        skills: [],
        plugins: [],
        apps: [],
        contextReferences: { supportedTypes: [] },
      };
    const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const codexHome = this.#assertManagedHome(managed);
    const executable = resolveCommand("codex", this.environment);
    if (!executable) throw new Error("codex-cli-unavailable");
    const result = await this.#codex.request(executable, workspace, codexHome, "skills/list", {
      cwds: [workspace],
      forceReload: false,
    });
    const latest = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (
      !latest ||
      latest.workspace_id !== managed.workspace_id ||
      latest.native_id !== managed.native_id ||
      pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
      pathIdentity(canonicalize(latest.home)) !== pathIdentity(codexHome)
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
      if (pathIdentity(cwd) !== pathIdentity(workspace) || !Array.isArray(entry.skills)) continue;
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
    const managed = readManagedRecords(this.dataDir, this.store).find(
      (record) => record.id === sessionId,
    );
    if (!managed)
      return {
        available: false,
        executionMode: "codex-follower",
        reason: "follower-operation-unverified",
      };

    const workspace = canonicalize(this.store.workspacePath(managed.workspace_id));
    if (pathIdentity(workspace) !== pathIdentity(canonicalize(managed.workspace)))
      throw new Error("session-workspace-mismatch");
    const home = this.#assertManagedHome(managed);
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
          workspace,
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

  async #managedAliases(records: ManagedRecord[]): Promise<Set<string>> {
    const aliases = new Set<string>();
    const sessionsByWorkspace = new Map<string, Set<string>>();
    const candidates = new Set<string>();
    const matchedRecords = new Set<ManagedRecord>();
    for (const record of records) {
      if (!record.native_id) continue;
      const workspace = this.store.workspacePath(record.workspace_id);
      let refs = sessionsByWorkspace.get(workspace);
      if (!refs) {
        try {
          refs = new Set(
            (await this.sessions.list("codex", workspace)).sessions.map(
              (session) => session.native_ref,
            ),
          );
        } catch {
          refs = new Set();
        }
        sessionsByWorkspace.set(workspace, refs);
      }
      if (refs.has(record.native_id)) {
        candidates.add(record.native_id);
        matchedRecords.add(record);
      }
    }
    const verified = this.sessions.verifiedCodexControlIds(candidates);
    for (const record of records) {
      if (
        !record.native_id ||
        !matchedRecords.has(record) ||
        !verified.has(record.native_id.toLowerCase())
      )
        continue;
      const salt = this.store.sessions.sql.one(
        "SELECT value FROM schema_meta WHERE key='conversation_salt'",
      )?.value;
      if (typeof salt !== "string") continue;
      aliases.add(this.store.sessions.id("codex", record.native_id));
    }
    return aliases;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
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
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      break;
    default:
      throw new Error("unsupported-policy");
  }
  return params;
}

function managedTurnSettings(record: ManagedRecord, workspace: string): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const params: Record<string, unknown> = { config };
  switch (record.policy_id ?? "workspace-write-on-request") {
    case "workspace-write-on-request":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
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
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
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
  if (
    !full &&
    (sandbox.networkAccess !== false ||
      !Array.isArray(sandbox.writableRoots) ||
      sandbox.writableRoots.some((root) => root !== record.workspace))
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
  if (["create", "adopt"].includes(String(evidence.operation)))
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
  if (!(error instanceof Error)) return "open-in-original-client";
  if (error.message === "platform-unsupported") return "platform-unsupported";
  if (error.message.includes("unverified Codex Desktop")) return "unverified-installation";
  if (error.message === "live-session-busy") return "live-session-busy";
  if (error.message === "no Codex session owner found") return "open-in-original-client";
  return "open-in-original-client";
}

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
  includeReleasedAdopted = false,
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
