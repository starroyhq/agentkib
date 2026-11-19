import { isSessionProviderAgent, type SessionProviderAgent } from "@agentkib/runtime-protocol";

export interface SessionQuery {
  operation: "capabilities" | "inspect";
  sessionId: string;
  deviceId?: string;
  experimentalEnabled?: boolean;
}

interface SessionExecutor {
  live(sessionId: string, enabled: boolean): Promise<unknown>;
  query(request: SessionQuery): Promise<unknown>;
  control(request: Record<string, unknown>): Promise<unknown>;
  contextUsage(sessionId: string): Promise<unknown>;
}

/** Each provider prepares its native execution environment within the original control request. */
export interface SessionProvider extends SessionExecutor {
  readonly agent: SessionProviderAgent;
  readonly createOperation: string;
  options(scope: { workspaceId?: unknown; includeModels?: boolean }): Promise<unknown>;
  workspaceResources?(workspaceId: string): Promise<unknown>;
  create(fields: Record<string, unknown>): Promise<unknown>;
  settingsState(request: Record<string, unknown>): Promise<unknown>;
  prepareSettings?(request: Record<string, unknown>): Promise<unknown>;
  updateSettings(request: Record<string, unknown>): Promise<unknown>;
}

type SessionProviders = {
  readonly [Agent in SessionProviderAgent]: SessionProvider & {
    readonly agent: Agent;
  };
} & { readonly antigravity: SessionExecutor & { readonly agent: "antigravity" } };

export class SessionProviderRegistry {
  readonly #providers: SessionProviders;

  constructor(providers: SessionProviders) {
    this.#providers = providers;
  }

  get(agent: unknown) {
    return agent === "antigravity" ? this.#providers.antigravity : this.creatable(agent);
  }

  creatable(agent: unknown) {
    return isSessionProviderAgent(agent) ? this.#providers[agent] : undefined;
  }

  require(agent: unknown) {
    const provider = this.creatable(agent);
    if (!provider) throw new Error("unsupported-session-provider");
    return provider;
  }
}
