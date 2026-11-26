// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { WebSocket } from "ws";
import { REMOTE_ROUTE, REMOTE_ROUTE_BASE } from "@agentkib/runtime-protocol";
import { attachManagedWebSocket, type ManagedWebSocketOptions } from "./managed-websocket";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(overrides: Partial<ManagedWebSocketOptions> = {}) {
  const authorize = vi.fn<ManagedWebSocketOptions["authorize"]>(async () => true);
  const dispatch = vi.fn<ManagedWebSocketOptions["dispatch"]>(async (_req, res) => {
    res.end(JSON.stringify({ accepted: true }));
  });
  const server: Server = createServer((_req, res) => res.end());
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const adapter = attachManagedWebSocket(server, { authorize, dispatch, ...overrides });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${origin.replace("http:", "ws:")}/api/web/v1/socket`;
  const clients = new Set<WebSocket>();
  const client = (options: { path?: string; origin?: string | null } = {}) => {
    const ws = new WebSocket(options.path ? new URL(options.path, url) : url, {
      headers: {
        ...(options.origin === null ? {} : { origin: options.origin ?? origin }),
        cookie: "ak_web_local=paired-cookie",
        "x-csrf-token": "handshake-must-not-win",
      },
    });
    clients.add(ws);
    ws.on("error", () => {});
    return ws;
  };
  const connect = async () => {
    const ws = client();
    await once(ws, "open");
    return ws;
  };
  cleanups.push(async () => {
    adapter.close();
    for (const ws of clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { authorize, dispatch, server, adapter, origin, connect, client, sockets };
}

async function rawUpgrade(
  host: { server: Server; origin: string },
  options: { path?: string; origin?: boolean } = {},
) {
  const port = (host.server.address() as { port: number }).port;
  const raw = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  raw.on("error", () => {});
  cleanups.push(async () => {
    raw.destroy();
  });
  let response = "";
  raw.on("data", (chunk: Buffer) => (response += chunk.toString()));
  await once(raw, "connect");
  raw.write(
    Buffer.concat([
      Buffer.from(
        `GET ${options.path ?? "/api/web/v1/socket"} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n" +
          (options.origin === false ? "" : `Origin: ${host.origin}\r\n`) +
          "\r\n",
      ),
      Buffer.alloc(512 * 1024, 65),
    ]),
  );
  return { raw, response: () => response };
}

function request(extra: Record<string, unknown> = {}) {
  return {
    id: "frame-1",
    path: "/managed/action",
    body: { operation: "rename", sessionId: "claude-1", name: "Updated" },
    csrfToken: "frame-csrf",
    protocolVersion: 2,
    ...extra,
  };
}

async function message(ws: WebSocket) {
  const [data] = await once(ws, "message");
  return JSON.parse(data.toString()) as { id: string | null; status: number; body: unknown };
}

function exchange(ws: WebSocket, input: unknown) {
  const result = message(ws);
  ws.send(typeof input === "string" ? input : JSON.stringify(input));
  return result;
}

async function rejected(ws: WebSocket) {
  const [, response] = await once(ws, "unexpected-response");
  response.resume();
  ws.terminate();
  return response.statusCode;
}

