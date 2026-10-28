// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createSecureServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_WORKER_SCRIPT,
  LivePreviewError,
  LivePreviewService,
  previewCookie,
  previewLocation,
  previewResponseHeaders,
  upstreamRequestHeaders,
} from "./live-preview";

const APP = "http://127.0.0.1:1421";
const PREVIEW = "https://device.preview.example.net";

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}
function close(server?: Server) {
  return new Promise<void>((resolve) => {
    if (!server?.listening) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
}
interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode!, headers: response.headers, body: data }),
      );
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
const pathOf = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

describe("web preview headers", () => {
  it("presents the page's request to its server as its own origin", () => {
    expect(
      upstreamRequestHeaders(
        {
          host: "device.preview.example.net",
          origin: PREVIEW,
          referer: `${PREVIEW}/home?tab=1`,
          cookie: "ak_web_secure=secret; app=1; ak_web_local=other; theme=dark",
          connection: "keep-alive, x-hop",
          "x-hop": "1",
          "keep-alive": "timeout=5",
          "x-forwarded-for": "203.0.113.9",
          "x-agentkib-live": "1",
          "x-agentkib-live-mode": "navigate",
          "x-agentkib-live-dest": "iframe",
          "sec-fetch-mode": "cors",
          "sec-fetch-dest": "empty",
          "sec-fetch-site": "same-origin",
          authorization: "Bearer app-token",
          accept: "text/html",
        },
        PREVIEW,
        "http://localhost:5173",
      ),
    ).toEqual({
      host: "localhost:5173",
      origin: "http://localhost:5173",
      referer: "http://localhost:5173/home?tab=1",
      cookie: "app=1; theme=dark",
      authorization: "Bearer app-token",
      accept: "text/html",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
      "sec-fetch-site": "same-origin",
    });
  });
  it("drops a foreign referrer, AgentKib-only cookies and unknown fetch metadata", () => {
    const headers = upstreamRequestHeaders(
      {
        referer: "https://elsewhere.example/",
        cookie: "ak_web_local=secret",
        "x-agentkib-live-mode": "websocket-ish",
        "x-agentkib-live-dest": "<script>",
      },
      PREVIEW,
      "http://localhost:3000",
    );
    expect(headers).toEqual({ host: "localhost:3000", "sec-fetch-site": "same-origin" });
  });
  it("keeps the page's cookies on the preview origin and away from AgentKib's", () => {
    expect(previewCookie("ak_web_local=forged; Path=/", false)).toBeUndefined();
    expect(previewCookie(" ak_web_secure=forged", true)).toBeUndefined();
    expect(
      previewCookie("session=abc; Path=/; Domain=example.net; HttpOnly; SameSite=Lax", false),
    ).toBe("session=abc; Path=/; HttpOnly; SameSite=Lax");
    expect(previewCookie("session=abc; Path=/; SameSite=Strict; Secure; HttpOnly", true)).toBe(
      "session=abc; Path=/; HttpOnly; Secure; SameSite=None; Partitioned",
    );
  });
  it("keeps redirects to the page's own server inside the ticket", () => {
    const context = {
      upstream: "http://localhost:5173",
      port: 5173,
      prefix: "/live/T",
      requestPath: "/admin/users?page=2",
    };
    expect(previewLocation("/login?next=%2F", context)).toBe("/live/T/login?next=%2F");
    expect(previewLocation("edit#form", context)).toBe("/live/T/admin/edit#form");
    expect(previewLocation("http://127.0.0.1:5173/done", context)).toBe("/live/T/done");
    expect(previewLocation("http://[::1]:5173/v6", context)).toBe("/live/T/v6");
    expect(previewLocation("http://localhost:3000/other", context)).toBe(
      "http://localhost:3000/other",
    );
    expect(previewLocation("https://accounts.example.com/o", context)).toBe(
      "https://accounts.example.com/o",
    );
    expect(previewLocation("http://[bad", context)).toBe("http://[bad");
  });
  it("lets only AgentKib frame the page and keeps the origin to the preview", () => {
    expect(
      previewResponseHeaders(
        {
          "content-type": "text/html",
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
          "strict-transport-security": "max-age=600",
          "clear-site-data": '"*"',
          "service-worker-allowed": "/",
          "referrer-policy": "no-referrer",
          "transfer-encoding": "chunked",
          location: "/next",
          "set-cookie": ["ak_web_local=forged", "app=1; Domain=example.net"],
        },
        {
          upstream: "http://localhost:5173",
          port: 5173,
          prefix: "/live/T",
          requestPath: "/",
          ancestors: [APP, "https://device.remote.example.com"],
          secureOrigin: false,
        },
      ),
    ).toEqual({
      "content-type": "text/html",
      location: "/live/T/next",
      "set-cookie": ["app=1"],
      "content-security-policy": [
        "default-src 'self'",
        `frame-ancestors 'self' ${APP} https://device.remote.example.com`,
      ],
      "referrer-policy": "same-origin",
    });
  });
});

