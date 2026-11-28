import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  conversationReconnectDelay,
  decodeApiError,
  isRetryableReadStateUpdateError,
  isTemporaryReadStateError,
  REMOTE_ERROR_CODES,
  SseParser,
  WebClient,
} from "@agentkib/web-client";

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
  it.each([
    [
      { error: "request_failed", reason: "TRANSCRIPT_UNREADABLE" },
      500,
      "request_failed",
      "TRANSCRIPT_UNREADABLE",
    ],
    [{ error: "stale_cursor" }, 409, "stale_cursor", undefined],
    [
      { error: "outcome_unknown", reason: "runtime_read_timeout" },
      504,
      "outcome_unknown",
      "runtime_read_timeout",
    ],
    [{ error: "request_failed", reason: "runtime_read_timeout" }, 500, "request_failed", undefined],
    [
      { error: "outcome_unknown", reason: "runtime_read_timeout" },
      403,
      "outcome_unknown",
      undefined,
    ],
    [
      { error: "outcome_unknown", reason: "TRANSCRIPT_UNREADABLE" },
      504,
      "outcome_unknown",
      undefined,
    ],
    [
      { error: "/private/path/log.jsonl", reason: "/private/path/log.jsonl" },
      409,
      "request_failed",
      undefined,
    ],
    [
      { error: "request_failed", reason: "associated-terminal-has-token" },
      409,
      "request_failed",
      undefined,
    ],
    [{ error: "unregistered", reason: "TRANSCRIPT_UNREADABLE" }, 409, "request_failed", undefined],
    [{ error: "request_failed", reason: "worker-unavailable" }, 409, "request_failed", undefined],
  ])(
    "preserves fixed history reasons and discards unregistered text (%j)",
    async (body, status, code, reason) => {
      const client = new WebClient(vi.fn().mockResolvedValue(json(body, status)));
      await expect(client.events("session")).rejects.toMatchObject({
        status,
        code,
        reason,
        message: code,
      });
    },
  );

  it("preserves the specific Project Agent designation refusal through WebClient", async () => {
    const error = REMOTE_ERROR_CODES.leadRequiresManagedClaude;
    const reason = REMOTE_ERROR_CODES.leadClaudeTerminalDisconnected;
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ error, reason }, 409));
    const client = new WebClient(transport);
    await client.access();

    await expect(
      client.manageProjectAgent({ sessionId: "lead", operation: "designate" }),
    ).rejects.toMatchObject({ status: 409, code: error, reason });
  });

  it("uses the paired Project Agent endpoint to list and assign Workers", async () => {
    const options = {
      capable: true,
      remaining: 2,
      eligibility: {
        executionSide: "agentkib",
        availability: { available: true },
        toolsReady: null,
      },
      candidates: [{ sessionId: "worker", reason: null }],
    };
    const assigned = {
      lead: { sessionId: "lead with space", workers: [{ sessionId: "worker" }] },
      capable: true,
      controlOutcome: "accepted",
    };
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ ...access, projectAgentAssignmentVersion: 1 }))
      .mockResolvedValueOnce(json(options))
      .mockResolvedValueOnce(json(assigned));
    const client = new WebClient(transport);
    await expect(client.access()).resolves.toMatchObject({ projectAgentAssignmentVersion: 1 });
    await expect(client.projectAgentAssignmentOptions("lead with space")).resolves.toEqual(options);
    const body = {
      sessionId: "lead with space",
      operation: "lead-assign-workers" as const,
      workers: ["worker"],
    };
    await expect(client.assignProjectAgentWorkers(body)).resolves.toEqual(assigned);

    const [readPath, read] = transport.mock.calls[1]!;
    expect(readPath.split("?")[0]).toContain("/managed/project-agent");
    expect(new URLSearchParams(readPath.split("?")[1]).get("sessionId")).toBe(body.sessionId);
    expect(new URLSearchParams(readPath.split("?")[1]).get("operation")).toBe(
      "lead-assignment-options",
    );
    expect(read.body).toBeUndefined();
    const [writePath, write] = transport.mock.calls[2]!;
    expect(writePath.split("?")[0]).toContain("/managed/project-agent");
    expect(new URLSearchParams(writePath.split("?")[1]).get("operation")).toBe(body.operation);
    expect(write.headers["X-AgentKib-Protocol"]).toBe("2");
    expect(JSON.parse(write.body)).toEqual(body);
  });

  it.each([
    [403, REMOTE_ERROR_CODES.permissionDenied, "not-dispatched"],
    [409, REMOTE_ERROR_CODES.accessChanged, "unknown"],
    [502, REMOTE_ERROR_CODES.requestFailed, undefined],
  ] as const)(
    "preserves or infers the assignment outcome for status %i",
    async (status, error, outcome) => {
      const client = new WebClient(
        vi
          .fn()
          .mockResolvedValueOnce(json(access))
          .mockResolvedValueOnce(json({ error, controlOutcome: outcome }, status)),
      );
      await client.access();
      await expect(
        client.assignProjectAgentWorkers({
          operation: "lead-assign-workers",
          sessionId: "lead",
          workers: ["worker"],
        }),
      ).rejects.toMatchObject({ status, code: error, controlOutcome: outcome ?? "unknown" });
    },
  );

  it.each([
    () => Promise.reject(new TypeError("failed network")),
    () => Promise.resolve(json({ lead: null })),
  ])("does not retry an assignment without a confirmed result", async (attempt) => {
    const transport = vi.fn().mockResolvedValueOnce(json(access)).mockImplementationOnce(attempt);
    const client = new WebClient(transport);
    await client.access();
    await expect(
      client.assignProjectAgentWorkers({
        operation: "lead-assign-workers",
        sessionId: "lead",
        workers: ["worker"],
      }),
    ).rejects.toMatchObject({ code: REMOTE_ERROR_CODES.outcomeUnknown, controlOutcome: "unknown" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("decodes a registered Worker assignment refusal with the shared decoder", () => {
    const error = REMOTE_ERROR_CODES.workerUnavailable;
    const reason = REMOTE_ERROR_CODES.workerTerminalDisconnected;
    expect(decodeApiError(409, { error, reason })).toMatchObject({
      status: 409,
      code: error,
      reason,
    });
  });

  it.each([
    [400, REMOTE_ERROR_CODES.invalidInput, undefined],
    [409, REMOTE_ERROR_CODES.workerUnavailable, REMOTE_ERROR_CODES.workerTerminalDisconnected],
  ])("preserves the Worker role edit refusal with status %i", async (status, error, reason) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ error, reason }, status));
    const client = new WebClient(transport);
    await client.access();
    const edit = {
      sessionId: "lead",
      worker: "worker",
      operation: "worker-role" as const,
      role: { label: "Example", description: "Worker role editing" },
    };
    const refused = client.manageProjectAgent(edit);
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status, code: error, reason });
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual(edit);
  });

  it("keeps legacy status and code while exposing a registered read-timeout reason", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(json({ error: "outcome_unknown", reason: "runtime_read_timeout" }, 504));
    const client = new WebClient(transport);
    await expect(client.request("live?sessionId=session")).rejects.toMatchObject({
      status: 504,
      code: "outcome_unknown",
      reason: "runtime_read_timeout",
      controlOutcome: undefined,
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    [new Response("<h1>Private proxy response</h1>", { status: 502 }), undefined],
    [
      json({ error: "Private response", reason: "Private reason", controlOutcome: "unknown" }, 502),
      "unknown",
    ],
  ])("uses a fixed fallback for an unrecognized error response", async (response, outcome) => {
    const client = new WebClient(vi.fn().mockResolvedValue(response));
    await expect(client.request("live?sessionId=session")).rejects.toMatchObject({
      status: 502,
      code: "request_failed",
      reason: undefined,
      controlOutcome: outcome,
    });
  });

  it("uses the legacy acknowledgement body and an optional explicit mark on the same route", async () => {
    const readState = { status: "read", version: "next" };
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ ...access, readStateVersion: 1, readStateMarkVersion: 1 }))
      .mockResolvedValueOnce(json({ readState }))
      .mockResolvedValueOnce(json({ readState: { ...readState, status: "unread" } }));
    const client = new WebClient(transport);
    expect(await client.access()).toMatchObject({ readStateMarkVersion: 1 });
    expect(await client.acknowledgeReadState("s", "first", "result")).toEqual({
      readState,
      acknowledged: true,
    });
    expect(await client.markReadState("s", "next", null, "unread")).toEqual({
      readState: { ...readState, status: "unread" },
      acknowledged: true,
    });
    for (const [index, body] of [
      { sessionId: "s", expectedVersion: "first", seenResultId: "result" },
      { sessionId: "s", expectedVersion: "next", seenResultId: null, mark: "unread" },
    ].entries()) {
      expect(transport.mock.calls[index + 1]).toEqual([
        "/api/web/v1/read-state",
        expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
      ]);
    }
  });

  it.each([
    [409, "read_state_conflict", true],
    [409, "access_changed", undefined],
    [503, "read_state_unavailable", undefined],
  ])(
    "distinguishes explicit read-state conflicts from uncertain writes (%s %s)",
    async (status, error, conflict) => {
      const readState = { status: "unread", version: "next" };
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockResolvedValueOnce(json({ error }, status))
        .mockResolvedValueOnce(json({ readState }));
      const client = new WebClient(transport);
      await client.access();
      expect(await client.acknowledgeReadState("s", "first", "result")).toEqual({
        readState,
        acknowledged: false,
        ...(conflict ? { conflict } : {}),
      });
      expect(
        transport.mock.calls.slice(1).map(([path, options]) => [path, options.method]),
      ).toEqual([
        ["/api/web/v1/read-state", "POST"],
        ["/api/web/v1/read-state?sessionId=s", "GET"],
      ]);
    },
  );

  it.each([
    [429, REMOTE_ERROR_CODES.rateLimited],
    [409, REMOTE_ERROR_CODES.operationBusy],
  ])("keeps a definite read-state refusal classified (%s %s)", async (status, code) => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ error: code }, status));
    const client = new WebClient(transport);
    await client.access();

    const refused = client.acknowledgeReadState("s", "first", "result");
    await expect(refused).rejects.toMatchObject({ status, code });
    await refused.catch((error: unknown) =>
      expect(isRetryableReadStateUpdateError(error)).toBe(true),
    );
    expect(transport.mock.calls.slice(1).map(([, options]) => options.method)).toEqual(["POST"]);
  });

  it.each([
    [504, REMOTE_ERROR_CODES.outcomeUnknown, false],
    [503, REMOTE_ERROR_CODES.readStateUnavailable, false],
    [409, REMOTE_ERROR_CODES.readStateConflict, true],
  ])(
    "retains the original write outcome when reading back is limited (%s %s)",
    async (status, code, conflict) => {
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockResolvedValueOnce(json({ error: code }, status))
        .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.rateLimited }, 429));
      const client = new WebClient(transport);
      await client.access();

      const receipt = client.acknowledgeReadState("s", "first", "result");
      await expect(receipt).rejects.toMatchObject({
        name: "ReadStateReconciliationError",
        conflict,
        cause: { status: 429, code: REMOTE_ERROR_CODES.rateLimited },
      });
      await receipt.catch((error: Error) => {
        expect(isRetryableReadStateUpdateError(error)).toBe(false);
        expect(isTemporaryReadStateError(error.cause)).toBe(true);
      });
      expect(transport.mock.calls.slice(1).map(([, options]) => options.method)).toEqual([
        "POST",
        "GET",
      ]);
    },
  );

  it("starts a fresh receipt read only after the same session's pending read settles", async () => {
    let finishProbe!: (response: Response) => void;
    const pendingProbe = new Promise<Response>((resolve) => {
      finishProbe = resolve;
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockReturnValueOnce(pendingProbe)
      .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.outcomeUnknown }, 504))
      .mockResolvedValueOnce(json({ readState: { status: "read", version: "new" } }));
    const client = new WebClient(transport);
    await client.access();

    const read = client.readState;
    const probe = read("s");
    const reconciling = new Promise<void>((resolve) => {
      vi.spyOn(client, "readState").mockImplementation((...args) => {
        const response = read(...args);
        resolve();
        return response;
      });
    });
    const receipt = client.acknowledgeReadState("s", "old", "result");
    await reconciling;
    expect(transport.mock.calls.slice(1).map(([, options]) => options.method)).toEqual([
      "GET",
      "POST",
    ]);
    finishProbe(json({ readState: { status: "unread", version: "old" } }));
    expect(await probe).toMatchObject({ readState: { status: "unread" } });
    expect(await receipt).toMatchObject({
      acknowledged: false,
      readState: { status: "read", version: "new" },
    });
    expect(transport.mock.calls.at(-1)?.[1].method).toBe("GET");
  });

  it("decodes registered read-state details through the shared transport error", async () => {
    const error = REMOTE_ERROR_CODES.readStateConflict;
    const reason = REMOTE_ERROR_CODES.readStateConflictDetail;
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ ...access, readStateVersion: 1, readStateMarkVersion: 1 }))
      .mockResolvedValueOnce(json({ error, reason }, 409));
    const client = new WebClient(transport);
    await client.access();

    const refused = client.request("read-state", {
      sessionId: "s",
      expectedVersion: "first",
      seenResultId: "result",
      mark: "read",
    });
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({ status: 409, code: error, reason });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("opts into a task summary without changing catalog reads on old hosts", async () => {
    const legacyCatalog = { indexEnabled: true, sessions: [] };
    const snapshot = { version: "scoped-version", groups: {}, coverage: { complete: true } };
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(legacyCatalog))
      .mockResolvedValueOnce(json(legacyCatalog))
      .mockResolvedValueOnce(json({ taskSummary: snapshot }));
    const client = new WebClient(transport);
    const signal = new AbortController().signal;
    await expect(client.catalog(signal)).resolves.toEqual(legacyCatalog);
    await expect(client.taskSummary(signal)).resolves.toBeUndefined();
    await expect(client.taskSummary(signal)).resolves.toEqual(snapshot);
    expect(transport.mock.calls.map(([path]) => path)).toEqual([
      "/api/web/v1/catalog",
      "/api/web/v1/catalog?taskSummary=1",
      "/api/web/v1/catalog?taskSummary=1",
    ]);
    expect(transport.mock.calls[2][1]).toMatchObject({ method: "GET", signal });
  });
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

  it("requests the native model picker only on the existing Claude session", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValue(json({ accepted: true }));
    const client = new WebClient(transport);
    const body = {
      requestId: "request",
      sessionId: "terminal-session",
      bootId: "boot",
      expectedRevision: 2,
    };
    for (const agent of ["codex", "devin", "deepseek-harness"] as const)
      await expect(client.sessionAction("open-model-picker", body, agent)).rejects.toMatchObject({
        code: "operation_unavailable",
      });
    expect(transport).not.toHaveBeenCalled();
    await client.access();
    await client.sessionAction("open-model-picker", body, "claude-code");
    expect(transport).toHaveBeenLastCalledWith(
      "/api/web/v1/managed/action",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...body, operation: "open-model-picker", agent: "claude-code" }),
      }),
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("uses the narrow Codex queue delete route on LAN", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(json({ accepted: true }));
    const origin = "http://192.168.1.10:1422";
    const client = new WebClient(transport, origin);
    await client.access();
    const action = {
      requestId: "request",
      sessionId: "session",
      expectedRevision: 2,
      bootId: "boot",
      queuedSubmissionId: "waiting",
    };
    await expect(client.sessionAction("queue-delete", action, "codex")).resolves.toEqual({
      accepted: true,
    });
    expect(transport).toHaveBeenLastCalledWith(
      `${origin}/api/web/v1/codex/queue-delete`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(action) }),
    );
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

