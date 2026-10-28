import { createHash, randomBytes } from "node:crypto";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect, type LookupFunction } from "node:net";
import { withoutFrameAncestors } from "../live-preview-frames";

/**
 * Web preview for remote browsers: a page served on this computer (a dev server on a loopback
 * port), shown through the isolated preview origin.
 *
 * A ticket URL ${preview}/live/<ticket>/<path> opens a bootstrap page that installs a service
 * worker for the whole preview origin. The worker sends the page to its own root path
 * (/<path>, so routers and root-relative assets work) and forwards every request of that page
 * to /live/<ticket>/... with X-AgentKib-Live: 1, which this service proxies to the loopback
 * port. WebSockets are not proxied, so live reload does not reach remote browsers.
 */
export interface LivePreviewOptions {
  /** The preview origin and the app origins allowed to frame it, read on every request. */
  origins: () => { preview: string; ancestors: string[] };
  /** Whether the device may still open previews: full access with advanced control. */
  authorize: (deviceId: string) => boolean;
  /** Loopback ports AgentKib itself listens on. */
  reservedPorts: () => number[];
  now?: () => number;
  idleMs?: number;
  maxAgeMs?: number;
  probeTimeoutMs?: number;
}
export interface LivePreviewTicket {
  url: string;
  expiresAt: number;
}
export class LivePreviewError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
interface Ticket {
  id: string;
  deviceId: string;
  /** The preview origin it was issued on; a changed origin ends it. */
  origin: string;
  port: number;
  secure: boolean;
  createdAt: number;
  usedAt: number;
  active: Set<ServerResponse>;
}

