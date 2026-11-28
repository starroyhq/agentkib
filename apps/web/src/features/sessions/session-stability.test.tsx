import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Access,
  Approval,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  SessionSettings,
  UserQuestionRequest,
} from "@agentkib/web-client";
import { pendingScope, readPending, rememberPending, catalogCopy } from "@agentkib/session-ui";
import { WebApplication, makeRouter } from "@/router";
import { TestSseConnection } from "@/sse-test-fixture";

let foregroundTime = 0;
function refocusWindow() {
  foregroundTime = Math.max(foregroundTime + 300, performance.now());
  const clock = vi.spyOn(performance, "now").mockReturnValue(foregroundTime);
  try {
    fireEvent.focus(window);
  } finally {
    clock.mockRestore();
  }
}

class SessionConnection extends TestSseConnection {
  static instances: SessionConnection[] = [];
  private sequence = 0;

  constructor(
    readonly path: string,
    signal: AbortSignal | null | undefined,
    initial: () => Live,
  ) {
    super(signal);
    SessionConnection.instances.push(this);
    if (new URL(path, "http://localhost").searchParams.has("sessionId"))
      queueMicrotask(() => {
        if (!this.closed) this.emit("snapshot", initial());
      });
  }

  sessionEvent(type: "snapshot" | "invalidate", value: unknown) {
    const sessionId =
      type === "snapshot"
        ? (value as Live).sessionId
        : (new URL(this.path, "http://localhost").searchParams.get("sessionId") ?? "");
    return {
      protocolVersion: 2,
      subscriptionId: "test-stream",
      sessionId,
      runtimeBootId: "runtime",
      epoch: "test",
      seq: ++this.sequence,
      cursor: `cursor-${this.sequence}`,
      type,
      payload: type === "snapshot" ? { live: value } : value,
    };
  }

  override emit(type: string, value: unknown) {
    if (type === "snapshot" || type === "invalidate") {
      super.emit("session-event", this.sessionEvent(type, value));
    } else super.emit(type, value);
  }
}

const approvedAccess: Access = {
  status: "approved",
  protocolVersion: 2,
  csrfToken: "csrf",
  bootId: "boot",
  experimentalEnabled: true,
  device: { id: "browser", name: "Browser", send: true, approve: true },
};
const catalog: ConversationCatalog = {
  indexEnabled: true,
  workspaces: [{ id: "workspace", name: "Project", path: "/projects/project" }],
  sessions: [
    {
      id: "session",
      workspace_id: "workspace",
      agent: "claude-code",
      title: "Test session",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
  ],
};
const history: ConversationEventPage = {
  events: [
    {
      id: "secret",
      kind: "agent-message",
      content: "Secret history",
      attachment_count: 0,
      truncated: false,
    },
  ],
  warnings: [],
};
const idleLive: Live = {
  sessionId: "session",
  status: "idle",
  revision: 1,
  sendEnabled: true,
  approvals: [],
  questions: [],
};
const question: UserQuestionRequest = {
  requestId: "question",
  turnId: "turn",
  supported: true,
  questions: [
    {
      id: "choice",
      question: "选一个",
      options: [{ label: "甲" }, { label: "乙" }],
      multiSelect: false,
      allowCustom: false,
    },
  ],
};
const approval: Approval = {
  requestId: "approval",
  turnId: "turn",
  method: "claude/can_use_tool",
  toolName: "Bash",
  input: { command: "echo before" },
  availableDecisions: ["allow", "deny"],
  supported: true,
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Content-Type": "application/json" } });
}

function createServer(initialLive: Live = idleLive) {
  const state = {
    access: approvedAccess,
    catalog,
    history,
    live: initialLive,
    receipt: undefined as unknown,
    capabilities: undefined as unknown,
    settings: undefined as SessionSettings | undefined,
    contextOptions: undefined as unknown,
    goals: undefined as unknown,
    mutation: undefined as ((path: string, init?: RequestInit) => Promise<Response>) | undefined,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (state.mutation && init?.method === "POST") return state.mutation(path, init);
    if (path.includes("/codex/session-settings?") || path.includes("/managed/settings?"))
      return state.settings ? json(state.settings) : json({ error: { code: "unavailable" } }, 503);
    if (path.includes("/codex/context-options?")) return json(state.contextOptions ?? {});
    if (path.includes("/codex/goals?")) return json(state.goals ?? {});
    if (path.includes("/codex/capabilities?") || path.includes("/managed/capabilities?"))
      return json(state.capabilities ?? {});
    if (path.includes("/requests/"))
      return json(state.receipt ?? { found: false, requestId: path.split("/").at(-1) });
    if (path.endsWith("/access")) return json(state.access);
    if (path.endsWith("/catalog")) return json(state.catalog);
    if (path.includes("/stream?"))
      return new SessionConnection(path, init?.signal, () => state.live).response;
    if (path.includes("/events?")) return json(state.history);
    if (path.includes("/live?")) return json(state.live);
    return json({});
  });
  vi.stubGlobal("fetch", fetcher);
  return { state, fetcher };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
});

