// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

/** The Host side of a connected DeepSeek Harness: which session operations reach the runtime. */
describe("DeepSeek Harness host control boundary", () => {
  let directory: string;
  let service: WebAccessService;
  let features: Record<string, { available: boolean; reason?: string }>;
  const runtime = vi.fn<(value: unknown) => Promise<unknown>>();
  const models = [
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", efforts: ["low", "high"] },
    { id: "mock%2Flocal/m-1", name: "Mock One", efforts: [] },
  ];

  beforeEach(async () => {
    runtime.mockReset();
    features = {
      rename: { available: true },
      archive: { available: true },
      unarchive: { available: false, reason: "operation-unavailable" },
      fork: { available: true },
      settings: { available: true },
      delete: { available: true },
    };
    directory = await mkdtemp(join(tmpdir(), "agentkib-dsh-host-"));
    await mkdir(join(directory, "workspace"));
    runtime.mockImplementation(async (value) => {
      const params = value as Record<string, unknown>;
      switch (params.operation) {
        case "catalog":
          return {
            sessions: [{ id: "dsh-session", workspace_id: "workspace", agent: "deepseek-harness" }],
            workspaces: [],
          };
        case "live":
          return {
            executionMode: "dsh-follower",
            workspaceId: "workspace",
            runtimeBootId: "runtime-one",
            revision: 4,
            status: "idle",
            sendEnabled: true,
          };
        case "capabilities":
          return { executionMode: "dsh-follower", features };
        case "settings-state":
          return {
            available: true,
            executionMode: "dsh-follower",
            revision: 4,
            current: { model: "deepseek/deepseek-chat", effort: "low" },
            selected: { model: "deepseek/deepseek-chat", effort: "low" },
            defaults: { model: "deepseek/deepseek-chat", effort: null },
            models,
            writable: { model: { available: true }, effort: { available: true } },
          };
        case "usage":
          return { available: false, state: "unavailable", reason: "usage-unavailable" };
        case "dsh-options":
          return params.includeModels === true
            ? {
                available: true,
                models: models.map((model) => ({ ...model, group: "Native provider" })),
                defaults: { model: "deepseek/deepseek-chat", effort: "low" },
              }
            : { available: true };
        case "dsh-create":
          return {
            accepted: true,
            completed: true,
            requestId: params.requestId,
            controlOutcome: "accepted",
            sessionId: "dsh-new",
          };
        default:
          return {
            accepted: true,
            completed: false,
            requestId: params.requestId,
            controlOutcome: "accepted",
            runtimeBootId: "runtime-one",
          };
      }
    });
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      desktopOrigin: "app://bundle",
      runtimeRequest: runtime,
      workspaceRequest: async () => [
        { id: "workspace", name: "Synthetic workspace", path: join(directory, "workspace") },
      ],
      verifiedDshFollower: true,
    });
    await service.initialize();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  async function action(operation: string, fields: Record<string, unknown> = {}) {
    const desktop = await service.localRequest("/access");
    return service.localRequest("/managed/action", {
      operation,
      agent: "deepseek-harness",
      bootId: (desktop.body as { bootId: string }).bootId,
      sessionId: "dsh-session",
      requestId: randomUUID(),
      expectedRevision: 4,
      ...fields,
    });
  }
  const forwarded = (operation: string) =>
    runtime.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => value.operation === operation);

  it("forwards rename, archive and fork, and nothing DSH does not take", async () => {
    expect(await action("rename", { name: "Renamed" })).toMatchObject({ status: 200 });
    expect(forwarded("rename")).toEqual([
      expect.objectContaining({ sessionId: "dsh-session", name: "Renamed" }),
    ]);
    expect(await action("archive")).toMatchObject({ status: 200 });
    expect(forwarded("archive")).toHaveLength(1);
    expect(await action("fork")).toMatchObject({ status: 200 });
    expect(forwarded("fork")).toHaveLength(1);
    // The capability decides; an unavailable one never reaches the runtime.
    expect(await action("unarchive")).toMatchObject({
      status: 409,
      body: { controlOutcome: "not-dispatched" },
    });
    expect(forwarded("unarchive")).toEqual([]);
    // Delete is not a DSH operation even when a capability claims it.
    expect(await action("delete")).toMatchObject({
      status: 409,
      body: { controlOutcome: "not-dispatched" },
    });
    expect(forwarded("delete")).toEqual([]);
  });

  it("reads DSH's models and forwards a model or effort from the list only", async () => {
    const settings = await service.localRequest("/managed/settings?sessionId=dsh-session");
    expect(settings).toMatchObject({
      status: 200,
      body: {
        available: true,
        executionMode: "dsh-follower",
        current: { modelId: "deepseek/deepseek-chat", effort: "low" },
        options: {
          models: [
            expect.objectContaining({ id: "deepseek/deepseek-chat", efforts: ["low", "high"] }),
            expect.objectContaining({ id: "mock%2Flocal/m-1", efforts: [] }),
          ],
        },
      },
    });
    expect(await action("settings", { model: "mock%2Flocal/m-1" })).toMatchObject({
      status: 200,
    });
    expect(await action("settings", { effort: "high" })).toMatchObject({ status: 200 });
    expect(forwarded("settings")).toEqual([
      expect.objectContaining({ model: "mock%2Flocal/m-1" }),
      expect.objectContaining({ effort: "high" }),
    ]);
    expect(await action("settings", { model: "nobody/none" })).toMatchObject({
      status: 400,
      body: { error: "unsupported_model" },
    });
    expect(await action("settings", { effort: "extreme" })).toMatchObject({
      status: 400,
      body: { error: "unsupported_effort" },
    });
    for (const fields of [{ effort: null }, { serviceTierId: null }])
      expect(await action("settings", fields)).toMatchObject({ status: 400 });
    expect(forwarded("settings")).toHaveLength(2);
    // With a default model reported, restoring defaults reaches the runtime as a reset.
    expect(await action("settings", { restoreDefaults: true })).toMatchObject({ status: 200 });
    expect(forwarded("settings").at(-1)).toMatchObject({ resetDefaults: true });
  });

  it("loads DSH's workspace-scoped start options and forwards model choices with the preset", async () => {
    expect(await service.localRequest("/managed/options?agent=deepseek-harness")).toMatchObject({
      status: 200,
      body: { available: true, workspaces: [{ id: "workspace", name: "Synthetic workspace" }] },
    });
    expect(
      await service.localRequest("/managed/options?agent=deepseek-harness&workspaceId=outside"),
    ).toMatchObject({ status: 403, body: { error: "workspace_not_authorized" } });
    expect(
      await service.localRequest("/managed/options?agent=deepseek-harness&workspaceId=workspace"),
    ).toMatchObject({
      status: 200,
      body: {
        defaults: { model: "deepseek/deepseek-chat", effort: "low" },
        models: [
          expect.objectContaining({ id: "deepseek/deepseek-chat", group: "Native provider" }),
          expect.objectContaining({ id: "mock%2Flocal/m-1", efforts: [] }),
        ],
      },
    });
    expect(forwarded("dsh-options")).toEqual([
      { operation: "dsh-options" },
      { operation: "dsh-options", includeModels: true },
    ]);
    const desktop = await service.localRequest("/access");
    const bootId = (desktop.body as { bootId: string }).bootId;
    expect(
      await service.localRequest("/managed/create", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        workspaceId: "workspace",
      }),
    ).toMatchObject({ status: 200, body: { accepted: true, sessionId: "dsh-new" } });
    expect(
      await service.localRequest("/managed/create", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        workspaceId: "workspace",
        agentPreset: "ptc",
        model: "deepseek/deepseek-chat",
        effort: "high",
      }),
    ).toMatchObject({ status: 200, body: { accepted: true, sessionId: "dsh-new" } });
    expect(
      await service.localRequest("/managed/create", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        workspaceId: "workspace",
        model: "\n",
        effort: "high",
      }),
    ).toMatchObject({ status: 400, body: { controlOutcome: "not-dispatched" } });
    const creates = forwarded("dsh-create");
    expect(creates).toHaveLength(2);
    expect(creates[0]).not.toHaveProperty("agentPreset");
    expect(creates[0]).not.toHaveProperty("model");
    expect(creates[0]).not.toHaveProperty("effort");
    expect(creates[1]).toMatchObject({
      workspaceId: "workspace",
      agentPreset: "ptc",
      model: "deepseek/deepseek-chat",
      effort: "high",
    });
    // Adopting or releasing is not how a DSH session is taken over.
    expect(
      await service.localRequest("/managed/adopt", {
        agent: "deepseek-harness",
        bootId,
        requestId: randomUUID(),
        sessionId: "dsh-session",
      }),
    ).toMatchObject({ status: 404 });
  });

  it("hands DSH an uploaded image as a checked file in DSH's own form", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=",
      "base64",
    );
    features.send = { available: true };
    features.attachments = { available: true };
    const upload = await service.localRequest(
      "/attachments?sessionId=dsh-session&name=one.png&mime=image%2Fpng",
      undefined,
      png,
    );
    expect(upload).toMatchObject({ status: 201 });
    const { id, version } = upload.body as { id: string; version: string };
    const desktop = await service.localRequest("/access");
    const sent = await service.localRequest("/send", {
      sessionId: "dsh-session",
      requestId: randomUUID(),
      bootId: (desktop.body as { bootId: string }).bootId,
      expectedRevision: 4,
      text: "look",
      attachmentIds: [id],
    });
    expect(sent).toMatchObject({ status: 200 });
    const [send] = forwarded("send");
    expect(send).toMatchObject({
      input: [
        { type: "text", text: "look" },
        {
          type: "image",
          path: expect.stringContaining(id),
          sha256: version,
          size: png.length,
          mediaType: "image/png",
          name: "one.png",
        },
      ],
    });
    expect(send).not.toHaveProperty("text");
  });

  it("forwards goal changes and compaction, and shows a goal bounded by rounds", async () => {
    Object.assign(features, {
      goal: { available: true },
      "goal-set": { available: true },
      "goal-pause": { available: true },
      compact: { available: true },
    });
    const read = runtime.getMockImplementation()!;
    runtime.mockImplementation(async (value) =>
      (value as { operation?: string }).operation === "goal"
        ? {
            available: true,
            revision: 4,
            budget: "rounds",
            goal: {
              objective: "Ship it",
              status: "blocked",
              rounds: { used: 3, limit: 256 },
              detail: "Which branch?",
              internal: "hidden",
            },
            actions: {
              set: { available: true },
              pause: { available: false, reason: "goal-action-unavailable" },
              resume: { available: true },
              clear: { available: true },
            },
          }
        : read(value),
    );
    expect(
      await service.localRequest("/managed/goals?sessionId=dsh-session&agent=deepseek-harness"),
    ).toMatchObject({
      status: 200,
      body: {
        available: true,
        budget: "rounds",
        goal: {
          objective: "Ship it",
          status: "blocked",
          rounds: { used: 3, limit: 256 },
          detail: "Which branch?",
        },
        actions: { pause: { available: false, reason: "goal-action-unavailable" } },
      },
    });
    expect(await action("goal-set", { objective: "Ship it", intent: "start" })).toMatchObject({
      status: 200,
    });
    expect(forwarded("goal-set")).toEqual([
      expect.objectContaining({ goal: { objective: "Ship it", intent: "start" } }),
    ]);
    expect(await action("goal-pause")).toMatchObject({ status: 200 });
    expect(await action("compact")).toMatchObject({ status: 200 });
    expect(forwarded("compact")).toHaveLength(1);
    // A capability the runtime does not offer is not forwarded.
    expect(await action("goal-clear")).toMatchObject({ status: 409 });
    expect(forwarded("goal-clear")).toEqual([]);
  });
});