describe("web preview service", () => {
  let upstream: Server;
  let upstreamPort: number;
  let preview: Server;
  let previewPort: number;
  let previewOrigin: string;
  let live: LivePreviewService;
  let now: number;
  const allowed = new Set<string>();
  const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const hanging = new Set<ServerResponse>();
  function devServer(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      if (request.url === "/page") {
        response.writeHead(200, {
          "Content-Type": "text/html",
          "X-Frame-Options": "DENY",
          "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
          "Strict-Transport-Security": "max-age=600",
          "Set-Cookie": ["session=abc; Path=/; Domain=preview.test", "ak_web_local=forged"],
        });
        return response.end("<h1>page</h1>");
      }
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/login?next=%2F" });
        return response.end();
      }
      if (request.url === "/slow") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.write("first");
        hanging.add(response);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ url: request.url, method: request.method, body }));
    });
  }
  function service(overrides: Partial<ConstructorParameters<typeof LivePreviewService>[0]> = {}) {
    return new LivePreviewService({
      origins: () => ({ preview: previewOrigin, ancestors: [APP] }),
      authorize: (deviceId) => allowed.has(deviceId),
      reservedPorts: () => [1421, previewPort],
      now: () => now,
      ...overrides,
    });
  }
  const proxied = (
    path: string,
    headers: Record<string, string> = {},
    method = "GET",
    body?: string,
  ) =>
    send(
      previewPort,
      path,
      { "X-AgentKib-Live": "1", "Sec-Fetch-Site": "same-origin", ...headers },
      method,
      body,
    );
  beforeEach(async () => {
    now = 1_000_000;
    allowed.clear();
    allowed.add("device");
    seen.length = 0;
    upstream = createServer(devServer);
    upstreamPort = await listen(upstream);
    live = service();
    preview = createServer((req, res) => {
      if (LivePreviewService.owns(req.url)) void live.handle(req, res);
      else {
        res.writeHead(404);
        res.end();
      }
    });
    previewPort = await listen(preview);
    previewOrigin = `http://127.0.0.1:${previewPort}`;
  });
  afterEach(async () => {
    for (const response of hanging) response.destroy();
    hanging.clear();
    live.close();
    await close(preview);
    await close(upstream);
  });

  it("issues a ticket only for a listening loopback port that is not AgentKib's or unsafe", async () => {
    const issued = await live.issue("device", { port: upstreamPort, path: "/app?x=1#top" });
    expect(issued.url).toMatch(
      new RegExp(`^${previewOrigin}/live/[A-Za-z0-9_-]{32}/app\\?x=1#top$`),
    );
    expect(issued.expiresAt).toBe(now + 30 * 60_000);
    const refused = async (input: Parameters<LivePreviewService["issue"]>[1]) => {
      const error = await live.issue("device", input).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LivePreviewError);
      return (error as LivePreviewError).code;
    };
    expect(await refused({ port: 1421 })).toBe("live_preview_port_reserved");
    expect(await refused({ port: previewPort })).toBe("live_preview_port_reserved");
    expect(await refused({ port: 6000 })).toBe("live_preview_port_blocked");
    for (const port of [0, 65_536, 1.5, "5173", undefined])
      expect(await refused({ port })).toBe("invalid_input");
    for (const path of [
      "app",
      "//evil.example/x",
      "/\\evil.example",
      "/a b",
      `/${"x".repeat(2048)}`,
      7,
    ])
      expect(await refused({ port: upstreamPort, path })).toBe("invalid_input");
    expect(await refused({ port: upstreamPort, secure: "yes" })).toBe("invalid_input");
    const closed = createServer();
    const closedPort = await listen(closed);
    await close(closed);
    expect(await refused({ port: closedPort })).toBe("live_preview_unreachable");
  });
  it("serves the worker and a bootstrap whose only script is the hashed installer", async () => {
    const worker = await send(previewPort, "/live-sw.js");
    expect(worker.status).toBe(200);
    expect(worker.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(worker.headers["cache-control"]).toBe("no-store");
    expect(worker.body).toBe(LIVE_WORKER_SCRIPT);
    expect((await send(previewPort, "/live-sw.js", {}, "POST")).status).toBe(405);
    const { url } = await live.issue("device", { port: upstreamPort, path: "/app" });
    const page = await send(previewPort, pathOf(url), {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
      "Accept-Language": "zh-CN,zh;q=0.9",
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain("正在打开预览…");
    const script = /<script>([^]*)<\/script>/.exec(page.body)![1]!;
    const hash = createHash("sha256").update(script).digest("base64");
    const policy = page.headers["content-security-policy"]!;
    expect(policy).toContain(`script-src 'sha256-${hash}';`);
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain(`frame-ancestors 'self' ${APP}`);
    expect(script).toContain('register("/live-sw.js", { scope: "/"');
    expect(seen).toEqual([]);
    // Without the worker's mark a non-navigation never reaches the page's server.
    const direct = await send(previewPort, pathOf(url));
    expect(direct.status).toBe(409);
    expect(JSON.parse(direct.body)).toEqual({ code: "live_preview_worker_required" });
    // A browser that ignored the installed worker sees why, instead of a reload loop.
    const bypassed = await send(previewPort, `${pathOf(url)}?__agentkib_live_boot=1`, {
      "Sec-Fetch-Mode": "navigate",
    });
    expect(bypassed.body).toContain(">This browser cannot show the preview here.");
    expect(bypassed.body).not.toContain("<script>");
    expect(seen).toEqual([]);
  });
  it("forwards the worker's requests to the loopback port as the page's own origin", async () => {
    const { url } = await live.issue("device", { port: upstreamPort });
    const prefix = new URL(url).pathname.replace(/\/$/, "");
    const reply = await proxied(`${prefix}/echo/a?b=1`, {
      "X-AgentKib-Live-Mode": "navigate",
      "X-AgentKib-Live-Dest": "iframe",
      Cookie: "ak_web_local=secret; app=1",
      Origin: previewOrigin,
      Referer: `${previewOrigin}/home`,
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({ url: "/echo/a?b=1", method: "GET", body: "" });
    const headers = seen[0]!.headers;
    expect(headers).toMatchObject({
      host: `localhost:${upstreamPort}`,
      origin: `http://localhost:${upstreamPort}`,
      referer: `http://localhost:${upstreamPort}/home`,
      cookie: "app=1",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
      "sec-fetch-site": "same-origin",
    });
    expect(Object.keys(headers).filter((name) => name.startsWith("x-agentkib"))).toEqual([]);
    const posted = await proxied(`${prefix}/form`, { "Content-Type": "text/plain" }, "POST", "a=1");
    expect(JSON.parse(posted.body)).toEqual({ url: "/form", method: "POST", body: "a=1" });
    const page = await proxied(`${prefix}/page`);
    expect(page.body).toBe("<h1>page</h1>");
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(page.headers["strict-transport-security"]).toBeUndefined();
    expect(page.headers["set-cookie"]).toEqual(["session=abc; Path=/"]);
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    const redirect = await proxied(`${prefix}/redirect`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`${prefix}/login?next=%2F`);
  });
  it("answers the frame with a page it can show when the server or the ticket is gone", async () => {
    const { url } = await live.issue("device", { port: upstreamPort });
    const prefix = new URL(url).pathname.replace(/\/$/, "");
    await close(upstream);
    const down = await proxied(`${prefix}/`, { "X-AgentKib-Live-Mode": "navigate" });
    expect(down.status).toBe(502);
    expect(down.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(down.body).toContain(`port ${upstreamPort}`);
    expect(JSON.parse((await proxied(`${prefix}/api`)).body)).toEqual({
      code: "live_preview_unreachable",
    });
    const unknown = await proxied(`/live/${"x".repeat(32)}/`, {
      "X-AgentKib-Live-Mode": "navigate",
    });
    expect(unknown.status).toBe(410);
    expect(unknown.body).toContain("This preview has expired.");
  });
  it("ends a ticket after it sits idle, at its maximum age or when the origin changes", async () => {
    const first = new URL((await live.issue("device", { port: upstreamPort })).url).pathname;
    now += 29 * 60_000;
    expect((await proxied(`${first}echo`)).status).toBe(200);
    now += 29 * 60_000;
    expect((await proxied(`${first}echo`)).status).toBe(200);
    now += 31 * 60_000;
    expect((await proxied(`${first}echo`)).status).toBe(410);
    const aged = new URL((await live.issue("device", { port: upstreamPort })).url).pathname;
    for (let step = 0; step < 9; step++) {
      now += 25 * 60_000;
      expect((await proxied(`${aged}echo`)).status).toBe(200);
    }
    now += 16 * 60_000;
    expect((await proxied(`${aged}echo`)).status).toBe(410);
    const moved = new URL((await live.issue("device", { port: upstreamPort })).url).pathname;
    // Same listener, new origin (the relay was turned on or off): old URLs are dead.
    previewOrigin = `http://localhost:${previewPort}`;
    expect((await proxied(`${moved}echo`, { Host: `localhost:${previewPort}` })).status).toBe(410);
  });
  it("closes open responses and refuses tickets once the device loses access", async () => {
    const { url } = await live.issue("device", { port: upstreamPort });
    const prefix = new URL(url).pathname.replace(/\/$/, "");
    const open = new Promise<string>((resolve) => {
      const outgoing = request(
        {
          host: "127.0.0.1",
          port: previewPort,
          path: `${prefix}/slow`,
          headers: { "X-AgentKib-Live": "1" },
        },
        (response) => {
          response.on("error", () => {});
          response.once("data", () => live.revokeDevice("device"));
          response.once("close", () => resolve(response.complete ? "complete" : "cut"));
        },
      );
      outgoing.on("error", () => resolve("cut"));
      outgoing.end();
    });
    expect(await open).toBe("cut");
    expect((await proxied(`${prefix}/echo`)).status).toBe(410);
    const next = new URL((await live.issue("device", { port: upstreamPort })).url).pathname;
    allowed.delete("device");
    const denied = await proxied(`${next}echo`, { "X-AgentKib-Live-Mode": "navigate" });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("can no longer open previews");
    allowed.add("device");
    expect((await proxied(`${next}echo`)).status).toBe(410);
  });
  it("refuses cross-site requests, foreign hosts and paths outside a ticket", async () => {
    const { url } = await live.issue("device", { port: upstreamPort });
    const prefix = new URL(url).pathname;
    expect((await proxied(`${prefix}echo`, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await proxied(`${prefix}echo`, { Host: "evil.example" })).status).toBe(403);
    expect((await proxied("/live/short/")).status).toBe(404);
    expect(seen).toEqual([]);
  });
  it("keeps each device to its newest tickets", async () => {
    const urls: string[] = [];
    for (let index = 0; index < 9; index++)
      urls.push((await live.issue("device", { port: upstreamPort })).url);
    expect((await proxied(`${new URL(urls[0]!).pathname}echo`)).status).toBe(410);
    expect((await proxied(`${new URL(urls[1]!).pathname}echo`)).status).toBe(200);
    allowed.add("other");
    const other = (await live.issue("other", { port: upstreamPort })).url;
    expect((await proxied(`${new URL(other).pathname}echo`)).status).toBe(200);
  });
  it("reaches a server that listens on IPv6 loopback only", async () => {
    const v6 = createServer(devServer);
    const port = await listen(v6, "::1").catch(() => undefined);
    // Hosts without IPv6 loopback cannot run this case.
    if (port === undefined) return;
    try {
      const { url } = await live.issue("device", { port });
      const reply = await proxied(`${new URL(url).pathname}v6`);
      expect(JSON.parse(reply.body).url).toBe("/v6");
    } finally {
      await close(v6);
    }
  });
  it("speaks HTTPS to a dev server with a self-signed certificate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentkib-live-tls-"));
    try {
      const key = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      }).privateKey;
      await writeFile(join(directory, "key.pem"), key, { mode: 0o600 });
      await writeFile(
        join(directory, "req.conf"),
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost\n",
      );
      // Only the fixture uses OpenSSL.
      execFileSync("openssl", [
        "req",
        "-new",
        "-x509",
        "-days",
        "2",
        "-key",
        join(directory, "key.pem"),
        "-config",
        join(directory, "req.conf"),
        "-out",
        join(directory, "cert.pem"),
      ]);
      const secure = createSecureServer(
        { key, cert: await readFile(join(directory, "cert.pem"), "utf8") },
        devServer,
      );
      const port = await listen(secure as unknown as Server);
      try {
        const { url } = await live.issue("device", { port, secure: true });
        const reply = await proxied(`${new URL(url).pathname}tls`);
        expect(JSON.parse(reply.body).url).toBe("/tls");
        expect(seen.at(-1)!.headers.host).toBe(`localhost:${port}`);
      } finally {
        await close(secure as unknown as Server);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  destination: string;
  headers: Headers;
  referrer: string;
  referrerPolicy: string;
  redirect: string;
  signal?: AbortSignal;
  blob: () => Promise<Blob>;
}
function fakeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const key = (request: string | Request) =>
    new URL(typeof request === "string" ? request : request.url, "https://preview.test").href;
  return {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        async put(request: string, response: Response) {
          store.set(key(request), await response.text());
        },
        async match(request: string) {
          const value = store.get(key(request));
          return value === undefined ? undefined : new Response(value);
        },
        async keys() {
          return [...store.keys()].map((url) => new Request(url));
        },
        async delete(request: Request) {
          return store.delete(key(request));
        },
      };
    },
  };
}
function installWorker(caches = fakeCaches()) {
  const listeners = new Map<string, (event: unknown) => void>();
  const clients = new Map<string, { id: string }>();
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response("proxied"));
  const scope = {
    location: { origin: "https://preview.test" },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => {}),
      get: vi.fn(async (id: string) => clients.get(id)),
      matchAll: vi.fn(async () => [...clients.values()]),
    },
  };
  new Function("self", "caches", "fetch", LIVE_WORKER_SCRIPT)(scope, caches, fetch);
  async function dispatch(
    request: Partial<FakeRequest> & { url: string },
    ids: { clientId?: string; resultingClientId?: string } = {},
  ) {
    let response: Promise<Response> | undefined;
    const full: FakeRequest = {
      method: "GET",
      mode: "cors",
      destination: "",
      headers: new Headers(),
      referrer: "",
      referrerPolicy: "",
      redirect: "follow",
      blob: async () => new Blob([]),
      ...request,
    };
    listeners.get("fetch")!({
      request: full,
      clientId: ids.clientId ?? "",
      resultingClientId: ids.resultingClientId ?? "",
      respondWith: (value: Promise<Response>) => (response = value),
    });
    return { request: full, response: response && (await response) };
  }
  const forwarded = () =>
    fetch.mock.calls.map(([input, init]) => ({
      url: String(input),
      init: init as RequestInit & { headers: Headers },
    }));
  return { dispatch, fetch, forwarded, clients, caches, scope, listeners };
}
const A = "A".repeat(32);
const B = "B".repeat(32);

