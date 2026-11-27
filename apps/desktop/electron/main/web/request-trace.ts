import {
  isTraceHostOperation,
  LOCAL_RUNTIME_TRACE_HOST_METHOD,
  localRuntimeTraceReason,
  type LocalRuntimeTraceEvent,
  type LocalRuntimeTraceResult,
} from "@agentkib/backend/local-runtime-trace";
import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
} from "@agentkib/runtime-protocol";
import {
  codexPostOperation,
  isControlRequest,
  isConversationReceiptPath,
  type ConversationResponse,
} from "./conversation-transport";
import type { ConversationDispatchControl } from "./managed-websocket";
import { RuntimeRequestError, RuntimeUnavailableError } from "../runtime-host";

const routeNames = new Map(
  Object.entries(REMOTE_ROUTE).map(([name, path]): [string, string] => [path, name]),
);

function webTracePath(url: string | undefined) {
  const pathname = url?.split("?", 1)[0];
  if (pathname?.startsWith(`${REMOTE_ROUTE_BASE}/`))
    return pathname.slice(REMOTE_ROUTE_BASE.length);
}

function webTraceOperation(method: string | undefined, path: string) {
  if (isConversationReceiptPath(path)) return "receipt";
  return (
    (method === "POST" ? codexPostOperation(path) : undefined) ?? routeNames.get(path) ?? "other"
  );
}

function fields(data: unknown) {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
}

export class WebRequestTraces extends WeakMap<ConversationResponse, WebRequestTrace> {
  constructor(private readonly record?: (event: LocalRuntimeTraceEvent) => void) {
    super();
  }

  observe(
    method: string | undefined,
    url: string | undefined,
    res: ConversationResponse,
    control: ConversationDispatchControl,
  ) {
    const path = this.record ? webTracePath(url) : undefined;
    if (!this.record || !path) return;
    const trace = new WebRequestTrace(webTraceOperation(method, path), this.record);
    this.set(res, trace);
    let finished = false;
    res.once("finish", () => {
      finished = true;
      queueMicrotask(() => trace.respond(res.statusCode));
    });
    res.once("close", () => {
      if (!finished) trace.disconnect(control.request || isControlRequest(method, path));
    });
    return trace;
  }

  error(res: ConversationResponse, error: unknown, status: number, body: unknown) {
    const trace = this.get(res);
    if (!trace) return;
    const runtimeError = error instanceof RuntimeRequestError;
    trace.respond(
      status,
      body,
      runtimeError || error instanceof RuntimeUnavailableError,
      runtimeError ? fields(error.data)?.detail : undefined,
    );
  }

  streamUnavailable(res: ConversationResponse, error?: unknown) {
    const trace = this.get(res);
    if (!trace) return;
    const detail = error instanceof RuntimeRequestError ? fields(error.data)?.detail : undefined;
    trace.respond(503, { error: REMOTE_ERROR_CODES.streamUnavailable }, true, detail);
  }
}

export class WebRequestTrace {
  readonly #started = performance.now();
  #finished = false;
  #dispatched = false;
  cancelled = false;

  constructor(
    private operation: string,
    private readonly record: (event: LocalRuntimeTraceEvent) => void,
  ) {}

  markDispatched() {
    this.#dispatched = true;
  }

  setOperation(operation: unknown) {
    if (this.operation === "managedAction" && isTraceHostOperation(operation))
      this.operation = operation;
  }

  respond(status: number, data?: unknown, dispatchFailure = false, detail?: unknown) {
    if (this.#finished) return;
    const body = fields(data);
    const reply = fields(body?.ack) ?? body;
    const code =
      localRuntimeTraceReason(detail) ?? localRuntimeTraceReason(reply?.error ?? reply?.reason);
    const timeout =
      status === 504 &&
      (code === REMOTE_ERROR_CODES.catalogReadTimeout ||
        code === REMOTE_ERROR_CODES.outcomeUnknown);
    const stage =
      dispatchFailure || timeout
        ? "host-dispatch"
        : this.#dispatched || status < 400
          ? "host-response"
          : "host-admission";
    if (reply?.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown) {
      this.finish({
        stage,
        outcome: "unknown",
        reason: code ?? REMOTE_ERROR_CODES.outcomeUnknown,
      });
    } else if (this.cancelled || code === REMOTE_ERROR_CODES.historyRequestCancelled) {
      this.finish({
        stage,
        outcome: "cancelled",
        reason: REMOTE_ERROR_CODES.historyRequestCancelled,
      });
    } else if (
      reply?.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched ||
      status >= 400 ||
      reply?.accepted === false
    ) {
      const refused =
        reply?.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched || status < 500;
      this.finish({
        stage,
        outcome: refused ? "refused" : "failed",
        reason: code ?? REMOTE_ERROR_CODES.requestFailed,
      });
    } else {
      this.finish({
        stage,
        outcome: reply?.accepted === true && reply.completed !== true ? "accepted" : "completed",
      });
    }
  }

  disconnect(control: boolean) {
    if (this.#finished) return;
    if (this.cancelled) {
      this.finish({
        stage: "host-dispatch",
        outcome: "cancelled",
        reason: REMOTE_ERROR_CODES.historyRequestCancelled,
      });
    } else if (control) {
      // A browser disconnect does not cancel a command the server may still dispatch.
      this.finish({
        stage: "host-dispatch",
        outcome: "unknown",
        reason: REMOTE_ERROR_CODES.connectionFailed,
      });
    } else {
      this.finish({
        stage: "host-dispatch",
        outcome: "failed",
        reason: REMOTE_ERROR_CODES.connectionFailed,
      });
    }
  }

  finish(result: LocalRuntimeTraceResult) {
    if (this.#finished) return;
    this.#finished = true;
    try {
      this.record({
        kind: "request",
        method: LOCAL_RUNTIME_TRACE_HOST_METHOD,
        operation: this.operation,
        durationMs: performance.now() - this.#started,
        ...result,
      });
    } catch {
      // Diagnostics may be unavailable even when the host can serve the request.
    }
  }
}
