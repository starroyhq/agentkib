export interface ConversationSessionSummary {
  id: string;
  workspace_id: string;
  agent:
    | "codex"
    | "claude-code"
    | "cursor"
    | "opencode"
    | "open-claw"
    | "hermes"
    | "grok-build"
    | "deepseek-harness";
  title?: string;
  created_at?: string | null;
  updated_at?: string;
  origin?: "interactive" | "auxiliary" | "unknown";
  forked_from_session_id?: string | null;
  spawned_by_session_id?: string | null;
  git_branch?: string | null;
  message_count?: number | null;
  availability: "readable" | "metadata-only";
  archived: boolean;
  sidechain: boolean;
}
export interface ConversationWorkspaceSummary {
  id: string;
  name: string;
  path: string;
}
export interface ConversationCatalog {
  sessions: ConversationSessionSummary[];
  // Missing on older desktop hosts; never treat it as an empty known catalog.
  workspaces?: ConversationWorkspaceSummary[];
  indexEnabled: boolean;
}
export interface ConversationEvent {
  id: string;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string | null;
  message_phase?: "commentary" | "final_answer" | null;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  truncated: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
export type Decision = "accept" | "decline" | "cancel" | "allow" | "deny";
export interface Access {
  bearerToken?: string;
  status: "unpaired" | "pending" | "approved" | "ended";
  csrfToken: string;
  bootId: string;
  device?: { id: string; name: string; send: boolean; approve: boolean };
  pending?: { id: string; verification: string; expiresAt: string | number };
  experimentalEnabled: boolean;
}
export interface Approval {
  requestId: string | number;
  turnId: string;
  method: string;
  toolName?: string;
  input?: unknown;
  context?: {
    blockedPath?: unknown;
    decisionReason?: unknown;
    description?: unknown;
    permissionSuggestions?: unknown;
  };
  command?: unknown;
  cwd?: string;
  changes?: unknown;
  availableDecisions: Decision[];
  supported: boolean;
  unsupportedReason?: string | null;
  unsupportedMetadata?: { field: string; type: string }[];
  proposedExecpolicyAmendment?: string[] | null;
  environmentId?: "local" | null;
}
export interface UserQuestionRequest {
  requestId: string | number;
  turnId: string;
  method?: string;
  supported: boolean;
  unsupportedReason?: string | null;
  questions: {
    id: string;
    header?: string;
    question: string;
    options: { label: string; description?: string }[];
    multiSelect: boolean;
    allowCustom: boolean;
  }[];
}
export interface Live {
  sessionId: string;
  status: string;
  revision: number;
  turnId?: string;
  sendEnabled: boolean;
  approvals: Approval[];
  questions?: UserQuestionRequest[];
  reason?: string;
  executionMode?: "managed-resume";
  streamText?: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public controlOutcome?: "not-dispatched" | "unknown",
  ) {
    super(code);
  }
}
export class WebClient {
  csrfToken = "";
  private bearerToken = "";
  private compatible = false;
  private accessFlight?: Promise<Access>;
  constructor(
    private readonly transport?: typeof fetch,
    readonly origin = "",
  ) {
    if (origin && parseLanOrigin(origin) !== origin) throw new Error("invalid_lan_address");
  }
  reset() {
    this.bearerToken = "";
    this.csrfToken = "";
    this.compatible = false;
  }
  async info(signal?: AbortSignal) {
    const info = await this.request<{
      protocolVersion: number;
      transport: string;
      capabilities: { read: boolean; send: boolean; approve: boolean };
    }>("info", undefined, signal);
    this.compatible =
      info.protocolVersion === 1 &&
      info.transport === "lan" &&
      info.capabilities?.read === true &&
      typeof info.capabilities.send === "boolean" &&
      typeof info.capabilities.approve === "boolean";
    if (!this.compatible) throw new ApiError(409, "incompatible_protocol");
    return info;
  }
  private headers(body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.origin && this.bearerToken) headers.Authorization = `Bearer ${this.bearerToken}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = this.csrfToken;
    }
    return headers;
  }
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (
      this.origin &&
      path !== "info" &&
      (!this.compatible || (path !== "access" && !this.bearerToken))
    )
      throw new ApiError(401, "access_ended");
    const response = await (this.transport ?? fetch)(`${this.origin}/api/web/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: this.origin ? "omit" : "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: signal ?? (this.origin ? AbortSignal.timeout(15000) : undefined),
      headers: this.headers(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = "request_failed";
      let controlOutcome: ApiError["controlOutcome"];
      try {
        const value = await response.json();
        code = value.code ?? value.error ?? code;
        if (value.controlOutcome === "not-dispatched" || value.controlOutcome === "unknown")
          controlOutcome = value.controlOutcome;
      } catch {
        /* Never expose raw HTML/proxy bodies. */
      }
      throw new ApiError(
        response.status,
        typeof code === "string" ? code : "request_failed",
        controlOutcome,
      );
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  async access(signal?: AbortSignal) {
    if (this.origin && this.accessFlight) return this.accessFlight;
    const pending = this.loadAccess(signal);
    if (!this.origin) return pending;
    this.accessFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.accessFlight === pending) this.accessFlight = undefined;
    }
  }
  private async loadAccess(signal?: AbortSignal) {
    if (this.origin && !this.compatible) await this.info(signal);
    const result = await this.request<Access>("access", undefined, signal);
    if (this.origin && !this.bearerToken) {
      if (!result.bearerToken) throw new ApiError(401, "access_ended");
      this.bearerToken = result.bearerToken;
    }
    this.csrfToken = result.csrfToken;
    const { bearerToken: _credential, ...publicAccess } = result;
    return publicAccess;
  }
  stream(
    sessionId: string,
    handlers: {
      event: (type: string, data: string) => void;
      open: () => void;
      error: (error?: unknown) => void;
    },
  ) {
    const path = `/api/web/v1/stream?${new URLSearchParams({ sessionId })}`;
    if (!this.origin) {
      const source = new EventSource(path);
      for (const type of ["snapshot", "unavailable", "access-ended"])
        source.addEventListener(type, (e) => handlers.event(type, (e as MessageEvent).data));
      source.onopen = handlers.open;
      source.onerror = () => handlers.error();
      return () => source.close();
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        if (!this.bearerToken || !this.compatible) throw new ApiError(401, "access_ended");
        const response = await (this.transport ?? fetch)(`${this.origin}${path}`, {
          headers: this.headers(),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: abort.signal,
        });
        if (response.status === 401 || response.status === 403) {
          handlers.event("access-ended", "");
          return;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new Error("stream_unavailable");
        handlers.open();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        const parser = new SseParser(handlers.event);
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!abort.signal.aborted) handlers.error();
      } catch (error) {
        if (!abort.signal.aborted) handlers.error(error);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void run(), 2000);
    };
    void run();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }
  catalog(signal?: AbortSignal) {
    return this.request<ConversationCatalog>("catalog", undefined, signal);
  }
  events(sessionId: string, cursor?: string, signal?: AbortSignal) {
    const q = new URLSearchParams({ sessionId, limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return this.request<ConversationEventPage>(`events?${q}`, undefined, signal);
  }
  live(sessionId: string, signal?: AbortSignal) {
    return this.request<Live>(`live?${new URLSearchParams({ sessionId })}`, undefined, signal);
  }
}

/** Reject alternate numeric spellings before URL normalization can hide them. */
export function parseLanOrigin(value: string): string {
  const match = /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (!match) throw new Error("invalid_lan_address");
  const octets = match[1].split(".").map(Number);
  if (octets.some((n, i) => n > 255 || String(n) !== match[1].split(".")[i]))
    throw new Error("invalid_lan_address");
  const [a, b] = octets,
    port = Number(match[2]);
  if (
    !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== match[2]
  )
    throw new Error("invalid_lan_address");
  return `http://${match[1]}:${port}`;
}

export class SseParser {
  private lineParts: string[] = [];
  private lineBytes = 0;
  private lastCodeUnit = 0;
  private event = "message";
  private data: string[] = [];
  private dataBytes = 0;
  private encoder = new TextEncoder();
  constructor(private readonly emit: (event: string, data: string) => void) {}
  push(chunk: string) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      if (part) {
        this.lineBytes += this.encoder.encode(part).byteLength;
        // A surrogate pair split between push calls encodes as four bytes, not
        // two replacement characters (six bytes). TextDecoder normally avoids this.
        const first = part.charCodeAt(0);
        if (
          this.lastCodeUnit >= 0xd800 &&
          this.lastCodeUnit <= 0xdbff &&
          first >= 0xdc00 &&
          first <= 0xdfff
        )
          this.lineBytes -= 2;
        this.lastCodeUnit = part.charCodeAt(part.length - 1);
        if (this.lineBytes + this.dataBytes > 4 * 1024 * 1024 + 1024)
          throw new Error("stream_too_large");
        this.lineParts.push(part);
      }
      if (end < 0) return;
      // Join only completed lines: neither scanning nor byte accounting revisits
      // an accumulated near-4 MiB prefix on every network chunk.
      const line = this.lineParts.join("").replace(/\r$/, "");
      this.lineParts = [];
      this.lineBytes = 0;
      this.lastCodeUnit = 0;
      start = end + 1;
      if (!line) {
        if (this.data.length) this.emit(this.event, this.data.join("\n"));
        this.event = "message";
        this.data = [];
        this.dataBytes = 0;
      } else if (line.startsWith("event:")) {
        if (line.length > 128) throw new Error("stream_too_large");
        this.event = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.dataBytes += this.encoder.encode(value).byteLength + (this.data.length ? 1 : 0);
        if (this.dataBytes > 4 * 1024 * 1024) throw new Error("stream_too_large");
        this.data.push(value);
      }
    }
  }
}
