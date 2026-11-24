import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerAddCopy, composerGoalCopy, planModeCopy } from "@agentkib/session-ui";
import {
  sessionProviderCapabilities,
  WebClient,
  type Access,
  type Live,
  type SessionQueue,
  type SessionSettings,
} from "@agentkib/web-client";
import { WebApplication } from "@/router";
import { sessionCopyForSurface } from "@/features/conversation/session-copy";
import { composerLayoutCopy } from "@agentkib/session-ui";
import { webLayoutCopy } from "@agentkib/session-ui";
import { useSessionController } from "@/features/conversation/web-session-controller";

// Exercise the real provider, controller and WebClient against the public API,
// including revision fencing and the follow-up reads after an accepted mutation.
class ClaudeEventSource {
  static live: () => Live;
  static instances = new Set<ClaudeEventSource>();
  seq = 0;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
    ClaudeEventSource.instances.delete(this);
  }
  constructor(path: string) {
    if (!new URL(path, "http://localhost").searchParams.has("sessionId")) return;
    ClaudeEventSource.instances.add(this);
    queueMicrotask(() => {
      if (this.closed) return;
      this.emit(ClaudeEventSource.live());
    });
  }
  emit(live: Live) {
    this.seq++;
    this.listeners["session-event"]?.(
      new MessageEvent("session-event", {
        data: JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "claude-stream",
          sessionId: "session",
          runtimeBootId: "runtime",
          epoch: "claude",
          seq: this.seq,
          cursor: `claude-${this.seq}`,
          type: "snapshot",
          payload: { live },
        }),
      }),
    );
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }
}

