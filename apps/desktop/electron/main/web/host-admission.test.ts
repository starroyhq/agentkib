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
import { HOSTED_ORIGIN, WebAccessService, type HostSessionRequest } from "./service";

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

async function fixture({
  lan = false,
  elevatedCodexPolicy = false,
  codexFollowerMode = false,
} = {}) {
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
      executionMode: codexFollowerMode && agent === "codex" ? "codex-follower" : executionMode,
    })),
  );
  const hostDispatches: HostSessionRequest["host"][] = [];
  const queues = new Map<string, Record<string, unknown>[]>();
  const queueReads: Record<string, unknown>[] = [];
  const queueReceipts = new Map<
    string,
    { deviceId: string; sessionId: string; workspaceId: string; ownerWaitOnly?: true }
  >();
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
    receiptRequest: async ({ requestId, deviceId }) => {
      const receipt = queueReceipts.get(requestId);
      if (!receipt || receipt.deviceId !== deviceId) return { found: false, requestId };
      return {
        found: true,
        requestId,
        sessionId: receipt.sessionId,
        workspaceId: receipt.workspaceId,
        operation: "queue-delete",
        executionMode: "codex-managed",
        status: "accepted",
        completionObserved: false,
        ack: { accepted: true, requestId, ownerWaitOnly: receipt.ownerWaitOnly },
      };
    },
    sessionRequest: async ({ host }) => {
      const input = host.request;
      if (input.operation === "catalog") return { sessions, workspaces };
      if (input.operation === "provider-validate-control")
        return validateEmbeddedControl(input.call as HostControlValidationCall);
      const session = sessions.find(({ id }) => id === input.sessionId);
      if (!session) throw new Error("unknown-fixture-session");
      if (input.operation === "capabilities")
        return {
          executionMode: session.executionMode,
          features: {
            "queue-add": { available: true },
            compact: { available: true },
            ...(queues.has(session.id) && {
              "queue-list": { available: true },
              "queue-delete": { available: true },
            }),
          },
          ...(queues.has(session.id) && { ownerWaitQueue: true }),
        };
      if (input.operation === "queue-list") {
        queueReads.push(input);
        return { data: queues.get(session.id) ?? [] };
      }
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
      if (!["queue-add", "queue-delete", "send", "compact"].includes(String(input.operation)))
        throw new Error("unexpected-fixture-operation");
      hostDispatches.push(host);
      if (
        elevatedCodexPolicy &&
        session.agent === "codex" &&
        "restrictCodexNativePolicy" in host &&
        host.restrictCodexNativePolicy === true
      )
        return {
          accepted: false,
          completed: false,
          requestId: input.requestId,
          sessionId: session.id,
          runtimeBootId: input.runtimeBootId,
          controlOutcome: "not-dispatched",
          reason: "native-policy-full-access-required",
        };
      if (input.operation === "queue-delete" && input.ownerWaitOnly === true) {
        queueReceipts.set(String(input.requestId), {
          deviceId: String(input.deviceId),
          sessionId: session.id,
          workspaceId: session.workspace_id,
          ownerWaitOnly: true,
        });
        return {
          accepted: true,
          requestId: input.requestId,
          sessionId: session.id,
          ownerWaitOnly: true,
        };
      }
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
          send: kind !== "queue-only",
          approve: true,
          advancedControl: kind !== "send-only",
        });
      else expect(paired.body.device).toMatchObject({ accessMode: "full" });
    } else {
      await approveLegacyBrowser(service, cookie!, {
        send: kind !== "queue-only",
        advancedControl: kind !== "send-only",
      });
    }
    const paired = await http("/access");
    return {
      id: (paired.body.device as { id: string }).id,
      http,
      control(
        provider: ProviderCase,
        workspaceId: string,
        operation: "queue-add" | "queue-delete" | "send" | "compact" = "queue-add",
        path = operation === "send" ? "/send" : "/managed/action",
        extra: Record<string, unknown> = {},
      ) {
        return http(path, {
          operation,
          agent: provider.agent === "codex" ? "devin" : "codex",
          bootId: access.body.bootId,
          expectedRevision: 4,
          requestId: randomUUID(),
          sessionId: `${provider.agent}:${workspaceId}`,
          text: "A queued fixture message",
          // The public body does not set the native DSH command grant.
          commandAccess: "all",
          ...extra,
        });
      },
    };
  }
  return {
    device,
    service,
    hostDispatches,
    queues,
    queueReads,
    queueReceipts,
    get dispatched() {
      return hostDispatches.map(({ request }) => request);
    },
  };
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
    const host = await fixture({ lan: true });
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
    expect(host.hostDispatches[0]).toHaveProperty("restrictCodexNativePolicy", true);
  });

  it("limits LAN queue reads and cancels to the requesting device's waiting item", async () => {
    const host = await fixture({ lan: true });
    const device = await host.device("send-only");
    const other = await host.device("send-only");
    const noSend = await host.device("queue-only");
    const sessionId = "codex:allowed";
    const waiting = {
      id: "waiting",
      status: "pending",
      reason: "codex-waiting-for-owner",
      ownerWait: true,
      ownerWaitDeviceId: device.id,
      ownerWaitWorkspaceId: "allowed",
      input: [{ type: "text", text: "Waiting message" }],
      actions: { delete: { available: true } },
    };
    host.queues.set(sessionId, [
      waiting,
      { ...waiting, id: "foreign", ownerWaitDeviceId: other.id },
      { ...waiting, id: "wrong-workspace", ownerWaitWorkspaceId: "other" },
      { ...waiting, id: "wrong-reason", reason: "session-busy" },
      { ...waiting, id: "cannot-delete", actions: { delete: { available: false } } },
      { ...waiting, id: "interrupted", status: "unknown", reason: "control-outcome-unconfirmed" },
      { id: "native", input: [{ type: "text", text: "Native message" }] },
    ]);
    const queuePath = `/codex/queue?sessionId=${sessionId}`;
    const own = await device.http(queuePath);
    expect(own).toMatchObject({
      status: 200,
      body: {
        sessionId,
        data: [
          {
            id: "waiting",
            status: "pending",
            reason: "codex-waiting-for-owner",
            text: "Waiting message",
            actions: { delete: { available: true }, update: { available: false } },
          },
          { id: "cannot-delete", actions: { delete: { available: false } } },
          { id: "interrupted", actions: { delete: { available: true } } },
        ],
      },
    });
    expect(JSON.stringify(own.body)).not.toContain(device.id);
    expect(JSON.stringify(own.body)).not.toContain(other.id);
    expect(await other.http(queuePath)).toMatchObject({
      status: 200,
      body: { data: [{ id: "foreign" }] },
    });
    expect(await noSend.http(queuePath)).toMatchObject({
      status: 403,
      body: { error: "permission_denied" },
    });
    expect(await device.http("/codex/queue?sessionId=codex:missing")).toMatchObject({
      status: 403,
      body: { error: "workspace_not_authorized" },
    });
    expect(await device.http(`/codex/capabilities?sessionId=${sessionId}`)).toMatchObject({
      status: 200,
      body: {
        features: {
          "queue-list": { available: true },
          "queue-delete": { available: true },
          "queue-add": { available: false },
        },
      },
    });

    const cancel = (id: string, path = "/codex/queue-delete") =>
      device.control(providers[0], "allowed", "queue-delete", path, { queuedSubmissionId: id });
    for (const id of ["foreign", "wrong-workspace", "wrong-reason", "cannot-delete", "native"])
      expect(await cancel(id)).toMatchObject({
        status: 409,
        body: { error: "queue_item_unavailable", controlOutcome: "not-dispatched" },
      });
    expect(await cancel("waiting", "/managed/action")).toMatchObject({ status: 403 });
    expect(
      await noSend.control(providers[0], "allowed", "queue-delete", "/codex/queue-delete", {
        queuedSubmissionId: "waiting",
      }),
    ).toMatchObject({ status: 403, body: { error: "permission_denied" } });
    expect(host.dispatched).toEqual([]);
    const cancelled = await cancel("waiting");
    expect(cancelled).toMatchObject({ status: 200, body: { accepted: true } });
    expect(cancelled.body).not.toHaveProperty("ownerWaitOnly");
    const receiptPath = `/requests/${cancelled.body.requestId}`;
    expect(await device.http(receiptPath)).toMatchObject({
      status: 200,
      body: { status: "accepted", ack: { accepted: true } },
    });
    expect((await device.http(receiptPath)).body.ack).not.toHaveProperty("ownerWaitOnly");
    expect(await other.http(receiptPath)).toMatchObject({
      status: 200,
      body: { found: false },
    });
    const nativeReceiptId = randomUUID();
    host.queueReceipts.set(nativeReceiptId, {
      deviceId: device.id,
      sessionId,
      workspaceId: "allowed",
    });
    expect(await device.http(`/requests/${nativeReceiptId}`)).toMatchObject({
      status: 403,
      body: { error: "permission_denied" },
    });
    expect(await cancel("interrupted")).toMatchObject({ status: 200, body: { accepted: true } });
    expect(host.dispatched).toEqual([
      expect.objectContaining({
        operation: "queue-delete",
        sessionId,
        queuedSubmissionId: "waiting",
        deviceId: device.id,
        ownerWaitOnly: true,
      }),
      expect.objectContaining({
        operation: "queue-delete",
        sessionId,
        queuedSubmissionId: "interrupted",
        deviceId: device.id,
        ownerWaitOnly: true,
      }),
    ]);
    expect(host.hostDispatches[0]).toHaveProperty("restrictCodexNativePolicy", true);
    expect(host.queueReads.length).toBeGreaterThan(0);
    for (const request of host.queueReads) expect(request.ownerWaitOnly).toBe(true);
  });

  it("lets the owning non-LAN device dismiss an interrupted wait on a followed session", async () => {
    const host = await fixture({ codexFollowerMode: true });
    const owner = await host.device("full");
    const other = await host.device("full");
    const sessionId = "codex:allowed";
    host.queues.set(sessionId, [
      {
        id: "interrupted",
        status: "unknown",
        reason: "control-outcome-unconfirmed",
        ownerWait: true,
        ownerWaitDeviceId: owner.id,
        ownerWaitWorkspaceId: "allowed",
        input: [{ type: "text", text: "Interrupted message" }],
        actions: { delete: { available: true } },
      },
    ]);
    const queuePath = `/codex/queue?sessionId=${sessionId}`;
    expect(await owner.http(queuePath)).toMatchObject({
      status: 200,
      body: {
        data: [
          {
            id: "interrupted",
            status: "unknown",
            reason: "control-outcome-unconfirmed",
            actions: { delete: { available: true } },
          },
        ],
      },
    });
    expect(await other.http(queuePath)).toMatchObject({
      status: 200,
      body: { data: [{ actions: { delete: { available: false } } }] },
    });
    const cancel = (device: typeof owner) =>
      device.control(providers[0], "allowed", "queue-delete", "/managed/action", {
        queuedSubmissionId: "interrupted",
      });
    expect(await cancel(other)).toMatchObject({ status: 409 });
    expect(host.dispatched).toEqual([]);
    expect(await cancel(owner)).toMatchObject({ status: 200 });
    expect(host.dispatched).toEqual([
      expect.objectContaining({ ownerWaitOnly: true, deviceId: owner.id }),
    ]);
  });

  it.each(["restricted", "full"] as const)(
    "takes the Codex native policy grant from the %s device on send and session actions",
    async (access) => {
      const host = await fixture({ elevatedCodexPolicy: true });
      const device = await host.device(access);
      const restricted = access === "restricted";
      const spoofed = {
        restrictCodexNativePolicy: !restricted,
        host: { restrictCodexNativePolicy: !restricted },
      };
      for (const [operation, path] of [
        ["send", "/send"],
        ["compact", "/managed/action"],
      ] as const) {
        const response = await device.control(providers[0], "allowed", operation, path, spoofed);
        expect(response).toMatchObject(
          restricted
            ? {
                status: 409,
                body: {
                  error: "native-policy-full-access-required",
                  controlOutcome: "not-dispatched",
                },
              }
            : { status: 200, body: { accepted: true } },
        );
      }
      expect(host.hostDispatches).toHaveLength(2);
      for (const dispatch of host.hostDispatches) {
        if (restricted) expect(dispatch).toHaveProperty("restrictCodexNativePolicy", true);
        else expect(dispatch).not.toHaveProperty("restrictCodexNativePolicy");
        expect(dispatch.request).not.toHaveProperty("restrictCodexNativePolicy");
        expect(dispatch.request).not.toHaveProperty("host");
      }
    },
  );

  it("does not restrict Codex native policy for the trusted desktop sender", async () => {
    const host = await fixture({ elevatedCodexPolicy: true });
    const { body } = await host.service.localRequest("/access");
    expect(
      await host.service.localRequest("/send", {
        bootId: (body as ResponseBody).bootId,
        expectedRevision: 4,
        requestId: randomUUID(),
        sessionId: "codex:allowed",
        text: "A local fixture message",
      }),
    ).toMatchObject({ status: 200, body: { accepted: true } });
    expect(host.hostDispatches).toHaveLength(1);
    expect(host.hostDispatches[0]).not.toHaveProperty("restrictCodexNativePolicy");
  });
});
