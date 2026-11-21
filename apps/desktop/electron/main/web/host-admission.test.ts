// @vitest-environment node
import {
  validateEmbeddedControl,
  type HostControlValidationCall,
} from "@agentkib/backend/session-control-validation";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request, Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { HOSTED_ORIGIN, WebAccessService } from "./service";

const providers = [
  { agent: "codex", executionMode: "codex-managed", needsSend: false },
  { agent: "claude-code", executionMode: "claude-managed", needsSend: false },
  { agent: "deepseek-harness", executionMode: "dsh-follower", needsSend: false },
  { agent: "devin", executionMode: "devin-print", needsSend: true },
  { agent: "antigravity", executionMode: "acp-managed", needsSend: true },
] as const;
const lanAddress = "192.168.20.10";
type ProviderCase = (typeof providers)[number];
type ResponseBody = {
  bootId?: string;
  csrfToken?: string;
  bearerToken?: string;
  pending?: { id: string };
  [key: string]: unknown;
};

const fixtures: (() => Promise<void>)[] = [];
afterEach(async () => {
  try {
    for (const cleanup of fixtures.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture(lan = false) {
  const root = await mkdtemp(join(tmpdir(), "agentkib-admission-"));
  fixtures.push(() => rm(root, { recursive: true, force: true }));
  const workspaces = await Promise.all(
    ["allowed", "other"].map(async (id) => {
      const path = join(root, id);
      await mkdir(path);
      return { id, name: id, path };
    }),
  );
  const sessions = providers.flatMap(({ agent, executionMode }) =>
    workspaces.map(({ id }) => ({
      id: `${agent}:${id}`,
      workspace_id: id,
      agent,
      executionMode,
    })),
  );
  const dispatched: Record<string, unknown>[] = [];
  const service = new WebAccessService({
    ...(lan ? { mode: "lan", addresses: () => [{ name: "fixture", address: lanAddress }] } : {}),
    dataDir: root,
    staticDir: root,
    workspaceRequest: async () => workspaces,
    verifiedCodex: true,
    verifiedClaudeManaged: true,
    verifiedDshFollower: true,
    verifiedDevinManaged: true,
    verifiedAntigravityManaged: true,
    sessionRequest: async ({ host: { request: input } }) => {
      if (input.operation === "catalog") return { sessions, workspaces };
      if (input.operation === "provider-validate-control")
        return validateEmbeddedControl(input.call as HostControlValidationCall);
      const session = sessions.find(({ id }) => id === input.sessionId);
      if (!session) throw new Error("unknown-fixture-session");
      if (input.operation === "capabilities")
        return {
          executionMode: session.executionMode,
          features: { "queue-add": { available: true } },
        };
      if (input.operation === "live")
        return {
          sessionId: session.id,
          workspaceId: session.workspace_id,
          executionMode: session.executionMode,
          runtimeBootId: "fixture-runtime",
          revision: 4,
          status: "idle",
          sendEnabled: true,
        };
      if (input.operation !== "queue-add" && input.operation !== "send")
        throw new Error("unexpected-fixture-operation");
      dispatched.push(input);
      return { accepted: true, requestId: input.requestId, sessionId: session.id };
    },
  });
  fixtures.push(() => service.shutdown());
  await service.initialize();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  if (lan) {
    // Exercise LAN trust rules on loopback without exposing a listener to the network.
    const listen = Server.prototype.listen;
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      args[1] = "127.0.0.1";
      return Reflect.apply(listen, this, args);
    } as typeof listen);
  }
  const origin = lan ? HOSTED_ORIGIN : `http://127.0.0.1:${port}`;
  await service.request({
    operation: "configure",
    enabled: true,
    port,
    externalOrigin: lan ? HOSTED_ORIGIN : "",
    experimentalEnabled: true,
    allowedWorkspaceIds: ["allowed"],
    ...(lan ? { lanAddress, allowPlaintext: true } : {}),
  });

  async function device(kind: "full" | "restricted" | "send-only" | "queue-only") {
    let cookie: string | undefined;
    let csrf: string | undefined;
    let bearer: string | undefined;
    function http(path: string, body?: Record<string, unknown>) {
      return new Promise<{ status: number; body: ResponseBody }>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method: body === undefined ? "GET" : "POST",
            headers: {
              Host: `${lan ? lanAddress : "127.0.0.1"}:${port}`,
              Origin: origin,
              ...(cookie ? { Cookie: cookie } : {}),
              ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
              ...(body
                ? {
                    "X-CSRF-Token": csrf!,
                    "X-AgentKib-Protocol": "2",
                    "Content-Type": "application/json",
                  }
                : {}),
            },
          },
          (res) => {
            cookie = res.headers["set-cookie"]?.[0]?.split(";")[0] ?? cookie;
            res.setEncoding("utf8");
            let received = "";
            res.on("data", (chunk) => (received += chunk));
            res.on("end", () => {
              try {
                resolve({ status: res.statusCode!, body: JSON.parse(received) });
              } catch (error) {
                reject(error);
              }
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      });
    }
    const access = await http("/access");
    expect(access.status).toBe(200);
    csrf = access.body.csrfToken;
    bearer = access.body.bearerToken;
    if (kind === "full" || lan) {
      const { code } = await service.request({ operation: "generate-code", access: "full" });
      const paired = await http("/pair", { code: code!.value, name: kind });
      expect(paired.status).toBe(200);
      if (lan)
        await service.request({
          operation: "approve",
          id: paired.body.pending!.id,
          send: true,
          approve: true,
          advancedControl: true,
        });
      else expect(paired.body.device).toMatchObject({ accessMode: "full" });
    } else {
      await approveLegacyBrowser(service, cookie!, {
        send: kind !== "queue-only",
        advancedControl: kind !== "send-only",
      });
    }
    return {
      control(
        provider: ProviderCase,
        workspaceId: string,
        operation: "queue-add" | "send" = "queue-add",
      ) {
        return http(operation === "send" ? "/send" : "/managed/action", {
          operation,
          agent: provider.agent === "codex" ? "devin" : "codex",
          bootId: access.body.bootId,
          expectedRevision: 4,
          requestId: randomUUID(),
          sessionId: `${provider.agent}:${workspaceId}`,
          text: "A queued fixture message",
          // The public body does not set the native DSH command grant.
          commandAccess: "all",
        });
      },
    };
  }
  return { device, dispatched };
}

describe("host session-control admission by provider and device", () => {
  it.each(providers)("enforces workspace and queue grants for $agent", async (provider) => {
    const host = await fixture();
    const full = await host.device("full");
    const restricted = await host.device("restricted");
    const sendOnly = await host.device("send-only");
    const queueOnly = await host.device("queue-only");

    // Full access uses registered workspaces, including those outside the legacy allowlist.
    expect(await full.control(provider, "other")).toMatchObject({ status: 200 });
    expect(await restricted.control(provider, "allowed")).toMatchObject({ status: 200 });
    if (provider.agent === "deepseek-harness") {
      expect(host.dispatched.map(({ commandAccess }) => commandAccess)).toEqual(["all", "session"]);
    } else {
      for (const forwarded of host.dispatched)
        expect(forwarded).not.toHaveProperty("commandAccess");
    }
    const denied = (error: string) => ({
      status: 403,
      body: { error, controlOutcome: "not-dispatched" },
    });
    expect(await restricted.control(provider, "other")).toMatchObject(
      denied("workspace_not_authorized"),
    );
    expect(await sendOnly.control(provider, "allowed")).toMatchObject(denied("permission_denied"));
    expect(host.dispatched).toHaveLength(2);

    const queued = await queueOnly.control(provider, "allowed");
    if (provider.needsSend) expect(queued).toMatchObject(denied("permission_denied"));
    else expect(queued).toMatchObject({ status: 200 });
    expect(host.dispatched).toHaveLength(provider.needsSend ? 2 : 3);
  });

  it("denies advanced LAN actions while retaining the registered Codex send exception", async () => {
    const host = await fixture(true);
    const device = await host.device("restricted");
    for (const provider of providers) {
      expect(await device.control(provider, "allowed")).toMatchObject({
        status: 403,
        body: { error: "capability_unavailable", controlOutcome: "not-dispatched" },
      });
    }
    expect(host.dispatched).toHaveLength(0);

    for (const provider of providers) {
      const sent = await device.control(provider, "allowed", "send");
      if (provider.agent === "codex") expect(sent).toMatchObject({ status: 200 });
      else
        expect(sent).toMatchObject({
          status: 403,
          body: { error: "provider_control_not_allowed", controlOutcome: "not-dispatched" },
        });
    }
    expect(host.dispatched).toEqual([
      expect.objectContaining({ operation: "send", sessionId: "codex:allowed" }),
    ]);
  });
});
