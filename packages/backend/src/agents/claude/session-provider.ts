import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import {
  sessionResultProjectors,
  type SessionProvider,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import type { WorkerRestartRequest, WorkerRestartResult } from "../../orchestration-service";
import { withProviderCapabilities } from "../../sessions/providers";
import { legacySessionFields, sessionQuerySchema } from "../../sessions/routing";
import { validateClaudeControl } from "../../sessions/validate/claude-code";
import type { ClaudeBridge } from "./claude-bridge";
import { claudeExecutionSource } from "./claude-execution";
import {
  ClaudeHostControlPreflightError,
  type ClaudeManagedReadOwner,
} from "./claude-managed-read";

type NativeRequest = (value: Record<string, unknown>) => Promise<unknown>;
type Route = { run: NativeRequest; legacy?: NativeRequest };

const personOperations = new Set([
  "live",
  "capabilities",
  "inspect",
  "options",
  "create",
  "settings-state",
  "settings-prepare",
  "settings",
  "usage",
  "send",
  "stop",
  "approve",
  "answer",
  "steer",
  "queue-add",
]);

export class ClaudeSessionProvider implements SessionProvider, TypedSessionProvider {
  readonly agent = "claude-code" as const;
  readonly validateControl = validateClaudeControl;
  readonly createOperation = "create";
  readonly typed = this;
  readonly #routes = new Map<string, Route>();

  *runningSessionIds(): Iterable<string> {
    yield* this.managed.runningSessionIds();
    yield* this.bridge.runningSessionIds();
  }

  constructor(
    private readonly managed: ClaudeManagedReadOwner,
    private readonly bridge: ClaudeBridge,
    deleted: (value: Record<string, unknown>, result: Promise<unknown>) => Promise<unknown>,
    private readonly personControlled: (sessionId: string, operation: string) => void,
    private readonly leadDevice: (sessionId: string) => string | undefined = () => undefined,
  ) {
    for (const operation of new Set([
      ...managed.sessionOperations.keys(),
      ...bridge.sessionOperations.keys(),
    ])) {
      const managedOperation =
        managed.sessionOperations.get(operation) ?? ((value) => managed.request(value));
      const managedRequest: NativeRequest =
        operation === "delete"
          ? (value) => deleted(value, managedOperation(value))
          : managedOperation;
      const terminalRequest =
        operation === "events" || operation === "resume-command"
          ? undefined
          : operation === "rename"
            ? (value: Record<string, unknown>) =>
                bridge.renameLocalTitle(value, (scope) => managed.renameLocalTitle(value, scope))
            : (bridge.sessionOperations.get(operation) ?? ((value) => bridge.request(value)));
      const run: NativeRequest = (value) => this.#run(value, managedRequest, terminalRequest);
      // The old desktop RPC also carries work from other providers' serial scheduler.
      const legacy = operation.startsWith("schedule-")
        ? undefined
        : this.#legacyRoute(operation, run);
      this.#routes.set(operation, { run, legacy });
    }
    for (const operation of [
      "bridge-status",
      "bridge-challenge",
      "bridge-disconnect",
      "bridge-auto-connect",
    ]) {
      const run: NativeRequest = (value) => this.bridge.management(value);
      this.#routes.set(operation, { run, legacy: run });
    }
    const adopt: NativeRequest = (value) =>
      this.managed.adoptTerminal(value, this.bridge, this.leadDevice);
    this.#routes.set("adopt-terminal", { run: adopt, legacy: adopt });
    this.#routes.set("handover-terminal", { run: adopt, legacy: adopt });
  }

  autoAdoptTerminalLead(sessionId: string, canAdopt: () => boolean): Promise<boolean> {
    return this.managed.autoAdoptTerminalLead(sessionId, this.bridge, this.leadDevice, canAdopt);
  }

  executionSource(sessionId: string) {
    return claudeExecutionSource(sessionId, this.managed, this.bridge);
  }

  #legacyRoute(operation: string, run: NativeRequest): NativeRequest {
    let request = run;
    switch (operation) {
      case "options":
        request = async ({ workspaceId }) =>
          withProviderCapabilities(this, await run({ operation, workspaceId }), true);
        break;
      case "settings-state":
      case "settings-prepare":
        request = async (value) => withProviderCapabilities(this, await run(value));
        break;
      case "capabilities":
      case "inspect":
        request = async (value) => run(sessionQuerySchema.parse(value));
        break;
      case "live":
        request = async ({ sessionId, experimentalEnabled, terminalDisplay }) => {
          if (typeof sessionId !== "string")
            throw new Error(REMOTE_ERROR_CODES.invalidRequestDetail);
          const live = await run({
            operation,
            sessionId,
            experimentalEnabled: experimentalEnabled === true,
          });
          // A composer refresh should show the same state as the conversation stream.
          return terminalDisplay === true && live && typeof live === "object"
            ? this.bridge.displayLive(sessionId, live as Record<string, unknown>)
            : live;
        };
        break;
      case "usage":
        request = (value) =>
          run(
            typeof value.sessionId === "string" ? { operation, sessionId: value.sessionId } : value,
          );
        break;
    }
    if (!personOperations.has(operation)) return request;
    return async (value) => {
      const result = await request(value);
      if (
        typeof value.sessionId === "string" &&
        result &&
        typeof result === "object" &&
        "accepted" in result &&
        result.accepted === true
      )
        this.personControlled(value.sessionId, operation);
      return result;
    };
  }

  async #run(value: Record<string, unknown>, managed: NativeRequest, terminal?: NativeRequest) {
    try {
      const { sessionId } = value;
      const source =
        terminal && typeof sessionId === "string" ? this.executionSource(sessionId) : null;
      const liveOrResult = await (terminal && source === "terminal"
        ? terminal(value)
        : managed(value));
      if (
        (value.operation === "live" || value.operation === "capabilities") &&
        typeof sessionId === "string" &&
        value.experimentalEnabled === true &&
        liveOrResult &&
        typeof liveOrResult === "object"
      ) {
        const response = liveOrResult as Record<string, unknown>;
        if (source === "agentkib") return response;
        const handover = this.bridge.terminalHandoverSource(sessionId);
        if (!handover) return response;
        const live =
          value.operation === "live"
            ? response
            : source === "terminal"
              ? this.bridge.live(sessionId, true)
              : await this.managed.live(sessionId, true);
        const flag = await this.managed.terminalHandoverAvailability(
          sessionId,
          live,
          handover,
          this.bridge.remoteTerminalExitSource(sessionId),
        );
        if (flag && value.operation === "live") return { ...live, terminalHandover: flag };
        if (flag)
          return {
            ...response,
            features: {
              ...(response.features as Record<string, unknown>),
              "adopt-terminal": { available: flag.available, reason: flag.reason },
              "handover-terminal": { available: flag.remoteAvailable === true },
            },
          };
      }
      return liveOrResult;
    } catch (error) {
      if (error instanceof ClaudeHostControlPreflightError) return error.result;
      throw error;
    }
  }

  #route(value: Record<string, unknown>): Route | undefined {
    return typeof value.operation === "string" ? this.#routes.get(value.operation) : undefined;
  }

  legacy(value: Record<string, unknown>): Promise<unknown> | undefined {
    return this.#route(value)?.legacy?.(value);
  }

  /** Worker and compatibility callers use the native result, independent of the person's bookkeeping. */
  native(value: Record<string, unknown>): Promise<unknown> {
    const route = this.#route(value);
    return route
      ? route.run(value)
      : this.#run(
          value,
          (input) => this.managed.request(input),
          (input) => this.bridge.request(input),
        );
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(request: SessionProviderRequest): Promise<SessionProviderResponse> {
    const { operation } = request;
    let raw: unknown;
    if (request.operation === "create") {
      const { prompt: _prompt, ...fields } = request;
      raw = await this.create(fields);
    } else {
      const fields = legacySessionFields(request);
      raw = await (this.legacy(fields) ?? this.native(fields));
    }
    return {
      operation,
      result: sessionResultProjectors[operation](this.agent, raw),
    } as SessionProviderResponse;
  }

  options({ workspaceId }: { workspaceId?: unknown }) {
    return this.native({ operation: "options", workspaceId });
  }

  workspaceResources(workspaceId: string) {
    return this.native({ operation: "workspace-resources", workspaceId });
  }

  create(fields: Record<string, unknown>) {
    return this.native({ ...fields, operation: this.createOperation });
  }

  live(sessionId: string, experimentalEnabled: boolean) {
    return this.native({ operation: "live", sessionId, experimentalEnabled });
  }

  query(value: SessionQuery) {
    return this.native({ ...value });
  }

  settingsState(value: Record<string, unknown>) {
    return this.native(value);
  }

  prepareSettings(value: Record<string, unknown>) {
    return this.native(value);
  }

  updateSettings(value: Record<string, unknown>) {
    return this.native(value);
  }

  control(value: Record<string, unknown>) {
    return this.native(value);
  }

  #terminalOwnsSession(sessionId: string): boolean {
    return this.executionSource(sessionId) === "terminal";
  }

  async quitCandidate(sessionId: string) {
    if (!this.#terminalOwnsSession(sessionId)) return this.managed.quitCandidate(sessionId);
  }

  async interruptForQuit(sessionId: string, turnId: string) {
    if (!this.#terminalOwnsSession(sessionId))
      return this.managed.interruptForQuit(sessionId, turnId);
  }

  async checkAfterQuit(sessionId: string, evidence: Record<string, unknown>) {
    return (
      !this.#terminalOwnsSession(sessionId) &&
      (await this.managed.checkAfterQuit(sessionId, evidence))
    );
  }

  async resumeAfterQuit(
    sessionId: string,
    evidence: Record<string, unknown>,
    requestId: string,
    text: string,
  ) {
    if (this.#terminalOwnsSession(sessionId)) return "skipped" as const;
    return this.managed.resumeAfterQuit(sessionId, evidence, requestId, text);
  }

  restoreQuitQueue(sessionId: string, evidence: Record<string, unknown>): void {
    if (!this.#terminalOwnsSession(sessionId)) this.managed.restoreQuitQueue(sessionId, evidence);
  }

  restartWorker(
    request: WorkerRestartRequest,
    beforeDispatch: () => void,
  ): Promise<WorkerRestartResult> {
    const { sessionId, requestId } = request;
    if (this.#terminalOwnsSession(sessionId))
      return Promise.resolve({
        accepted: false,
        controlOutcome: "not-dispatched",
        requestId,
        reason: "worker-restart-user-only",
      });
    return this.managed.restartWorker(request, beforeDispatch);
  }

  contextUsage(sessionId: string) {
    return this.native({ operation: "usage", sessionId });
  }

  queue(value: Extract<SessionProviderRequest, { operation: "queue-list" }>) {
    return this.native({ ...value });
  }
}
