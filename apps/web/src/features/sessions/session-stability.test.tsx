import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Access,
  Approval,
  ConversationCatalog,
  ConversationEventPage,
  Live,
  UserQuestionRequest,
} from "@agentkib/web-client";
import {
  pendingScope,
  readPending,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";
import { WebApplication, makeRouter } from "@/router";
import { catalogCopy } from "@/features/conversation/features/catalog/catalog-copy";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static live: (() => Live) | undefined;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  sequence = 0;

  constructor(readonly path: string) {
    FakeEventSource.instances.push(this);
    if (new URL(path, "http://localhost").searchParams.has("sessionId"))
      queueMicrotask(() => {
        if (!this.close.mock.calls.length && FakeEventSource.live)
          this.emit("snapshot", FakeEventSource.live());
      });
  }

  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }

  emit(name: string, value: unknown) {
    if (name === "snapshot") {
      const live = value as Live;
      this.listeners["session-event"]?.(
        new MessageEvent("session-event", {
          data: JSON.stringify({
            protocolVersion: 2,
            subscriptionId: "test-stream",
            sessionId: live.sessionId,
            runtimeBootId: "runtime",
            epoch: "test",
            seq: ++this.sequence,
            cursor: `cursor-${this.sequence}`,
            type: "snapshot",
            payload: { live },
          }),
        }),
      );
    } else this.listeners[name]?.(new MessageEvent(name, { data: JSON.stringify(value) }));
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
    contextOptions: undefined as unknown,
    goals: undefined as unknown,
    mutation: undefined as ((path: string, init?: RequestInit) => Promise<Response>) | undefined,
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (state.mutation && init?.method === "POST") return state.mutation(path, init);
    if (path.includes("/codex/session-settings?"))
      return json({ error: { code: "unavailable" } }, 503);
    if (path.includes("/codex/context-options?")) return json(state.contextOptions ?? {});
    if (path.includes("/codex/goals?")) return json(state.goals ?? {});
    if (path.includes("/codex/capabilities?") || path.includes("/managed/capabilities?"))
      return json(state.capabilities ?? {});
    if (path.includes("/requests/"))
      return json(state.receipt ?? { found: false, requestId: path.split("/").at(-1) });
    if (path.endsWith("/access")) return json(state.access);
    if (path.endsWith("/catalog")) return json(state.catalog);
    if (path.includes("/events?")) return json(state.history);
    if (path.includes("/live?")) return json(state.live);
    return json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.live = () => state.live;
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
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
}

