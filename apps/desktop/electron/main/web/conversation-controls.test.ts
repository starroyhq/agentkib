// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

describe("Codex conversation controls", () => {
  let service: WebAccessService;
  let dataDir: string;
  let workspaceDir: string;
  let origin: string;
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as Record<string, unknown>;
    if (params.operation === "catalog")
      return {
        sessions: [{ id: "session", agent: "codex", workspace_id: "workspace" }],
      };
    if (params.operation === "capabilities")
      return {
        sessionId: "session",
        workspaceId: "workspace",
        executionMode: "codex-managed",
        features: Object.fromEntries(
          [
            "send",
            "settings",
            "goal-set",
            "goal-pause",
            "goal-resume",
            "goal-clear",
            "context",
          ].map((name) => [name, { available: true }]),
        ),
      };
    if (params.operation === "live")
      return {
        sessionId: "session",
        workspaceId: "workspace",
        executionMode: "codex-managed",
        status: "idle",
        revision: 7,
        runtimeBootId: "runtime",
        sendEnabled: true,
        approvals: [],
      };
    if (params.operation === "settings-state")
      return {
        available: true,
        executionMode: "codex-managed",
        status: "idle",
        revision: 7,
        collaborationModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan", native: "must-not-leak" },
          { id: "unsafe", name: "Unsafe" },
        ],
        settings: {
          selected: {
            model: "model-a",
            effort: "medium",
            mode: "plan",
            serviceTier: "standard",
            native: "must-not-leak",
          },
          applicationStatus: "pending",
          current: {
            model: "model-a",
            effort: "high",
            mode: "default",
            serviceTier: "fast",
            policyId: "workspace",
          },
          defaults: { model: "model-a", effort: "medium", serviceTier: "standard" },
          writable: { model: true, effort: true, mode: true, serviceTier: true, policy: true },
        },
        models: [
          {
            id: "model-a",
            name: "Model A",
            efforts: ["medium", "high"],
            defaultEffort: "medium",
            serviceTiers: [
              { id: "standard", name: "Standard" },
              { id: "fast", name: "Fast", description: "Host-provided description" },
            ],
          },
        ],
        policies: [{ id: "workspace", name: "Workspace", native: { unsafe: true } }],
        serviceTiers: [
          { id: "standard", name: "Standard" },
          { id: "fast", name: "Fast", description: "Host-provided description" },
        ],
        native: { rpc: "must-not-leak" },
      };
    if (params.operation === "usage")
      return {
        available: true,
        revision: 7,
        tokenUsage: {
          total: { totalTokens: 12000 },
          last: { totalTokens: 3000 },
          modelContextWindow: 48000,
        },
        updatedAt: "2026-09-27T00:00:00Z",
      };
    if (params.operation === "goal")
      return {
        available: true,
        revision: 7,
        goal: {
          objective: "Finish the safe fixture",
          status: "active",
          tokenBudget: 5000,
          tokensUsed: 100,
          timeUsedSeconds: 2,
          internal: "hidden",
        },
      };
    if (params.operation === "resources")
      return {
        revision: 7,
        skills: [{ id: "skill-safe", name: "Safe skill", path: "/private/skill" }],
        plugins: [{ id: "plugin-safe", name: "Safe plugin" }],
        apps: [{ id: "app-safe", name: "Safe app", available: false, reason: "signed_out" }],
        contextReferences: { supportedTypes: ["computerPath", "skill"] },
      };
    return { accepted: true, requestId: params.requestId };
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
    return {
      api,
      get bootId() {
        return bootId;
      },
      get cookie() {
        return cookie;
      },
    };
  }

  beforeEach(async () => {
    runtime.mockClear();
    dataDir = await mkdtemp(join(tmpdir(), "agentkib-conversation-controls-"));
    workspaceDir = join(dataDir, "workspace");
    await mkdir(join(workspaceDir, "src"), { recursive: true });
    await writeFile(join(workspaceDir, "fixture.txt"), "safe fixture");
    await writeFile(join(workspaceDir, "src", "nested.txt"), "nested fixture");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir,
      staticDir: dataDir,
      runtimeRequest: runtime,
      workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: workspaceDir }],
      verifiedCodex: true,
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
    await rm(dataDir, { recursive: true, force: true });
  });

  async function fullBrowser() {
    const client = await browser();
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    const paired = await client.api("pair", { code, name: "Phone" });
    expect(paired.response.status).toBe(200);
    return client;
  }

  it("projects settings, usage and goals without native objects", async () => {
    const client = await fullBrowser();
    const settings = await client.api("codex/session-settings?sessionId=session");
    expect(settings.data).toMatchObject({
      sessionId: "session",
      revision: 7,
      selected: { modelId: "model-a", effort: "medium", mode: "plan", serviceTierId: "standard" },
      applicationStatus: "pending",
      current: { modelId: "model-a", serviceTierId: "fast", policyId: "workspace" },
      defaults: { modelId: "model-a", effort: "medium", serviceTierId: "standard" },
      usage: { usedTokens: 3000, totalTokens: 12000, contextWindow: 48000, percent: 6.25 },
    });
    expect(settings.data.options.collaborationModes).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
    expect(settings.data.options.models[0].serviceTierIds).toEqual(["standard", "fast"]);
    expect(JSON.stringify(settings.data)).not.toContain("must-not-leak");
    expect(JSON.stringify(settings.data)).not.toContain("unsafe");

    const goals = await client.api("codex/goals?sessionId=session");
    expect(goals.data).toMatchObject({
      available: true,
      revision: 7,
      goal: {
        objective: "Finish the safe fixture",
        status: "active",
        tokenBudget: 5000,
        elapsedMs: 2000,
      },
      actions: { set: { available: true }, resume: { available: true } },
    });
    expect(JSON.stringify(goals.data)).not.toContain("internal");
  });

  it("validates setting ids and dispatches only the public projection", async () => {
    const client = await fullBrowser();
    const result = await client.api("codex/settings", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      model: "model-a",
      effort: "high",
      policyId: "workspace",
      serviceTierId: "fast",
      sandbox: { writableRoots: ["/"] },
      nativeRpc: { method: "danger" },
    });
    expect(result.response.status).toBe(200);
    const dispatched = runtime.mock.calls.find(
      ([value]) => (value as Record<string, unknown>).operation === "settings",
    )![0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      model: "model-a",
      effort: "high",
      policyId: "workspace",
      serviceTier: "fast",
    });
    expect(dispatched).not.toHaveProperty("sandbox");
    expect(dispatched).not.toHaveProperty("nativeRpc");
    expect(dispatched).not.toHaveProperty("serviceTierId");
  });

  it("takes a Codex model only by its exact id", async () => {
    // Claude's `/model` matching (any case, full model ID) is not applied to Codex.
    const client = await fullBrowser();
    const result = await client.api("codex/settings", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      model: "MODEL-A",
    });
    expect(result.response.status).toBe(400);
    expect(result.data).toMatchObject({ error: "unsupported_model" });
    expect(
      runtime.mock.calls.some(
        ([value]) => (value as Record<string, unknown>).operation === "settings",
      ),
    ).toBe(false);
  });

  it("dispatches goal changes through the normal request fence", async () => {
    const client = await fullBrowser();
    const requestId = randomUUID();
    const result = await client.api("codex/goal-set", {
      bootId: client.bootId,
      requestId,
      sessionId: "session",
      expectedRevision: 7,
      objective: "Complete the isolated fixture",
      tokenBudget: 4000,
      nativeGoal: { command: "hidden" },
    });
    expect(result.response.status).toBe(200);
    const dispatched = runtime.mock.calls.find(
      ([value]) => (value as Record<string, unknown>).operation === "goal-set",
    )![0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      requestId,
      goal: { objective: "Complete the isolated fixture", tokenBudget: 4000 },
      expectedRevision: 7,
    });
    expect(dispatched).not.toHaveProperty("nativeGoal");
    expect(
      (
        await client.api("codex/goal-set", {
          bootId: client.bootId,
          requestId,
          sessionId: "session",
          expectedRevision: 7,
          objective: "Duplicate",
        })
      ).response.status,
    ).toBe(409);
  });

  it("preserves explicit goal update intent and null budget without accepting native status", async () => {
    const client = await fullBrowser();
    const result = await client.api("codex/goal-set", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      objective: "Edit without restarting",
      intent: "update",
      tokenBudget: null,
      status: "active",
    });
    expect(result.response.status).toBe(200);
    const dispatched = runtime.mock.calls.find(
      ([value]) => (value as Record<string, unknown>).operation === "goal-set",
    )![0] as Record<string, unknown>;
    expect(dispatched.goal).toEqual({
      objective: "Edit without restarting",
      intent: "update",
      tokenBudget: null,
    });
    const invalid = await client.api("codex/goal-set", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      objective: "test",
      intent: "arbitrary-rpc",
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.data.error).toBe("invalid_goal_intent");
  });

  it("allows only native listed collaboration modes", async () => {
    const client = await fullBrowser();
    const action = { bootId: client.bootId, sessionId: "session", expectedRevision: 7 };
    expect(
      (await client.api("codex/settings", { ...action, requestId: randomUUID(), mode: "plan" }))
        .response.status,
    ).toBe(200);
    expect(
      (await client.api("codex/settings", { ...action, requestId: randomUUID(), mode: "custom" }))
        .response.status,
    ).toBe(400);
  });

  it("uses opaque resource ids and resolves them again before send", async () => {
    const client = await fullBrowser();
    const options = await client.api("codex/context-options?sessionId=session");
    expect(options.data.resources).toHaveLength(5);
    expect(JSON.stringify(options.data)).not.toContain("/private/skill");
    expect(JSON.stringify(options.data)).not.toContain("/etc/passwd");
    expect(
      options.data.resources.every((resource: { id: string }) =>
        /^[a-f0-9]{64}$/.test(resource.id),
      ),
    ).toBe(true);

    const skill = options.data.resources.find(
      (resource: { kind: string }) => resource.kind === "skill",
    );
    const file = options.data.resources.find(
      (resource: { name: string }) => resource.name === "fixture.txt",
    );
    const resourcesOnly = await client.api("send", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      text: "  ",
      resourceIds: [skill.id, file.id],
    });
    expect(resourcesOnly.response.status).toBe(400);
    expect(resourcesOnly.data.error).toBe("invalid_text");
    expect(
      runtime.mock.calls.some(([value]) => (value as Record<string, unknown>).operation === "send"),
    ).toBe(false);
    const sent = await client.api("send", {
      bootId: client.bootId,
      requestId: randomUUID(),
      sessionId: "session",
      expectedRevision: 7,
      text: "Use these",
      resourceIds: [skill.id, file.id],
      resourceRefs: [{ kind: "file", relativePath: "/etc/passwd" }],
    });
    expect(sent.response.status).toBe(200);
    const dispatched = runtime.mock.calls.find(
      ([value]) => (value as Record<string, unknown>).operation === "send",
    )![0] as Record<string, unknown>;
    expect(dispatched.resourceRefs).toEqual([
      { kind: "skill", id: "skill-safe" },
      { kind: "file", relativePath: "fixture.txt" },
    ]);
    expect(JSON.stringify(dispatched)).not.toContain("/etc/passwd");

    const directory = options.data.resources.find(
      (resource: { name: string }) => resource.name === "src",
    );
    const nested = await client.api(
      `codex/context-options?sessionId=session&directoryId=${encodeURIComponent(directory.navigationId)}`,
    );
    expect(nested.data.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "nested.txt", kind: "file" })]),
    );

    const unavailable = options.data.resources.find(
      (resource: { kind: string }) => resource.kind === "app",
    );
    expect(
      (
        await client.api("send", {
          bootId: client.bootId,
          requestId: randomUUID(),
          sessionId: "session",
          expectedRevision: 7,
          text: "Unavailable app",
          resourceIds: [unavailable.id],
        })
      ).response.status,
    ).toBe(409);
  });

  it("rejects changed and deleted file candidates at dispatch time", async () => {
    const client = await fullBrowser();
    const before = await client.api("codex/context-options?sessionId=session");
    const file = before.data.resources.find(
      (resource: { name: string }) => resource.name === "fixture.txt",
    );
    await writeFile(join(workspaceDir, "fixture.txt"), "changed fixture");
    expect(
      (
        await client.api("send", {
          bootId: client.bootId,
          requestId: randomUUID(),
          sessionId: "session",
          expectedRevision: 7,
          text: "Changed",
          resourceIds: [file.id],
        })
      ).response.status,
    ).toBe(409);

    const after = await client.api("codex/context-options?sessionId=session");
    const changed = after.data.resources.find(
      (resource: { name: string }) => resource.name === "fixture.txt",
    );
    await unlink(join(workspaceDir, "fixture.txt"));
    expect(
      (
        await client.api("send", {
          bootId: client.bootId,
          requestId: randomUUID(),
          sessionId: "session",
          expectedRevision: 7,
          text: "Deleted",
          resourceIds: [changed.id],
        })
      ).response.status,
    ).toBe(404);
  });

  it("keeps the new surfaces unavailable to legacy grants", async () => {
    const client = await browser();
    await approveLegacyBrowser(service, client.cookie, {
      send: true,
      settings: true,
      advancedControl: true,
    });
    expect((await client.api("codex/session-settings?sessionId=session")).response.status).toBe(
      403,
    );
    expect((await client.api("codex/goals?sessionId=session")).response.status).toBe(403);
    expect((await client.api("codex/context-options?sessionId=session")).response.status).toBe(403);
    expect(
      (
        await client.api("codex/goal-set", {
          bootId: client.bootId,
          requestId: randomUUID(),
          sessionId: "session",
          expectedRevision: 7,
          objective: "not allowed",
        })
      ).response.status,
    ).toBe(403);
  });
});
