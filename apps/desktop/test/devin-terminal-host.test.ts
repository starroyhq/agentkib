import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { WebAccessService, createWebControlState } from "../electron/main/web/service";
import { approveLegacyBrowser } from "../electron/main/web/legacy-pairing-fixture";

describe("Devin terminal route", () => {
  let dir: string;
  let port: number;
  let cookie = "";
  let csrf = "";
  let service: WebAccessService;
  const runtime = vi.fn(async (params: unknown) => {
    const value = params as Record<string, unknown>;
    if (value.operation === "devin-terminal") return { terminal: "Terminal.app" };
    return {};
  });

  async function http(path: string, body?: unknown) {
    return new Promise<{ status: number; body: Record<string, any>; cookie?: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: `/api/web/v1${path}`,
            method: body === undefined ? "GET" : "POST",
            headers: {
              Cookie: cookie,
              Origin: `http://127.0.0.1:${port}`,
              "X-CSRF-Token": csrf,
              "X-AgentKib-Protocol": "2",
              "Content-Type": "application/json",
            },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(data),
                cookie: res.headers["set-cookie"]?.[0].split(";")[0],
              }),
            );
          },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      },
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ak-devin-terminal-"));
    runtime.mockClear();
    cookie = "";
    csrf = "";
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      managedRequest: runtime,
      verifiedCodex: true,
      verifiedExperimental: true,
      verifiedDevinManaged: true,
      sharedControl: createWebControlState(),
      workspaceRequest: async () => [{ id: "w", name: "Workspace", path: dir }],
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["w"],
    });
    const access = await http("/access");
    cookie = access.cookie!;
    csrf = access.body.csrfToken;
    await approveLegacyBrowser(service, cookie, { send: true, advancedControl: true });
  });

  afterEach(async () => {
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("opens Devin CLI's login for the desktop app only", async () => {
    expect(await service.localRequest("/devin/terminal", { action: "login" })).toMatchObject({
      status: 200,
      body: { terminal: "Terminal.app" },
    });
    expect(runtime).toHaveBeenCalledWith({ operation: "devin-terminal", action: "login" });
    runtime.mockClear();
    // A paired browser or phone cannot open a terminal on this computer.
    expect((await http("/devin/terminal", { action: "login" })).status).toBe(403);
    expect(runtime).not.toHaveBeenCalledWith(
      expect.objectContaining({ operation: "devin-terminal" }),
    );
  });

  it("asks to trust a registered workspace and refuses anything else", async () => {
    expect(
      await service.localRequest("/devin/terminal", { action: "trust", workspaceId: "w" }),
    ).toMatchObject({ status: 200 });
    expect(runtime).toHaveBeenCalledWith({
      operation: "devin-terminal",
      action: "trust",
      workspaceId: "w",
    });
    expect(await service.localRequest("/devin/terminal", { action: "rm" })).toMatchObject({
      status: 400,
    });
  });
});