describe("ordinary API rate limiting", () => {
  it.each([
    ["7", 7000],
    ["Thu, 01 Jan 1970 00:00:15 GMT", 5000],
    ["-2", undefined],
    ["1.5", undefined],
    ["99999999999999999999999", undefined],
  ])(
    "returns the Retry-After header as milliseconds without replaying the write (%s)",
    async (header, expected) => {
      vi.spyOn(Date, "now").mockReturnValue(10000);
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockResolvedValueOnce(
          Response.json(
            { error: "rate_limited", controlOutcome: "unknown" },
            {
              status: 429,
              headers: { "Retry-After": header },
            },
          ),
        );
      const client = new WebClient(transport);
      await client.access();
      await expect(client.request("send", {})).rejects.toMatchObject({
        status: 429,
        code: "rate_limited",
        controlOutcome: "unknown",
        retryAfterMs: expected,
      });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );
});

describe("hosted SSE", () => {
  beforeEach(() => vi.spyOn(Math, "random").mockReturnValue(0));

  it.each([
    ["read timeout", { error: "outcome_unknown", reason: "runtime_read_timeout" }, true],
    ["unclassified timeout", { error: "outcome_unknown" }, false],
    [
      "unknown control outcome",
      { error: "outcome_unknown", reason: "runtime_read_timeout", controlOutcome: "unknown" },
      false,
    ],
  ] as const)(
    "reconnects on a handshake 504 only for a proved read timeout (%s)",
    async (_, body, retry) => {
      vi.useFakeTimers();
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockImplementationOnce(() => Promise.resolve(json(body, 504)))
        .mockImplementationOnce(() =>
          Promise.resolve(
            new Response("event: session-ready\ndata: {}\n\n", {
              headers: { "Content-Type": "text/event-stream" },
            }),
          ),
        );
      const client = new WebClient(transport);
      await client.access();
      const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
      const close = client.stream("s", handlers);
      try {
        await vi.advanceTimersByTimeAsync(1999);
        expect(transport).toHaveBeenCalledTimes(2);
        expect(handlers.error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status: 504, code: body.error }),
          ...(retry ? [] : ["stopped"]),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(transport).toHaveBeenCalledTimes(retry ? 3 : 2);
        expect(handlers.open).toHaveBeenCalledTimes(retry ? 1 : 0);
      } finally {
        close();
      }
    },
  );

  it.each([
    ["still approved", () => json(access)],
    ["explicitly ended", () => json({ ...access, status: "ended" })],
    ["structured revocation", () => json({ error: REMOTE_ERROR_CODES.accessEnded }, 401)],
    ["unproved denial", () => new Response(null, { status: 401 })],
  ] as const)("checks detail access after a proxy 401 (%s)", async (outcome, reply) => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(new Response("proxy", { status: 401 }))
      .mockImplementationOnce(() => Promise.resolve(reply()))
      .mockResolvedValueOnce(
        new Response("event: session-ready\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    const client = new WebClient(transport);
    await client.access();
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    const close = client.stream("s", handlers);
    try {
      await vi.advanceTimersByTimeAsync(1999);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(transport).toHaveBeenLastCalledWith(
        "/api/web/v1/access",
        expect.objectContaining({ method: "GET" }),
      );
      await vi.advanceTimersByTimeAsync(1);
      if (outcome === "still approved") {
        expect(transport).toHaveBeenCalledTimes(4);
        expect(handlers.event).toHaveBeenCalledWith("session-ready", "{}", undefined);
        expect(handlers.event).not.toHaveBeenCalledWith("access-ended", "");
      } else if (outcome === "unproved denial") {
        expect(handlers.event).not.toHaveBeenCalled();
        expect(handlers.error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status: 401, code: REMOTE_ERROR_CODES.streamUnavailable }),
          "stopped",
        );
      } else {
        expect(handlers.event).toHaveBeenCalledExactlyOnceWith("access-ended", "");
        expect(handlers.error).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledTimes(3);
      }
    } finally {
      close();
    }
  });

  it("retains the last applied cursor when an established stream reports a read timeout", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(
          "id: applied\nevent: session-event\ndata: {}\n\n" +
            "id: rejected\nevent: session-event\ndata: {}\n\n" +
            'event: unavailable\ndata: {"reason":"runtime_read_timeout"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.accessEnded }, 401));
    const client = new WebClient(transport);
    await client.access();
    const event = vi.fn((_type: string, _body: string, cursor?: string) =>
      cursor === "applied" ? cursor : false,
    );
    const error = vi.fn();
    const close = client.stream("s", { event, open: vi.fn(), error });
    try {
      await vi.advanceTimersByTimeAsync(2000);
      expect(event).toHaveBeenCalledWith("unavailable", '{"reason":"runtime_read_timeout"}');
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "runtime_read_timeout" }),
      );
      expect(transport).toHaveBeenLastCalledWith(
        "/api/web/v1/stream?protocolVersion=2&sessionId=s&afterCursor=applied",
        expect.any(Object),
      );
    } finally {
      close();
    }
  });

  it("bounds detail authorization rechecks within the original reconnect budget", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/access") ? json(access) : new Response(null, { status: 401 }),
    );
    const client = new WebClient(transport);
    await client.access();
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    const close = client.stream("s", handlers);
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(
        transport.mock.calls.filter(([input]) => String(input).includes("/stream?")),
      ).toHaveLength(7);
      expect(
        transport.mock.calls.filter(([input]) => String(input).endsWith("/access")),
      ).toHaveLength(8);
      expect(handlers.open).not.toHaveBeenCalled();
      expect(handlers.event).not.toHaveBeenCalled();
      expect(handlers.error).toHaveBeenCalledTimes(7);
      expect(handlers.error).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 401, code: REMOTE_ERROR_CODES.streamUnavailable }),
        "stopped",
      );
    } finally {
      close();
    }
  });

  it("aborts the authorization check when its detail stream closes", async () => {
    vi.useFakeTimers();
    let probeSignal: AbortSignal | null | undefined;
    let finishProbe!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => (finishProbe = resolve));
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockImplementationOnce(async () => new Response(null, { status: 401 }))
      .mockImplementationOnce((_path: string, options: RequestInit) => {
        probeSignal = options.signal;
        return probe;
      });
    const client = new WebClient(transport);
    await client.access();
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    const close = client.stream("s", handlers);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(probeSignal?.aborted).toBe(false);
      close();
      expect(probeSignal?.aborted).toBe(true);
      finishProbe(json({ ...access, status: "ended" }));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(handlers.event).not.toHaveBeenCalled();
      expect(handlers.open).not.toHaveBeenCalled();
      expect(handlers.error).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it.each(["rate_limited", "stream_limit"])(
    "keeps %s and honors the server's Retry-After before reconnecting",
    async (code) => {
      vi.useFakeTimers();
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockImplementation(() =>
          Promise.resolve(
            Response.json({ error: code }, { status: 429, headers: { "Retry-After": "8" } }),
          ),
        );
      const client = new WebClient(transport);
      await client.access();
      const error = vi.fn();
      const close = client.stream("s", { event: vi.fn(), open: vi.fn(), error });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            status: 429,
            code,
            retryAfterMs: 8000,
          }),
        );
        await vi.advanceTimersByTimeAsync(7999);
        expect(transport).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport).toHaveBeenCalledTimes(3);
      } finally {
        close();
      }
    },
  );

  it.each([
    new Response(null, { status: 401 }),
    new Response("<h1>Sign in to proxy</h1>", {
      status: 401,
      headers: { "Content-Type": "text/html" },
    }),
    new Response('{"error":', {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
    json({}, 401),
  ])(
    "leaves access verification for a stopped directory handshake to its controller",
    async (reply) => {
      vi.useFakeTimers();
      const transport = vi.fn().mockResolvedValueOnce(json(access)).mockResolvedValueOnce(reply);
      const client = new WebClient(transport);
      await client.access();
      const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
      const close = client.stream("", handlers);
      try {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(handlers.event).not.toHaveBeenCalled();
        expect(handlers.open).not.toHaveBeenCalled();
        expect(handlers.error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status: 401, code: REMOTE_ERROR_CODES.streamUnavailable }),
          "stopped",
        );
        expect(transport).toHaveBeenCalledTimes(2);
      } finally {
        close();
      }
    },
  );

  it("does not treat an unterminated authorization response as proof", async () => {
    vi.useFakeTimers();
    const responseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":"access_ended"}'));
      },
    });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(responseBody, {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const client = new WebClient(transport);
    await client.access();
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    const close = client.stream("", handlers);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(handlers.event).not.toHaveBeenCalled();
      expect(handlers.error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 401, code: REMOTE_ERROR_CODES.streamUnavailable }),
        "stopped",
      );
    } finally {
      close();
    }
  });

  it("preserves the legacy access-ended frame without retrying the stream", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response("event: access-ended\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    const client = new WebClient(transport);
    await client.access();
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    const close = client.stream("s", handlers);
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(handlers.event).toHaveBeenCalledExactlyOnceWith("access-ended", "{}", undefined);
      expect(handlers.error).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      close();
    }
  });

  it.each(["continued access", "device revoked"])(
    "reconnects from the applied cursor after an access change (%s)",
    async (accessOnReconnect) => {
      vi.useFakeTimers();
      const reason = REMOTE_ERROR_CODES.accessChanged;
      const terminal = `event: unavailable\ndata: ${JSON.stringify({ reason })}\n\n`;
      const sse = (body: string) =>
        new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockResolvedValueOnce(
          sse(
            "id: applied\nevent: session-event\ndata: {}\n\n" +
              "id: rejected\nevent: session-event\ndata: {}\n\n" +
              terminal,
          ),
        )
        .mockImplementation(() =>
          Promise.resolve(
            accessOnReconnect === "device revoked"
              ? json({ error: REMOTE_ERROR_CODES.accessEnded }, 401)
              : sse(terminal),
          ),
        );
      const client = new WebClient(transport);
      await client.access();
      const error = vi.fn();
      const event = vi.fn((_type: string, _data: string, cursor?: string) =>
        cursor === "applied" ? cursor : false,
      );
      const close = client.stream("s", { event, open: vi.fn(), error });
      try {
        await vi.advanceTimersByTimeAsync(1999);
        expect(event).toHaveBeenLastCalledWith("unavailable", JSON.stringify({ reason }));
        expect(error).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ status: 0, code: reason }),
        );
        expect(transport).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(transport).toHaveBeenLastCalledWith(
          "/api/web/v1/stream?protocolVersion=2&sessionId=s&afterCursor=applied",
          expect.any(Object),
        );

        await vi.advanceTimersByTimeAsync(300_000);
        if (accessOnReconnect === "device revoked") {
          expect(event).toHaveBeenLastCalledWith("access-ended", "");
          expect(error).toHaveBeenCalledTimes(1);
          expect(transport).toHaveBeenCalledTimes(3);
        } else {
          expect(event).not.toHaveBeenCalledWith("access-ended", "");
          expect(error).toHaveBeenCalledTimes(7);
          expect(error).toHaveBeenLastCalledWith(
            expect.objectContaining({ status: 0, code: reason }),
            "stopped",
          );
          expect(transport).toHaveBeenCalledTimes(8);
        }
      } finally {
        close();
      }
    },
  );

  it("bounds reconnect attempts when the host stays unavailable", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockImplementation(() => Promise.resolve(json({ error: "runtime_unavailable" }, 500)));
    const client = new WebClient(transport);
    await client.access();
    const error = vi.fn();
    const close = client.stream("s", { event: vi.fn(), open: vi.fn(), error });
    try {
      await vi.advanceTimersByTimeAsync(300_000);
      expect(transport).toHaveBeenCalledTimes(8);
      expect(error).toHaveBeenCalledTimes(7);
      expect(error).toHaveBeenLastCalledWith(
        expect.objectContaining({ code: "runtime_unavailable" }),
        "stopped",
      );
    } finally {
      close();
    }
  });

  it("reports a successful non-SSE response as invalid without replaying a request", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response("<html>private proxy path</html>", {
          headers: { "Content-Type": "text/html" },
        }),
      );
    const client = new WebClient(transport);
    await client.access();
    const error = vi.fn();
    const close = client.stream("s", { event: vi.fn(), open: vi.fn(), error });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "stream_invalid_response" }),
        "stopped",
      );
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      close();
    }
  });

  it.each([
    [403, "workspace_not_authorized"],
    [403, "access_changed"],
    [401, "account_login_required"],
  ])("keeps scoped denial %s/%s separate from device revocation", async (status, code) => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(Response.json({ error: code }, { status }))
      .mockResolvedValueOnce(Response.json({ error: code }, { status }));
    const client = new WebClient(transport);
    await client.access();
    const error = vi.fn();
    const event = vi.fn();
    const close = client.stream("s", { event, open: vi.fn(), error });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(error).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status, code }),
        "stopped",
      );
      expect(event).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(status === 401 ? 3 : 2);
    } finally {
      close();
    }
  });

  it.each([
    ["runtime_unavailable", "runtime_unavailable"],
    ["raw /private/control", "stream_unavailable"],
  ])(
    "projects the terminal event as a fixed reason and never advances the cursor",
    async (wireReason, code) => {
      vi.useFakeTimers();
      const terminal = `id: terminal\nevent: unavailable\ndata: ${JSON.stringify({ reason: wireReason })}\n\n`;
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(access))
        .mockImplementation(() =>
          Promise.resolve(
            new Response(terminal, { headers: { "Content-Type": "text/event-stream" } }),
          ),
        );
      const client = new WebClient(transport);
      await client.access();
      const error = vi.fn();
      const event = vi.fn().mockReturnValue("terminal");
      const close = client.stream("s", { event, open: vi.fn(), error });
      try {
        await vi.advanceTimersByTimeAsync(2000);
        expect(event).toHaveBeenCalledWith("unavailable", JSON.stringify({ reason: code }));
        expect(error).toHaveBeenCalledWith(expect.objectContaining({ code }));
        expect(transport.mock.calls[2][0]).not.toContain("afterCursor");
      } finally {
        close();
      }
    },
  );

  it("jitters the retry delay even at the ceiling", () => {
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.9);
    expect(conversationReconnectDelay(0, 500, 10_000)).toBe(500);
    expect(conversationReconnectDelay(0, 500, 10_000)).toBe(590);
    vi.mocked(Math.random).mockReturnValueOnce(0).mockReturnValueOnce(0.9);
    expect(conversationReconnectDelay(32, 500, 10_000)).toBe(8333);
    expect(conversationReconnectDelay(32, 500, 10_000)).toBe(9833);
  });

  it("requests task summaries only on opted-in global streams", async () => {
    const transport = vi.fn().mockResolvedValue(json({ ...access, taskSummaryVersion: 1 }));
    const client = new WebClient(transport);
    expect((await client.access()).taskSummaryVersion).toBe(1);
    const handlers = { event: vi.fn(), open: vi.fn(), error: vi.fn() };
    client.stream("", handlers)();
    client.stream("", handlers, { taskSummary: true })();
    client.stream("", handlers, { catalogPatch: true })();
    client.stream("", handlers, { catalogPatch: 2 })();
    client.stream("session", handlers, { taskSummary: true })();
    expect(transport.mock.calls.slice(1).map(([path]) => path)).toEqual([
      "/api/web/v1/stream?protocolVersion=2",
      "/api/web/v1/stream?protocolVersion=2&taskSummary=1",
      "/api/web/v1/stream?protocolVersion=2&catalogPatch=1",
      "/api/web/v1/stream?protocolVersion=2&catalogPatch=2",
      "/api/web/v1/stream?protocolVersion=2&sessionId=session",
    ]);
  });

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
      .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.accessEnded }, 401));
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
      .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.accessEnded }, 401));
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

  it("probes the existing LAN stream on wake before replacing a silent connection", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const browser = new EventTarget();
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", new EventTarget());
    let inbound!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => (inbound = controller) });
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(info))
      .mockResolvedValueOnce(json(access))
      .mockResolvedValueOnce(
        new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(json({ error: REMOTE_ERROR_CODES.accessEnded }, 401));
    const client = new WebClient(transport, "http://10.0.0.1:1422");
    await client.access();
    const error = vi.fn();
    const close = client.stream("session", { event: vi.fn(), open: vi.fn(), error });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      inbound.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      await vi.advanceTimersByTimeAsync(30_000);
      browser.dispatchEvent(new Event("focus"));
      expect(error).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(15_000);
      browser.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(error).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledTimes(4);
    } finally {
      close();
    }
  });

  it("backs off short same-origin SSE attempts and resumes from the applied cursor", async () => {
    vi.useFakeTimers();
    const streams: Array<{ url: string; controller: ReadableStreamDefaultController<Uint8Array> }> =
      [];
    const encoder = new TextEncoder();
    const transport = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/access")) return json(access);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push({ url, controller });
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const client = new WebClient(transport);
    await client.access();
    const event = vi.fn().mockReturnValueOnce("applied").mockReturnValue(false);
    const error = vi.fn();
    const close = client.stream("s", { event, open: vi.fn(), error });
    const frame = (type: string, cursor?: string) =>
      encoder.encode(`${cursor ? `id: ${cursor}\n` : ""}event: ${type}\ndata: {}\n\n`);
    try {
      streams[0].controller.enqueue(frame("session-event", "applied"));
      streams[0].controller.enqueue(frame("session-event", "rejected"));
      streams[0].controller.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(error).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2000);
      expect(streams[1].url).toContain("afterCursor=applied");
      streams[1].controller.enqueue(frame("session-ready"));
      streams[1].controller.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(event).toHaveBeenLastCalledWith("session-ready", "{}", undefined);
      await vi.advanceTimersByTimeAsync(3999);
      expect(streams).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams[2].url).toContain("afterCursor=applied");
    } finally {
      close();
    }
    await vi.advanceTimersByTimeAsync(8000);
    expect(streams).toHaveLength(3);
  });
});

