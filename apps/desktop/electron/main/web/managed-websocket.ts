import {
  CONVERSATION_PROTOCOL_VERSION,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
} from "@agentkib/runtime-protocol";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  isConversationPath,
  isConversationReceiptPath,
  isLegacyCodexPostPath,
  relativeConversationPath,
  LocalConversationResponse,
  type ConversationRequest,
} from "./conversation-transport";

const SOCKET_PATH = `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.socket}`;
const MAX_PAYLOAD = 64 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const POST_PATHS = new Set<string>([
  REMOTE_ROUTE.send,
  REMOTE_ROUTE.stop,
  REMOTE_ROUTE.approve,
  REMOTE_ROUTE.answer,
  REMOTE_ROUTE.abandonRequest,
  REMOTE_ROUTE.managedCreate,
  REMOTE_ROUTE.managedRelease,
  REMOTE_ROUTE.managedReconcile,
  REMOTE_ROUTE.managedAction,
  REMOTE_ROUTE.managedSettingsPrepare,
]);
const GET_PATHS = new Set<string>([
  REMOTE_ROUTE.managedOptions,
  REMOTE_ROUTE.managedCapabilities,
  REMOTE_ROUTE.managedInspect,
  REMOTE_ROUTE.managedContext,
  REMOTE_ROUTE.managedSettings,
  REMOTE_ROUTE.managedQueue,
  REMOTE_ROUTE.managedGoals,
  REMOTE_ROUTE.managedResources,
  REMOTE_ROUTE.codexCapabilities,
  REMOTE_ROUTE.codexQueue,
  REMOTE_ROUTE.codexSessionSettings,
  REMOTE_ROUTE.codexGoals,
  REMOTE_ROUTE.codexContextOptions,
]);

export interface ConversationDispatchControl {
  request: boolean;
  dispatched: boolean;
  priorUncertain: boolean;
}

export interface ManagedWebSocketOptions {
  authorize(req: IncomingMessage): Promise<boolean>;
  dispatch(
    req: ConversationRequest,
    res: LocalConversationResponse,
    control: ConversationDispatchControl,
  ): Promise<void>;
}

type Frame = {
  id: string;
  path: string;
  body?: Record<string, unknown>;
  csrfToken: string;
  protocolVersion: typeof CONVERSATION_PROTOCOL_VERSION;
};

function frame(value: unknown): Frame | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["id", "path", "body", "csrfToken", "protocolVersion"].includes(key),
    ) ||
    typeof item.id !== "string" ||
    !ID.test(item.id) ||
    typeof item.path !== "string" ||
    item.path.length > 2048 ||
    typeof item.csrfToken !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(item.csrfToken) ||
    item.protocolVersion !== CONVERSATION_PROTOCOL_VERSION ||
    (item.body !== undefined &&
      (!item.body || typeof item.body !== "object" || Array.isArray(item.body)))
  )
    return;
  return item as Frame;
}

/** Deliberately narrower than IPC: no streams, uploads, file contents or long history reads. */
function boundedPath(path: string, post: boolean): string | undefined {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("#")) return;
  let url: URL;
  try {
    url = new URL(path, "http://local");
  } catch {
    return;
  }
  // Reject URL aliases and traversal before the shared router normalizes them.
  if (url.origin !== "http://local" || `${url.pathname}${url.search}` !== path) return;
  const name = relativeConversationPath(url.pathname);
  if (!isConversationPath(path, post)) return;
  if (post) {
    if (url.search) return;
    if (!POST_PATHS.has(name) && !isLegacyCodexPostPath(name)) return;
  } else if (!GET_PATHS.has(name) && !isConversationReceiptPath(name)) return;
  return `${REMOTE_ROUTE_BASE}${name}${url.search}`;
}

function rejectUpgrade(socket: Duplex, status: number) {
  if (socket.destroyed) return;
  // Drain early frames after rejecting: destroying on finish can reset the TCP
  // connection before the peer reads the response. The handshake deadline and
  // adapter shutdown still bound peers that leave their write side open.
  socket.resume();
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** Uses the HTTP service's admission and receipts for every frame, never a backend RPC proxy. */
export function attachManagedWebSocket(server: Server, options: ManagedWebSocketOptions) {
  const sockets = new Set<Duplex>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  let closed = false;

  wss.on("connection", (ws, handshake) => {
    // Identity and origin always come from the authenticated upgrade, not frame fields.
    const headers = { ...handshake.headers };
    let active: LocalConversationResponse | undefined;
    const reply = (id: string | null, status: number, body: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let data = JSON.stringify({ id, status, body });
      if (Buffer.byteLength(data) > MAX_RESPONSE)
        data = JSON.stringify({
          id,
          status: 502,
          body: { error: "response_too_large", controlOutcome: "unknown" },
        });
      if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_RESPONSE * 2) {
        ws.terminate();
        return;
      }
      ws.send(data);
    };
    ws.on("error", () => ws.terminate());
    ws.on("close", () => active?.destroy());
    ws.on("message", (bytes, binary) => {
      if (binary) {
        ws.close(1003, "json_required");
        return;
      }
      let input: Frame | undefined;
      try {
        input = frame(JSON.parse(bytes.toString()));
      } catch {
        // Malformed frames cannot supply a trustworthy response ID.
      }
      if (!input) {
        reply(null, 400, { error: "invalid_frame", controlOutcome: "not-dispatched" });
        return;
      }
      const post = input.body !== undefined;
      const path = boundedPath(input.path, post);
      if (!path) {
        reply(input.id, 404, { error: "not_found", controlOutcome: "not-dispatched" });
        return;
      }
      if (active) {
        reply(input.id, 409, { error: "request_in_progress", controlOutcome: "not-dispatched" });
        return;
      }
      const body = Buffer.from(post ? JSON.stringify(input.body) : "");
      const req: ConversationRequest = {
        method: post ? "POST" : "GET",
        url: path,
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(body.byteLength),
          "x-csrf-token": input.csrfToken,
          "x-agentkib-protocol": String(CONVERSATION_PROTOCOL_VERSION),
        },
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      };
      const res = new LocalConversationResponse();
      active = res;
      const control = { request: false, dispatched: false, priorUncertain: false };
      const id = input.id;
      void (async () => {
        try {
          // The caller rechecks cookie, CSRF, boot, grants, capabilities and request receipts.
          await options.dispatch(req, res, control);
          if (!res.destroyed) reply(id, res.statusCode, res.body);
        } catch {
          reply(id, 500, {
            error: "request_failed",
            ...(post || control.request ? { controlOutcome: "unknown" } : {}),
          });
        } finally {
          active = undefined;
        }
      })();
    });
  });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), 10_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      sockets.delete(socket);
    });
    if (closed || req.url !== SOCKET_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (
      typeof req.headers.origin !== "string" ||
      !req.headers.origin ||
      req.headers.origin === "null"
    ) {
      rejectUpgrade(socket, 403);
      return;
    }
    void (async () => {
      try {
        if (!(await options.authorize(req))) {
          rejectUpgrade(socket, 403);
          return;
        }
        if (closed || socket.destroyed) return;
        clearTimeout(timeout);
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } catch {
        rejectUpgrade(socket, 403);
      }
    })();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    server.removeListener("upgrade", upgrade);
    server.removeListener("close", close);
    for (const socket of sockets) socket.destroy();
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
  server.on("upgrade", upgrade);
  server.once("close", close);
  return { close };
}
