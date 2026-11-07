// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";

describe("parent-scoped read-only subagents", () => {
  let service: WebAccessService, dir: string, origin: string, cookie: string, deviceId: string;
  const runtime = vi.fn();
  const workspaceRequest = vi.fn();
  const childId = "c".repeat(64);
  const sessions = [
    { id: "parent", workspace_id: "w", agent: "codex", origin: "interactive" },
    { id: "claude-parent", workspace_id: "w", agent: "claude-code", origin: "interactive" },
    { id: "dsh-parent", workspace_id: "w", agent: "deepseek-harness", origin: "interactive" },
    { id: "other", workspace_id: "elsewhere", agent: "codex", origin: "interactive" },
    { id: "aux", workspace_id: "w", agent: "codex", origin: "auxiliary" },
  ];
  const result = { version: 1, sessionId: "parent", agents: [], truncated: false };
  const api = (path: string, method = "GET") =>
    fetch(`${origin}/api/web/v1/${path}`, {
      method,
      headers: { Cookie: cookie, "X-AgentKib-Protocol": "2" },
    });
  beforeEach(async () => {
    runtime.mockReset();
    workspaceRequest.mockReset();
    workspaceRequest.mockImplementation(async () => [{ id: "w", name: "Workspace", path: dir }]);
    cookie = "";
    dir = await mkdtemp(join(tmpdir(), "agentkib-subagents-http-"));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    runtime.mockImplementation(async (input: { operation: string }) =>
      input.operation === "catalog" ? { workspaces: [{ id: "w", path: dir }], sessions } : result,
    );
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      workspaceRequest,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: ["w"],
    });
    const access = await api("access");
    cookie = access.headers.get("set-cookie")!.split(";")[0];
    deviceId = await approveLegacyBrowser(service, cookie);
  });
  afterEach(async () => {
    await service?.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["parent", "claude-parent", "dsh-parent"])(
    "allows a read-only grant to inspect %s without control permissions",
    async (sessionId) => {
      expect((await api(`subagents?sessionId=${sessionId}`)).status).toBe(200);
      expect(runtime).toHaveBeenCalledWith({ operation: "subagents", sessionId });
      expect(
        (await api(`subagent/events?sessionId=${sessionId}&subagentId=${childId}&cursor=page-1`))
          .status,
      ).toBe(200);
      expect(runtime).toHaveBeenCalledWith({
        operation: "subagent-events",
        sessionId,
        subagentId: childId,
        cursor: "page-1",
        limit: 50,
      });
    },
  );

  it.each(["other", "aux", "missing"])(
    "rejects an unauthorized or auxiliary parent %s before reading children",
    async (sessionId) => {
      expect((await api(`subagents?sessionId=${sessionId}`)).status).toBe(403);
      expect(runtime.mock.calls.some(([value]) => value.operation === "subagents")).toBe(false);
    },
  );

  it("validates child IDs, cursors and page bounds before native reads", async () => {
    for (const query of [
      "",
      "&subagentId=opaque-child",
      `&subagentId=${"C".repeat(64)}`,
      `&subagentId=${childId}&limit=51`,
      `&subagentId=${childId}&cursor=${"a".repeat(1025)}`,
    ]) {
      expect((await api(`subagent/events?sessionId=parent${query}`)).status).toBe(400);
    }
    expect(runtime.mock.calls.some(([value]) => value.operation === "subagent-events")).toBe(false);
  });

  it.each([
    ["invalid-request", 400, "invalid_input"],
    ["TRANSCRIPT_CURSOR_INVALID", 400, "invalid_cursor"],
    ["TRANSCRIPT_CURSOR_STALE", 409, "stale_cursor"],
    ["subagent-unavailable", 404, "subagent_unavailable"],
    ["private failure /home/synthetic/.claude/secret.jsonl", 500, "request_failed"],
  ])(
    "projects native child read error %s without leaking runtime details",
    async (message, status, code) => {
      runtime.mockImplementation(async (input: { operation: string }) => {
        if (input.operation === "catalog") return { sessions, workspaces: [] };
        throw new Error(String(message));
      });
      const response = await api(`subagent/events?sessionId=parent&subagentId=${childId}`);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
    },
  );

  it("does not treat a temporarily unavailable parent catalog as an unsupported host", async () => {
    runtime.mockImplementation(async (input: { operation: string }) => {
      if (input.operation === "catalog") return { sessions, workspaces: [] };
      throw new Error("subagent-unavailable");
    });
    const response = await api("subagents?sessionId=parent");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "request_failed" });
  });

  it("does not expose a pending read after authorization is revoked", async () => {
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    runtime.mockImplementation(async (input: { operation: string }) => {
      if (input.operation === "catalog") return { sessions, workspaces: [] };
      entered();
      return new Promise((resolve) => (finish = resolve));
    });
    const pending = api("subagents?sessionId=parent");
    await started;
    await service.request({ operation: "revoke", id: deviceId });
    finish(result);
    expect((await pending).status).toBe(401);
  });

  it("rechecks the grant after the final asynchronous workspace authorization", async () => {
    // A real code pairing takes the full-access branch, where workspaceAllowed
    // awaits the independently registered workspace catalog.
    cookie = "";
    const access = await api("access");
    cookie = access.headers.get("set-cookie")!.split(";")[0];
    const bootstrap = (await access.json()) as { csrfToken: string };
    const code = await service.request({ operation: "generate-code" });
    const paired = await fetch(`${origin}/api/web/v1/pair`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": bootstrap.csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: code.code!.value, name: "Synthetic phone" }),
    });
    expect(paired.status).toBe(200);
    const pairedBody = (await paired.json()) as { device: { id: string; accessMode: string } };
    expect(pairedBody.device.accessMode).toBe("full");

    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const release = new Promise<void>((resolve) => (finish = resolve));
    let checks = 0;
    workspaceRequest.mockImplementation(async () => {
      if (++checks === 2) {
        entered();
        await release;
      }
      return [{ id: "w", name: "Workspace", path: dir }];
    });
    runtime.mockImplementation(async (input: { operation: string }) =>
      input.operation === "catalog"
        ? { sessions, workspaces: [] }
        : {
            version: 1,
            sessionId: "parent",
            subagentId: childId,
            events: [{ content: "private child report" }],
          },
    );
    const pending = api(`subagent/events?sessionId=parent&subagentId=${childId}`);
    await started;
    await service.request({ operation: "revoke", id: pairedBody.device.id });
    finish();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "access_ended" });
  });
});
