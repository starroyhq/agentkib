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
import { requestWebAdmin } from "./web-status";

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

/** Turns computer sharing on, which is when the computer name can be edited. */
function startSharing() {
  nativeStatus = {
    ...nativeStatus,
    local: { ...nativeStatus.local, enabled: true, address: "192.168.20.10:42987" },
  };
  useRemoteStore.setState({ snapshot: nativeStatus });
}

function configureCalls() {
  return nativeRequest.mock.calls.filter(([request]) => request.operation === "configure");
}

describe("remote settings integration", () => {
  it("saves a blurred computer name without opening advanced settings or configuring Web services", async () => {
    startSharing();
    nativeRequest.mockImplementation(async (input: RemoteRequest) => {
      if (input.operation === "configure") {
        nativeStatus = { ...nativeStatus, local: { ...nativeStatus.local, name: input.name } };
      } else if (input.operation !== "status") throw new Error("Unexpected native mutation");
      return nativeStatus;
    });
    render(<RemoteConnectionSettings />);
    await screen.findByRole("button", { name: "Connect phone" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "This device name" });
    fireEvent.change(input, { target: { value: "New example name" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByText("Name saved.")).toHaveAttribute("role", "status"));
    expect(configureCalls()).toEqual([
      [
        {
          operation: "configure",
          enabled: true,
          address: "192.168.20.10:42987",
          name: "New example name",
        },
      ],
    ]);
    expect(webRequest.mock.calls.every(([request]) => request.operation === "status")).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps shared settings locked until a name write finishes and does not submit it twice", async () => {
    startSharing();
    let finish!: (value: RemoteStatus) => void;
    nativeRequest.mockImplementation((input: RemoteRequest) => {
      if (input.operation === "configure")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (input.operation !== "status") throw new Error("Unexpected native mutation");
      return Promise.resolve(nativeStatus);
    });
    render(<RemoteConnectionSettings />);
    await screen.findByRole("button", { name: "Connect phone" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "This device name" });
    fireEvent.change(input, { target: { value: "New example name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect phone" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Advanced settings" });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("combobox", { name: "Shared LAN interface" })).toBeDisabled();
    expect(configureCalls()).toHaveLength(1);
    await act(async () => {
      nativeStatus = {
        ...nativeStatus,
        local: { ...nativeStatus.local, name: "New example name" },
      };
      finish(nativeStatus);
    });
    expect(screen.getByRole("button", { name: "Connect phone", hidden: true })).toBeEnabled();
    expect(within(dialog).getByRole("combobox", { name: "Shared LAN interface" })).toBeEnabled();
    expect(webRequest.mock.calls.every(([request]) => request.operation === "status")).toBe(true);
  });

  it("does not save a name while a Web write is pending, even through a stale blur handler", async () => {
    startSharing();
    render(<RemoteConnectionSettings />);
    await screen.findByRole("button", { name: "Connect phone" });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "This device name" });
    fireEvent.change(input, { target: { value: "New example name" } });
    let finish!: (value: WebAdminStatus) => void;
    webRequest.mockImplementation((request: WebAdminRequest) =>
      request.operation === "configure"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(request.target === "lan" ? lanStatus : localStatus),
    );
    let pending!: Promise<WebAdminStatus>;
    act(() => {
      pending = requestWebAdmin({ operation: "configure", ...localStatus.config });
    });
    expect(input).toBeDisabled();
    fireEvent.blur(input);
    expect(nativeRequest.mock.calls.every(([request]) => request.operation === "status")).toBe(
      true,
    );
    await act(async () => {
      finish(localStatus);
      await pending;
    });
    expect(input).toBeEnabled();
    expect(input).toHaveValue("New example name");
    expect(screen.queryByText("Name saved.")).toBeNull();
  });

  it("does not dispatch sharing or Web changes from clicks queued with a name blur", async () => {
    startSharing();
    let finish!: (value: RemoteStatus) => void;
    nativeRequest.mockImplementation((input: RemoteRequest) => {
      if (input.operation === "configure")
        return new Promise((resolve) => {
          finish = resolve;
        });
      if (input.operation !== "status") throw new Error("Unexpected native mutation");
      return Promise.resolve(nativeStatus);
    });
    render(<RemoteConnectionSettings />);
    await screen.findByRole("button", { name: "Connect phone" });
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Advanced settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^More settings/ }));
    fireEvent.change(await within(dialog).findByRole("spinbutton", { name: "Port" }), {
      target: { value: "1431" },
    });
    // The name editor and the share switch stay on the page behind the dialog.
    fireEvent.click(screen.getByRole("button", { name: "Rename", hidden: true }));
    const input = screen.getByRole("textbox", { name: "This device name", hidden: true });
    const save = within(dialog).getByRole("button", { name: "Save" });
    const share = screen.getByRole("switch", { name: "Share this computer", hidden: true });
    fireEvent.change(input, { target: { value: "New example name" } });
    act(() => {
      fireEvent.blur(input);
      fireEvent.click(save);
      fireEvent.click(share);
    });
    expect(configureCalls()).toEqual([
      [
        {
          operation: "configure",
          enabled: true,
          address: "192.168.20.10:42987",
          name: "New example name",
        },
      ],
    ]);
    expect(webRequest.mock.calls.every(([request]) => request.operation === "status")).toBe(true);
    await act(async () => {
      nativeStatus = {
        ...nativeStatus,
        local: { ...nativeStatus.local, name: "New example name" },
      };
      finish(nativeStatus);
    });
    expect(nativeStatus.local.enabled).toBe(true);
    expect(configureCalls()).toHaveLength(1);
    expect(within(dialog).getByRole("spinbutton", { name: "Port" })).toHaveValue(1431);
    expect(within(dialog).getByText("Unsaved changes")).toBeVisible();
  });

  it.each([
    ["zh-CN", "连接新手机", "连接手机", "重新生成", "完整控制"],
    ["zh-TW", "連接新手機", "連接手機", "重新產生", "完整控制"],
    ["en-US", "Connect a new phone", "Connect phone", "Regenerate", "Full control"],
    ["ja-JP", "新しいスマートフォンを接続", "スマートフォンを接続", "再生成", "フルコントロール"],
  ] as const)(
    "renders the access code step without a length qualifier in %s",
    async (locale, connect, title, regenerate, full) => {
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
      webRequest.mockImplementation(async (input: WebAdminRequest) => {
        if (input.operation === "generate-code") {
          localStatus = {
            ...localStatus,
            code: { value: "12345678", expiresAt: Date.now() + 300_000, access: "full" },
          };
          return localStatus;
        }
        if (input.operation !== "status") throw new Error("Unexpected Web mutation");
        return input.target === "lan" ? lanStatus : localStatus;
      });
      render(<RemoteConnectionSettings />);
      fireEvent.click(await screen.findByRole("button", { name: connect }));
      const dialog = await screen.findByRole("dialog", { name: title });
      expect(await within(dialog).findByRole("button", { name: regenerate })).toBeVisible();
      expect(within(dialog).getByRole("button", { name: full })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(dialog.textContent).not.toMatch(/八位|8\s*(?:位|桁)|8-digit/i);
      // The dialog asks for exactly one access code by itself and changes nothing else.
      const mutations = webRequest.mock.calls.filter(([input]) => input.operation !== "status");
      expect(mutations).toEqual([[{ operation: "generate-code", access: "full" }]]);
    },
  );

  it("shows both cards without tabs and keeps one shared save inside the advanced dialog", async () => {
    render(<RemoteConnectionSettings />);
    expect(await screen.findByRole("button", { name: "Connect phone" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Phone" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Other computers" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Phones" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Other computers" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Share this computer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add computer" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Find nearby computers" })).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "No connections with other computers yet" }),
    ).toBeNull();
    expect(
      screen.queryByText(/No computers found|No authorized devices|No remote computers/),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Advanced settings" });
    expect(within(dialog).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).queryByRole("button", { name: "Save settings" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /^More settings/ }));
    expect(
      await within(dialog).findByRole("checkbox", { name: "Enable local Web service" }),
    ).toBeVisible();
    expect(within(dialog).queryByRole("switch", { name: "Enable local Web service" })).toBeNull();
    expect(webRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    expect(accountRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    expect(nativeRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  });

  it("keeps one running plaintext warning across settings dialogs and the page", async () => {
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

    const manage = screen.getByRole("button", { name: "Manage" });
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

    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    const advanced = await screen.findByRole("dialog", { name: "Advanced settings" });
    expect(warning).toBeVisible();
    expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
    fireEvent.click(within(advanced).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(warning).toBeVisible();
    expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
    expect(webRequest.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  });

  it("reports an enabled but unavailable LAN service without calling it running", async () => {
    enableLan(false);
    render(<RemoteConnectionSettings />);
    expect(await screen.findByText("LAN access is enabled but unavailable")).toBeVisible();
    expect(screen.queryByText("LAN HTTP access is running")).toBeNull();
    expect(screen.queryByText(/capture the access token/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
    await screen.findByRole("dialog", { name: "Advanced settings" });
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
    await screen.findByRole("button", { name: "Connect phone" });
    expect(screen.getByRole("switch", { name: "Share this computer" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Computers that can view this one" })).toBeVisible();
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
