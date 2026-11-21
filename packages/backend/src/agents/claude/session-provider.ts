import {
  sessionResultProjectors,
  type SessionProvider,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import { withProviderCapabilities } from "../../sessions/providers";
import { legacySessionFields, sessionQuerySchema } from "../../sessions/routing";
import type { ClaudeBridge } from "./claude-bridge";
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
  readonly createOperation = "create";
  readonly typed = this;
  readonly #routes = new Map<string, Route>();

  constructor(
    private readonly managed: ClaudeManagedReadOwner,
    private readonly bridge: ClaudeBridge,
    deleted: (value: Record<string, unknown>, result: Promise<unknown>) => Promise<unknown>,
    private readonly personControlled: (sessionId: string, operation: string) => void,
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
        request = async ({ sessionId, experimentalEnabled }) => {
          if (typeof sessionId !== "string") throw new Error("invalid-request");
          return run({ operation, sessionId, experimentalEnabled: experimentalEnabled === true });
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
      if (
        terminal &&
        typeof sessionId === "string" &&
        this.bridge.handles(sessionId) &&
        this.bridge.blocksManagedResume(sessionId)
      )
        return terminal(value);
      return await managed(value);
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

  contextUsage(sessionId: string) {
    return this.native({ operation: "usage", sessionId });
  }

  queue(value: Extract<SessionProviderRequest, { operation: "queue-list" }>) {
    return this.native({ ...value });
  }
}
