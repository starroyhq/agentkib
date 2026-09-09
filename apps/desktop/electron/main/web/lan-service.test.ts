// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, Server } from "node:http";
import { createWebControlState, HOSTED_ORIGIN, isPrivateIPv4, WebAccessService } from "./service";

describe("hosted LAN transport", () => {
  let dir: string;
  let service: WebAccessService;
  let port: number;
  let bearer = "";
  let csrf = "";
  let addresses = [{ name: "fixture", address: "192.168.20.10" }];
  const runtime = vi.fn(async () => ({ events: [] }));
  const shared = createWebControlState();
  let bootId = "";
  async function http(
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    body?: unknown,
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      data: Record<string, any>;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/web/v1${path}`,
          method,
          headers: {
            Host: `192.168.20.10:${port}`,
            Origin: HOSTED_ORIGIN,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(body ? { "Content-Type": "application/json", "X-CSRF-Token": csrf } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              data: JSON.parse(Buffer.concat(chunks).toString() || "{}"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function bootstrap() {
    const result = await http("/access");
    bearer = result.data.bearerToken;
    csrf = result.data.csrfToken;
    bootId = result.data.bootId;
    return result;
  }
  async function pair() {
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    const response = await http("/pair", {}, "POST", { code, name: "LAN fixture" });
    expect(response.status).toBe(200);
    await service.request({
      operation: "approve",
      id: response.data.pending.id,
      send: false,
      approve: false,
    });
    return response.data.pending.id as string;
  }
  beforeEach(async () => {
    bearer = "";
    csrf = "";
    addresses = [{ name: "fixture", address: "192.168.20.10" }];
    shared.admission = false;
    shared.requests.clear();
    shared.active.clear();
    shared.unconfirmed.clear();
    runtime.mockClear();
    dir = await mkdtemp(join(tmpdir(), "agentkib-lan-test-"));
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    // Test the HTTP boundary without opening the fixture on a real LAN interface.
    const original = Server.prototype.listen;
    vi.spyOn(Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      args[1] = "127.0.0.1";
      return Reflect.apply(original, this, args);
    } as typeof original);
    service = new WebAccessService({
      mode: "lan",
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      addresses: () => addresses,
      sharedControl: shared,
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
  });
  afterEach(async () => {
    await service.shutdown();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("validates RFC1918 and exact host/origin, rejecting absent and null origins", async () => {
    for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1"])
      expect(isPrivateIPv4(address)).toBe(true);
    for (const address of [
      "127.0.0.1",
      "0.0.0.0",
      "172.32.0.1",
      "192.168.1.256",
      "192.168.01.1",
      "1.1.1.1",
    ])
      expect(isPrivateIPv4(address)).toBe(false);
    expect((await http("/info", { Origin: "null" })).status).toBe(403);
    expect((await http("/info", { Origin: "" })).status).toBe(403);
    expect((await http("/info", { Host: "remote.agentkib.com" })).status).toBe(403);
    expect(
      (await http("/info", { Origin: "https://evil.test" })).headers["access-control-allow-origin"],
    ).toBeUndefined();
    expect((await http("/info")).data).toEqual({
      protocolVersion: 1,
      transport: "lan",
      capabilities: { read: true, send: false, approve: false },
    });
  });
  it("only preflights whitelisted routes, methods and headers", async () => {
    const response = await http(
      "/send",
      {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type,x-csrf-token",
      },
      "OPTIONS",
    );
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(HOSTED_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(
      (await http("/rpc", { "Access-Control-Request-Method": "POST" }, "OPTIONS")).status,
    ).toBe(403);
    expect(
      (
        await http(
          "/send",
          {
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-arbitrary",
          },
          "OPTIONS",
        )
      ).status,
    ).toBe(403);
  });
  it("issues bearer only at bootstrap, never cookies, and requires desktop approval and CSRF", async () => {
    const response = await bootstrap();
    expect(bearer).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect((await http("/access")).data.bearerToken).toBeUndefined();
    expect((await http("/catalog")).status).toBe(401);
    expect(
      (await http("/pair", { "X-CSRF-Token": "wrong" }, "POST", { code: "12345678", name: "test" }))
        .status,
    ).toBe(403);
    const id = await pair();
    expect((await http("/catalog")).status).toBe(200);
    expect((await http("/send", {}, "POST", {})).status).toBe(403);
    const saved = await readFile(join(dir, "web-access.json"), "utf8");
    expect(saved).not.toContain(bearer);
    expect(saved).toContain(`${HOSTED_ORIGIN}|http://192.168.20.10:${port}`);
    expect(
      (await http("/catalog", { Authorization: "", Cookie: `ak_web_local=${bearer}` })).status,
    ).toBe(401);
    await service.request({ operation: "revoke", id });
    expect((await http("/catalog")).status).toBe(401);
    expect((await http("/access")).data.status).toBe("ended");
  });
  it("shares runtime admission and blocks malformed/revoked tokens rather than rebootstrap", async () => {
    await bootstrap();
    await pair();
    shared.admission = true;
    expect((await http("/catalog")).status).toBe(409);
    expect(runtime).not.toHaveBeenCalled();
    expect((await http("/access", { Authorization: "Bearer invalid" })).status).toBe(401);
  });
  it("refuses plaintext without confirmation and does not migrate unavailable addresses", async () => {
    await expect(
      service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: HOSTED_ORIGIN,
        experimentalEnabled: false,
        lanAddress: "192.168.20.10",
        allowPlaintext: false,
      }),
    ).rejects.toThrow("plaintext_confirmation_required");
    addresses = [];
    const status = await service.request({ operation: "status" });
    expect(status.running).toBe(false);
    expect(status.error).toBe("lan_address_unavailable");
    expect(status.connectionUrl).toBeUndefined();
  });
  it("checks LAN addresses every 30 seconds and releases the timer when the address disappears", async () => {
    const config = (await service.request({ operation: "status" })).config;
    const schedule = vi.spyOn(globalThis, "setInterval");
    const cancel = vi.spyOn(globalThis, "clearInterval");
    await service.request({ operation: "configure", ...config });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 30_000);
    const timer = schedule.mock.results[0].value;
    addresses = [];
    await service.checkLanAddress();
    expect(cancel).toHaveBeenCalledWith(timer);
    const status = await service.request({ operation: "status" });
    expect(status.running).toBe(false);
    expect(status.error).toBe("lan_address_unavailable");
  });
  it("restores only its own persisted backend-bound bearer credentials", async () => {
    await bootstrap();
    await pair();
    await service.shutdown();
    service = new WebAccessService({
      mode: "lan",
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      addresses: () => addresses,
      sharedControl: shared,
    });
    await service.initialize();
    expect((await http("/access")).data.status).toBe("approved");
    expect((await http("/access")).data.bearerToken).toBeUndefined();
    expect((await http("/catalog")).status).toBe(200);
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: HOSTED_ORIGIN,
      experimentalEnabled: false,
      lanAddress: "192.168.20.10",
      allowPlaintext: true,
    });
    expect((await http("/access")).status).toBe(401);
  });
  it("ends streams as unavailable on runtime restart without revoking credentials", async () => {
    await bootstrap();
    await pair();
    const previousBoot = bootId;
    const stream = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=session",
          headers: {
            Host: `192.168.20.10:${port}`,
            Origin: HOSTED_ORIGIN,
            Authorization: `Bearer ${bearer}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let restarted = false;
          res.on("data", (chunk) => {
            chunks.push(chunk);
            if (!restarted) {
              restarted = true;
              service.runtimeUnavailable();
            }
          });
          res.on("error", reject);
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(stream).toContain("event: snapshot");
    expect(stream).toContain("event: unavailable");
    expect(stream).not.toContain("event: access-ended");
    const access = await http("/access");
    expect(access.data.status).toBe("approved");
    expect(access.data.bootId).not.toBe(previousBoot);
    expect(access.data.bearerToken).toBeUndefined();
    expect((await http("/catalog")).status).toBe(200);
  });
  it("honors shared request and unconfirmed fences before dispatch", async () => {
    await service.shutdown();
    service = new WebAccessService({
      mode: "lan",
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      addresses: () => addresses,
      sharedControl: shared,
      verifiedExperimental: true,
    });
    await service.initialize();
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: HOSTED_ORIGIN,
      experimentalEnabled: true,
      lanAddress: "192.168.20.10",
      allowPlaintext: true,
    });
    await bootstrap();
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    const paired = await http("/pair", {}, "POST", { code, name: "control fixture" });
    await service.request({
      operation: "approve",
      id: paired.data.pending.id,
      send: true,
      approve: true,
    });
    shared.requests.add("request-from-loopback");
    const duplicate = await http("/send", {}, "POST", {
      bootId,
      sessionId: "session",
      requestId: "request-from-loopback",
      expectedRevision: 1,
      text: "hello",
    });
    expect(duplicate.data.error).toBe("duplicate_request");
    shared.unconfirmed.add("session");
    const uncertain = await http("/send", {}, "POST", {
      bootId,
      sessionId: "session",
      requestId: "another-request",
      expectedRevision: 1,
      text: "hello",
    });
    expect(uncertain.data.error).toBe("outcome_unknown");
    expect(runtime).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "coordinates two paired transports across preflight (revoked: %s)",
    async (revoke) => {
      let enterPreflight!: () => void;
      const entered = new Promise<void>((resolve) => {
        enterPreflight = resolve;
      });
      let releasePreflight!: () => void;
      const preflight = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      let first = true;
      const owner = vi.fn(async (input: unknown): Promise<unknown> => {
        const params = input as { operation: string };
        if (params.operation === "live") {
          if (first) {
            first = false;
            enterPreflight();
            await preflight;
          }
          return { runtimeBootId: "fixture-runtime", revision: 1, sendEnabled: true };
        }
        // An ambiguous reply must leave the shared unknown-outcome fence in place.
        return { accepted: false };
      });
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const localPort = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const local = new WebAccessService({
        dataDir: join(dir, "local"),
        staticDir: dir,
        runtimeRequest: owner,
        sharedControl: shared,
        verifiedExperimental: true,
      });
      let localCookie = "";
      let localCsrf = "";
      let localBoot = "";
      async function localHttp(path: string, body?: unknown) {
        const response = await fetch(`http://127.0.0.1:${localPort}/api/web/v1${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            Cookie: localCookie,
            Origin: `http://127.0.0.1:${localPort}`,
            ...(body ? { "Content-Type": "application/json", "X-CSRF-Token": localCsrf } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        return {
          status: response.status,
          headers: response.headers,
          data: (await response.json()) as Record<string, any>,
        };
      }
      try {
        await local.initialize();
        await local.request({
          operation: "configure",
          enabled: true,
          port: localPort,
          externalOrigin: "",
          experimentalEnabled: true,
        });
        const access = await localHttp("/access");
        localCookie = access.headers.get("set-cookie")!.split(";")[0];
        localCsrf = access.data.csrfToken;
        localBoot = access.data.bootId;
        const localCode = (await local.request({ operation: "generate-code" })).code!.value;
        const localPair = await localHttp("/pair", { code: localCode, name: "local fixture" });
        await local.request({
          operation: "approve",
          id: localPair.data.pending.id,
          send: true,
          approve: true,
        });
        await service.shutdown();
        service = new WebAccessService({
          mode: "lan",
          dataDir: dir,
          staticDir: dir,
          runtimeRequest: owner,
          sharedControl: shared,
          addresses: () => addresses,
          verifiedExperimental: true,
        });
        await service.initialize();
        await service.request({
          operation: "configure",
          enabled: true,
          port,
          externalOrigin: HOSTED_ORIGIN,
          experimentalEnabled: true,
          lanAddress: "192.168.20.10",
          allowPlaintext: true,
        });
        await bootstrap();
        const lanCode = (await service.request({ operation: "generate-code" })).code!.value;
        const lanPair = await http("/pair", {}, "POST", { code: lanCode, name: "LAN fixture" });
        await service.request({
          operation: "approve",
          id: lanPair.data.pending.id,
          send: true,
          approve: true,
        });
        const body = {
          sessionId: "shared-session",
          requestId: "first-local",
          expectedRevision: 1,
          text: "fixture",
        };
        const pending = localHttp("/send", { ...body, bootId: localBoot });
        await entered;
        const competing = await http("/send", {}, "POST", {
          ...body,
          requestId: "lan-competing",
          bootId,
        });
        expect(competing.status).toBe(409);
        expect(competing.data.error).toBe("operation_busy");
        expect(owner).toHaveBeenCalledTimes(1);
        if (revoke) await local.request({ operation: "revoke", id: localPair.data.pending.id });
        releasePreflight();
        const firstResult = await pending;
        expect(firstResult.status).toBe(revoke ? 401 : 502);
        expect(
          owner.mock.calls.filter(
            ([input]) => (input as { operation: string }).operation === "send",
          ),
        ).toHaveLength(revoke ? 0 : 1);
        const duplicate = await http("/send", {}, "POST", { ...body, bootId });
        expect(duplicate.data.error).toBe("duplicate_request");
        if (!revoke) {
          for (const live of [
            await localHttp("/live?sessionId=shared-session"),
            await http("/live?sessionId=shared-session"),
          ]) {
            expect(live.data.status).toBe("outcome-unknown");
            expect(live.data.sendEnabled).toBe(false);
          }
          for (const reply of [
            await localHttp("/send", { ...body, requestId: "local-next", bootId: localBoot }),
            await http("/send", {}, "POST", { ...body, requestId: "lan-next", bootId }),
          ]) {
            expect(reply.data.error).toBe("outcome_unknown");
          }
        }
      } finally {
        releasePreflight();
        await local.shutdown();
      }
    },
  );
});