export const LIVE_WORKER_PATH = "/live-sw.js";
const TICKET_URL = /^\/live\/([A-Za-z0-9_-]{32})(\/.*)?$/;
const BOOT_MARK = "__agentkib_live_boot=1";
const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 4 * 60 * 60_000;
const MAX_TICKETS = 64;
const MAX_DEVICE_TICKETS = 8;
const MAX_REQUESTS = 256;
const MAX_DEVICE_REQUESTS = 96;
const UPSTREAM_IDLE_MS = 5 * 60_000;
const AGENTKIB_COOKIES = new Set(["ak_web_local", "ak_web_secure"]);
/** Fetch's "bad ports": browsers refuse HTTP to them, and so does this proxy. */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);
const REQUEST_ONLY_HERE = new Set([
  "host",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "x-agentkib-live",
  "x-agentkib-live-dest",
  "x-agentkib-live-mode",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
]);
// The page must not take over the preview origin: no HSTS, storage wipes or own workers.
const RESPONSE_ONLY_THERE = new Set([
  "x-frame-options",
  "strict-transport-security",
  "clear-site-data",
  "service-worker-allowed",
  "alt-svc",
  "public-key-pins",
  "public-key-pins-report-only",
  "expect-ct",
  "referrer-policy",
]);
const FETCH_MODES = new Set(["navigate", "same-origin", "no-cors", "cors"]);
const FETCH_DESTS = new Set([
  "audio",
  "audioworklet",
  "document",
  "embed",
  "empty",
  "font",
  "frame",
  "iframe",
  "image",
  "json",
  "manifest",
  "object",
  "paintworklet",
  "report",
  "script",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
  "xslt",
]);
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** "localhost" is never resolved through the system: it is these two addresses. */
const loopback: LookupFunction = (_hostname, options, callback) => {
  const addresses = [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
  if (options.all) callback(null, addresses);
  else callback(null, addresses[0]!.address, addresses[0]!.family);
};

// The bootstrap installs the worker, then opens the same URL again for the worker to take.
// It marks that second request so a browser that bypasses the worker sees a failure, not a loop.
const BOOT_SCRIPT = `(async () => {
  const body = document.body;
  const fail = () => { body.textContent = body.dataset.unsupported; };
  if (!("serviceWorker" in navigator)) return fail();
  try {
    await navigator.serviceWorker.register("${LIVE_WORKER_PATH}", { scope: "/", updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    const search = location.search ? location.search + "&" : "?";
    location.replace(location.pathname + search + "${BOOT_MARK}" + location.hash);
  } catch {
    fail();
  }
})();`;
const BOOT_HASH = `'sha256-${createHash("sha256").update(BOOT_SCRIPT).digest("base64")}'`;

/**
 * The preview origin's service worker (see the class comment). It never touches other origins,
 * artifact tickets (/p/) or itself. A top-level page needs evidence that it came from the preview
 * itself (an earlier preview page, or a same-origin referrer), so another site cannot reach the
 * dev server just by linking to the preview origin. Frames are partitioned by the top-level
 * site, so only AgentKib's own pages ever share this worker's frames.
 */
export const LIVE_WORKER_SCRIPT = String.raw`"use strict";
const STORE = "agentkib-live-v1";
const LAST = "/__agentkib_live/last";
const CLIENT = "/__agentkib_live/client/";
const TICKET = /^\/live\/([A-Za-z0-9_-]{32})(\/.*)?$/;
const BOOT = /(^|&)__agentkib_live_boot=1(?=&|$)/;
const known = new Map();
// Pages this worker let through without a preview (another site linked here): their own
// requests (a favicon) stay away from the page's server too.
const outside = new Set();
let last;
let remembered = 0;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
const store = () => caches.open(STORE);
async function remember(clientId, ticket) {
  last = ticket;
  const cache = await store();
  await cache.put(LAST, new Response(ticket));
  if (!clientId) return;
  known.set(clientId, ticket);
  await cache.put(CLIENT + clientId, new Response(ticket));
  if (++remembered % 32 === 0) await prune(cache);
}
async function prune(cache) {
  const alive = new Set(
    (await self.clients.matchAll({ includeUncontrolled: true, type: "all" })).map((c) => c.id),
  );
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(CLIENT) || alive.has(path.slice(CLIENT.length))) continue;
    known.delete(path.slice(CLIENT.length));
    await cache.delete(request);
  }
}
async function recall(clientId) {
  if (!clientId) return undefined;
  if (known.has(clientId)) return known.get(clientId);
  const saved = await (await store()).match(CLIENT + clientId);
  if (!saved) return undefined;
  const ticket = await saved.text();
  known.set(clientId, ticket);
  return ticket;
}
async function lastTicket() {
  if (last) return last;
  const saved = await (await store()).match(LAST);
  if (saved) last = await saved.text();
  return last;
}
function sameOrigin(referrer) {
  try {
    return !!referrer && new URL(referrer).origin === self.location.origin;
  } catch {
    return false;
  }
}
async function forward(request, path) {
  const headers = new Headers(request.headers);
  headers.set("X-AgentKib-Live", "1");
  headers.set("X-AgentKib-Live-Mode", request.mode);
  headers.set("X-AgentKib-Live-Dest", request.destination || "empty");
  const init = {
    method: request.method,
    headers,
    credentials: "same-origin",
    redirect: request.mode === "navigate" ? "manual" : request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.blob();
  return fetch(new URL(path, self.location.origin).href, init);
}
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    url.pathname === "/live-sw.js" ||
    url.pathname.startsWith("/p/")
  )
    return;
  const prefixed = TICKET.exec(url.pathname);
  const navigation = request.mode === "navigate";
  if (prefixed && navigation) {
    event.respondWith(
      (async () => {
        await remember(event.resultingClientId, prefixed[1]);
        const search = url.search.slice(1).replace(BOOT, "").replace(/^&/, "");
        const target = (prefixed[2] || "/") + (search ? "?" + search : "");
        return Response.redirect(self.location.origin + target, 302);
      })(),
    );
    return;
  }
  event.respondWith(
    (async () => {
      let ticket = prefixed
        ? prefixed[1]
        : (await recall(event.resultingClientId)) || (await recall(event.clientId));
      if (
        !ticket &&
        !outside.has(event.clientId) &&
        (!navigation ||
          request.destination !== "document" ||
          (event.clientId && (await self.clients.get(event.clientId))) ||
          sameOrigin(request.referrer))
      )
        ticket = await lastTicket();
      if (!ticket) {
        if (navigation && event.resultingClientId) outside.add(event.resultingClientId);
        return fetch(request);
      }
      if (navigation && event.resultingClientId) await remember(event.resultingClientId, ticket);
      return forward(
        request,
        prefixed ? url.pathname + url.search : "/live/" + ticket + url.pathname + url.search,
      );
    })(),
  );
});
`;

type Language = "en" | "zh" | "tw" | "ja";
type PageText = Record<
  "opening" | "unsupported" | "expired" | "denied" | "unreachable" | "notFound",
  string
>;
const PAGE_TEXT: Record<Language, PageText> = {
  en: {
    opening: "Opening the preview…",
    unsupported: "This browser cannot show the preview here. Open it in a new tab from AgentKib.",
    expired: "This preview has expired. Open it again from AgentKib.",
    denied: "This browser can no longer open previews. Check its access in AgentKib.",
    unreachable: "Nothing is answering on port {port} on the computer running AgentKib.",
    notFound: "Open web previews from AgentKib.",
  },
  zh: {
    opening: "正在打开预览…",
    unsupported: "这个浏览器无法在这里显示预览，请在 AgentKib 里用新标签页打开。",
    expired: "这个预览已过期，请在 AgentKib 里重新打开。",
    denied: "这个浏览器已经不能打开预览，请在 AgentKib 里检查它的权限。",
    unreachable: "运行 AgentKib 的电脑上，端口 {port} 没有响应。",
    notFound: "请在 AgentKib 里打开网页预览。",
  },
  tw: {
    opening: "正在開啟預覽…",
    unsupported: "這個瀏覽器無法在這裡顯示預覽，請在 AgentKib 裡用新分頁開啟。",
    expired: "這個預覽已過期，請在 AgentKib 裡重新開啟。",
    denied: "這個瀏覽器已經不能開啟預覽，請在 AgentKib 裡檢查它的權限。",
    unreachable: "執行 AgentKib 的電腦上，連接埠 {port} 沒有回應。",
    notFound: "請在 AgentKib 裡開啟網頁預覽。",
  },
  ja: {
    opening: "プレビューを開いています…",
    unsupported:
      "このブラウザーではここにプレビューを表示できません。AgentKib から新しいタブで開いてください。",
    expired: "このプレビューは期限切れです。AgentKib から開き直してください。",
    denied:
      "このブラウザーはプレビューを開けなくなりました。AgentKib でアクセス権を確認してください。",
    unreachable: "AgentKib を実行しているコンピューターのポート {port} が応答しません。",
    notFound: "Web プレビューは AgentKib から開いてください。",
  },
};
const PAGE_KEY: Record<string, keyof PageText> = {
  live_preview_expired: "expired",
  live_preview_denied: "denied",
  live_preview_unreachable: "unreachable",
};

function languageOf(header: string | undefined): Language {
  const first = (header ?? "").split(",")[0]!.trim().toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(first)) return "tw";
  if (first.startsWith("zh")) return "zh";
  if (first.startsWith("ja")) return "ja";
  return "en";
}
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
function reject(status: number, code: string): never {
  throw new LivePreviewError(status, code);
}
function connectionTokens(value: string | string[] | undefined): Set<string> {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}
function withoutAgentKibCookies(header: string | undefined): string | undefined {
  const kept = (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !AGENTKIB_COOKIES.has(pair.split("=", 1)[0]!.trim()));
  return kept.length ? kept.join("; ") : undefined;
}

