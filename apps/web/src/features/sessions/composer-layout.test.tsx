import userEvent from "@testing-library/user-event";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { useSession } from "@/features/conversation/web-session-context";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { composerLayoutCopy } from "@agentkib/session-ui";
import { sessionCopyForSurface } from "@/features/conversation/session-copy";
import { publishSessionInvalidation } from "@agentkib/conversation-state";
import type { SessionGoalState, SessionSettings } from "@agentkib/web-client";
import { composerAddCopy, composerModelCopy, planModeCopy } from "@agentkib/session-ui";

const modelReset = () => screen.getByRole("button", { name: "恢复默认模型" });
vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: vi.fn(),
}));
let state: ReturnType<typeof useSession>;
function settings(id = "s"): SessionSettings {
  return {
    sessionId: id,
    revision: 1,
    available: true,
    current: { modelId: "model", effort: "high", mode: "default" },
    defaults: { modelId: "model", effort: "medium" },
    writable: {
      model: { available: true },
      effort: { available: true },
      mode: { available: false, reason: "owner_channel_unavailable" },
      serviceTier: { available: false },
      policy: { available: false },
      restoreDefaults: { available: true },
    },
    options: {
      models: [
        { id: "model", name: `Test Model ${id}`, efforts: ["medium", "high"], serviceTierIds: [] },
      ],
      policies: [],
      serviceTiers: [],
    },
  };
}
beforeEach(() => {
  // Base UI measures the control before exposing the slider in browsers.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(0, 0, this.hasAttribute("data-index") ? 28 : 240, 28);
    },
  );
  state = {
    selected: "s",
    current: {
      id: "s",
      workspace_id: "workspace",
      agent: "codex",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
    locale: "zh-CN",
    t: dictionaries["zh-CN"],
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { accessMode: "full", send: true, attachments: true, advancedControl: true },
    },
    live: { sessionId: "s", status: "idle", revision: 1 },
    online: true,
    controlReady: true,
    busy: false,
    canSend: true,
    canStop: false,
    message: "",
    setMessage: vi.fn(),
    control: vi.fn(),
    runSessionAction: vi.fn(),
    capabilities: {
      sessionId: "s",
      features: {
        settings: { available: true },
        goal: { available: true },
        resources: { available: true },
        context: { available: true },
        attachments: { available: true },
      },
    },
    client: {
      sessionSettings: vi.fn(async (id: string) => settings(id)),
      codexGoals: vi.fn(async () => ({
        sessionId: "s",
        revision: 1,
        available: false,
        actions: {},
      })),
      codexContextOptions: vi.fn(async () => ({
        sessionId: "s",
        revision: 1,
        resources: [{ id: "resource", kind: "file", name: "readme.md", available: true }],
      })),
    },
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("responsive composer behavior", () => {
  it("locks model and permission controls during a turn, then uses each field grant when idle", async () => {
    state.locale = "en-US";
    state.t = dictionaries["en-US"];
    state.live = { ...state.live!, executionMode: "codex-managed", status: "running" };
    const native = settings();
    native.writable.effort = { available: false };
    native.writable.restoreDefaults = { available: false };
    native.options.models.push({
      id: "second-model",
      name: "Second model",
      efforts: ["medium", "high"],
      serviceTierIds: [],
    });
    vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
    const view = render(<SessionComposer />);
    const model = await screen.findByRole("button", {
      name: /Select reasoning effort: Test Model/,
    });
    expect(model).toBeDisabled();
    expect(screen.getByRole("button", { name: /Execution policy/ })).toBeDisabled();
    fireEvent.click(model);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.runSessionAction).not.toHaveBeenCalled();
    state = { ...state, live: { ...state.live!, status: "idle" } };
    view.rerender(<SessionComposer />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Select reasoning effort: Test Model/ }),
    );
    const panel = within(await screen.findByRole("dialog"));
    expect(await panel.findByRole("slider")).toBeDisabled();
    expect(panel.getByRole("button", { name: "Reset default model" })).toBeDisabled();
    expect(panel.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole("button", { name: /Select model: Test Model/ }));
    const secondModel = await screen.findByRole("button", { name: "Second model" });
    expect(secondModel).toBeEnabled();
    fireEvent.click(secondModel);
    expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
      model: "second-model",
    });
  });

  it.each([
    ["zh-CN", "电脑上的 AgentKib 尚未开启执行控制。"],
    ["zh-Hant", "電腦上的 AgentKib 尚未啟用執行控制。"],
    ["en-US", "Execution control is not enabled in AgentKib on your computer."],
    ["ja-JP", "コンピューター上の AgentKib で実行操作が有効になっていません。"],
  ] as const)(
    "identifies the computer application when execution control is off in %s",
    async (locale, notice) => {
      state.locale = locale;
      state.t = dictionaries[locale];
      state.access = { ...state.access!, experimentalEnabled: false };
      state.canSend = false;
      state.controlReady = false;
      state.message = "Keep this draft";
      render(<SessionComposer />);
      expect(await screen.findByText(notice)).toBeVisible();
      const send = screen.getByRole("button", { name: state.t.send });
      expect(send).toBeDisabled();
      fireEvent.click(send);
      expect(state.control).not.toHaveBeenCalled();
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.setMessage).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    },
  );

  it.each([
    ["zh-CN", "连接协议不兼容。请更新电脑上的 AgentKib 并重新连接。"],
    ["zh-Hant", "連線協定不相容。請更新電腦上的 AgentKib 並重新連線。"],
    [
      "en-US",
      "The connection protocol is incompatible. Update AgentKib on your computer and reconnect.",
    ],
    [
      "ja-JP",
      "接続プロトコルに互換性がありません。コンピューター上の AgentKib を更新して再接続してください。",
    ],
  ] as const)(
    "directs an incompatible Web connection to update AgentKib in %s without sending",
    async (locale, reason) => {
      state.locale = locale;
      state.t = dictionaries[locale];
      state.access = { ...state.access!, protocolVersion: 1 };
      state.canSend = false;
      state.controlReady = false;
      state.message = "Keep this draft";
      render(<SessionComposer />);

      expect(await screen.findByText(reason)).toBeVisible();
      const send = screen.getByRole("button", { name: state.t.send });
      expect(send).toBeDisabled();
      fireEvent.click(send);
      expect(state.control).not.toHaveBeenCalled();
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.setMessage).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    },
  );
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows a neutral model picker when no model is reported in %s",
    async (locale) => {
      state.locale = locale;
      state.t = dictionaries[locale];
      vi.mocked(state.client.sessionSettings).mockResolvedValue({
        ...settings(),
        current: {},
        defaults: {},
        options: { models: [], policies: [], serviceTiers: [] },
      });
      render(<SessionComposer />);
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalled());
      const copy = composerModelCopy[locale];
      const trigger = screen.getByRole("button", { name: copy.modelSettings });
      expect(trigger).toHaveTextContent(/^$/);
      const user = userEvent.setup();
      await user.hover(trigger);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(copy.modelSettings);
      await user.click(trigger);
      const overview = within(await screen.findByRole("dialog", { name: copy.modelSettings }));
      expect(overview.getByRole("button", { name: copy.chooseModel })).toHaveTextContent(
        copy.model,
      );
    },
  );
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "keeps confirmation feedback outside the model panel after a local settings intent in %s",
    async (locale) => {
      state.locale = locale;
      state.t = dictionaries[locale];
      vi.mocked(state.client.sessionSettings).mockResolvedValue({
        ...settings(),
        applicationStatus: "unknown",
      });
      const view = render(<SessionComposer />);
      const model = await screen.findByRole("button", { name: /Test Model/ });
      fireEvent.click(model);
      const panel = await screen.findByRole("dialog");
      const unknown = composerLayoutCopy[locale].settingsUnknown;
      expect(screen.queryByText(unknown)).not.toBeInTheDocument();
      state = { ...state, settingsChangedHere: true };
      view.rerender(<SessionComposer />);
      expect(within(panel).queryByText(unknown)).not.toBeInTheDocument();
      expect(
        within(panel).getByRole("button", { name: composerModelCopy[locale].reset }),
      ).toBeDisabled();
      fireEvent.click(model);
      expect(await screen.findByText(unknown)).toBeVisible();
      expect(state.runSessionAction).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      "zh-CN",
      "当前模型不在运行 AgentKib 的电脑已验证的模型列表中，本次消息尚未发送。请更改模型后再发送。",
      "更改模型",
    ],
    [
      "zh-Hant",
      "目前模型不在執行 AgentKib 的電腦已驗證的模型清單中，本次訊息尚未傳送。請變更模型後再傳送。",
      "變更模型",
    ],
    [
      "en-US",
      "The current model is not in the model list verified on the computer running AgentKib. This message was not sent. Change the model before sending again.",
      "Change model",
    ],
    [
      "ja-JP",
      "現在のモデルはAgentKib を実行しているコンピューターで検証済みのモデル一覧にありません。このメッセージは送信されていません。モデルを変更してから送信してください。",
      "モデルを変更",
    ],
  ] as const)(
    "opens settings for an unsupported model in %s without sending or changing the draft",
    async (locale, reason, action) => {
      state = {
        ...state,
        locale,
        t: dictionaries[locale],
        notice: "notDispatched",
        noticeReason: "unsupported-model",
        message: "Keep this draft",
      };
      const inherited = {
        ...settings(),
        current: { modelId: "unlisted-model", effort: "high", mode: "default" as const },
      };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(inherited);
      render(<SessionComposer />);
      expect(await screen.findByText(reason)).toBeVisible();
      await screen.findByRole("button", { name: /unlisted-model/ });
      vi.mocked(state.client.sessionSettings).mockClear();
      fireEvent.click(screen.getByRole("button", { name: action }));
      const dialog = await screen.findByRole("dialog", { name: composerModelCopy[locale].model });
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledWith("s", "codex"));
      expect(state.runSessionAction).not.toHaveBeenCalled();
      expect(state.control).not.toHaveBeenCalled();
      expect(state.setMessage).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Test Model s" }));
      await waitFor(() =>
        expect(state.runSessionAction).toHaveBeenCalledWith(
          "settings",
          expect.objectContaining({ model: "model" }),
        ),
      );
      expect(state.control).not.toHaveBeenCalled();
      expect(state.setMessage).not.toHaveBeenCalled();
    },
  );

  it("shows effort recovery only for a confirmed Codex rejection", async () => {
    state = { ...state, notice: "notDispatched", noticeReason: "unsupported-effort" };
    const view = render(<SessionComposer />);
    expect(
      await screen.findByText(
        "当前模型不支持所选思考强度，本次消息尚未发送。请调整模型或思考强度后再发送。",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "更改模型" })).toBeVisible();
    state = { ...state, notice: "uncertain" };
    view.rerender(<SessionComposer />);
    expect(screen.queryByRole("button", { name: "更改模型" })).not.toBeInTheDocument();
    state = {
      ...state,
      notice: "notDispatched",
      current: { ...state.current!, agent: "claude-code" },
      capabilities: { ...state.capabilities!, features: {} },
    };
    view.rerender(<SessionComposer />);
    expect(screen.queryByRole("button", { name: "更改模型" })).not.toBeInTheDocument();
  });

  it("shows native usage before settings load and preserves it after a late settings response", async () => {
    let finish!: (value: SessionSettings) => void;
    vi.mocked(state.client.sessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.live = {
      ...state.live!,
      usage: { available: true, state: "ready", reportId: 1, usedTokens: 8, contextWindow: 100 },
    };
    render(<SessionComposer />);
    const usage = screen.getByRole("img", { name: "上下文用量" });
    expect(usage).toHaveAccessibleDescription(expect.stringContaining("8%"));
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () =>
      finish({ ...settings(), usage: { available: true, usedTokens: 95, contextWindow: 100 } }),
    );
    expect(usage).toHaveAccessibleDescription(expect.stringContaining("8%"));
  });

  it("keeps settings and goals read-only while compacting despite retained capabilities", async () => {
    state.live = {
      ...state.live!,
      activity: "compacting",
      usage: { available: false, state: "pending" },
    };
    state.capabilities!.features = {
      ...state.capabilities!.features,
      "goal-set": { available: true },
      "goal-pause": { available: true },
      "goal-clear": { available: true },
    };
    vi.mocked(state.client.codexGoals).mockResolvedValue({
      sessionId: "s",
      revision: 1,
      available: true,
      goal: { objective: "Keep working", status: "active" },
      actions: {
        set: { available: true },
        pause: { available: true },
        resume: { available: false },
        clear: { available: true },
      },
    });
    render(<SessionComposer />);
    const picker = await screen.findByRole("button", { name: /Test Model/ });
    expect(picker).toBeDisabled();
    fireEvent.click(picker);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "持续目标" }));
    expect(
      screen.getByRole("button", { name: sessionCopyForSurface("zh-CN", "web").goalUpdate }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: sessionCopyForSurface("zh-CN", "web").goalPause }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: sessionCopyForSurface("zh-CN", "web").goalClear }),
    ).toBeDisabled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });
  it("opens unknown context usage on keyboard focus without a dialog", async () => {
    render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    const usage = screen.getByRole("img", { name: "上下文用量" });
    act(() => usage.focus());
    expect(usage).toHaveFocus();
    const details = await screen.findByRole("tooltip");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(details).not.toHaveAttribute("aria-modal", "true");
    expect(details).toHaveTextContent("暂无用量数据");
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(usage).toHaveFocus();
  });
  it("keeps selected resources in the draft after Done and puts goals in Add", async () => {
    render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    await waitFor(() => expect(state.client.codexContextOptions).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "持续目标" })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "添加上下文" });
    add.focus();
    fireEvent.click(add);
    const panel = await screen.findByRole("dialog", { name: "添加上下文" });
    expect(panel).not.toHaveAttribute("aria-modal", "true");
    await waitFor(() =>
      expect(within(panel).getByRole("button", { name: "持续目标" })).toBeVisible(),
    );
    const { back, filesAndFolders } = composerAddCopy("zh-CN");
    const actions = within(panel);
    expect(actions.queryByRole("checkbox", { name: /readme/ })).not.toBeInTheDocument();
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
    fireEvent.click(actions.getByRole("button", { name: filesAndFolders }));
    expect(actions.getByRole("button", { name: back })).toHaveFocus();
    expect(actions.queryByRole("button", { name: "持续目标" })).not.toBeInTheDocument();
    fireEvent.click(await actions.findByRole("checkbox", { name: /readme/ }));
    expect(screen.getByText("已选: 1")).toBeVisible();
    fireEvent.click(actions.getByRole("button", { name: back }));
    expect(actions.queryByRole("checkbox", { name: /readme/ })).not.toBeInTheDocument();
    expect(actions.getByRole("button", { name: filesAndFolders })).toHaveFocus();
    fireEvent.click(actions.getByRole("button", { name: filesAndFolders }));
    expect(await actions.findByRole("checkbox", { name: /readme/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    await waitFor(() => expect(add).toHaveFocus());
    expect(screen.getByRole("button", { name: "移除附件: readme.md" })).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toBeEnabled();
  });
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as Locale[])(
    "localizes effort and exposes disabled reasons in %s",
    async (locale) => {
      state = { ...state, locale, t: dictionaries[locale] };
      const native = settings();
      native.options.collaborationModes = [{ id: "plan", name: "Plan" }];
      vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
      render(<SessionComposer />);
      const model = await screen.findByRole("button", { name: /Test Model/ });
      fireEvent.click(model);
      expect(await screen.findByRole("slider")).toHaveAttribute(
        "aria-valuetext",
        { "zh-CN": "高", "zh-Hant": "高", "en-US": "High", "ja-JP": "高" }[locale],
      );
      fireEvent.click(model);
      const copy = sessionCopyForSurface(locale, "web");
      const add = screen.getByRole("button", { name: copy.addContext });
      fireEvent.click(add);
      const panel = within(await screen.findByRole("dialog", { name: copy.addContext }));
      const plan = panel.getByRole("button", { name: planModeCopy(locale).title });
      expect(plan).toBeDisabled();
      expect(plan).toHaveAttribute("title", copy.unavailable);
      fireEvent.click(add);
      const policy = screen.getByRole("button", { name: copy.executionPolicy });
      expect(policy).toBeDisabled();
      fireEvent.click(policy);
      expect(screen.queryByRole("menu", { name: copy.executionPolicy })).not.toBeInTheDocument();
    },
  );
  it("does not confuse an empty message with missing authorization", async () => {
    const view = render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(screen.queryByText(composerLayoutCopy["zh-CN"].permission)).not.toBeInTheDocument();
    state = { ...state, online: false, canSend: false };
    view.rerender(<SessionComposer />);
    expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
    expect(state.control).not.toHaveBeenCalled();
  });
  it.each([
    ["unverified-installation", dictionaries["zh-CN"].unverifiedInstallation],
    ["open-in-original-client", dictionaries["zh-CN"].openOriginalClient],
  ])("shows actionable %s advice beside the disabled composer", async (reason, expected) => {
    state = {
      ...state,
      canSend: false,
      message: "Draft",
      live: { ...state.live!, status: "unsupported", sendEnabled: false, reason },
    };
    render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    expect(screen.getByRole("status")).toHaveTextContent(expected);
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });
  it("keeps the draft editable while the DSH owner cannot be verified", () => {
    state = {
      ...state,
      current: { ...state.current!, agent: "deepseek-harness" },
      canSend: false,
      canStop: false,
      message: "Keep this draft",
      live: {
        ...state.live!,
        status: "unsupported",
        reason: "dsh-native-status-unknown",
        executionMode: "dsh-follower",
        sendEnabled: false,
      },
    };
    render(<SessionComposer />);
    expect(screen.queryByText(/DeepSeek Harness 桥接未连接/)).not.toBeInTheDocument();
    const draft = screen.getByRole("textbox");
    expect(draft).toBeEnabled();
    expect(draft).toHaveValue("Keep this draft");
    const send = screen.getByRole("button", { name: "发送" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(state.control).not.toHaveBeenCalled();
  });
  it("keeps controls disabled for an observed DSH turn during capability refresh", () => {
    state = {
      ...state,
      current: { ...state.current!, agent: "deepseek-harness" },
      canSend: false,
      canStop: false,
      message: "Keep this draft",
      capabilities: {
        ...state.capabilities!,
        features: { steer: { available: true }, "queue-add": { available: true } },
      },
      live: {
        ...state.live!,
        status: "running",
        executionLocation: "external",
        reason: "dsh-native-turn-observed",
        executionMode: "dsh-follower",
        sendEnabled: false,
      },
    };
    render(<SessionComposer />);
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft");
    expect(screen.getByRole("button", { name: state.t.send })).toBeDisabled();
    expect(screen.queryByRole("button", { name: state.t.stop })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: sessionCopyForSurface(state.locale, "web").advanced }),
    ).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
  });
  it("ignores late settings responses for a previously selected conversation", async () => {
    let finish!: (value: SessionSettings) => void;
    vi.mocked(state.client.sessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<SessionComposer />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledWith("s", "codex"));
    state = {
      ...state,
      selected: "next",
      current: { ...state.current!, id: "next" },
      live: { ...state.live!, sessionId: "next" },
      capabilities: { ...state.capabilities!, sessionId: "next" },
    };
    view.rerender(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model next/ });
    finish(settings("old"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Test Model old/ })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Test Model next/ })).toBeVisible();
  });
});