afterEach(() => {
  cleanup();
  FakeEventSource.instances = [];
  FakeEventSource.live = undefined;
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
        FakeEventSource.instances.some((source) =>
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
    const stream = FakeEventSource.instances.at(-1)!;
    const original = server.fetcher.getMockImplementation()!;
    let releaseHistory!: (response: Response) => void;
    server.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/events?"))
        return new Promise<Response>((resolve) => {
          releaseHistory = resolve;
        });
      return original(input, init);
    });
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() => expect(releaseHistory).toBeTypeOf("function"));

    act(() => stream.emit("access-ended", {}));

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
    act(() => stream.emit("snapshot", { ...idleLive, revision: 99, streamText: "late secret" }));
    expect(screen.queryByText("Late network history")).not.toBeInTheDocument();
    expect(screen.queryByText("late secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });

  it("clears selected history and catalog when indexing is disabled", async () => {
    const server = createServer();
    await openSession();
    server.state.catalog = { indexEnabled: false, sessions: [] };

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);

    await screen.findByText("历史索引未开启");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });
  it("rechecks access after an unobservable same-origin SSE authentication failure", async () => {
    const server = createServer();
    await openSession();
    server.state.access = { ...approvedAccess, status: "ended" };
    act(() => FakeEventSource.instances[0].onerror?.());
    await screen.findByText("远程访问已结束");
    expect(screen.queryByText("Secret history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test session/ })).not.toBeInTheDocument();
  });
});

describe("control outcome recovery", () => {
  it("never resends an unknown send outcome and requires a later manual refresh", async () => {
    const polling: (() => void)[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      if (delay === 4000) polling.push(callback);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const server = createServer();
    server.state.mutation = async (path) =>
      path.endsWith("/send")
        ? json({ code: "permission_denied", controlOutcome: "unknown" }, 403)
        : json({});
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "draft" } });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(
      "上次控制结果尚未确认，控制已暂停。请刷新核对已保存请求的处理状态，勿重复提交。",
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveValue("draft");

    await act(async () => polling.forEach((poll) => poll()));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      1,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() =>
      expect(server.fetcher.mock.calls.some(([url]) => String(url).includes("/requests/"))).toBe(
        true,
      ),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(readPending(pendingScope("", "browser"))).toHaveLength(1);
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
    act(() => FakeEventSource.instances.at(-1)!.emit("snapshot", cancelled));

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
    act(() => FakeEventSource.instances.at(-1)!.emit("snapshot", changed));

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

    act(() => FakeEventSource.instances.at(-1)!.emit("access-ended", {}));

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
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
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
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
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
    await screen.findByText("结果尚未确认。请刷新核对已保存请求的处理状态，不会自动重发。");
    const scope = pendingScope("", "browser");
    const pending = readPending(scope)[0];
    expect(pending.kind).toBe("send");
    expect(sessionStorage.getItem(scope)).not.toContain("private prompt");
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
    await waitFor(() =>
      expect(server.fetcher.mock.calls.some(([url]) => String(url).includes("/requests/"))).toBe(
        true,
      ),
    );
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    cleanup();
    FakeEventSource.instances = [];
    await openSession();
    fireEvent.change(screen.getByLabelText("发送消息"), { target: { value: "new draft" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    server.state.receipt = {
      found: true,
      requestId: pending.requestId,
      sessionId: "session",
      operation: "send",
      status: "accepted",
      completionObserved: false,
      ack: { accepted: true, completed: false },
    };
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
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
  it("never replays an uncertain rename after refresh or remount", async () => {
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
        ([url, init]) => String(url).endsWith("/codex/rename") && init?.method === "POST",
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
    fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]!);
    await waitFor(() => expect(readPending(scope)).toHaveLength(0));
    expect(writes()).toHaveLength(1);
  });
});

it("does not reload capabilities for streaming text revisions but does on manual refresh", async () => {
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
    server.fetcher.mock.calls.filter(([url]) => String(url).includes("/codex/capabilities?"))
      .length;
  await waitFor(() => expect(count()).toBeGreaterThan(0));
  await act(async () => {
    await Promise.resolve();
  });
  const before = count();
  const source = FakeEventSource.instances.at(-1)!;
  for (let index = 2; index <= 20; index++) {
    await act(async () =>
      source.emit("snapshot", { ...live, revision: index, streamText: `token ${index}` }),
    );
  }
  expect(count()).toBe(before);
  fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]!);
  await waitFor(() => expect(count()).toBeGreaterThan(before));
});

describe("Codex composer with the real session controller", () => {
  function codexServer() {
    const server = createServer({ ...idleLive, executionMode: "codex-managed" });
    server.state.catalog = { ...catalog, sessions: [{ ...catalog.sessions[0], agent: "codex" }] };
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, accessMode: "full" },
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
      fireEvent.click(await screen.findByRole("checkbox"));
      fireEvent.click(screen.getByRole("button", { name: "完成" }));
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
          ([url, init]) => String(url).endsWith("/codex/goal-set") && init?.method === "POST",
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
        fireEvent.click(screen.getAllByRole("button", { name: "刷新" })[0]);
      }
      await waitFor(() => expect(readPending(scope)).toEqual([]));
      expect(writes()).toHaveLength(1);
    },
  );
});

describe("Claude managed workflow", () => {
  it("creates a Claude task with the same provider and does not offer Codex-only settings", async () => {
    const server = createServer({ ...idleLive, executionMode: "claude-managed" });
    server.state.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, manage: true },
    };
    const original = server.fetcher.getMockImplementation()!;
    server.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/managed/options"))
        return json({ available: true, workspaces: catalog.workspaces });
      return original(input, init);
    });
    server.state.mutation = async () => json({ accepted: true, sessionId: "session" });
    render(<WebApplication />);
    fireEvent.click(await screen.findByRole("button", { name: "新建任务" }));
    fireEvent.change(screen.getByLabelText("执行工具"), { target: { value: "claude-code" } });
    await screen.findByText(/沿用运行 AgentKib 的电脑上的 Claude Code/);
    expect(screen.queryByLabelText("模型")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await screen.findByText("Secret history");
    const creates = server.fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith("/managed/create"),
    );
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0][1]?.body))).toMatchObject({
      agent: "claude-code",
      workspaceId: "workspace",
      bootId: "boot",
    });
    expect(JSON.parse(String(creates[0][1]?.body))).not.toHaveProperty("model");
    expect(server.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/send"))).toHaveLength(
      0,
    );
  });

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
