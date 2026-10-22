// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import { WebAccessSettings } from "./WebAccessSettings";
import { requestWebAdmin } from "./web-status";
import { remotePhoneCopy } from "./remote-phone-copy";
import { lanSettingsCopy } from "./lan-settings-copy";
import { remoteAccountCopy } from "./remote-account-copy";
import { remoteEntryCopy } from "./remote-entry-copy";
import { webSettingsCopy } from "./web-settings-copy";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import type { WebAdminStatus } from "../../../electron/main/web/service";

const request = vi.fn();
const accountRequest = vi.fn();
let accountListener: ((value: DesktopAccountStatus) => void) | undefined;
let account: DesktopAccountStatus;
let local: WebAdminStatus;
let lan: WebAdminStatus;
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    web: {
      request: (input: { target?: string }) =>
        input.target === "lan" ? Promise.resolve(lan) : request(input),
    },
    account: {
      request: (input: unknown) => accountRequest(input),
      onStatus: (listener: typeof accountListener) => {
        accountListener = listener;
        return () => {};
      },
    },
  }),
}));
const signedIn: DesktopAccountStatus = {
  phase: "signed-in",
  secureStorage: true,
  account: {
    id: "example",
    username: "demo@example.com",
    status: "active",
    deviceCount: 1,
    deviceLimit: 3,
    totpEnabled: false,
  },
  device: { deviceId: "example", ownership: "owned" },
};
const browser = {
  id: "phone",
  name: "iPhone · Safari",
  accessMode: "full" as const,
  accessLevel: "full" as const,
  send: true,
  approve: true,
  createdAt: 0,
};
function ready() {
  local = {
    ...local,
    running: true,
    pairingMode: "code",
    config: {
      ...local.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://computer.example.com" },
  };
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  await changeLocale("en-US");
  account = signedIn;
  local = {
    config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
    running: false,
    pairingMode: "code",
    experimentalAvailable: false,
    localUrl: "http://127.0.0.1:1421",
    pending: [],
    devices: [],
  };
  lan = {
    ...local,
    mode: "lan",
    config: { ...local.config, port: 1422, lanAddress: "192.168.50.10", allowPlaintext: false },
    addresses: [{ name: "Example LAN", address: "192.168.50.10" }],
  };
  request.mockReset().mockImplementation(async () => local);
  accountRequest.mockReset().mockImplementation(async () => account);
  accountListener = undefined;
});
afterEach(cleanup);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "shows only the current first-time step action in %s",
  async (locale) => {
    account = { phase: "signed-out", secureStorage: true };
    await changeLocale(locale);
    const view = render(<WebAccessSettings />);
    expect(
      await screen.findByRole("button", { name: remoteAccountCopy[locale].login }),
    ).toBeEnabled();
    expect(screen.getByRole("heading", { name: remotePhoneCopy[locale].introTitle })).toBeVisible();
    expect(screen.getByText(remotePhoneCopy[locale].loginHint)).toBeVisible();
    expect(screen.getByText(remotePhoneCopy[locale].connectHint)).toBeVisible();
    expect(screen.queryByRole("button", { name: remoteEntryCopy[locale].enable })).toBeNull();
    expect(
      screen.queryByRole("button", { name: webSettingsCopy[locale].generateAccess }),
    ).toBeNull();
    expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
    account = { phase: "signing-in", secureStorage: true };
    fireEvent.click(screen.getByRole("button", { name: remoteAccountCopy[locale].login }));
    expect(
      await screen.findByRole("button", { name: remoteAccountCopy[locale].cancel }),
    ).toBeVisible();
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    act(() => accountListener?.(signedIn));
    expect(
      await screen.findByRole("button", { name: remoteEntryCopy[locale].enable }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: webSettingsCopy[locale].generateAccess }),
    ).toBeNull();
  },
);