async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Test session/ }));
  await screen.findByText("Secret history");
  await waitFor(() => expect(SessionConnection.instances.length).toBeGreaterThan(0));
}

function invalidateReceipts() {
  const stream = SessionConnection.instances
    .filter(
      (source) =>
        !source.closed &&
        new URL(source.path, "http://localhost").searchParams.get("sessionId") === "session",
    )
    .at(-1);
  expect(stream).toBeDefined();
  act(() => stream!.emit("invalidate", { domains: ["receipts"] }));
}

afterEach(() => {
  cleanup();
  SessionConnection.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ordinary session routes", () => {
  it.each(["auxiliary", "execution"] as const)(
    "returns an old %s deep link to the directory without requesting its content",
    async (origin) => {
      const server = createServer();
      server.state.catalog = {
        ...catalog,
        sessions: catalog.sessions.map((session) => ({ ...session, origin })),
      };
      const router = makeRouter({}, true);
      router.history.replace("/sessions/session");
      render(<RouterProvider router={router} />);

      expect(await screen.findByText(catalogCopy["zh-CN"].excludedSession)).toBeVisible();
      await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
      expect(screen.queryByText("Secret history")).toBeNull();
      expect(screen.queryByRole("button", { name: /Test session/ })).toBeNull();
      expect(
        server.fetcher.mock.calls.some(([path]) => /\/(events|live)\?/.test(String(path))),
      ).toBe(false);
      expect(
        SessionConnection.instances.some((source) =>
          new URL(source.path, "http://localhost").searchParams.has("sessionId"),
        ),
      ).toBe(false);
    },
  );
});

