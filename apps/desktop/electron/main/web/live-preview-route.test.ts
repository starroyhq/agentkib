// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebAccessService, type WebConfig } from "./service";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}
function get(url: string, headers: Record<string, string>) {
  const target = new URL(url);
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const outgoing = request(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          headers,
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode!, headers: response.headers, body }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    },
  );
}

describe("the web preview route", () => {
  let dir: string;
  let origin: string;
  let webPort: number;
  let service: WebAccessService;
  let devServer: Server;
  let devPort: number;
  const received: IncomingHttpHeaders[] = [];
  let connections = 0;
  const runtime = vi.fn(async (input: unknown): Promise<unknown> => {
    const params = input as { operation: string };
    if (params.operation === "catalog") return { workspaces: [], sessions: [] };
    return {};
  });
  async function browser(access: "full" | "read" = "full") {
    const initial = await fetch(`${origin}/api/web/v1/access`);
    const state = await initial.json();
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${origin}/api/web/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "X-CSRF-Token": state.csrfToken,
          "X-AgentKib-Protocol": "2",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    const code = (await service.request({ operation: "generate-code", access })).code!.value;
    const paired = await api("pair", { code, name: "Phone" });
    expect(paired.data.status).toBe("approved");
    return { cookie, api, id: paired.data.device.id as string };
  }
  beforeEach(async () => {
    received.length = 0;
    connections = 0;
    dir = await mkdtemp(join(tmpdir(), "agentkib-live-route-"));
    devServer = createServer((req, res) => {
      received.push(req.headers);
      res.writeHead(200, { "Content-Type": "text/plain", "X-Frame-Options": "DENY" });
      res.end(`dev ${req.url}`);
    });
    devServer.on("connection", () => connections++);
    devPort = await listen(devServer);
    const probe = createServer();
    webPort = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    origin = `http://127.0.0.1:${webPort}`;
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      workspaceRequest: async () => [],
      verifiedCodex: true,
    });
    await service.initialize();
    const config: WebConfig = {
      enabled: true,
      port: webPort,
      externalOrigin: "",
      experimentalEnabled: false,
      allowedWorkspaceIds: [],
    };
    await service.request({ operation: "configure", ...config });
  });
  afterEach(async () => {
    await service.shutdown();
    devServer.closeAllConnections();
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("gives a full-access browser a preview of a local port, without AgentKib's cookie", async () => {
    const phone = await browser();
    const issued = await phone.api("live-preview-tickets", { port: devPort, path: "/app" });
    expect(issued.status).toBe(200);
    const url = new URL(issued.data.url);
    expect(url.origin).not.toBe(origin);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toMatch(/^\/live\/[A-Za-z0-9_-]{32}\/app$/);
    const bootstrap = await get(issued.data.url, { "Sec-Fetch-Mode": "navigate" });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers["content-security-policy"]).toContain(
      `frame-ancestors 'self' ${origin}`,
    );
    // The browser sends its 127.0.0.1 cookies to every port; the page's server must not see it.
    const page = await get(issued.data.url, {
      "X-AgentKib-Live": "1",
      Cookie: `${phone.cookie}; app=1`,
    });
    expect(page.body).toBe("dev /app");
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.cookie).toBe("app=1");
    expect(received[0]!.host).toBe(`localhost:${devPort}`);
  });
  it("refuses read access, AgentKib's own ports and ports nothing listens on", async () => {
    const reader = await browser("read");
    expect((await reader.api("live-preview-tickets", { port: devPort })).status).toBe(403);
    // Refused before the port is probed: a read-only browser cannot scan local ports.
    expect(connections).toBe(0);
    const phone = await browser();
    const own = await phone.api("live-preview-tickets", { port: webPort });
    expect(own).toEqual({ status: 403, data: { error: "live_preview_port_reserved" } });
    const issued = await phone.api("live-preview-tickets", { port: devPort });
    const previewPort = Number(new URL(issued.data.url).port);
    expect((await phone.api("live-preview-tickets", { port: previewPort })).data.error).toBe(
      "live_preview_port_reserved",
    );
    const closed = createServer();
    const closedPort = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect((await phone.api("live-preview-tickets", { port: closedPort })).data.error).toBe(
      "live_preview_unreachable",
    );
    expect((await phone.api("live-preview-tickets", { port: "5173" })).status).toBe(400);
    expect(received).toEqual([]);
  });
  it.each([
    ["revoked", "revoke"],
    ["downgraded", "set-access"],
  ] as const)("stops a device's previews once it is %s", async (_name, operation) => {
    const phone = await browser();
    const issued = await phone.api("live-preview-tickets", { port: devPort });
    expect((await get(issued.data.url, { "X-AgentKib-Live": "1" })).status).toBe(200);
    await service.request(
      operation === "revoke"
        ? { operation, id: phone.id }
        : { operation, id: phone.id, access: "read" },
    );
    expect((await get(issued.data.url, { "X-AgentKib-Live": "1" })).status).toBe(410);
    expect(received).toHaveLength(1);
  });
  it("checks the device's grant again on every request", async () => {
    const phone = await browser();
    const issued = await phone.api("live-preview-tickets", { port: devPort });
    const credentials = (
      service as unknown as { credentials: { device: { id: string; advancedControl?: boolean } }[] }
    ).credentials;
    // A grant can change without a revocation event; the proxy must not rely on one.
    credentials.find((c) => c.device.id === phone.id)!.device.advancedControl = false;
    expect((await get(issued.data.url, { "X-AgentKib-Live": "1" })).status).toBe(403);
    expect(received).toEqual([]);
  });
  it("stops a browser's previews when it logs out", async () => {
    const phone = await browser();
    const issued = await phone.api("live-preview-tickets", { port: devPort });
    expect((await phone.api("logout", {})).status).toBe(200);
    expect((await get(issued.data.url, { "X-AgentKib-Live": "1" })).status).toBe(410);
    expect(received).toEqual([]);
  });
});