describe("native Plan and Goal projection", () => {
  it("shows selected next-turn mode without claiming native confirmation, and confirms only on native state", async () => {
    const native = settings();
    native.writable.mode = { available: true };
    native.writable.serviceTier = { available: true };
    native.options.collaborationModes = [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ];
    native.options.models.push({
      id: "next-model",
      name: "Next Model",
      efforts: ["low"],
      serviceTierIds: ["priority"],
    });
    native.options.serviceTiers = [{ id: "priority", name: "Fast" }];
    native.selected = {
      modelId: "next-model",
      effort: "low",
      mode: "plan",
      serviceTierId: "priority",
    };
    native.applicationStatus = "pending";
    vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
    state = { ...state, message: "Keep this draft" };
    const view = render(<SessionComposer />);
    const modelSettings = await screen.findByRole("button", {
      name: /Next Model.*Fast/,
    });
    expect(modelSettings).not.toHaveAccessibleName(/下一轮/);
    expect(modelSettings).toHaveTextContent(/^Next Model$/);
    expect(modelSettings).toHaveAccessibleName(/Fast/);
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "添加上下文" }));
    const add = await screen.findByRole("dialog", { name: "添加上下文" });
    expect(add).not.toHaveAttribute("aria-modal", "true");
    const plan = within(add).getByRole("button", { name: "计划模式" });
    expect(plan).toHaveAttribute("aria-pressed", "true");
    expect(plan).toBeEnabled();
    expect(screen.queryByText("已保存设置，发送后确认生效状态。")).not.toBeInTheDocument();
    expect(screen.queryByText("设置已由这台电脑确认")).not.toBeInTheDocument();
    state = {
      ...state,
      live: {
        ...state.live!,
        settings: { ...native, current: native.selected, applicationStatus: "confirmed" },
      },
    };
    view.rerender(<SessionComposer />);
    await waitFor(() =>
      expect(screen.queryByText("已保存设置，发送后确认生效状态。")).not.toBeInTheDocument(),
    );
    expect(state.runSessionAction).not.toHaveBeenCalled();
    expect(state.control).not.toHaveBeenCalled();
  });
  it("retains the Plan entry without manufacturing native modes when its directory is absent", async () => {
    const native = settings();
    native.writable.mode = { available: true };
    native.options.policies = [{ id: "workspace-write-on-request", name: "Request approval" }];
    vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
    render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    const add = screen.getByRole("button", { name: "添加上下文" });
    fireEvent.click(add);
    const panel = within(await screen.findByRole("dialog", { name: "添加上下文" }));
    expect(panel.getByRole("button", { name: "计划模式" })).toBeDisabled();
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: /^执行策略/ }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem")).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).queryByRole("menuitem", { name: "计划" })).not.toBeInTheDocument();
  });
  it.each(["paused", "blocked", "active", "budgetLimited", "usageLimited", "complete"])(
    "maps native %s to valid goal controls and updates without activation",
    async (status) => {
      state.capabilities = {
        ...state.capabilities!,
        features: {
          ...state.capabilities!.features,
          "goal-set": { available: true },
          "goal-pause": { available: true },
          "goal-resume": { available: true },
          "goal-clear": { available: true },
        },
      };
      vi.mocked(state.client.codexGoals).mockResolvedValue({
        sessionId: "s",
        revision: 1,
        available: true,
        goal: { objective: "Safe native goal", status, tokenBudget: 5000 },
        actions: {
          set: { available: true },
          pause: { available: true },
          resume: { available: true },
          clear: { available: true },
        },
      });
      render(<SessionComposer />);
      fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
      const pause = screen.queryByRole("button", { name: "暂停" });
      if (status === "active") expect(pause).toBeEnabled();
      else if (status === "complete") expect(pause).toBeDisabled();
      else expect(pause).not.toBeInTheDocument();
      expect(!!screen.queryByRole("button", { name: "恢复并继续执行" })).toBe(
        ["paused", "blocked"].includes(status),
      );
      expect(!!screen.queryByRole("button", { name: "尝试恢复" })).toBe(
        ["budgetLimited", "usageLimited"].includes(status),
      );
      fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "更新目标" }));
      await waitFor(() =>
        expect(state.runSessionAction).toHaveBeenCalledWith("goal-set", {
          objective: "Safe native goal",
          intent: "update",
          tokenBudget: null,
        }),
      );
      expect(state.control).not.toHaveBeenCalled();
    },
  );
});