describe("access invalidation", () => {
  it("enters the catalog directly after a code grants full access without desktop confirmation", async () => {
    const server = createServer();
    server.state.access = {
      status: "unpaired",
      pairingMode: "code",
      csrfToken: "csrf",
      bootId: "boot",
      experimentalEnabled: false,
    };
    let finishPair!: () => void;
    server.state.mutation = async (path) => {
      if (path.endsWith("/pair")) {
        await new Promise<void>((resolve) => {
          finishPair = resolve;
        });
        server.state.access = {
          ...approvedAccess,
          pairingMode: "code",
          device: { ...approvedAccess.device!, accessMode: "full", manage: true, files: true },
        };
        return json({ status: "approved", protocolVersion: 2, device: server.state.access.device });
      }
      return json({});
    };
    render(<WebApplication />);
    fireEvent.change(await screen.findByLabelText("授权码"), { target: { value: "12345678" } });
    expect(screen.queryByText("等待桌面 AgentKib 确认")).not.toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "连接并开始使用" });
    fireEvent.click(connect);
    fireEvent.click(connect);
    expect(connect).toBeDisabled();
    await waitFor(() => expect(finishPair).toBeTypeOf("function"));
    await act(async () => finishPair());
    expect(await screen.findByRole("button", { name: /Test session/ })).toBeVisible();
    expect(screen.queryByText("等待桌面 AgentKib 确认")).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(
        ([path, init]) => String(path).endsWith("/pair") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("clears private state immediately and ignores late events after access is revoked", async () => {
    const server = createServer();
    await openSession();
    const stream = SessionConnection.instances.at(-1)!;
    const original = server.fetcher.getMockImplementation()!;
    let releaseHistory!: (response: Response) => void;
    server.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/events?"))
        return new Promise<Response>((resolve) => {
          releaseHistory = resolve;
        });
      return original(input, init);
    });
    refocusWindow();
    await waitFor(() => expect(releaseHistory).toBeTypeOf("function"));

    await act(async () =>
      stream.emitFrames([
        { event: "access-ended", data: {} },
        {
          event: "session-event",
          data: stream.sessionEvent("snapshot", {
            ...idleLive,
            revision: 99,
            streamText: "late secret",
          }),
        },
      ]),
    );

    await screen.findByText("远程访问已结束");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    await act(async () =>
      releaseHistory(
        json({
          events: [{ ...history.events[0], id: "late", content: "Late network history" }],
          warnings: [],
        }),
      ),
    );
    expect(screen.queryByText("Late network history")).not.toBeInTheDocument();
    expect(screen.queryByText("late secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });

  it("clears selected history and catalog when indexing is disabled", async () => {
    const server = createServer();
    await openSession();
    server.state.catalog = { indexEnabled: false, sessions: [] };

    refocusWindow();

    await screen.findByText("历史索引未开启");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });
  it("rechecks access after a same-origin SSE connection drops", async () => {
    const server = createServer();
    await openSession();
    server.state.access = { ...approvedAccess, status: "ended" };
    await act(async () => SessionConnection.instances[0].disconnect());
    await screen.findByText("远程访问已结束");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });

  it("keeps checking access after a directory stream stops with an unreadable 401", async () => {
    const server = createServer();
    const original = server.fetcher.getMockImplementation()!;
    let finishHandshake!: (response: Response) => void;
    const handshake = new Promise<Response>((resolve) => (finishHandshake = resolve));
    let finishAccess!: (response: Response) => void;
    const access = new Promise<Response>((resolve) => (finishAccess = resolve));
    const stopped = vi.fn(() => access);
    let verifyAccess = false;
    server.fetcher.mockImplementation((input, init) => {
      const path = String(input);
      if (
        path.includes("/stream?") &&
        !new URL(path, "http://localhost").searchParams.has("sessionId")
      )
        return handshake;
      if (verifyAccess && path.endsWith("/access")) return stopped();
      return original(input, init);
    });
    await openSession();
    verifyAccess = true;
    await act(async () => finishHandshake(new Response("<html>Sign in</html>", { status: 401 })));
    expect(stopped).toHaveBeenCalledOnce();
    expect(screen.getByText("Secret history")).toBeVisible();

    await act(async () => finishAccess(json({ ...approvedAccess, status: "ended" })));
    expect(await screen.findByText("远程访问已结束")).toBeVisible();
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });

  it.each(["approved", "ended"] as const)(
    "rechecks %s access after an isolated detail stream reconnect receives an unreadable 401",
    async (status) => {
      const server = createServer();
      const original = server.fetcher.getMockImplementation()!;
      let rejectedReconnect = false;
      let finishAccess!: (response: Response) => void;
      const access = new Promise<Response>((resolve) => (finishAccess = resolve));
      const probeAccess = vi.fn(() => access);
      await openSession();
      await waitFor(() => expect(SessionConnection.instances).toHaveLength(2));
      const [directory, detail] = SessionConnection.instances;
      expect(directory.path).not.toContain("sessionId=");
      expect(detail.path).toContain("sessionId=session");
      await act(async () => directory.emit("session-ready", { cursor: "directory-ready" }));
      fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "unsent draft" } });

      server.fetcher.mockImplementation((input, init) => {
        const path = String(input);
        if (!rejectedReconnect && path.includes("/stream?") && path.includes("sessionId=session")) {
          rejectedReconnect = true;
          return Promise.resolve(new Response("<html>Sign in</html>", { status: 401 }));
        }
        if (rejectedReconnect && path.endsWith("/access")) return probeAccess();
        return original(input, init);
      });

      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        await act(async () => detail.disconnect());
        await act(async () => vi.advanceTimersByTimeAsync(2000));
        expect(probeAccess).toHaveBeenCalledOnce();
        expect(directory.closed).toBe(false);
        expect(screen.getByText("Secret history")).toBeVisible();
        expect(screen.getByLabelText("发送消息")).toHaveValue("unsent draft");

        await act(async () => finishAccess(json({ ...approvedAccess, status })));
        await act(async () => vi.advanceTimersByTimeAsync(4000));
        if (status === "ended") {
          expect(screen.getByText("远程访问已结束")).toBeVisible();
          expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
          expect(SessionConnection.instances).toEqual([directory, detail]);
          return;
        }
        const resumed = SessionConnection.instances.at(-1)!;
        expect(SessionConnection.instances).toEqual([directory, detail, resumed]);
        const query = new URL(resumed.path, "http://localhost").searchParams;
        expect(query.get("sessionId")).toBe("session");
        expect(query.get("afterCursor")).toBe("cursor-1");
        expect(directory.closed).toBe(false);
        await act(async () =>
          resumed.emit("snapshot", {
            ...idleLive,
            revision: 2,
            turnId: "turn",
            status: "awaiting-approval",
            sendEnabled: false,
            approvals: [approval],
          }),
        );
        expect(screen.getByText("echo before")).toBeVisible();
        expect(screen.getByText("Secret history")).toBeVisible();
        expect(screen.getByLabelText("发送消息")).toHaveValue("unsent draft");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

it("refreshes HTTP access on focus without replacing the current session stream", async () => {
  const server = createServer();
  await openSession();
  const source = SessionConnection.instances.at(-1)!;
  expect(source.path).toContain("sessionId=session");
  const streamCount = SessionConnection.instances.length;
  server.fetcher.mockClear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(window, new Event("focus"));
  await waitFor(() =>
    expect(server.fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/access$/),
      expect.objectContaining({ method: "GET" }),
    ),
  );
  expect(source.closed).toBe(false);
  expect(SessionConnection.instances).toHaveLength(streamCount);
  expect(screen.getByText("Secret history")).toBeVisible();
});

describe("control outcome recovery", () => {
  it("reconciles the original unknown send even when its reason normally allows backoff", async () => {
    const server = createServer();
    server.state.mutation = async (path) =>
      path.endsWith("/send")
        ? json(
            { error: "outcome_unknown", reason: "session-compacting", controlOutcome: "unknown" },
            409,
          )
        : json({});
    await openSession();
    const scope = pendingScope("", "browser");
    const input = screen.getByLabelText("发送消息");
    const send = screen.getByRole("button", { name: "发送" });
    fireEvent.change(input, { target: { value: "first draft" } });
    fireEvent.click(send);
    await waitFor(() => expect(readPending(scope)).toHaveLength(1));
    const [pending] = readPending(scope);
    await waitFor(() =>
      expect(server.fetcher).toHaveBeenCalledWith(
        expect.stringContaining(`/requests/${pending.requestId}`),
        expect.objectContaining({ method: "GET" }),
      ),
    );
    fireEvent.change(input, { target: { value: "next draft" } });
    expect(send).toBeDisabled();
    expect(screen.getByText("Secret history")).toBeVisible();

    server.state.receipt = {
      ...pending,
      found: true,
      operation: "send",
      status: "accepted",
      completionObserved: true,
    };
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(send).toBeEnabled());
    expect(readPending(scope)).toEqual([]);
    expect(input).toHaveValue("next draft");
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );
  });
});

describe("live interaction validity", () => {
  it("collapses without answering, reopens, and drops a cancelled question", async () => {
    const server = createServer({
      ...idleLive,
      status: "awaiting-input",
      turnId: "turn",
      sendEnabled: false,
      questions: [question],
    });
    await openSession();
    const card = await screen.findByRole("region", { name: "有问题待回答" });
    expect(within(card).getByRole("heading", { name: "选一个" })).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("region", { name: "有问题待回答" })).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/answer")),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "展开 · 有问题待回答 · 选一个" }));
    expect(screen.getByRole("button", { name: "甲" })).toBeVisible();
    const cancelled = { ...idleLive, revision: 2 };
    server.state.live = cancelled;
    await act(async () => SessionConnection.instances.at(-1)!.emit("snapshot", cancelled));

    expect(screen.queryByRole("region", { name: "有问题待回答" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "甲" })).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/answer")),
    ).toHaveLength(0);
  });

  it("shows the current projection when a waiting approval changes", async () => {
    const server = createServer({
      ...idleLive,
      status: "awaiting-approval",
      turnId: "turn",
      sendEnabled: false,
      approvals: [approval],
    });
    await openSession();
    const card = await screen.findByRole("region", { name: "等待审批" });
    expect(within(card).getByText("echo before")).toBeVisible();
    fireEvent.click(within(card).getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("region", { name: "等待审批" })).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "展开 · 等待审批 · echo before" }));

    const changed = {
      ...server.state.live,
      revision: 2,
      approvals: [{ ...approval, input: { command: "echo after" } }],
    };
    server.state.live = changed;
    await act(async () => SessionConnection.instances.at(-1)!.emit("snapshot", changed));

    // The card only ever offers decisions on what it currently shows.
    const updated = screen.getByRole("region", { name: "等待审批" });
    expect(within(updated).getByText("echo after")).toBeVisible();
    expect(within(updated).queryByText("echo before")).not.toBeInTheDocument();
    expect(
      server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
    ).toHaveLength(0);
  });

  it("uses the native ACP option name when its opaque id matches a legacy decision", async () => {
    const nativeApproval: Approval = {
      requestId: "native-approval",
      turnId: "native-turn",
      method: "session/request_permission",
      toolCall: { toolCallId: "tool", title: "Native action" },
      options: [{ optionId: "cancel", name: "Allow this native action", kind: "allow_once" }],
      availableDecisions: ["cancel"],
      supported: true,
    };
    const server = createServer({
      ...idleLive,
      status: "waiting-approval",
      turnId: nativeApproval.turnId,
      sendEnabled: false,
      approvals: [nativeApproval],
    });
    server.state.mutation = async () => json({ accepted: true });
    await openSession();

    await screen.findByRole("region", { name: "等待审批" });
    const option = screen.getByRole("button", { name: "Allow this native action" });
    expect(screen.queryByRole("button", { name: "取消运行" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝并停止本轮" })).not.toBeInTheDocument();
    fireEvent.click(option);

    await waitFor(() => {
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/approve")),
      ).toHaveLength(1);
    });
    const approveCall = server.fetcher.mock.calls.find(([url]) => String(url).endsWith("/approve"));
    expect(JSON.parse(String(approveCall?.[1]?.body))).toMatchObject({
      sessionId: "session",
      turnId: "native-turn",
      approvalId: "native-approval",
      decision: "cancel",
    });
  });

  it("closes an open interaction and clears its data when permission is revoked", async () => {
    createServer({
      ...idleLive,
      status: "awaiting-input",
      turnId: "turn",
      sendEnabled: false,
      questions: [question],
    });
    await openSession();
    await screen.findByRole("region", { name: "有问题待回答" });

    act(() => SessionConnection.instances.at(-1)!.emit("access-ended", {}));

    await screen.findByText("远程访问已结束");
    expect(screen.queryByRole("region", { name: "有问题待回答" })).not.toBeInTheDocument();
    expect(screen.queryByText("选一个")).not.toBeInTheDocument();
  });
});