/**
 * DSH runs a message naming one of its commands as that command; those that change a session's
 * preset or goal need what those controls need, which only the Host knows.
 */
describe("DeepSeek Harness slash commands from another device", () => {
  let service: WebAccessService;
  let directory: string;
  let origin: string;
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as Record<string, unknown>;
    switch (params.operation) {
      case "catalog":
        return {
          sessions: [{ id: "dsh-session", workspace_id: "workspace", agent: "deepseek-harness" }],
        };
      case "live":
        return {
          sessionId: "dsh-session",
          workspaceId: "workspace",
          executionMode: "dsh-follower",
          runtimeBootId: "runtime-one",
          revision: 4,
          status: "idle",
          sendEnabled: true,
          approvals: [],
        };
      case "capabilities":
        return {
          sessionId: "dsh-session",
          executionMode: "dsh-follower",
          features: { send: { available: true } },
        };
      default:
        return {
          accepted: true,
          requestId: params.requestId,
          controlOutcome: "accepted",
          runtimeBootId: "runtime-one",
        };
    }
  });

  async function browser() {
    let cookie = "";
    let csrf = "";
    let bootId = "";
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${origin}/api/web/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined
            ? {}
            : {
                Origin: origin,
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf,
                "X-AgentKib-Protocol": "2",
              }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      cookie ||= response.headers.get("set-cookie")?.split(";")[0] ?? "";
      const data = await response.json();
      csrf ||= data.csrfToken ?? "";
      bootId ||= data.bootId ?? "";
      return { response, data };
    };
    await api("access");
    const send = (text: string) =>
      api("send", {
        sessionId: "dsh-session",
        requestId: randomUUID(),
        bootId,
        expectedRevision: 4,
        text,
      });
    return { api, send, cookie: () => cookie };
  }

  beforeEach(async () => {
    runtime.mockClear();
    directory = await mkdtemp(join(tmpdir(), "agentkib-dsh-commands-"));
    await mkdir(join(directory, "workspace"));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      workspaceRequest: async () => [
        { id: "workspace", name: "Workspace", path: join(directory, "workspace") },
      ],
      verifiedDshFollower: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["workspace"],
    });
  });
  afterEach(async () => {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const sent = () =>
    runtime.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => value.operation === "send")
      .map((value) => [value.text, value.commandAccess]);

  it("tells DSH whether the device may run the commands that need full access", async () => {
    const limited = await browser();
    await approveLegacyBrowser(service, limited.cookie(), { send: true });
    expect((await limited.send("/goal ship it")).response.status).toBe(200);
    const full = await browser();
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    expect((await full.api("pair", { code, name: "Phone" })).response.status).toBe(200);
    expect((await full.send("/goal ship it")).response.status).toBe(200);
    // DSH decides with the session's own registry and refuses `/goal` for the first device.
    expect(sent()).toEqual([
      ["/goal ship it", "session"],
      ["/goal ship it", "all"],
    ]);
  });
});
