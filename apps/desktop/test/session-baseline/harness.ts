import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { vi } from "vitest";
import { HistorySearch } from "../../../../packages/backend/src/history-search";
import { TypeScriptBackend } from "../../../../packages/backend/src/index";
import { McpHub } from "../../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../../packages/backend/src/remote-agent";
import { BackendStore } from "../../../../packages/backend/src/store";
import { RuntimeRequestError } from "../../electron/main/runtime-host";
import {
  createWebControlState,
  WebAccessService,
  type HostSessionRequest,
} from "../../electron/main/web/service";

export type Rpc = (method: string, params: unknown) => Promise<unknown>;

export async function startBackend({
  data,
  workspace,
  environment,
  indexSessions = false,
  reuseData = false,
}: {
  data: string;
  workspace: string;
  environment: NodeJS.ProcessEnv & { HOME: string };
  indexSessions?: boolean;
  reuseData?: boolean;
}) {
  if (!reuseData) {
    await mkdir(data, { recursive: true });
    await writeFile(
      join(data, "preferences.json"),
      JSON.stringify({ session_index_enabled: indexSessions }),
    );
    const store = new BackendStore(join(data, "agentkib.db"));
    try {
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        workspace,
        "Offline workspace",
        "healthy",
        "2026-11-20T00:00:00Z",
      );
    } finally {
      store.close();
    }
  }

  // Keep the real request dispatcher and provider registry. Background indexers and
  // services unrelated to these requests would otherwise race the synthetic runtimes.
  const mocks = [
    vi.spyOn(McpHub.prototype, "start").mockResolvedValue(),
    vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue(),
    vi.spyOn(HistorySearch.prototype, "refresh").mockImplementation(() => {}),
    vi.spyOn(HistorySearch.prototype, "clear").mockResolvedValue(),
  ];
  const home = environment.HOME;
  const backend = new TypeScriptBackend({
    USERPROFILE: home,
    AGENTKIB_HOME: join(home, ".agentkib"),
    AGENTKIB_DSH_PLUGIN_DIR: "",
    AGENTKIB_ANTIGRAVITY_ACP_BIN: undefined,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    DSH_HOME: join(home, ".dsh"),
    DEVIN_SESSIONS_DIR: join(home, ".local", "share", "devin"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    ...environment,
  });
  const rpc: Rpc = async (method, params) => {
    const response = await backend.handleAsync({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    });
    if (response.error) throw new RuntimeRequestError(response.error);
    return response.result;
  };
  async function close() {
    try {
      await backend.close();
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
    }
  }
  try {
    await rpc("backend.initialize", { dataDir: data });
    return { rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

export async function startHost({
  root,
  workspace,
  rpc,
  enableClaudeScheduler = false,
}: {
  root: string;
  workspace: string;
  rpc: Rpc;
  enableClaudeScheduler?: boolean;
}) {
  const calls: {
    method: string;
    params: unknown;
    target?: HostSessionRequest["host"]["target"];
  }[] = [];
  const dispatch = (method: string) => (params: unknown) => {
    calls.push({ method, params });
    return rpc(method, params);
  };
  const shared = createWebControlState();
  const service = new WebAccessService({
    dataDir: join(root, "host"),
    staticDir: root,
    desktopOrigin: "app://bundle",
    sessionRequest: (input) => {
      const { request: params, target } = input.host;
      calls.push({ method: "session.request", params, ...(target ? { target } : {}) });
      return rpc("session.request", input);
    },
    historyRequest: (method, params) => dispatch(method)(params),
    receiptRequest: dispatch("control.receipt"),
    workspaceRequest: async () => [{ id: "workspace", name: "Offline workspace", path: workspace }],
    verifiedCodex: true,
    verifiedClaudeManaged: true,
    verifiedAntigravityManaged: true,
    verifiedDshFollower: true,
    verifiedDevinManaged: true,
    enableClaudeScheduler,
    sharedControl: shared,
    addresses: () => [],
  });
  let origin = "";
  let cookie = "";
  let csrf = "";
  function exchange(path: string, body?: Record<string, unknown>) {
    return new Promise<{
      status: number;
      body: Record<string, unknown>;
      cookie?: string;
    }>((resolve, reject) => {
      const client = request(
        origin + "/api/web/v1" + path,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Connection: "close",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(body === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  Origin: origin,
                  "X-CSRF-Token": csrf,
                  "X-AgentKib-Protocol": "2",
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            try {
              resolve({
                status: response.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                cookie: response.headers["set-cookie"]?.[0]?.split(";")[0],
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      client.on("error", reject);
      client.setTimeout(5000, () => client.destroy(new Error("Baseline HTTP request timed out")));
      client.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  try {
    await service.initialize();
    if (shared.claudeScheduler) {
      // The tests that drain the Claude queue tick the real scheduler explicitly.
      const scheduler = shared.claudeScheduler as unknown as {
        timer?: ReturnType<typeof setInterval>;
      };
      clearInterval(scheduler.timer);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const status = await service.request({
        operation: "configure",
        enabled: true,
        port: await freePort(),
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: ["workspace"],
      });
      if (status.running) {
        origin = status.localUrl;
        break;
      }
      // Another worker can acquire the port between the probe and configuration.
      if (status.error !== "port_in_use" || attempt === 3)
        throw new Error(`Baseline host failed to listen: ${status.error ?? "unknown"}`);
    }
    const access = await exchange("/access");
    const { bootId, csrfToken } = access.body;
    if (
      access.status !== 200 ||
      !access.cookie ||
      typeof bootId !== "string" ||
      typeof csrfToken !== "string"
    )
      throw new Error(`Baseline access bootstrap failed with HTTP ${access.status}`);
    cookie = access.cookie;
    csrf = csrfToken;
    const { code } = await service.request({ operation: "generate-code", access: "full" });
    const paired = await exchange("/pair", { code: code?.value, name: "Baseline client" });
    const device = paired.body.device as { id?: string } | undefined;
    if (paired.status !== 200 || !device?.id)
      throw new Error(`Baseline pairing failed with HTTP ${paired.status}`);

    return {
      async http(path: string, body?: Record<string, unknown>) {
        const { status, body: response } = await exchange(path, body);
        return { status, body: response };
      },
      bootId,
      deviceId: device.id,
      calls,
      tickClaudeQueue: () => shared.claudeScheduler?.tick(),
      dispose: () => service.dispose(),
    };
  } catch (error) {
    await service.dispose();
    throw error;
  }
}
