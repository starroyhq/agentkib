// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

// A Project Agent set up, read and managed from Web or a phone: what each device may do, and
// that the backend hears it in that device's name.

describe("Project Agent from a paired device", () => {
  let service: WebAccessService;
  let directory: string;
  let origin: string;
  let port: number;
  const lead = {
    sessionId: "claude-session",
    paused: false,
    reason: null,
    scope: {
      workspaceIds: ["first"],
      policies: [] as string[],
      maxLanes: 10,
      approvals: [] as string[],
    },
    workers: [],
  };
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string };
    if (params.operation === "catalog")
      return {
        workspaces: [],
        sessions: [
          { id: "claude-session", agent: "claude-code", workspace_id: "first" },
          { id: "codex-worker", agent: "codex", workspace_id: "first" },
        ],
      };
    return {};
  });
  const managed = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string };
    if (params.operation === "lead-status") return { lead: currentLead };
    if (params.operation === "lead-designate") return { lead };
    return { lead: currentLead };
  });
  let currentLead: typeof lead | null = null;

  async function browser() {
    const initial = await fetch(`${origin}/api/web/v1/access`);
    const access = await initial.json();
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    return {
      cookie,
      async api(path: string, body?: unknown) {
        const response = await fetch(`${origin}/api/web/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "X-CSRF-Token": access.csrfToken,
            "X-AgentKib-Protocol": "2",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      },
    };
  }
  async function phone() {
    const device = await browser();
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    const paired = await device.api("pair", { code, name: "Phone" });
    expect(paired.data.status).toBe("approved");
    return { ...device, id: String(paired.data.device.id) };
  }
  const leadCalls = () =>
    managed.mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter((value) => String(value.operation).startsWith("lead-"));

  beforeEach(async () => {
    runtime.mockClear();
    managed.mockClear();
    currentLead = null;
    directory = await mkdtemp(join(tmpdir(), "ak-project-agent-route-"));
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      claudeManagedRequest: managed,
      receiptRequest: async () => ({ found: false }),
      workspaceRequest: async () => [
        { id: "first", name: "First", path: directory },
        { id: "second", name: "Second", path: join(directory, "second") },
      ],
      verifiedClaudeManaged: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: ["first"],
    });
  });
  afterEach(async () => {
    await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it("sets one up in the device's name and accepts legacy settings without forwarding them", async () => {
    const device = await phone();
    expect(await device.api("managed/project-agent?sessionId=claude-session")).toMatchObject({
      status: 200,
      data: { lead: null },
    });
    const scope = { maxAutoTurns: 10, approvals: ["command"], answers: true };
    const designated = await device.api("managed/project-agent", {
      sessionId: "claude-session",
      operation: "designate",
      scope: {
        ...scope,
        workspaceIds: ["nonexistent"],
        policies: ["workspace-write-auto-review"],
        maxLanes: 1,
        allowAutoReview: true,
        maxWorkers: 1,
      },
    });
    expect(designated).toMatchObject({
      status: 200,
      data: { lead: { sessionId: "claude-session" } },
    });
    expect(leadCalls().at(-1)).toEqual({
      operation: "lead-designate",
      sessionId: "claude-session",
      deviceId: device.id,
      scope,
    });
    currentLead = { ...lead, scope: { ...lead.scope, approvals: ["command"] } };
    for (const operation of ["pause", "resume", "release"])
      expect(
        (await device.api("managed/project-agent", { sessionId: "claude-session", operation }))
          .status,
      ).toBe(200);
    expect(leadCalls().map((call) => call.operation)).toEqual([
      "lead-status",
      "lead-designate",
      "lead-pause",
      // Resuming checks what it resumes first.
      "lead-status",
      "lead-resume",
      "lead-release",
    ]);
    expect(leadCalls().every((call) => call.deviceId === device.id)).toBe(true);
    expect(leadCalls().find((call) => call.operation === "lead-resume")).toMatchObject({
      authorizedWorkspaceIds: ["first"],
    });
  });

  it("changes its settings, and lets one worker go or stops its turn, in the device's name", async () => {
    const device = await phone();
    currentLead = { ...lead, scope: { ...lead.scope, approvals: ["command"] } };
    const call = (body: Record<string, unknown>) =>
      device.api("managed/project-agent", { sessionId: "claude-session", ...body });
    // A change keeps what it does not name, and this device answers for all of it.
    expect(
      await call({
        operation: "update",
        scope: { maxLanes: 3, workspaceIds: ["elsewhere"], maxAutoTurns: 15, stallMinutes: 18 },
      }),
    ).toMatchObject({ status: 200, data: { lead: { scope: { maxLanes: 10 } } } });
    for (const operation of ["stop-worker", "remove-worker"])
      expect((await call({ operation, worker: "codex-worker" })).status).toBe(200);
    // A session this device cannot reach is no worker it acts on.
    expect((await call({ operation: "stop-worker", worker: "unknown" })).status).toBe(403);
    expect((await call({ operation: "remove-worker" })).status).toBe(400);
    expect(leadCalls()).toEqual([
      { operation: "lead-status", sessionId: "claude-session", deviceId: device.id },
      {
        operation: "lead-update",
        sessionId: "claude-session",
        deviceId: device.id,
        scope: { maxAutoTurns: 15, stallMinutes: 18 },
        authorizedWorkspaceIds: ["first"],
      },
      {
        operation: "lead-worker-stop",
        sessionId: "claude-session",
        deviceId: device.id,
        worker: "codex-worker",
      },
      {
        operation: "lead-worker-remove",
        sessionId: "claude-session",
        deviceId: device.id,
        worker: "codex-worker",
      },
    ]);
  });

  it("does not let a device take responsibility for workers outside its reach", async () => {
    const device = await phone();
    currentLead = { ...lead, scope: { ...lead.scope, workspaceIds: ["first", "elsewhere"] } };
    for (const operation of ["update", "resume"]) {
      const result = await device.api("managed/project-agent", {
        sessionId: "claude-session",
        operation,
        ...(operation === "update" ? { scope: { workspaceIds: ["first"] } } : {}),
      });
      expect(result).toMatchObject({ status: 403 });
    }
    expect(leadCalls().map((call) => call.operation)).toEqual(["lead-status", "lead-status"]);
  });

  it("says so when it stops because the app quits, not when its settings change", async () => {
    service.setSharedRuntimePrimary(false);
    const device = await phone();
    const invalidations = () =>
      managed.mock.calls
        .map(([value]) => value as Record<string, unknown>)
        .filter((value) => value.operation === "schedule-invalidate");
    // New settings may change what the device can reach: what it set going stops.
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: [],
    });
    expect(invalidations()).toEqual([{ operation: "schedule-invalidate", deviceId: device.id }]);
    managed.mockClear();
    // Quitting changes nothing about the device: the backend hears that it is a quit.
    await service.dispose();
    expect(invalidations()).toEqual([
      { operation: "schedule-invalidate", deviceId: device.id, quitting: true },
    ]);
  });

  it("lets a device without full access see one, and nothing more", async () => {
    const restricted = await browser();
    await approveLegacyBrowser(service, restricted.cookie, {
      send: true,
      approve: true,
      manage: true,
    });
    expect((await restricted.api("managed/project-agent?sessionId=claude-session")).status).toBe(
      200,
    );
    for (const operation of [
      "designate",
      "update",
      "pause",
      "resume",
      "release",
      "remove-worker",
      "stop-worker",
    ])
      expect(
        (
          await restricted.api("managed/project-agent", {
            sessionId: "claude-session",
            operation,
            ...(operation === "designate" || operation === "update"
              ? { scope: { workspaceIds: ["first"] } }
              : {}),
            ...(operation.endsWith("-worker") ? { worker: "codex-worker" } : {}),
          })
        ).status,
      ).toBe(403);
    expect(leadCalls().map((call) => call.operation)).toEqual(["lead-status"]);
    expect(
      (
        await restricted.api("managed/project-agent", {
          sessionId: "claude-session",
          operation: "everything",
        })
      ).status,
    ).toBe(400);
  });
});
