// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import type { RemoteRequest, RemoteStatus } from "@/core/remote-types";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import type { WebAdminRequest, WebAdminStatus } from "../../../electron/main/web/service";
import { RemoteConnectionSettings } from "./RemoteConnectionPanel";
import { useRemoteStore } from "./remote-store";

const webRequest = vi.fn();
const accountRequest = vi.fn();
const nativeRequest = vi.fn();
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    web: { request: webRequest },
    account: { request: accountRequest, onStatus: () => () => {} },
  }),
}));
vi.mock("@/core/api", () => ({
  api: { remoteRequest: (input: RemoteRequest) => nativeRequest(input) },
}));

const nativeBase: RemoteStatus = {
  local: { id: "example-computer", name: "Example computer", enabled: false, address: null },
  interfaces: [{ name: "Example network", address: "192.168.20.10" }],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const localBase: WebAdminStatus = {
  pairingMode: "code",
  config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
  running: false,
  localUrl: "http://127.0.0.1:1421",
  experimentalAvailable: false,
  pending: [],
  devices: [],
};
const lanBase: WebAdminStatus = {
  ...localBase,
  mode: "lan",
  pairingMode: "confirmation",
  config: {
    ...localBase.config,
    port: 1422,
    lanAddress: "192.168.20.10",
    allowPlaintext: false,
  },
  addresses: [{ name: "Example network", address: "192.168.20.10" }],
  localUrl: "http://192.168.20.10:1422",
};
const accountBase: DesktopAccountStatus = { phase: "signed-out", secureStorage: true };
const initialRemoteState = useRemoteStore.getState();
let nativeStatus: RemoteStatus;
let localStatus: WebAdminStatus;
let lanStatus: WebAdminStatus;

beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  await changeLocale("en-US");
  nativeStatus = structuredClone(nativeBase);
  localStatus = structuredClone(localBase);
  lanStatus = structuredClone(lanBase);
  webRequest.mockReset().mockImplementation(async (input: WebAdminRequest) => {
    if (input.operation !== "status")
      throw new Error("Unexpected Web mutation in integration fixture");
    return input.target === "lan" ? lanStatus : localStatus;
  });
  accountRequest.mockReset().mockResolvedValue(accountBase);
  nativeRequest.mockReset().mockImplementation(async (input: RemoteRequest) => {
    if (input.operation === "revoke") {
      nativeStatus = {
        ...nativeStatus,
        authorized: nativeStatus.authorized.filter((device) => device.id !== input.id),
      };
    } else if (input.operation !== "status") {
      throw new Error("Unexpected native mutation in integration fixture");
    }
    return nativeStatus;
  });
  useRemoteStore.setState({ ...initialRemoteState, snapshot: nativeStatus });
});
afterEach(cleanup);

function enableLan(running: boolean) {
  lanStatus = {
    ...lanStatus,
    running,
    config: { ...lanStatus.config, enabled: true, allowPlaintext: true },
  };
}

describe("remote settings integration", () => {
  it.each([
    ["zh-CN", "连接新手机", "生成授权码", "完整控制"],
    ["zh-TW", "連接新手機", "產生授權碼", "完整控制"],
    ["en-US", "Connect a new phone", "Generate access code", "Full control"],
    ["ja-JP", "新しいスマートフォンを接続", "認証コードを生成", "フルコントロール"],
  ] as const)(
    "renders the access code action without a length qualifier in %s",
    async (locale, connect, generate, full) => {
      await changeLocale(locale);
      localStatus = {
        ...localStatus,
        running: true,
        config: {
          ...localStatus.config,
          enabled: true,
          relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
        },
        relay: { phase: "ready", publicUrl: "https://computer.example.com" },
      };
      render(<RemoteConnectionSettings />);
      fireEvent.click(await screen.findByRole("button", { name: connect }));
      const dialog = await screen.findByRole("dialog", { name: connect });
      expect(within(dialog).getByRole("button", { name: generate })).toBeVisible();
      expect(within(dialog).getByRole("button", { name: full })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(dialog.textContent).not.toMatch(/八位|8\s*(?:位|桁)|8-digit/i);
      expect(webRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    },
  );

  it("defaults to phones and keeps one empty computer state with one shared advanced save", async () => {
    render(<RemoteConnectionSettings />);
    expect(await screen.findByRole("button", { name: "Sign in with your browser" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Phones" })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("heading", { name: "Access this computer from your phone" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Advanced settings" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
    expect(
      screen.getAllByRole("heading", { name: "No connections with other computers yet" }),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Find nearby computers" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Share this computer" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Share this computer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "View other computers" })).toBeNull();
    expect(
      screen.queryByText(/No computers found|No authorized devices|No remote computers/),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    expect(await screen.findByRole("button", { name: "Save settings" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Save settings" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Enable local Web service" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Enable local Web service" })).toBeNull();
    expect(webRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    expect(accountRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    expect(nativeRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  });

  it("keeps one running plaintext warning across settings dialogs and both tabs", async () => {
    enableLan(true);
    const user = userEvent.setup();
    render(<RemoteConnectionSettings />);
    expect(await screen.findByText("LAN HTTP access is running")).toBeVisible();
    const title = screen.getByText("LAN direct connection is not encrypted");
    const warning = title.closest("[class*='border-amber-500']");
    expect(warning).toBeVisible();
    expect(warning).toHaveClass("bg-amber-500/5", "text-amber-700");
    expect(warning).toHaveTextContent("capture the access token");
    expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);

    const manage = screen.getByRole("button", { name: "Set up LAN direct connection" });
    manage.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(
      within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" }),
    ).toBeVisible();
    expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(manage).toHaveFocus());
    expect(warning).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
    expect(warning).toBeVisible();
    expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Phones" }));
    expect(warning).toBeVisible();
    expect(webRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  });

  it("reports an enabled but unavailable LAN service without calling it running", async () => {
    enableLan(false);
    render(<RemoteConnectionSettings />);
    expect(await screen.findByText("LAN access is enabled but unavailable")).toBeVisible();
    expect(screen.queryByText("LAN HTTP access is running")).toBeNull();
    expect(screen.queryByText(/capture the access token/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
    expect(screen.queryByText("LAN HTTP access is running")).toBeNull();
  });

  it("keeps authorized computer management reachable and confirms revocation before sending it", async () => {
    nativeStatus = {
      ...nativeStatus,
      authorized: [
        {
          id: "example-laptop",
          name: "Example laptop",
          approved_at: 1_700_000_000,
          last_seen: null,
        },
      ],
    };
    useRemoteStore.setState({ snapshot: nativeStatus });
    render(<RemoteConnectionSettings />);
    await screen.findByRole("button", { name: "Sign in with your browser" });
    fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
    expect(
      screen.queryByRole("heading", { name: "No connections with other computers yet" }),
    ).toBeNull();
    expect(screen.getByRole("heading", { name: "Share this computer" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "View other computers" })).toBeVisible();
    expect(screen.getByText("Example laptop")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke access" });
    expect(dialog).toHaveTextContent("Active reads will stop and the device must pair again");
    expect(nativeRequest.mock.calls.some(([input]) => input.operation === "revoke")).toBe(false);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" })));
    await waitFor(() =>
      expect(nativeRequest).toHaveBeenCalledWith({ operation: "revoke", id: "example-laptop" }),
    );
    expect(useRemoteStore.getState().snapshot?.authorized).toEqual([]);
  });
});