const available = { available: true };
const unavailable = { available: false };
const copy = sessionCopyForSurface("zh-CN", "web");
function createHost({
  staleSettingsAfterMutation = false,
  unmanaged = false,
  follower = false,
} = {}) {
  const settings: SessionSettings = {
    sessionId: "session",
    revision: 1,
    available: true,
    applicationStatus: "confirmed",
    current: { modelId: "host-model", effort: "medium", permissionMode: "default" },
    defaults: { modelId: "host-model", effort: "medium", permissionMode: "default" },
    writable: {
      model: available,
      effort: available,
      permissionMode: available,
      restoreDefaults: available,
      mode: unavailable,
      policy: unavailable,
      serviceTier: unavailable,
    },
    options: {
      models: [
        { id: "host-model", name: "Host Claude", efforts: ["medium", "high"], serviceTierIds: [] },
        { id: "second-model", name: "Second Claude", efforts: ["low", "high"], serviceTierIds: [] },
      ],
      policies: [],
      serviceTiers: [],
      permissionModes: [
        { id: "default", name: "默认权限" },
        { id: "plan", name: "计划权限" },
        { id: "acceptEdits", name: "允许编辑" },
      ],
    },
  };
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "csrf",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "browser",
      name: "Phone",
      accessMode: "full",
      send: true,
      approve: true,
      manage: true,
      advancedControl: true,
      organize: true,
      settings: true,
      files: true,
      attachments: true,
    },
  };
  const state = {
    settings,
    live: {
      sessionId: "session",
      status: "idle",
      revision: 1,
      executionMode: "claude-managed",
      executionLocation: null,
      sendEnabled: true,
      approvals: [],
      questions: [],
    } as Live,
    features: Object.fromEntries(
      [
        "settings",
        "settings-state",
        "goal",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "queue-list",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "queue-pause",
        "queue-resume",
        "context",
        "resources",
        "rename",
        "fork",
        "send",
        "inspect",
      ].map((key) => [key, available]),
    ),
    queue: {
      sessionId: "session",
      paused: true,
      requiresResume: true,
      data: [
        { id: "queued-1", text: "Queued follow-up", status: "pending" },
        { id: "queued-2", text: "Later work", status: "pending" },
      ],
    } as SessionQueue,
    goal: {
      sessionId: "session",
      revision: 1,
      available: true,
      goal: { objective: "Finish the task", status: "paused", tokensUsed: 10, tokenBudget: 1000 },
      actions: { set: available, pause: unavailable, resume: available, clear: available },
    },
    mutations: [] as Record<string, unknown>[],
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/web/v1/", "");
    if (path === "managed/settings-prepare") return Response.json(state.settings);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.mutations.push({ path, ...body });
      if (path === "managed/adopt") {
        state.live = {
          ...state.live,
          executionMode: "claude-managed",
          reason: undefined,
          sendEnabled: true,
        };
        state.features.send = available;
        state.features.adopt = unavailable;
      }
      if (body.operation === "settings" && !staleSettingsAfterMutation) {
        const selected = { ...state.settings.selected };
        if (body.effort === null) delete selected.effort;
        state.settings = {
          ...state.settings,
          revision: state.settings.revision + 1,
          applicationStatus: "pending",
          selected: {
            ...selected,
            ...(typeof body.model === "string" ? { modelId: body.model } : {}),
            ...(typeof body.effort === "string" ? { effort: body.effort } : {}),
            ...(body.permissionMode
              ? { permissionMode: body.permissionMode as "acceptEdits" }
              : {}),
          },
        };
        state.live.revision = state.settings.revision;
      }
      if (body.operation === "queue-resume") {
        state.queue.paused = false;
        state.queue.requiresResume = false;
      }
      if (body.operation === "goal-resume") state.goal.goal.status = "active";
      if (body.operation === "queue-update") state.queue.data[0]!.text = String(body.text);
      return Response.json({ accepted: true, sessionId: "session", requestId: body.requestId });
    }
    if (path === "access") return Response.json(access);
    if (path === "catalog")
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
        sessions: [
          {
            id: "session",
            workspace_id: "workspace",
            agent: "claude-code",
            title: "Claude parity session",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
    if (path === "events")
      return Response.json({
        events: [
          {
            id: "reply",
            kind: "agent-message",
            content: "Claude history",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    if (path === "live") return Response.json(state.live);
    if (path === "managed/capabilities")
      return Response.json({ sessionId: "session", features: state.features });
    if (path === "managed/settings") return Response.json(state.settings);
    if (path === "managed/inspect")
      return Response.json({ sessionId: "session", handoffFingerprint: "verified-history" });
    if (path === "managed/queue") return Response.json(state.queue);
    if (path === "managed/goals") return Response.json(state.goal);
    if (path === "managed/options")
      return Response.json({
        available: true,
        workspaces: [{ id: "workspace", name: "Project" }],
        models: settings.options.models,
      });
    if (path === "managed/resources")
      return Response.json({
        sessionId: "session",
        revision: 1,
        resources: [{ id: "scoped-file", kind: "file", name: "notes.md", available: true }],
      });
    if (path.startsWith("requests/"))
      return Response.json({ found: false, requestId: path.split("/").at(-1) });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", ClaudeEventSource);
  ClaudeEventSource.live = () => state.live;
  if (unmanaged) {
    state.live = { ...state.live, executionMode: "claude-managed", sendEnabled: true };
    state.features.adopt = available;
  }
  if (follower) {
    state.live = {
      ...state.live,
      executionMode: "claude-follower",
      executionLocation: "terminal",
      // These cases cover the experimental plugin that accepts messages sent from here.
      terminalSend: true,
      connectionGeneration: "lease-a",
    };
    for (const key of Object.keys(state.features)) state.features[key] = unavailable;
    state.features.send = available;
    state.features.inspect = available;
  }
  return { state, fetcher, access };
}
async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Claude parity session/ }));
  await screen.findByText("Claude history");
  await waitFor(() => expect(screen.getByRole("button", { name: "会话操作" })).toBeEnabled());
}
async function openEffort(model = "Host Claude") {
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`^选择推理强度: ${model}`) }),
  );
  return within(await screen.findByRole("dialog"));
}
async function chooseModel(model: string) {
  const picker = await openEffort();
  fireEvent.click(picker.getByRole("button", { name: "选择模型: Host Claude" }));
  const choice = await screen.findByRole("button", { name: model });
  await waitFor(() => expect(choice).toBeEnabled());
  fireEvent.click(choice);
}
async function chooseHighEffort(picker?: ReturnType<typeof within>) {
  const slider = await (picker ?? (await openEffort())).findByRole("slider", {
    name: "选择推理强度",
  });
  await waitFor(() => expect(slider).not.toHaveAttribute("disabled"));
  fireEvent.keyDown(slider, { key: "End" });
}
async function choosePermission(permission: string) {
  fireEvent.click(await screen.findByRole("button", { name: /^工具权限(?::|$)/ }));
  const item = await screen.findByRole("menuitem", { name: new RegExp(`^${permission}`) });
  await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
  fireEvent.click(item);
}
async function openAddContext() {
  fireEvent.click(await screen.findByRole("button", { name: copy.addContext }));
  return within(await screen.findByRole("dialog", { name: copy.addContext }));
}
function reportNativeSettings(state: ReturnType<typeof createHost>["state"]) {
  act(() => {
    for (const source of ClaudeEventSource.instances)
      source.emit({ ...state.live, settings: state.settings });
  });
}
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("idle Claude settings and retirement", () => {
  it("reuses the loaded native catalog when the user opens the model picker", async () => {
    const { fetcher } = createHost();
    await openSession();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/managed/settings-prepare")),
    ).toHaveLength(0);
    await openEffort();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith("/managed/settings-prepare")),
    ).toHaveLength(0);
  });

  it("does not replay another client's old retirement notice but shows the next retirement in this visit", async () => {
    const { state } = createHost();
    state.live = {
      ...state.live,
      continuationNotice: "background-ended",
      continuationNoticeId: "old-client-retirement",
    };
    const { result } = renderHook(() => useSessionController({}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => result.current.choose("session"));
    expect(result.current.live?.continuationNotice).toBeNull();
    state.live = { ...state.live, continuationNoticeId: "new-retirement" };
    act(() => {
      for (const source of ClaudeEventSource.instances) source.emit(state.live);
    });
    await waitFor(() => expect(result.current.live?.continuationNotice).toBe("background-ended"));
    expect(result.current.live?.continuationNoticeId).toBe("new-retirement");
  });
});