it("keeps the first connection at step three and generates the selected level with one primary action", async () => {
  render(<WebAccessSettings />);
  const enable = await screen.findByRole("button", { name: "Enable remote access" });
  ready();
  fireEvent.click(enable);
  expect(await screen.findByText(remotePhoneCopy["en-US"].readyResult)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect a new phone" })).toBeNull();
  expect(screen.getByRole("button", { name: "Full control" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Read-only" }));
  local = { ...local, code: { value: "48291736", access: "read", expiresAt: Date.now() + 60_000 } };
  fireEvent.click(screen.getByRole("button", { name: webSettingsCopy["en-US"].generateAccess }));
  expect(await screen.findByText("4829 1736")).toBeVisible();
  expect(screen.getByRole("img", { name: "Open on your phone" })).toBeVisible();
  expect(screen.getByText(remotePhoneCopy["en-US"].codeHint)).toBeVisible();
  expect(screen.getByText(/Access level: Read-only/)).toBeVisible();
  expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "read" });
  expect(screen.getByRole("button", { name: "Regenerate" })).toBeVisible();
  local = { ...local, devices: [browser] };
  fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
  expect(await screen.findByRole("heading", { name: "Authorized browsers 1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  local = { ...local, devices: [], relay: { phase: "offline", reason: "network" } };
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "Revoke this browser?" })).getByRole(
      "button",
      { name: "Confirm revocation" },
    ),
  );
  expect(await screen.findByRole("heading", { name: "Authorized browsers 0" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: remotePhoneCopy["en-US"].introTitle })).toBeNull();
});

it("manages existing browsers after pause and requires confirmation for pause and revocation", async () => {
  ready();
  local = { ...local, devices: [browser] };
  render(<WebAccessSettings />);
  expect(await screen.findByRole("heading", { name: "Authorized browsers 1" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: remotePhoneCopy["en-US"].introTitle })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  const pause = await screen.findByRole("dialog", { name: "Pause remote access?" });
  expect(within(pause).getByText(remotePhoneCopy["en-US"].pauseHint)).toBeVisible();
  expect(request).not.toHaveBeenCalledWith({ operation: "relay-stop" });
  await waitFor(() => expect(within(pause).getByRole("button", { name: "Cancel" })).toHaveFocus());
  local = {
    ...local,
    config: { ...local.config, relay: { ...local.config.relay!, enabled: false } },
    relay: { phase: "disabled" },
  };
  fireEvent.click(within(pause).getByRole("button", { name: "Confirm pause" }));
  expect(await screen.findByText("Remote access paused")).toBeVisible();
  expect(screen.getByRole("heading", { name: "Authorized browsers 1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  const revoke = await screen.findByRole("dialog", { name: "Revoke this browser?" });
  expect(request).not.toHaveBeenCalledWith({ operation: "revoke", id: "phone" });
  fireEvent.click(within(revoke).getByRole("button", { name: "Confirm revocation" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "phone" }));
});

it("opens step three for a new phone while account actions stay in account management", async () => {
  const user = userEvent.setup();
  ready();
  local = { ...local, devices: [browser] };
  render(<WebAccessSettings />);
  await user.click(await screen.findByRole("button", { name: "Connect a new phone" }));
  const dialog = screen.getByRole("dialog", { name: "Connect a new phone" });
  expect(within(dialog).getByRole("button", { name: "Full control" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    within(dialog).getByRole("button", { name: webSettingsCopy["en-US"].generateAccess }),
  ).toBeEnabled();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("button", { name: remoteAccountCopy["en-US"].logout })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Manage account" }));
  expect(
    within(screen.getByRole("dialog", { name: "Manage account" })).getByRole("button", {
      name: remoteAccountCopy["en-US"].logout,
    }),
  ).toBeVisible();
});

it.each([
  ["zh-CN", "手机暂时连不上"],
  ["zh-TW", "手機暫時無法連線"],
  ["en-US", "Your phone cannot connect for now"],
  ["ja-JP", "スマートフォンからは一時的に接続できません"],
] as const)(
  "requires sign-in before resuming a saved official pause in %s",
  async (locale, hint) => {
    await changeLocale(locale);
    account = { phase: "signed-out", secureStorage: true };
    local = {
      ...local,
      config: {
        ...local.config,
        relay: { enabled: false, brokerUrl: "https://api.agentkib.com" },
      },
      relay: { phase: "disabled" },
    };
    const view = render(<WebAccessSettings />);
    expect(await screen.findByText(hint)).toBeVisible();
    expect(screen.queryByText(remoteEntryCopy[locale].phases.disabled)).toBeNull();
    expect(screen.queryByRole("button", { name: remoteEntryCopy[locale].enable })).toBeNull();
    const login = await screen.findByRole("button", { name: remoteAccountCopy[locale].login });
    expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
    expect(login).toHaveClass("bg-primary");
    account = { phase: "signing-in", secureStorage: true };
    fireEvent.click(login);
    expect(
      await screen.findByRole("button", { name: remoteAccountCopy[locale].cancel }),
    ).toBeVisible();
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    act(() => accountListener?.(signedIn));
    const resume = await screen.findByRole("button", { name: remoteEntryCopy[locale].enable });
    expect(resume).toBeEnabled();
    expect(screen.queryByRole("button", { name: remoteAccountCopy[locale].login })).toBeNull();
    fireEvent.click(resume);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
  },
);

it("keeps official pause login cancellable without applying a self-hosted provider draft", async () => {
  local = {
    ...local,
    config: {
      ...local.config,
      relay: { enabled: false, brokerUrl: "https://api.agentkib.com" },
    },
  };
  render(<WebAccessSettings />);
  await screen.findByRole("button", { name: "Enable remote access" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  fireEvent.change(screen.getByLabelText(remoteEntryCopy["en-US"].broker), {
    target: { value: "https://draft.example.com" },
  });
  act(() => accountListener?.({ phase: "signed-out", secureStorage: true }));
  const login = await screen.findByRole("button", { name: remoteAccountCopy["en-US"].login });
  expect(screen.queryByRole("button", { name: "Enable remote access" })).toBeNull();
  account = { phase: "signing-in", secureStorage: true };
  fireEvent.click(login);
  const cancel = await screen.findByRole("button", { name: remoteAccountCopy["en-US"].cancel });
  account = { phase: "signed-out", secureStorage: true };
  fireEvent.click(cancel);
  expect(
    await screen.findByRole("button", { name: remoteAccountCopy["en-US"].login }),
  ).toBeVisible();
  expect(accountRequest).toHaveBeenCalledWith({ operation: "cancel-login" });
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  act(() => accountListener?.(signedIn));
  fireEvent.click(await screen.findByRole("button", { name: "Enable remote access" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
    }),
  );
  expect(screen.getByLabelText(remoteEntryCopy["en-US"].broker)).toHaveValue(
    "https://draft.example.com",
  );
});

it("keeps self-hosted pause resume independent of account sign-in and official provider drafts", async () => {
  account = { phase: "signed-out", secureStorage: true };
  local = {
    ...local,
    config: {
      ...local.config,
      relay: { enabled: false, brokerUrl: "https://self-hosted.example.com" },
    },
  };
  const view = render(<WebAccessSettings />);
  const resume = await screen.findByRole("button", { name: "Enable remote access" });
  expect(resume).toBeEnabled();
  expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  fireEvent.change(screen.getByLabelText(remoteEntryCopy["en-US"].broker), {
    target: { value: "https://api.agentkib.com" },
  });
  fireEvent.click(resume);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://self-hosted.example.com",
    }),
  );
});

it.each(["ready", "connecting", "offline", "error"] as const)(
  "shows diagnostics only for a failed or interrupted management connection (%s)",
  async (phase) => {
    ready();
    local = {
      ...local,
      devices: [browser],
      relay: { ...local.relay!, phase, channels: { control: true, preview: phase === "ready" } },
    };
    render(<WebAccessSettings />);
    await screen.findByRole("heading", { name: "Authorized browsers 1" });
    const diagnostics = screen.queryByRole("button", { name: "Connection diagnostics" });
    if (phase === "offline" || phase === "error") expect(diagnostics).toBeVisible();
    else expect(diagnostics).toBeNull();
    expect(screen.getAllByText("Full control")).toHaveLength(1);
    expect(
      screen.getByRole("combobox", { name: "Access level: iPhone · Safari" }),
    ).toHaveTextContent("Full control");
  },
);

it("keeps legacy browser permission details while avoiding repeated generated-code access levels", async () => {
  ready();
  local = {
    ...local,
    devices: [{ ...browser, accessMode: undefined, accessLevel: undefined }],
    code: { value: "48291736", access: "full", expiresAt: Date.now() + 60_000 },
  };
  render(<WebAccessSettings />);
  const name = await screen.findByText(browser.name);
  expect(name.closest("div")).toHaveTextContent(webSettingsCopy["en-US"].read);
  fireEvent.click(screen.getByRole("button", { name: "Connect a new phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect a new phone" });
  expect(within(dialog).getByText("4829 1736")).toBeVisible();
  expect(within(dialog).queryByText(/^Access level:/)).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Read-only" }));
  expect(within(dialog).queryByText("4829 1736")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Generate access code" })).toBeEnabled();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "generate-code" }));
});

it("does not restart local Web for external-only save failures, retries, or discarded external drafts", async () => {
  const save = vi.fn().mockResolvedValue(false);
  const view = render(
    <WebAccessSettings phoneVisible={false} advancedDirty onSaveAdvanced={save} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Settings saved.")).toBeNull();
  view.rerender(
    <WebAccessSettings phoneVisible={false} advancedDirty={false} onSaveAdvanced={save} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  view.rerender(<WebAccessSettings phoneVisible={false} advancedDirty onSaveAdvanced={save} />);
  save.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});

it("keeps the ready first-time migration invitation reachable and requires explicit provider confirmation", async () => {
  const user = userEvent.setup();
  ready();
  local = {
    ...local,
    config: { ...local.config, relay: { enabled: true, brokerUrl: "https://remote.agentkib.com" } },
  };
  render(<WebAccessSettings />);
  await screen.findByText("Signed in as demo@example.com");
  await user.click(screen.getByRole("button", { name: "Advanced settings" }));
  await user.click(screen.getByRole("button", { name: "Prepare service migration" }));
  const invitation = screen.getByLabelText("Invitation (first connection only)");
  expect(invitation).toBeVisible();
  expect(screen.getAllByLabelText("Invitation (first connection only)")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Apply connection settings" })).toBeDisabled();
  await user.type(invitation, "example-invitation");
  await user.click(screen.getByRole("button", { name: "Apply connection settings" }));
  const dialog = screen.getByRole("dialog", { name: "Apply connection settings" });
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  await user.click(within(dialog).getByRole("button", { name: "Apply connection settings" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
      inviteCode: "example-invitation",
    }),
  );
});

it("keeps LAN plaintext warnings visible outside either tab and hides duplicate network fields in its dialog", async () => {
  lan = { ...lan, running: true, config: { ...lan.config, enabled: true, allowPlaintext: true } };
  const view = render(<WebAccessSettings phoneVisible={false} />);
  expect(await screen.findByText("LAN direct connection is not encrypted")).toBeVisible();
  expect(screen.getByText("LAN HTTP access is running")).toBeVisible();
  expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
  view.rerender(<WebAccessSettings phoneVisible />);
  fireEvent.click(screen.getByRole("button", { name: "Set up LAN direct connection" }));
  const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
  expect(
    within(dialog)
      .getAllByRole("heading", { name: "LAN direct connection" })
      .filter((element) => !element.closest(".sr-only")),
  ).toHaveLength(1);
  expect(
    within(dialog)
      .getAllByText(lanSettingsCopy["en-US"].scope)
      .filter((element) => !element.closest(".sr-only")),
  ).toHaveLength(1);
  expect(within(dialog).queryByLabelText("Network interface address")).toBeNull();
  expect(within(dialog).queryByLabelText("Port")).toBeNull();
  expect(
    within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" }),
  ).toBeVisible();
  expect(within(dialog).getByRole("checkbox", { name: /I understand/ })).toBeVisible();
});

it("opens an already registered connection with no browsers in the management view", async () => {
  ready();
  render(<WebAccessSettings />);
  expect(await screen.findByRole("heading", { name: "Authorized browsers 0" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: remotePhoneCopy["en-US"].introTitle })).toBeNull();
  expect(screen.getByRole("button", { name: "Connect a new phone" })).toBeEnabled();
});

it.each(["ready", "disabled"] as const)(
  "stays in management after revoking its last browser while relay is %s",
  async (phase) => {
    ready();
    local = { ...local, devices: [browser] };
    render(<WebAccessSettings />);
    expect(await screen.findByRole("heading", { name: "Authorized browsers 1" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    local = {
      ...local,
      devices: [],
      config: { ...local.config, relay: { ...local.config.relay!, enabled: phase === "ready" } },
      relay: { phase },
    };
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Revoke this browser?" })).getByRole(
        "button",
        { name: "Confirm revocation" },
      ),
    );
    expect(await screen.findByRole("heading", { name: "Authorized browsers 0" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: remotePhoneCopy["en-US"].introTitle })).toBeNull();
    expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "phone" });
  },
);

it("locks the combined network draft throughout local and network saves", async () => {
  const user = userEvent.setup();
  let finishLocal!: (value: WebAdminStatus) => void;
  let finishNetwork!: (value: boolean) => void;
  const saveNetwork = vi.fn(
    (_port: string) =>
      new Promise<boolean>((resolve) => {
        finishNetwork = resolve;
      }),
  );
  function CombinedSettings() {
    const [networkPort, setNetworkPort] = useState("42987");
    return (
      <WebAccessSettings
        advancedDirty={networkPort !== "42987"}
        onSaveAdvanced={() => saveNetwork(networkPort)}
        advancedContent={
          <label>
            Shared network port
            <input value={networkPort} onChange={(event) => setNetworkPort(event.target.value)} />
          </label>
        }
      />
    );
  }
  render(<CombinedSettings />);
  await user.click(await screen.findByRole("button", { name: "Advanced settings" }));
  const network = screen.getByLabelText("Shared network port");
  await user.clear(network);
  await user.type(network, "43001");
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  request.mockImplementation((input) =>
    input.operation === "configure"
      ? new Promise<WebAdminStatus>((resolve) => {
          finishLocal = resolve;
        })
      : Promise.resolve(local),
  );
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(network).toBeDisabled();
  await user.type(network, "44001");
  expect(network).toHaveValue("43001");
  expect(saveNetwork).not.toHaveBeenCalled();
  await act(async () => finishLocal({ ...local, config: { ...local.config, port: 1444 } }));
  expect(saveNetwork).toHaveBeenCalledWith("43001");
  expect(network).toBeDisabled();
  await act(async () => finishNetwork(true));
  expect(network).toBeEnabled();
});

it.each([false, true])(
  "keeps a saved paused connection in management after a restart with no relay runtime or browsers (running=%s)",
  async (running) => {
    local = {
      ...local,
      config: {
        ...local.config,
        enabled: running,
        relay: { enabled: false, brokerUrl: "https://api.agentkib.com" },
      },
      running,
    };
    render(<WebAccessSettings />);
    expect(await screen.findByRole("heading", { name: "Authorized browsers 0" })).toBeVisible();
    expect(screen.getByText("Remote access paused")).toBeVisible();
    expect(screen.queryByRole("heading", { name: remotePhoneCopy["en-US"].introTitle })).toBeNull();
    expect(await screen.findByRole("button", { name: "Enable remote access" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Connect a new phone" })).toBeDisabled();
    expect(screen.queryByLabelText("Invitation (first connection only)")).toBeNull();
  },
);

it("keeps a first failed enable intent in the setup flow until a browser is authorized", async () => {
  local = {
    ...local,
    config: { ...local.config, relay: { enabled: true, brokerUrl: "https://api.agentkib.com" } },
    relay: { phase: "error", reason: "setup" },
  };
  render(<WebAccessSettings />);
  expect(
    await screen.findByRole("heading", { name: remotePhoneCopy["en-US"].introTitle }),
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Authorized browsers 0" })).toBeNull();
  const retry = await screen.findByRole("button", { name: "Enable remote access" });
  const invitation = await screen.findByLabelText("Invitation (first connection only)");
  expect(invitation).toBeVisible();
  fireEvent.change(invitation, { target: { value: "corrected-invitation" } });
  ready();
  fireEvent.click(retry);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
      inviteCode: "corrected-invitation",
    }),
  );
  expect(await screen.findByText(remotePhoneCopy["en-US"].readyResult)).toBeVisible();
  expect(
    screen.getByRole("button", { name: webSettingsCopy["en-US"].generateAccess }),
  ).toBeEnabled();
  expect(screen.queryByRole("heading", { name: "Authorized browsers 0" })).toBeNull();
});

it("hides a phone code and blocks generation if an open connection dialog is paused", async () => {
  ready();
  local = {
    ...local,
    devices: [browser],
    code: { value: "48291736", access: "full", expiresAt: Date.now() + 60_000 },
  };
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect a new phone" }));
  expect(await screen.findByText("4829 1736")).toBeVisible();
  local = {
    ...local,
    config: { ...local.config, enabled: true, relay: { ...local.config.relay!, enabled: false } },
    running: true,
    relay: { phase: "disabled" },
  };
  await act(async () => {
    await requestWebAdmin({ operation: "relay-stop" });
  });
  const dialog = screen.getByRole("dialog", { name: "Connect a new phone" });
  expect(within(dialog).queryByText("4829 1736")).toBeNull();
  expect(within(dialog).queryByRole("img", { name: "Open on your phone" })).toBeNull();
  const generate = within(dialog).getByRole("button", {
    name: webSettingsCopy["en-US"].generateAccess,
  });
  expect(generate).toBeDisabled();
  expect(generate).toHaveAccessibleDescription(webSettingsCopy["en-US"].generateNeedsConnection);
  fireEvent.click(generate);
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "generate-code" }));
});

it("resumes saved connection settings without applying unconfirmed provider or program drafts", async () => {
  local = {
    ...local,
    config: {
      ...local.config,
      relay: {
        enabled: false,
        brokerUrl: "https://saved.example.com",
        frpcPath: "/synthetic/saved-frpc",
      },
    },
  };
  render(<WebAccessSettings />);
  await screen.findByRole("heading", { name: "Authorized browsers 0" });
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  fireEvent.change(screen.getByLabelText(remoteEntryCopy["en-US"].broker), {
    target: { value: "https://draft.example.com" },
  });
  fireEvent.change(screen.getByLabelText(remoteEntryCopy["en-US"].frpc), {
    target: { value: "/synthetic/draft-frpc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Enable remote access" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://saved.example.com",
      frpcPath: "/synthetic/saved-frpc",
    }),
  );
  expect(screen.getByLabelText(remoteEntryCopy["en-US"].broker)).toHaveValue(
    "https://draft.example.com",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "explains the code grant scope once beside first and additional phone generation in %s",
  async (locale) => {
    await changeLocale(locale);
    render(<WebAccessSettings />);
    const enable = await screen.findByRole("button", { name: remoteEntryCopy[locale].enable });
    ready();
    fireEvent.click(enable);
    expect(await screen.findByText(webSettingsCopy[locale].codeScope)).toBeVisible();
    expect(screen.getByText(remotePhoneCopy[locale].codeHint)).toBeVisible();
    expect(screen.getAllByText(webSettingsCopy[locale].codeScope)).toHaveLength(1);
    local = {
      ...local,
      devices: [browser],
      code: { value: "48291736", access: "full", expiresAt: Date.now() + 60_000 },
    };
    await act(async () => {
      await requestWebAdmin({ operation: "status" });
    });
    fireEvent.click(screen.getByRole("button", { name: remotePhoneCopy[locale].connectNew }));
    const dialog = await screen.findByRole("dialog", { name: remotePhoneCopy[locale].connectNew });
    expect(within(dialog).getByText(webSettingsCopy[locale].codeScope)).toBeVisible();
    expect(within(dialog).getByText(remotePhoneCopy[locale].codeHint)).toBeVisible();
    expect(within(dialog).getByText("4829 1736")).toBeVisible();
    expect(
      within(dialog).queryByText(
        `${webSettingsCopy[locale].accessLevel}: ${webSettingsCopy[locale].fullAccess}`,
      ),
    ).toBeNull();
    expect(screen.getAllByText(webSettingsCopy[locale].codeScope)).toHaveLength(1);
  },
);

it.each(["", "192.168.50.99"])(
  "opens shared network settings from a LAN dialog with an unavailable address (%s)",
  async (address) => {
    const user = userEvent.setup();
    lan = {
      ...lan,
      config: { ...lan.config, lanAddress: address, enabled: !!address, allowPlaintext: true },
    };
    render(<WebAccessSettings />);
    await user.click(await screen.findByRole("button", { name: "Set up LAN direct connection" }));
    const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
    expect(within(dialog).getByText(webSettingsCopy["en-US"].lanNetworkRequired)).toBeVisible();
    const enabled = within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" });
    if (!address) await user.click(enabled);
    expect(within(dialog).getByRole("button", { name: "Save settings" })).toBeDisabled();
    await user.click(enabled);
    expect(within(dialog).getByRole("button", { name: "Save settings" })).toBeEnabled();
    await user.click(
      within(dialog).getByRole("button", { name: webSettingsCopy["en-US"].openNetworkSettings }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const advanced = screen.getByRole("button", { name: "Advanced settings" });
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(advanced).toHaveFocus());
  },
);

it("retries an unpersisted local configuration after every settings controller remounts", async () => {
  request.mockImplementation(async (input) => {
    if (input.operation === "configure") {
      const { operation: _operation, ...config } = input;
      local = { ...local, config };
      throw new Error("synthetic local persistence failure");
    }
    return local;
  });
  const first = render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText(remoteEntryCopy["en-US"].saveFailed);
  first.unmount();
  request.mockImplementation(async () => local);
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  expect(await screen.findByText(webSettingsCopy["en-US"].unsaved)).toBeVisible();
  expect(screen.getByLabelText("Port")).toHaveValue(1444);
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByText(webSettingsCopy["en-US"].saved)).toBeVisible();
  expect(request.mock.calls.filter(([input]) => input.operation === "configure")).toHaveLength(2);
  expect(screen.queryByText(webSettingsCopy["en-US"].unsaved)).toBeNull();
});
