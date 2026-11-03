// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, Server, type IncomingHttpHeaders } from "node:http";
import { WebAccessService, createWebControlState, HOSTED_ORIGIN } from "./service";
import { approveLegacyBrowser } from "./legacy-pairing-fixture";
import { RuntimeRequestError } from "../runtime-host";

describe("session image read boundary", () => {
  let directory: string;
  let service: WebAccessService;
  let origin: string;
  let port: number;
  let cookie: string;
  let csrf: string;
  let deviceId: string;
  let owner: string | undefined;
  let registered: boolean;
  let workspaceId: string;
  let image: { mimeType: string; base64: string };
  const control = createWebControlState();
  const route = "/session-images?sessionId=s&imageId=opaque-image";
  const runtime = vi.fn(async (params: unknown): Promise<unknown> => {
    const input = params as { operation: string };
    if (input.operation === "catalog")
      return {
        workspaces: [{ id: "w" }],
        sessions: [{ id: "s", workspace_id: workspaceId, agent: "claude-code" }],
      };
    if (input.operation === "session-image") return image;
    throw new Error("unexpected operation");
  });
  const implementation = runtime.getMockImplementation()!;

  async function http(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return new Promise<{
      status: number;
      headers: IncomingHttpHeaders;
      data: Record<string, unknown>;
      bytes: number;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/web/v1${path}`,
          method: options.method ?? "GET",
          headers: {
            Origin: origin,
            Cookie: cookie,
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json", "X-CSRF-Token": csrf }),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              data: JSON.parse(body.toString() || "{}") as Record<string, unknown>,
              bytes: body.length,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  }

  beforeEach(async () => {
    cookie = "";
    csrf = "";
    owner = undefined;
    registered = true;
    workspaceId = "w";
    image = { mimeType: "image/png", base64: Buffer.from("image fixture").toString("base64") };
    runtime.mockReset().mockImplementation(implementation);
    control.admission = false;
    control.active.clear();
    control.requests.clear();
    control.unconfirmed.clear();
    directory = await mkdtemp(join(tmpdir(), "agentkib-session-image-host-"));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    service = new WebAccessService({
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      sharedControl: control,
      desktopOrigin: "app://bundle",
      workspaceRequest: async () =>
        registered ? [{ id: "w", name: "Workspace", path: directory }] : [],
      account: {
        signedIn: () => !!owner,
        accountId: () => owner,
        ensureDeviceOwner: async () => undefined,
        registerDevice: async () => ({}),
      },
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      allowedWorkspaceIds: ["w"],
      experimentalEnabled: false,
    });
    const access = await http("/access");
    cookie = access.headers["set-cookie"]![0].split(";")[0];
    csrf = access.data.csrfToken as string;
    deviceId = await approveLegacyBrowser(service, cookie, {
      send: false,
      approve: false,
      attachments: false,
      files: false,
    });
  });

  afterEach(async () => {
    await service.shutdown();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("lets read-only clients load images independently of uploads and control admission", async () => {
    control.admission = true;
    const response = await http(route);
    expect(response.status).toBe(200);
    expect(response.data).toEqual(image);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(runtime).toHaveBeenCalledWith({
      operation: "session-image",
      sessionId: "s",
      imageId: "opaque-image",
    });
    expect(control.requests.size).toBe(0);
    expect(control.active.size).toBe(0);
    expect(control.unconfirmed.size).toBe(0);
    expect(control.admission).toBe(true);
  });

  it("exposes the image GET through the trusted desktop conversation whitelist", async () => {
    const result = await service.localRequest(route);
    expect(result).toMatchObject({ status: 200, body: image });
    expect(await service.localRequest(route, { imageId: "other" })).toMatchObject({ status: 404 });
  });

  it.each([
    "/session-images?sessionId=s",
    "/session-images?imageId=opaque-image",
    `${route}&path=%2Fprivate%2Fimage.png`,
    `${route}&sessionId=s`,
    `${route}&imageId=opaque-image`,
  ])("rejects missing, duplicate and path-bearing image parameters: %s", async (path) => {
    expect((await http(path)).status).toBe(400);
    expect(
      runtime.mock.calls.some(
        ([params]) => (params as { operation: string }).operation === "session-image",
      ),
    ).toBe(false);
  });

  it("rejects unpaired clients, unauthorized sessions and non-GET writes", async () => {
    expect((await http(route, { headers: { Cookie: "" } })).status).toBe(401);
    expect((await http(route.replace("sessionId=s", "sessionId=other"))).status).toBe(403);
    workspaceId = "outside";
    expect((await http(route)).status).toBe(403);
    expect((await http(route, { method: "POST", body: {} })).status).toBe(404);
    expect(
      runtime.mock.calls.some(
        ([params]) => (params as { operation: string }).operation === "session-image",
      ),
    ).toBe(false);
  });

  it.each([
    ["session-image-invalid", 400, "invalid_image_id"],
    ["session-image-unavailable", 404, "image_unavailable"],
    ["session-image-changed", 409, "image_changed"],
    ["session-image-too-large", 413, "image_too_large"],
    ["session-image-unsupported", 415, "image_unsupported"],
  ])("maps %s without replaying the image read", async (detail, status, code) => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "session-image")
        throw new RuntimeRequestError({ code: -32000, message: "Read failed", data: { detail } });
      return implementation(params);
    });
    const response = await http(route);
    expect(response.status).toBe(status);
    expect(response.data).toEqual({ error: code });
    expect(
      runtime.mock.calls.filter(
        ([params]) => (params as { operation: string }).operation === "session-image",
      ),
    ).toHaveLength(1);
    expect(control.requests.size).toBe(0);
    expect(control.unconfirmed.size).toBe(0);
  });

  it.each([
    ["revoke", 401, "access_ended"],
    ["boot", 409, "stale_boot"],
    ["owner", 409, "access_changed"],
    ["workspace", 403, "workspace_not_authorized"],
  ])("withholds an image when %s changes during the read", async (change, status, code) => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "session-image") {
        if (change === "revoke") await service.request({ operation: "revoke", id: deviceId });
        if (change === "boot") service.runtimeUnavailable();
        if (change === "owner") owner = "another-owner";
        if (change === "workspace") workspaceId = "outside";
      }
      return implementation(params);
    });
    const response = await http(route);
    expect(response.status).toBe(status);
    expect(response.data).toEqual({ error: code });
  });

  it("rechecks registered workspace access for trusted desktop reads", async () => {
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "session-image") registered = false;
      return implementation(params);
    });
    expect(await service.localRequest(route)).toMatchObject({
      status: 403,
      body: { error: "workspace_not_authorized" },
    });
  });

  it.each([
    { mimeType: "image/svg+xml", base64: "YWJj" },
    { mimeType: "text/html", base64: "YWJj" },
    { mimeType: "image/png", base64: "not base64" },
    { mimeType: "image/png", base64: "data:image/png;base64,YWJj" },
    { mimeType: "image/png", base64: "" },
  ])("rejects an invalid upstream image response ($mimeType, $base64)", async (invalid) => {
    image = invalid;
    const response = await http(route);
    expect(response.status).toBe(502);
    expect(response.data).toEqual({ error: "invalid_image_response" });
  });

  it("transports an 8 MiB image over HTTP and desktop JSON without lifting other route limits", async () => {
    image = { mimeType: "image/png", base64: Buffer.alloc(8 * 1024 * 1024, 1).toString("base64") };
    const response = await http(route);
    expect(response.status).toBe(200);
    expect(response.bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect((response.data.base64 as string | undefined)?.length).toBe(image.base64.length);
    const desktop = await service.localRequest(route);
    expect(desktop.status).toBe(200);
    expect((desktop.body as { base64?: string }).base64?.length).toBe(image.base64.length);
    runtime.mockImplementation(async (params) =>
      (params as { operation: string }).operation === "catalog"
        ? { content: "x".repeat(4 * 1024 * 1024) }
        : implementation(params),
    );
    expect(await service.localRequest("/catalog")).toMatchObject({
      status: 413,
      body: { error: "response_too_large" },
    });
  });

  it("rejects an upstream image exceeding the raw 8 MiB limit", async () => {
    image = { mimeType: "image/png", base64: Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") };
    const response = await http(route);
    expect(response.status).toBe(502);
    expect(response.data).toEqual({ error: "invalid_image_response" });
  });

  it("preflights only the image GET with the exact hosted LAN origin and allowed headers", async () => {
    await service.shutdown();
    const originalListen = Server.prototype.listen;
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      args[1] = "127.0.0.1";
      return Reflect.apply(originalListen, this, args);
    } as typeof originalListen);
    service = new WebAccessService({
      mode: "lan",
      dataDir: directory,
      staticDir: directory,
      runtimeRequest: runtime,
      sharedControl: control,
      addresses: () => [{ name: "fixture", address: "192.168.20.10" }],
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: HOSTED_ORIGIN,
      experimentalEnabled: false,
      lanAddress: "192.168.20.10",
      allowPlaintext: true,
    });
    const preflight = (headers: Record<string, string> = {}) =>
      http(route, {
        method: "OPTIONS",
        headers: {
          Host: `192.168.20.10:${port}`,
          Origin: HOSTED_ORIGIN,
          Cookie: "",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization,x-agentkib-protocol",
          ...headers,
        },
      });
    const allowed = await preflight();
    expect(allowed.status).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe(HOSTED_ORIGIN);
    expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await preflight({ "Access-Control-Request-Method": "POST" })).status).toBe(403);
    expect((await preflight({ Origin: "https://other.test" })).status).toBe(403);
    expect((await preflight({ "Access-Control-Request-Headers": "x-arbitrary" })).status).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
  });
});