/** The headers the loopback server receives: as if the page were its own origin. */
export function upstreamRequestHeaders(
  headers: IncomingHttpHeaders,
  preview: string,
  upstream: string,
): OutgoingHttpHeaders {
  const listed = connectionTokens(headers.connection);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (
      value !== undefined &&
      !HOP_BY_HOP.has(name) &&
      !listed.has(name) &&
      !REQUEST_ONLY_HERE.has(name)
    )
      result[name] = value;
  result.host = new URL(upstream).host;
  if (headers.origin !== undefined) result.origin = upstream;
  delete result.referer;
  if (typeof headers.referer === "string" && headers.referer.startsWith(`${preview}/`))
    result.referer = `${upstream}${headers.referer.slice(preview.length)}`;
  // AgentKib's own session cookie must never reach the page's server (on 127.0.0.1 the
  // browser sends it to every port).
  const cookie = withoutAgentKibCookies(headers.cookie);
  if (cookie) result.cookie = cookie;
  else delete result.cookie;
  // The worker's fetch reports Sec-Fetch-* for itself; pass on what the page asked for.
  const mode = headers["x-agentkib-live-mode"];
  const dest = headers["x-agentkib-live-dest"];
  if (typeof mode === "string" && FETCH_MODES.has(mode)) result["sec-fetch-mode"] = mode;
  if (typeof dest === "string" && FETCH_DESTS.has(dest)) result["sec-fetch-dest"] = dest;
  result["sec-fetch-site"] = "same-origin";
  return result;
}

