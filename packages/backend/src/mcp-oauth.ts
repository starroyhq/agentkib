import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpServer } from "./mcp-config-read";
import type { McpManager } from "./mcp";

type StoredOAuthCredentials = {
  client_id?: string;
  client_information?: OAuthClientInformationMixed;
  token_response?: OAuthTokens;
  granted_scopes?: string[];
  token_received_at?: number;
  issuer?: string;
  discovery_state?: OAuthDiscoveryState;
};
type HttpMcpServer = Extract<McpServer, { transport: "streamable-http" }>;

type Pending = { server: HttpMcpServer; provider: StoredOAuthProvider; state: string };

export class McpOAuth {
  #pending = new Map<string, Pending>();

  constructor(
    readonly manager: McpManager,
    readonly port: () => number,
  ) {}

  async start(serverId: string, project?: string): Promise<{ authorization_url: string }> {
    const server = this.manager.getPrivate(serverId, project);
    if (!server) throw new Error("Unknown MCP server");
    if (server.transport !== "streamable-http" || !("url" in server))
      throw new Error("OAuth is supported only for Streamable HTTP MCP servers");
    const serverUrl = server.url;
    this.manager.ensureOAuthStore(server, project);
    const provider = new StoredOAuthProvider(server, this.manager, project, this.port());
    const state = randomBytes(32).toString("base64url");
    provider.stateValue = state;
    provider.authorizationUrl = undefined;
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const result = await auth(provider, { serverUrl });
    const authorizationUrl = provider.getAuthorizationUrl();
    if (result !== "REDIRECT" || !authorizationUrl)
      throw new Error("MCP server did not begin an interactive OAuth flow");
    this.#pending.set(server.id, { server, provider, state });
    return { authorization_url: authorizationUrl.toString() };
  }

  async complete(serverId: string, code: string, state: string, issuer?: string): Promise<void> {
    const pending = this.#pending.get(serverId);
    if (!pending) throw new Error("No pending OAuth authorization for this MCP server");
    if (!safeEqual(state, pending.state)) throw new Error("OAuth state did not match");
    const expectedIssuer = pending.provider.discovery?.authorizationServerMetadata?.issuer;
    if (issuer && expectedIssuer && issuer !== expectedIssuer)
      throw new Error("OAuth issuer did not match the discovered authorization server");
    this.#pending.delete(serverId);
    const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
    await auth(pending.provider, { serverUrl: pending.server.url, authorizationCode: code });
    if (!pending.provider.hasTokens) throw new Error("OAuth provider did not return credentials");
  }

  cancel(serverId: string): void {
    this.#pending.delete(serverId);
  }
}

export function oauthProvider(
  server: HttpMcpServer,
  manager: McpManager,
  project: string | undefined,
  port: number,
) {
  return new StoredOAuthProvider(server, manager, project, port);
}

class StoredOAuthProvider implements OAuthClientProvider {
  readonly #redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  authorizationUrl?: URL;
  stateValue?: string;
  discovery?: OAuthDiscoveryState;
  hasTokens = false;

  constructor(
    readonly server: HttpMcpServer,
    readonly manager: McpManager,
    readonly project: string | undefined,
    port: number,
  ) {
    this.#redirectUrl = `http://127.0.0.1:${port}/oauth/callback/${encodeURIComponent(server.id)}`;
    this.clientMetadata = {
      redirect_uris: [this.#redirectUrl],
      client_name: "AgentKib",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    };
    this.discovery = readCredentials(server)?.discovery_state;
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  state(): string {
    return this.stateValue ?? "";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = readCredentials(this.server);
    return (
      stored?.client_information ??
      (stored?.client_id ? { client_id: stored.client_id } : undefined)
    );
  }

  saveClientInformation(value: OAuthClientInformationMixed): void {
    this.#update((stored) => ({
      ...stored,
      client_id: value.client_id,
      client_information: value,
    }));
  }

  tokens(): OAuthTokens | undefined {
    return readCredentials(this.server)?.token_response;
  }

  saveTokens(value: OAuthTokens): void {
    this.hasTokens = true;
    const scopes = value.scope?.split(/\s+/).filter(Boolean) ?? [];
    this.#update((stored) => ({
      ...stored,
      token_response: value,
      granted_scopes: scopes,
      token_received_at: Math.floor(Date.now() / 1000),
      issuer: this.discovery?.authorizationServerMetadata?.issuer,
    }));
  }

  saveCodeVerifier(value: string): void {
    this.#verifier = value;
  }

  codeVerifier(): string {
    if (!this.#verifier) throw new Error("No OAuth PKCE verifier is pending");
    return this.#verifier;
  }

  redirectToAuthorization(value: URL): void {
    this.authorizationUrl = value;
  }

  getAuthorizationUrl(): URL | undefined {
    return this.authorizationUrl;
  }

  saveDiscoveryState(value: OAuthDiscoveryState): void {
    this.discovery = value;
    this.#update((stored) => ({ ...stored, discovery_state: value }));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.manager.clearOAuthCredentials(this.server.id, this.project);
    else
      this.#update((stored) => {
        const next = { ...stored };
        if (scope === "client") {
          delete next.client_id;
          delete next.client_information;
        }
        if (scope === "tokens") {
          delete next.token_response;
          delete next.granted_scopes;
          delete next.token_received_at;
        }
        if (scope === "discovery") delete next.discovery_state;
        return next;
      });
    if (scope === "verifier" || scope === "all") this.#verifier = undefined;
  }

  #verifier?: string;

  #update(transform: (value: StoredOAuthCredentials) => StoredOAuthCredentials): void {
    const current = readCredentials(this.server) ?? {};
    const updated = transform(current);
    this.manager.saveOAuthCredentials(this.server.id, updated, this.project);
    this.server.oauth_credentials = updated;
  }
}

function readCredentials(server: McpServer): StoredOAuthCredentials | undefined {
  const value = server.oauth_credentials;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as StoredOAuthCredentials)
    : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
