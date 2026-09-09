// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, ServerResponse } from "node:http";
import { WebAccessService } from "./service";

describe("WebAccessService loopback security boundary", () => {
  let dir: string;
  let service: WebAccessService;
  let origin: string;
  let port: number;
  let cookie: string;
  let csrf: string;
  let bootId: string;
  const runtime = vi.fn(async (_params: unknown): Promise<unknown> => ({
    runtimeBootId: "runtime-one",
    revision: 4,
    sendEnabled: true,
    events: [],
  }));
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
    const admin = await service.request({ operation: "generate-code" });
    const paired = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: admin.code!.value, name: "Test browser" },
    });
    expect(paired.status).toBe(200);
    const id = paired.json().pending.id;
    await service.request({ operation: "approve", id, send, approve });
    return id;
  }
  function openStream(streamCookie = cookie, sessionId = "s") {
    const chunks: string[] = [];
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/api/web/v1/stream?sessionId=${sessionId}`,
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
  beforeEach(async () => {
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
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: runtime,
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
    vi.restoreAllMocks();
    await service.shutdown();
    await rm(dir, { recursive: true, force: true });
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
  it("requires desktop confirmation, persists only hashed credentials, and revokes access", async () => {
    await bootstrap();
    const status = await service.request({ operation: "generate-code" });
    expect(status.code!.value).toMatch(/^\d{8}$/);
    const result = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: status.code!.value, name: "Phone" },
    });
    expect((await http("/api/web/v1/access")).json().status).toBe("pending");
    expect((await http("/api/web/v1/catalog")).status).toBe(401);
    const id = result.json().pending.id;
    await service.request({ operation: "approve", id, send: false, approve: false });
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
    await service.request({ operation: "generate-code" });
    const next = await service.request({ operation: "status" });
    const result = await http("/api/web/v1/pair", {
      method: "POST",
      body: { code: next.code!.value, name: "Phone" },
    });
    await service.request({ operation: "reject", id: result.json().pending.id });
    expect((await http("/api/web/v1/access")).json().status).toBe("ended");
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
  it("shares same-scope SSE reads, omits unchanged snapshots and retains heartbeats", async () => {
    await bootstrap();
    await pair();
    let finish!: (value: unknown) => void;
    const snapshot = { runtimeBootId: "r", revision: 7, events: [] };
    runtime.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    runtime.mockResolvedValue(snapshot);
    const first = openStream();
    const second = openStream();
    try {
      await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(1));
      // Both clients must have entered the stream before releasing the common read.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runtime).toHaveBeenCalledTimes(1);
      finish(snapshot);
      await vi.waitFor(() => {
        expect(first.chunks.join("")).toContain("event: snapshot");
        expect(second.chunks.join("")).toContain("event: snapshot");
      });
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(first.chunks.join("").match(/event: snapshot/g)).toHaveLength(1);
      expect(second.chunks.join("").match(/event: snapshot/g)).toHaveLength(1);
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
      await new Promise((resolve) => setTimeout(resolve, 2100));
      expect(first.chunks.join("")).toContain(": heartbeat");
      expect(second.chunks.join("")).toContain(": heartbeat");
    } finally {
      finish?.(snapshot);
      first.close();
      second.close();
    }
  }, 10_000);

  it.each([false, true])(
    "isolates SSE scopes and independently rechecks revocation (writable peer: %s)",
    async (writable) => {
      await bootstrap();
      const readOnlyId = await pair();
      const readOnlyCookie = cookie;
      cookie = "";
      await bootstrap();
      await pair(writable);
      const finishes: Array<(value: unknown) => void> = [];
      runtime.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishes.push(resolve);
          }),
      );
      const first = openStream(readOnlyCookie);
      const second = openStream();
      try {
        await vi.waitFor(() => expect(runtime).toHaveBeenCalledTimes(writable ? 2 : 1));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(runtime).toHaveBeenCalledTimes(writable ? 2 : 1);
        await service.request({ operation: "revoke", id: readOnlyId });
        finishes.forEach((finish) => finish({ revision: 8, events: [] }));
        await vi.waitFor(() => {
          expect(first.chunks.join("")).toContain("event: access-ended");
          expect(second.chunks.join("")).toContain("event: snapshot");
        });
        expect(first.chunks.join("")).not.toContain("event: snapshot");
      } finally {
        finishes.forEach((finish) => finish({ revision: 8, events: [] }));
        first.close();
        second.close();
      }
    },
  );

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
          path: "/api/web/v1/stream?sessionId=s",
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
      await vi.waitFor(() => expect(chunks.join("")).toContain("event: snapshot"));
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
          path: "/api/web/v1/stream?sessionId=s",
          headers: { Cookie: cookie },
        },
        (res) => {
          res.on("data", (chunk) => {
            chunks.push(String(chunk));
            if (String(chunk).includes("event: snapshot")) first();
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
          availableDecisions: ["accept", "cancel"],
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
          body: { ...approval, requestId: "accept", decision: "accept" },
        })
      ).status,
    ).toBe(200);
    expect(runtime).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "approve", approvalId: 860, decision: "accept" }),
    );
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
    { accepted: true },
    {
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      requestId: "r",
      runtimeBootId: "r",
    },
  ])(
    "retains unknown outcome after timeout, late receipt %j and runtime restart",
    async (receipt) => {
      await bootstrap();
      await pair(true);
      let finish!: (value: unknown) => void;
      runtime.mockImplementation(async (p) =>
        (p as { operation: string }).operation === "send"
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : { runtimeBootId: "r", revision: 4, sendEnabled: true },
      );
      const body = { sessionId: "s", text: "x", requestId: "r", bootId, expectedRevision: 4 };
      const timeout = await http("/api/web/v1/send", { method: "POST", body });
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
    runtime.mockImplementationOnce(() => new Promise(() => {}));
    const body = {
      sessionId: "s",
      text: "x",
      requestId: "preflight-timeout",
      bootId,
      expectedRevision: 4,
    };
    const timeout = await http("/api/web/v1/send", { method: "POST", body });
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
          path: "/api/web/v1/stream?sessionId=s",
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