describe("host identity isolation", () => {
  it("drops the previous host's history and draft before bootstrapping a new host", async () => {
    const hostA = "http://192.168.1.10:1422";
    const hostB = "http://192.168.1.11:1422";
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const host = url.startsWith(hostB) ? hostB : hostA;
      if (url.endsWith("/info"))
        return json({
          protocolVersion: 2,
          transport: "lan",
          capabilities: { read: true, send: true, approve: true },
        });
      if (url.endsWith("/access"))
        return json({
          ...approvedAccess,
          bearerToken: host === hostA ? "token-a" : "token-b",
          bootId: host === hostA ? "boot-a" : "boot-b",
        });
      if (url.endsWith("/catalog"))
        return json({
          ...catalog,
          sessions: catalog.sessions.map((session) => ({
            ...session,
            title: host === hostA ? "Host A session" : "Host B session",
          })),
        });
      if (url.includes("/events?"))
        return json({
          events: [
            {
              ...history.events[0],
              id: host === hostA ? "secret-a" : "secret-b",
              content: host === hostA ? "Host A secret" : "Host B history",
            },
          ],
          warnings: [],
        });
      if (url.includes("/live?")) return json(idleLive);
      if (url.includes("/stream?")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);

    render(<WebApplication hosted origin={hostA} />);
    fireEvent.click(await screen.findByRole("button", { name: /Host A session/ }));
    await screen.findByText("Host A secret");
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "private draft" } });

    fireEvent.click(screen.getByRole("button", { name: "更换连接 / 清空内容" }));
    await screen.findByRole("button", { name: "连接电脑上的 AgentKib" });
    expect(screen.queryByText("Host A secret")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("private draft")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("电脑的局域网地址"), { target: { value: hostB } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "连接电脑上的 AgentKib" }));
    fireEvent.click(await screen.findByRole("button", { name: /Host B session/ }));
    await screen.findByText("Host B history");

    expect(screen.queryByText("Host A secret")).not.toBeInTheDocument();
    expect(screen.getByLabelText("发送消息")).toHaveValue("");
    const hostBAccess = fetcher.mock.calls.find(
      ([url]) => String(url) === `${hostB}/api/web/v1/access`,
    );
    expect(hostBAccess).toBeDefined();
    expect(streams.length).toBeGreaterThan(0);
  });
});