describe("attachment upload transport", () => {
  it("preserves a specific attachment refusal and the legacy response fields", async () => {
    const transport = vi.fn().mockResolvedValueOnce(json(access));
    const client = new WebClient(transport);
    await client.access();
    transport.mockResolvedValueOnce(
      json(
        {
          error: REMOTE_ERROR_CODES.requestFailed,
          reason: REMOTE_ERROR_CODES.attachmentChanged,
          controlOutcome: "not-dispatched",
        },
        500,
      ),
    );
    await expect(client.request("send", { attachmentIds: ["staged-file"] })).rejects.toMatchObject({
      status: 500,
      code: REMOTE_ERROR_CODES.requestFailed,
      reason: REMOTE_ERROR_CODES.attachmentChanged,
      controlOutcome: "not-dispatched",
    });
  });

  it.each([
    [
      400,
      { error: REMOTE_ERROR_CODES.invalidAttachmentName },
      REMOTE_ERROR_CODES.invalidAttachmentName,
      undefined,
    ],
    [
      413,
      { code: REMOTE_ERROR_CODES.attachmentTooLarge },
      REMOTE_ERROR_CODES.attachmentTooLarge,
      undefined,
    ],
    [
      507,
      { error: REMOTE_ERROR_CODES.attachmentStorageFull },
      REMOTE_ERROR_CODES.attachmentStorageFull,
      undefined,
    ],
    [
      500,
      {
        error: REMOTE_ERROR_CODES.requestFailed,
        reason: REMOTE_ERROR_CODES.attachmentIndexInvalid,
      },
      REMOTE_ERROR_CODES.requestFailed,
      REMOTE_ERROR_CODES.attachmentIndexInvalid,
    ],
    [
      201,
      { id: "staged-file" },
      REMOTE_ERROR_CODES.uploadFailed,
      REMOTE_ERROR_CODES.invalidAttachmentResponse,
    ],
    [502, { error: "/private/staged-file" }, REMOTE_ERROR_CODES.uploadFailed, undefined],
  ])("keeps registered upload reasons for HTTP %i", async (status, body, code, reason) => {
    class FailedUpload {
      status = status;
      responseText = JSON.stringify(body);
      upload = {};
      onload?: () => void;
      open() {}
      setRequestHeader() {}
      send() {
        this.onload?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", FailedUpload);
    const client = new WebClient(vi.fn().mockResolvedValue(json(access)));
    await client.access();
    await expect(
      client.uploadAttachment("session", new File(["file"], "file.txt"), vi.fn()),
    ).rejects.toMatchObject({ status, code, reason });
  });

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
    client.managedAction("release", {
      agent: "claude-code",
      sessionId: "session",
      bootId: "boot",
      requestId: "request",
      expectedRevision: 2,
    }),
  ).rejects.toThrow("disconnected");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith(
    "/api/web/v1/managed/release",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-AgentKib-Protocol": "2" }),
    }),
  );
});
