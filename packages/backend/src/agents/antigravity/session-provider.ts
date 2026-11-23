import type { ContextUsage } from "../../context-usage";
import { within } from "../../files";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  managedSessionHasUnknownCommands,
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
import type { ApplyManagedControl } from "../../sessions/control-admission";
import { legacySessionFields } from "../../sessions/routing";
import { validateAntigravityControl } from "../../sessions/validate/antigravity";
import type { BackendStore } from "../../store";
import { AcpUndispatchedError } from "./antigravity-acp";
import { AntigravityManagedRunner } from "./antigravity-managed-runner";

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
  admitControl(value: Record<string, unknown>, execute: ApplyManagedControl): Promise<unknown>;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AntigravityRunnerRecord = {
  runner: AntigravityManagedRunner;
  nativeId: string;
  workspaceId: string;
  workspace: string;
  lastUsed: number;
};

export class AntigravitySessionProvider implements AntigravityExecutor, TypedSessionProvider {
  readonly agent = "antigravity" as const;
  readonly validateControl = validateAntigravityControl;
  readonly typed = this;
  #runners = new Map<string, AntigravityRunnerRecord>();
  #retiredRevisions = new Map<string, number>();
  #runnerFlights = new Map<string, Promise<AntigravityRunnerRecord>>();

  constructor(private readonly host: AntigravitySessionHost) {}

  close(): void {
    for (const record of this.#runners.values()) record.runner.close();
    this.#runners.clear();
    this.#retiredRevisions.clear();
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
    const live = await this.live(request.sessionId);
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

  async #live(sessionId: string, supervision: boolean): Promise<Record<string, unknown>> {
    try {
      const target = await this.#target(sessionId);
      this.host.sessions.antigravityControlExecutable();
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
      return {
        ...snapshot,
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

  async #target(sessionId: string) {
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
  ): Promise<AntigravityRunnerRecord> {
    if (this.#runners.size >= 8) {
      const candidates = [...this.#runners.entries()]
        .filter(([, value]) => ["idle", "failed"].includes(String(value.runner.snapshot().status)))
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed);
      const [retireId, retire] = candidates[0] ?? [];
      if (!retireId || !retire) throw new Error("live-session-limit");
      this.#retiredRevisions.set(retireId, this.#inactiveRevision(retireId, retire) - 1);
      this.#runners.delete(retireId);
      retire.runner.close();
    }
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
      const record = { runner, nativeId, workspaceId, workspace, lastUsed: Date.now() };
      this.#runners.set(sessionId, record);
      return record;
    } catch (error) {
      runner.close();
      throw error;
    }
  }

  async #executeControl(
    request: Parameters<ApplyManagedControl>[0],
    fingerprint: string,
    beforeNativeDispatch?: () => void,
  ) {
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
      if (request.operation !== "send") throw new Error("session-not-running");
      if (!before.sendEnabled)
        throw new Error(typeof before.reason === "string" ? before.reason : "session-unavailable");
      if (typeof request.text !== "string") throw new Error("missing-text");
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