describe("durable Codex control recovery", () => {
  it("clears only a matching legacy non-dispatch proof and keeps the draft without resending", async () => {
    const scope = pendingScope("", "browser");
    const requestId = crypto.randomUUID();
    rememberPending(scope, { requestId, sessionId: "session", kind: "send" });
    const server = createServer({ ...idleLive, executionMode: "codex-managed" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.receipt = {
      found: true,
      requestId: crypto.randomUUID(),
      status: "not-dispatched",
      recovery: "legacy-prepared",
      completionObserved: false,
    };
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "keep this draft" } });
    expect(readPending(scope)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    server.state.receipt = {
      found: true,
      requestId,
      status: "unknown",
      recovery: "legacy-prepared",
      completionObserved: false,
    };
    refocusWindow();
    await waitFor(() =>
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).includes("/requests/")).length,
      ).toBeGreaterThan(1),
    );
    expect(readPending(scope)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    server.state.receipt = {
      found: true,
      requestId,
      status: "not-dispatched",
      recovery: "legacy-prepared",
      completionObserved: false,
    };
    refocusWindow();
    await waitFor(() => expect(readPending(scope)).toEqual([]));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(screen.getByLabelText("发送消息")).toHaveValue("keep this draft");
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      0,
    );
  });
  it("persists unknown sends across reload and only clears them using the matching receipt", async () => {
    const server = createServer({ ...idleLive, executionMode: "codex-managed" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.mutation = async () =>
      json({ code: "runtime_timeout", controlOutcome: "unknown" }, 503);
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), {
      target: { value: "private prompt never persisted" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    const scope = pendingScope("", "browser");
    await waitFor(() => expect(readPending(scope)).toHaveLength(1));
    const pending = readPending(scope)[0];
    expect(pending.kind).toBe("send");
    expect(sessionStorage.getItem(scope)).not.toContain("private prompt");
    await waitFor(() =>
      expect(server.fetcher.mock.calls.some(([url]) => String(url).includes("/requests/"))).toBe(
        true,
      ),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    cleanup();
    SessionConnection.instances = [];
    server.state.receipt = {
      found: true,
      requestId: crypto.randomUUID(),
      sessionId: "session",
      operation: "send",
      status: "accepted",
      completionObserved: true,
    };
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "new draft" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(readPending(scope)).toEqual([pending]);
    server.state.receipt = {
      found: true,
      requestId: pending.requestId,
      sessionId: "session",
      operation: "send",
      status: "accepted",
      completionObserved: false,
      ack: { accepted: true, completed: false },
    };
    invalidateReceipts();
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(readPending(scope)).toEqual([]);
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );
  });
  it("does not load another device's pending identities", async () => {
    rememberPending(pendingScope("", "other-device"), {
      requestId: crypto.randomUUID(),
      sessionId: "session",
      kind: "send",
    });
    const server = createServer({ ...idleLive, executionMode: "codex-managed" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "draft" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(server.fetcher.mock.calls.some(([url]) => String(url).includes("/requests/"))).toBe(
      false,
    );
  });
  it("keeps native approvals visible after an accepted approval receipt", async () => {
    const requestId = crypto.randomUUID();
    rememberPending(pendingScope("", "browser"), {
      requestId,
      sessionId: "session",
      kind: "approve",
    });
    const server = createServer({
      ...idleLive,
      executionMode: "codex-managed",
      status: "awaiting-approval",
      turnId: "turn",
      sendEnabled: false,
      approvals: [approval],
    });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.receipt = {
      found: true,
      requestId,
      sessionId: "session",
      operation: "approve",
      status: "accepted",
      turnId: "turn",
      completionObserved: false,
      ack: { accepted: true, completed: false },
    };
    await openSession();
    await waitFor(() => expect(screen.getByRole("region", { name: "等待审批" })).toBeVisible());
    expect(readPending(pendingScope("", "browser"))).toEqual([]);
    expect(
      server.fetcher.mock.calls.some(
        ([url, init]) => String(url).endsWith("/approve") && init?.method === "POST",
      ),
    ).toBe(false);
  });
});

describe("advanced Codex receipt recovery", () => {
  it("automatically reconciles an uncertain rename after remount without replaying it", async () => {
    const server = createServer({ ...idleLive, executionMode: "codex-follower" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, organize: true },
    };
    server.state.capabilities = {
      sessionId: "session",
      executionMode: "codex-follower",
      status: "idle",
      features: { rename: { available: true } },
    };
    server.state.mutation = async () =>
      json({ code: "runtime_timeout", controlOutcome: "unknown" }, 503);
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    const rename = screen.getByRole("button", { name: "重命名" });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "private name" } });
    fireEvent.click(rename);
    fireEvent.click(rename);
    const scope = pendingScope("", "browser");
    await waitFor(() => expect(readPending(scope)).toHaveLength(1));
    const pending = readPending(scope)[0]!;
    expect(pending.kind).toBe("rename");
    expect(sessionStorage.getItem(scope)).not.toContain("private name");
    await waitFor(() => expect(rename).toBeDisabled());
    cleanup();
    await openSession();
    const writes = () =>
      server.fetcher.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith("/managed/action") &&
          JSON.parse(String(init?.body)).operation === "rename",
      );
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    expect(screen.getByRole("button", { name: "重命名" })).toBeDisabled();
    server.state.receipt = {
      ...pending,
      found: true,
      status: "accepted",
      operation: "rename",
      completionObserved: false,
    };
    invalidateReceipts();
    await waitFor(() => expect(readPending(scope)).toHaveLength(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "重命名" })).toBeEnabled());
    expect(writes()).toHaveLength(1);
  });
});

