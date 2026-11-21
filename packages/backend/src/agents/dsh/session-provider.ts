import {
  sessionResultProjectors,
  type SessionProvider,
  type SessionProviderRequest,
  type SessionProviderResponse,
  type SessionQuery,
  type TypedSessionProvider,
} from "../../session-provider";
import { withProviderCapabilities } from "../../sessions/providers";
import { isSessionOperation, sessionQuerySchema } from "../../sessions/routing";
import type { DshBridge } from "./dsh-bridge";

type NativeRequest = (value: Record<string, unknown>) => Promise<unknown>;
type Route = {
  run: NativeRequest;
  legacy?: NativeRequest;
  typed?: (value: SessionProviderRequest) => Promise<SessionProviderResponse>;
};

export class DshSessionProvider implements SessionProvider, TypedSessionProvider {
  readonly agent = "deepseek-harness" as const;
  readonly createOperation = "dsh-create";
  readonly typed = this;
  readonly #routes = new Map<string, Route>();

  constructor(
    private readonly bridge?: DshBridge,
    private readonly notePersonControl?: (sessionId: string, operation: string) => void,
  ) {
    for (const [operation, native] of bridge?.sessionOperations ?? []) {
      // The old web channel leaves resources to the shared reader.
      if (operation === "resources") continue;
      let run: NativeRequest = (value) => this.#run(operation, value, native);
      if (operation === "capabilities" || operation === "inspect") {
        const raw = run;
        run = async (value) => raw(sessionQuerySchema.parse(value));
      }
      const legacy: NativeRequest =
        operation === "settings-state"
          ? async (value) => withProviderCapabilities(this, await run(value))
          : run;
      this.#register(operation, run, legacy);
    }
    const create: NativeRequest = (value) => this.create(value);
    this.#register("dsh-create", create, create);
    this.#register("create", (value) => {
      const { prompt: _prompt, ...fields } = value;
      return create({ ...fields, operation: this.createOperation });
    });
    const options: NativeRequest = async (value) =>
      withProviderCapabilities(
        this,
        (await this.bridge?.createOptions(value.includeModels === true)) ?? {
          available: false,
          reason: "platform-unsupported",
        },
        true,
      );
    this.#register("dsh-options", options, options);
  }

  #register(operation: string, run: NativeRequest, legacy?: NativeRequest): void {
    const route: Route = { run, legacy };
    if (isSessionOperation(operation)) {
      const project = sessionResultProjectors[operation];
      route.typed = async (value) =>
        ({
          operation,
          result: project(this.agent, await run(value)),
        }) as SessionProviderResponse;
    }
    this.#routes.set(operation, route);
  }

  async #run(operation: string, value: Record<string, unknown>, native: NativeRequest) {
    const { sessionId } = value;
    if (typeof sessionId !== "string" || !this.bridge?.handles(sessionId))
      throw new Error("session-unavailable");
    this.notePersonControl?.(sessionId, operation);
    return native(value);
  }

  legacy(operation: string, value: Record<string, unknown>): Promise<unknown> | undefined {
    return this.#routes.get(operation)?.legacy?.(value);
  }

  request<Request extends SessionProviderRequest>(
    request: Request,
  ): Promise<SessionProviderResponse<Request["operation"]>>;
  async request(request: SessionProviderRequest): Promise<SessionProviderResponse> {
    const run = this.#routes.get(request.operation)?.typed;
    if (!run) throw new Error("unsupported-session-provider-operation");
    return run(request);
  }

  async #invoke(operation: string, value: Record<string, unknown>) {
    const run = this.#routes.get(operation)?.run;
    return run ? run(value) : this.#run(operation, value, (input) => this.bridge!.request(input));
  }

  async options({
    workspaceId,
    includeModels,
  }: {
    workspaceId?: unknown;
    includeModels?: boolean;
  }) {
    if (!this.bridge) throw new Error("session-unavailable");
    return this.bridge.createOptions(workspaceId !== undefined || includeModels === true);
  }

  async create(fields: Record<string, unknown>) {
    if (!this.bridge) throw new Error("session-unavailable");
    return this.bridge.create(fields);
  }

  live(sessionId: string, experimentalEnabled: boolean) {
    return this.#invoke("live", { operation: "live", sessionId, experimentalEnabled });
  }

  query(value: SessionQuery) {
    return this.#invoke(value.operation, { ...value });
  }

  settingsState(value: Record<string, unknown>) {
    return this.#invoke("settings-state", value);
  }

  updateSettings(value: Record<string, unknown>) {
    return this.#invoke("settings", value);
  }

  control(value: Record<string, unknown>) {
    return this.#invoke(String(value.operation), value);
  }

  contextUsage(sessionId: string) {
    return this.#invoke("usage", { operation: "usage", sessionId });
  }

  queue(value: Extract<SessionProviderRequest, { operation: "queue-list" }>) {
    return this.#invoke("queue-list", value);
  }
}
