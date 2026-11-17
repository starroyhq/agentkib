import { isSessionProviderAgent, type SessionProviderAgent } from "@agentkib/runtime-protocol";

/** Session operations that use a provider adapter. Other controls stay on their existing paths. */
export interface SessionProvider {
  readonly agent: SessionProviderAgent;
  readonly createOperation: string;
  options(scope: { workspaceId?: unknown; includeModels?: boolean }): Promise<unknown>;
  workspaceResources?(workspaceId: string): Promise<unknown>;
  create(fields: Record<string, unknown>): Promise<unknown>;
  settingsState(request: Record<string, unknown>): Promise<unknown>;
  prepareSettings?(request: Record<string, unknown>): Promise<unknown>;
  updateSettings(request: Record<string, unknown>): Promise<unknown>;
  contextUsage(sessionId: string): Promise<unknown>;
}

type SessionProviders = {
  readonly [Agent in SessionProviderAgent]: SessionProvider & {
    readonly agent: Agent;
  };
};

export class SessionProviderRegistry {
  readonly #providers: SessionProviders;

  constructor(providers: SessionProviders) {
    this.#providers = providers;
  }

  get(agent: unknown) {
    return isSessionProviderAgent(agent) ? this.#providers[agent] : undefined;
  }

  require(agent: unknown) {
    const provider = this.get(agent);
    if (!provider) throw new Error("unsupported-session-provider");
    return provider;
  }
}