it("reconciles selected native invalidations and freezes changes until the new revision is read", async () => {
  const native = settings();
  native.selected = { ...native.current, mode: "plan" };
  native.applicationStatus = "pending";
  native.options.collaborationModes = [
    { id: "default", name: "Default" },
    { id: "plan", name: "Plan" },
  ];
  native.writable.mode = { available: true };
  vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
  vi.mocked(state.client.codexGoals).mockResolvedValue({
    sessionId: "s",
    revision: 1,
    available: true,
    goal: { objective: "Native goal", status: "paused" },
    actions: {
      set: { available: true },
      pause: { available: false },
      resume: { available: true },
      clear: { available: true },
    },
  });
  const view = render(<SessionComposer />);
  fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
  vi.useFakeTimers();
  const initialReads = vi.mocked(state.client.sessionSettings).mock.calls.length;
  const initialResources = vi.mocked(state.client.codexContextOptions).mock.calls.length;
  state = {
    ...state,
    live: { ...state.live!, unrelatedData: "unchanged selected revision" } as typeof state.live,
  };
  view.rerender(<SessionComposer />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(state.client.sessionSettings).toHaveBeenCalledTimes(initialReads);
  vi.mocked(state.client.sessionSettings).mockResolvedValue({
    ...native,
    revision: 2,
    current: native.selected!,
    applicationStatus: "confirmed",
  });
  vi.mocked(state.client.codexGoals).mockResolvedValue({
    sessionId: "s",
    revision: 2,
    available: true,
    actions: {
      set: { available: true },
      pause: { available: false },
      resume: { available: false },
      clear: { available: false },
    },
  });
  state = { ...state, live: { ...state.live!, revision: 2 } };
  view.rerender(<SessionComposer />);
  expect(modelReset()).toBeDisabled();
  fireEvent.click(modelReset());
  expect(state.runSessionAction).not.toHaveBeenCalled();
  await act(async () => {
    publishSessionInvalidation(state.client, "s", ["settings", "goal"]);
  });
  expect(state.client.sessionSettings).toHaveBeenCalledTimes(initialReads + 1);
  expect(state.client.codexContextOptions).toHaveBeenCalledTimes(initialResources);
  expect(screen.queryByText("已保存设置，发送后确认生效状态。")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "持续目标" })).not.toBeInTheDocument();
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "1");
  expect(modelReset()).toBeEnabled();
  expect(state.runSessionAction).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("ignores late selected-session native reads after switching conversations", async () => {
  const view = render(<SessionComposer />);
  await screen.findByRole("button", { name: /Test Model s/ });
  let resolveOld!: (value: SessionSettings) => void;
  vi.mocked(state.client.sessionSettings).mockImplementation((id) =>
    id === "s"
      ? new Promise((resolve) => {
          resolveOld = resolve;
        })
      : Promise.resolve(settings(id)),
  );
  vi.useFakeTimers();
  state = { ...state, live: { ...state.live!, revision: 2 } };
  view.rerender(<SessionComposer />);
  await act(async () => {
    publishSessionInvalidation(state.client, "s", ["settings"]);
  });
  state = {
    ...state,
    selected: "new",
    current: { ...state.current!, id: "new" },
    live: { ...state.live!, sessionId: "new", revision: 1 },
    capabilities: { ...state.capabilities!, sessionId: "new" },
  };
  view.rerender(<SessionComposer />);
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () =>
    resolveOld({ ...settings("s"), selected: { modelId: "stale" }, applicationStatus: "pending" }),
  );
  expect(screen.getByRole("button", { name: /Test Model new/ })).toBeVisible();
  expect(screen.queryByText("stale")).not.toBeInTheDocument();
  expect(state.runSessionAction).not.toHaveBeenCalled();
  vi.useRealTimers();
});

