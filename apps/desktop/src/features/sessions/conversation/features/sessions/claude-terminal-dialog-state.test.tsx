// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { SessionController } from "./use-session-controller";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { claudeConnectionCopy } from "./claude-connection-copy";

const state = vi.hoisted(() => ({ session: {} as SessionController, request: vi.fn() }));
vi.mock("./session-context", () => ({ useSession: () => state.session }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request: state.request } }) }));

const copy = claudeConnectionCopy["zh-CN"];
const command = "/agentkib:connect synthetic-test-code";
let connected = false;
function blockManagement(gate: "busy" | "controlReady" | "experimental") {
  state.session = {
    ...state.session,
    ...(gate === "busy"
      ? { busy: true }
      : gate === "controlReady"
        ? { controlReady: false }
        : { access: { ...state.session.access!, experimentalEnabled: false } }),
  };
}
function operations() {
  return state.request.mock.calls.map(([request]) => request.operation);
}
beforeAll(() => initializeI18n("zh-CN"));
beforeEach(() => {
  connected = false;
  state.session = {
    selected: "s",
    current: { id: "s", title: "合成连接状态测试", agent: "claude-code" },
    locale: "zh-CN",
    t: { close: "关闭" },
    access: {
      status: "approved",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { manage: true },
    },
    online: true,
    controlReady: true,
    busy: false,
    live: { sessionId: "s", status: "idle", executionMode: "claude-managed" },
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionController;
  state.request.mockReset().mockImplementation(async ({ operation }) =>
    operation === "bridge-status"
      ? {
          sessionId: "s",
          supported: true,
          connected,
          version: "2.1.301",
          pluginDirectory: "/synthetic/plugin",
          installInstructions: "Install synthetic plugin",
        }
      : operation === "bridge-challenge"
        ? {
            challenge: "synthetic-test-code",
            instructions: command,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
          }
        : { disconnected: true },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("terminal connection evidence and management gates", () => {
  it.each(["busy", "controlReady", "experimental"] as const)(
    "invalidates a confirmed connection when its generation disconnects while %s blocks checks",
    async (gate) => {
      vi.useFakeTimers();
      connected = true;
      state.session.live = {
        ...state.session.live!,
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
      };
      const view = render(<ClaudeBridgePanel active onClose={vi.fn()} />);
      await act(async () => {});
      expect(screen.getByText(copy.connectedTitle)).toBeVisible();
      blockManagement(gate);
      state.session.live = {
        ...state.session.live!,
        connectionGeneration: "runtime-boot",
        status: "unsupported",
        reason: "claude-bridge-disconnected",
      };
      view.rerender(<ClaudeBridgePanel active onClose={vi.fn()} />);
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
      expect(screen.getByText(copy.notConnected, { exact: true })).toBeVisible();
      expect(screen.getByText(copy.lostTitle)).toBeVisible();
      expect(screen.queryByRole("button", { name: copy.disconnectShort })).toBeNull();
      expect(screen.getByRole("button", { name: copy.clearConnection })).toBeEnabled();
      expect(screen.getByRole("button", { name: copy.regenerate })).toBeDisabled();
      expect(operations()).toEqual(["bridge-status"]);
    },
  );

  it("does not let a same-generation cached check override explicit live disconnection", async () => {
    connected = true;
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      connectionGeneration: "lease-a",
    };
    const view = render(<ClaudeBridgePanel active onClose={vi.fn()} />);
    await screen.findByText(copy.connectedTitle);
    blockManagement("busy");
    state.session.live = {
      ...state.session.live!,
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    view.rerender(<ClaudeBridgePanel active onClose={vi.fn()} />);
    expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
    expect(screen.getByText(copy.lostTitle)).toBeVisible();
    expect(screen.getByRole("button", { name: copy.clearConnection })).toBeEnabled();
    expect(operations()).toEqual(["bridge-status"]);
  });

  it("waits for a new generation's own check before confirming its connection", async () => {
    connected = true;
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      connectionGeneration: "lease-a",
    };
    const view = render(<ClaudeBridgePanel active onClose={vi.fn()} />);
    await screen.findByText(copy.connectedTitle);
    let resolve!: (value: unknown) => void;
    state.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    state.session.live = { ...state.session.live!, connectionGeneration: "lease-b" };
    view.rerender(<ClaudeBridgePanel active onClose={vi.fn()} />);
    expect(screen.queryByText(copy.connectedTitle)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(copy.statusUnavailable);
    expect(screen.getByRole("button", { name: copy.regenerate })).toBeDisabled();
    await act(async () =>
      resolve({
        sessionId: "s",
        supported: true,
        connected: true,
        version: "2.1.301",
        pluginDirectory: "/synthetic/plugin",
        installInstructions: "Install synthetic plugin",
      }),
    );
    expect(screen.getByText(copy.connectedTitle)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(operations()).toEqual(["bridge-status", "bridge-status"]);
  });
  it("does not call an existing binding disconnected before the first status read completes", async () => {
    let resolve!: (value: unknown) => void;
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<ClaudeBridgePanel active onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: copy.title });
    expect(within(dialog).queryByText(copy.lostTitle)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.connectedTitle)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.statusUnavailable);
    expect(operations()).toEqual(["bridge-status"]);
    await act(async () =>
      resolve({
        sessionId: "s",
        supported: true,
        connected: true,
        version: "2.1.301",
        pluginDirectory: "/synthetic/plugin",
        installInstructions: "Install synthetic plugin",
      }),
    );
    expect(within(dialog).getByText(copy.connectedTitle)).toBeVisible();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(operations()).toEqual(["bridge-status"]);
  });
  it.each(["busy", "controlReady", "experimental"] as const)(
    "does not infer a lost connection when first opened with the %s gate active",
    async (gate) => {
      state.session.live = {
        ...state.session.live!,
        executionMode: "claude-follower",
        connectionGeneration: "existing-unverified-binding",
      };
      blockManagement(gate);
      render(<ClaudeBridgePanel active onClose={vi.fn()} />);
      const dialog = screen.getByRole("dialog", { name: copy.title });
      expect(within(dialog).queryByText(copy.lostTitle)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.connectedTitle)).not.toBeInTheDocument();
      expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.statusUnavailable);
      expect(within(dialog).getByText(copy.notConnected, { exact: true })).toBeVisible();
      expect(within(dialog).getByRole("button", { name: copy.regenerate })).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: copy.refresh })).toBeDisabled();
      expect(operations()).toEqual([]);
      fireEvent.click(within(dialog).getByRole("button", { name: copy.clearConnection }));
      const confirmation = await screen.findByRole("group", { name: copy.clearConnection });
      expect(within(confirmation).getByText(copy.clearConnectionInfo)).toBeVisible();
      expect(operations()).toEqual([]);
      fireEvent.click(
        within(confirmation).getByRole("button", { name: copy.confirmClearConnection }),
      );
      await waitFor(() => expect(operations()).toEqual(["bridge-disconnect"]));
    },
  );

  it("replaces an issued command when a poll expires it before its local deadline", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    state.request.mockReset().mockImplementation(async ({ operation }) =>
      operation === "bridge-status"
        ? {
            sessionId: "s",
            supported: true,
            connected: false,
            version: "2.1.301",
            pluginDirectory: "/synthetic/plugin",
            installInstructions: "Install synthetic plugin",
          }
        : {
            challenge: "synthetic-test-code",
            instructions: command,
            expiresAt,
          },
    );
    render(<ClaudeBridgePanel active onClose={vi.fn()} />);
    await act(async () => {});
    const dialog = screen.getByRole("dialog", { name: copy.title });
    fireEvent.click(within(dialog).getByRole("button", { name: copy.generate }));
    await act(async () => {});
    expect(within(dialog).getByText(command)).toBeVisible();
    expect(within(dialog).getByText(copy.waiting, { exact: true })).toBeVisible();
    state.request.mockResolvedValueOnce({
      sessionId: "s",
      supported: true,
      connected: false,
      version: "2.1.301",
      pluginDirectory: "/synthetic/plugin",
      installInstructions: "Install synthetic plugin",
      connectionError: "expired-bridge-challenge",
    });
    await act(async () => vi.advanceTimersByTime(2500));
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(operations()).toEqual(["bridge-status", "bridge-challenge", "bridge-status"]);
    expect(within(dialog).getByText(copy.expiredTitle, { exact: true })).toBeVisible();
    expect(within(dialog).getByText(copy.expiredInfo)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: copy.regenerate })).toBeEnabled();
    expect(within(dialog).queryByText(command)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.waiting, { exact: true })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.pasteStep)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: copy.copyCommand })).toBeNull();
    state.request.mockRejectedValueOnce(new Error("synthetic status unavailable"));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.failed);
    expect(within(dialog).queryByText(command)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: copy.copyCommand })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: copy.copyCode })).toBeNull();
    // A later successful check cannot make the invalidated command valid again.
    await act(async () => vi.advanceTimersByTime(2500));
    expect(within(dialog).getByText(copy.expiredTitle, { exact: true })).toBeVisible();
    expect(within(dialog).queryByText(command)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.regenerate }));
    await act(async () => {});
    expect(within(dialog).getByText(command)).toBeVisible();
    expect(within(dialog).getByText(copy.waiting, { exact: true })).toBeVisible();
    expect(operations().filter((operation) => operation === "bridge-challenge")).toHaveLength(2);
  });

  it.each(["local-expiry", "expired-poll", "failed-poll", "connected-poll"] as const)(
    "keeps the clear confirmation focused when %s replaces its command",
    async (transition) => {
      vi.useFakeTimers();
      state.session.live = {
        ...state.session.live!,
        executionMode: "claude-follower",
        status: "unsupported",
        reason: "claude-bridge-disconnected",
      };
      render(<ClaudeBridgePanel active onClose={vi.fn()} />);
      await act(async () => {});
      const dialog = screen.getByRole("dialog", { name: copy.title });
      fireEvent.click(within(dialog).getByRole("button", { name: copy.regenerate }));
      await act(async () => {});
      expect(within(dialog).getByText(command)).toBeVisible();
      fireEvent.click(within(dialog).getByRole("button", { name: copy.clearConnection }));
      const initial = within(dialog).getByRole("group", { name: copy.clearConnection });
      expect(within(initial).getByRole("button", { name: copy.cancel })).toHaveFocus();

      if (transition === "failed-poll")
        state.request.mockRejectedValueOnce(new Error("synthetic status unavailable"));
      else if (transition !== "local-expiry")
        state.request.mockResolvedValueOnce({
          sessionId: "s",
          supported: true,
          connected: transition === "connected-poll",
          version: "2.1.301",
          pluginDirectory: "/synthetic/plugin",
          installInstructions: "Install synthetic plugin",
          connectionError: transition === "expired-poll" ? "expired-bridge-challenge" : undefined,
        });
      await act(async () => vi.advanceTimersByTime(transition === "local-expiry" ? 120_000 : 2500));

      const confirmation = within(dialog).getByRole("group", { name: copy.clearConnection });
      expect(confirmation).toBeVisible();
      const cancel = within(confirmation).getByRole("button", { name: copy.cancel });
      expect(cancel).toHaveFocus();
      expect(operations()).not.toContain("bridge-disconnect");
      fireEvent.keyDown(cancel, { key: "Escape" });
      expect(within(dialog).queryByRole("group", { name: copy.clearConnection })).toBeNull();
      expect(within(dialog).getByRole("button", { name: copy.clearConnection })).toHaveFocus();
    },
  );

  it("refocuses cancel after a pending clear moves the confirmation and fails", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    render(<ClaudeBridgePanel active onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: copy.title });
    const regenerate = within(dialog).getByRole("button", { name: copy.regenerate });
    await waitFor(() => expect(regenerate).toBeEnabled());
    fireEvent.click(regenerate);
    await within(dialog).findByText(command);
    fireEvent.click(within(dialog).getByRole("button", { name: copy.clearConnection }));
    let resolve!: (value: unknown) => void;
    state.request.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    fireEvent.click(within(dialog).getByRole("button", { name: copy.confirmClearConnection }));
    const confirmation = within(dialog).getByRole("group", { name: copy.clearConnection });
    const cancel = within(confirmation).getByRole("button", { name: copy.cancel });
    expect(cancel).toBeDisabled();
    expect(within(dialog).queryByText(command)).not.toBeInTheDocument();
    await act(async () => resolve({ disconnected: false }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.failed);
    expect(cancel).toBeEnabled();
    expect(cancel).toHaveFocus();
    expect(operations().filter((operation) => operation === "bridge-disconnect")).toHaveLength(1);
    fireEvent.click(cancel);
    expect(within(dialog).getByRole("button", { name: copy.clearConnection })).toHaveFocus();
  });

  it.each(["busy", "controlReady", "experimental"] as const)(
    "keeps a confirmed connection while %s blocks new connections",
    async (gate) => {
      connected = true;
      state.session.live = {
        ...state.session.live!,
        executionMode: "claude-follower",
        connectionGeneration: "confirmed-connection",
      };
      const view = render(<ClaudeBridgePanel active onClose={vi.fn()} />);
      const dialog = await screen.findByRole("dialog", { name: copy.title });
      await within(dialog).findByText(copy.connectedTitle);
      blockManagement(gate);
      view.rerender(<ClaudeBridgePanel active onClose={vi.fn()} />);
      expect(within(dialog).getByText(copy.connectedBadge, { exact: true })).toBeVisible();
      expect(within(dialog).getByText(copy.connectedTitle)).toBeVisible();
      expect(within(dialog).queryByText(copy.lostTitle)).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: copy.clearConnection })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: copy.generate })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: copy.refresh })).toBeNull();
      const disconnect = within(dialog).getByRole("button", { name: copy.disconnectShort });
      expect(disconnect).toBeEnabled();
      fireEvent.click(disconnect);
      const confirmation = await screen.findByRole("group", { name: copy.disconnect });
      expect(operations()).toEqual(["bridge-status"]);
      fireEvent.click(within(confirmation).getByRole("button", { name: copy.confirmDisconnect }));
      await waitFor(() => expect(operations()).toContain("bridge-disconnect"));
      expect(operations()).not.toContain("bridge-challenge");
    },
  );

  it.each(["busy", "controlReady", "experimental"] as const)(
    "keeps an issued code and blocks generation and checks while gated by %s",
    async (gate) => {
      const view = render(<ClaudeBridgePanel active onClose={vi.fn()} />);
      const dialog = await screen.findByRole("dialog", { name: copy.title });
      const generate = within(dialog).getByRole("button", { name: copy.generate });
      await waitFor(() => expect(generate).toBeEnabled());
      fireEvent.click(generate);
      await within(dialog).findByText(command);
      blockManagement(gate);
      view.rerender(<ClaudeBridgePanel active onClose={vi.fn()} />);
      expect(within(dialog).getByText(command)).toBeVisible();
      const regenerate = within(dialog).getByRole("button", { name: copy.regenerate });
      const check = within(dialog).getByRole("button", { name: copy.refresh });
      expect(regenerate).toBeDisabled();
      expect(check).toBeDisabled();
      fireEvent.click(regenerate);
      fireEvent.click(check);
      expect(operations()).toEqual(["bridge-status", "bridge-challenge"]);
      expect(within(dialog).queryByRole("button", { name: copy.disconnectShort })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: copy.clearConnection })).toBeNull();
    },
  );
});
