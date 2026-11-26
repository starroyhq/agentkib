import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  acpAttachmentFeature,
  acpPromptInput,
  type AcpPromptAttachmentSupport,
} from "../../acp-prompt-attachments";
import type { ContextUsage } from "../../context-usage";
import { within } from "../../files";
import type { LeadToolRegistration } from "../../orchestration-endpoint";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
  replayManagedCommand,
} from "../../managed-ledger";
import { canonicalize, pathIdentity } from "../../paths";
import { activityBlocks, assertActivityAllows } from "../../session-activity";
import {
  sessionResultProjectors,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionProviders,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import type { SessionReaders } from "../../session-readers";
import {
  stableJson,
  type antigravityManagedControlSchema,
  type ApplyManagedControl,
} from "../../sessions/control-admission";
import { legacySessionFields } from "../../sessions/routing";
import {
  ANTIGRAVITY_PERMISSION_MODES,
  validateAntigravityControl,
} from "../../sessions/validate/antigravity";
import type { BackendStore } from "../../store";
import { ANTIGRAVITY_ACP_DISABLED, antigravityAcpEnabled } from "./acp-enabled";
import {
  AcpUndispatchedError,
  AntigravityAcp,
  initializeAcpProbe,
  verifyAcpControlIdentity,
} from "./antigravity-acp";
import { AntigravityManagedRunner } from "./antigravity-managed-runner";
import { antigravityAcpArgs } from "./antigravity-sessions";

type AntigravityExecutor = SessionProviders["antigravity"];

type AntigravitySessionHost = {
  store: BackendStore;
  sessions: SessionReaders;
  dataDir: string;
  environment: NodeJS.ProcessEnv;
  runtimeBootId: string;
  publishConversationEvent?: (
    sessionId: string,
    type: "snapshot" | "state" | "text-delta" | "item-upsert",
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => void;
  observeTurn(
    sessionId: string,
  ): NonNullable<Parameters<typeof AntigravityManagedRunner.connect>[7]>;
  admitControl(
    value: Record<string, unknown>,
    execute: ApplyManagedControl<AntigravityControl>,
  ): Promise<unknown>;
  queue: NonNullable<AntigravityExecutor["queue"]>;
  readSession(value: Record<string, unknown>): Promise<unknown>;
  querySession(value: SessionQuery): Promise<unknown>;
  settingsState(value: Record<string, unknown>): Promise<unknown>;
  controlSession(value: Record<string, unknown>): Promise<unknown>;
  personControlled?(sessionId: string, operation: string): void;
  normalizeContextUsage(snapshot: { usage?: unknown; reason?: unknown }): ContextUsage;
  compactingRejection(
    request: { requestId: string; sessionId?: string },
    runtimeBootId: string,
  ): Record<string, unknown>;
};

type AntigravityControl = z.infer<typeof antigravityManagedControlSchema>;
const OPTION_CACHE_MS = 10 * 60_000;
const ATTACHMENT_PROBE_CACHE_MS = 60_000;
const ATTACHMENT_PROBE_TIMEOUT_MS = 3_000;

const antigravityCreateSchema = z
  .object({
    operation: z.literal("antigravity-create"),
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
      .refine((value) => Buffer.byteLength(value, "utf8") <= 65_536),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:@/+-]{1,128}$/)
      .optional(),
    effort: z.string().min(1).max(64).optional(),
    permissionMode: z.enum(ANTIGRAVITY_PERMISSION_MODES).optional(),
  })
  .strict();

type ConfigOption = Record<string, unknown>;

function optionValues(options: readonly ConfigOption[], id: string) {
  const option = options.find((entry) => entry.id === id);
  const values = Array.isArray(option?.options) ? option.options : [];
  return values.flatMap((entry) =>
    isObject(entry) && typeof entry.value === "string"
      ? [{ id: entry.value, name: typeof entry.name === "string" ? entry.name : entry.value }]
      : [],
  );
}

