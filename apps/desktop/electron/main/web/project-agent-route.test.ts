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
      policies: ["workspace-write-on-request"],
      approvals: [] as string[],
    },
    workers: [],
  };
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string };
    if (params.operation === "catalog")
      return {
        workspaces: [],
        sessions: [{ id: "claude-session", agent: "claude-code", workspace_id: "first" }],
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

  it("sets one up in the device's name, within the workspaces it may use", async () => {
    const device = await phone();
    expect(await device.api("managed/project-agent?sessionId=claude-session")).toMatchObject({
      status: 200,
      data: { lead: null },
    });
    const scope = {
      workspaceIds: ["first", "second"],
      policies: ["workspace-write-on-request"],
      maxLanes: 2,
      maxAutoTurns: 10,
      approvals: ["command"],
      answers: true,
    };
    const designated = await device.api("managed/project-agent", {
      sessionId: "claude-session",
      operation: "designate",
      scope,
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
    // Not a workspace of this computer.
    expect(
      (
        await device.api("managed/project-agent", {
          sessionId: "claude-session",
          operation: "designate",
          scope: { ...scope, workspaceIds: ["elsewhere"] },
        })
      ).status,
    ).toBe(403);
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
  });

  it("says so when it stops because the app quits, not when its settings change", async () => {
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
    for (const operation of ["designate", "pause", "resume", "release"])
      expect(
        (
          await restricted.api("managed/project-agent", {
            sessionId: "claude-session",
            operation,
            ...(operation === "designate" ? { scope: { workspaceIds: ["first"] } } : {}),
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
