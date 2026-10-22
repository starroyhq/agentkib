// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController } from "./use-session-controller";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { claudeConnectionCopy } from "./claude-connection-copy";

const state = vi.hoisted(() => ({ session: {} as SessionController, request: vi.fn() }));
vi.mock("./session-context", () => ({ useSession: () => state.session }));
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request: state.request } }) }));

type Locale = keyof typeof claudeConnectionCopy;
const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
const installCommand = "claude plugin install /isolated/agentkib-plugin";
// Real codes contain an encoded payload. Do not accidentally test only a short preview code.
const connectionCode = "synthetic_connection_payload_".repeat(12);
const connectionCommand = `/agentkib:connect ${connectionCode}`;
const close = vi.fn();
const clipboard = vi.fn().mockResolvedValue(undefined);

function bridgeStatus(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    connected: false,
    sessionId: "s",
    version: "2.1.301",
    pluginDirectory: "/isolated/plugin",
    installInstructions: installCommand,
    ...overrides,
  };
}
function challenge(expiresAt = new Date(Date.now() + 120_000).toISOString()) {
  return { challenge: connectionCode, instructions: connectionCommand, expiresAt };
}
function operations() {
  return state.request.mock.calls.map(([request]) => request.operation);
}
async function openDialog(locale: Locale = "zh-CN") {
  state.session.locale = locale;
  const view = render(<ClaudeBridgePanel active onClose={close} />);
  const dialog = await screen.findByRole("dialog", { name: claudeConnectionCopy[locale].title });
  await within(dialog).findByText(installCommand);
  return { ...view, dialog, copy: claudeConnectionCopy[locale] };
}