describe("idle conversation revision calibration", () => {
  it("discards a batched read when the selected session changes before it starts", async () => {
    const view = render(<SessionComposer />);
    state = {
      ...state,
      selected: "next",
      current: { ...state.current!, id: "next" },
      live: { ...state.live!, sessionId: "next" },
      capabilities: { ...state.capabilities!, sessionId: "next" },
    };
    view.rerender(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model next/ });
    expect(state.client.sessionSettings).toHaveBeenCalledExactlyOnceWith("next", "codex");
  });

  it.each([
    ["codex-follower", true],
    ["codex-follower", false],
    ["codex-managed", true],
    ["codex-managed", false],
  ] as const)(
    "refreshes %s settings after an unrelated idle revision (open: %s)",
    async (executionMode, open) => {
      const native = settings();
      if (executionMode === "codex-follower") {
        native.executionMode = "codex-follower";
        native.writeScope = "current-owner";
        native.writable.restoreDefaults = { available: false };
        // Follower goal reads can be unsupported and have no usable revision.
        vi.mocked(state.client.codexGoals).mockResolvedValue({
          available: false,
        } as SessionGoalState);
      }
      state.live = { ...state.live!, executionMode };
      vi.mocked(state.client.sessionSettings).mockResolvedValue(native);
      const view = render(<SessionComposer />);
      const model = await screen.findByRole("button", { name: /Test Model/ });
      if (open) fireEvent.click(model);
      expect(state.client.sessionSettings).toHaveBeenCalledOnce();
      vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...native, revision: 2 });
      // Neither follower nor the raw managed settings projection supplies the
      // complete session-settings read model on an unrelated native state patch.
      state = { ...state, live: { ...state.live!, revision: 2 } };
      view.rerender(<SessionComposer />);
      act(() => publishSessionInvalidation(state.client, "s", ["catalog"]));
      await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
      if (!open) fireEvent.click(model);
      if (executionMode === "codex-follower") {
        await waitFor(() => expect(screen.getByRole("slider")).toBeEnabled());
        expect(modelReset()).toBeDisabled();
      } else await waitFor(() => expect(modelReset()).toBeEnabled());
      expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
      expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
      expect(state.runSessionAction).not.toHaveBeenCalled();
    },
  );

  it("calibrates exposed goal actions without discarding an edited goal", async () => {
    state.capabilities!.features["goal-set"] = { available: true };
    state.capabilities!.features["goal-resume"] = { available: true };
    const goal: SessionGoalState = {
      sessionId: "s",
      revision: 1,
      available: true,
      goal: { objective: "Native goal", status: "paused" },
      actions: {
        set: { available: true },
        resume: { available: true },
        pause: { available: false },
        clear: { available: false },
      },
    };
    vi.mocked(state.client.codexGoals).mockResolvedValue(goal);
    const view = render(<SessionComposer />);
    fireEvent.click(await screen.findByRole("button", { name: "持续目标" }));
    fireEvent.change(screen.getByRole("textbox", { name: "目标内容" }), {
      target: { value: "Keep my goal draft" },
    });
    vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...settings(), revision: 2 });
    vi.mocked(state.client.codexGoals).mockResolvedValue({ ...goal, revision: 2 });
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<SessionComposer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "恢复并继续执行" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "目标内容" })).toHaveValue("Keep my goal draft");
    expect(screen.getByText(composerLayoutCopy["zh-CN"].nativeChanged)).toBeVisible();
    expect(screen.getByRole("button", { name: "更新目标" })).toBeDisabled();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });

  it("coalesces initial and idle reads, then drains changes received during the flight", async () => {
    let finish!: (value: SessionSettings) => void;
    vi.mocked(state.client.sessionSettings)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ ...settings(), revision: 3 });
    const view = render(<SessionComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings", "goal"]));
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledOnce());
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<SessionComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings"]));
    state = { ...state, live: { ...state.live!, revision: 3 } };
    view.rerender(<SessionComposer />);
    expect(state.client.sessionSettings).toHaveBeenCalledOnce();
    await act(async () => finish(settings()));
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    await waitFor(() => expect(modelReset()).toBeEnabled());
    expect(state.client.sessionSettings).toHaveBeenCalledTimes(2);
    expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
  });

  it("does not read settings for running token revisions and calibrates once on idle", async () => {
    const view = render(<SessionComposer />);
    await screen.findByRole("button", { name: /Test Model/ });
    for (let revision = 2; revision <= 20; revision++) {
      state = { ...state, live: { ...state.live!, status: "running", revision } };
      view.rerender(<SessionComposer />);
    }
    await act(async () => {});
    expect(state.client.sessionSettings).toHaveBeenCalledOnce();
    expect(state.client.codexGoals).toHaveBeenCalledOnce();
    vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...settings(), revision: 21 });
    state = { ...state, live: { ...state.live!, status: "idle", revision: 21 } };
    view.rerender(<SessionComposer />);
    act(() => publishSessionInvalidation(state.client, "s", ["settings", "goal", "usage"]));
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
    expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
  });

  it("retains settings after a failed calibration without retrying until another idle event", async () => {
    const view = render(<SessionComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    vi.useFakeTimers();
    vi.mocked(state.client.sessionSettings).mockRejectedValueOnce(new Error("unavailable"));
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<SessionComposer />);
    await act(async () => {});
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "1");
    expect(modelReset()).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(state.client.sessionSettings).toHaveBeenCalledTimes(2);
    vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...settings(), revision: 3 });
    state = { ...state, live: { ...state.live!, revision: 3 } };
    view.rerender(<SessionComposer />);
    await act(async () => {});
    expect(modelReset()).toBeEnabled();
    expect(state.client.sessionSettings).toHaveBeenCalledTimes(3);
  });

  it("keeps an applied settings action busy until its shared read finishes", async () => {
    const view = render(<SessionComposer />);
    fireEvent.click(await screen.findByRole("button", { name: /Test Model/ }));
    let finish!: (value: SessionSettings) => void;
    vi.mocked(state.client.sessionSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(state.runSessionAction).mockResolvedValue({ accepted: true } as never);
    fireEvent.click(modelReset());
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
    expect(modelReset()).toBeDisabled();
    await act(async () => finish(settings()));
    expect(modelReset()).toBeEnabled();
  });

  it.each([true, false])(
    "refreshes a running goal only on demand and keeps the latest CAS guard (open: %s)",
    async (open) => {
      state.capabilities!.features["goal-set"] = { available: true };
      state.capabilities!.features["goal-pause"] = { available: true };
      const goal: SessionGoalState = {
        sessionId: "s",
        revision: 1,
        available: true,
        goal: { objective: "Native goal", status: "active" },
        actions: {
          set: { available: true },
          pause: { available: true },
          resume: { available: false },
          clear: { available: false },
        },
      };
      vi.mocked(state.client.codexGoals).mockResolvedValue(goal);
      const view = render(<SessionComposer />);
      const goalButton = await screen.findByRole("button", { name: "持续目标" });
      if (open) {
        fireEvent.click(goalButton);
        fireEvent.change(screen.getByRole("textbox", { name: "目标内容" }), {
          target: { value: "Keep my running goal draft" },
        });
      }
      state = { ...state, live: { ...state.live!, status: "running", revision: 2 } };
      view.rerender(<SessionComposer />);
      await act(async () => {});
      expect(state.client.codexGoals).toHaveBeenCalledOnce();
      let finish!: (value: SessionGoalState) => void;
      vi.mocked(state.client.codexGoals).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      vi.mocked(state.client.sessionSettings).mockResolvedValue({
        ...settings(),
        revision: 2,
      });
      fireEvent.click(open ? screen.getByRole("button", { name: "重新载入" }) : goalButton);
      await waitFor(() => expect(state.client.codexGoals).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
      state = { ...state, live: { ...state.live!, revision: 3 } };
      view.rerender(<SessionComposer />);
      await act(async () => finish({ ...goal, revision: 2 }));
      expect(screen.getByRole("button", { name: "暂停" })).toBeDisabled();
      expect(state.client.codexGoals).toHaveBeenCalledTimes(2);
      expect(state.runSessionAction).not.toHaveBeenCalled();

      vi.mocked(state.client.codexGoals).mockResolvedValue({ ...goal, revision: 3 });
      vi.mocked(state.client.sessionSettings).mockResolvedValue({
        ...settings(),
        revision: 3,
      });
      fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled());
      if (open) {
        expect(screen.getByRole("textbox", { name: "目标内容" })).toHaveValue(
          "Keep my running goal draft",
        );
        expect(screen.getByText(composerLayoutCopy["zh-CN"].nativeChanged)).toBeVisible();
        expect(screen.getByRole("button", { name: "更新目标" })).toBeDisabled();
      }
      expect(state.client.codexGoals).toHaveBeenCalledTimes(3);
      expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
      expect(state.runSessionAction).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "暂停" }));
      expect(state.runSessionAction).toHaveBeenCalledExactlyOnceWith("goal-pause", {});
    },
  );

  it("retries a failed explicit settings refresh on demand without rescanning resources", async () => {
    const view = render(<SessionComposer />);
    const picker = await screen.findByRole("button", { name: /Test Model/ });
    const reopen = async () => {
      fireEvent.click(picker);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      fireEvent.click(picker);
    };
    fireEvent.click(picker);
    vi.mocked(state.client.sessionSettings).mockRejectedValue(new Error("unavailable"));
    state = { ...state, live: { ...state.live!, revision: 2 } };
    view.rerender(<SessionComposer />);
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(2));
    await reopen();
    await waitFor(() => expect(state.client.sessionSettings).toHaveBeenCalledTimes(3));
    await act(async () => {});
    expect(modelReset()).toBeDisabled();
    vi.mocked(state.client.sessionSettings).mockResolvedValue({ ...settings(), revision: 2 });
    await reopen();
    const overview = within(await screen.findByRole("dialog"));
    const copy = composerModelCopy["zh-CN"];
    fireEvent.click(
      await overview.findByRole("button", { name: `${copy.chooseModel}: Test Model s` }),
    );
    const models = await screen.findByRole("dialog", { name: copy.model });
    await waitFor(() =>
      expect(within(models).getByRole("button", { name: "Test Model s" })).toBeEnabled(),
    );
    expect(state.client.codexContextOptions).toHaveBeenCalledOnce();
    expect(state.runSessionAction).not.toHaveBeenCalled();
  });
});
