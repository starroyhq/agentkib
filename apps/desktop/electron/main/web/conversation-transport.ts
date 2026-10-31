import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";

export interface ConversationRequest extends AsyncIterable<Uint8Array> {
  headers: IncomingHttpHeaders;
  method?: string;
  url?: string;
}

/** Minimal response contract shared by HTTP and trusted desktop IPC. */
export interface ConversationResponse extends EventEmitter {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  setHeader(name: string, value: string): unknown;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  write(data: string): boolean;
  end(data?: string | Buffer): unknown;
  destroy(): unknown;
}

export class LocalConversationResponse extends EventEmitter implements ConversationResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  body: unknown;
  setHeader(_name: string, _value: string) {}
  writeHead(status: number) {
    this.statusCode = status;
    this.headersSent = true;
  }
  write(_data: string): boolean {
    throw new Error("stream_requires_subscription");
  }
  end(data?: string | Buffer) {
    this.body = data ? JSON.parse(data.toString()) : undefined;
    this.writableEnded = true;
    this.emit("finish");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

/** Only bounded history reads can be cancelled through the trusted desktop bridge. */
export function isHistoryReadConversationPath(path: string): boolean {
  if (path.includes("\\")) return false;
  if (!path.startsWith("/")) path = `/${path}`;
  const url = new URL(path, "http://local");
  if (url.origin !== "http://local" || url.search || url.hash) return false;
  return ["/history/search", "/history/locate", "/history/references", "/history/status"].includes(
    url.pathname.replace(/^\/api\/web\/v1(?=\/)/, ""),
  );
}

// This is a closed application API, never an arbitrary Runtime or HTTP proxy.
export function isConversationPath(path: string, post: boolean) {
  if (!path.startsWith("/") || path.includes("\\")) return false;
  const url = new URL(path, "http://local");
  if (url.origin !== "http://local") return false;
  const name = url.pathname.replace(/^\/api\/web\/v1(?=\/)/, "");
  return post
    ? [
        "/history/search",
        "/history/locate",
        "/history/references",
        "/history/configure",
        "/history/clear",
        "/history/rebuild",
        "/send",
        "/stop",
        "/approve",
        "/answer",
        "/artifact-tickets",
        "/attachments",
        "/attachments/delete",
        "/managed/create",
        "/managed/adopt",
        "/managed/release",
        "/managed/reconcile",
        "/managed/action",
        "/managed/settings-prepare",
      ].includes(name) ||
        // Keep in step with the operations WebAccessService.codexAction accepts.
        /^\/codex\/(steer|queue-add|queue-update|queue-delete|queue-reorder|queue-start|rename|archive|unarchive|fork|settings|goal-set|goal-pause|goal-resume|goal-clear|resume|inspect|compact|terminals-clean|delete)$/.test(
          name,
        )
    : [
        "/history/status",
        "/access",
        "/info",
        "/catalog",
        "/events",
        "/live",
        "/attachments",
        "/codex/capabilities",
        "/codex/queue",
        "/codex/session-settings",
        "/codex/goals",
        "/codex/context-options",
        "/managed/options",
        "/managed/capabilities",
        "/managed/inspect",
        "/managed/context",
        "/managed/resume-command",
        "/managed/settings",
        "/managed/queue",
        "/managed/goals",
        "/managed/resources",
        "/files/workspaces",
        "/files/list",
        "/files/text",
        "/artifacts",
        "/artifacts/resolve",
        "/diff",
      ].includes(name) || /^\/requests\/[A-Za-z0-9_-]{1,128}$/.test(name);
}
