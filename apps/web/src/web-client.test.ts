import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, SseParser, WebClient } from "@agentkib/web-client";

const info = {
  protocolVersion: 1,
  conversationProtocolVersion: 2,
  transport: "lan",
  capabilities: { read: true, send: true, approve: true },
};
const access = {
  protocolVersion: 2,
  status: "approved",
  csrfToken: "csrf",
  bearerToken: "secret",
  bootId: "boot",
  experimentalEnabled: true,
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("WebClient transport boundaries", () => {
  it("reads only the selected session image using its opaque ID and cancellation", async () => {
    const image = { mimeType: "image/png", base64: "aW1hZ2U=" };
    const transport = vi.fn().mockResolvedValue(json(image));
    const client = new WebClient(transport);
    const abort = new AbortController();
    await expect(
      client.sessionImage("session &other=foreign", "opaque/image?other=1", abort.signal),
    ).resolves.toEqual(image);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/api/web/v1/session-images?sessionId=session+%26other%3Dforeign&imageId=opaque%2Fimage%3Fother%3D1",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        signal: abort.signal,
        cache: "no-store",
      }),
    );
    expect(transport.mock.calls[0][1].body).toBeUndefined();
  });

  it("does not contact an unpaired LAN host for a session image", async () => {
    const transport = vi.fn();
    const client = new WebClient(transport, "http://192.168.1.10:1422");
    await expect(client.sessionImage("session", "image")).rejects.toMatchObject({
      code: "access_ended",
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("reads a host resume command with the selected identity and cancellation without dispatching", async () => {
    const command = {
      available: true,
      command: "CODEX_HOME='/host/codex' codex resume '00000000-0000-4000-8000-000000000001'",
      shell: "posix",
      runOn: "host",
    };
    const transport = vi.fn().mockResolvedValue(json(command));
    const client = new WebClient(transport);
    const abort = new AbortController();
    await expect(
      client.codexResumeCommand("session &other=foreign", abort.signal),
    ).resolves.toEqual(command);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/api/web/v1/managed/resume-command?sessionId=session+%26other%3Dforeign",
      expect.objectContaining({ method: "GET", signal: abort.signal, cache: "no-store" }),
    );
    expect(transport.mock.calls[0][1].body).toBeUndefined();
  });

  it("rejects command reads from an unpaired LAN device before contacting its host", async () => {
    const transport = vi.fn();
    const client = new WebClient(transport, "http://192.168.1.10:1422");
    await expect(client.codexResumeCommand("session")).rejects.toMatchObject({
      code: "access_ended",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("posts history search text without placing it in a URL", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValue(json({ hits: [] }));
    const client = new WebClient(transport);
    await client.access();
    await client.historySearch({ query: "private query", kinds: ["tool-output"] });
    expect(transport).toHaveBeenLastCalledWith(
      "/api/web/v1/history/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "private query", kinds: ["tool-output"] }),
      }),
    );
    expect(transport.mock.calls.every(([url]) => !String(url).includes("private"))).toBe(true);
  });

  it("explicit connection types preserve transport boundaries and legacy construction", async () => {
    const sameOrigin = vi.fn().mockResolvedValue(json(access));
    const local = new WebClient(sameOrigin, { type: "same-origin" });
    await local.access();
    expect(local.origin).toBe("");
    expect(sameOrigin).toHaveBeenCalledWith(
      "/api/web/v1/access",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const lan = vi.fn().mockResolvedValueOnce(json(info)).mockResolvedValueOnce(json(access));
    const remote = new WebClient(lan, { type: "lan-http", origin: "http://192.168.1.10:1422" });
    await remote.access();
    expect(remote.connection.type).toBe("lan-http");
    expect(lan).toHaveBeenCalledWith(
      "http://192.168.1.10:1422/api/web/v1/access",
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(new WebClient(undefined, remote.origin).connection).toEqual(remote.connection);
    expect(new WebClient().connection).toEqual({ type: "same-origin" });
    expect(
      () => new WebClient(undefined, { type: "lan-http", origin: "https://public.example" }),
    ).toThrow("invalid_lan_address");
  });

  it("bounds same-origin reads and mutations to 25 seconds and queries a receipt without replay", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const transport = vi.fn().mockResolvedValue(json({ found: false, requestId: "request" }));
    const client = new WebClient(transport);
    await client.receipt("request");
    expect(timeout).toHaveBeenCalledWith(25000);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "/api/web/v1/requests/request",
      expect.objectContaining({ method: "GET", signal: expect.any(AbortSignal) }),
    );
  });

  it("uses same-origin cookies and CSRF and sends a mutation only once", async () => {
    const transport = vi.fn().mockResolvedValue(json({ accepted: true }));
    const client = new WebClient(transport);
    transport.mockResolvedValueOnce(json(access));
    await client.access();
    transport.mockClear();

    await client.request("send", { text: "hello" });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "/api/web/v1/send",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf",
          "X-AgentKib-Protocol": "2",
        },
      }),
    );
  });

  it("keeps hosted bearer credentials out of Access and never sends cookies", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ accepted: true }));
    const client = new WebClient(transport, "http://192.168.1.10:1422");

    await expect(client.catalog()).rejects.toMatchObject({ code: "access_ended" });
    expect(transport).not.toHaveBeenCalled();
    await expect(client.access()).resolves.not.toHaveProperty("bearerToken");
    await client.request("send", { text: "hello" });

    expect(transport.mock.calls[2][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "X-CSRF-Token": "csrf",
      },
    });
  });

  it("does not access or control an incompatible hosted backend", async () => {
    const transport = vi.fn().mockResolvedValue(json({ ...info, protocolVersion: 99 }));
    const client = new WebClient(transport, "http://10.0.0.1:1422");

    await expect(client.access()).rejects.toMatchObject({ code: "incompatible_protocol" });
    await expect(client.request("send", {})).rejects.toBeInstanceOf(ApiError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([{ protocolVersion: 1, conversationProtocolVersion: 2 }, { protocolVersion: 2 }])(
    "negotiates current and transitional realtime hosts: %j",
    async (versions) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(
          json({ ...info, conversationProtocolVersion: undefined, ...versions }),
        )
        .mockResolvedValueOnce(json(access))
        .mockResolvedValueOnce(json({ accepted: true }));
      const client = new WebClient(transport, "http://192.168.1.10:1422");
      await client.access();
      await client.request("send", { text: "hello" });
      expect(transport.mock.calls[2][1].headers["X-AgentKib-Protocol"]).toBe("2");
    },
  );

  it("pairs with legacy LAN hosts using their allowed headers while keeping writes disabled", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ ...info, conversationProtocolVersion: undefined }))
      .mockResolvedValueOnce(json({ ...access, protocolVersion: undefined, status: "unpaired" }))
      .mockResolvedValueOnce(json({ pending: { id: "pairing" } }))
      .mockResolvedValueOnce(json({ ...access, protocolVersion: undefined }))
      .mockResolvedValueOnce(json({ events: [], warnings: [] }))
      .mockResolvedValueOnce(json({ found: false, requestId: "pending" }));
    const client = new WebClient(transport, "http://192.168.1.10:1422");
    await client.access();
    await client.request("pair", { code: "12345678", name: "Phone" });
    expect(transport.mock.calls[2][1].headers).toEqual({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf",
    });
    await client.access();
    await expect(client.events("s")).resolves.toMatchObject({ events: [] });
    await expect(client.receipt("pending")).resolves.toMatchObject({ found: false });
    await expect(client.request("send", { text: "draft" })).rejects.toMatchObject({
      code: "incompatible_protocol",
      controlOutcome: "not-dispatched",
    });
    const error = vi.fn();
    client.stream("s", { event: vi.fn(), open: vi.fn(), error });
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: "incompatible_protocol" }));
    expect(transport).toHaveBeenCalledTimes(6);
  });

  it("keeps legacy history and request receipts readable without falling back to snapshot controls", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ ...access, protocolVersion: undefined }))
      .mockResolvedValueOnce(json({ events: [], warnings: [] }))
      .mockResolvedValueOnce(json({ found: false, requestId: "pending" }));
    const client = new WebClient(transport);
    await client.access();
    await expect(client.events("s")).resolves.toMatchObject({ events: [] });
    await expect(client.receipt("pending")).resolves.toMatchObject({ found: false });
    await expect(client.request("send", { text: "draft" })).rejects.toMatchObject({
      code: "incompatible_protocol",
      controlOutcome: "not-dispatched",
    });
    const error = vi.fn();
    client.stream("s", { event: vi.fn(), open: vi.fn(), error });
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: "incompatible_protocol" }));
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(["not-dispatched", "unknown", undefined, "invalid"])(
    "preserves only recognized mutation outcome %s",
    async (controlOutcome) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockResolvedValue(json({ code: "permission_denied", controlOutcome }, 403));
      const client = new WebClient(transport);
      await client.access();

      await expect(client.request("send", {})).rejects.toMatchObject({
        code: "permission_denied",
        controlOutcome: controlOutcome === "invalid" ? undefined : controlOutcome,
      });
    },
  );
});