it("keeps capability reads stable during streaming and refreshes the catalog on focus", async () => {
  const live = {
    ...idleLive,
    executionMode: "codex-managed" as const,
    status: "running",
    sendEnabled: false,
  };
  const server = createServer(live);
  server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
  server.state.capabilities = {
    sessionId: "session",
    executionMode: "codex-managed",
    status: "running",
    features: { inspect: { available: true } },
  };
  await openSession();
  const count = () =>
    server.fetcher.mock.calls.filter(([url]) => String(url).includes("/managed/capabilities?"))
      .length;
  await waitFor(() => expect(count()).toBeGreaterThan(0));
  await act(async () => {
    await Promise.resolve();
  });
  const before = count();
  const source = SessionConnection.instances.at(-1)!;
  for (let index = 2; index <= 20; index++) {
    await act(async () =>
      source.emit("snapshot", { ...live, revision: index, streamText: `token ${index}` }),
    );
  }
  expect(count()).toBe(before);
  const catalogReads = () =>
    server.fetcher.mock.calls.filter(([url]) =>
      new URL(String(url), "http://localhost").pathname.endsWith("/catalog"),
    ).length;
  const readsBeforeFocus = catalogReads();
  expect(screen.queryByRole("button", { name: "刷新" })).not.toBeInTheDocument();
  refocusWindow();
  await waitFor(() => expect(catalogReads()).toBeGreaterThan(readsBeforeFocus));
});

