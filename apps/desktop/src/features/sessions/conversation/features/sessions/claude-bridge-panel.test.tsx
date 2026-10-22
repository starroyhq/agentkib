// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "./use-session-controller";
import { ClaudeBridgePanel } from "./claude-bridge-panel";

const state = vi.hoisted(() => ({
  session: {} as SessionController,
  request: vi.fn(),
  resumeCommand: vi.fn(),
}));
vi.mock("./session-context", () => ({ useSession: () => state.session }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request: state.request } }) }));

const status = (sessionId = "s") => ({
  supported: true,
  connected: false,
  sessionId,
  version: "2.1.301",
  pluginDirectory: "/isolated/plugin",
  installInstructions: "Install isolated plugin",
});
const challenge = {
  challenge: "one-time-code",
  expiresAt: new Date(Date.now() + 120_000).toISOString(),
  instructions: "/agentkib:connect one-time-code",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  state.request.mockReset();
  state.resumeCommand.mockReset().mockResolvedValue({
    available: true,
    command: "cd -- '/synthetic/workspace with spaces' && claude --resume 'synthetic-session'",
    shell: "posix",
    runOn: "host",
  });
  state.session = {
    selected: "s",
    current: { id: "s", agent: "claude-code" },
    locale: "zh-CN",
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { manage: true },
    },
    online: true,
    controlReady: true,
    busy: false,
    live: { sessionId: "s", status: "idle", executionMode: "managed-resume" },
    refresh: vi.fn().mockResolvedValue(undefined),
    client: { claudeResumeCommand: state.resumeCommand },
  } as unknown as SessionController;
  state.request.mockImplementation(async ({ operation, sessionId }) =>
    operation === "bridge-status"
      ? status(sessionId)
      : operation === "bridge-challenge"
        ? challenge
        : { disconnected: true },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Claude terminal connection management", () => {
  it("keeps a validated offline binding waiting for terminal reconnection after a restart", async () => {
    state.request.mockResolvedValue({ ...status(), hasBinding: true });
    render(<ClaudeBridgePanel active />);
    expect(await screen.findByText("等待终端重新连接")).toBeVisible();
    expect(screen.getByText("在终端继续这条会话后会自动连接，不需要新的连接码。")).toBeVisible();
    expect(screen.getByRole("button", { name: "已安装插件" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "复制继续命令" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新生成连接码" })).toHaveClass("text-primary-text");
    expect(screen.getByRole("button", { name: "清除连接…" })).toHaveClass("text-primary-text");
    expect(screen.queryByRole("button", { name: "生成连接码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("未连接", { exact: true })).toBeVisible();
  });

  it("does not let an old follower snapshot revive an explicitly absent binding", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    state.request.mockResolvedValue({ ...status(), hasBinding: false });
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.getByRole("button", { name: "生成连接码" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
    expect(screen.queryByText("等待终端重新连接")).not.toBeInTheDocument();
  });

  it("uses explicit offline status instead of a stale follower snapshot to allow recovery", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "idle",
    };
    state.request.mockResolvedValue({ ...status(), hasBinding: true });
    render(<ClaudeBridgePanel active />);
    await waitFor(() => expect(screen.getByRole("button", { name: "复制继续命令" })).toBeEnabled());
    expect(screen.getByText("等待终端重新连接")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新生成连接码" })).toBeEnabled();
    expect(screen.queryByText("已连接终端")).not.toBeInTheDocument();
  });

  it("rejects an unvalidated binding flag instead of offering connection actions", async () => {
    state.request.mockResolvedValue({ ...status(), hasBinding: "true" });
    render(<ClaudeBridgePanel active />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法完成连接操作，请检查这台电脑状态后重试。",
    );
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("keeps revocation when an unsafe source cannot authoritatively report an absent binding", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "idle",
    };
    state.request.mockResolvedValue({
      ...status(),
      supported: false,
      hasBinding: false,
      reason: "claude-bridge-session-unavailable",
    });
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "清除连接…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "复制继续命令" })).not.toBeInTheDocument();
    state.session = { ...state.session, notice: "uncertain" };
    view.rerender(<ClaudeBridgePanel active />);
    fireEvent.click(screen.getByRole("button", { name: "清除连接…" }));
    state.request.mockResolvedValueOnce({ disconnected: true });
    fireEvent.click(screen.getByRole("button", { name: "确认清除连接" }));
    await waitFor(() => expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true));
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
  });

  it("copies the validated resume command without building a command or generating a code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    state.request.mockResolvedValue({ ...status(), hasBinding: true });
    render(<ClaudeBridgePanel active />);
    fireEvent.click(await screen.findByRole("button", { name: "复制继续命令" }));
    await screen.findByText("复制继续命令 · 已复制");
    expect(state.resumeCommand).toHaveBeenCalledExactlyOnceWith("s", expect.any(AbortSignal));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      "cd -- '/synthetic/workspace with spaces' && claude --resume 'synthetic-session'",
    );
    expect(state.request.mock.calls.map(([request]) => request.operation)).toEqual([
      "bridge-status",
    ]);
  });

  it("keeps a resume request started at the first enabled commit alive", async () => {
    const resume = deferred<unknown>();
    state.resumeCommand.mockReturnValueOnce(resume.promise);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    state.request.mockResolvedValue({ ...status(), hasBinding: true });
    let clicked = false;
    const disabledAtClick: boolean[] = [];
    render(
      <Profiler
        id="first-enabled-copy"
        onRender={() => {
          const button = screen.queryByRole<HTMLButtonElement>("button", { name: "复制继续命令" });
          if (clicked || !button || button.disabled) return;
          clicked = true;
          disabledAtClick.push(button.disabled);
          // The outer render already uses act; avoid nesting it inside this commit.
          button.click();
        }}
      >
        <ClaudeBridgePanel active />
      </Profiler>,
    );
    await waitFor(() => expect(state.resumeCommand).toHaveBeenCalledOnce());
    await act(async () => {});
    expect({
      disabledAtClick,
      requests: state.resumeCommand.mock.calls.length,
      aborted: state.resumeCommand.mock.calls[0][1].aborted,
      clipboardCalls: writeText.mock.calls.length,
    }).toEqual({ disabledAtClick: [false], requests: 1, aborted: false, clipboardCalls: 0 });
    await act(async () =>
      resume.resolve({ available: true, command: "synthetic validated command" }),
    );
    expect({
      aborted: state.resumeCommand.mock.calls[0][1].aborted,
      clipboardCalls: writeText.mock.calls.length,
    }).toEqual({ aborted: false, clipboardCalls: 1 });
    await screen.findByText("复制继续命令 · 已复制");
    expect(writeText).toHaveBeenCalledOnce();
  });

  it.each(["before", "after"] as const)(
    "accepts only fresh binding evidence when an old poll arrives %s the clear ACK",
    async (order) => {
      vi.useFakeTimers();
      const previous = deferred<unknown>();
      const acknowledgement = deferred<unknown>();
      state.session.live = { ...state.session.live!, connectionGeneration: "runtime-boot" };
      state.request
        .mockResolvedValueOnce({ ...status(), hasBinding: true })
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(acknowledgement.promise)
        .mockResolvedValue({ ...status(), hasBinding: false });
      render(<ClaudeBridgePanel active />);
      await act(async () => {});
      expect(screen.getByText("等待终端重新连接")).toBeVisible();
      await act(async () => vi.advanceTimersByTime(2500));
      fireEvent.click(screen.getByRole("button", { name: "清除连接…" }));
      fireEvent.click(screen.getByRole("button", { name: "确认清除连接" }));
      if (order === "before")
        await act(async () => previous.resolve({ ...status(), hasBinding: true }));
      await act(async () => acknowledgement.resolve({ disconnected: true }));
      if (order === "after")
        await act(async () => previous.resolve({ ...status(), hasBinding: true }));
      expect(screen.getByRole("button", { name: "生成连接码" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
      expect(screen.queryByText("等待终端重新连接")).not.toBeInTheDocument();

      // A later verified binding can already be offline before a lease snapshot
      // reaches this renderer. Its fresh owner lookup proves it can be cleared.
      state.request.mockResolvedValue({ ...status(), hasBinding: true });
      await act(async () => vi.advanceTimersByTime(2500));
      expect(screen.getByText("等待终端重新连接")).toBeVisible();
      expect(screen.getByRole("button", { name: "清除连接…" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "复制继续命令" })).toBeEnabled();
      expect(screen.queryByText("已连接终端")).not.toBeInTheDocument();
      expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    },
  );

  it("drops an old generation's pending challenge and keeps checking the new binding", async () => {
    vi.useFakeTimers();
    const previous = deferred<unknown>();
    state.session.live = { ...state.session.live!, connectionGeneration: "old-generation" };
    state.request
      .mockResolvedValueOnce(status())
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValue({ ...status(), hasBinding: true });
    const view = render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    state.session.live = {
      ...state.session.live!,
      connectionGeneration: "new-generation",
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    view.rerender(<ClaudeBridgePanel active />);
    await act(async () => {});
    expect(screen.getByText("等待终端重新连接")).toBeVisible();
    expect(screen.getByRole("button", { name: "重新生成连接码" })).toBeEnabled();
    await act(async () => previous.resolve(challenge));
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("等待终端重新连接")).toBeVisible();
    await act(async () => vi.advanceTimersByTime(2500));
    expect(state.request.mock.calls.map(([request]) => request.operation)).toEqual([
      "bridge-status",
      "bridge-challenge",
      "bridge-status",
      "bridge-status",
    ]);
  });

  it.each(["session", "permission", "uncertain", "generation", "inactive"] as const)(
    "does not copy a late resume command after the %s changes",
    async (change) => {
      const result = deferred<unknown>();
      state.resumeCommand.mockReturnValueOnce(result.promise);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      state.request.mockImplementation(async ({ sessionId }) => ({
        ...status(sessionId),
        hasBinding: true,
      }));
      const view = render(<ClaudeBridgePanel active />);
      fireEvent.click(await screen.findByRole("button", { name: "复制继续命令" }));
      expect(screen.getByRole("button", { name: "复制继续命令" })).toBeDisabled();
      if (change === "session")
        state.session = {
          ...state.session,
          selected: "other",
          current: { ...state.session.current!, id: "other" },
          live: { ...state.session.live!, sessionId: "other" },
        };
      else if (change === "permission")
        state.session = {
          ...state.session,
          access: {
            ...state.session.access!,
            device: { ...state.session.access!.device!, manage: false },
          },
        };
      else if (change === "uncertain") state.session = { ...state.session, notice: "uncertain" };
      else if (change === "generation")
        state.session = {
          ...state.session,
          live: { ...state.session.live!, connectionGeneration: "replacement-generation" },
        };
      view.rerender(<ClaudeBridgePanel active={change !== "inactive"} />);
      await act(async () => result.resolve({ available: true, command: "stale command" }));
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText(/· 已复制/)).not.toBeInTheDocument();
      expect(state.resumeCommand.mock.calls[0][1].aborted).toBe(true);
    },
  );

  it.each(["unavailable", "empty", "rejected", "clipboard"] as const)(
    "reports a resume command %s failure without copying unvalidated content",
    async (failure) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      if (failure === "unavailable")
        state.resumeCommand.mockResolvedValueOnce({ available: false, command: "unsafe command" });
      else if (failure === "empty")
        state.resumeCommand.mockResolvedValueOnce({ available: true, command: "  " });
      else if (failure === "rejected")
        state.resumeCommand.mockRejectedValueOnce(new Error("private diagnostic"));
      else writeText.mockRejectedValueOnce(new Error("clipboard denied"));
      state.request.mockResolvedValue({ ...status(), hasBinding: true });
      render(<ClaudeBridgePanel active />);
      fireEvent.click(await screen.findByRole("button", { name: "复制继续命令" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请手动选择并复制。");
      if (failure !== "clipboard") expect(writeText).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "复制继续命令" })).toBeEnabled();
      expect(screen.queryByText("private diagnostic")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["zh-CN", "未连接", "仅可查看"],
    ["zh-TW", "未連線", "僅可查看"],
    ["en-US", "Not connected", "View only"],
    ["ja-JP", "未接続", "閲覧のみ"],
  ] as const)(
    "labels an unconnected terminal accurately in %s",
    async (locale, label, oldLabel) => {
      state.session.locale = locale;
      render(<ClaudeBridgePanel active />);
      await screen.findByText("Install isolated plugin");
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByText(oldLabel)).not.toBeInTheDocument();
      expect(
        state.request.mock.calls.every(([request]) => request.operation === "bridge-status"),
      ).toBe(true);
    },
  );
  it("can revoke an offline follower binding without restarting its execution", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    const disconnect = screen.getByRole("button", { name: "清除连接…" });
    expect(disconnect).toBeEnabled();
    fireEvent.click(disconnect);
    fireEvent.click(await screen.findByRole("button", { name: "确认清除连接" }));
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("cannot revoke an unbound session or another session's follower", async () => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
    state.session.live = {
      ...state.session.live!,
      sessionId: "other",
      executionMode: "claude-follower",
      status: "idle",
    };
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
  });
  it("can revoke when status lookup fails and the pending outcome is unknown", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockImplementation(async ({ operation }) => {
      if (operation === "bridge-status") throw new Error("claude_session_unavailable");
      return { disconnected: true };
    });
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByRole("alert");
    state.session = {
      ...state.session,
      notice: "uncertain",
      busy: true,
      live: { ...state.session.live!, status: "outcome-unknown" },
    } as SessionController;
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "清除连接…" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认清除连接" }));
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
    expect(state.session.refresh).toHaveBeenCalledOnce();
  });
  it("keeps revocation available when the source is unavailable for a new connection", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? {
            ...status(sessionId),
            connected: true,
            supported: false,
            reason: "claude-bridge-session-unavailable",
          }
        : { disconnected: true },
    );
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认断开" }));
    await waitFor(() => expect(state.session.refresh).toHaveBeenCalled());
    expect(state.request).toHaveBeenCalledWith({ operation: "bridge-disconnect", sessionId: "s" });
  });
  it("only reads status when opened, and creates a challenge without adopting or sending", async () => {
    const view = render(<ClaudeBridgePanel active={false} />);
    expect(state.request).not.toHaveBeenCalled();
    view.rerender(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    expect(state.request.mock.calls.map(([request]) => request.operation)).toEqual([
      "bridge-status",
      "bridge-challenge",
    ]);
    expect(state.session.refresh).not.toHaveBeenCalled();
  });
  it("clears the revoked connection code after a successful disconnect", async () => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    view.rerender(<ClaudeBridgePanel active />);
    fireEvent.click(screen.getByRole("button", { name: "清除连接…" }));
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "确认清除连接" }));
    await waitFor(() => expect(state.session.refresh).toHaveBeenCalled());
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(state.request).toHaveBeenCalledWith({ operation: "bridge-disconnect", sessionId: "s" });
  });
  it("copies installation instructions, connection command and code with feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "复制安装命令" }));
    await screen.findByText("复制安装命令 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    fireEvent.click(screen.getByRole("button", { name: "复制连接命令" }));
    await screen.findByText("复制连接命令 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith(challenge.instructions);
    fireEvent.click(screen.getByText("更多复制选项"));
    fireEvent.click(screen.getByRole("button", { name: "复制连接码" }));
    await screen.findByText("复制连接码 · 已复制");
    expect(writeText).toHaveBeenLastCalledWith(challenge.challenge);
    expect(screen.getByText(/前有效 · 只在你自己的终端使用，不要发给别人/)).toBeVisible();
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "复制连接码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请手动选择并复制。");
  });
  it.each(["copied", "failed"])(
    "ignores a %s clipboard result from the previously selected session",
    async (result) => {
      let finish!: () => void;
      const writeText = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () => (result === "copied" ? resolve() : reject(new Error("copy failed")));
          }),
      );
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      const view = render(<ClaudeBridgePanel active />);
      await screen.findByText("Install isolated plugin");
      fireEvent.click(screen.getByRole("button", { name: "复制安装命令" }));
      state.session = {
        ...state.session,
        selected: "other",
        current: { ...state.session.current!, id: "other" },
        live: { ...state.session.live!, sessionId: "other" },
      };
      view.rerender(<ClaudeBridgePanel active />);
      await act(async () => finish());
      expect(screen.queryByText(/· 已复制/)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it.each(["copied", "failed"])(
    "does not let an older %s clipboard result replace the latest copy feedback",
    async (result) => {
      let finish!: () => void;
      const previous = new Promise<void>((resolve, reject) => {
        finish = () => (result === "copied" ? resolve() : reject(new Error("copy failed")));
      });
      const writeText = vi.fn().mockReturnValueOnce(previous).mockResolvedValueOnce(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      render(<ClaudeBridgePanel active />);
      await screen.findByText("Install isolated plugin");
      fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
      await screen.findByText(challenge.instructions, { selector: "code" });
      fireEvent.click(screen.getByText("更多复制选项"));
      fireEvent.click(screen.getByRole("button", { name: "复制连接码" }));
      fireEvent.click(screen.getByRole("button", { name: "复制连接命令" }));
      await screen.findByText("复制连接命令 · 已复制");
      await act(async () => finish());
      expect(screen.getByText("复制连接命令 · 已复制")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
  it("keeps a valid code through explicit status refresh, busy and uncertain transitions", async () => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(3));
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
    state.session = { ...state.session, busy: true, notice: "uncertain" };
    view.rerender(<ClaudeBridgePanel active />);
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
    state.session = { ...state.session, busy: false, notice: undefined };
    view.rerender(<ClaudeBridgePanel active />);
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(4));
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
  });
  it.each(
    ["connected", "connection-error", "expired", "rejected"].flatMap((outcome) =>
      ["before", "after"].map((order) => ({ outcome, order })),
    ),
  )(
    "ignores an old $outcome poll arriving $order a replacement code",
    async ({ outcome, order }) => {
      vi.useFakeTimers();
      const previous = deferred<unknown>();
      const replacement = deferred<unknown>();
      state.request
        .mockResolvedValueOnce(status())
        .mockResolvedValueOnce(challenge)
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(replacement.promise);
      render(<ClaudeBridgePanel active />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(2500));
      fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
      async function settlePrevious() {
        await act(async () => {
          if (outcome === "rejected") previous.reject(new Error("previous lookup failed"));
          else
            previous.resolve({
              ...status(),
              connected: outcome === "connected",
              connectionError:
                outcome === "connection-error"
                  ? "bridge-version-mismatch"
                  : outcome === "expired"
                    ? "expired-bridge-challenge"
                    : undefined,
            });
        });
      }
      if (order === "before") {
        await settlePrevious();
        expect(screen.getByText("正在检查连接…")).toBeVisible();
        expect(screen.getByRole("button", { name: "生成连接码" })).toBeDisabled();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      }
      await act(async () =>
        replacement.resolve({
          ...challenge,
          challenge: "replacement-code",
          instructions: "/agentkib:connect replacement-code",
        }),
      );
      if (order === "after") await settlePrevious();
      expect(
        screen.getByText("/agentkib:connect replacement-code", { selector: "code" }),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(state.session.refresh).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(2500));
      expect(state.request).toHaveBeenLastCalledWith({
        operation: "bridge-status",
        sessionId: "s",
      });
      expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled();
    },
  );
  it("continues polling while an invalidated lookup is unresolved and preserves the newer result", async () => {
    vi.useFakeTimers();
    const previous = deferred<unknown>();
    const latest = deferred<unknown>();
    state.request
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(challenge)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce({
        ...challenge,
        challenge: "replacement-code",
        instructions: "/agentkib:connect replacement-code",
      })
      .mockReturnValueOnce(latest.promise);
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(2500));
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTime(2500));
    expect(state.request).toHaveBeenCalledTimes(5);
    await act(async () => previous.resolve({ ...status(), connected: true }));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(state.request).toHaveBeenCalledTimes(5);
    expect(
      screen.getByText("/agentkib:connect replacement-code", { selector: "code" }),
    ).toBeVisible();
    expect(state.session.refresh).not.toHaveBeenCalled();
    await act(async () =>
      latest.resolve({ ...status(), connectionError: "bridge-identity-mismatch" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("目标终端与所选会话不匹配");
    await act(async () => vi.advanceTimersByTime(2500));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByText("/agentkib:connect replacement-code", { selector: "code" }),
    ).toBeVisible();
    state.request.mockResolvedValueOnce({ ...status(), connected: true });
    await act(async () => vi.advanceTimersByTime(2500));
    expect(
      screen.queryByText("/agentkib:connect replacement-code", { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(["connected", "connection-error", "rejected"])(
    "ignores an old %s poll while disconnecting",
    async (outcome) => {
      vi.useFakeTimers();
      const previous = deferred<unknown>();
      const disconnect = deferred<unknown>();
      state.session.live = {
        ...state.session.live!,
        executionMode: "claude-follower",
        status: "unsupported",
        reason: "claude-bridge-disconnected",
      };
      state.request
        .mockResolvedValueOnce(status())
        .mockReturnValueOnce(previous.promise)
        .mockReturnValueOnce(disconnect.promise);
      render(<ClaudeBridgePanel active />);
      await act(async () => {});
      await act(async () => vi.advanceTimersByTime(2500));
      fireEvent.click(screen.getByRole("button", { name: "清除连接…" }));
      fireEvent.click(screen.getByRole("button", { name: "确认清除连接" }));
      await act(async () => {
        if (outcome === "rejected") previous.reject(new Error("previous lookup failed"));
        else
          previous.resolve({
            ...status(),
            connected: outcome === "connected",
            connectionError: outcome === "connection-error" ? "bridge-version-mismatch" : undefined,
          });
      });
      expect(screen.queryByRole("alert", { hidden: true })).not.toBeInTheDocument();
      expect(state.session.refresh).not.toHaveBeenCalled();
      expect(screen.getByText("正在检查连接…")).toBeVisible();
      expect(screen.getByRole("button", { name: "确认清除连接" })).toBeDisabled();
      await act(async () => disconnect.resolve({ disconnected: true }));
      expect(screen.queryByRole("group", { name: "清除连接…" })).not.toBeInTheDocument();
      expect(screen.queryByText("正在检查连接…")).not.toBeInTheDocument();
      expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it("retains the code but disables a new challenge after a failed status refresh", async () => {
    render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    state.request.mockRejectedValueOnce(new Error("status unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByRole("alert");
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });
  it.each([
    ["platform-unsupported", "连接终端目前只支持 macOS"],
    [
      "claude-bridge-unavailable",
      "终端连接服务无法启动。请检查这台电脑日志并重新启动 AgentKib 后重试。",
    ],
  ])("explains %s and the required CLI version", async (reason, explanation) => {
    state.request.mockResolvedValue({ ...status(), supported: false, reason });
    render(<ClaudeBridgePanel active />);
    expect(await screen.findByText(explanation)).toBeVisible();
    if (reason === "platform-unsupported") {
      expect(
        screen.queryByText("仅 macOS · 需要 Claude Code 2.1.301 或更高版本"),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "重新生成" })).not.toBeInTheDocument();
    } else {
      expect(screen.getByText("仅 macOS · 需要 Claude Code 2.1.301 或更高版本")).toBeVisible();
      expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    }
    expect(screen.queryByRole("button", { name: "清除连接…" })).not.toBeInTheDocument();
  });
  it("polls connection failures after code expiry and clears the code only on a confirmed connection", async () => {
    vi.useFakeTimers();
    let result = { ...status(), connectionError: undefined as string | undefined };
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status"
        ? result
        : { ...challenge, expiresAt: new Date(Date.now() + 1000).toISOString() },
    );
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await act(async () => {});
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
    result = { ...result, connectionError: "bridge-version-mismatch" };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "终端里的连接插件需要更新。按第 1 步重新安装后，重新生成连接码。",
    );
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
    result = { ...result, connectionError: "expired-bridge-challenge" };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(screen.getByText("连接码已过期")).toBeVisible();
    expect(screen.getByText("重新生成后，把新的连接命令粘贴到终端。")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    result = { ...result, connected: true, connectionError: undefined };
    await act(async () => vi.advanceTimersByTime(2500));
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("requires disconnecting an existing terminal before a fresh code can be generated", async () => {
    vi.useFakeTimers();
    state.request.mockResolvedValue({ ...status(), connected: true });
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "生成连接码" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重新生成" })).not.toBeInTheDocument();
    expect(screen.getByText("已连接终端")).toBeVisible();
    await act(async () => vi.advanceTimersByTime(2500));
    expect(
      state.request.mock.calls.every(([request]) => request.operation === "bridge-status"),
    ).toBe(true);
    expect(state.session.refresh).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("button", { name: "断开" })).toBeEnabled();
  });
  it("does not display a late challenge for a different session", async () => {
    let resolve!: (value: unknown) => void;
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? status(sessionId)
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    state.session = {
      ...state.session,
      selected: "other",
      current: { ...state.session.current!, id: "other" },
    };
    view.rerender(<ClaudeBridgePanel active />);
    await act(async () => resolve(challenge));
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
  });
  it("removes the connection code when its finite expiry is reached", async () => {
    vi.useFakeTimers();
    state.request.mockImplementation(async ({ operation, sessionId }) =>
      operation === "bridge-status"
        ? status(sessionId)
        : {
            ...challenge,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          },
    );
    render(<ClaudeBridgePanel active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await act(async () => {});
    expect(screen.getByText(challenge.instructions, { selector: "code" })).toBeVisible();
    act(() => vi.advanceTimersByTime(120_000));
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("连接码已过期")).toBeVisible();
  });
  it.each(["offline", "revoked"])("clears a challenge when %s", async (reason) => {
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    fireEvent.click(screen.getByRole("button", { name: "生成连接码" }));
    await screen.findByText(challenge.instructions, { selector: "code" });
    state.session = {
      ...state.session,
      ...(reason === "offline"
        ? { online: false }
        : reason === "revoked"
          ? {
              access: {
                ...state.session.access!,
                device: { ...state.session.access!.device!, manage: false },
              },
            }
          : { notice: "uncertain" }),
    };
    view.rerender(<ClaudeBridgePanel active />);
    expect(
      screen.queryByText(challenge.instructions, { selector: "code" }),
    ).not.toBeInTheDocument();
    expect(
      state.request.mock.calls.some(([request]) => request.operation === "bridge-disconnect"),
    ).toBe(false);
  });
  it("disables pairing for an unsupported CLI and rejects mismatched status identities", async () => {
    state.request.mockResolvedValue({ ...status(), supported: false });
    const view = render(<ClaudeBridgePanel active />);
    await screen.findByText("Install isolated plugin");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    state.request.mockResolvedValue(status("wrong"));
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    view.unmount();
  });
});
