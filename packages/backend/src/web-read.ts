import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  sessionProviderCapabilities,
  type ConversationReadResult,
} from "@agentkib/runtime-protocol";
import { AntigravitySessionProvider } from "./agents/antigravity/session-provider";
import { readManagedRecords, type ManagedRecord } from "./agents/codex/managed-records";
import {
  hasManagedCatalogWorkspace,
  managedCatalogProjection,
  readManagedCatalog,
} from "./agents/codex/managed-session-catalog";
import { CodexSessionProvider } from "./agents/codex/session-provider";
import { DevinSessionProvider } from "./agents/devin/session-provider";
import { DshSessionProvider } from "./agents/dsh/session-provider";
import { projectContextUsage, type ContextUsage } from "./context-usage";
import type { ReadStateTarget } from "./conversation-read-state";
import { catalogCheckouts } from "./git-checkouts";
import type { LeadToolRegistration } from "./orchestration-endpoint";
import { SerialSessionQueue } from "./sessions/serial-session-queue";
import type { SessionIndex } from "./session-index";
import type { SessionProviderRegistry, SessionProviders } from "./session-provider";
import type { SessionReaders } from "./session-readers";
import {
  admitManagedControl,
  antigravityManagedControlSchema,
  managedControlSchema,
  type ApplyManagedControl,
  type ManagedControlRequest,
} from "./sessions/control-admission";
import type { LaneObserver } from "./sessions/lane-observer";
import {
  createSessionProviders,
  getSessionProviderReader,
  withProviderCapabilities,
} from "./sessions/providers";
import {
  sessionQuerySchema as managedQuerySchema,
  sessionSettingsStateSchema,
} from "./sessions/routing";
import { validateClaudeControl } from "./sessions/validate/claude-code";
import type { BackendStore } from "./store";

export type { LaneObserver } from "./sessions/lane-observer";

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

const sessionProviderOptionsScopeSchema = z
  .object({ workspaceId: z.string().min(1).max(256).optional() })
  .strict();

function normalizeContextUsage(snapshot: { usage?: unknown; reason?: unknown }): ContextUsage {
  return (
    projectContextUsage(snapshot.usage) ?? {
      available: false,
      state: "unavailable",
      reason: typeof snapshot.reason === "string" ? snapshot.reason : "usage-not-reported",
    }
  );
}

function unavailableClaudeProvider(): SessionProviders["claude-code"] {
  const reject = async () => {
    throw new Error("claude-managed-unavailable");
  };
  return {
    agent: "claude-code",
    validateControl: validateClaudeControl,
    createOperation: "create",
    live: reject,
    query: reject,
    options: reject,
    workspaceResources: reject,
    create: reject,
    settingsState: reject,
    prepareSettings: reject,
    control: reject,
    updateSettings: reject,
    contextUsage: reject,
    queue: reject,
  };
}

export class WebReadRequests {
  readonly #codex: CodexSessionProvider;
  readonly sessionProviders: SessionProviderRegistry;

  codexSessionProvider(): SessionProviders["codex"] {
    return this.#codex;
  }

  claudeSessionProvider(): SessionProviders["claude-code"] {
    return this.claudeProvider;
  }

  devinSessionProvider(): SessionProviders["devin"] {
    return this.#devin;
  }

  antigravitySessionProvider(): SessionProviders["antigravity"] {
    return this.#antigravity;
  }