describe("Codex composer with the real session controller", () => {
  function codexServer() {
    const server = createServer({ ...idleLive, executionMode: "codex-managed" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, accessMode: "full", advancedControl: true },
    };
    server.state.capabilities = {
      sessionId: "session",
      executionMode: "codex-managed",
      status: "idle",
      features: { context: { available: true }, "goal-set": { available: true } },
    };
    server.state.goals = {
      sessionId: "session",
      revision: 1,
      available: true,
      actions: { set: { available: true } },
    };
    return server;
  }

  it.each(["file", "skill"])(
    "keeps a %s-only draft editable, then sends text and the reference once",
    async (kind) => {
      const server = codexServer();
      server.state.contextOptions = {
        sessionId: "session",
        revision: 1,
        available: true,
        resources: [{ id: "opaque-resource", name: "reference", kind, available: true }],
      };
      server.state.mutation = async () => json({ accepted: true });
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: "添加上下文" }));
      const add = within(await screen.findByRole("dialog", { name: "添加上下文" }));
      fireEvent.click(add.getByRole("button", { name: "文件和文件夹" }));
      fireEvent.click(await add.findByRole("checkbox", { name: /reference/ }));
      fireEvent.click(add.getByRole("button", { name: "完成" }));
      const input = screen.getByLabelText("发送消息");
      const send = screen.getByRole("button", { name: "发送" });
      expect(send).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(input).toBeEnabled();
      expect(server.fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
        0,
      );
      fireEvent.change(input, { target: { value: "Use this reference" } });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
      await waitFor(() => expect(input).toHaveValue(""));
      expect(input).toBeEnabled();
      const writes = server.fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/send") && init?.method === "POST",
      );
      expect(writes).toHaveLength(1);
      expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({
        text: "Use this reference",
        resourceIds: ["opaque-resource"],
      });
      expect(readPending(pendingScope("", "browser"))).toEqual([]);
    },
  );

  it.each([false, true])(
    "persists a Goal request, reconciles its receipt, and never replays it (disconnect=%s)",
    async (disconnect) => {
      const server = codexServer();
      const scope = pendingScope("", "browser");
      let observedPending = false;
      server.state.mutation = async () => {
        observedPending = readPending(scope)[0]?.kind === "goal-set";
        return disconnect
          ? json({ code: "runtime_timeout", controlOutcome: "unknown" }, 503)
          : json({ accepted: true });
      };
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: "添加上下文" }));
      fireEvent.click(screen.getByRole("button", { name: "持续目标" }));
      fireEvent.change(await screen.findByLabelText("目标内容"), {
        target: { value: "safe test goal" },
      });
      const start = screen.getByRole("button", { name: "开始目标" });
      await waitFor(() => expect(start).toBeEnabled());
      fireEvent.click(start);
      const writes = () =>
        server.fetcher.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/managed/action") &&
            JSON.parse(String(init?.body)).operation === "goal-set",
        );
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(observedPending).toBe(true);
      if (disconnect) {
        await waitFor(() =>
          expect(
            server.fetcher.mock.calls.some(([url]) => String(url).includes("/requests/")),
          ).toBe(true),
        );
        fireEvent.click(start);
        const pending = readPending(scope)[0];
        cleanup();
        await openSession();
        expect(readPending(scope)).toEqual([pending]);
        server.state.receipt = {
          ...pending,
          found: true,
          status: "accepted",
          operation: "goal-set",
          completionObserved: false,
        };
        refocusWindow();
      }
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(writes()).toHaveLength(1);
    },
  );
});

