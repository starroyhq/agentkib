// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, ServerResponse } from "node:http";
import { WebAccessService, createWebControlState } from "./service";
import { ConversationHub } from "../conversation-hub";
import { RUNTIME_METHODS, type SessionStreamEvent } from "../../generated/runtime-protocol";
import { approveLegacyBrowser, seedLegacyPending } from "./legacy-pairing-fixture";
import { RelayManager } from "./relay/manager";

describe("WebAccessService loopback security boundary", () => {
  let dir: string;
  let service: WebAccessService;
  let origin: string;
  let port: number;
  let cookie: string;
  let csrf: string;
  let bootId: string;
  let hub: ConversationHub;
  let control: ReturnType<typeof createWebControlState>;
  let nextSubscription = 0;
  const subscriptions = new Set<string>();
  function pushEvent(type: string, payload: unknown, seq = 1) {
    for (const subscriptionId of subscriptions)
      hub.notification("sessions.event", {
        protocolVersion: 2,
        subscriptionId,
        sessionId: "s",
        runtimeBootId: "runtime-one",
        epoch: "epoch-one",
        seq,
        cursor: `epoch-one:${seq}`,
        type,
        payload,
      });
  }
  const runtime = vi.fn(async (_params: unknown): Promise<unknown> => ({
    runtimeBootId: "runtime-one",
    revision: 4,
    sendEnabled: true,
    events: [],
  }));
  const receiptQuery = vi.fn(
    async (params: { requestId: string; deviceId: string }): Promise<unknown> => ({
      found: false,
      requestId: params.requestId,
    }),
  );
  const onPairingRequested = vi.fn();
  async function http(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
      json: () => Record<string, any>;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method || "GET",
          headers: {
            "X-AgentKib-Protocol": "2",
            ...(cookie ? { Cookie: cookie } : {}),
            ...(options.body !== undefined
              ? { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf }
              : {}),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body,
              json: () => JSON.parse(body),
            });
          });
        },
      );
      req.on("error", reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  }
  async function bootstrap() {
    const result = await http("/api/web/v1/access");
    cookie = result.headers["set-cookie"]![0].split(";")[0];
    csrf = result.json().csrfToken;
    bootId = result.json().bootId;
    return result;
  }
  async function pair(send = false, approve = false) {
    return approveLegacyBrowser(service, cookie, { send, approve });
  }
  function openStream(streamCookie = cookie, sessionId = "s", afterCursor?: string) {
    const chunks: string[] = [];
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/web/v1/stream?protocolVersion=2${sessionId ? `&sessionId=${sessionId}` : ""}${afterCursor ? `&afterCursor=${encodeURIComponent(afterCursor)}` : ""}`,
        headers: { Cookie: streamCookie },
      },
      (res) => {
        res.on("data", (chunk) => chunks.push(String(chunk)));
      },
    );
    req.on("error", () => {});
    req.end();
    return { chunks, close: () => req.destroy() };
  }
  /** Waits for readiness so streams register in the order they were opened. */
  async function openReadyStream(streamCookie = cookie, sessionId = "s") {
    const stream = openStream(streamCookie, sessionId);
    await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
    return stream;
  }
  function streamEvents(chunks: string[]): SessionStreamEvent[] {
    return chunks
      .join("")
      .split("\n\n")
      .filter((frame) => frame.includes("event: session-event\n"))
      .map((frame) => JSON.parse(frame.split("\ndata: ")[1]));
  }
  beforeEach(async () => {
    onPairingRequested.mockClear();
    runtime.mockReset();
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: true,
      events: [],
    });
    cookie = "";
    csrf = "";
    bootId = "";
    dir = await mkdtemp(join(tmpdir(), "agentkib-web-unit-"));
    await writeFile(join(dir, "index.html"), "<html>local web</html>");
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    origin = `http://127.0.0.1:${port}`;
    subscriptions.clear();
    nextSubscription = 0;
    hub = new ConversationHub(async (method, params) => {
      const input = params as { sessionId: string; subscriptionId: string };
      if (method === RUNTIME_METHODS.sessionsUnsubscribe) {
        subscriptions.delete(input.subscriptionId);
        return { ok: true };
      }
      const subscriptionId = `subscription-${++nextSubscription}`;
      const live = await runtime({ operation: "live", sessionId: input.sessionId });
      subscriptions.add(subscriptionId);
      return {
        subscriptionId,
        cursor: "epoch-one:0",
        events: [
          {
            protocolVersion: 2,
            subscriptionId,
            sessionId: input.sessionId,
            runtimeBootId: "runtime-one",
            epoch: "epoch-one",
            seq: 0,
            cursor: "epoch-one:0",
            type: "snapshot",
            payload: { live },
          },
        ],
      };
    });
    control = createWebControlState();
    service = new WebAccessService({
      conversationHub: hub,
      sharedControl: control,
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      receiptRequest: receiptQuery,
      onPairingRequested,
      verifiedExperimental: true,
    });
    await service.initialize();
    expect((await service.request({ operation: "status" })).running).toBe(false);
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it("only exposes direct routes to an approved device on its existing HTTPS origin", async () => {
    const controlOrigin = "https://device.control.example.com";
    const previewOrigin = "https://device.preview.example.net";
    await service.setRelayOrigins(controlOrigin, previewOrigin);
    const relay = new RelayManager({
      stateDirectory: dir,
      frpcPath: "/unused",
      target: { host: "127.0.0.1", port },
      preview: { host: "127.0.0.1", port },
    });
    (service as unknown as { relay: RelayManager }).relay = relay;
    const directConnection = {
      version: 1 as const,
      controlOrigin,
      previewOrigin,
      candidates: [{ address: "192.168.20.10", controlPort: 40001, previewPort: 40002 }],
    };
    const candidate = vi.spyOn(relay, "directConnection", "get").mockReturnValue(directConnection);
    const access = () =>
      http("/api/web/v1/access", { headers: { Host: new URL(controlOrigin).host } });
    const first = await access();
    expect(first.json().directConnection).toBeUndefined();
    cookie = first.headers["set-cookie"]![0].split(";")[0];
    const deviceId = await pair();
    const approved = (await access()).json();
    expect(approved.status).toBe("approved");
    expect(approved.directConnection).toEqual(directConnection);
    expect(
      (await http("/api/web/v1/info", { headers: { Host: new URL(controlOrigin).host } })).json()
        .directConnection,
    ).toBeUndefined();
    expect(
      (
        await http("/api/web/v1/access", {
          headers: { Cookie: cookie.replace("ak_web_secure", "ak_web_local") },
        })
      ).json().directConnection,
    ).toBeUndefined();
    candidate.mockReturnValue({ ...directConnection, controlOrigin: "https://other.example.com" });
    expect((await access()).json().directConnection).toBeUndefined();
    candidate.mockReturnValue(directConnection);
    await service.request({ operation: "revoke", id: deviceId });
    expect((await access()).json().directConnection).toBeUndefined();
  });

  it("reads only authorized Codex and Claude session contexts", async () => {
    runtime.mockImplementation(async (params) => {
      const operation = (params as { operation: string }).operation;
      if (operation === "catalog")
        return {
          sessions: [
            { id: "codex-session", workspace_id: "workspace", agent: "codex" },
            { id: "other-agent", workspace_id: "workspace", agent: "claude-code" },
          ],
        };
      if (operation === "context")
        return { available: true, cwd: "/workspace", branchAtCreation: "main" };
      return {};
    });
    expect((await http("/api/web/v1/managed/context?sessionId=codex-session")).status).toBe(401);
    await bootstrap();
    await pair();
    expect((await http("/api/web/v1/managed/context?sessionId=codex-session")).status).toBe(403);
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "",
      experimentalEnabled: true,
      allowedWorkspaceIds: ["workspace"],
    });
    const context = await http("/api/web/v1/managed/context?sessionId=codex-session");
    expect(context.status).toBe(200);
    expect(context.json()).toEqual({
      available: true,
      cwd: "/workspace",
      branchAtCreation: "main",
    });
    expect(runtime).toHaveBeenLastCalledWith({ operation: "context", sessionId: "codex-session" });
    expect((await http("/api/web/v1/managed/context?sessionId=other-agent")).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith({ operation: "context", sessionId: "other-agent" });
    expect((await http("/api/web/v1/managed/context?sessionId=unknown")).status).toBe(403);
  });

  it("scopes durable receipt queries to the paired device and current permissions", async () => {
    const id = "a169d42b-c32a-45e0-83b6-c2460c111bed";
    expect((await http(`/api/web/v1/requests/${id}`)).status).toBe(401);
    await bootstrap();
    const device = await pair(true);
    receiptQuery.mockResolvedValueOnce({ found: false, requestId: id });
    const missing = await http(`/api/web/v1/requests/${id}?deviceId=someone-else`);
    expect(missing.status).toBe(200);
    expect(missing.json().found).toBe(false);
    expect(receiptQuery).toHaveBeenLastCalledWith({ requestId: id, deviceId: device });
    receiptQuery.mockResolvedValueOnce({
      found: true,
      requestId: id,
      operation: "send",
      workspaceId: "not-authorized",
      status: "accepted",
    });
    expect((await http(`/api/web/v1/requests/${id}`)).status).toBe(403);
    receiptQuery.mockResolvedValueOnce({
      found: true,
      requestId: id,
      operation: "send",
      workspaceId: "follower-workspace",
      executionMode: "codex-follower",
      status: "accepted",
    });
    expect((await http(`/api/web/v1/requests/${id}`)).status).toBe(403);
    receiptQuery.mockResolvedValueOnce({
      found: true,
      requestId: id,
      operation: "approve",
      status: "accepted",
    });
    expect((await http(`/api/web/v1/requests/${id}`)).status).toBe(403);
    expect((await http("/api/web/v1/requests/not-a-uuid")).status).toBe(400);
  });
  it("returns only the legacy non-dispatch proof after authenticating the browser", async () => {
    const requestId = "a169d42b-c32a-45e0-83b6-c2460c111bed";
    const proof = {
      found: true,
      requestId,
      status: "not-dispatched",
      recovery: "legacy-prepared",
      completionObserved: false,
    };
    expect((await http(`/api/web/v1/requests/${requestId}`)).status).toBe(401);
    await bootstrap();
    const deviceId = await pair(true);
    receiptQuery.mockResolvedValueOnce({
      ...proof,
      sessionId: "private-session",
      workspaceId: "private-workspace",
      operation: "create",
      ack: { private: "runtime-only" },
    });
    const response = await http(`/api/web/v1/requests/${requestId}`);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual(proof);
    expect(receiptQuery).toHaveBeenLastCalledWith({ requestId, deviceId });
  });
  it("clears only the inactive fence correlated with a legacy non-dispatch proof", async () => {
    await bootstrap();
    await pair(true);
    const requestId = crypto.randomUUID();
    const body = { sessionId: "s", text: "x", requestId, bootId, expectedRevision: 4 };
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "send") throw new Error("receipt lost");
      return { runtimeBootId: "r", revision: 4, sendEnabled: true };
    });
    expect((await http("/api/web/v1/send", { method: "POST", body })).json()).toMatchObject({
      controlOutcome: "unknown",
    });
    const proof = {
      found: true,
      status: "not-dispatched",
      recovery: "legacy-prepared",
      completionObserved: false,
    };
    const otherId = crypto.randomUUID();
    receiptQuery.mockResolvedValueOnce({ ...proof, requestId: otherId });
    expect((await http(`/api/web/v1/requests/${otherId}`)).status).toBe(200);
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...body, requestId: crypto.randomUUID() },
        })
      ).json(),
    ).toMatchObject({ error: "outcome_unknown" });
    receiptQuery.mockResolvedValueOnce({ ...proof, requestId });
    expect((await http(`/api/web/v1/requests/${requestId}`)).status).toBe(200);
    // Receipt recovery itself must not issue the original control a second time.
    expect(
      runtime.mock.calls.filter(
        ([params]) => (params as { operation: string }).operation === "send",
      ),
    ).toHaveLength(1);
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "r",
      revision: 4,
      sendEnabled: true,
    });
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...body, requestId: crypto.randomUUID() },
        })
      ).status,
    ).toBe(200);
  });
  it.each(["unknown", "accepted", "wrong-request", "wrong-marker", "completed"])(
    "rejects a legacy recovery proof with %s",
    async (invalid) => {
      const requestId = "a169d42b-c32a-45e0-83b6-c2460c111bed";
      await bootstrap();
      await pair(true);
      receiptQuery.mockResolvedValueOnce({
        found: true,
        requestId: invalid === "wrong-request" ? crypto.randomUUID() : requestId,
        status: ["unknown", "accepted"].includes(invalid) ? invalid : "not-dispatched",
        recovery: invalid === "wrong-marker" ? "other" : "legacy-prepared",
        completionObserved: invalid === "completed",
      });
      expect((await http(`/api/web/v1/requests/${requestId}`)).status).toBe(503);
    },
  );
  it.each([false, true])(
    "rechecks revocation after a receipt lookup finishes (legacy=%s)",
    async (legacy) => {
      await bootstrap();
      const device = await pair(true);
      let release!: (result: unknown) => void;
      receiptQuery.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = http("/api/web/v1/requests/a169d42b-c32a-45e0-83b6-c2460c111bed");
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await service.request({ operation: "revoke", id: device });
      release(
        legacy
          ? {
              found: true,
              requestId: "a169d42b-c32a-45e0-83b6-c2460c111bed",
              status: "not-dispatched",
              recovery: "legacy-prepared",
              completionObserved: false,
            }
          : { found: false },
      );
      expect((await pending).status).toBe(401);
    },
  );
  it("allows local image attachment previews without opening blob scripts or frames", async () => {
    const response = await http("/");
    expect(response.status).toBe(200);
    const csp = String(response.headers["content-security-policy"]);
    const directives = csp.split(";").map((entry) => entry.trim());
    expect(directives.find((entry) => entry.startsWith("img-src "))?.split(" ")).toContain("blob:");
    expect(directives.find((entry) => entry.startsWith("script-src "))).toBe("script-src 'self'");
    expect(directives.find((entry) => entry.startsWith("frame-src "))).not.toContain("blob:");
  });

  it("requires pairing, same origin and CSRF; exposes no arbitrary runtime methods", async () => {
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    const access = await bootstrap();
    expect(access.headers["set-cookie"]![0]).toContain("HttpOnly; SameSite=Strict");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: {},
          headers: { Origin: "https://evil.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: {},
          headers: { "X-CSRF-Token": "bad" },
        })
      ).status,
    ).toBe(403);
    expect((await http("/", { headers: { Host: "evil.test" } })).status).toBe(403);
    expect((await http("/", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    await pair();
    expect((await http("/api/web/v1/catalog")).status).toBe(200);
    expect(
      (await http("/api/web/v1/rpc", { method: "POST", body: { method: "delete_everything" } }))
        .status,
    ).toBe(404);
    expect(runtime).toHaveBeenCalledTimes(1);
    expect((await http("/api/web/v1/events?sessionId=x&limit=10000")).status).toBe(400);
  });
  it.each(["local", "external"] as const)(
    "allows only top-level cross-site page navigation on the %s entry",
    async (entry) => {
      const headers: Record<string, string> = {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      };
      if (entry === "external") {
        await service.request({
          operation: "configure",
          enabled: true,
          port,
          externalOrigin: "https://web.example",
          experimentalEnabled: false,
        });
        headers.Host = "web.example";
      }
      for (const path of ["/", "/index.html"]) {
        for (const method of ["GET", "HEAD"]) {
          const result = await http(path, { method, headers });
          expect(result.status, `${method} ${path}`).toBe(200);
          expect(result.headers["referrer-policy"]).toBe("no-referrer");
          expect(result.headers["x-content-type-options"]).toBe("nosniff");
          expect(result.headers["set-cookie"]).toBeUndefined();
          const policy = String(result.headers["content-security-policy"]);
          for (const directive of [
            "default-src 'self'",
            "script-src 'self'",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
          ])
            expect(policy.split(";").map((value) => value.trim())).toContain(directive);
          expect(result.body).toBe(method === "HEAD" ? "" : "<html>local web</html>");
        }
      }
      expect(runtime).not.toHaveBeenCalled();
    },
  );
  it.each(["local", "external"] as const)(
    "keeps cross-site API, embedded and non-navigation requests blocked on the %s entry",
    async (entry) => {
      const headers: Record<string, string> = {
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
      };
      if (entry === "external") {
        await service.request({
          operation: "configure",
          enabled: true,
          port,
          externalOrigin: "https://web.example",
          experimentalEnabled: false,
        });
        headers.Host = "web.example";
      }
      for (const path of [
        "/api/web/v1/access",
        "/api/web/v1/catalog",
        "/assets/app.js",
        "/other",
      ]) {
        expect((await http(path, { headers })).status, path).toBe(403);
      }
      // The navigation exception uses the raw path, before URL or percent normalization.
      for (const path of [
        "/./index.html",
        "/nested/../index.html",
        "/%2e/index.html",
        "/%69ndex.html",
        "/index%2ehtml",
        "/index.html/..",
        "//index.html",
        "/index.html/",
        "/api/web/v1/../v1/access",
      ]) {
        const result = await http(path, { headers });
        expect(result.status, path).toBe(403);
        expect(result.json(), path).toEqual({ error: "cross_site_request" });
      }
      for (const method of ["POST", "OPTIONS"]) {
        expect((await http("/", { method, headers })).status, method).toBe(403);
      }
      const blockedHeaders: Record<string, string>[] = [
        { "Sec-Fetch-Dest": "iframe" },
        { "Sec-Fetch-Dest": "object" },
        { "Sec-Fetch-Dest": "empty" },
        { "Sec-Fetch-Mode": "cors" },
        { "Sec-Fetch-Mode": "same-origin" },
        { "Sec-Fetch-Mode": "" },
        { "Sec-Fetch-Dest": "" },
        { Origin: "https://evil.example" },
        { Host: "evil.example", "X-Forwarded-Host": "web.example" },
      ];
      for (const overrides of blockedHeaders) {
        expect((await http("/", { headers: { ...headers, ...overrides } })).status).toBe(403);
      }
      for (const missing of ["Sec-Fetch-Mode", "Sec-Fetch-Dest"]) {
        const incomplete = { ...headers };
        delete incomplete[missing];
        expect((await http("/", { headers: incomplete })).status, missing).toBe(403);
      }
      expect(runtime).not.toHaveBeenCalled();
    },
  );
  it("protects the workspace catalog and preserves history metadata without requiring control grants", async () => {
    const catalog = {
      indexEnabled: true,
      workspaces: [{ id: "workspace", name: "test", path: "/projects/test" }],
      sessions: [
        { id: "session", workspace_id: "workspace", origin: "interactive", git_branch: "main" },
      ],
    };
    const events = {
      events: [
        {
          id: "event",
          kind: "tool-summary",
          turn_id: "turn",
          message_phase: null,
          tool_name: "Bash",
          tool_status: "failed",
          duration_ms: 12,
          attachment_count: 0,
          truncated: true,
        },
      ],
      next_cursor: "older",
      warnings: ["read-budget-exhausted"],
    };
    runtime.mockImplementation(async (params) =>
      (params as { operation: string }).operation === "catalog" ? catalog : events,
    );
    await bootstrap();
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    expect(runtime).not.toHaveBeenCalled();
    const id = await pair(false, false);
    expect((await http("/api/web/v1/catalog")).json()).toEqual(catalog);
    expect((await http("/api/web/v1/events?sessionId=session")).json()).toEqual(events);
    await service.request({ operation: "revoke", id });
    const revoked = await http("/api/web/v1/catalog");
    expect(revoked.status).toBe(401);
    expect(revoked.body).not.toContain("/projects/test");
    expect(runtime).toHaveBeenCalledTimes(2);
  });
  it("authorizes a same-origin code immediately, persists only hashes, and revokes access", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    expect(status.code!.value).toMatch(/^\d{8}$/);
    const result = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: status.code!.value, name: "Phone" },
    });
    expect(onPairingRequested).not.toHaveBeenCalled();
    expect(result.json()).toMatchObject({
      status: "approved",
      device: { accessMode: "full", send: true, approve: true, files: true, manage: true },
    });
    expect((await http("/api/web/v1/access")).json()).toMatchObject({
      status: "approved",
      pairingMode: "code",
    });
    const id = result.json().device.id;
    const saved = await readFile(join(dir, "web-access.json"), "utf8");
    expect(saved).not.toContain(cookie.split("=")[1]);
    expect(saved).not.toContain(csrf);
    expect((await http("/api/web/v1/access")).json().status).toBe("approved");
    await service.request({ operation: "revoke", id });
    expect((await http("/api/web/v1/access")).json().status).toBe("ended");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
  });
  it("fails closed after five incorrect pairing attempts and on desktop rejection", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    for (let i = 0; i < 5; i++)
      expect(
        (await http("/api/web/v1/pair", { method: "POST", body: { code: "wrong", name: "Phone" } }))
          .status,
      ).toBe(403);
    expect(onPairingRequested).not.toHaveBeenCalled();
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: status.code!.value, name: "Phone" },
        })
      ).status,
    ).toBe(429);
    cookie = "";
    await bootstrap();
    const id = seedLegacyPending(service, cookie);
    await service.request({ operation: "reject", id });
    expect((await http("/api/web/v1/access")).json().status).toBe("ended");
  });
  it("keeps paired devices within their own budget when anonymous traffic is exhausted", async () => {
    await bootstrap();
    await pair();
    const pairedCookie = cookie;
    // 先让已配对设备占到自己的额度 key，表满后已有 key 仍应可用。
    expect((await http("/api/web/v1/catalog")).status).toBe(200);
    const rates = (service as unknown as { rates: Map<string, { count: number; until: number }> })
      .rates;
    // 模拟未认证流量打满共享额度，并把限流表撑到上限。
    rates.set("anonymous", { count: 600, until: Date.now() + 60_000 });
    for (let i = rates.size; i < 4096; i++)
      rates.set(`filler:${i}`, { count: 1, until: Date.now() + 60_000 });

    cookie = "";
    expect((await http("/api/web/v1/access")).status).toBe(429);
    cookie = pairedCookie;
    expect((await http("/api/web/v1/access")).status).toBe(200);
    expect((await http("/api/web/v1/catalog")).status).toBe(200);
  });
  it("does not let one browser's wrong guesses invalidate the code for another browser", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    for (let i = 0; i < 5; i++)
      expect(
        (await http("/api/web/v1/pair", { method: "POST", body: { code: "wrong", name: "Probe" } }))
          .status,
      ).toBe(403);
    cookie = "";
    await bootstrap();
    const paired = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: status.code!.value, name: "Phone" },
    });
    expect(paired.status).toBe(200);
    expect(paired.json().status).toBe("approved");
  });
  it("isolates send/approve permissions and prevents duplicate or stale control requests", async () => {
    await bootstrap();
    await pair(true, false);
    const body = {
      sessionId: "session",
      text: "hello",
      requestId: "one",
      bootId,
      expectedRevision: 4,
    };
    expect(
      (
        await http("/api/web/v1/approve", {
          method: "POST",
          body: { ...body, turnId: "t", approvalId: "a", decision: "accept" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, bootId: "old" } })).status,
    ).toBe(409);
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...body, expectedRevision: 3, requestId: "stale" },
        })
      ).status,
    ).toBe(409);
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "send", runtimeBootId: "runtime-one", text: "hello" }),
    );
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
    service.runtimeUnavailable();
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "new" } }))
        .status,
    ).toBe(409);
  });
  it("stops only the exact active turn and forwards it with send permission", async () => {
    await bootstrap();
    await pair(true, false);
    runtime.mockImplementation(async (params) => {
      const request = params as { operation: string };
      if (request.operation === "live")
        return {
          runtimeBootId: "runtime-one",
          revision: 9,
          status: "running",
          turnId: "turn-9",
          sendEnabled: false,
          stopEnabled: true,
          approvals: [],
        };
      return { accepted: true, runtimeBootId: "runtime-one" };
    });
    const body = {
      sessionId: "session",
      requestId: "stop-one",
      bootId,
      expectedRevision: 9,
      turnId: "turn-9",
    };
    expect((await http("/api/web/v1/stop", { method: "POST", body })).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "stop", turnId: "turn-9" }),
    );
    expect(
      (
        await http("/api/web/v1/stop", {
          method: "POST",
          body: { ...body, requestId: "stop-stale", turnId: "old-turn" },
        })
      ).status,
    ).toBe(409);
  });
  it.each([
    ["ASCII character limit", "x".repeat(16_000)],
    ["Chinese UTF-8 byte limit", "中".repeat(5_461) + "x"],
    ["emoji UTF-8 byte limit", "😀".repeat(4_096)],
  ])(
    "rejects text above the %s before runtime dispatch without fencing control",
    async (_label, boundary) => {
      await bootstrap();
      await pair(true);
      const body = {
        sessionId: "session",
        text: boundary + "x",
        requestId: "one",
        bootId,
        expectedRevision: 4,
      };
      runtime.mockClear();
      const rejected = await http("/api/web/v1/send", { method: "POST", body });
      expect(rejected.status).toBe(400);
      expect(rejected.json()).toMatchObject({ error: "invalid_text" });
      expect(runtime).not.toHaveBeenCalled();
      // Reusing the request and session proves validation consumed no request ID
      // and left neither the active-operation guard nor an outcome fence behind.
      const accepted = await http("/api/web/v1/send", {
        method: "POST",
        body: { ...body, text: boundary },
      });
      expect(accepted.status).toBe(200);
      expect(runtime).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: "send", text: boundary }),
      );
    },
  );
  it.each(["send", "approve"])(
    "reserves worker admission across %s preflight and dispatch",
    async (operation) => {
      await bootstrap();
      await pair(true, true);
      let finishPreflight!: (value: unknown) => void;
      let finishControl!: (value: unknown) => void;
      runtime.mockImplementation(async (params) => {
        const op = (params as { operation: string }).operation;
        if (op === "live")
          return new Promise((resolve) => {
            finishPreflight = resolve;
          });
        if (op === operation)
          return new Promise((resolve) => {
            finishControl = resolve;
          });
        return { sessions: [], events: [] };
      });
      const body = {
        sessionId: "s",
        text: "x",
        requestId: "r",
        bootId,
        expectedRevision: 4,
        turnId: "turn",
        approvalId: "approval",
        decision: "accept",
      };
      const control = http(`/api/web/v1/${operation}`, { method: "POST", body });
      await vi.waitFor(() => expect(finishPreflight).toBeTypeOf("function"));
      for (const path of ["catalog", "events?sessionId=s", "live?sessionId=s"]) {
        expect((await http(`/api/web/v1/${path}`)).status).toBe(409);
      }
      expect(
        (
          await http(`/api/web/v1/${operation}`, {
            method: "POST",
            body: { ...body, sessionId: "other", requestId: "other" },
          })
        ).status,
      ).toBe(409);
      expect(runtime).toHaveBeenCalledTimes(1);
      finishPreflight({
        runtimeBootId: "r",
        revision: 4,
        sendEnabled: true,
        approvals: [
          {
            requestId: "approval",
            turnId: "turn",
            supported: true,
            availableDecisions: ["accept"],
          },
        ],
      });
      await vi.waitFor(() => expect(finishControl).toBeTypeOf("function"));
      expect((await http("/api/web/v1/catalog")).status).toBe(409);
      expect(runtime.mock.calls.map(([p]) => (p as { operation: string }).operation)).toEqual([
        "live",
        operation,
      ]);
      finishControl({ accepted: true });
      expect((await control).status).toBe(200);
      expect((await http("/api/web/v1/catalog")).status).toBe(200);
    },
  );
  it("lets existing reads drain before the reserved preflight dispatches control", async () => {
    await bootstrap();
    await pair(true);
    let finishRead!: () => void;
    const readFinished = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    let reading = false;
    runtime.mockImplementation(async (params) => {
      const op = (params as { operation: string }).operation;
      if (op === "catalog") {
        reading = true;
        await readFinished;
        reading = false;
        return { sessions: [] };
      }
      if (op === "live") {
        await readFinished;
        return { runtimeBootId: "r", revision: 4, sendEnabled: true };
      }
      if (reading) throw new Error("web-busy");
      return { accepted: true };
    });
    const catalog = http("/api/web/v1/catalog");
    await vi.waitFor(() => expect(reading).toBe(true));
    const control = http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
    });
    await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
    expect((await http("/api/web/v1/events?sessionId=s")).status).toBe(409);
    finishRead();
    expect((await catalog).status).toBe(200);
    expect((await control).status).toBe(200);
    expect(runtime.mock.calls.map(([p]) => (p as { operation: string }).operation)).toEqual([
      "catalog",
      "live",
      "send",
    ]);
  });
  it("releases read admission after preflight rejection without fencing the session", async () => {
    await bootstrap();
    await pair(true);
    runtime.mockRejectedValueOnce(new Error("preflight unavailable"));
    const body = { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 };
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(500);
    expect((await http("/api/web/v1/catalog")).status).toBe(200);
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "retry" } }))
        .status,
    ).toBe(200);
  });
  it("marks only definitive pre-dispatch control rejections as not dispatched", async () => {
    await bootstrap();
    await pair(true);
    const body = { sessionId: "s", text: "x", requestId: "stale", bootId, expectedRevision: 3 };
    const stale = await http("/api/web/v1/send", { method: "POST", body });
    expect(stale.json()).toMatchObject({ error: "stale_state", controlOutcome: "not-dispatched" });
    expect(runtime).toHaveBeenCalledTimes(1);
    runtime.mockRejectedValueOnce(new Error("preflight failed"));
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...body, requestId: "preflight" },
        })
      ).json(),
    ).toMatchObject({ error: "request_failed", controlOutcome: "not-dispatched" });
    runtime.mockImplementation(async (params) => {
      if ((params as { operation: string }).operation === "send") throw new Error("receipt lost");
      return { runtimeBootId: "r", revision: 4, sendEnabled: true };
    });
    const dispatched = { ...body, requestId: "dispatched", expectedRevision: 4 };
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: dispatched })).json(),
    ).toMatchObject({ error: "request_failed", controlOutcome: "unknown" });
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: dispatched })).json(),
    ).toMatchObject({ error: "duplicate_request", controlOutcome: "unknown" });
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { ...dispatched, requestId: "new" },
        })
      ).json(),
    ).toMatchObject({ error: "outcome_unknown", controlOutcome: "unknown" });
  });
  it.each(["send", "approve"])(
    "releases the fence for a correlated bridge %s preflight rejection",
    async (operation) => {
      await bootstrap();
      await pair(true, true);
      const snapshot = {
        runtimeBootId: "r",
        revision: 4,
        sendEnabled: true,
        approvals: [
          { requestId: "a", turnId: "t", supported: true, availableDecisions: ["accept"] },
        ],
      };
      runtime.mockImplementation(async (params) => {
        const p = params as Record<string, unknown>;
        return p.operation === operation
          ? {
              accepted: false,
              completed: false,
              controlOutcome: "not-dispatched",
              requestId: p.requestId,
              runtimeBootId: "r",
            }
          : snapshot;
      });
      const body = {
        sessionId: "s",
        text: "x",
        requestId: "first",
        bootId,
        expectedRevision: 4,
        approvalId: "a",
        turnId: "t",
        decision: "accept",
      };
      const rejected = await http(`/api/web/v1/${operation}`, { method: "POST", body });
      expect(rejected.status).toBe(409);
      expect(rejected.json()).toMatchObject({ controlOutcome: "not-dispatched" });
      expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(true);
      runtime.mockResolvedValue({ ...snapshot, accepted: true });
      expect(
        (
          await http(`/api/web/v1/${operation}`, {
            method: "POST",
            body: { ...body, requestId: "fresh" },
          })
        ).status,
      ).toBe(200);
    },
  );
  it.each(
    ["send", "approve"].flatMap((operation) =>
      [
        { requestId: "wrong" },
        { runtimeBootId: "wrong" },
        { controlOutcome: undefined },
        { accepted: undefined },
        { completed: undefined },
      ].map((override) => ({ operation, override })),
    ),
  )(
    "does not release a fence for an uncorrelated rejection %j",
    async ({ operation, override }) => {
      await bootstrap();
      await pair(true, true);
      runtime.mockImplementation(async (params) =>
        (params as { operation: string }).operation === operation
          ? {
              accepted: false,
              completed: false,
              requestId: "first",
              runtimeBootId: "r",
              controlOutcome: "not-dispatched",
              ...override,
            }
          : {
              runtimeBootId: "r",
              revision: 4,
              sendEnabled: true,
              approvals: [
                { requestId: "a", turnId: "t", supported: true, availableDecisions: ["accept"] },
              ],
            },
      );
      const body = {
        sessionId: "s",
        text: "x",
        requestId: "first",
        bootId,
        expectedRevision: 4,
        approvalId: "a",
        turnId: "t",
        decision: "accept",
      };
      const result = await http(`/api/web/v1/${operation}`, { method: "POST", body });
      expect(result.status).toBe(502);
      expect(result.json()).toMatchObject({ error: "outcome_unknown", controlOutcome: "unknown" });
      expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(false);
      expect(
        (
          await http(`/api/web/v1/${operation}`, {
            method: "POST",
            body: { ...body, requestId: "fresh" },
          })
        ).json(),
      ).toMatchObject({ controlOutcome: "unknown" });
    },
  );
  it("streams native deltas without periodic live reads, including a large baseline", async () => {
    await bootstrap();
    await pair();
    runtime.mockResolvedValue({
      runtimeBootId: "r",
      revision: 1,
      streamText: "x".repeat(1024 * 1024),
    });
    const stream = openStream();
    try {
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-event"));
      pushEvent("text-delta", { text: "实时", offset: 1048576 });
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("实时"));
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(runtime).toHaveBeenCalledTimes(1);
      expect(stream.chunks.join("").match(/"type":"snapshot"/g)).toHaveLength(1);
      expect(stream.chunks.join("")).toContain("id: epoch-one:1");
    } finally {
      stream.close();
    }
  });

  it.each([false, true])(
    "uses the same context projection for HTTP and SSE, full access=%s",
    async (full) => {
      await service.shutdown();
      service = new WebAccessService({
        conversationHub: hub,
        sharedControl: control,
        dataDir: dir,
        staticDir: dir,
        runtimeRequest: runtime,
        verifiedCodex: true,
        workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: dir }],
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
      await bootstrap();
      if (full) {
        const code = (await service.request({ operation: "generate-code" })).code!.value;
        expect(
          (await http("/api/web/v1/pair", { body: { code, name: "Fixture" }, method: "POST" }))
            .status,
        ).toBe(200);
      } else await pair();
      const tokenUsage = {
        last: { totalTokens: 3000 },
        total: { totalTokens: 12000 },
        modelContextWindow: 48000,
      };
      const usage = { available: true, tokenUsage, reportGeneration: 2, reportId: 3 };
      runtime.mockImplementation(async (params) =>
        (params as { operation: string }).operation === "catalog"
          ? { sessions: [{ id: "s", workspace_id: "workspace", agent: "codex" }] }
          : {
              executionMode: "codex-managed",
              workspaceId: "workspace",
              runtimeBootId: "runtime-one",
              revision: 4,
              sendEnabled: true,
              tokenUsage,
              usage,
            },
      );
      const live = await http("/api/web/v1/live?sessionId=s");
      expect(live.status).toBe(200);
      expect(live.json()).not.toHaveProperty("tokenUsage");
      if (full)
        expect(live.json().usage).toMatchObject({
          state: "ready",
          usedTokens: 3000,
          percent: 6.25,
          reportGeneration: 2,
          reportId: 3,
        });
      else expect(live.json()).not.toHaveProperty("usage");
      const stream = openStream();
      try {
        await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
        expect(streamEvents(stream.chunks)[0].payload.live).toEqual(live.json());
        const before = runtime.mock.calls.length;
        pushEvent("state", { revision: 5, tokenUsage, usage, activity: "compacting" });
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(2));
        const patch = streamEvents(stream.chunks)[1].payload;
        expect(patch).not.toHaveProperty("tokenUsage");
        if (full) {
          expect(patch.usage).toMatchObject({
            state: "pending",
            usedTokens: 3000,
            reportGeneration: 2,
            reportId: 3,
          });
          expect(patch.usage).not.toHaveProperty("percent");
        } else expect(patch).not.toHaveProperty("usage");
        pushEvent("state", { revision: 6, activity: null }, 2);
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(3));
        expect(streamEvents(stream.chunks)[2].payload).toEqual({ revision: 6, activity: null });
        expect(runtime.mock.calls).toHaveLength(before);
      } finally {
        stream.close();
      }
    },
  );

  it.each([
    { name: "a newly observed auto mode", raw: { mode: "auto" }, expected: { mode: "auto" } },
    { name: "dontAsk", raw: { mode: "dontAsk" }, expected: { mode: "dontAsk" } },
    {
      name: "bypassPermissions",
      raw: { mode: "bypassPermissions" },
      expected: { mode: "bypassPermissions" },
    },
    { name: "a selectable mode", raw: { mode: "plan" }, expected: { mode: "plan" } },
    { name: "an explicit clear", raw: { mode: null }, expected: { mode: null } },
    {
      name: "the unknown-mode hint",
      raw: { mode: null, possiblyAuto: true },
      expected: { mode: null, possiblyAuto: true },
    },
    {
      name: "a previously observed mode",
      raw: { mode: "auto", previous: true },
      expected: { mode: "auto", previous: true },
    },
    {
      name: "unknown extra keys, which are stripped",
      raw: { mode: "auto", note: "x", nested: { deep: 1 } },
      expected: { mode: "auto" },
    },
    { name: "an unlisted mode word", raw: { mode: "yolo" }, expected: undefined },
    { name: "the CLI manual alias", raw: { mode: "manual" }, expected: undefined },
    { name: "a mode in a different case", raw: { mode: "AUTO" }, expected: undefined },
    { name: "a numeric mode", raw: { mode: 1 }, expected: undefined },
    { name: "a missing mode", raw: {}, expected: undefined },
    { name: "a bare string", raw: "auto", expected: undefined },
    { name: "an array", raw: [{ mode: "auto" }], expected: undefined },
    { name: "null", raw: null, expected: undefined },
    { name: "previous=false", raw: { mode: "auto", previous: false }, expected: undefined },
    { name: "previous as a string", raw: { mode: "auto", previous: "true" }, expected: undefined },
    {
      name: "previous without a mode",
      raw: { mode: null, previous: true },
      expected: undefined,
    },
    {
      name: "possiblyAuto=false",
      raw: { mode: null, possiblyAuto: false },
      expected: undefined,
    },
    {
      name: "possiblyAuto beside a known mode",
      raw: { mode: "auto", possiblyAuto: true },
      expected: undefined,
    },
  ])(
    "projects only a well-formed permission view in HTTP, snapshots and state patches: $name",
    async ({ raw, expected }) => {
      await bootstrap();
      await pair();
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: ["workspace"],
      });
      runtime.mockImplementation(async (params) =>
        (params as { operation: string }).operation === "catalog"
          ? { sessions: [{ id: "s", workspace_id: "workspace", agent: "claude-code" }] }
          : {
              executionMode: "claude-managed",
              workspaceId: "workspace",
              runtimeBootId: "runtime-one",
              revision: 4,
              sendEnabled: true,
              permission: raw,
            },
      );
      const live = (await http("/api/web/v1/live?sessionId=s")).json();
      if (expected) expect(live.permission).toEqual(expected);
      else expect(live).not.toHaveProperty("permission");
      // The rest of the live object is passed through unchanged.
      expect(live).toMatchObject({ executionMode: "claude-managed", revision: 4 });
      const stream = openStream();
      try {
        await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
        const snapshot = streamEvents(stream.chunks)[0].payload.live as Record<string, unknown>;
        if (expected) expect(snapshot.permission).toEqual(expected);
        else expect(snapshot).not.toHaveProperty("permission");
        pushEvent("state", { revision: 5, permission: raw });
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(2));
        const patch = streamEvents(stream.chunks)[1].payload;
        expect(patch.revision).toBe(5);
        if (expected) expect(patch.permission).toEqual(expected);
        else expect(patch).not.toHaveProperty("permission");
        // A patch without the field leaves the client's previous value alone.
        pushEvent("state", { revision: 6 }, 2);
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(3));
        expect(streamEvents(stream.chunks)[2].payload).toEqual({ revision: 6 });
      } finally {
        stream.close();
      }
    },
  );

  it.each(
    ["codex-managed", "claude-managed"].flatMap((executionMode) =>
      [false, true].map((allowed) => ({ executionMode, allowed })),
    ),
  )(
    "preserves $executionMode workspace authorization across metadata-free state patches: allowed=$allowed",
    async ({ executionMode, allowed }) => {
      await service.request({
        operation: "configure",
        enabled: true,
        port,
        externalOrigin: "",
        experimentalEnabled: true,
        allowedWorkspaceIds: allowed ? ["workspace"] : [],
      });
      await bootstrap();
      await pair(true, true);
      const controls = {
        sendEnabled: true,
        stopEnabled: true,
        approvals: [{ requestId: "approval", supported: true, availableDecisions: ["accept"] }],
        questions: [{ requestId: "question", supported: true, questions: [] }],
      };
      const live = {
        runtimeBootId: "runtime-one",
        executionMode,
        workspaceId: "workspace",
        revision: 4,
        ...controls,
      };
      runtime.mockResolvedValue(live);
      const expectedControls = {
        ...controls,
        sendEnabled: allowed,
        stopEnabled: allowed,
        approvals: [
          {
            ...controls.approvals[0],
            supported: allowed,
            availableDecisions: allowed ? ["accept"] : [],
          },
        ],
        questions: [{ ...controls.questions[0], supported: allowed }],
      };
      const stream = openStream();
      try {
        await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
        expect(streamEvents(stream.chunks)[0].payload.live).toEqual({
          ...live,
          ...expectedControls,
        });
        expect(runtime).toHaveBeenCalledTimes(1);
        pushEvent("state", { revision: 5, ...controls });
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(2));
        expect(streamEvents(stream.chunks)[1].payload).toEqual({
          revision: 5,
          ...expectedControls,
        });
        pushEvent("state", { revision: 6 }, 2);
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(3));
        expect(streamEvents(stream.chunks)[2].payload).toEqual({ revision: 6 });
        expect(runtime).toHaveBeenCalledTimes(1);
      } finally {
        stream.close();
      }
    },
  );

  it("keeps an unverified provider disabled in snapshots and metadata-free state patches", async () => {
    await service.shutdown();
    service = new WebAccessService({
      conversationHub: hub,
      sharedControl: control,
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      verifiedCodex: true,
    });
    await service.initialize();
    await bootstrap();
    await pair(true, true);
    const controls = {
      sendEnabled: true,
      stopEnabled: true,
      approvals: [{ requestId: "approval", supported: true, availableDecisions: ["accept"] }],
      questions: [{ requestId: "question", supported: true, questions: [] }],
    };
    const live = {
      runtimeBootId: "runtime-one",
      executionMode: "managed-resume",
      revision: 4,
      ...controls,
    };
    const disabled = {
      ...controls,
      sendEnabled: false,
      stopEnabled: false,
      approvals: [{ ...controls.approvals[0], supported: false, availableDecisions: [] }],
      questions: [{ ...controls.questions[0], supported: false }],
    };
    runtime.mockResolvedValue(live);
    const stream = openStream();
    try {
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
      expect(streamEvents(stream.chunks)[0].payload.live).toEqual({ ...live, ...disabled });
      pushEvent("state", { revision: 5, ...controls });
      await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(2));
      expect(streamEvents(stream.chunks)[1].payload).toEqual({ revision: 5, ...disabled });
      expect(runtime).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  });

  it.each([false, true])(
    "loads replay authorization metadata once and queues newer events behind replay: partial=%s",
    async (partial) => {
      await bootstrap();
      await pair(true, true);
      const controls = {
        sendEnabled: true,
        stopEnabled: true,
        approvals: [{ requestId: "approval", supported: true, availableDecisions: ["accept"] }],
        questions: [{ requestId: "question", supported: true, questions: [] }],
      };
      const live = {
        runtimeBootId: "runtime-one",
        executionMode: "codex-managed",
        workspaceId: "not-authorized",
        revision: 100,
        streamText: "newer state must not replace replay",
        ...controls,
      };
      let resolveMetadata!: (value: unknown) => void;
      const metadata = new Promise<unknown>((resolve) => {
        resolveMetadata = resolve;
      });
      // The hub fixture reads its native baseline once before returning our replay.
      runtime.mockResolvedValueOnce(live).mockImplementationOnce(() => metadata);
      const subscribe = hub.subscribe.bind(hub);
      vi.spyOn(hub, "subscribe").mockImplementationOnce(async (...args) => {
        const result = await subscribe(...args);
        return {
          ...result,
          cursor: `epoch-one:${partial ? 1 : 0}`,
          events: partial
            ? [
                {
                  ...result.events[0],
                  type: "state",
                  seq: 1,
                  cursor: "epoch-one:1",
                  payload: { revision: 5, ...controls },
                },
              ]
            : [],
        };
      });
      const stream = openStream(cookie, "s", "epoch-one:0");
      try {
        await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(2));
        expect(runtime).toHaveBeenLastCalledWith({
          operation: "live",
          sessionId: "s",
          experimentalEnabled: true,
        });
        const nextSeq = partial ? 2 : 1;
        pushEvent("state", { revision: 6, ...controls }, nextSeq);
        expect(streamEvents(stream.chunks)).toEqual([]);
        expect(stream.chunks.join("")).not.toContain("event: session-ready");
        resolveMetadata(live);
        await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
        const events = streamEvents(stream.chunks);
        expect(events.map((event) => event.seq)).toEqual(partial ? [1, 2] : [1]);
        expect(events.map((event) => event.payload.revision)).toEqual(partial ? [5, 6] : [6]);
        for (const event of events) {
          expect(event.type).toBe("state");
          expect(event.payload).toEqual({
            revision: event.payload.revision,
            sendEnabled: false,
            stopEnabled: false,
            approvals: [{ ...controls.approvals[0], supported: false, availableDecisions: [] }],
            questions: [{ ...controls.questions[0], supported: false }],
          });
        }
        expect(stream.chunks.join("")).toContain(
          `event: session-ready\ndata: {"cursor":"epoch-one:${nextSeq}"}`,
        );
        expect(stream.chunks.join("")).not.toContain(live.streamText);
        pushEvent("state", { revision: 7 }, nextSeq + 1);
        await vi.waitFor(() => expect(streamEvents(stream.chunks)).toHaveLength(events.length + 1));
        expect(streamEvents(stream.chunks).at(-1)!.payload).toEqual({ revision: 7 });
        expect(runtime).toHaveBeenCalledTimes(2);
      } finally {
        resolveMetadata(live);
        stream.close();
      }
    },
  );

  it.each(["close", "revoke", "timeout"])(
    "cleans up a backpressured event stream on %s",
    async (reason) => {
      await bootstrap();
      const id = await pair();
      let response: ServerResponse | undefined;
      let expireDrain: (() => void) | undefined;
      const timeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 30_000) expireDrain = callback;
        return timeout(callback, delay, ...args);
      }) as typeof setTimeout);
      const original = ServerResponse.prototype.write;
      vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<typeof original>
      ) {
        if (String(args[0]).startsWith("id: ")) {
          response = this;
          return false;
        }
        return original.apply(this, args);
      });
      const stream = openStream();
      try {
        await vi.waitFor(() => expect(response?.listenerCount("drain")).toBe(1));
        if (reason === "close") stream.close();
        else if (reason === "revoke") await service.request({ operation: "revoke", id });
        else expireDrain!();
        await vi.waitFor(() => expect(response!.listenerCount("drain")).toBe(0));
        await vi.waitFor(() => expect(response!.destroyed || response!.writableEnded).toBe(true));
        await vi.waitFor(() => expect(subscriptions.size).toBe(0));
      } finally {
        stream.close();
      }
    },
  );

  it("queues ordered events until drain without resending an accepted frame", async () => {
    await bootstrap();
    await pair();
    let response: ServerResponse | undefined;
    const original = ServerResponse.prototype.write;
    const frames: string[] = [];
    const spy = vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).startsWith("id: ")) {
        frames.push(String(args[0]));
        response = this;
        return false;
      }
      return original.apply(this, args);
    });
    const stream = openStream();
    try {
      await vi.waitFor(() => expect(frames).toHaveLength(1));
      pushEvent("text-delta", { text: "one", offset: 0 });
      expect(frames).toHaveLength(1);
      response!.emit("drain");
      await vi.waitFor(() => expect(frames).toHaveLength(2));
      expect(frames[1]).toContain("epoch-one:1");
      expect(runtime).toHaveBeenCalledTimes(1);
      response!.emit("drain");
    } finally {
      stream.close();
      spy.mockRestore();
    }
  });

  it("marks replay ready at the last event delivered after backpressure", async () => {
    await bootstrap();
    await pair();
    const subscribe = hub.subscribe.bind(hub);
    vi.spyOn(hub, "subscribe").mockImplementationOnce(async (...args) => {
      const result = await subscribe(...args);
      return {
        ...result,
        cursor: "epoch-one:1",
        events: [
          {
            ...result.events[0],
            type: "state",
            seq: 1,
            cursor: "epoch-one:1",
            payload: { revision: 5 },
          },
        ],
      };
    });
    const responses: ServerResponse[] = [];
    const frames: string[] = [];
    const original = ServerResponse.prototype.write;
    vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
      this: ServerResponse,
      ...args: Parameters<typeof original>
    ) {
      frames.push(String(args[0]));
      if (String(args[0]).startsWith("id: epoch-one:1\n")) {
        responses.push(this);
        return false;
      }
      return original.apply(this, args);
    });
    const stream = openStream(cookie, "s", "epoch-one:0");
    try {
      await vi.waitFor(() => expect(responses[0]?.listenerCount("drain")).toBe(1));
      pushEvent("state", { revision: 6 }, 2);
      responses[0].emit("drain");
      await vi.waitFor(() =>
        expect(frames.some((frame) => frame.includes("session-ready"))).toBe(true),
      );
      expect(frames.map((frame) => frame.split("\n")[0])).toEqual([
        "id: epoch-one:1",
        "id: epoch-one:2",
        "event: session-ready",
      ]);
      expect(frames[2]).toContain('"cursor":"epoch-one:2"');
      expect(hub.subscribe).toHaveBeenCalledWith("s", "epoch-one:0", expect.any(Function));
    } finally {
      stream.close();
    }
  });

  it("wakes global receipt reconciliation without disclosing the changed session", async () => {
    await bootstrap();
    await pair();
    const stream = openStream(cookie, "");
    try {
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
      const access = await service.localRequest("/access");
      runtime.mockImplementation(async (input) => {
        const params = input as { operation: string };
        if (params.operation === "catalog")
          return {
            workspaces: [{ id: "workspace", name: "Workspace", path: dir }],
            sessions: [{ id: "private-session", workspace_id: "workspace", agent: "codex" }],
          };
        if (params.operation === "live")
          return { runtimeBootId: "r", revision: 4, sendEnabled: true, approvals: [] };
        return { accepted: true };
      });
      expect(
        await service.localRequest("/send", {
          sessionId: "private-session",
          text: "hello",
          requestId: "global-receipt",
          expectedRevision: 4,
          bootId: (access.body as { bootId: string }).bootId,
        }),
      ).toMatchObject({ status: 200 });
      await vi.waitFor(() =>
        expect(stream.chunks.join("")).toContain("event: control-changed\ndata: {}"),
      );
      expect(stream.chunks.join("")).not.toContain("private-session");
    } finally {
      stream.close();
    }
  });

  it.each(["resume", "revoke", "expire"])(
    "retains global catalog invalidations during backpressure and rechecks access on %s",
    async (action) => {
      await bootstrap();
      const deviceId = await pair();
      let response: ServerResponse | undefined;
      const frames: string[] = [];
      const original = ServerResponse.prototype.write;
      vi.spyOn(ServerResponse.prototype, "write").mockImplementation(function (
        this: ServerResponse,
        ...args: Parameters<typeof original>
      ) {
        const frame = String(args[0]);
        frames.push(frame);
        const accepted = original.apply(this, args);
        if (frame.startsWith("event: control-changed")) {
          response = this;
          return false;
        }
        return accepted;
      });
      const stream = openStream(cookie, "");
      try {
        await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
        control.events.emit("changed", "private-session");
        await vi.waitFor(() => expect(response?.listenerCount("drain")).toBe(1));
        pushEvent("invalidate", { domains: ["catalog"] }, 1);
        pushEvent("invalidate", { domains: ["catalog"] }, 2);
        const catalogFrames = () =>
          frames.filter((frame) => frame.startsWith("event: catalog-invalidated"));
        expect(catalogFrames()).toHaveLength(0);
        if (action === "revoke") await service.request({ operation: "revoke", id: deviceId });
        else if (action === "expire")
          vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000);
        response!.emit("drain");
        if (action === "resume") {
          await vi.waitFor(() => expect(catalogFrames()).toHaveLength(1));
          expect(response!.writableEnded).toBe(false);
          pushEvent("invalidate", { domains: ["catalog"] }, 3);
          await vi.waitFor(() => expect(catalogFrames()).toHaveLength(2));
        } else {
          await vi.waitFor(() => expect(response!.writableEnded).toBe(true));
          expect(catalogFrames()).toHaveLength(0);
          await vi.waitFor(() => expect(subscriptions.size).toBe(0));
        }
        expect(stream.chunks.join("")).not.toContain("private-session");
      } finally {
        stream.close();
      }
    },
  );

  it("independently rechecks revocation while subscribers initialize", async () => {
    await bootstrap();
    const readOnlyId = await pair();
    const firstCookie = cookie;
    cookie = "";
    await bootstrap();
    await pair(true);
    const finishes: Array<(value: unknown) => void> = [];
    runtime.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const first = openStream(firstCookie);
    const second = openStream();
    try {
      await vi.waitFor(() => expect(finishes).toHaveLength(2));
      await service.request({ operation: "revoke", id: readOnlyId });
      finishes.forEach((finish) => finish({ revision: 8, events: [] }));
      await vi.waitFor(() => expect(second.chunks.join("")).toContain("event: session-event"));
      expect(first.chunks.join("")).toContain("event: access-ended");
      expect(first.chunks.join("")).not.toContain("event: session-event");
    } finally {
      finishes.forEach((finish) => finish({}));
      first.close();
      second.close();
    }
  });

  it("lets a device's newest stream replace its oldest one at the per-device limit", async () => {
    await bootstrap();
    await pair();
    const registry = (service as unknown as { streams: Map<unknown, unknown> }).streams;
    const streams: ReturnType<typeof openStream>[] = [];
    try {
      // After a network change the oldest connection can stay half-open while the
      // same device reconnects; the reconnect must not wait for that slot.
      streams.push(await openReadyStream());
      streams.push(await openReadyStream(cookie, ""));
      streams.push(await openReadyStream());
      const [stale, catalog, replacement] = streams;
      await vi.waitFor(() => expect(stale.chunks.join("")).toContain("event: unavailable"));
      expect(catalog.chunks.join("")).not.toContain("event: unavailable");
      expect(replacement.chunks.join("")).not.toContain("event: unavailable");
      expect(registry.size).toBe(2);
      await vi.waitFor(() => expect(subscriptions.size).toBe(2));
    } finally {
      streams.forEach((stream) => stream.close());
    }
  });

  it("only replaces streams owned by the reconnecting device", async () => {
    await bootstrap();
    await pair();
    const otherCookie = cookie;
    cookie = "";
    await bootstrap();
    await pair();
    const registry = (service as unknown as { streams: Map<unknown, unknown> }).streams;
    const streams: ReturnType<typeof openStream>[] = [];
    try {
      // The other device holds the oldest streams in the table, yet stays untouched.
      streams.push(await openReadyStream(otherCookie));
      streams.push(await openReadyStream(otherCookie, ""));
      streams.push(await openReadyStream());
      streams.push(await openReadyStream(cookie, ""));
      streams.push(await openReadyStream());
      await vi.waitFor(() => expect(streams[2].chunks.join("")).toContain("event: unavailable"));
      for (const stream of [streams[0], streams[1], streams[3], streams[4]])
        expect(stream.chunks.join("")).not.toContain("event: unavailable");
      expect(registry.size).toBe(4);
    } finally {
      streams.forEach((stream) => stream.close());
    }
  });

  it("asks clients to retry when the stream table is full, without evicting other devices", async () => {
    // Every stream listens for hub unavailability; sixteen exceed EventEmitter's warning threshold.
    hub.setMaxListeners(32);
    const devices: string[] = [];
    for (let index = 0; index < 8; index++) {
      cookie = "";
      await bootstrap();
      await pair();
      devices.push(cookie);
    }
    const registry = (service as unknown as { streams: Map<unknown, unknown> }).streams;
    const streams: ReturnType<typeof openStream>[] = [];
    try {
      for (const device of devices) {
        streams.push(await openReadyStream(device));
        streams.push(await openReadyStream(device, ""));
      }
      expect(registry.size).toBe(16);
      cookie = "";
      await bootstrap();
      await pair();
      const rejected = await http("/api/web/v1/stream?protocolVersion=2&sessionId=s");
      expect(rejected.status).toBe(429);
      expect(rejected.headers["retry-after"]).toBe("3");
      expect(rejected.json()).toMatchObject({ error: "stream_limit" });
      expect(registry.size).toBe(16);
      // A device at its own limit still replaces its oldest stream in a full table.
      streams.push(await openReadyStream(devices[0]));
      await vi.waitFor(() => expect(streams[0].chunks.join("")).toContain("event: unavailable"));
      for (const stream of streams.slice(1))
        expect(stream.chunks.join("")).not.toContain("event: unavailable");
      expect(registry.size).toBe(16);
    } finally {
      streams.forEach((stream) => stream.close());
    }
  });

  it("refuses old controls before dispatch but retains history access", async () => {
    await bootstrap();
    await pair(true);
    const response = await http("/api/web/v1/send", {
      method: "POST",
      headers: { "X-AgentKib-Protocol": "1" },
      body: { sessionId: "s", text: "hello", requestId: "old", bootId, expectedRevision: 4 },
    });
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({
      error: "incompatible_protocol",
      controlOutcome: "not-dispatched",
    });
    expect(runtime).not.toHaveBeenCalled();
    expect((await http("/api/web/v1/events?sessionId=s")).status).toBe(200);
  });

  it("shares desktop commands and native state with Remote without refreshing history", async () => {
    await bootstrap();
    await pair(true, true);
    const live = {
      sessionId: "s",
      workspaceId: "workspace",
      executionMode: "codex-managed",
      runtimeBootId: "runtime-one",
      revision: 4,
      status: "idle",
      sendEnabled: true,
      approvals: [],
      questions: [],
    };
    runtime.mockImplementation(async (params) => {
      const input = params as { operation: string };
      if (input.operation === "catalog")
        return {
          workspaces: [{ id: "workspace", name: "Workspace", path: dir }],
          sessions: [{ id: "s", workspace_id: "workspace", agent: "codex" }],
        };
      if (input.operation === "send") {
        pushEvent("state", { status: "running", revision: 5, sendEnabled: false, turnId: "turn" });
        return { accepted: true };
      }
      return live;
    });
    const localEvents: unknown[] = [];
    const local = await service.localSubscribe("s", undefined, (event) => localEvents.push(event));
    const remote = openStream();
    try {
      await vi.waitFor(() => expect(remote.chunks.join("")).toContain('"type":"snapshot"'));
      expect(
        await service.localRequest("send", {
          sessionId: "s",
          text: "hello",
          requestId: "desktop-send",
          expectedRevision: 4,
          bootId,
        }),
      ).toMatchObject({ status: 200, body: { accepted: true } });
      await vi.waitFor(() => expect(remote.chunks.join("")).toContain('"status":"running"'));
      expect(localEvents).toContainEqual(
        expect.objectContaining({
          type: "state",
          payload: expect.objectContaining({ status: "running" }),
        }),
      );
      await vi.waitFor(() => expect(remote.chunks.join("")).toContain("event: control-changed"));
      pushEvent("text-delta", { itemId: "reply", turnId: "turn", text: "native", offset: 0 }, 2);
      await vi.waitFor(() => expect(remote.chunks.join("")).toContain('"text":"native"'));
      expect(
        runtime.mock.calls.some(
          ([input]) => (input as { operation: string }).operation === "events",
        ),
      ).toBe(false);
    } finally {
      remote.close();
      await hub.unsubscribe(local.subscriptionId);
    }
  });

  it("opens a full-access native observation while another command is pending", async () => {
    await bootstrap();
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    expect(
      (await http("/api/web/v1/pair", { method: "POST", body: { code, name: "Phone" } })).status,
    ).toBe(200);
    let settle!: (value: unknown) => void;
    runtime.mockImplementation(async (params) => {
      const input = params as { operation: string };
      if (input.operation === "catalog")
        return {
          workspaces: [{ id: "workspace", name: "Workspace", path: dir }],
          sessions: [{ id: "s", workspace_id: "workspace", agent: "codex" }],
        };
      if (input.operation === "send")
        return new Promise((resolve) => {
          settle = resolve;
        });
      return {
        sessionId: "s",
        workspaceId: "workspace",
        executionMode: "codex-managed",
        runtimeBootId: "r",
        revision: 4,
        status: "idle",
        sendEnabled: true,
        approvals: [],
        questions: [],
      };
    });
    const control = service.localRequest("send", {
      sessionId: "s",
      text: "hello",
      requestId: "desktop-send",
      expectedRevision: 4,
      bootId,
    });
    await vi.waitFor(() => expect(settle).toBeTypeOf("function"));
    const stream = openStream();
    try {
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("event: session-ready"));
      pushEvent("text-delta", { itemId: "reply", text: "while pending", offset: 0 });
      await vi.waitFor(() => expect(stream.chunks.join("")).toContain("while pending"));
    } finally {
      stream.close();
      settle({ accepted: true });
      await control;
    }
  });

  it("keeps SSE connected across reserved preflight and mutation, while revocation still closes it", async () => {
    await bootstrap();
    const id = await pair(true);
    const chunks: string[] = [];
    let streamRequest: ReturnType<typeof request> | undefined;
    const ended = new Promise<void>((resolve, reject) => {
      streamRequest = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=s&protocolVersion=2",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.on("data", (chunk) => chunks.push(String(chunk)));
          res.on("end", resolve);
        },
      );
      streamRequest.on("error", reject);
      streamRequest.end();
    });
    let preflight!: (value: unknown) => void;
    let mutation!: (value: unknown) => void;
    try {
      await vi.waitFor(() => expect(chunks.join("")).toContain("event: session-event"));
      runtime.mockImplementation(
        async (params) =>
          new Promise((resolve) => {
            if ((params as { operation: string }).operation === "send") mutation = resolve;
            else preflight = resolve;
          }),
      );
      const control = http("/api/web/v1/send", {
        method: "POST",
        body: { sessionId: "s", text: "x", requestId: "reserved", bootId, expectedRevision: 4 },
      });
      await vi.waitFor(() => expect(preflight).toBeTypeOf("function"));
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(chunks.join("")).not.toContain("event: unavailable");
      expect(runtime).toHaveBeenCalledTimes(2);
      preflight({ runtimeBootId: "r", revision: 4, sendEnabled: true });
      await vi.waitFor(() => expect(mutation).toBeTypeOf("function"));
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(chunks.join("")).not.toContain("event: unavailable");
      expect(runtime).toHaveBeenCalledTimes(3);
      await service.request({ operation: "revoke", id });
      await ended;
      expect(chunks.join("")).toContain("event: access-ended");
      mutation({ accepted: true });
      expect((await control).json()).toMatchObject({
        error: "access_ended",
        controlOutcome: "unknown",
      });
    } finally {
      preflight?.({ runtimeBootId: "r", revision: 4, sendEnabled: true });
      mutation?.({ accepted: true });
      streamRequest?.destroy();
    }
  }, 10_000);
  it("rejects concurrent control and withholds results after authorization is revoked", async () => {
    await bootstrap();
    const id = await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "runtime-one", revision: 4, sendEnabled: true },
    );
    const body = {
      sessionId: "session",
      text: "hello",
      requestId: "one",
      bootId,
      expectedRevision: 4,
    };
    const first = http("/api/web/v1/send", { method: "POST", body });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "two" } }))
        .status,
    ).toBe(409);
    await service.request({ operation: "revoke", id });
    finish({ ok: true });
    expect((await first).status).toBe(401);
  });
  it("blocks traversal and escaping symlinks and serves local assets without a dev server", async () => {
    expect((await http("/")).body).toContain("local web");
    expect((await http("/%2e%2e/secrets")).status).toBe(403);
    await symlink(join(dir, ".."), join(dir, "escape"));
    expect((await http(`/escape/${dir.split("/").at(-1)}/index.html`)).status).toBe(200);
    await symlink("/etc/hosts", join(dir, "outside"));
    expect((await http("/outside")).status).toBe(403);
  });
  it("rejects directories and oversized assets before reading them into memory", async () => {
    await mkdir(join(dir, "assets"));
    expect((await http("/assets")).status).toBe(404);
    const large = join(dir, "large.js");
    await writeFile(large, "");
    await truncate(large, 16 * 1024 * 1024 + 1);
    // 稀疏文件：大小超限但不占用磁盘，服务端应只看元数据就拒绝。
    expect((await http("/large.js")).status).toBe(413);
  });
  it("uses configured external HTTPS origin, never trusts forwarded headers", async () => {
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "https://web.example",
      experimentalEnabled: false,
    });
    const result = await http("/api/web/v1/access", { headers: { Host: "web.example" } });
    expect(result.headers["set-cookie"]![0]).toContain("; Secure");
    expect(
      (await http("/", { headers: { Host: "evil.example", "X-Forwarded-Host": "web.example" } }))
        .status,
    ).toBe(403);
  });
  it("preserves approved credentials across restart but invalidates control boot", async () => {
    await bootstrap();
    await pair(true);
    const oldBoot = bootId;
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      verifiedExperimental: true,
    });
    await service.initialize();
    const access = await http("/api/web/v1/access");
    expect(access.json().status).toBe("approved");
    expect(access.json().bootId).not.toBe(oldBoot);
    csrf = access.json().csrfToken;
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: {
            sessionId: "s",
            text: "x",
            requestId: "old",
            bootId: oldBoot,
            expectedRevision: 4,
          },
        })
      ).status,
    ).toBe(409);
    expect(runtime).not.toHaveBeenCalled();
  });
  it("closes SSE immediately on revoke and never forwards subsequent snapshots", async () => {
    await bootstrap();
    const id = await pair();
    const chunks: string[] = [];
    let first!: () => void;
    const snapshot = new Promise<void>((resolve) => {
      first = resolve;
    });
    const ended = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=s&protocolVersion=2",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.on("data", (chunk) => {
            chunks.push(String(chunk));
            if (String(chunk).includes("event: session-event")) first();
          });
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end();
    });
    await snapshot;
    await service.request({ operation: "revoke", id });
    await ended;
    expect(chunks.join("")).toContain("event: access-ended");
    expect(runtime).toHaveBeenCalledTimes(1);
  });
  it("expires pairing codes and enforces bounded bodies", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    try {
      expect((await service.request({ operation: "status" })).code).toBeUndefined();
    } finally {
      now.mockRestore();
    }
    cookie = "";
    await bootstrap();
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: status.code!.value, name: "Phone" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http("/api/web/v1/pair", {
          method: "POST",
          body: { code: "1", name: "x".repeat(70_000) },
        })
      ).status,
    ).toBe(413);
  });
  it("keeps secure and insecure credentials isolated", async () => {
    await service.request({
      operation: "configure",
      enabled: true,
      port,
      externalOrigin: "https://web.example",
      experimentalEnabled: false,
    });
    await bootstrap();
    await pair();
    const external = await http("/api/web/v1/access", { headers: { Host: "web.example" } });
    expect(external.json().status).toBe("unpaired");
    const secureCookie = external.headers["set-cookie"]![0].split(";")[0];
    expect(secureCookie).toMatch(/^ak_web_secure=/);
    const local = await http("/api/web/v1/access", { headers: { Cookie: secureCookie } });
    expect(local.json().status).toBe("unpaired");
    expect((await http("/api/web/v1/catalog", { headers: { Host: "web.example" } })).status).toBe(
      401,
    );
  });
  it("Claude-only verification never enables Codex or unknown providers", async () => {
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      verifiedClaudeManaged: true,
    });
    await service.initialize();
    await bootstrap();
    await pair(true, true);
    for (const executionMode of [undefined, "unknown", "managed-resume"]) {
      runtime.mockResolvedValue({
        runtimeBootId: "runtime-one",
        revision: 4,
        sendEnabled: true,
        executionMode,
        accepted: true,
        approvals: [],
      });
      const live = await http("/api/web/v1/live?sessionId=s");
      expect(live.json().sendEnabled).toBe(executionMode === "managed-resume");
      const sent = await http("/api/web/v1/send", {
        method: "POST",
        body: {
          sessionId: "s",
          text: "test",
          requestId: `mode-${executionMode}`,
          bootId,
          expectedRevision: 4,
        },
      });
      expect(sent.status).toBe(executionMode === "managed-resume" ? 200 : 403);
    }
  });
  it("answers questions with send-only permission while a turn is waiting, without requiring idle", async () => {
    await bootstrap();
    await pair(true, false);
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      questions: [
        {
          requestId: 7,
          turnId: "turn",
          supported: true,
          questions: [
            {
              id: "choice",
              multiSelect: true,
              allowCustom: false,
              options: [{ label: "A" }, { label: "B" }],
            },
            { id: "custom", multiSelect: false, allowCustom: true, options: [] },
          ],
        },
      ],
    });
    const body = {
      bootId,
      sessionId: "s",
      requestId: "answer-one",
      expectedRevision: 4,
      questionId: 7,
      turnId: "turn",
      answers: { choice: ["A", "B"], custom: ["My answer"] },
    };
    expect((await http("/api/web/v1/answer", { method: "POST", body })).status).toBe(200);
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "answer", questionId: 7, answers: body.answers }),
    );
    expect((await http("/api/web/v1/answer", { method: "POST", body })).json().error).toBe(
      "duplicate_request",
    );
  });
  it("enforces the native per-answer UTF-8 limit before runtime dispatch", async () => {
    await bootstrap();
    await pair(true, false);
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      questions: [
        {
          requestId: "q",
          turnId: "turn",
          supported: true,
          questions: [{ id: "answer", multiSelect: false, allowCustom: true, options: [] }],
        },
      ],
    });
    for (const [index, value] of [
      "文".repeat(2730),
      "文".repeat(2730) + "ab",
      "文".repeat(2731),
    ].entries()) {
      runtime.mockClear();
      const result = await http("/api/web/v1/answer", {
        method: "POST",
        body: {
          bootId,
          sessionId: "s",
          requestId: `utf8-${index}`,
          expectedRevision: 4,
          questionId: "q",
          turnId: "turn",
          answers: { answer: [value] },
        },
      });
      expect(result.status).toBe(index < 2 ? 200 : 400);
      if (index === 2) expect(runtime).not.toHaveBeenCalled();
    }
  });

  it("does not substitute approval permission for question answering", async () => {
    await bootstrap();
    await pair(false, true);
    expect((await http("/api/web/v1/answer", { method: "POST", body: { bootId } })).status).toBe(
      403,
    );
    expect(runtime).not.toHaveBeenCalled();
  });
  it("rechecks question-answer authorization after preflight and rejects CSRF", async () => {
    await bootstrap();
    const id = await pair(true, false);
    const body = {
      bootId,
      sessionId: "s",
      requestId: "answer-race",
      expectedRevision: 4,
      questionId: "q",
      turnId: "t",
      answers: { x: ["A"] },
    };
    expect(
      (
        await http("/api/web/v1/answer", {
          method: "POST",
          body,
          headers: { "X-CSRF-Token": "wrong" },
        })
      ).status,
    ).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
    let resolve!: (snapshot: unknown) => void;
    runtime.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const response = http("/api/web/v1/answer", { method: "POST", body });
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    await service.request({ operation: "revoke", id });
    resolve({
      runtimeBootId: "runtime-one",
      revision: 4,
      questions: [
        {
          requestId: "q",
          turnId: "t",
          supported: true,
          questions: [
            { id: "x", multiSelect: false, allowCustom: false, options: [{ label: "A" }] },
          ],
        },
      ],
    });
    expect((await response).status).toBe(401);
    expect(runtime).toHaveBeenCalledTimes(1);
  });
  it("rejects stale, unsupported and malformed question answers before dispatch", async () => {
    await bootstrap();
    await pair(true, true);
    const snapshot = {
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      questions: [
        {
          requestId: "q",
          turnId: "turn",
          supported: true,
          questions: [
            {
              id: "choice",
              multiSelect: false,
              allowCustom: false,
              options: [{ label: "A" }, { label: "B" }],
            },
          ],
        },
      ],
    };
    runtime.mockResolvedValue(snapshot);
    const body = {
      bootId,
      sessionId: "s",
      expectedRevision: 4,
      questionId: "q",
      turnId: "turn",
      answers: { choice: ["A"] },
    };
    const variants = [
      { turnId: "old" },
      { questionId: "absent" },
      { expectedRevision: 3 },
      { answers: { choice: ["C"] } },
      { answers: { choice: ["A", "B"] } },
      { answers: { choice: ["A"], extra: ["A"] } },
      { answers: { other: ["A"] } },
    ];
    for (const [index, variant] of variants.entries()) {
      const response = await http("/api/web/v1/answer", {
        method: "POST",
        body: { ...body, ...variant, requestId: `invalid-${index}` },
      });
      expect([400, 409]).toContain(response.status);
    }
    snapshot.questions[0].supported = false;
    expect(
      (
        await http("/api/web/v1/answer", {
          method: "POST",
          body: { ...body, requestId: "unsupported" },
        })
      ).json().error,
    ).toBe("question_unavailable");
    expect(runtime.mock.calls.every(([value]) => (value as any).operation === "live")).toBe(true);
  });
  it("forwards native Claude decisions only when the exact pending request offers them", async () => {
    await bootstrap();
    await pair(true, true);
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      approvals: [
        {
          requestId: "claude-request",
          turnId: "turn",
          supported: true,
          method: "claude/can_use_tool",
          availableDecisions: ["allow", "deny"],
        },
      ],
    });
    for (const decision of ["allow", "deny", "accept", "cancel"]) {
      const response = await http("/api/web/v1/approve", {
        method: "POST",
        body: {
          sessionId: "s",
          requestId: `claude-${decision}`,
          bootId,
          expectedRevision: 4,
          turnId: "turn",
          approvalId: "claude-request",
          decision,
        },
      });
      expect(response.status).toBe(["allow", "deny"].includes(decision) ? 200 : 409);
    }
    expect(
      runtime.mock.calls.some(
        ([value]) => (value as any).operation === "approve" && (value as any).decision === "allow",
      ),
    ).toBe(true);
  });
  it("rejects unavailable send and only forwards exact supported numeric approvals", async () => {
    await bootstrap();
    await pair(true, true);
    const body = { sessionId: "s", text: "x", requestId: "disabled", bootId, expectedRevision: 4 };
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      approvals: [
        {
          requestId: 860,
          turnId: "turn",
          supported: true,
          availableDecisions: ["approve-once", "cancel"],
        },
      ],
    });
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
    const approval = {
      ...body,
      requestId: "decline",
      turnId: "turn",
      approvalId: 860,
      decision: "decline",
    };
    expect((await http("/api/web/v1/approve", { method: "POST", body: approval })).status).toBe(
      409,
    );
    expect(
      (
        await http("/api/web/v1/approve", {
          method: "POST",
          body: { ...approval, requestId: "accept", decision: "approve-once" },
        })
      ).status,
    ).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "approve",
        approvalId: 860,
        decision: "approve-once",
      }),
    );
  });
  it("forwards a supported negative ACP approval ID without changing its sign", async () => {
    await bootstrap();
    await pair(true, true);
    runtime.mockResolvedValue({
      accepted: true,
      runtimeBootId: "runtime-one",
      revision: 4,
      sendEnabled: false,
      approvals: [
        {
          requestId: -860,
          turnId: "turn",
          supported: true,
          availableDecisions: ["native-yes"],
        },
      ],
    });
    const response = await http("/api/web/v1/approve", {
      method: "POST",
      body: {
        sessionId: "s",
        requestId: "negative-approval",
        bootId,
        expectedRevision: 4,
        turnId: "turn",
        approvalId: -860,
        decision: "native-yes",
      },
    });
    expect(response.status).toBe(200);
    expect(runtime).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "approve", approvalId: -860 }),
    );
    expect(
      runtime.mock.calls.filter(
        ([params]) => (params as { operation?: string }).operation === "approve",
      ),
    ).toHaveLength(1);
  });
  it("rechecks revoked grants between live read and mutation dispatch", async () => {
    await bootstrap();
    const id = await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await service.request({ operation: "revoke", id });
    finish({ runtimeBootId: "runtime-one", revision: 4, sendEnabled: true });
    expect((await pending).status).toBe(401);
    expect(runtime).toHaveBeenCalledTimes(1);
  });
  it("invalidates in-flight read/control success after runtime disconnect", async () => {
    await bootstrap();
    await pair(true);
    let finish!: (value: unknown) => void;
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = http("/api/web/v1/live?sessionId=s");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    service.runtimeUnavailable();
    finish({ runtimeBootId: "old", revision: 4 });
    expect((await pending).status).toBe(409);
    const access = await http("/api/web/v1/access");
    bootId = access.json().bootId;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "new", revision: 4, sendEnabled: true },
    );
    finish = undefined!;
    const send = http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    service.runtimeUnavailable();
    finish({ accepted: true });
    expect((await send).status).toBe(409);
  });
  it.each([
    {
      receipt: { accepted: true },
    },
    {
      receipt: {
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        requestId: "r",
        runtimeBootId: "r",
      },
    },
  ])(
    "retains unknown outcome after timeout, late receipt %j and runtime restart",
    async ({ receipt }) => {
      await bootstrap();
      await pair(true);
      let finish!: (value: unknown) => void;
      let notifySendStarted!: () => void;
      const sendStarted = new Promise<void>((resolve) => {
        notifySendStarted = resolve;
      });
      runtime.mockImplementation(async (p) =>
        (p as { operation: string }).operation === "send"
          ? new Promise((resolve) => {
              finish = resolve;
              notifySendStarted();
            })
          : { runtimeBootId: "r", revision: 4, sendEnabled: true },
      );
      const body = { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const timeoutRequest = http("/api/web/v1/send", { method: "POST", body });
      await sendStarted;
      await vi.advanceTimersByTimeAsync(20_000);
      const timeout = await timeoutRequest;
      expect(timeout.status).toBe(504);
      expect(timeout.json().error).toBe("outcome_unknown");
      expect(
        (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "r2" } }))
          .status,
      ).toBe(409);
      finish(receipt);
      expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(409);
      service.runtimeUnavailable();
      const access = await http("/api/web/v1/access");
      const next = await http("/api/web/v1/send", {
        method: "POST",
        body: { ...body, requestId: "after-restart", bootId: access.json().bootId },
      });
      expect(next.status).toBe(409);
      expect(next.json().error).toBe("outcome_unknown");
      const live = await http("/api/web/v1/live?sessionId=s");
      expect(live.json()).toMatchObject({
        status: "outcome-unknown",
        sendEnabled: false,
        approvals: [],
      });
      expect(
        runtime.mock.calls.filter(([p]) => (p as { operation: string }).operation === "send"),
      ).toHaveLength(1);
    },
    30_000,
  );
  it("reports a read-only preflight timeout as not dispatched and permits a fresh request", async () => {
    await bootstrap();
    await pair(true);
    let notifyPreflightStarted!: () => void;
    const preflightStarted = new Promise<void>((resolve) => {
      notifyPreflightStarted = resolve;
    });
    runtime.mockImplementationOnce(
      () =>
        new Promise(() => {
          notifyPreflightStarted();
        }),
    );
    const body = {
      sessionId: "s",
      text: "x",
      requestId: "preflight-timeout",
      bootId,
      expectedRevision: 4,
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeoutRequest = http("/api/web/v1/send", { method: "POST", body });
    await preflightStarted;
    await vi.advanceTimersByTimeAsync(20_000);
    const timeout = await timeoutRequest;
    expect(timeout.status).toBe(504);
    expect(timeout.json()).toMatchObject({
      error: "outcome_unknown",
      controlOutcome: "not-dispatched",
    });
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(
      (await http("/api/web/v1/send", { method: "POST", body: { ...body, requestId: "fresh" } }))
        .status,
    ).toBe(200);
  }, 30_000);
  it("retains failed dispatch protection when the runtime recovers with a fresh idle snapshot", async () => {
    await bootstrap();
    await pair(true, true);
    runtime.mockImplementation(async (p) => {
      if ((p as { operation: string }).operation === "send")
        throw new Error("runtime disconnected");
      return { runtimeBootId: "new-runtime", revision: 4, sendEnabled: true, approvals: [] };
    });
    const body = { sessionId: "s", text: "x", requestId: "first", bootId, expectedRevision: 4 };
    expect((await http("/api/web/v1/send", { method: "POST", body })).status).toBe(500);
    service.runtimeUnavailable();
    const freshBoot = (await http("/api/web/v1/access")).json().bootId;
    for (const path of ["send", "approve"]) {
      const result = await http(`/api/web/v1/${path}`, {
        method: "POST",
        body: { ...body, bootId: freshBoot, requestId: path },
      });
      expect(result.status).toBe(409);
      expect(result.json().error).toBe("outcome_unknown");
    }
    expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(false);
    expect((await http("/api/web/v1/live?sessionId=other")).json().sendEnabled).toBe(true);
    const stream = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/web/v1/stream?sessionId=s&protocolVersion=2",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.once("data", (chunk) => {
            resolve(String(chunk));
            res.destroy();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(stream).toContain('"reason":"control-outcome-unconfirmed"');
  });
  it("clears the dispatch fence only after a successful acknowledgement response", async () => {
    await bootstrap();
    await pair(true);
    for (const requestId of ["one", "two"]) {
      expect(
        (
          await http("/api/web/v1/send", {
            method: "POST",
            body: {
              sessionId: "s",
              text: "x",
              requestId,
              bootId,
              expectedRevision: 4,
            },
          })
        ).status,
      ).toBe(200);
    }
    expect((await http("/api/web/v1/live?sessionId=s")).json().sendEnabled).toBe(true);
  });
  it("keeps the fence when the browser disconnects before a late acknowledgement", async () => {
    await bootstrap();
    await pair(true);
    // Client close only confirms the local socket closed. Wait for the server
    // to observe it before simulating a late runtime acknowledgement.
    let serverClosed!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      serverClosed = resolve;
    });
    const emit = ServerResponse.prototype.emit;
    vi.spyOn(ServerResponse.prototype, "emit").mockImplementation(function (
      this: ServerResponse,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const result = emit.call(this, event, ...args);
      if (event === "close" && this.req.url === "/api/web/v1/send") serverClosed();
      return result;
    });
    let finish!: (value: unknown) => void;
    runtime.mockImplementation(async (p) =>
      (p as { operation: string }).operation === "send"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { runtimeBootId: "r", revision: 4, sendEnabled: true },
    );
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/api/web/v1/send",
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "X-CSRF-Token": csrf,
        "X-AgentKib-Protocol": "2",
        "Content-Type": "application/json",
      },
    });
    req.on("error", () => {});
    req.end(
      JSON.stringify({ sessionId: "s", text: "x", requestId: "lost", bootId, expectedRevision: 4 }),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await new Promise<void>((resolve) => {
      req.once("close", resolve);
      req.destroy();
    });
    await disconnected;
    finish({ accepted: true });
    const live = await http("/api/web/v1/live?sessionId=s");
    expect(live.json()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
    const next = await http("/api/web/v1/send", {
      method: "POST",
      body: {
        sessionId: "s",
        text: "x",
        requestId: "new",
        bootId,
        expectedRevision: 4,
      },
    });
    expect(next.status).toBe(409);
    expect(
      runtime.mock.calls.filter(([p]) => (p as { operation: string }).operation === "send"),
    ).toHaveLength(1);
  });
  it("limits local acceptance controls to one session and rejects remote configuration", async () => {
    await service.shutdown();
    const sessionId = "a".repeat(64);
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
      acceptanceSessionId: sessionId,
    });
    await service.initialize();
    await bootstrap();
    await pair(true, true);
    runtime.mockClear();
    for (const path of ["send", "approve"]) {
      const result = await http(`/api/web/v1/${path}`, {
        method: "POST",
        body: { sessionId: "other", requestId: "outside", bootId, expectedRevision: 4, text: "x" },
      });
      expect(result.status).toBe(403);
    }
    expect(runtime).not.toHaveBeenCalled();
    await http("/api/web/v1/live?sessionId=other");
    expect(runtime).toHaveBeenLastCalledWith({
      operation: "live",
      sessionId: "other",
      experimentalEnabled: false,
    });
    const result = await http("/api/web/v1/send", {
      method: "POST",
      body: { sessionId, requestId: "allowed", bootId, expectedRevision: 4, text: "x" },
    });
    expect(result.status).toBe(200);
    await expect(
      service.request({
        operation: "configure",
        enabled: true,
        port,
        experimentalEnabled: true,
        externalOrigin: "https://example.com",
      }),
    ).rejects.toThrow("acceptance_is_local_only");
  });
  it("defaults to release-gated read-only even when stored host and device grants allow control", async () => {
    await bootstrap();
    await pair(true, true);
    await service.shutdown();
    service = new WebAccessService({ dataDir: dir, staticDir: dir, runtimeRequest: runtime });
    await service.initialize();
    const status = await service.request({ operation: "status" });
    expect(status.config.experimentalEnabled).toBe(true);
    expect(status.experimentalAvailable).toBe(false);
    const access = await http("/api/web/v1/access");
    csrf = access.json().csrfToken;
    bootId = access.json().bootId;
    expect(access.json().experimentalEnabled).toBe(false);
    expect(
      (
        await http("/api/web/v1/send", {
          method: "POST",
          body: { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 },
        })
      ).status,
    ).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
    expect((await http("/api/web/v1/live?sessionId=s")).status).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith({
      operation: "live",
      sessionId: "s",
      experimentalEnabled: false,
    });
  });
});