beforeEach(() => {
  state.request.mockReset();
  close.mockClear();
  clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  state.session = {
    selected: "s",
    current: { id: "s", title: "合成测试会话", agent: "claude-code" },
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
    live: { sessionId: "s", status: "idle", executionMode: "managed-resume" },
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionController;
  state.request.mockImplementation(async ({ operation }) =>
    operation === "bridge-status"
      ? bridgeStatus()
      : operation === "bridge-challenge"
        ? challenge()
        : { disconnected: true },
  );
});
afterEach(() => cleanup());

describe("Claude terminal connection dialog", () => {
  it.each(locales)(
    "renders a single real dialog header and three-step flow in %s",
    async (locale) => {
      const { dialog, copy } = await openDialog(locale);
      expect(within(dialog).getAllByRole("heading", { name: copy.title })).toHaveLength(1);
      expect(dialog).toHaveAccessibleDescription("合成测试会话 · Claude Code");
      expect(within(dialog).getByText(copy.notConnected, { exact: true })).toBeVisible();
      expect(within(dialog).getByText(copy.flow)).toBeVisible();
      expect(
        within(dialog).getByText(copy.platformVersion.replace("{version}", "2.1.301")),
      ).toBeVisible();
      expect(within(dialog).getByText(copy.installStep)).toBeVisible();
      expect(within(dialog).getByRole("heading", { name: copy.generateStep })).toBeVisible();
      expect(within(dialog).getByText(copy.pasteStep)).toBeVisible();
      expect(within(dialog).getByText(copy.pasteHint)).toBeVisible();
      const generate = within(dialog).getByRole("button", { name: copy.generate });
      expect(generate).toBeEnabled();
      expect(generate).toHaveClass("bg-primary");
      expect(dialog.querySelectorAll("button.bg-primary")).toHaveLength(1);
      expect(
        within(dialog).queryByRole("button", { name: copy.disconnectShort }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole("button", { name: copy.clearConnection }),
      ).not.toBeInTheDocument();
      expect(new Set(operations())).toEqual(new Set(["bridge-status"]));
    },
  );

  it.each(locales)("shows an unverified version as neutral text in %s", async (locale) => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockResolvedValue(
      bridgeStatus({
        connected: true,
        bridgeCompatibility: { cliVersion: "2.1.307", status: "unverified" },
      }),
    );
    const { dialog, copy } = await openDialog(locale);
    const note = within(dialog).getByText(copy.unverifiedVersion.replace("{version}", "2.1.307"));
    expect(note).toHaveClass("text-muted-foreground");
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(within(dialog).getByText(copy.connectedTitle)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: copy.generate })).toBeNull();
    expect(operations()).not.toContain("send");
  });

  it("accepts explicit cleared compatibility metadata without reviving an old version note", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockResolvedValue(bridgeStatus({ connected: true, bridgeCompatibility: null }));
    const { dialog, copy } = await openDialog();
    expect(within(dialog).getByText(copy.connectedTitle)).toBeVisible();
    expect(dialog.querySelector("[data-terminal-compatibility]")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it.each(locales)(
    "explains incompatible versions and hides the old command in %s",
    async (locale) => {
      let result = bridgeStatus();
      state.request.mockImplementation(async ({ operation }) =>
        operation === "bridge-status" ? result : challenge(),
      );
      const { dialog, copy } = await openDialog(locale);
      fireEvent.click(within(dialog).getByRole("button", { name: copy.generate }));
      await within(dialog).findByText(connectionCommand);
      for (const [reason, expected] of [
        [
          "bridge-cli-too-old",
          copy.cliTooOld.replace("{version}", "2.1.300").replace("{minimum}", "2.1.301"),
        ],
        ["bridge-plugin-update-required", copy.pluginOutdated],
        ["bridge-capabilities-missing", copy.missingCapabilities.replace("{version}", "2.1.307")],
        ["bridge-cli-unsupported", copy.cliUnsupported],
      ]) {
        result = bridgeStatus({
          connectionError: reason,
          connectionCliVersion: reason === "bridge-cli-too-old" ? "2.1.300" : "2.1.307",
        });
        fireEvent.click(within(dialog).getByRole("button", { name: copy.refresh }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent(expected);
        expect(within(dialog).queryByText(connectionCommand)).toBeNull();
        expect(within(dialog).queryByRole("button", { name: copy.copyCommand })).toBeNull();
      }
      state.request.mockRejectedValueOnce(new Error("status unavailable"));
      fireEvent.click(within(dialog).getByRole("button", { name: copy.refresh }));
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.failed));
      expect(within(dialog).queryByText(connectionCommand)).toBeNull();
    },
  );

  it("copies the complete commands and checks status without clearing a generated code", async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status" ? bridgeStatus() : challenge(expiresAt),
    );
    const { dialog, copy } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.copyInstall }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(installCommand));
    fireEvent.click(within(dialog).getByRole("button", { name: copy.generate }));
    await within(dialog).findByText(connectionCommand);
    expect(within(dialog).queryByRole("button", { name: copy.generate })).not.toBeInTheDocument();
    expect(dialog.querySelectorAll("button.bg-primary")).toHaveLength(0);
    expect(within(dialog).getByText(copy.waiting, { exact: true })).toBeVisible();
    expect(within(dialog).queryByText(copy.pasteHint)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(
        copy.expiresAt.replace("{time}", new Date(expiresAt).toLocaleTimeString("zh-CN")),
      ),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.copyCommand }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(connectionCommand));
    const previousChecks = operations().filter((operation) => operation === "bridge-status").length;
    fireEvent.click(within(dialog).getByRole("button", { name: copy.refresh }));
    await waitFor(() =>
      expect(
        operations().filter((operation) => operation === "bridge-status").length,
      ).toBeGreaterThan(previousChecks),
    );
    expect(within(dialog).getByText(connectionCommand)).toBeVisible();
    expect(operations().filter((operation) => operation === "bridge-challenge")).toHaveLength(1);
    expect(operations()).not.toContain("bridge-disconnect");
  });

  it("confirms a connected terminal disconnection without stopping terminal execution", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status" ? bridgeStatus({ connected: true }) : { disconnected: true },
    );
    const { dialog, copy } = await openDialog();
    expect(within(dialog).getByText(copy.connectedBadge, { exact: true })).toBeVisible();
    expect(within(dialog).getByText(copy.connectedTitle)).toBeVisible();
    expect(within(dialog).getByText(copy.connectedInfo)).toBeVisible();
    expect(within(dialog).getByText(copy.disconnectInfo)).toBeVisible();
    expect(within(dialog).queryByText(copy.generateStep)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.pasteStep)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: copy.clearConnection }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.disconnectShort }));
    const confirmation = await screen.findByRole("dialog", { name: copy.disconnect });
    expect(operations()).not.toContain("bridge-disconnect");
    fireEvent.click(
      within(confirmation).getByText(copy.cancel, { selector: "button", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: copy.disconnect })).not.toBeInTheDocument(),
    );
    expect(operations()).not.toContain("bridge-disconnect");
    fireEvent.click(within(dialog).getByRole("button", { name: copy.disconnectShort }));
    const confirmed = await screen.findByRole("dialog", { name: copy.disconnect });
    fireEvent.click(within(confirmed).getByRole("button", { name: copy.confirmDisconnect }));
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
    expect(
      operations().every((operation) => ["bridge-status", "bridge-disconnect"].includes(operation)),
    ).toBe(true);
  });

  it("replaces an expired command with a single regeneration action", async () => {
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status"
        ? bridgeStatus()
        : challenge(new Date(Date.now() - 1000).toISOString()),
    );
    const { dialog, copy } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.generate }));
    await within(dialog).findByText(copy.expiredTitle, { exact: true });
    expect(within(dialog).getByText(copy.expiredInfo)).toBeVisible();
    expect(within(dialog).queryByText(connectionCommand)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.waiting, { exact: true })).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.pasteStep)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: copy.generate })).not.toBeInTheDocument();
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status" ? bridgeStatus() : challenge(),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: copy.regenerate }));
    await within(dialog).findByText(connectionCommand);
    expect(operations().filter((operation) => operation === "bridge-challenge")).toHaveLength(2);
  });

  it("does not resurrect a successfully revoked binding from the previous live snapshot", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      connectionGeneration: "previous-binding",
    };
    let connected = true;
    state.request.mockImplementation(async ({ operation }) => {
      if (operation === "bridge-status") return bridgeStatus({ connected });
      connected = false;
      return { disconnected: true };
    });
    const { dialog, copy } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.disconnectShort }));
    const confirmation = await screen.findByRole("dialog", { name: copy.disconnect });
    fireEvent.click(within(confirmation).getByRole("button", { name: copy.confirmDisconnect }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: copy.disconnect })).not.toBeInTheDocument(),
    );
    const regenerate = await within(dialog).findByRole("button", {
      name: copy.regenerate,
    });
    expect(regenerate).toBeEnabled();
    expect(within(dialog).getByText(copy.lostTitle, { exact: true })).toBeVisible();
    expect(within(dialog).getByText(copy.disconnectedInfo)).toBeVisible();
    expect(within(dialog).getByText(copy.notConnected, { exact: true })).toBeVisible();
    expect(
      within(dialog).queryByText(copy.connectedBadge, { exact: true }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText(copy.connectedTitle)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: copy.clearConnection }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: copy.disconnectShort }),
    ).not.toBeInTheDocument();
    expect(state.session.live?.executionMode).toBe("claude-follower");
    expect(operations().filter((operation) => operation === "bridge-disconnect")).toHaveLength(1);
  });

  it("does not call an uncertain terminal connected when every status check fails", async () => {
    state.session.live = { ...state.session.live!, executionMode: "claude-follower" };
    state.request.mockRejectedValue(new Error("isolated_status_unavailable"));
    render(<ClaudeBridgePanel active onClose={close} />);
    const copy = claudeConnectionCopy["zh-CN"];
    const dialog = await screen.findByRole("dialog", { name: copy.title });
    await within(dialog).findByRole("alert");
    for (let index = 0; index < 2; index++) {
      const previous = operations().length;
      fireEvent.click(within(dialog).getByRole("button", { name: copy.refresh }));
      await waitFor(() => expect(operations()).toHaveLength(previous + 1));
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: copy.refresh })).toBeEnabled(),
      );
      expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.failed);
      expect(within(dialog).getByText(copy.notConnected, { exact: true })).toBeVisible();
      expect(
        within(dialog).queryByText(copy.connectedBadge, { exact: true }),
      ).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.connectedTitle)).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole("button", { name: copy.disconnectShort }),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: copy.clearConnection })).toBeEnabled();
    }
    expect(new Set(operations())).toEqual(new Set(["bridge-status"]));
  });

  it("does not forget a binding when revocation is not acknowledged", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    state.request.mockImplementation(async ({ operation }) =>
      operation === "bridge-status" ? bridgeStatus() : { disconnected: false },
    );
    const { dialog, copy } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.clearConnection }));
    const confirmation = await screen.findByRole("dialog", { name: copy.clearConnection });
    const confirm = within(confirmation).getByRole("button", { name: copy.confirmClearConnection });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(
      within(confirmation).getByText(copy.cancel, { selector: "button", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: copy.clearConnection })).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(copy.failed);
    expect(within(dialog).getByRole("button", { name: copy.clearConnection })).toBeEnabled();
    expect(within(dialog).queryByRole("button", { name: copy.generate })).not.toBeInTheDocument();
    expect(state.session.refresh).not.toHaveBeenCalled();
    expect(operations()).not.toContain("bridge-challenge");
  });

  it("preserves explicit confirmed revocation for an offline binding", async () => {
    state.session.live = {
      ...state.session.live!,
      executionMode: "claude-follower",
      status: "unsupported",
      reason: "claude-bridge-disconnected",
    };
    const { dialog, copy } = await openDialog();
    expect(within(dialog).getByText(copy.lostTitle, { exact: true })).toBeVisible();
    expect(within(dialog).getByText(copy.disconnectedInfo)).toBeVisible();
    expect(within(dialog).queryByText(copy.pasteStep)).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: copy.disconnectShort }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: copy.clearConnection }));
    const confirmation = await screen.findByRole("dialog", { name: copy.clearConnection });
    expect(within(confirmation).getByText(copy.clearConnectionInfo)).toBeVisible();
    expect(operations()).not.toContain("bridge-disconnect");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: copy.confirmClearConnection }),
    );
    await waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({
        operation: "bridge-disconnect",
        sessionId: "s",
      }),
    );
  });

  it("shows only platform guidance without unusable connection steps", async () => {
    state.request.mockResolvedValue(
      bridgeStatus({ supported: false, reason: "platform-unsupported" }),
    );
    render(<ClaudeBridgePanel active onClose={close} />);
    const copy = claudeConnectionCopy["zh-CN"];
    const dialog = await screen.findByRole("dialog", { name: copy.title });
    await within(dialog).findByText(copy.unsupportedTitle);
    expect(within(dialog).getByText(copy.platformUnsupported)).toBeVisible();
    for (const text of [copy.installStep, copy.generateStep, copy.pasteStep, installCommand]) {
      expect(within(dialog).queryByText(text)).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByRole("button", { name: copy.generate })).not.toBeInTheDocument();
    expect(new Set(operations())).toEqual(new Set(["bridge-status"]));
  });

  it.each([
    ["bridge-version-mismatch", "versionMismatch"],
    ["invalid-bridge-challenge", "invalidCode"],
    ["bridge-identity-mismatch", "identityMismatch"],
    ["claude-bridge-binding-limit", "connectionLimit"],
  ] as const)(
    "replaces the code and paste steps with actionable %s guidance",
    async (reason, key) => {
      state.request.mockResolvedValue(bridgeStatus({ connectionError: reason }));
      const { dialog, copy } = await openDialog();
      expect(within(dialog).getByRole("alert")).toHaveTextContent(copy[key]);
      expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
      expect(within(dialog).queryByText(copy.generateStep)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.pasteStep)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.waiting, { exact: true })).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.connectedTitle)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(copy.expiredTitle)).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: copy.refresh })).toBeEnabled();
      expect(operations()).not.toContain("bridge-challenge");
    },
  );

  it("retains the complete long session title in the accessible description and closes from its header", async () => {
    const title = "仅含合成数据的超长会话标题".repeat(24);
    state.session.current = { ...state.session.current!, title };
    const { dialog } = await openDialog();
    expect(dialog).toHaveAccessibleDescription(`${title} · Claude Code`);
    expect(within(dialog).getByText(`${title} · Claude Code`, { exact: true })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(close).toHaveBeenCalledOnce();
    expect(new Set(operations())).toEqual(new Set(["bridge-status"]));
  });
});
