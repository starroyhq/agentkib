import {
  type ConversationSubscription,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import {
  ApiError,
  isHistoryReadPath,
  WebClient,
  type ConversationClientBridge,
  type Live,
  type UploadedAttachment,
} from "@agentkib/web-client";

export interface DesktopConversationResponse {
  status: number;
  body: unknown;
}

/** This bridge exposes the host's bounded conversation routes, never arbitrary RPC or paths. */
export interface DesktopConversationBridge {
  request(path: string, body?: unknown, requestId?: string): Promise<DesktopConversationResponse>;
  cancelRead?(requestId: string): Promise<void>;
  upload(input: {
    sessionId: string;
    name: string;
    mime: string;
    data: ArrayBuffer;
  }): Promise<DesktopConversationResponse>;
  subscribe(sessionId: string, afterCursor?: string): Promise<ConversationSubscription<Live>>;
  acknowledge(subscriptionId: string, cursor: string): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onEvent(listener: (event: SessionStreamEvent<Live>) => void): () => void;
  onUnavailable(listener: () => void): () => void;
  onControlChanged(listener: (sessionId: string) => void): () => void;
}

export function hasDesktopConversation(): boolean {
  return Boolean(globalThis.window?.desktopConversation);
}

export function decodeConversationResponse<Result>(response: DesktopConversationResponse): Result {
  if (response.status < 200 || response.status >= 300) {
    const body = response.body;
    const record = body !== null && typeof body === "object" ? body : {};
    const code = "code" in record ? record.code : "error" in record ? record.error : undefined;
    const outcome = "controlOutcome" in record ? record.controlOutcome : undefined;
    throw new ApiError(
      response.status,
      typeof code === "string" ? code : "request_failed",
      outcome === "not-dispatched" || outcome === "unknown" ? outcome : undefined,
    );
  }
  return response.body as Result;
}

function requireBridge(): DesktopConversationBridge {
  const bridge = globalThis.window?.desktopConversation;
  if (!bridge) throw new ApiError(503, "runtime_unavailable", "not-dispatched");
  return bridge;
}

async function bridgeRequest<Result>(
  bridge: DesktopConversationBridge,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Result> {
  signal?.throwIfAborted();
  const historyRead =
    isHistoryReadPath(path) || path.replace(/^\//, "").split("?")[0] === "history/status";
  const read = body === undefined || historyRead;
  const requestId = historyRead && bridge.cancelRead ? crypto.randomUUID() : undefined;
  const cancel = () => {
    if (requestId) void bridge.cancelRead!(requestId).catch(() => {});
  };
  if (requestId) signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = requestId
      ? await bridge.request(path, body, requestId)
      : await bridge.request(path, body);
    // Dispatched controls retain their receipt even when the view navigates away.
    if (read) signal?.throwIfAborted();
    return decodeConversationResponse<Result>(result);
  } catch (error) {
    if (read) signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function desktopConversationRequest<Result>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Result> {
  return bridgeRequest<Result>(requireBridge(), path, body, signal);
}

export function createDesktopConversationAdapter(
  getBridge: () => DesktopConversationBridge = requireBridge,
): ConversationClientBridge {
  return {
    async request<Result>(path: string, body?: unknown, signal?: AbortSignal) {
      return bridgeRequest<Result>(getBridge(), path, body, signal);
    },
    stream(sessionId, handlers) {
      const bridge = getBridge();
      let closed = false;
      let subscriptionId: string | undefined;
      let cursor: string | undefined;
      let generation = 0;
      let reconnect: ReturnType<typeof setTimeout> | undefined;
      let failures = 0;
      let buffered: SessionStreamEvent<Live>[] = [];
      let bufferedBytes = 0;
      let connecting = false;
      type Acknowledgement = {
        subscriptionId: string;
        generation: number;
        pending?: string;
        inFlight: boolean;
        scheduled: boolean;
      };
      let acknowledgement: Acknowledgement | undefined;
      const disposeSubscription = () => {
        const id = subscriptionId;
        subscriptionId = undefined;
        acknowledgement = undefined;
        if (id) void bridge.unsubscribe(id).catch(() => {});
      };
      const isCurrentAcknowledgement = (state: Acknowledgement) =>
        !closed && acknowledgement === state && generation === state.generation;
      const scheduleAcknowledgement = (state: Acknowledgement) => {
        if (
          !isCurrentAcknowledgement(state) ||
          state.inFlight ||
          state.scheduled ||
          state.pending === undefined
        )
          return;
        state.scheduled = true;
        // Bootstrap and synchronous event batches share one cumulative ACK. Each
        // connection owns its in-flight state so an old IPC promise cannot stall it.
        queueMicrotask(() => {
          state.scheduled = false;
          if (!isCurrentAcknowledgement(state) || state.pending === undefined) return;
          const applied = state.pending;
          state.pending = undefined;
          state.inFlight = true;
          void (async () => {
            try {
              await bridge.acknowledge(state.subscriptionId, applied);
            } catch (error) {
              if (!isCurrentAcknowledgement(state)) return;
              generation++;
              connecting = false;
              clearTimeout(reconnect);
              disposeSubscription();
              buffered = [];
              bufferedBytes = 0;
              handlers.error(error);
              // ACK failure only recovers observation from its applied cursor.
              if (!closed) reconnect = setTimeout(() => void connect(), 500);
            } finally {
              state.inFlight = false;
              scheduleAcknowledgement(state);
            }
          })();
        });
      };
      const deliver = (event: SessionStreamEvent<Live>) => {
        if (closed || event.subscriptionId !== subscriptionId || event.sessionId !== sessionId)
          return;
        const attempt = generation;
        const applied = handlers.event("session-event", JSON.stringify(event), event.cursor);
        // Only the consuming reducer can acknowledge the last applied event.
        // A parsed envelope or a received-but-rejected gap is not an acknowledgement.
        if (closed || generation !== attempt || event.subscriptionId !== subscriptionId) return;
        if (typeof applied === "string") {
          cursor = applied;
          if (acknowledgement) {
            acknowledgement.pending = applied;
            scheduleAcknowledgement(acknowledgement);
          }
        }
        return typeof applied === "string" ? applied : event.cursor;
      };
      const connect = async () => {
        if (closed || connecting || subscriptionId) return;
        connecting = true;
        const attempt = ++generation;
        buffered = [];
        bufferedBytes = 0;
        try {
          const result = await bridge.subscribe(sessionId, cursor);
          if (closed || generation !== attempt) {
            void bridge.unsubscribe(result.subscriptionId).catch(() => {});
            return;
          }
          subscriptionId = result.subscriptionId;
          acknowledgement = {
            subscriptionId,
            generation: attempt,
            inFlight: false,
            scheduled: false,
          };
          let readyCursor = result.cursor;
          for (const event of result.events) readyCursor = deliver(event) ?? readyCursor;
          for (const event of buffered) readyCursor = deliver(event) ?? readyCursor;
          buffered = [];
          if (closed || generation !== attempt) return;
          failures = 0;
          handlers.event("session-ready", JSON.stringify({ cursor: readyCursor }));
          handlers.open();
        } catch (error) {
          if (closed || generation !== attempt) return;
          disposeSubscription();
          // Electron serializes IPC rejections as Error messages.
          handlers.error(
            error instanceof Error && /(?:^|: )stream_limit$/.test(error.message)
              ? new ApiError(429, "stream_limit")
              : error,
          );
          // This only reconnects observation; commands are never replayed here.
          if (!closed)
            reconnect = setTimeout(() => void connect(), Math.min(500 * 2 ** failures++, 10_000));
        } finally {
          if (generation === attempt) connecting = false;
        }
      };
      const removeEvents = bridge.onEvent((event) => {
        if (closed || event.sessionId !== sessionId) return;
        if (!subscriptionId && connecting) {
          bufferedBytes += JSON.stringify(event).length * 2;
          if (buffered.length >= 256 || bufferedBytes > 4 * 1024 * 1024) {
            buffered = [];
            generation++;
            connecting = false;
            cursor = undefined;
            handlers.error(new ApiError(409, "resync_required"));
            clearTimeout(reconnect);
            if (!closed) reconnect = setTimeout(() => void connect(), 500);
            return;
          }
          buffered.push(event);
          return;
        }
        deliver(event);
      });
      const removeStatus = globalThis.window?.agentkibDesktop?.events.onRuntimeStatus((status) => {
        if (closed) return;
        if (status.state !== "ready") {
          generation++;
          connecting = false;
          clearTimeout(reconnect);
          disposeSubscription();
          buffered = [];
          handlers.error(new ApiError(503, "runtime_unavailable"));
        } else void connect();
      });
      const removeUnavailable = bridge.onUnavailable(() => {
        if (closed) return;
        generation++;
        connecting = false;
        clearTimeout(reconnect);
        disposeSubscription();
        buffered = [];
        handlers.error(new ApiError(503, "runtime_unavailable"));
        if (!closed) reconnect = setTimeout(() => void connect(), 500);
      });
      const removeControls = bridge.onControlChanged((id) => {
        if (!closed && (!sessionId || !id || id === sessionId))
          handlers.event("control-changed", JSON.stringify({ sessionId: id || sessionId }));
      });
      void connect();
      return () => {
        closed = true;
        generation++;
        clearTimeout(reconnect);
        removeEvents();
        removeStatus?.();
        removeUnavailable();
        removeControls();
        disposeSubscription();
        buffered = [];
      };
    },
    async uploadAttachment(sessionId, file, progress, signal) {
      signal?.throwIfAborted();
      // Reject before materializing bytes; the main process validates the transferred size again.
      if (file.size > 25 * 1024 * 1024) throw new ApiError(413, "attachment_too_large");
      progress(0);
      const data = await file.arrayBuffer();
      signal?.throwIfAborted();
      const bridge = getBridge();
      const attachment = decodeConversationResponse<UploadedAttachment>(
        await bridge.upload({
          sessionId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          data,
        }),
      );
      if (signal?.aborted) {
        // IPC transfer cannot be cancelled halfway; remove the now-unused staged upload.
        await bridge
          .request("attachments/delete", {
            sessionId,
            attachmentId: attachment.id,
            version: attachment.version,
          })
          .catch(() => {});
        signal.throwIfAborted();
      }
      progress(100);
      return attachment;
    },
  };
}

export function createDesktopConversationClient(): WebClient {
  return new WebClient(undefined, { type: "same-origin" }, createDesktopConversationAdapter());
}