/** A cookie the page's server sets, kept to the preview origin and usable inside the frame. */
export function previewCookie(value: string, secureOrigin: boolean): string | undefined {
  const [pair = "", ...attributes] = value.split(";");
  const name = pair.split("=", 1)[0]!.trim();
  if (!name || AGENTKIB_COOKIES.has(name)) return undefined;
  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => {
      const key = attribute.split("=", 1)[0]!.trim().toLowerCase();
      if (!key || key === "domain") return false;
      return !secureOrigin || !["samesite", "secure", "partitioned"].includes(key);
    });
  // The relay's preview origin is a third party inside the app: only partitioned cookies work.
  if (secureOrigin) kept.push("Secure", "SameSite=None", "Partitioned");
  return [pair.trim(), ...kept].join("; ");
}

/** Redirects to the page's own server stay inside the ticket. */
export function previewLocation(
  value: string,
  context: { upstream: string; port: number; prefix: string; requestPath: string },
): string {
  let target: URL;
  try {
    target = new URL(value, `${context.upstream}${context.requestPath}`);
  } catch {
    return value;
  }
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const own =
    (target.protocol === "http:" || target.protocol === "https:") &&
    LOOPBACK_NAMES.has(target.hostname) &&
    port === context.port;
  return own ? `${context.prefix}${target.pathname}${target.search}${target.hash}` : value;
}

export function previewResponseHeaders(
  headers: IncomingHttpHeaders,
  context: {
    upstream: string;
    port: number;
    prefix: string;
    requestPath: string;
    ancestors: string[];
    secureOrigin: boolean;
  },
): OutgoingHttpHeaders {
  const listed = connectionTokens(headers.connection);
  const result: OutgoingHttpHeaders = {};
  const policies: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      listed.has(name) ||
      RESPONSE_ONLY_THERE.has(name)
    )
      continue;
    if (name === "content-security-policy")
      policies.push(...[value].flat().map(withoutFrameAncestors).filter(Boolean));
    else if (name === "set-cookie") {
      const cookies = [value]
        .flat()
        .map((cookie) => previewCookie(cookie, context.secureOrigin))
        .filter((cookie): cookie is string => !!cookie);
      if (cookies.length) result[name] = cookies;
    } else if (name === "location" && typeof value === "string")
      result.location = previewLocation(value, context);
    else result[name] = value;
  }
  // 'self' keeps the page's own nested frames working (Storybook frames itself).
  policies.push(`frame-ancestors 'self' ${context.ancestors.join(" ")}`.trim());
  // Several policies are all enforced; Node sends one header line each.
  (result as Record<string, string[]>)["content-security-policy"] = policies;
  result["referrer-policy"] = "same-origin";
  return result;
}