/** The models, thought levels and modes a session's ACP options offer, as the composer reads them. */
function antigravityChoices(options: readonly ConfigOption[]) {
  const efforts = optionValues(options, "thought_level").map((entry) => entry.id);
  return {
    models: optionValues(options, "model").map((entry) => ({
      id: entry.id,
      displayName: entry.name,
      efforts,
      serviceTierIds: [],
    })),
    serviceTiers: [],
    permissionModes: optionValues(options, "mode")
      .filter((entry) => (ANTIGRAVITY_PERMISSION_MODES as readonly string[]).includes(entry.id))
      .map((entry) => ({ id: entry.id, name: entry.name })),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AntigravityRunnerRecord = {
  runner: AntigravityManagedRunner;
  nativeId: string;
  workspaceId: string;
  workspace: string;
  /** The Project Agent worker tools this connection offered, if any. */
  leadUrl: string | null;
};

export class AntigravitySessionProvider implements AntigravityExecutor, TypedSessionProvider {
  readonly agent = "antigravity" as const;
  readonly createOperation = "antigravity-create";
  readonly validateControl: typeof validateAntigravityControl = (request, context) =>
    this.acpEnabled ? validateAntigravityControl(request, context) : { available: false };
  readonly typed = this;
  readonly acpEnabled: boolean;
  #runners = new Map<string, AntigravityRunnerRecord>();
  #retiredRevisions = new Map<string, number>();
  #runnerFlights = new Map<string, Promise<AntigravityRunnerRecord>>();
  #options: { at: number; choices: Promise<Record<string, unknown>> } | undefined;
  #attachmentProbe?: {
    executable: string;
    at: number;
    client: AntigravityAcp;
    support: Promise<AcpPromptAttachmentSupport | undefined>;
  };
  /** Sessions whose ACP control was confirmed (not App or IDE history read from disk). */
  #controllable = new Set<string>();
  #leadEndpoint: ((sessionId: string) => Promise<LeadToolRegistration | null>) | undefined;

  /** Where a Project Agent's worker tools are served (`OrchestrationService.leadTools`). */
  leadEndpoints(
    source: ((sessionId: string) => Promise<LeadToolRegistration | null>) | undefined,
  ): void {
    this.#leadEndpoint = source;
  }

  /** Whether an Antigravity session could be a Project Agent: one AgentKib controls over ACP. */
  leadCapable(sessionId: string): boolean {
    return (
      this.acpEnabled &&
      this.#controllable.has(sessionId) &&
      this.host.store.sessions.get(sessionId)?.agent === "antigravity"
    );
  }

  /** Confirms a session's ACP control before a Project Agent is set up on it. */
  async prepareLead(sessionId: string): Promise<boolean> {
    return this.#target(sessionId).then(
      () => true,
      () => false,
    );
  }

  /** What a session runs with by the person's choice; Antigravity forgets the thought level. */
  #savedSettings(nativeId: string): Record<string, string> {
    try {
      const all = JSON.parse(readFileSync(this.#settingsFile(), "utf8")) as Record<string, unknown>;
      const saved = all[nativeId];
      return isObject(saved)
        ? Object.fromEntries(
            Object.entries(saved).filter(
              (entry): entry is [string, string] =>
                ["model", "thought_level", "mode"].includes(entry[0]) &&
                typeof entry[1] === "string",
            ),
          )
        : {};
    } catch {
      return {};
    }
  }

  #saveSettings(nativeId: string, values: Record<string, string>) {
    if (!Object.keys(values).length) return;
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(readFileSync(this.#settingsFile(), "utf8")) as Record<string, unknown>;
    } catch {
      // A missing or unreadable file starts again.
    }
    all[nativeId] = { ...this.#savedSettings(nativeId), ...values };
    const file = this.#settingsFile();
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  #settingsFile() {
    return path.join(this.host.dataDir, "antigravity-session-settings.json");
  }

  constructor(private readonly host: AntigravitySessionHost) {
    this.acpEnabled = antigravityAcpEnabled(host.environment);
  }

  close(): void {
    this.#attachmentProbe?.client.shutdown();
    this.#attachmentProbe = undefined;
    for (const record of this.#runners.values()) record.runner.close();
    this.#runners.clear();
    this.#retiredRevisions.clear();
  }

  *runningSessionIds(): Iterable<string> {
    for (const [id, { runner }] of this.#runners) if (runner.running) yield id;
  }

  async contextUsage(sessionId: string) {
    return this.host.normalizeContextUsage(await this.live(sessionId));
  }

  queue(request: Parameters<NonNullable<AntigravityExecutor["queue"]>>[0]) {
    return this.host.queue(request);
  }

  control(value: Record<string, unknown>, beforeNativeDispatch?: () => void) {
    return this.host.admitControl(value, (request, fingerprint) =>
      this.#executeControl(request, fingerprint, beforeNativeDispatch),
    );
  }

  updateSettings(value: Record<string, unknown>) {
    return this.control(value);
  }

  /**
   * A session's model, thought level and mode, which are its own ACP options: they apply from the
   * next turn and stay with the session in Antigravity too.
   */
  async settingsState(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
    let record: AntigravityRunnerRecord;
    try {
      record = await this.#runner(sessionId);
    } catch (error) {
      return {
        available: false,
        executionMode: "acp-managed",
        revision: 0,
        reason: error instanceof Error ? error.message : "session-unavailable",
      };
    }
    const { runner } = record;
    const live = runner.snapshot();
    const choices = antigravityChoices(runner.configOptions);
    const settings = {
      model: runner.option("model") ?? null,
      effort: runner.option("thought_level") ?? null,
      permissionMode: runner.option("mode") ?? null,
    };
    const idle = live.status === "idle" && live.turnId === null;
    return {
      available: true,
      executionMode: "acp-managed",
      revision: live.revision,
      current: settings,
      selected: settings,
      settings,
      defaults: { model: null, effort: null, permissionMode: "default" },
      applicationStatus: "confirmed",
      ...choices,
      writable: {
        model: { available: idle && choices.models.length > 0 },
        effort: { available: idle && choices.models.some((model) => model.efforts.length > 0) },
        serviceTier: { available: false },
        permissionMode: { available: idle && choices.permissionModes.length > 0 },
        restoreDefaults: { available: false },
      },
    };
  }

  /**
   * What a new Antigravity session can start with, read from a session the CLI opens and never
   * stores (it has no message), in a private temporary directory.
   */
  async options(): Promise<Record<string, unknown>> {
    if (!this.acpEnabled) return { available: false, reason: ANTIGRAVITY_ACP_DISABLED };
    let executable: string;
    try {
      executable = this.host.sessions.antigravityControlExecutable();
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "antigravity-cli-unavailable",
      };
    }
    if (!this.#options || Date.now() - this.#options.at > OPTION_CACHE_MS) {
      const choices = (async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-antigravity-"));
        const runner = await AntigravityManagedRunner.connect(
          executable,
          directory,
          "",
          { ...process.env, ...this.host.environment },
          undefined,
          undefined,
          0,
          undefined,
          { create: true },
        );
        try {
          return {
            ...antigravityChoices(runner.configOptions),
            defaults: {
              model: runner.option("model") ?? null,
              effort: runner.option("thought_level") ?? null,
              permissionMode: runner.option("mode") ?? "default",
            },
          };
        } finally {
          runner.close();
          await rm(directory, { recursive: true, force: true });
        }
      })();
      this.#options = { at: Date.now(), choices };
      choices.catch(() => {
        if (this.#options?.choices === choices) this.#options = undefined;
      });
    }
    try {
      return { available: true, ...(await this.#options.choices) };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : "antigravity-options-unavailable",
      };
    }
  }

  /**
   * Starts an Antigravity session with its first message through the CLI's `agy acp`, with the
   * chosen model, thought level and mode, and answers once Antigravity stores it.
   */
  async create(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = antigravityCreateSchema.parse(value);
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const replay = replayManagedCommand(this.host.dataDir, request.requestId, fingerprint);
    if (replay) return replay;
    const result = (outcome: "accepted" | "not-dispatched" | "unknown", extra = {}) => ({
      accepted: outcome === "accepted",
      completed: outcome === "accepted",
      requestId: request.requestId,
      runtimeBootId: this.host.runtimeBootId,
      executionMode: "acp-managed",
      controlOutcome: outcome,
      ...extra,
    });
    if (!this.acpEnabled) return result("not-dispatched", { reason: ANTIGRAVITY_ACP_DISABLED });
    let workspace: string;
    let executable: string;
    try {
      workspace = canonicalize(this.host.store.workspacePath(request.workspaceId));
      executable = this.host.sessions.antigravityControlExecutable();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "workspace-unavailable";
      return result("not-dispatched", {
        reason: reason === "antigravity-cli-unavailable" ? reason : "workspace-unavailable",
      });
    }
    const prior = claimManagedCommand(
      this.host.dataDir,
      request.requestId,
      `antigravity-create:${request.requestId}`,
      fingerprint,
      request.deviceId,
      {
        operation: "create",
        workspaceId: request.workspaceId,
        runtimeBootId: this.host.runtimeBootId,
        executionMode: "antigravity-acp-managed",
        claimedAt: Date.now(),
      },
    );
    if (prior) return prior;
    let created: string | null = null;
    let runner: AntigravityManagedRunner | undefined;
    let dispatched = false;
    const config = {
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { thought_level: request.effort } : {}),
      ...(request.permissionMode ? { mode: request.permissionMode } : {}),
    };
    try {
      runner = await AntigravityManagedRunner.connect(
        executable,
        workspace,
        "",
        { ...process.env, ...this.host.environment },
        (type, payload, live) => {
          if (!created) return;
          const current = {
            ...live,
            sessionId: created,
            runtimeBootId: this.host.runtimeBootId,
            workspaceId: request.workspaceId,
          };
          const eventPayload = isObject(payload.live) ? { ...payload, live: current } : payload;
          this.host.publishConversationEvent?.(created, type, eventPayload, current);
        },
        undefined,
        0,
        undefined,
        { create: true, config },
      );
      const nativeId = runner.sessionId;
      this.#saveSettings(nativeId, config);
      await runner.send(request.prompt, Number(runner.snapshot().revision), () => {
        dispatchManagedCommand(this.host.dataDir, request.requestId);
        dispatched = true;
      });
      // Antigravity lists a session once it has a message; index it so that its ID resolves.
      for (let attempt = 0; attempt < 60 && !created; attempt++) {
        const listed = await this.host.sessions.list("antigravity", workspace);
        if (listed.sessions.some((session) => session.native_ref === nativeId)) {
          this.host.store.sessions.sync(request.workspaceId, "antigravity", listed.sessions, true);
          created = this.host.store.sessions.id("antigravity", nativeId);
        } else await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!created) throw new Error("antigravity-session-unconfirmed");
      this.#runners.set(created, {
        runner,
        nativeId,
        workspaceId: request.workspaceId,
        workspace,
        leadUrl: null,
      });
      const outcome = result("accepted", { sessionId: created });
      finishManagedCommand(this.host.dataDir, request.requestId, outcome);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "control-preflight-rejected";
      if (!dispatched) {
        runner?.close();
        const outcome = result("not-dispatched", { reason });
        finishManagedCommand(this.host.dataDir, request.requestId, outcome);
        return outcome;
      }
      return result("unknown", { reason: "control-outcome-unconfirmed" });
    }
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(request: SessionProviderRequest): Promise<SessionProviderResponse> {
    const { operation } = request;
    const raw = await this.#request(request);
    return {
      operation,
      result: sessionResultProjectors[operation](this.agent, raw),
    } as SessionProviderResponse;
  }

  async #request(request: SessionProviderRequest): Promise<unknown> {
    switch (request.operation) {
      case "create":
        return this.create({ ...request, operation: this.createOperation });
      case "settings-prepare":
        throw new Error("unsupported-session-provider-operation");
      case "live":
      case "usage":
      case "queue-start":
      case "queue-steer":
        return this.host.readSession(legacySessionFields(request));
      case "inspect":
      case "capabilities":
        // Common capability reads include the PA-2 queue affordances and operation fencing.
        return this.host.querySession(request);
      case "queue-list": {
        const { operation, sessionId, limit } = request;
        return this.queue({ operation, sessionId, limit });
      }
      case "settings-state":
        return this.host.settingsState(request);
      default: {
        const result = await this.host.controlSession(request);
        if (isObject(result) && result.accepted === true)
          this.host.personControlled?.(request.sessionId, request.operation);
        return result;
      }
    }
  }

  async query(request: SessionQuery) {
    const experimental = request.experimentalEnabled === true;
    const live = await this.#live(
      request.sessionId,
      false,
      request.operation === "capabilities" && experimental,
    );
    if (live.status === "unsupported") {
      if (request.operation !== "capabilities") return live;
      const operations = [
        "send",
        "stop",
        "approve",
        "answer",
        "inspect",
        "resume",
        "usage",
        "attachments",
      ];
      if (!this.acpEnabled)
        operations.push(
          "settings-state",
          "settings",
          "fork",
          "queue",
          "queue-list",
          "queue-add",
          "queue-update",
          "queue-delete",
          "queue-reorder",
          "queue-pause",
          "queue-resume",
          "queue-steer",
        );
      return {
        ...live,
        features: {
          ...Object.fromEntries(
            operations.map((operation) => [operation, { available: false, reason: live.reason }]),
          ),
          ...(!this.acpEnabled && typeof live.workspaceId === "string"
            ? { inspect: { available: true }, "queue-list": { available: true } }
            : {}),
        },
      };
    }
    const approvals = Array.isArray(live.approvals) ? live.approvals : [];
    const reason = experimental ? live.reason : "control-disabled";
    const canSend = experimental && live.status === "idle" && live.sendEnabled === true;
    const features = {
      send: canSend
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
      attachments: canSend
        ? acpAttachmentFeature(live.promptAttachments)
        : { available: false, reason: reason ?? "session-busy" },
      "settings-state": { available: true },
      settings:
        experimental && live.status === "idle" && live.turnId === null
          ? { available: true }
          : { available: false, reason: reason ?? "session-busy" },
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
        runtimeBootId: this.host.runtimeBootId,
        status: live.status,
        reason: live.reason,
        features,
      };
    return {
      sessionId: request.sessionId,
      executionMode: "acp-managed",
      runtimeBootId: this.host.runtimeBootId,
      status: live.status,
      revision: live.revision,
      turnId: live.turnId,
      approvals,
      reason: live.reason,
    };
  }

  live(sessionId: string): Promise<Record<string, unknown>> {
    return this.#live(sessionId, false);
  }

  workerLive(sessionId: string): Promise<Record<string, unknown>> {
    return this.#live(sessionId, true);
  }

  async #live(
    sessionId: string,
    supervision: boolean,
    attachments = false,
  ): Promise<Record<string, unknown> & { promptAttachments?: AcpPromptAttachmentSupport }> {
    try {
      const target = await this.#target(sessionId);
      const executable = this.host.sessions.antigravityControlExecutable();
      const cached = this.#runners.get(sessionId);
      const unknown =
        cached?.runner.snapshot().status === "outcome-unknown" ||
        managedSessionHasUnknownCommands(this.host.dataDir, sessionId);
      const current =
        cached?.runner.connected &&
        cached.runner.snapshot().status !== "failed" &&
        cached?.nativeId === target.nativeId &&
        cached.workspaceId === target.workspaceId &&
        pathIdentity(cached.workspace) === pathIdentity(target.workspace)
          ? cached.runner
          : undefined;
      const snapshot = current?.snapshot() ?? {
        executionMode: "acp-managed",
        status: "idle",
        revision: this.#inactiveRevision(sessionId, cached),
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        reason: null,
      };
      const promptAttachments =
        attachments && !unknown && snapshot.status === "idle" && snapshot.sendEnabled === true
          ? current
            ? current.client.compatibility?.promptAttachments
            : await this.#probeAttachments(executable)
          : undefined;
      return {
        ...snapshot,
        ...(promptAttachments && { promptAttachments }),
        ...(supervision && !unknown ? current?.workerObservation() : undefined),
        ...(unknown
          ? {
              status: "outcome-unknown",
              sendEnabled: false,
              stopEnabled: false,
              reason: "control-outcome-unconfirmed",
            }
          : {}),
        sessionId,
        runtimeBootId: this.host.runtimeBootId,
        // Restricted devices may control sessions in their workspaces only.
        workspaceId: target.workspaceId,
      };
    } catch (error) {
      return {
        sessionId,
        executionMode: "acp-managed",
        runtimeBootId: this.host.runtimeBootId,
        workspaceId: this.host.store.sessions.get(sessionId)?.workspace_id ?? null,
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

  #probeAttachments(executable: string): Promise<AcpPromptAttachmentSupport | undefined> {
    const cached = this.#attachmentProbe;
    if (cached?.executable === executable && Date.now() - cached.at < ATTACHMENT_PROBE_CACHE_MS)
      return cached.support;
    cached?.client.shutdown();
    try {
      const client = AntigravityAcp.spawn(
        executable,
        antigravityAcpArgs(executable),
        canonicalize(this.host.dataDir),
        { ...process.env, ...this.host.environment },
        { timeout: ATTACHMENT_PROBE_TIMEOUT_MS, version: "0.15.1" },
      );
      // Only a composer capability query probes an inactive process. It never attaches a session.
      const support = initializeAcpProbe(client, ATTACHMENT_PROBE_TIMEOUT_MS)
        .then((initialized) => {
          verifyAcpControlIdentity(initialized);
          return client.compatibility?.promptAttachments;
        })
        .catch(() => undefined)
        .finally(() => client.shutdown());
      this.#attachmentProbe = { executable, at: Date.now(), client, support };
      return support;
    } catch {
      return Promise.resolve(undefined);
    }
  }

  async #target(sessionId: string) {
    if (!this.acpEnabled) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    if (
      process.platform !== "darwin" &&
      process.platform !== "win32" &&
      process.platform !== "linux"
    )
      throw new Error("platform-unsupported");
    const summary = this.host.store.sessions.get(sessionId);
    if (!summary || summary.agent !== "antigravity" || summary.availability !== "readable")
      throw new Error("session-unavailable");
    const resolved = await this.host.sessions.resolve(sessionId);
    if (resolved.native.agent !== "antigravity") throw new Error("session-not-antigravity");
    if (resolved.native.native_ref.startsWith("antigravity-local-v1-"))
      throw new Error("session-read-only");
    if (resolved.native.sidechain) throw new Error("auxiliary-session-not-controllable");
    const nativeId = resolved.native.native_ref;
    const workspace = canonicalize(resolved.workspace);
    const workspaceId = summary.workspace_id;
    const registeredWorkspace = canonicalize(this.host.store.workspacePath(workspaceId));
    if (!within(workspace, registeredWorkspace)) throw new Error("session-workspace-mismatch");
    this.#controllable.add(sessionId);
    return { nativeId, workspaceId, workspace };
  }

  async workerAvailable(sessionId: string): Promise<boolean> {
    const live = await this.live(sessionId);
    return ["idle", "running", "waiting-approval"].includes(String(live.status));
  }

  /** Read visible replies not yet persisted by ACP without starting a second transport. */
  async workerEvents(sessionId: string, limit: number): Promise<Record<string, unknown>[] | null> {
    try {
      const target = await this.#target(sessionId);
      const cached = this.#runners.get(sessionId);
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

  async #runner(sessionId: string): Promise<AntigravityRunnerRecord> {
    const { nativeId, workspaceId, workspace } = await this.#target(sessionId);
    const cached = this.#runners.get(sessionId);
    // A Project Agent's tools are offered when its session connects; a change of them takes
    // effect by reconnecting between turns.
    const leadTools = (await this.#leadEndpoint?.(sessionId).catch(() => null)) ?? null;
    const leadUrl = leadTools?.url ?? null;
    const idle = cached?.runner.snapshot().status === "idle";
    if (
      cached?.runner.connected &&
      !["failed"].includes(String(cached.runner.snapshot().status)) &&
      cached.nativeId === nativeId &&
      cached.workspaceId === workspaceId &&
      pathIdentity(cached.workspace) === pathIdentity(workspace) &&
      (cached.leadUrl === leadUrl || !idle)
    ) {
      return cached;
    }
    const initialRevision = this.#inactiveRevision(sessionId, cached);
    if (cached) {
      this.#retiredRevisions.set(sessionId, initialRevision - 1);
      this.#runners.delete(sessionId);
      cached.runner.close();
    }
    const pending = this.#runnerFlights.get(sessionId);
    if (pending) return pending;
    const flight = this.#connectRunner(
      sessionId,
      workspaceId,
      workspace,
      nativeId,
      initialRevision,
      leadTools,
    );
    this.#runnerFlights.set(sessionId, flight);
    try {
      return await flight;
    } finally {
      if (this.#runnerFlights.get(sessionId) === flight) this.#runnerFlights.delete(sessionId);
    }
  }

  #inactiveRevision(sessionId: string, cached?: AntigravityRunnerRecord): number {
    const last = cached?.runner.snapshot().revision ?? this.#retiredRevisions.get(sessionId);
    return typeof last === "number" && Number.isSafeInteger(last) && last >= 0 ? last + 1 : 0;
  }

  async #connectRunner(
    sessionId: string,
    workspaceId: string,
    workspace: string,
    nativeId: string,
    initialRevision: number,
    leadTools: LeadToolRegistration | null,
  ): Promise<AntigravityRunnerRecord> {
    const runner = await AntigravityManagedRunner.connect(
      this.host.sessions.antigravityControlExecutable(),
      workspace,
      nativeId,
      { ...process.env, ...this.host.environment },
      (type, payload, live) => {
        const current = { ...live, sessionId, runtimeBootId: this.host.runtimeBootId, workspaceId };
        const eventPayload = isObject(payload.live) ? { ...payload, live: current } : payload;
        this.host.publishConversationEvent?.(sessionId, type, eventPayload, current);
      },
      async () => {
        const replay = await this.host.sessions.antigravityReadHandoff(nativeId);
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
      this.host.observeTurn(sessionId),
      {
        leadTools: leadTools ?? undefined,
        config: this.#savedSettings(nativeId),
      },
    );
    try {
      const latest = await this.host.sessions.resolve(sessionId);
      const latestRoot = canonicalize(this.host.store.workspacePath(workspaceId));
      if (
        latest.native.agent !== "antigravity" ||
        latest.native.sidechain ||
        latest.native.native_ref !== nativeId ||
        latest.summary.workspace_id !== workspaceId ||
        pathIdentity(canonicalize(latest.workspace)) !== pathIdentity(workspace) ||
        !within(canonicalize(latest.workspace), latestRoot)
      )
        throw new Error("session-unavailable");
      const record = {
        runner,
        nativeId,
        workspaceId,
        workspace,
        leadUrl: leadTools?.url ?? null,
      };
      this.#runners.set(sessionId, record);
      return record;
    } catch (error) {
      runner.close();
      throw error;
    }
  }

  async #executeControl(
    request: AntigravityControl,
    fingerprint: string,
    beforeNativeDispatch?: () => void,
  ) {
    if (!this.acpEnabled) throw new Error(ANTIGRAVITY_ACP_DISABLED);
    if (request.effort === null || request.serviceTier === null)
      throw new Error("unsupported-setting-clear");
    const runtimeBootId = this.host.runtimeBootId;
    if (!request.experimentalEnabled || request.runtimeBootId !== runtimeBootId)
      throw new Error("stale-or-disabled-control");
    if (managedSessionHasUnknownCommands(this.host.dataDir, request.sessionId))
      throw new Error("control-outcome-unconfirmed");
    const before = await this.live(request.sessionId);
    if (before.revision !== request.expectedRevision) throw new Error("stale-or-disabled-control");
    if (before.status === "unsupported")
      throw new Error(typeof before.reason === "string" ? before.reason : "session-unavailable");
    const cached = this.#runners.get(request.sessionId);
    if (!cached?.runner.connected || cached.runner.snapshot().status === "failed") {
      if (request.operation !== "send" && request.operation !== "settings")
        throw new Error("session-not-running");
      if (!before.sendEnabled)
        throw new Error(typeof before.reason === "string" ? before.reason : "session-unavailable");
      if (
        request.operation === "send" &&
        typeof request.text !== "string" &&
        !request.input?.length
      )
        throw new Error("missing-text");
    }
    const record = await this.#runner(request.sessionId);
    const live = record.runner.snapshot();
    if (activityBlocks(live, request.operation))
      return this.host.compactingRejection(request, this.host.runtimeBootId);
    if (request.expectedRevision !== live.revision) throw new Error("stale-or-disabled-control");
    const claimed = claimManagedCommand(
      this.host.dataDir,
      request.requestId,
      request.sessionId,
      fingerprint,
      request.deviceId ?? null,
      {
        operation: request.operation,
        workspaceId: this.host.store.sessions.get(request.sessionId)?.workspace_id ?? null,
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
      dispatchManagedCommand(this.host.dataDir, request.requestId);
      dispatched = true;
    };
    try {
      if (request.operation === "send") {
        const prompt = request.input?.length
          ? await acpPromptInput(
              this.host.dataDir,
              request.text,
              request.input,
              record.runner.client.compatibility?.promptAttachments,
              this.host.environment,
            )
          : request.text;
        if (prompt === undefined) throw new Error("missing-text");
        await record.runner.send(prompt, request.expectedRevision, beforeDispatch, {
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
      } else if (request.operation === "settings") {
        const changes = {
          ...(typeof request.model === "string" ? { model: request.model } : {}),
          ...(typeof request.effort === "string" ? { thought_level: request.effort } : {}),
          ...(typeof request.permissionMode === "string" ? { mode: request.permissionMode } : {}),
        };
        await record.runner.setOptions(changes, request.expectedRevision, beforeDispatch);
        this.#saveSettings(record.nativeId, changes);
      } else {
        throw new Error("control-unavailable");
      }
      const result = {
        accepted: true,
        // Antigravity confirms a setting when it is set; the next turn runs with it.
        completed: request.operation === "settings",
        ...(request.operation === "settings" ? { appliesTo: "next-turn" } : {}),
        sessionId: request.sessionId,
        requestId: request.requestId,
        runtimeBootId,
      };
      finishManagedCommand(this.host.dataDir, request.requestId, result);
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
      if (!outcomeUnknown) finishManagedCommand(this.host.dataDir, request.requestId, result);
      return result;
    }
  }

  /**
   * An Antigravity row of the catalog while AgentKib holds the session's ACP runner, as for
   * Devin: its turns run in the `antigravity` process AgentKib started, which quitting ends. A
   * turn waiting for a permission waits for the person, as a Codex approval does.
   */
  continuation<T extends { id: string }>(session: T): T {
    const live = this.#runners.get(session.id)?.runner.snapshot();
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
}
