// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { WebAccessService, createWebControlState } from "./service";

describe("trusted desktop conversation routes", () => {
  let directory: string;
  let service: WebAccessService;
  let workspaceRegistered: boolean;
  const managed = vi.fn(async (_params: unknown): Promise<unknown> => ({ accepted: true }));
  const runtime = vi.fn(async (params: unknown): Promise<unknown> => {
    const input = params as { operation: string };
    if (input.operation === "catalog")
      return {
        workspaces: [{ id: "w", name: "Workspace" }],
        sessions: [{ id: "s", workspace_id: "w", agent: "codex" }],
      };
    if (input.operation === "live")
      return {
        sessionId: "s",
        workspaceId: "w",
        executionMode: "codex-managed",
        runtimeBootId: "r",
        revision: 4,
        status: "idle",
        sendEnabled: true,
        approvals: [],
        questions: [],
      };
    return { accepted: true };
  });
  const defaultRuntime = runtime.getMockImplementation()!;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "agentkib-desktop-conversation-"));
    workspaceRegistered = true;
    runtime.mockReset().mockImplementation(defaultRuntime);
    managed.mockReset().mockResolvedValue({ accepted: true });
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      managedRequest: managed,
      verifiedCodex: true,
      sharedControl: createWebControlState(),
      desktopOrigin: "app://bundle",
      workspaceRequest: async () =>
        workspaceRegistered ? [{ id: "w", name: "Workspace", path: directory }] : [],
    });
    await service.initialize();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("reads and sends with Remote disabled without pairing or arbitrary RPC", async () => {
    expect((await service.request({ operation: "status" })).running).toBe(false);
    const access = await service.localRequest("/access");
    expect(access).toMatchObject({ status: 200, body: { status: "approved", protocolVersion: 2 } });
    const bootId = (access.body as { bootId: string }).bootId;
    expect(
      await service.localRequest("/send", {
        sessionId: "s",
        text: "hello",
        requestId: "request",
        expectedRevision: 4,
        bootId,
      }),
    ).toMatchObject({ status: 200, body: { accepted: true } });
    expect(await service.localRequest("/rpc", { method: "delete" })).toMatchObject({
      status: 404,
      body: { controlOutcome: "not-dispatched" },
    });
    expect(await service.localRequest("//external.test/events")).toMatchObject({ status: 404 });
    expect(await service.localRequest("/pair", {})).toMatchObject({ status: 404 });
  });

  it.each(["compact", "terminals-clean"])(
    "sends the Codex %s action over the desktop route",
    async (operation) => {
      runtime.mockImplementation(async (params: unknown) =>
        (params as { operation: string }).operation === "capabilities"
          ? {
              sessionId: "s",
              executionMode: "codex-managed",
              features: { [operation]: { available: true } },
            }
          : defaultRuntime(params),
      );
      const access = await service.localRequest("/access");
      expect(
        await service.localRequest(`/codex/${operation}`, {
          sessionId: "s",
          bootId: (access.body as { bootId: string }).bootId,
          expectedRevision: 4,
          requestId: randomUUID(),
        }),
      ).toMatchObject({ status: 200, body: { accepted: true } });
      expect(
        runtime.mock.calls.some(
          ([params]) => (params as { operation: string }).operation === operation,
        ),
      ).toBe(true);
    },
  );

  it("prepares Claude settings over the closed desktop route without fencing later preparation on failure", async () => {
    await service.shutdown();
    const options = {
      available: true,
      revision: 4,
      current: {},
      defaults: {},
      writable: {},
      models: [{ id: "fixture-model", efforts: [] }],
    };
    const prepare = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline initialize failure"))
      .mockResolvedValue(options);
    runtime.mockImplementation(async (params) => {
      const operation = (params as { operation: string }).operation;
      if (operation === "capabilities")
        return { executionMode: "claude-managed", features: { settings: { available: true } } };
      const result = (await defaultRuntime(params)) as Record<string, unknown>;
      if (operation === "catalog")
        return { ...result, sessions: [{ id: "s", workspace_id: "w", agent: "claude-code" }] };
      return result;
    });
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      claudeManagedRequest: prepare,
      verifiedClaudeManaged: true,
      sharedControl: createWebControlState(),
      desktopOrigin: "app://bundle",
      workspaceRequest: async () => [{ id: "w", name: "Workspace", path: directory }],
    });
    await service.initialize();
    const access = await service.localRequest("/access");
    const body = {
      sessionId: "s",
      bootId: (access.body as { bootId: string }).bootId,
      expectedRevision: 4,
    };
    expect((await service.localRequest("/managed/settings-prepare", body)).status).not.toBe(200);
    expect(await service.localRequest("/managed/settings-prepare", body)).toMatchObject({
      status: 200,
      body: { sessionId: "s", options: { models: [{ id: "fixture-model" }] } },
    });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1][0]).toMatchObject({
      operation: "settings-prepare",
      sessionId: "s",
      runtimeBootId: "r",
      expectedRevision: 4,
      experimentalEnabled: true,
    });
    expect(prepare.mock.calls[1][0]).not.toHaveProperty("requestId");
  });

  it("retains duplicate-command protection and detailed unknown outcomes", async () => {
    const access = await service.localRequest("/access");
    const body = {
      sessionId: "s",
      text: "hello",
      requestId: "request",
      expectedRevision: 4,
      bootId: (access.body as { bootId: string }).bootId,
    };
    await service.localRequest("/send", body);
    expect(await service.localRequest("/send", body)).toMatchObject({
      status: 409,
      body: { error: "duplicate_request", controlOutcome: "unknown" },
    });
    expect(
      runtime.mock.calls.filter(([input]) => (input as { operation: string }).operation === "send"),
    ).toHaveLength(1);
  });

  it("projects native context independently of settings and cumulative consumption", async () => {
    runtime.mockImplementation(async (params) => {
      const result = await defaultRuntime(params);
      if ((params as { operation: string }).operation !== "live") return result;
      return {
        ...(result as Record<string, unknown>),
        tokenUsage: {
          last: { totalTokens: 0 },
          total: { totalTokens: 12000 },
          modelContextWindow: 48000,
        },
      };
    });
    const live = await service.localRequest("/live?sessionId=s");
    expect(live).toMatchObject({
      status: 200,
      body: { usage: { available: true, state: "ready", usedTokens: 0, percent: 0 } },
    });
    expect(live.body).not.toHaveProperty("tokenUsage");
    expect(
      runtime.mock.calls.some(
        ([input]) => (input as { operation: string }).operation === "settings-state",
      ),
    ).toBe(false);
  });

  it("rejects compaction before sending and keeps the latest report pending", async () => {
    runtime.mockImplementation(async (params) => {
      const result = await defaultRuntime(params);
      return (params as { operation: string }).operation === "live"
        ? {
            ...(result as Record<string, unknown>),
            activity: "compacting",
            usage: {
              available: true,
              state: "ready",
              usedTokens: 100,
              contextWindow: 1000,
              reportGeneration: 2,
              reportId: 3,
            },
          }
        : result;
    });
    const live = await service.localRequest("/live?sessionId=s");
    expect(live.body).toMatchObject({
      activity: "compacting",
      usage: { state: "pending", reportGeneration: 2, reportId: 3 },
    });
    expect((live.body as { usage: unknown }).usage).not.toHaveProperty("percent");
    const access = await service.localRequest("/access");
    expect(
      await service.localRequest("/send", {
        sessionId: "s",
        text: "hello",
        requestId: "compacting",
        expectedRevision: 4,
        bootId: (access.body as { bootId: string }).bootId,
      }),
    ).toMatchObject({
      status: 409,
      body: { error: "session-compacting", controlOutcome: "not-dispatched" },
    });
    expect(
      runtime.mock.calls.some(([input]) => (input as { operation: string }).operation === "send"),
    ).toBe(false);
  });

  it("keeps a final compaction rejection definitive and releases the unknown fence", async () => {
    runtime.mockImplementation(async (params) => {
      const input = params as { operation: string; requestId: string };
      if (input.operation === "send")
        return {
          accepted: false,
          completed: false,
          controlOutcome: "not-dispatched",
          reason: "session-compacting",
          requestId: input.requestId,
          runtimeBootId: "r",
        };
      return defaultRuntime(params);
    });
    const access = await service.localRequest("/access");
    const body = {
      sessionId: "s",
      text: "hello",
      requestId: "late-compaction",
      expectedRevision: 4,
      bootId: (access.body as { bootId: string }).bootId,
    };
    expect(await service.localRequest("/send", body)).toMatchObject({
      status: 409,
      body: { error: "session-compacting", controlOutcome: "not-dispatched" },
    });
    expect(await service.localRequest("/live?sessionId=s")).toMatchObject({
      status: 200,
      body: { status: "idle", sendEnabled: true },
    });
  });

  it("creates scoped file previews for the Electron origin while Web remains disabled", async () => {
    await writeFile(join(directory, "report.html"), "<h1>Report</h1>");
    const files = await service.localRequest("/files/list?workspaceId=w");
    expect(files.status).toBe(200);
    expect((await service.request({ operation: "status" })).running).toBe(false);
  });

  it("keeps desktop preview tickets on a separate loopback listener across relay origin changes", async () => {
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
    });
    await writeFile(join(directory, "report.html"), "<h1>Local report</h1>");
    const files = await service.localRequest("/files/list?workspaceId=w");
    const artifactId = (files.body as { entries: { id: string; name: string }[] }).entries.find(
      (entry) => entry.name === "report.html",
    )!.id;
    const issue = () => service.localRequest("/artifact-tickets", { workspaceId: "w", artifactId });
    const before = await issue();
    const originalUrl = (before.body as { url: string }).url;
    const targets = service.relayTargets();
    expect(new URL(originalUrl).hostname).toBe("127.0.0.1");
    expect(new URL(originalUrl).port).not.toBe(String(targets.preview.port));
    await service.setRelayOrigins("https://control.example", "https://preview.example");
    const after = await issue();
    expect(after.status).toBe(200);
    const nextUrl = (after.body as { url: string }).url;
    expect(new URL(nextUrl).origin).toBe(new URL(originalUrl).origin);
    expect(service.canDownloadDesktopArtifact(nextUrl)).toBe(true);
    for (const url of [originalUrl, nextUrl]) {
      const response = await fetch(url, { headers: { Origin: "app://bundle" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors");
      expect(response.headers.get("content-security-policy")).toContain("app://bundle");
      expect(response.headers.get("content-security-policy")).not.toContain("preview.example");
      expect(await response.text()).toContain("Local report");
    }
    const tunneled = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: targets.preview.port,
          path: new URL(nextUrl).pathname,
          headers: { Host: "preview.example" },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode!));
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(tunneled).toBe(410);
    const denied = await fetch(nextUrl, { headers: { Origin: "https://untrusted.example" } });
    expect(denied.status).toBe(403);
    await denied.arrayBuffer();
    workspaceRegistered = false;
    const revoked = await fetch(nextUrl, { headers: { Origin: "app://bundle" } });
    expect(revoked.status).toBe(403);
    await revoked.arrayBuffer();
  });

  it.each(["create", "adopt", "release", "reconcile"])(
    "notifies receipt observers when %s settles after timeout",
    async (operation) => {
      let finish!: (value: unknown) => void;
      managed.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let expire!: () => void;
      const timeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 20_000) expire = callback;
        return timeout(callback, delay, ...args);
      }) as typeof setTimeout);
      const changed = vi.fn();
      service.onControlChanged(changed);
      const access = await service.localRequest("/access");
      const pending = service.localRequest(`/managed/${operation}`, {
        bootId: (access.body as { bootId: string }).bootId,
        requestId: `late-${operation}`,
        ...(operation === "create"
          ? { workspaceId: "w" }
          : { sessionId: "s", handoffConfirmed: true }),
      });
      await vi.waitFor(() => expect(managed).toHaveBeenCalledOnce());
      expire();
      expect(await pending).toMatchObject({ status: 504, body: { controlOutcome: "unknown" } });
      expect(changed).not.toHaveBeenCalled();
      finish(operation === "reconcile" ? { reconciled: true } : { accepted: true });
      await vi.waitFor(() =>
        expect(changed).toHaveBeenCalledWith(operation === "create" ? "" : "s"),
      );
    },
  );
});