export class LivePreviewService {
  private readonly options: LivePreviewOptions;
  private readonly tickets = new Map<string, Ticket>();
  private readonly httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 64 });
  // A loopback server's certificate proves nothing: whoever listens on the port is the page.
  private readonly httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: 64,
    rejectUnauthorized: false,
  });
  private readonly now: () => number;
  constructor(options: LivePreviewOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Requests on the preview origin that belong to the web preview. */
  static owns(url: string | undefined): boolean {
    const path = (url ?? "").split("?")[0]!;
    return path === LIVE_WORKER_PATH || path.startsWith("/live/");
  }

  async issue(
    deviceId: string,
    input: { port?: unknown; path?: unknown; secure?: unknown },
  ): Promise<LivePreviewTicket> {
    const port = input.port;
    if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535)
      reject(400, "invalid_input");
    if (input.secure !== undefined && typeof input.secure !== "boolean")
      reject(400, "invalid_input");
    const path = previewPath(input.path);
    if (this.options.reservedPorts().includes(port)) reject(403, "live_preview_port_reserved");
    if (BAD_PORTS.has(port)) reject(403, "live_preview_port_blocked");
    const { preview } = this.options.origins();
    if (!preview) reject(503, "preview_unavailable");
    if (!(await this.reachable(port))) reject(409, "live_preview_unreachable");
    this.expire();
    const own = [...this.tickets.values()]
      .filter((ticket) => ticket.deviceId === deviceId)
      .sort((left, right) => left.createdAt - right.createdAt);
    while (own.length >= MAX_DEVICE_TICKETS) this.remove(own.shift()!.id);
    if (this.tickets.size >= MAX_TICKETS) reject(429, "live_preview_ticket_limit");
    const now = this.now();
    const ticket: Ticket = {
      id: randomBytes(24).toString("base64url"),
      deviceId,
      origin: preview,
      port,
      secure: input.secure === true,
      createdAt: now,
      usedAt: now,
      active: new Set(),
    };
    this.tickets.set(ticket.id, ticket);
    return { url: `${preview}/live/${ticket.id}${path}`, expiresAt: this.expiresAt(ticket) };
  }
  revokeDevice(deviceId: string) {
    for (const ticket of [...this.tickets.values()])
      if (ticket.deviceId === deviceId) this.remove(ticket.id);
  }
  clear() {
    for (const id of [...this.tickets.keys()]) this.remove(id);
  }
  close() {
    this.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** The caller routes only the preview origin's requests that {@link owns} accepts. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { preview, ancestors } = this.options.origins();
    if (!preview || req.headers.host !== new URL(preview).host)
      return this.fail(req, res, 403, "live_preview_invalid_host");
    const raw = req.url ?? "/";
    if (raw.split("?")[0] === LIVE_WORKER_PATH) return this.worker(req, res);
    const match = TICKET_URL.exec(raw);
    if (!match) return this.fail(req, res, 404, "live_preview_not_found");
    this.expire();
    const ticket = this.tickets.get(match[1]!);
    if (!ticket || ticket.origin !== preview)
      return this.fail(req, res, 410, "live_preview_expired");
    if (!this.options.authorize(ticket.deviceId)) {
      this.revokeDevice(ticket.deviceId);
      return this.fail(req, res, 403, "live_preview_denied");
    }
    const rest = match[2] ?? "/";
    if (req.headers["x-agentkib-live"] !== "1") {
      // Only the address bar or a frame opens a ticket; the worker sends everything else.
      if (!navigationRequest(req)) return this.fail(req, res, 409, "live_preview_worker_required");
      if (rest.split("?")[1]?.split("&").includes(BOOT_MARK))
        return this.page(req, res, 200, "unsupported");
      ticket.usedAt = this.now();
      return this.bootstrap(req, res, ancestors);
    }
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin")
      return this.fail(req, res, 403, "live_preview_cross_site");
    if (this.busy(ticket.deviceId)) return this.fail(req, res, 429, "live_preview_request_limit");
    ticket.usedAt = this.now();
    this.forward(req, res, ticket, rest, preview, ancestors);
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    ticket: Ticket,
    rest: string,
    preview: string,
    ancestors: string[],
  ) {
    const upstream = `${ticket.secure ? "https" : "http"}://localhost:${ticket.port}`;
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      host: "localhost",
      port: ticket.port,
      method: req.method,
      path: rest,
      headers: upstreamRequestHeaders(req.headers, preview, upstream),
      agent: ticket.secure ? this.httpsAgent : this.httpAgent,
      lookup: loopback,
      autoSelectFamily: true,
      ...(ticket.secure ? { servername: "localhost" } : {}),
    };
    const outgoing = ticket.secure ? httpsRequest(options) : httpRequest(options);
    let complete = false;
    ticket.active.add(res);
    res.once("close", () => {
      ticket.active.delete(res);
      if (!complete) outgoing.destroy();
    });
    req.once("error", () => outgoing.destroy());
    outgoing.setTimeout(UPSTREAM_IDLE_MS, () => outgoing.destroy(new Error("upstream_idle")));
    outgoing.once("response", (response) => {
      if (this.tickets.get(ticket.id) !== ticket || res.destroyed) {
        response.destroy();
        res.destroy();
        return;
      }
      response.once("end", () => (complete = true));
      response.once("error", () => res.destroy());
      res.writeHead(
        response.statusCode ?? 502,
        previewResponseHeaders(response.headers, {
          upstream,
          port: ticket.port,
          prefix: `/live/${ticket.id}`,
          requestPath: rest,
          ancestors,
          secureOrigin: preview.startsWith("https:"),
        }),
      );
      response.pipe(res);
    });
    outgoing.once("error", () => {
      if (res.headersSent) res.destroy();
      else this.fail(req, res, 502, "live_preview_unreachable", ticket.port);
    });
    req.pipe(outgoing);
  }

  private reachable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = connect({
        host: "localhost",
        port,
        lookup: loopback,
        autoSelectFamily: true,
        timeout: this.options.probeTimeoutMs ?? 1500,
      });
      const done = (reachable: boolean) => {
        socket.destroy();
        resolve(reachable);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.once("timeout", () => done(false));
    });
  }
  private busy(deviceId: string) {
    let total = 0,
      device = 0;
    for (const ticket of this.tickets.values()) {
      total += ticket.active.size;
      if (ticket.deviceId === deviceId) device += ticket.active.size;
    }
    return total >= MAX_REQUESTS || device >= MAX_DEVICE_REQUESTS;
  }
  private expiresAt(ticket: Ticket) {
    return Math.min(
      ticket.usedAt + (this.options.idleMs ?? IDLE_MS),
      ticket.createdAt + (this.options.maxAgeMs ?? MAX_AGE_MS),
    );
  }
  private expire() {
    const now = this.now();
    for (const ticket of [...this.tickets.values()])
      if (this.expiresAt(ticket) <= now) this.remove(ticket.id);
  }
  private remove(id: string) {
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);
    for (const response of ticket?.active ?? []) response.destroy();
  }
  private worker(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD")
      return this.fail(req, res, 405, "live_preview_method_not_allowed");
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'",
    });
    res.end(req.method === "HEAD" ? undefined : LIVE_WORKER_SCRIPT);
  }
  private bootstrap(req: IncomingMessage, res: ServerResponse, ancestors: string[]) {
    const language = languageOf(req.headers["accept-language"]);
    const text = PAGE_TEXT[language];
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src ${BOOT_HASH}; style-src 'unsafe-inline'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${ancestors.join(" ")}`,
    });
    res.end(
      `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>AgentKib</title><body data-unsupported="${escapeHtml(text.unsupported)}" style="font:13px system-ui,sans-serif;color:#666;padding:16px">${escapeHtml(text.opening)}<script>${BOOT_SCRIPT}</script></body></html>`,
    );
  }
  private fail(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    code: string,
    port?: number,
  ) {
    const navigation =
      req.headers["x-agentkib-live-mode"] === "navigate" ||
      (req.headers["x-agentkib-live"] === undefined && navigationRequest(req));
    if (!navigation) {
      const { ancestors } = this.options.origins();
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; frame-ancestors 'self' ${ancestors.join(" ")}`,
      });
      res.end(JSON.stringify({ code }));
      return;
    }
    this.page(req, res, status, PAGE_KEY[code] ?? "notFound", port);
  }
  private page(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    key: keyof PageText,
    port?: number,
  ) {
    const language = languageOf(req.headers["accept-language"]);
    const { ancestors } = this.options.origins();
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' ${ancestors.join(" ")}`,
    });
    const message = PAGE_TEXT[language][key].replace("{port}", String(port ?? ""));
    res.end(
      `<!doctype html><html lang="${language}"><meta charset="utf-8"><title>AgentKib</title><body style="font:13px system-ui,sans-serif;color:#666;padding:16px">${escapeHtml(message)}</body></html>`,
    );
  }
}

function navigationRequest(req: IncomingMessage) {
  const mode = req.headers["sec-fetch-mode"];
  if (mode !== undefined) return mode === "navigate";
  return (
    (req.method === "GET" || req.method === "HEAD") && /text\/html/.test(req.headers.accept ?? "")
  );
}

/** "/", "/app?x=1#top": a path on the page's own server, never another host. */
function previewPath(value: unknown): string {
  if (value === undefined) return "/";
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > 2048 ||
    // oxlint-disable-next-line no-control-regex
    /[\s\u0000-\u001f\u007f]/.test(value)
  )
    reject(400, "invalid_input");
  const url = new URL(value, "http://localhost");
  if (url.origin !== "http://localhost") reject(400, "invalid_input");
  return `${url.pathname}${url.search}${url.hash}`;
}