  #controlSessions = new Map<string, { count: number; observed: boolean }>();
  #laneObserver?: LaneObserver;
  readonly #serialQueue: SerialSessionQueue;
  #closing?: Promise<void>;
  #shuttingDown = false;
  #operations = new Set<Promise<unknown>>();
  #bootId = randomUUID();
  readonly #antigravity: AntigravitySessionProvider;
  readonly #devin: DevinSessionProvider;
  /** See `observeResults`. */
  #resultObserver?: (
    target: Omit<ReadStateTarget, "transcript">,
    result: ConversationReadResult,
    options: { turnStartedAt: string },
  ) => void;

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
    private readonly claudeProvider = unavailableClaudeProvider(),
    dshProvider = new DshSessionProvider(),
    personControlled?: (sessionId: string, operation: string) => void,
    requestCodexSession?: (request: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.#codex = new CodexSessionProvider({
      store,
      sessions,
      dataDir,
      indexGeneration,
      indexEnabled: () => indexEnabled(dataDir),
      environment,
      sessionIndex,
      controlSessions: this.#controlSessions,
      runtimeBootId: this.#bootId,
      publishConversationEvent,
      isSessionObserved,
      catalogChanged,
      hasLaneObserver: () => this.#laneObserver !== undefined,
      observeLane: (notify) => this.#observeLane(notify),
      isShuttingDown: () => this.#shuttingDown,
      isClosing: () => this.#closing !== undefined,
      assertOpen: () => this.#assertOpen(),
      runOperation: (run) => this.#runOperation(run),
      admitControl: (request, execute) =>
        this.#managedControlAdmission(request, managedControlSchema, execute),
      controlSession: (request, restrictNativePolicy) =>
        this.managedControl(request, restrictNativePolicy),
      querySession: (request) => this.managedQuery(request),
      requestSession: requestCodexSession,
      normalizeContextUsage,
      compactingRejection,
    });
    this.#antigravity = new AntigravitySessionProvider({
      store,
      sessions,
      dataDir,
      environment,
      runtimeBootId: this.#bootId,
      publishConversationEvent,
      observeTurn: (sessionId) => ({
        waiting: (turnId) =>
          this.#observeLane((observer) => observer.waiting(sessionId, turnId, "awaiting-approval")),
        ended: (turnId, outcome, durationMs, replyText) =>
          this.#observeLane((observer) =>
            observer.turnEnded(sessionId, turnId, outcome, durationMs, undefined, replyText),
          ),
      }),
      admitControl: (request, execute) =>
        this.#managedControlAdmission(request, antigravityManagedControlSchema, execute),
      queue: (request) => this.managedQueueList(request),
      readSession: (request) => this.request(request),
      querySession: (request) => this.managedQuery(request),
      settingsState: (request) => this.sessionProviderSettingsState(request),
      controlSession: (request) => this.managedControl(request),
      personControlled,
      normalizeContextUsage,
      compactingRejection,
    });
    this.#devin = new DevinSessionProvider({
      store,
      sessions,
      dataDir,
      environment,
      runtimeBootId: this.#bootId,
      publishConversationEvent,
      catalogChanged,
      indexGeneration,
      indexEnabled: () => indexEnabled(dataDir),
      recordResult: (target, result, options) => this.#resultObserver?.(target, result, options),
      turnEnded: (...args) => this.#observeLane((observer) => observer.turnEnded(...args)),
      laneWaiting: (sessionId, turnId) =>
        this.#observeLane((observer) => observer.waiting(sessionId, turnId, "waiting-approval")),
      isShuttingDown: () => this.#shuttingDown,
      serialQueueTarget: (sessionId) => this.#serialQueueTarget(sessionId),
      admitControl: (request, execute) =>
        this.#managedControlAdmission(request, managedControlSchema, execute),
      queue: (request) => this.managedQueueList(request),
      readSession: (request) => this.request(request),
      querySession: (request) => this.managedQuery(request),
      readSettingsSessionId: (request) => sessionSettingsStateSchema.parse(request).sessionId,
      settingsState: (request) => this.sessionProviderSettingsState(request),
      controlSession: (request) => this.managedControl(request),
      personControlled,
      normalizeContextUsage,
    });
    this.sessionProviders = createSessionProviders(this, dshProvider);
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
  }

  close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  /** Resident native overlays also seed subscriptions that have not received any events yet. */
  readFollowerSnapshot(sessionId: string) {
    return this.#codex.readFollowerSnapshot(sessionId);
  }

  closeAsync(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#shuttingDown = true;
    this.#codex.stopTimers();
    this.#devin.beginShutdown();
    this.#codex.closeDiscovery();
    return (this.#closing = this.#close());
  }

  async #close(): Promise<void> {
    const readerClosed = this.#codex.closeReader();
    this.#antigravity.close();
    this.#devin.close();
    this.#codex.closeFollowers();
    const initialClose = Promise.allSettled([readerClosed, ...this.#codex.closeRunners()]);
    // Keep the store and ledger alive until cancelled startups and controls have
    // recorded their real dispatch outcomes. Admission is fenced synchronously.
    await Promise.allSettled([...this.#operations]);
    // A startup can finish between returning its runner and its caller registering
    // it. The operation drain covers that microtask boundary before this last sweep.
    const pending = this.#codex.closeRunners();
    const results = [...(await initialClose), ...(await Promise.allSettled(pending))];
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  #assertOpen(): void {
    if (this.#shuttingDown) throw new Error("backend-closing");
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

  leadEndpoints(source?: (sessionId: string) => Promise<LeadToolRegistration | null>): void {
    this.#codex.leadEndpoints(
      source && (async (sessionId) => (await source(sessionId))?.url ?? null),
    );
    this.#devin.leadEndpoints(source);
    this.#antigravity.leadEndpoints(source);
  }

  devinLeadCapable(sessionId: string): boolean {
    return this.#devin.leadCapable(sessionId);
  }

  antigravityLeadCapable(sessionId: string): boolean {
    return this.#antigravity.leadCapable(sessionId);
  }

  /** Confirms an Antigravity session is controlled over ACP before it may lead. */
  prepareAntigravityLead(sessionId: string): Promise<boolean> {
    return this.#antigravity.prepareLead(sessionId);
  }

  codexLeadCapable(sessionId: string): boolean {
    return this.#codex.codexLeadCapable(sessionId);
  }

  runnerHasLeadTools(sessionId: string): boolean | null {
    return this.#codex.runnerHasLeadTools(sessionId);
  }

  usageLimited(sessionId: string): boolean {
    return this.#codex.usageLimited(sessionId);
  }

  managedWorkspace(sessionId: string): string | null {
    return this.#codex.managedWorkspace(sessionId);
  }

  restartManagedRunner(sessionId: string): Promise<void> {
    return this.#codex.restartManagedRunner(sessionId);
  }

  isManagedSession(sessionId: string): boolean {
    return this.#codex.isManagedSession(sessionId);
  }

  endedTurns(sessionId: string) {
    return this.#codex.endedTurns(sessionId);
  }

  codexActiveTurn(target: { home: string; workspace: string; nativeId: string }): string | null {
    return this.#codex.codexActiveTurn(target);
  }

  managedOptions() {
    return this.sessionProviderOptions("codex");
  }

  sessionProviderOptions(agent: unknown, scope: unknown = {}): Promise<Record<string, unknown>> {
    return this.#runOperation(async () => {
      const provider = this.sessionProviders.require(agent);
      const options = await provider.options(sessionProviderOptionsScopeSchema.parse(scope));
      return withProviderCapabilities(provider, options, true);
    });
  }

  sessionProviderWorkspaceResources(agent: unknown, scope: unknown) {
    return this.#runOperation(async () => {
      const provider = this.sessionProviders.require(agent);
      const { workspaceId } = sessionProviderOptionsScopeSchema.required().parse(scope);
      if (!sessionProviderCapabilities(provider.agent)?.create.workspaceResources)
        throw new Error("unsupported-session-provider-operation");
      return provider.workspaceResources?.(workspaceId) ?? {};
    });
  }

  async sessionProviderCreate(agent: unknown, fields: Record<string, unknown>) {
    const provider = this.sessionProviders.require(agent);
    return provider.create({ ...fields, operation: provider.createOperation });
  }

  #sessionProviderForSession(sessionId: string) {
    // Newly created Codex sessions may only be present in the managed ledger until indexed.
    return this.sessionProviders.get(this.store.sessions.get(sessionId)?.agent ?? "codex");
  }

  managedReconcile(value: unknown, restrictNativePolicy = false) {
    return this.#codex.managedReconcile(value, restrictNativePolicy);
  }

  managedLifecycle(value: unknown, fingerprintOverride?: string) {
    return this.#codex.managedLifecycle(value, fingerprintOverride);
  }

  managedResume(value: unknown, restrictNativePolicy = false) {
    return this.#codex.managedResume(value, restrictNativePolicy);
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
        return this.#devin.live(sessionId);
      case "antigravity":
        return this.#antigravity.live(sessionId);
      default:
        throw new Error("session-unavailable");
    }
  }

  #dispatchSerialQueue(value: Record<string, unknown>, beforeDispatch: () => void) {
    return this.#runOperation(() => {
      const target =
        typeof value.sessionId === "string" ? this.#serialQueueTarget(value.sessionId) : null;
      if (!target || value.operation !== "send") throw new Error("invalid-scheduled-operation");
      if (target.agent === "antigravity") return this.#antigravity.control(value, beforeDispatch);
      return this.#devin.control(value, beforeDispatch);
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
    return this.#codex.queue(value);
  }

  managedUnarchive(value: unknown) {
    return this.#codex.managedUnarchive(value);
  }

  managedDelete(value: unknown) {
    return this.#codex.managedDelete(value);
  }

  managedSettingsState(value: unknown) {
    return this.#runOperation(async () => {
      const provider = this.sessionProviders.require("codex");
      if (!isObject(value)) throw new Error("invalid-request");
      return withProviderCapabilities(provider, await provider.settingsState(value));
    });
  }

  sessionProviderSettingsState(value: Record<string, unknown>) {
    return this.#runOperation(async () => {
      const provider =
        typeof value.sessionId === "string"
          ? this.sessionProviders.creatable(this.#sessionProviderForSession(value.sessionId)?.agent)
          : undefined;
      if (!provider) throw new Error("unsupported-session-provider-operation");
      return withProviderCapabilities(provider, await provider.settingsState(value));
    });
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

  /** A device lost access: AgentKib no longer continues in its name after a usage limit. */
  invalidateUsageLimitDevice(deviceId: string): void {
    this.#codex.invalidateUsageLimitDevice(deviceId);
    this.#devin.invalidateUsageLimitDevice(deviceId);
  }

  managedControl(value: unknown, restrictNativePolicy = false) {
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
      return provider === this.#codex
        ? this.#codex.control(value, restrictNativePolicy)
        : provider.control(value);
    });
  }

  #managedControlAdmission<Request extends ManagedControlRequest>(
    value: unknown,
    schema: { parse(value: unknown): Request },
    execute: ApplyManagedControl<Request>,
  ) {
    return admitManagedControl(
      {
        dataDir: this.dataDir,
        controlSessions: this.#controlSessions,
        isSessionObserved: (id) => this.isSessionObserved?.(id),
        runnerForSession: (id) => this.#codex.runnerObservation(id),
      },
      value,
      schema,
      execute,
    );
  }

  /** A short-lived subscription must be recorded even between retirement timer ticks. */
  observeSession(sessionId: string): void {
    this.#codex.observeSession(sessionId);
  }

  request(value: unknown) {
    return this.#runOperation(() => this.#request(value));
  }

  indexedCodexHistoryVersion(sessionId: string): Promise<string | null> {
    return this.#codex.indexedCodexHistoryVersion(sessionId);
  }

  indexedCodexEvents(value: unknown) {
    return this.#runOperation(async () => {
      const request = requestSchema.parse(value);
      if (request.operation !== "events") throw new Error("invalid-request");
      return this.#codex.indexedCodexEvents(request);
    });
  }

  async #request(value: unknown) {
    const request = requestSchema.parse(value);
    if (request.operation === "subagents" || request.operation === "subagent-events") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      const child = request.operation === "subagent-events" ? request : null;
      if (managed) return this.#codex.managedSubagents(managed, child);
      const source = await this.sessions.resolve(request.sessionId);
      const observation = this.#codex.subagentObservation(
        request.sessionId,
        source.native.native_ref,
      );
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
    if (request.operation === "context") return this.#codex.context(request.sessionId);
    if (request.operation === "resume-command") return this.#codex.resumeCommand(request.sessionId);
    if (request.operation === "usage") {
      const provider = this.#sessionProviderForSession(request.sessionId);
      if (!provider) throw new Error("unsupported-session-provider");
      return provider.contextUsage(request.sessionId);
    }
    if (request.operation === "goal") return this.#codex.goal(request.sessionId);
    if (request.operation === "resources") return this.#resources(request.sessionId);
    if (request.operation === "session-directory") return this.#sessionDirectory(request.sessionId);
    if (request.operation === "session-image") {
      const managed = readManagedRecords(this.dataDir, this.store).find(
        (record) => record.id === request.sessionId,
      );
      if (managed) return this.#codex.managedImage(managed, request);
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
      if (managed) return this.#codex.managedEvents(managed, request);
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
      const sessions = sessionRows.filter(
        (session): session is { id: string; workspace_id: string } => {
          if (!isSessionSummary(session)) return false;
          return registered.has(session.workspace_id) && !aliases.has(session.id);
        },
      );
      sessions.push(...this.#codex.catalogRows(managed, aliasesByOwner, nativeByOwner));
      const runtime = this.#codex.catalogRuntime(sessions, enabled);
      if (this.indexGeneration() !== generation || indexEnabled(this.dataDir) !== enabled)
        throw new Error("catalog-stale");
      const incompleteSources = enabled
        ? (this.sessionIndex?.incompleteSources(allWorkspaces.map((workspace) => workspace.id)) ??
          [])
        : [];
      const checkouts = catalogCheckouts(this.store, this.environment);
      const externalTurns = this.#codex.externalTurnsBySession(managed, aliasesByOwner, enabled);
      const catalogProviders = {
        codex: this.#codex,
        devin: this.#devin,
        antigravity: this.#antigravity,
        codexRuntime: runtime,
        codexExternalTurns: externalTurns,
      };
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
          if (
            !isSessionSummary(session) ||
            !("agent" in session) ||
            typeof session.agent !== "string"
          )
            return session;
          const reader = getSessionProviderReader(session.agent);
          return reader?.catalog?.(session, catalogProviders) ?? session;
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

  antigravityWorkerAvailable(sessionId: string) {
    return this.#antigravity.workerAvailable(sessionId);
  }

  antigravityWorkerEvents(sessionId: string, limit: number) {
    return this.#antigravity.workerEvents(sessionId, limit);
  }

  devinEndedTurns(sessionId: string) {
    return this.#devin.endedTurns(sessionId);
  }

  devinCreate(value: Record<string, unknown>) {
    return this.sessionProviders.require("devin").create(value);
  }

  devinOptions() {
    return this.sessionProviderOptions("devin");
  }

  /**
   * The directory a session's relative file references were written against. Callers resolve
   * those references inside their own file grant. Null means the registered root.
   */
  #sessionDirectory(sessionId: string): { cwd: string | null } {
    return (
      this.#codex.managedSessionDirectory(sessionId) ?? {
        cwd: this.store.sessions.directories([sessionId]).get(sessionId)?.cwd ?? null,
      }
    );
  }

  #resources(sessionId: string) {
    const indexed = this.store.sessions.get(sessionId);
    if (indexed?.agent === "devin") return this.#devin.resources(sessionId, indexed.workspace_id);
    return this.#codex.resources(sessionId);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