describe("hosted SSE", () => {
  it("parses CRLF, multiline data and arbitrary network chunks", () => {
    const emit = vi.fn();
    const parser = new SseParser(emit);
    for (const chunk of ["event: snap", "shot\r\ndata: {\r\n", "data: }\r\n\r", "\n"])
      parser.push(chunk);
    expect(emit).toHaveBeenCalledExactlyOnceWith("snapshot", "{\n}");
  });

  it("decodes split UTF-8 records and retries only the stream", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode(
      'event: session-event\r\nid: cursor-7\r\ndata: {"status":"空闲"}\r\n\r\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3)
          controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
      },
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(json({}, 401));
    const client = new WebClient(transport, "http://10.0.0.1:1422");
    await client.access();
    const event = vi.fn().mockReturnValue("cursor-7");
    const open = vi.fn();
    const error = vi.fn();

    const close = client.stream("session", { event, open, error });
    await vi.advanceTimersByTimeAsync(0);
    expect(event).toHaveBeenCalledWith("session-event", '{"status":"空闲"}', "cursor-7");
    expect(open).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(event).toHaveBeenCalledWith("access-ended", "");
    expect(transport).toHaveBeenCalledTimes(4);
    expect(transport.mock.calls[3][0]).toContain("protocolVersion=2");
    expect(transport.mock.calls[3][0]).toContain("afterCursor=cursor-7");

    close();
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("reconnects LAN from the last applied cursor after a rejected frame", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode(
      "event: session-event\nid: good\ndata: {}\n\nevent: session-event\nid: gap\ndata: {}\n\n",
    );
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(json({}, 401));
    const client = new WebClient(transport, "http://10.0.0.1:1422");
    await client.access();
    const close = client.stream("s", {
      event: vi.fn().mockReturnValueOnce("good").mockReturnValue(false),
      open: vi.fn(),
      error: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.mock.calls[3][0]).toContain("afterCursor=good");
    close();
  });

  it("recreates same-origin SSE with its applied cursor and delivers readiness markers", async () => {
    vi.useFakeTimers();
    const sources: FakeSource[] = [];
    class FakeSource {
      listeners = new Map<string, (event: MessageEvent) => void>();
      onopen?: () => void;
      onerror?: () => void;
      close = vi.fn();
      constructor(readonly url: string) {
        sources.push(this);
      }
      addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
      }
      emit(type: string, cursor: string) {
        this.listeners.get(type)?.({ data: "{}", lastEventId: cursor } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeSource);
    const client = new WebClient(vi.fn().mockResolvedValue(json(access)));
    await client.access();
    const event = vi.fn().mockReturnValueOnce("applied").mockReturnValue(false);
    const close = client.stream("s", { event, open: vi.fn(), error: vi.fn() });
    sources[0].emit("session-event", "applied");
    sources[0].emit("session-event", "rejected");
    sources[0].onerror?.();
    expect(sources[0].close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources[1].url).toContain("afterCursor=applied");
    sources[1].emit("session-ready", "");
    expect(event).toHaveBeenLastCalledWith("session-ready", "{}", undefined);
    close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sources).toHaveLength(2);
  });
});

describe("attachment upload transport", () => {
  it("uploads binary with CSRF, reports progress and returns only the attachment handle", async () => {
    let xhr!: FakeUpload;
    class FakeUpload {
      timeout = 0;
      withCredentials = false;
      status = 201;
      responseText = JSON.stringify({
        id: "a",
        name: "a.png",
        mime: "image/png",
        size: 3,
        version: "v",
      });
      upload: {
        onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
      } = {};
      onload?: () => void;
      onerror?: () => void;
      ontimeout?: () => void;
      onabort?: () => void;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      abort = vi.fn(() => this.onabort?.());
      constructor() {
        xhr = this;
      }
    }
    vi.stubGlobal("XMLHttpRequest", FakeUpload);
    const transport = vi.fn().mockResolvedValue(json(access));
    const client = new WebClient(transport);
    transport.mockResolvedValueOnce(json(access));
    await client.access();
    transport.mockClear();
    const progress = vi.fn();
    const file = new File(["abc"], "a.png", { type: "image/png" });
    const pending = client.uploadAttachment("session", file, progress);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("X-CSRF-Token", "csrf");
    expect(xhr.send).toHaveBeenCalledExactlyOnceWith(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 });
    expect(progress).toHaveBeenCalledWith(50);
    xhr.onload?.();
    await expect(pending).resolves.toMatchObject({ id: "a", version: "v" });
    vi.unstubAllGlobals();
  });
  it("fails closed for an unpaired LAN client before creating a transfer", async () => {
    const constructor = vi.fn();
    vi.stubGlobal("XMLHttpRequest", constructor);
    const client = new WebClient(undefined, {
      type: "lan-http",
      origin: "http://192.168.1.10:1422",
    });
    await expect(
      client.uploadAttachment("session", new File(["a"], "a.txt"), vi.fn()),
    ).rejects.toMatchObject({ code: "access_ended" });
    expect(constructor).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

it("preserves native goal intent and explicit null budget over the existing one-shot mutation transport", async () => {
  const transport = vi.fn().mockResolvedValue(json({ accepted: true }));
  const client = new WebClient(transport);
  transport.mockResolvedValueOnce(json(access));
  await client.access();
  transport.mockClear();
  const body = {
    bootId: "boot",
    requestId: "goal-update",
    sessionId: "s",
    expectedRevision: 2,
    objective: "Revise goal",
    intent: "update" as const,
    tokenBudget: null,
  };
  await client.codexAction("goal-set", body);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith(
    "/api/web/v1/codex/goal-set",
    expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
  );
});

it("routes Claude managed reads and one-shot writes without changing the Codex default", async () => {
  const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    json({ available: true }),
  );
  const client = new WebClient(transport);
  await client.managedOptions();
  await client.managedOptions("claude-code");
  await client.sessionCapabilities("session", "claude-code");
  await client.managedInspect("session", "claude-code");
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    "/api/web/v1/managed/options",
    "/api/web/v1/managed/options?agent=claude-code",
    "/api/web/v1/managed/capabilities?sessionId=session&agent=claude-code",
    "/api/web/v1/managed/inspect?sessionId=session&agent=claude-code",
  ]);
  transport.mockResolvedValueOnce(json(access));
  await client.access();
  transport.mockClear().mockRejectedValue(new Error("disconnected"));
  await expect(
    client.managedAction("adopt", {
      agent: "claude-code",
      sessionId: "session",
      bootId: "boot",
      requestId: "request",
      handoffConfirmed: true,
      handoffFingerprint: "snapshot",
    }),
  ).rejects.toThrow("disconnected");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith(
    "/api/web/v1/managed/adopt",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-AgentKib-Protocol": "2" }),
    }),
  );
});