describe("managed WebSocket HTTP adapter", () => {
  it("preserves authenticated handshake identity and delegates ordinary HTTP requests", async () => {
    const host = await fixture();
    const ws = await host.connect();
    host.dispatch.mockImplementationOnce(async (req, res, control) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/web/v1/managed/action");
      expect(req.headers).toMatchObject({
        origin: host.origin,
        cookie: "ak_web_local=paired-cookie",
        "x-csrf-token": "frame-csrf",
        "x-agentkib-protocol": "2",
        "content-type": "application/json",
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(request().body);
      control.request = true;
      control.dispatched = true;
      res.writeHead(202);
      res.end(JSON.stringify({ accepted: true, requestId: "receipt-1" }));
    });
    expect(await exchange(ws, request())).toEqual({
      id: "frame-1",
      status: 202,
      body: { accepted: true, requestId: "receipt-1" },
    });
    expect(host.authorize).toHaveBeenCalledOnce();
    expect(host.dispatch).toHaveBeenCalledOnce();
  });

  it("dispatches an outcome-abandon request through the authenticated bridge", async () => {
    const host = await fixture();
    const ws = await host.connect();
    const body = { sessionId: "s", requestId: "00000000-0000-0000-0000-000000000001" };
    expect(await exchange(ws, request({ path: REMOTE_ROUTE.abandonRequest, body }))).toMatchObject({
      status: 200,
    });
    expect(host.authorize).toHaveBeenCalledOnce();
    expect(host.dispatch.mock.calls[0]?.[0].url).toBe(
      `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.abandonRequest}`,
    );
  });

  it.each([null, "null", ""])("requires a non-opaque Origin (%s)", async (origin) => {
    const host = await fixture();
    expect(await rejected(host.client({ origin }))).toBe(403);
    expect(host.authorize).not.toHaveBeenCalled();
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it.each([false, new Error("private auth failure")])(
    "requires successful caller authorization",
    async (result) => {
      const host = await fixture({
        authorize: async () => {
          if (result instanceof Error) throw result;
          return result;
        },
      });
      expect(await rejected(host.client())).toBe(403);
      expect(host.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/web/v1/events", "/api/web/v1/socket?token=secret", "/socket"])(
    "rejects other upgrade paths: %s",
    async (path) => {
      const host = await fixture();
      expect(await rejected(host.client({ path }))).toBe(404);
      expect(host.authorize).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong path", "missing Origin", "authorization denied", "authorization error"])(
    "stops with rejected upgrades and unread input without waiting for the client: %s",
    async (kind) => {
      const host = await fixture({
        authorize: async () => {
          if (kind === "authorization error") throw new Error("private auth failure");
          return kind !== "authorization denied";
        },
      });
      const input = await rawUpgrade(host, {
        path: kind === "wrong path" ? "/wrong" : undefined,
        origin: kind !== "missing Origin",
      });
      const status = kind === "wrong path" ? "404 Not Found" : "403 Forbidden";
      await vi.waitFor(() =>
        expect(input.response()).toBe(
          `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        ),
      );
      // Keep the client write side open: shutdown must release its own connection.
      host.adapter.close();
      host.server.closeAllConnections();
      let stopped = false;
      host.server.close(() => (stopped = true));
      await vi.waitFor(() => {
        expect(host.sockets.size).toBe(0);
        expect(stopped).toBe(true);
      });
      expect(host.dispatch).not.toHaveBeenCalled();
    },
  );

  it("expires a half-open rejected upgrade after the handshake deadline without stopping the server", async () => {
    const host = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const input = await rawUpgrade(host, { origin: false });
      if (!input.raw.readableEnded) await once(input.raw, "end");
      expect(input.response()).toBe(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      expect(host.sockets.size).toBe(1);
      const closed = once([...host.sockets][0], "close");
      await vi.advanceTimersByTimeAsync(9_999);
      expect(host.sockets.size).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(host.sockets.size).toBe(0);
      expect(host.server.listening).toBe(true);
      expect(host.authorize).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { headers: { cookie: "different-owner" } },
    { deviceId: "agentkib-local-owner" },
    { method: "POST" },
    { protocolVersion: 1 },
    { csrfToken: "" },
    { id: "../invalid" },
    { id: "a".repeat(129) },
    { body: [] },
    { body: null },
  ])("rejects frame envelope injection or invalid fields: %j", async (extra) => {
    const host = await fixture();
    expect(await exchange(await host.connect(), request(extra))).toEqual({
      id: null,
      status: 400,
      body: { error: "invalid_frame", controlOutcome: "not-dispatched" },
    });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch malformed JSON", async () => {
    const host = await fixture();
    expect(await exchange(await host.connect(), "{invalid")).toMatchObject({ status: 400 });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    "/attachments",
    "/attachments/delete",
    "/artifact-tickets",
    "/history/search",
    "/history/rebuild",
    "/events",
    "/runtime/request",
    "/managed/action?owner=local",
    "/managed/../managed/action",
    "/managed/%61ction",
    "//evil.example/managed/action",
    "/managed\\action",
    "/managed/action#ignored",
  ])("rejects upload, streaming, history and unknown POST paths: %s", async (path) => {
    const host = await fixture();
    expect(await exchange(await host.connect(), request({ path }))).toMatchObject({
      status: 404,
      body: { error: "not_found", controlOutcome: "not-dispatched" },
    });
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it.each(["/events", "/live", "/access", "/files/text", "/diff", "/history/status"])(
    "rejects non-bounded or bootstrap GET paths: %s",
    async (path) => {
      const host = await fixture();
      expect(
        await exchange(await host.connect(), request({ path, body: undefined })),
      ).toMatchObject({
        status: 404,
      });
      expect(host.dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["/managed/settings?sessionId=claude-1", "/api/web/v1/requests/receipt-1"])(
    "dispatches bounded public GET paths: %s",
    async (path) => {
      const host = await fixture();
      expect(
        await exchange(await host.connect(), request({ path, body: undefined })),
      ).toMatchObject({
        status: 200,
      });
      expect(host.dispatch.mock.calls[0][0]).toMatchObject({
        method: "GET",
        url: path.startsWith("/api/") ? path : `/api/web/v1${path}`,
      });
    },
  );

  it("allows only one in-flight request per connection without queueing or replaying frames", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const host = await fixture({
      dispatch: async (_req, res) => {
        await pending;
        res.end(JSON.stringify({ accepted: true }));
      },
    });
    const ws = await host.connect();
    ws.send(JSON.stringify(request()));
    expect(await exchange(ws, request({ id: "frame-2" }))).toEqual({
      id: "frame-2",
      status: 409,
      body: { error: "request_in_progress", controlOutcome: "not-dispatched" },
    });
    const result = message(ws);
    release();
    expect(await result).toMatchObject({ id: "frame-1", status: 200 });
    expect(await exchange(ws, request({ id: "frame-3" }))).toMatchObject({
      id: "frame-3",
      status: 200,
    });
  });

  it("preserves per-frame authorization failures returned by the shared handler", async () => {
    const host = await fixture();
    const ws = await host.connect();
    await exchange(ws, request());
    host.dispatch.mockImplementationOnce(async (_req, res) => {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "access_ended", controlOutcome: "not-dispatched" }));
    });
    expect(await exchange(ws, request({ id: "frame-2", csrfToken: "rotated-csrf" }))).toEqual({
      id: "frame-2",
      status: 401,
      body: { error: "access_ended", controlOutcome: "not-dispatched" },
    });
    expect(host.dispatch).toHaveBeenCalledTimes(2);
    expect(host.dispatch.mock.calls[1][0].headers["x-csrf-token"]).toBe("rotated-csrf");
  });

  it("returns an uncertain outcome without leaking unexpected exception details", async () => {
    const host = await fixture({
      dispatch: async () => {
        throw new Error("private file and credential detail");
      },
    });
    expect(await exchange(await host.connect(), request())).toEqual({
      id: "frame-1",
      status: 500,
      body: { error: "request_failed", controlOutcome: "unknown" },
    });
  });

  it("bounds response size even when a handler returns too much JSON", async () => {
    const host = await fixture({
      dispatch: async (_req, res) => res.end(JSON.stringify({ text: "a".repeat(1024 * 1024) })),
    });
    expect(await exchange(await host.connect(), request())).toMatchObject({
      status: 502,
      body: { error: "response_too_large", controlOutcome: "unknown" },
    });
  });

  it("rejects binary frames before dispatch", async () => {
    const host = await fixture();
    const ws = await host.connect();
    const closed = once(ws, "close");
    ws.send(Buffer.from(JSON.stringify(request())));
    expect((await closed)[0]).toBe(1003);
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it("rejects oversized frames before dispatch", async () => {
    const host = await fixture();
    const ws = await host.connect();
    const closed = once(ws, "close");
    ws.send(JSON.stringify(request({ body: { text: "a".repeat(70 * 1024) } })));
    expect([1006, 1009]).toContain((await closed)[0]);
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it("terminates active sockets and destroys active responses on shutdown", async () => {
    let response: Parameters<ManagedWebSocketOptions["dispatch"]>[1] | undefined;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const host = await fixture({
      dispatch: async (_req, res) => {
        response = res;
        await pending;
      },
    });
    const ws = await host.connect();
    ws.send(JSON.stringify(request()));
    await vi.waitFor(() => expect(response).toBeDefined());
    const closed = once(ws, "close");
    host.adapter.close();
    await closed;
    await vi.waitFor(() => expect(response?.destroyed).toBe(true));
    expect(host.server.listenerCount("upgrade")).toBe(0);
    release();
  });

  it("does not finish an upgrade whose authorization completes after shutdown", async () => {
    let authorizeStarted = false;
    let release!: (authorized: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => (release = resolve));
    const host = await fixture({
      authorize: async () => {
        authorizeStarted = true;
        return authorization;
      },
    });
    const ws = host.client();
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await vi.waitFor(() => expect(authorizeStarted).toBe(true));
    host.adapter.close();
    release(true);
    await closed;
    expect(host.dispatch).not.toHaveBeenCalled();
  });
});