describe("Claude history continuation", () => {
  it("continues directly and rechecks an unknown outcome without losing the draft", async () => {
    const { state } = createHost({ unmanaged: true });
    await openSession();
    const draft = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
    state.live = {
      ...state.live,
      revision: 2,
      sendEnabled: false,
      reason: "control-outcome-unconfirmed",
    };
    act(() => {
      for (const source of ClaudeEventSource.instances) source.emit(state.live);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
    expect(draft).toHaveValue("Keep this draft");
    state.live = { ...state.live, revision: 3, reason: undefined, sendEnabled: true };
    act(() => {
      for (const source of ClaudeEventSource.instances) source.emit(state.live);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.mutations).toHaveLength(1));
    expect(state.mutations[0]).toMatchObject({
      path: "send",
      sessionId: "session",
      text: "Keep this draft",
      expectedRevision: 3,
    });
    expect(state.mutations[0]).not.toHaveProperty("handoffConfirmed");
    expect(state.mutations.some((request) => request.path === "managed/adopt")).toBe(false);
  });

  it.each(["manage", "capability", "unknown"])(
    "does not offer handoff with %s unavailable",
    async (reason) => {
      const { state, access } = createHost({ unmanaged: true });
      if (reason === "manage") access.device!.manage = false;
      if (reason === "capability") state.features.adopt = unavailable;
      if (reason === "unknown") state.live.reason = "control-outcome-unconfirmed";
      await openSession();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(state.mutations).toEqual([]);
    },
  );
});

describe("original Claude terminal over Web", () => {
  it("keeps an original-terminal connection outside managed handoff even with stale adoption capabilities", async () => {
    const { state } = createHost({ follower: true });
    state.live = { ...state.live, sendEnabled: false, reason: "handoff-required" };
    state.features.adopt = available;
    await openSession();
    const draft = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(draft, { target: { value: "Keep original terminal draft" } });
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(draft).toHaveValue("Keep original terminal draft");
    expect(state.mutations).toEqual([]);
  });

  it("keeps an editable draft while a connected terminal cannot take messages", async () => {
    const { state } = createHost({ follower: true });
    state.live = {
      ...state.live,
      sendEnabled: false,
      terminalSend: false,
      reason: "claude-follower-send-unverified",
    };
    await openSession();
    expect(await screen.findByText("在终端中继续这条会话，这里会同步显示")).toBeVisible();
    expect(screen.getByText("在终端中运行 · 已连接")).toBeVisible();
    // The limitation is explained once, by the bar, not again in a banner.
    expect(
      screen.queryByText("会话发送尚未开放，请在终端发送；AgentKib 可同步观察并取消当前轮次。"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it("observes a terminal turn without offering an unverified stop", async () => {
    const { state } = createHost({ follower: true });
    state.live = {
      ...state.live,
      status: "running",
      turnId: "turn-terminal",
      sendEnabled: false,
      stopEnabled: true,
      terminalSend: false,
    };
    state.features.stop = unavailable;
    await openSession();
    expect(await screen.findByText("在终端中继续这条会话，这里会同步显示")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "停止当前轮次" })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it("invalidates the old form when the terminal binding changes and keeps unsent text", async () => {
    const { state } = createHost({ follower: true });
    const { result } = renderHook(() => useSessionController({}));
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    await act(async () => result.current.choose("session"));
    await waitFor(() => expect(result.current.live?.connectionGeneration).toBe("lease-a"));
    act(() => {
      result.current.setMessage("Keep binding draft");
      result.current.setModal("metadata");
      result.current.setHistorySearchOpen(true);
    });
    expect(result.current.modal).toBe("metadata");
    state.live = { ...state.live, revision: 2, connectionGeneration: "lease-b" };
    act(() => {
      for (const source of ClaudeEventSource.instances) source.emit(state.live);
    });
    await waitFor(() => expect(result.current.modal).toBeUndefined());
    expect(result.current.historySearchOpen).toBe(false);
    expect(result.current.message).toBe("Keep binding draft");
    expect(state.mutations).toEqual([]);
  });
  it("sends directly to a connected session once without exposing local pairing or handoff", async () => {
    const { state } = createHost({ follower: true });
    await openSession();
    expect(await screen.findByText("在终端中运行 · 已连接")).toBeVisible();
    expect(screen.queryByText("审批和提问在终端中处理")).not.toBeInTheDocument();
    expect(document.querySelector("aside.info")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成连接码" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "Continue original terminal" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(state.mutations).toHaveLength(1));
    expect(state.mutations[0]).toMatchObject({
      path: "send",
      sessionId: "session",
      text: "Continue original terminal",
    });
    expect(state.mutations.some((request) => request.path === "managed/adopt")).toBe(false);
  });

  it("keeps the draft but disables sending after the original terminal disconnects", async () => {
    const { state } = createHost({ follower: true });
    await openSession();
    const draft = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(draft, { target: { value: "Unsent terminal draft" } });
    state.live = {
      ...state.live,
      revision: 2,
      status: "unsupported",
      sendEnabled: false,
      reason: "claude-bridge-disconnected",
      connectionGeneration: "revoked-a",
      streamText: "",
    };
    act(() => {
      for (const source of ClaudeEventSource.instances) source.emit(state.live);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
    expect(draft).toHaveValue("Unsent terminal draft");
    expect(screen.getByText("终端连接已断开", { selector: "aside strong" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });

  it.each([
    ["claude-terminal-approval", "awaiting-approval", "正在等待工具审批，请在终端处理。"],
    ["claude-terminal-question", "waiting-input", "正在等待问题回答，请在终端处理。"],
    [
      "claude-bridge-event-gap",
      "unsupported",
      "事件同步出现缺口，正在重新读取快照和原生历史；恢复前暂停控制。",
    ],
    [
      "claude-follower-turn-unconfirmed",
      "running",
      "终端正在执行，当前轮次身份尚未核实；暂不能取消，请在终端处理。",
    ],
    [
      "claude-terminal-permission-unconfirmed",
      "running",
      "终端曾请求工具审批，当前授权或执行状态尚未核实，请查看终端。",
    ],
  ])("handles %s in the original terminal", async (reason, status, text) => {
    const { state } = createHost({ follower: true });
    state.live = { ...state.live, reason, status, sendEnabled: false };
    await openSession();
    expect(await screen.findByText(text)).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.mutations).toEqual([]);
  });
});

describe("Claude Remote parity", () => {
  beforeEach(() => {
    // Base UI exposes the slider thumb after measuring it. jsdom has no layout.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.hasAttribute("data-index") ? 28 : 240;
        return new DOMRect(0, 0, width, 28);
      },
    );
  });

  it("does not write another effort against stale settings while the native revision advances", async () => {
    const host = createHost({ staleSettingsAfterMutation: true });
    host.state.settings.writable.restoreDefaults = unavailable;
    host.state.settings.selected = { effort: "high" };
    host.state.settings.current.effort = "high";
    await openSession();
    const picker = await openEffort();
    const clear = picker.getByRole("button", { name: "使用默认强度" });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({
      operation: "settings",
      expectedRevision: 1,
      effort: null,
    });
    await waitFor(() =>
      expect(
        host.fetcher.mock.calls.filter(([url]) => String(url).includes("/managed/settings?"))
          .length,
      ).toBeGreaterThan(1),
    );
    host.state.live.revision = 2;
    reportNativeSettings(host.state);
    const slider = await picker.findByRole("slider");
    await waitFor(() => expect(slider).toBeDisabled());
    fireEvent.keyDown(slider, { key: "End" });
    expect(host.state.mutations).toHaveLength(1);
    host.state.settings = {
      ...host.state.settings,
      revision: 2,
      selected: {},
      current: { ...host.state.settings.current, effort: "medium" },
    };
    reportNativeSettings(host.state);
    await waitFor(() => expect(picker.getByRole("slider")).toHaveAttribute("aria-valuetext", "中"));
    await chooseHighEffort(picker);
    await waitFor(() => expect(host.state.mutations).toHaveLength(2));
    expect(host.state.mutations[1]).toMatchObject({ effort: "high", expectedRevision: 2 });
  });

  it("does not send Claude effort clearing semantics through the Codex API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new WebClient(fetcher);
    const body = {
      sessionId: "session",
      requestId: "request",
      bootId: "boot",
      expectedRevision: 1,
      effort: null,
    };
    await expect(client.codexAction("settings", body)).rejects.toMatchObject({
      status: 400,
      code: "invalid_effort",
      controlOutcome: "not-dispatched",
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.sessionAction("settings", body, "codex")).rejects.toMatchObject({
      status: 400,
      code: "invalid_effort",
      controlOutcome: "not-dispatched",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "low"])(
    "replaces an incompatible effort with the new model default %s",
    async (defaultEffort) => {
      const host = createHost();
      host.state.settings.selected = { effort: "high", permissionMode: "plan" };
      host.state.settings.current.effort = "high";
      host.state.settings.current.permissionMode = "plan";
      host.state.settings.options.models[1]!.efforts = ["low"];
      host.state.settings.options.models[1]!.defaultEffort = defaultEffort;
      await openSession();
      await chooseModel("Second Claude");
      await waitFor(() => expect(host.state.mutations).toHaveLength(1));
      expect(host.state.mutations[0]).toMatchObject({
        operation: "settings",
        model: "second-model",
        effort: defaultEffort ?? null,
      });
      expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    },
  );

  it("clears only the effort override and waits for native confirmation of its default", async () => {
    const host = createHost();
    host.state.settings.provider = sessionProviderCapabilities("claude-code");
    host.state.settings.writable.restoreDefaults = unavailable;
    host.state.settings.selected = { effort: "high", permissionMode: "plan" };
    host.state.settings.current.effort = "high";
    host.state.settings.current.permissionMode = "plan";
    await openSession();
    const picker = await openEffort();
    const clear = picker.getByRole("button", { name: "使用默认强度" });
    await waitFor(() => expect(clear).toBeEnabled());
    fireEvent.click(clear);
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: null });
    expect(host.state.mutations[0]).not.toHaveProperty("model");
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    expect(host.state.mutations[0]).not.toHaveProperty("serviceTierId");
    host.state.settings = {
      ...host.state.settings,
      applicationStatus: "confirmed",
      current: { ...host.state.settings.current, effort: "medium" },
    };
    reportNativeSettings(host.state);
    await waitFor(() => expect(picker.getByRole("slider")).toHaveAttribute("aria-valuetext", "中"));
    expect(host.state.settings.selected?.effort).toBeUndefined();
    expect(host.state.settings.selected?.permissionMode).toBe("plan");
  });

  it("uses a resolved inherited model to show its effort options without selecting a model override", async () => {
    const host = createHost();
    host.state.settings.selected = {};
    host.state.settings.current.modelId = "claude-sonnet-fixture";
    Object.assign(host.state.settings.options.models[0]!, {
      id: "sonnet",
      resolvedModel: "claude-sonnet-fixture",
    });
    await openSession();
    await chooseHighEffort();
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: "high" });
    expect(host.state.mutations[0]).not.toHaveProperty("model");
  });

  it("confirms the selected alias when multiple aliases resolve to the same native model", async () => {
    const host = createHost();
    Object.assign(host.state.settings.options.models[1]!, {
      id: "sonnet",
      resolvedModel: "claude-sonnet-fixture",
      efforts: ["medium", "high"],
    });
    host.state.settings.options.models.unshift({
      id: "default",
      name: "Default Claude",
      resolvedModel: "claude-sonnet-fixture",
      efforts: ["medium", "high"],
      serviceTierIds: [],
    });
    await openSession();
    await chooseModel("Second Claude");
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    host.state.settings = {
      ...host.state.settings,
      applicationStatus: "confirmed",
      current: { ...host.state.settings.current, modelId: "claude-sonnet-fixture" },
    };
    reportNativeSettings(host.state);
    const picker = within(await screen.findByRole("dialog"));
    fireEvent.click(await picker.findByRole("button", { name: "选择模型: Second Claude" }));
    const choice = await screen.findByRole("button", { name: "Second Claude" });
    await waitFor(() => expect(choice).toBeEnabled());
    expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Default Claude" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(host.state.mutations[0]).toMatchObject({ model: "sonnet" });
    expect(host.state.mutations[0]).not.toHaveProperty("effort");
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
  });

  it("surfaces an actual unknown native result without retrying the model change", async () => {
    const host = createHost();
    host.state.settings.options.models[1]!.efforts = ["medium", "high"];
    await openSession();
    await chooseModel("Second Claude");
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    host.state.settings = { ...host.state.settings, applicationStatus: "unknown" };
    reportNativeSettings(host.state);
    const picker = within(await screen.findByRole("dialog"));
    const message = composerLayoutCopy["zh-CN"].settingsUnknown;
    expect(await screen.findByText(message)).toBeVisible();
    expect(picker.queryByText(message)).not.toBeInTheDocument();
    expect(host.state.mutations).toHaveLength(1);
  });

  it.each(["default", "plan", "acceptEdits", undefined] as const)(
    "preserves inherited %s permission when only the model is changed",
    async (permissionMode) => {
      const host = createHost();
      host.state.settings.current.permissionMode = permissionMode;
      host.state.settings.selected = {};
      host.state.settings.defaults = {};
      host.state.settings.options.models[1]!.efforts = ["medium", "high"];
      await openSession();
      const permission =
        permissionMode === "default"
          ? "手动审批"
          : permissionMode === "acceptEdits"
            ? "自动接受编辑"
            : undefined;
      expect(
        await screen.findByRole("button", {
          name:
            permissionMode === "plan"
              ? "退出计划模式"
              : permission
                ? `工具权限: ${permission}`
                : "工具权限",
        }),
      ).toBeVisible();
      if (permissionMode === undefined) {
        fireEvent.click(screen.getByRole("button", { name: "工具权限" }));
        const menu = within(await screen.findByRole("menu"));
        const defaultChoice = menu.getByRole("menuitem", { name: /^手动审批/ });
        expect(menu.getAllByRole("menuitem")).toHaveLength(2);
        expect(defaultChoice).not.toHaveAttribute("aria-current");
        expect(menu.getByRole("menuitem", { name: /^自动接受编辑/ })).not.toHaveAttribute(
          "aria-current",
        );
        fireEvent.keyDown(defaultChoice, { key: "Escape" });
        expect(host.state.mutations).toHaveLength(0);
      }
      await chooseModel("Second Claude");
      await waitFor(() => expect(host.state.mutations).toHaveLength(1));
      expect(host.state.mutations[0]).toMatchObject({
        path: "managed/action",
        operation: "settings",
        model: "second-model",
      });
      expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
      expect(host.state.mutations[0]).not.toHaveProperty("effort");
      expect(host.state.settings.current.permissionMode).toBe(permissionMode);
    },
  );

  it("does not resend a previously selected permission mode when editing effort", async () => {
    const host = createHost();
    host.state.settings.selected = { permissionMode: "plan" };
    host.state.settings.current.permissionMode = "plan";
    await openSession();
    await chooseHighEffort();
    await waitFor(() => expect(host.state.mutations).toHaveLength(1));
    expect(host.state.mutations[0]).toMatchObject({ operation: "settings", effort: "high" });
    expect(host.state.mutations[0]).not.toHaveProperty("permissionMode");
    expect(host.state.mutations[0]).not.toHaveProperty("model");
  });

  it("clears submitted fields before the next settings edit", async () => {
    const host = createHost();
    await openSession();
    const add = await openAddContext();
    const plan = await add.findByRole("button", { name: planModeCopy("zh-CN").title });
    await waitFor(() => expect(plan).toBeEnabled());
    fireEvent.click(plan);
    await waitFor(() => expect(host.state.settings.selected?.permissionMode).toBe("plan"));
    await chooseHighEffort();
    await waitFor(() => expect(host.state.mutations).toHaveLength(2));
    expect(host.state.mutations[0]).toMatchObject({
      operation: "settings",
      permissionMode: "plan",
      expectedRevision: 1,
    });
    expect(host.state.mutations[1]).toMatchObject({
      operation: "settings",
      effort: "high",
      expectedRevision: 2,
    });
    expect(host.state.mutations[1]).not.toHaveProperty("permissionMode");
    expect(host.state.mutations[1]).not.toHaveProperty("model");
  });

  it("applies only the changed models and permissions through the generic action", async () => {
    const host = createHost();
    await openSession();
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${copy.executionPolicy}:`) }),
    ).not.toBeInTheDocument();
    await chooseModel("Second Claude");
    await screen.findByRole("button", { name: /^选择推理强度: Second Claude/ });
    const picker = within(await screen.findByRole("dialog"));
    expect(picker.queryByRole("button", { name: "Fast 模式" })).not.toBeInTheDocument();
    await chooseHighEffort(picker);
    await waitFor(() => expect(host.state.mutations).toHaveLength(2));
    fireEvent.keyDown(picker.getByRole("slider"), { key: "Escape" });
    await choosePermission("自动接受编辑");
    await waitFor(() => expect(host.state.mutations).toHaveLength(3));
    const [model, effort, permission] = host.state.mutations;
    expect(model).toMatchObject({
      path: "managed/action",
      operation: "settings",
      agent: "claude-code",
      model: "second-model",
      expectedRevision: 1,
    });
    expect(effort).toMatchObject({ effort: "high", expectedRevision: 2 });
    expect(permission).toMatchObject({ permissionMode: "acceptEdits", expectedRevision: 3 });
    expect(model).not.toHaveProperty("permissionMode");
    expect(effort).not.toHaveProperty("model");
    expect(permission).not.toHaveProperty("model");
    expect(permission).not.toHaveProperty("effort");
    expect(host.state.settings.current.modelId).toBe("host-model");
    expect(host.fetcher.mock.calls.some(([url]) => String(url).includes("/codex/"))).toBe(false);
  });

  it("keeps recovered queues paused until an explicit resume and edits the queued item by ID", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    await screen.findByText("Queued follow-up");
    expect(host.state.mutations).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "恢复队列" }));
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        operation: "queue-resume",
        path: "managed/action",
        agent: "claude-code",
      }),
    );
    await screen.findByRole("button", { name: "暂停队列" });
    const edits = screen.getAllByRole("button", { name: copy.queueUpdate });
    await waitFor(() => expect(edits[0]).toBeEnabled());
    fireEvent.click(edits[0]!);
    fireEvent.change(screen.getByLabelText(copy.text), { target: { value: "Revised follow-up" } });
    fireEvent.click(screen.getAllByRole("button", { name: copy.queueUpdate })[0]!);
    await waitFor(() =>
      expect(host.state.mutations[1]).toMatchObject({
        operation: "queue-update",
        queuedSubmissionId: "queued-1",
        text: "Revised follow-up",
      }),
    );
    await screen.findByText("Revised follow-up");
  });

  it.each(["claimed", "dispatched", "unknown"] as const)(
    "keeps %s entries immutable and reorders only pending entries",
    async (status) => {
      const host = createHost();
      host.state.live = {
        ...host.state.live,
        status: "running",
        sendEnabled: false,
        stopEnabled: true,
        turnId: "native-turn",
      };
      host.state.queue = {
        sessionId: "session",
        paused: false,
        requiresResume: false,
        data: [
          { id: "active-work", text: "Active work", status },
          { id: "next-work", text: "Next work", status: "pending" },
          { id: "last-work", text: "Last work", status: "pending" },
        ],
      };
      await openSession();
      fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
      await screen.findByText("Active work");
      const edits = screen.getAllByRole("button", { name: copy.queueUpdate });
      const deletes = screen.getAllByRole("button", { name: copy.queueDelete });
      expect(edits[0]).toBeDisabled();
      expect(deletes[0]).toBeDisabled();
      await waitFor(() => expect(edits[1]).toBeEnabled());
      expect(deletes[1]).toBeEnabled();
      fireEvent.click(edits[0]!);
      fireEvent.click(deletes[0]!);
      expect(host.state.mutations).toHaveLength(0);
      expect(screen.queryByLabelText(copy.text)).not.toBeInTheDocument();
      const [active, first, reorder] = screen.getAllByRole("button", { name: copy.queueUp });
      expect(active).toBeDisabled();
      expect(first).toBeDisabled();
      expect(first).toHaveAttribute("title");
      await waitFor(() => expect(reorder).toBeEnabled());
      fireEvent.click(reorder!);
      await waitFor(() =>
        expect(host.state.mutations[0]).toMatchObject({
          path: "managed/action",
          operation: "queue-reorder",
          queuedSubmissionIds: ["last-work", "next-work"],
        }),
      );
    },
  );

  it.each(["paused", "budget-exhausted"])(
    "resumes a %s persistent goal only on user action",
    async (status) => {
      const host = createHost();
      host.state.goal.goal.status = status;
      await openSession();
      fireEvent.click(await screen.findByRole("button", { name: copy.goals }));
      expect(host.state.mutations).toHaveLength(0);
      fireEvent.click(
        screen.getByRole("button", {
          name: status === "paused" ? copy.goalResume : composerLayoutCopy["zh-CN"].tryResume,
        }),
      );
      await waitFor(() =>
        expect(host.state.mutations[0]).toMatchObject({
          operation: "goal-resume",
          path: "managed/action",
          agent: "claude-code",
          expectedRevision: 1,
        }),
      );
    },
  );

  it("applies an imported Claude goal draft after the first confirmed message and a newer idle revision", async () => {
    const host = createHost();
    Object.assign(host.state.features, {
      "goal-draft": available,
      goal: unavailable,
      "goal-set": unavailable,
      "goal-pause": unavailable,
      "goal-resume": unavailable,
      "goal-clear": unavailable,
    });
    const fetchHost = host.fetcher.getMockImplementation()!;
    host.fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/managed/goals?"))
        return Response.json({
          ...host.state.goal,
          revision: host.state.live.revision,
          goal: undefined,
        });
      return fetchHost(input, init);
    });
    await openSession();
    const goalCopy = composerGoalCopy("zh-CN");
    const add = await openAddContext();
    fireEvent.click(await add.findByRole("button", { name: goalCopy.title }));
    const editor = within(await screen.findByRole("dialog", { name: goalCopy.title }));
    fireEvent.change(editor.getByRole("textbox", { name: goalCopy.objective }), {
      target: { value: "Review the old session" },
    });
    const save = editor.getByRole("button", { name: goalCopy.saveDraft });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    expect(await screen.findByRole("button", { name: goalCopy.clearDraft })).toBeVisible();
    expect(host.fetcher.mock.calls.some(([url]) => String(url).includes("/managed/goals?"))).toBe(
      false,
    );
    expect(host.state.mutations).toHaveLength(0);

    const input = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(input, { target: { value: "Continue reviewing" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(host.state.mutations).toHaveLength(1);
    expect(host.state.mutations[0]).toMatchObject({ path: "send", text: "Continue reviewing" });

    host.state.features["goal-draft"] = unavailable;
    host.state.features.goal = available;
    host.state.features["goal-set"] = available;
    host.state.live = { ...host.state.live, status: "running", revision: 2, sendEnabled: false };
    reportNativeSettings(host.state);
    expect(host.state.mutations).toHaveLength(1);
    host.state.live = { ...host.state.live, status: "idle", revision: 3, sendEnabled: true };
    reportNativeSettings(host.state);
    await waitFor(() => expect(host.state.mutations).toHaveLength(2));
    expect(host.state.mutations[1]).toMatchObject({
      path: "managed/action",
      operation: "goal-set",
      agent: "claude-code",
      expectedRevision: 3,
      objective: "Review the old session",
      intent: "start",
    });
  });

  it("sends selected scoped resources through the regular Claude send contract", async () => {
    const host = createHost();
    await openSession();
    const add = await openAddContext();
    fireEvent.click(
      await add.findByRole("button", { name: composerAddCopy("zh-CN").filesAndFolders }),
    );
    const resource = await add.findByRole("checkbox", { name: /notes.md/ });
    fireEvent.click(resource);
    fireEvent.click(add.getByRole("button", { name: "完成" }));
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "Read this file" },
    });
    const send = screen.getByRole("button", { name: "发送" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        path: "send",
        text: "Read this file",
        resourceIds: ["scoped-file"],
      }),
    );
  });

  it("renames Claude through the shared operations panel without a Codex request", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.change(await screen.findByLabelText(copy.name), {
      target: { value: "Reviewed title" },
    });
    const rename = screen.getByRole("button", { name: copy.rename });
    await waitFor(() => expect(rename).toBeEnabled());
    fireEvent.click(rename);
    await waitFor(() =>
      expect(host.state.mutations[0]).toMatchObject({
        operation: "rename",
        name: "Reviewed title",
        agent: "claude-code",
        path: "managed/action",
      }),
    );
    expect(host.fetcher.mock.calls.some(([url]) => String(url).includes("/codex/"))).toBe(false);
  });

  it("does not read or mutate unsupported advanced Claude features", async () => {
    const host = createHost();
    host.state.features = {};
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    await screen.findByRole("button", { name: copy.rename });
    expect(screen.getByRole("button", { name: copy.rename })).toBeDisabled();
    expect(
      host.fetcher.mock.calls.some(([url]) =>
        /managed\/(settings|goals|resources|queue)\?/.test(String(url)),
      ),
    ).toBe(false);
    expect(host.state.mutations).toHaveLength(0);
  });

  it("inspects Claude through the existing read endpoint without creating a command", async () => {
    const host = createHost();
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(await screen.findByText(webLayoutCopy["zh-CN"].diagnostics));
    fireEvent.click(screen.getByRole("button", { name: copy.inspect }));
    await screen.findByText(/verified-history/);
    expect(host.state.mutations).toHaveLength(0);
    expect(
      host.fetcher.mock.calls.some(([url]) =>
        String(url).includes("/managed/inspect?sessionId=session&agent=claude-code"),
      ),
    ).toBe(true);
  });
});