describe("Claude managed workflow", () => {
  it("continues Claude with a regular send and keeps identity checks inside the host", async () => {
    const server = createServer({
      ...idleLive,
      sendEnabled: true,
      executionMode: "claude-managed",
    });
    server.state.capabilities = {
      sessionId: "session",
      executionMode: "claude-managed",
      status: "idle",
      features: { send: { available: true }, adopt: { available: true } },
    };
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, manage: true },
    };
    server.state.mutation = async () => json({ accepted: true, sessionId: "session" });
    await openSession();
    const message = screen.getByRole("textbox", { name: "发送消息" });
    expect(message).toHaveAttribute("placeholder", "继续这条会话…");
    fireEvent.change(message, { target: { value: "Continue without a manual handoff" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() =>
      expect(
        server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send")),
      ).toHaveLength(1),
    );
    const call = server.fetcher.mock.calls.find(([url]) => String(url).endsWith("/send"))!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      sessionId: "session",
      expectedRevision: 1,
      text: "Continue without a manual handoff",
    });
    expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty("handoffConfirmed");
    expect(server.fetcher.mock.calls.some(([url]) => String(url).endsWith("/managed/adopt"))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

it.each([
  { agent: "codex", executionMode: "codex-managed", field: "mode" },
  { agent: "claude-code", executionMode: "claude-managed", field: "permissionMode" },
] as const)(
  "keeps $agent history and catalog while changing Plan mode",
  async ({ agent, executionMode, field }) => {
    const server = createServer({ ...idleLive, executionMode, runtimeBootId: "runtime" });
    const available = { available: true };
    const unavailable = { available: false };
    const modes: NonNullable<SessionSettings["options"]["collaborationModes"]> = [
      { id: "default", name: "Execute" },
      { id: "plan", name: "Plan" },
    ];
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0]!, agent }] };
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, accessMode: "full", advancedControl: true },
    };
    server.state.capabilities = {
      sessionId: "session",
      executionMode,
      status: "idle",
      features: { settings: available, "settings-state": available, send: available },
    };
    server.state.settings = {
      sessionId: "session",
      revision: 1,
      available: true,
      applicationStatus: "confirmed",
      current: { [field]: "default" },
      selected: { [field]: "default" },
      defaults: {},
      writable: {
        mode: field === "mode" ? available : unavailable,
        permissionMode: field === "permissionMode" ? available : unavailable,
        model: unavailable,
        effort: unavailable,
        policy: unavailable,
        serviceTier: unavailable,
        restoreDefaults: unavailable,
      },
      options: {
        models: [],
        policies: [],
        serviceTiers: [],
        ...(field === "mode" ? { collaborationModes: modes } : { permissionModes: modes }),
      },
    };
    const writes: string[] = [];
    server.state.mutation = async (_path, init) => {
      const request = JSON.parse(String(init?.body));
      const mode = request[field];
      writes.push(mode);
      const settings = server.state.settings!;
      server.state.settings = {
        ...settings,
        revision: settings.revision + 1,
        current: { [field]: mode },
        selected: { [field]: mode },
      };
      server.state.live = { ...server.state.live, revision: settings.revision + 1 };
      return json({
        accepted: true,
        requestId: request.requestId,
        sessionId: "session",
        runtimeBootId: "runtime",
      });
    };

    await openSession();
    const history = screen.getByText("Secret history");
    const broadReads = () =>
      server.fetcher.mock.calls.filter(([url]) =>
        /\/(access|catalog)$|\/events\?/.test(String(url)),
      ).length;
    const openPlan = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "添加上下文" }));
      const plan = await screen.findByRole("button", { name: "计划模式" });
      await waitFor(() => expect(plan).toBeEnabled());
      return plan;
    };
    const enter = await openPlan();
    const before = broadReads();
    expect(enter).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(enter);
    await waitFor(() => expect(writes).toEqual(["plan"]));
    const exit = await openPlan();
    await waitFor(() => expect(exit).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(exit);
    await waitFor(() => expect(writes).toEqual(["plan", "default"]));
    expect(await openPlan()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Secret history")).toBe(history);
    expect(broadReads()).toBe(before);
  },
);
