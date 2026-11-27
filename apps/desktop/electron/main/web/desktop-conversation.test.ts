// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { sessionProviderCapabilities } from "@agentkib/runtime-protocol";
import { RuntimeRequestError } from "../runtime-host";
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

  it("reads Claude live state during a pending send without admitting another send", async () => {
    await service.shutdown();
    let notifyDispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      notifyDispatch = resolve;
    });
    let finishSend!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const send = vi.fn(async () => {
      notifyDispatch();
      await pending;
      return { accepted: true };
    });
    runtime.mockImplementation(async (params) => {
      const { operation, sessionId } = params as { operation: string; sessionId?: string };
      if (operation === "send") return send();
      if (operation === "catalog-scope")
        return {
          handled: true,
          session: sessionId === "s" ? { id: "s", workspace_id: "w", agent: "claude-code" } : null,
        };
      if (operation === "live")
        return {
          sessionId: "s",
          workspaceId: "w",
          executionMode: "claude-managed",
          runtimeBootId: "r",
          revision: 4,
          status: "idle",
          sendEnabled: true,
        };
      return defaultRuntime(params);
    });
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      verifiedClaudeManaged: true,
      supportsCatalogScope: true,
      desktopOrigin: "app://bundle",
      workspaceRequest: async () => [{ id: "w", name: "Workspace", path: directory }],
    });
    await service.initialize();
    const access = await service.localRequest("/access");
    const body = {
      sessionId: "s",
      text: "hello",
      requestId: randomUUID(),
      expectedRevision: 4,
      bootId: (access.body as { bootId: string }).bootId,
    };
    const sending = service.localRequest("/send", body);
    try {
      expect(await Promise.race([dispatched.then(() => "dispatched"), sending])).toBe("dispatched");
      expect(await service.localRequest("/live?sessionId=s")).toMatchObject({
        status: 200,
        body: { sessionId: "s", revision: 4, sendEnabled: false },
      });
      expect(await service.localRequest("/live?sessionId=unknown")).toMatchObject({
        status: 403,
        body: { error: "workspace_not_authorized" },
      });
      expect(
        await service.localRequest("/send", { ...body, requestId: randomUUID() }),
      ).toMatchObject({
        status: 409,
        body: { error: "operation_busy", controlOutcome: "not-dispatched" },
      });
    } finally {
      finishSend();
      await sending;
    }
    expect(await sending).toMatchObject({ status: 200, body: { accepted: true } });
    expect(send).toHaveBeenCalledOnce();
    expect(runtime).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "catalog" }));
  });

  it("serves a verified desktop history page without reading the directory", async () => {
    const page = { events: [{ id: "message" }], next_cursor: "older", warnings: [] };
    runtime.mockResolvedValueOnce({ handled: true, page });
    expect(await service.localRequest("/events?sessionId=s&limit=25&cursor=before")).toEqual({
      status: 200,
      body: page,
    });
    expect(runtime).toHaveBeenCalledExactlyOnceWith({
      operation: "desktop-events",
      sessionId: "s",
      limit: 25,
      cursor: "before",
    });
  });

  it("forwards child history reads through the desktop route only for an authorized parent", async () => {
    const childId = "c".repeat(64);
    const page = {
      version: 1,
      sessionId: "s",
      subagentId: childId,
      epoch: "child-epoch",
      events: [
        {
          id: "child-message",
          kind: "agent-message",
          content: "Synthetic child reply",
          attachment_count: 0,
          truncated: false,
        },
      ],
      next_cursor: "older",
      warnings: [],
    };
    runtime.mockImplementation(async (params) =>
      (params as { operation: string }).operation === "subagent-events"
        ? page
        : defaultRuntime(params),
    );

    const route = `/subagent/events?sessionId=s&subagentId=${childId}&limit=25&cursor=before`;
    expect(await service.localRequest(route)).toEqual({ status: 200, body: page });
    expect(await service.localRequest(route, {})).toMatchObject({
      status: 404,
      body: { error: "not_found", controlOutcome: "not-dispatched" },
    });
    workspaceRegistered = false;
    expect(await service.localRequest(route)).toMatchObject({
      status: 403,
      body: { error: "workspace_not_authorized" },
    });
    expect(
      runtime.mock.calls.filter(
        ([input]) => (input as { operation: string }).operation === "subagent-events",
      ),
    ).toEqual([
      [
        {
          operation: "subagent-events",
          sessionId: "s",
          subagentId: childId,
          limit: 25,
          cursor: "before",
        },
      ],
    ]);
  });

  it("retains catalog authorization when a history page cannot use the targeted route", async () => {
    workspaceRegistered = false;
    runtime.mockResolvedValueOnce({ handled: false });
    expect(await service.localRequest("/events?sessionId=s")).toMatchObject({
      status: 403,
      body: { error: "workspace_not_authorized" },
    });
    expect(runtime.mock.calls.map(([input]) => (input as { operation: string }).operation)).toEqual(
      ["desktop-events", "catalog"],
    );
  });

  it("drops a targeted history response from a replaced runtime", async () => {
    runtime.mockImplementationOnce(async () => {
      service.runtimeUnavailable();
      return { handled: true, page: { events: [{ id: "late" }] } };
    });
    expect(await service.localRequest("/events?sessionId=s")).toMatchObject({
      status: 409,
      body: { error: "stale_boot" },
    });
  });

  it("projects a stale cursor from the targeted desktop history route", async () => {
    runtime.mockRejectedValueOnce(
      new RuntimeRequestError({
        code: -32000,
        message: "request rejected",
        data: { detail: "TRANSCRIPT_CURSOR_STALE" },
      }),
    );
    expect(await service.localRequest("/events?sessionId=s&cursor=old-source")).toMatchObject({
      status: 409,
      body: { error: "stale_cursor" },
    });
    expect(runtime).toHaveBeenCalledExactlyOnceWith({
      operation: "desktop-events",
      sessionId: "s",
      limit: 50,
      cursor: "old-source",
    });
  });

  it.each(["compact", "terminals-clean", "delete"])(
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
        await service.localRequest("/managed/action", {
          agent: "codex",
          operation,
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

  it("isolates Claude settings preparation to its session and releases it after failure", async () => {
    await service.shutdown();
    const options = {
      available: true,
      revision: 4,
      current: {},
      defaults: {},
      writable: {},
      models: [{ id: "fixture-model", efforts: [] }],
    };
    let rejectPreparation: ((error: Error) => void) | undefined;
    const prepare = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            rejectPreparation = reject;
          }),
      )
      .mockResolvedValue(options);
    runtime.mockImplementation(async (params) => {
      const operation = (params as { operation: string }).operation;
      if (operation === "capabilities")
        return { executionMode: "claude-managed", features: { settings: { available: true } } };
      const result = (await defaultRuntime(params)) as Record<string, unknown>;
      if (operation === "catalog")
        return {
          ...result,
          sessions: [
            { id: "s", workspace_id: "w", agent: "claude-code" },
            { id: "other", workspace_id: "w", agent: "claude-code" },
          ],
        };
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
    const preparing = service.localRequest("/managed/settings-prepare", body);
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(await service.localRequest("/managed/settings-prepare", body)).toMatchObject({
        status: 409,
        body: { error: "operation_busy" },
      });
      expect(await service.localRequest("/live?sessionId=other")).toMatchObject({ status: 200 });
      expect(
        await service.localRequest("/managed/settings-prepare", { ...body, sessionId: "other" }),
      ).toMatchObject({ status: 200 });
    } finally {
      rejectPreparation?.(new Error("offline initialize failure"));
      expect((await preparing).status).not.toBe(200);
    }
    expect(await service.localRequest("/managed/settings-prepare", body)).toMatchObject({
      status: 200,
      body: { sessionId: "s", options: { models: [{ id: "fixture-model" }] } },
    });
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls[2][0]).toMatchObject({
      operation: "settings-prepare",
      sessionId: "s",
      runtimeBootId: "r",
      expectedRevision: 4,
      experimentalEnabled: true,
    });
    expect(prepare.mock.calls[2][0]).not.toHaveProperty("requestId");
  });

  it("scopes Claude's startup catalog to a registered workspace and forwards the launch selection", async () => {
    await service.shutdown();
    const models = [{ id: "fixture-model", resolvedModel: "fixture-model-v2", efforts: ["high"] }];
    const provider = sessionProviderCapabilities("claude-code");
    const claude = vi.fn(async (input: unknown) => {
      const { operation, workspaceId } = input as Record<string, unknown>;
      return operation === "provider-create"
        ? { accepted: true, sessionId: "new-claude" }
        : { available: true, provider, models: workspaceId === "w" ? models : [] };
    });
    const legacy = vi.fn(async () => ({ available: false }));
    const receipt = vi.fn(async ({ requestId }: { requestId: string }) => ({
      found: false,
      requestId,
    }));
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      claudeManagedRequest: legacy,
      sessionProviderRequest: claude,
      receiptRequest: receipt,
      verifiedClaudeManaged: true,
      desktopOrigin: "app://bundle",
      workspaceRequest: async () =>
        workspaceRegistered ? [{ id: "w", name: "Workspace", path: directory }] : [],
    });
    await service.initialize();

    const options = "/managed/options?agent=claude-code";
    expect(await service.localRequest(`${options}&workspaceId=outside`)).toMatchObject({
      status: 403,
    });
    expect(claude).not.toHaveBeenCalled();
    expect(await service.localRequest(options)).toMatchObject({
      status: 200,
      body: { models: [] },
    });
    expect(await service.localRequest(`${options}&workspaceId=w`)).toMatchObject({
      status: 200,
      body: { models, provider },
    });
    const access = await service.localRequest("/access");
    const requestId = randomUUID();
    const create = {
      agent: "claude-code",
      workspaceId: "w",
      requestId,
      bootId: (access.body as { bootId: string }).bootId,
      model: "fixture-model",
      effort: "high",
      permissionMode: "plan",
      verifyStartupModel: true,
    };
    expect(
      await service.localRequest("/managed/create", { ...create, verifyStartupModel: false }),
    ).toMatchObject({ status: 400, body: { error: "invalid_input" } });
    expect(
      await service.localRequest("/managed/create", {
        ...create,
        permissionMode: "bypassPermissions",
      }),
    ).toMatchObject({ status: 400, body: { error: "unsupported_permission_mode" } });
    expect(
      await service.localRequest("/managed/create", { ...create, prompt: "send after creating" }),
    ).toMatchObject({ status: 200, body: { accepted: true, sessionId: "new-claude" } });
    expect(claude.mock.calls.map(([input]) => input)).toEqual([
      { operation: "provider-options", agent: "claude-code" },
      { operation: "provider-options", agent: "claude-code", workspaceId: "w" },
      expect.objectContaining({
        operation: "provider-create",
        agent: "claude-code",
        workspaceId: "w",
        model: "fixture-model",
        effort: "high",
        permissionMode: "plan",
        verifyStartupModel: true,
      }),
    ]);
    expect(claude.mock.calls[2][0]).not.toHaveProperty("prompt");
    expect(legacy).not.toHaveBeenCalled();
    const retryId = randomUUID();
    claude.mockRejectedValueOnce(new RuntimeRequestError({ code: -32000, message: "web-busy" }));
    expect(
      await service.localRequest("/managed/create", { ...create, requestId: retryId }),
    ).toMatchObject({ status: 409, body: { error: "web-busy", controlOutcome: "not-dispatched" } });
    expect(receipt.mock.calls.filter(([entry]) => entry.requestId === retryId)).toHaveLength(2);
    claude.mockImplementationOnce(async () => {
      workspaceRegistered = false;
      return { available: true, provider, models };
    });
    expect(await service.localRequest(`${options}&workspaceId=w`)).toMatchObject({ status: 403 });
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

  it("browses and revalidates draft workspace references before sending", async () => {
    await mkdir(join(directory, "notes"));
    const file = join(directory, "notes", "topic.md");
    await writeFile(file, "topic");
    runtime.mockImplementation(async (params) => {
      const input = params as { operation: string };
      if (input.operation === "resources") return { revision: 4 };
      if (input.operation === "capabilities")
        return { features: { resources: { available: true } } };
      return defaultRuntime(params);
    });
    const path = "/managed/resources?workspaceId=w&agent=codex";
    const root = await service.localRequest(path);
    expect(root).toMatchObject({ status: 200, body: { workspaceId: "w" } });
    expect(root.body).not.toHaveProperty("sessionId");
    expect(runtime).toHaveBeenCalledExactlyOnceWith({
      operation: "provider-workspace-resources",
      workspaceId: "w",
      agent: "codex",
    });
    type Listing = { resources: Array<{ id: string; name: string; navigationId?: string }> };
    const notes = (root.body as Listing).resources.find((row) => row.name === "notes")!;
    const folder = await service.localRequest(`${path}&directoryId=${notes.navigationId}`);
    const topic = (folder.body as Listing).resources.find((row) => row.name === "topic.md")!;
    expect(topic.id).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await service.localRequest(
        path.replace("agent=codex", "agent=claude-code") + `&directoryId=${notes.navigationId}`,
      ),
    ).toMatchObject({ status: 404 });
    expect(
      await service.localRequest(path.replace("workspaceId=w", "workspaceId=outside")),
    ).toMatchObject({ status: 403 });

    const access = await service.localRequest("/access");
    const send = (resourceId: string) =>
      service.localRequest("/send", {
        sessionId: "s",
        text: "Read the notes",
        requestId: randomUUID(),
        expectedRevision: 4,
        bootId: (access.body as { bootId: string }).bootId,
        resourceIds: [resourceId],
      });
    await writeFile(file, "new longer topic");
    expect(await send(topic.id)).toMatchObject({
      status: 409,
      body: { error: "artifact_changed" },
    });
    expect(
      runtime.mock.calls.some(([params]) => (params as { operation: string }).operation === "send"),
    ).toBe(false);
    const refreshed = await service.localRequest(`${path}&directoryId=${notes.navigationId}`);
    const currentTopic = (refreshed.body as Listing).resources.find(
      (row) => row.name === "topic.md",
    )!;
    expect(await send(currentTopic.id)).toMatchObject({ status: 200, body: { accepted: true } });
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send",
        sessionId: "s",
        resourceRefs: [{ kind: "file", relativePath: "notes/topic.md" }],
      }),
    );
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

  it.each(["create", "release", "reconcile"])(
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
        ...(operation === "create" ? { workspaceId: "w" } : { sessionId: "s" }),
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