describe("web preview service worker", () => {
  it("moves a ticket's page to its own root path and forwards its requests", async () => {
    const worker = installWorker();
    const { response } = await worker.dispatch(
      {
        url: `https://preview.test/live/${A}/app?x=1&__agentkib_live_boot=1`,
        mode: "navigate",
        destination: "iframe",
      },
      { resultingClientId: "frame" },
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://preview.test/app?x=1");
    expect(worker.fetch).not.toHaveBeenCalled();
    await worker.dispatch(
      {
        url: "https://preview.test/app?x=1",
        mode: "navigate",
        destination: "iframe",
        headers: new Headers({ Accept: "text/html" }),
      },
      { resultingClientId: "frame" },
    );
    await worker.dispatch(
      { url: "https://preview.test/@vite/client", destination: "script" },
      { clientId: "frame" },
    );
    await worker.dispatch(
      {
        url: "https://preview.test/api/save",
        method: "POST",
        blob: async () => new Blob(["a=1"]),
      },
      { clientId: "frame" },
    );
    const [page, script, save] = worker.forwarded();
    expect(page!.url).toBe(`https://preview.test/live/${A}/app?x=1`);
    expect(page!.init).toMatchObject({ redirect: "manual", credentials: "same-origin" });
    expect(page!.init.headers.get("Accept")).toBe("text/html");
    expect(page!.init.headers.get("X-AgentKib-Live")).toBe("1");
    expect(page!.init.headers.get("X-AgentKib-Live-Mode")).toBe("navigate");
    expect(page!.init.headers.get("X-AgentKib-Live-Dest")).toBe("iframe");
    expect(script!.url).toBe(`https://preview.test/live/${A}/@vite/client`);
    expect(script!.init).toMatchObject({ redirect: "follow" });
    expect(script!.init.headers.get("X-AgentKib-Live-Dest")).toBe("script");
    expect(save!.url).toBe(`https://preview.test/live/${A}/api/save`);
    expect(await (save!.init.body as Blob).text()).toBe("a=1");
  });
  it("keeps two previews apart, also after the worker restarts", async () => {
    const caches = fakeCaches();
    const first = installWorker(caches);
    for (const [ticket, client] of [
      [A, "one"],
      [B, "two"],
    ] as const)
      await first.dispatch(
        { url: `https://preview.test/live/${ticket}/`, mode: "navigate", destination: "iframe" },
        { resultingClientId: client },
      );
    const restarted = installWorker(caches);
    await restarted.dispatch({ url: "https://preview.test/a.js" }, { clientId: "one" });
    await restarted.dispatch({ url: "https://preview.test/b.js" }, { clientId: "two" });
    await restarted.dispatch({ url: "https://preview.test/c.js" }, { clientId: "unknown" });
    expect(restarted.forwarded().map((call) => call.url)).toEqual([
      `https://preview.test/live/${A}/a.js`,
      `https://preview.test/live/${B}/b.js`,
      `https://preview.test/live/${B}/c.js`,
    ]);
  });
  it("lets a page move to its next page, but not another site open one", async () => {
    const worker = installWorker();
    await worker.dispatch(
      { url: `https://preview.test/live/${A}/`, mode: "navigate", destination: "document" },
      { resultingClientId: "tab" },
    );
    worker.clients.set("tab", { id: "tab" });
    await worker.dispatch(
      { url: "https://preview.test/about", mode: "navigate", destination: "document" },
      { clientId: "tab", resultingClientId: "about" },
    );
    await worker.dispatch(
      {
        url: "https://preview.test/back",
        mode: "navigate",
        destination: "document",
        referrer: "https://preview.test/about",
      },
      { resultingClientId: "history" },
    );
    await worker.dispatch(
      { url: "https://preview.test/framed", mode: "navigate", destination: "iframe" },
      { resultingClientId: "frame" },
    );
    expect(worker.forwarded().map((call) => call.url)).toEqual([
      `https://preview.test/live/${A}/about`,
      `https://preview.test/live/${A}/back`,
      `https://preview.test/live/${A}/framed`,
    ]);
    const { request } = await worker.dispatch(
      {
        url: "https://preview.test/delete-everything",
        mode: "navigate",
        destination: "document",
        referrer: "https://evil.example/",
      },
      { resultingClientId: "attack" },
    );
    expect(worker.fetch).toHaveBeenLastCalledWith(request);
    // The browser then asks for that page's icon: it is not the preview's either.
    const icon = await worker.dispatch(
      { url: "https://preview.test/favicon.ico", destination: "image" },
      { clientId: "attack" },
    );
    expect(worker.fetch).toHaveBeenLastCalledWith(icon.request);
    expect(worker.forwarded().filter((call) => call.url.includes("/live/"))).toHaveLength(3);
  });
  it("leaves other origins, artifact tickets and itself alone", async () => {
    const worker = installWorker();
    await worker.dispatch(
      { url: `https://preview.test/live/${A}/`, mode: "navigate", destination: "iframe" },
      { resultingClientId: "frame" },
    );
    for (const url of [
      "https://cdn.example/lib.js",
      `https://preview.test/p/${"p".repeat(32)}/report.html`,
      "https://preview.test/live-sw.js",
    ])
      expect((await worker.dispatch({ url }, { clientId: "frame" })).response).toBeUndefined();
    await worker.dispatch({ url: `https://preview.test/live/${B}/x.js` }, { clientId: "frame" });
    expect(worker.forwarded().map((call) => call.url)).toEqual([
      `https://preview.test/live/${B}/x.js`,
    ]);
  });
  it("passes a request through when no preview was ever opened", async () => {
    const worker = installWorker();
    const { request } = await worker.dispatch({ url: "https://preview.test/app.js" });
    expect(worker.fetch).toHaveBeenCalledExactlyOnceWith(request);
  });
});
