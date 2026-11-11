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
import { remotePageCopy } from "./remote-page-copy";
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
const noInvitation = /邀请码|邀請碼|invitation|招待コード/i;
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
/** Answers generate-code like the service: a live code for the requested level. */
function serveCodes() {
  request.mockImplementation(async (input) => {
    if (input.operation === "generate-code")
      local = {
        ...local,
        code: { value: "48291736", access: input.access ?? "full", expiresAt: Date.now() + 60_000 },
      };
    return local;
  });
}
const operations = () => request.mock.calls.map(([input]) => input.operation);
const statusOnly = () => operations().every((operation) => operation === "status");
const generated = () =>
  request.mock.calls
    .filter(([input]) => input.operation === "generate-code")
    .map(([input]) => input);
const devices = (count: number, locale: keyof typeof remotePageCopy = "en-US") =>
  remotePageCopy[locale].devices.replace("{count}", String(count));
async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Advanced settings" }));
  return screen.findByRole("dialog", { name: "Advanced settings" });
}
async function openMenu(user: ReturnType<typeof userEvent.setup>, item: RegExp) {
  await user.click(await screen.findByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitem", { name: item }));
}
const gone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "shows only the current first-time step action in %s",
  async (locale) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
    account = { phase: "signed-out", secureStorage: true };
    await changeLocale(locale);
    const view = render(<WebAccessSettings />);
    expect(await screen.findByRole("button", { name: pc.connectPhone })).toBeEnabled();
    expect(screen.getByRole("heading", { name: pc.phone })).toBeVisible();
    expect(screen.getByText(pc.phoneInfo)).toBeVisible();
    expect(screen.queryByRole("button", { name: remoteEntryCopy[locale].enable })).toBeNull();
    expect(
      screen.queryByRole("button", { name: webSettingsCopy[locale].generateAccess }),
    ).toBeNull();
    expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: pc.connectPhone }));
    const dialog = await screen.findByRole("dialog", { name: pc.dialogTitle });
    const login = await within(dialog).findByRole("button", {
      name: remoteAccountCopy[locale].login,
    });
    expect(login).toBeEnabled();
    expect(within(dialog).getByRole("heading", { name: pc.loginTitle })).toBeVisible();
    expect(dialog.querySelectorAll("button.bg-primary")).toHaveLength(1);
    expect(
      within(dialog).queryByRole("button", { name: remoteEntryCopy[locale].enable }),
    ).toBeNull();
    account = { phase: "signing-in", secureStorage: true };
    fireEvent.click(login);
    expect(
      await within(dialog).findByRole("button", { name: remoteAccountCopy[locale].cancel }),
    ).toBeVisible();
    expect(statusOnly()).toBe(true);
    act(() => accountListener?.(signedIn));
    // Signed in, the window turns remote access on by itself, once, with no extra click.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
    expect(operations().filter((operation) => operation === "remote-enable")).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: webSettingsCopy[locale].generateAccess }),
    ).toBeNull();
    expect(screen.queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    expect(within(dialog).queryByText(noInvitation)).toBeNull();
  },
);

it.each([
  "https://api.agentkib.com/",
  "https://API.AGENTKIB.COM:443/",
  " https://API.AGENTKIB.COM:443 ",
])(
  "requires account login for official origin %s in advanced settings without an invitation",
  async (brokerUrl) => {
    const user = userEvent.setup();
    account = { phase: "signed-out", secureStorage: true };
    // A saved self-hosted service makes switching to the official origin a pending change.
    local = {
      ...local,
      config: {
        ...local.config,
        relay: { enabled: false, brokerUrl: "https://self-hosted.example.com" },
      },
    };
    render(<WebAccessSettings />);
    const dialog = await openAdvanced(user);
    fireEvent.change(within(dialog).getByLabelText(remotePageCopy["en-US"].serviceAddress), {
      target: { value: brokerUrl },
    });
    // The spelling is recognised as the official service: no address field, no invitation.
    expect(within(dialog).queryByLabelText(remoteEntryCopy["en-US"].invitation)).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /^Official/ })).toBeChecked();
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(statusOnly()).toBe(true);
    act(() => accountListener?.(signedIn));
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const confirm = await screen.findByRole("dialog", {
      name: remotePhoneCopy["en-US"].applyConnection,
    });
    expect(statusOnly()).toBe(true);
    await user.click(
      within(confirm).getByRole("button", { name: remotePhoneCopy["en-US"].applyConnection }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: brokerUrl.trim(),
      }),
    );
  },
);

it.each([
  "https://self-hosted.example.com",
  "http://api.agentkib.com",
  "https://user@api.agentkib.com",
  "https://api.agentkib.com/path",
  "https://api.agentkib.com/?query=1",
  "https://api.agentkib.com/#hash",
  "https://api.agentkib.com//",
  "invalid broker",
])(
  "keeps %s on the explicit advanced path without treating it as the official origin",
  async (brokerUrl) => {
    const user = userEvent.setup();
    account = { phase: "signed-out", secureStorage: true };
    render(<WebAccessSettings />);
    const dialog = await openAdvanced(user);
    await user.click(within(dialog).getByRole("radio", { name: /^Self-hosted/ }));
    fireEvent.change(within(dialog).getByLabelText(remotePageCopy["en-US"].serviceAddress), {
      target: { value: brokerUrl },
    });
    expect(within(dialog).getByLabelText(remoteEntryCopy["en-US"].invitation)).toBeVisible();
    expect(within(dialog).getByRole("radio", { name: /^Self-hosted/ })).toBeChecked();
    const save = within(dialog).getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ operation: "remote-enable", brokerUrl }),
    );
  },
);

it("keeps the first connection at the code step and generates the selected level once per level", async () => {
  const user = userEvent.setup();
  render(<WebAccessSettings />);
  await screen.findByRole("button", { name: "Connect phone" });
  ready();
  serveCodes();
  await user.click(screen.getByRole("button", { name: "Connect phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(await within(dialog).findByText("4829 1736")).toBeVisible();
  expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "full" });
  expect(generated()).toHaveLength(1);
  expect(within(dialog).getByRole("button", { name: "Full control" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(within(dialog).getByRole("img", { name: "Open on your phone" })).toBeVisible();
  expect(within(dialog).getByLabelText("48291736")).toBeVisible();
  expect(within(dialog).getByText(/Valid until \d{2}:\d{2}/)).toBeVisible();
  expect(within(dialog).getByText(webSettingsCopy["en-US"].codeScope)).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Read-only" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "read" }),
  );
  expect(within(dialog).getByRole("button", { name: "Read-only" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await within(dialog).findByText("4829 1736")).toBeVisible();
  expect(generated()).toHaveLength(2);
  // Polling never generates a code of its own.
  await act(async () => {
    await requestWebAdmin({ operation: "status" });
  });
  expect(generated()).toHaveLength(2);
  local = { ...local, devices: [browser] };
  await user.click(within(dialog).getByRole("button", { name: "Regenerate" }));
  expect(await within(dialog).findByText("iPhone · Safari connected")).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await gone();
  expect(await screen.findByText(devices(1))).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  local = { ...local, devices: [], relay: { phase: "offline", reason: "network" } };
  await user.click(
    within(await screen.findByRole("dialog", { name: "Revoke this browser?" })).getByRole(
      "button",
      { name: "Confirm revocation" },
    ),
  );
  expect(await screen.findByText(devices(0))).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
});

it("manages existing browsers after pause and requires confirmation for pause and revocation", async () => {
  const user = userEvent.setup();
  ready();
  local = { ...local, devices: [browser] };
  render(<WebAccessSettings />);
  expect(await screen.findByText(devices(1))).toBeVisible();
  expect(screen.getByText(browser.name)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
  await openMenu(user, /^Pause remote access$/);
  const pause = await screen.findByRole("dialog", { name: "Pause remote access?" });
  expect(within(pause).getByText(remotePhoneCopy["en-US"].pauseHint)).toBeVisible();
  expect(request).not.toHaveBeenCalledWith({ operation: "relay-stop" });
  await waitFor(() => expect(within(pause).getByRole("button", { name: "Cancel" })).toHaveFocus());
  local = {
    ...local,
    config: { ...local.config, relay: { ...local.config.relay!, enabled: false } },
    relay: { phase: "disabled" },
  };
  await user.click(within(pause).getByRole("button", { name: "Confirm pause" }));
  expect(await screen.findByText(remotePageCopy["en-US"].paused)).toBeVisible();
  expect(screen.getByText(remotePageCopy["en-US"].pausedInfo)).toBeVisible();
  expect(screen.getByText(browser.name)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Revoke" }));
  const revoke = await screen.findByRole("dialog", { name: "Revoke this browser?" });
  expect(request).not.toHaveBeenCalledWith({ operation: "revoke", id: "phone" });
  await user.click(within(revoke).getByRole("button", { name: "Confirm revocation" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "phone" }));
});

it("opens the code step for a new phone while account actions stay in account management", async () => {
  const user = userEvent.setup();
  ready();
  serveCodes();
  local = { ...local, devices: [browser] };
  render(<WebAccessSettings />);
  await user.click(await screen.findByRole("button", { name: "Connect a new phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(within(dialog).getByRole("button", { name: "Full control" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await within(dialog).findByText("4829 1736")).toBeVisible();
  expect(generated()).toEqual([{ operation: "generate-code", access: "full" }]);
  expect(operations().every((operation) => ["status", "generate-code"].includes(operation))).toBe(
    true,
  );
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await gone();
  expect(screen.queryByRole("button", { name: remoteAccountCopy["en-US"].logout })).toBeNull();
  await openMenu(user, /^Account/);
  expect(
    within(await screen.findByRole("dialog", { name: remoteAccountCopy["en-US"].title })).getByRole(
      "button",
      { name: remoteAccountCopy["en-US"].logout },
    ),
  ).toBeVisible();
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "requires sign-in before resuming a saved official pause in %s",
  async (locale) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
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
    expect(await screen.findByText(pc.pausedInfo)).toBeVisible();
    expect(screen.queryByText(remoteEntryCopy[locale].phases.disabled)).toBeNull();
    expect(screen.queryByRole("button", { name: remoteEntryCopy[locale].enable })).toBeNull();
    const resume = await screen.findByRole("button", { name: pc.resume });
    expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
    await user.click(resume);
    const dialog = await screen.findByRole("dialog", { name: pc.dialogTitle });
    const login = await within(dialog).findByRole("button", {
      name: remoteAccountCopy[locale].login,
    });
    expect(dialog.querySelectorAll("button.bg-primary")).toHaveLength(1);
    expect(login).toHaveClass("bg-primary");
    account = { phase: "signing-in", secureStorage: true };
    fireEvent.click(login);
    expect(
      await within(dialog).findByRole("button", { name: remoteAccountCopy[locale].cancel }),
    ).toBeVisible();
    expect(statusOnly()).toBe(true);
    act(() => accountListener?.(signedIn));
    // The saved connection resumes by itself once signed in.
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
    expect(screen.queryByRole("button", { name: remoteAccountCopy[locale].login })).toBeNull();
  },
);

it("keeps official pause login cancellable without applying a self-hosted provider draft", async () => {
  const user = userEvent.setup();
  local = {
    ...local,
    config: {
      ...local.config,
      relay: { enabled: false, brokerUrl: "https://api.agentkib.com" },
    },
  };
  render(<WebAccessSettings />);
  await screen.findByRole("button", { name: "Resume" });
  // A self-hosted draft lives only until the advanced settings are cancelled.
  const advanced = await openAdvanced(user);
  await user.click(within(advanced).getByRole("radio", { name: /^Self-hosted/ }));
  fireEvent.change(within(advanced).getByLabelText(remotePageCopy["en-US"].serviceAddress), {
    target: { value: "https://draft.example.com" },
  });
  await user.click(within(advanced).getByRole("button", { name: "Cancel" }));
  await gone();
  account = { phase: "signed-out", secureStorage: true };
  act(() => accountListener?.(account));
  await user.click(await screen.findByRole("button", { name: "Resume" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  const login = await within(dialog).findByRole("button", {
    name: remoteAccountCopy["en-US"].login,
  });
  account = { phase: "signing-in", secureStorage: true };
  fireEvent.click(login);
  const cancel = await within(dialog).findByRole("button", {
    name: remoteAccountCopy["en-US"].cancel,
  });
  account = { phase: "signed-out", secureStorage: true };
  fireEvent.click(cancel);
  expect(
    await within(dialog).findByRole("button", { name: remoteAccountCopy["en-US"].login }),
  ).toBeVisible();
  expect(accountRequest).toHaveBeenCalledWith({ operation: "cancel-login" });
  expect(statusOnly()).toBe(true);
  act(() => accountListener?.(signedIn));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
    }),
  );
  expect(request).not.toHaveBeenCalledWith(
    expect.objectContaining({ brokerUrl: "https://draft.example.com" }),
  );
});

it("keeps self-hosted pause resume independent of account sign-in and official provider drafts", async () => {
  const user = userEvent.setup();
  account = { phase: "signed-out", secureStorage: true };
  local = {
    ...local,
    config: {
      ...local.config,
      relay: { enabled: false, brokerUrl: "https://self-hosted.example.com" },
    },
  };
  const view = render(<WebAccessSettings />);
  const resume = await screen.findByRole("button", { name: "Resume" });
  expect(resume).toBeEnabled();
  expect(view.container.querySelectorAll("button.bg-primary")).toHaveLength(1);
  const advanced = await openAdvanced(user);
  await user.click(within(advanced).getByRole("radio", { name: /^Official/ }));
  await user.click(within(advanced).getByRole("button", { name: "Cancel" }));
  await gone();
  await user.click(screen.getByRole("button", { name: "Resume" }));
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
    await screen.findByText(browser.name);
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
  const user = userEvent.setup();
  ready();
  local = {
    ...local,
    devices: [{ ...browser, accessMode: undefined, accessLevel: undefined }],
    code: { value: "48291736", access: "full", expiresAt: Date.now() + 60_000 },
  };
  render(<WebAccessSettings />);
  const name = await screen.findByText(browser.name);
  expect(name.closest("div")).toHaveTextContent(webSettingsCopy["en-US"].read);
  await user.click(screen.getByRole("button", { name: "Connect a new phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(within(dialog).getByText("4829 1736")).toBeVisible();
  expect(within(dialog).queryByText(/^Access level:/)).toBeNull();
  // A live code exists for this level, so opening the window generated nothing.
  expect(generated()).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Read-only" }));
  // The full-control code is hidden at once; the window asks for one read-only code, one time.
  expect(within(dialog).queryByText("4829 1736")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Generate access code" })).toBeEnabled();
  await waitFor(() =>
    expect(generated()).toEqual([{ operation: "generate-code", access: "read" }]),
  );
});

it("does not restart local Web for external-only save failures, retries, or discarded external drafts", async () => {
  const user = userEvent.setup();
  const save = vi.fn().mockResolvedValue(false);
  const view = render(<WebAccessSettings advancedDirty onSaveAdvanced={save} />);
  const dialog = await openAdvanced(user);
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(save).toHaveBeenCalledTimes(1);
  expect(within(dialog).queryByText("Settings saved.")).toBeNull();
  view.rerender(<WebAccessSettings advancedDirty={false} onSaveAdvanced={save} />);
  // Nothing is left to save, so Save is unavailable and nothing is requested.
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(statusOnly()).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  view.rerender(<WebAccessSettings advancedDirty onSaveAdvanced={save} />);
  save.mockResolvedValue(true);
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(statusOnly()).toBe(true);
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "migrates a ready legacy official service through the account with explicit confirmation in %s",
  async (locale) => {
    await changeLocale(locale);
    const user = userEvent.setup();
    ready();
    local = {
      ...local,
      config: {
        ...local.config,
        relay: { enabled: true, brokerUrl: "https://remote.agentkib.com" },
      },
    };
    render(<WebAccessSettings />);
    await user.click(await screen.findByRole("button", { name: remotePageCopy[locale].advanced }));
    const advanced = await screen.findByRole("dialog", { name: remotePageCopy[locale].advanced });
    expect(within(advanced).getByText(remoteEntryCopy[locale].migrationNotice)).toBeVisible();
    expect(within(advanced).queryByText(noInvitation)).toBeNull();
    await user.click(
      within(advanced).getByRole("button", { name: remoteEntryCopy[locale].prepareMigration }),
    );
    expect(within(advanced).queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    const save = within(advanced).getByRole("button", { name: remotePageCopy[locale].save });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    const dialog = await screen.findByRole("dialog", {
      name: remotePhoneCopy[locale].applyConnection,
    });
    expect(statusOnly()).toBe(true);
    await user.click(
      within(dialog).getByRole("button", { name: remotePhoneCopy[locale].applyConnection }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
  },
);

it("keeps LAN plaintext warnings visible on the page and hides duplicate network fields in its dialog", async () => {
  const user = userEvent.setup();
  lan = { ...lan, running: true, config: { ...lan.config, enabled: true, allowPlaintext: true } };
  render(<WebAccessSettings />);
  expect(await screen.findByText("LAN direct connection is not encrypted")).toBeVisible();
  expect(screen.getByText("LAN HTTP access is running")).toBeVisible();
  expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: remotePageCopy["en-US"].lanManage }));
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
  expect(await screen.findByText(devices(0))).toBeVisible();
  expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
  expect(screen.getByRole("button", { name: "Connect a new phone" })).toBeEnabled();
});

it.each(["ready", "disabled"] as const)(
  "stays in management after revoking its last browser while relay is %s",
  async (phase) => {
    const user = userEvent.setup();
    ready();
    local = { ...local, devices: [browser] };
    render(<WebAccessSettings />);
    expect(await screen.findByText(devices(1))).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    local = {
      ...local,
      devices: [],
      config: { ...local.config, relay: { ...local.config.relay!, enabled: phase === "ready" } },
      relay: { phase },
    };
    await user.click(
      within(await screen.findByRole("dialog", { name: "Revoke this browser?" })).getByRole(
        "button",
        { name: "Confirm revocation" },
      ),
    );
    if (phase === "ready") expect(await screen.findByText(devices(0))).toBeVisible();
    else {
      expect(await screen.findByText(remotePageCopy["en-US"].pausedInfo)).toBeVisible();
      expect(screen.getByText(remotePhoneCopy["en-US"].noBrowsers)).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
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
  const dialog = await openAdvanced(user);
  const network = within(dialog).getByLabelText("Shared network port");
  await user.clear(network);
  await user.type(network, "43001");
  fireEvent.change(within(dialog).getByLabelText("Port"), { target: { value: "1444" } });
  request.mockImplementation((input) =>
    input.operation === "configure"
      ? new Promise<WebAdminStatus>((resolve) => {
          finishLocal = resolve;
        })
      : Promise.resolve(local),
  );
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(network).toBeDisabled();
  await user.type(network, "44001");
  expect(network).toHaveValue("43001");
  expect(saveNetwork).not.toHaveBeenCalled();
  await act(async () => finishLocal({ ...local, config: { ...local.config, port: 1444 } }));
  expect(saveNetwork).toHaveBeenCalledWith("43001");
  expect(network).toBeDisabled();
  await act(async () => finishNetwork(true));
  // The lock is released: the window closes after a complete save.
  await gone();
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
    expect(await screen.findByText(remotePageCopy["en-US"].paused)).toBeVisible();
    expect(screen.getByText(remotePageCopy["en-US"].pausedInfo)).toBeVisible();
    expect(await screen.findByText(remotePhoneCopy["en-US"].noBrowsers)).toBeVisible();
    expect(await screen.findByRole("button", { name: "Resume" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Connect phone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect a new phone" })).toBeNull();
    expect(screen.queryByLabelText(/invitation/i)).toBeNull();
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "retries a failed official enable intent without an invitation and stays in setup in %s",
  async (locale) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
    await changeLocale(locale);
    local = {
      ...local,
      config: { ...local.config, relay: { enabled: true, brokerUrl: "https://api.agentkib.com/" } },
      relay: { phase: "error", reason: "setup" },
    };
    render(<WebAccessSettings />);
    expect(await screen.findByRole("heading", { name: pc.phone })).toBeVisible();
    expect(screen.queryByText(devices(0, locale))).toBeNull();
    await user.click(await screen.findByRole("button", { name: pc.connectPhone }));
    const dialog = await screen.findByRole("dialog", { name: pc.dialogTitle });
    expect(await within(dialog).findByRole("heading", { name: pc.failedTitle })).toBeVisible();
    expect(within(dialog).getByText(remoteEntryCopy[locale].reasons.setup)).toBeVisible();
    const retry = within(dialog).getByRole("button", { name: pc.retryNow });
    expect(retry).toBeEnabled();
    expect(screen.queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    expect(within(dialog).queryByText(noInvitation)).toBeNull();
    ready();
    await user.click(retry);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com/",
      }),
    );
    expect(
      await within(dialog).findByRole("button", { name: webSettingsCopy[locale].generateAccess }),
    ).toBeEnabled();
    expect(screen.queryByText(devices(0, locale))).toBeNull();
  },
);

it.each(
  (["zh-CN", "zh-TW", "en-US", "ja-JP"] as const).flatMap((locale) =>
    [false, true].map((management) => ({ locale, management })),
  ),
)(
  "re-registers a revoked official device with its account in $locale (management=$management)",
  async ({ locale, management }) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
    await changeLocale(locale);
    const brokerUrl = `https://api.agentkib.com${management ? "/" : ""}`;
    local = {
      ...local,
      running: true,
      config: { ...local.config, relay: { enabled: true, brokerUrl } },
      relay: { phase: "error", reason: "revoked" },
      devices: management ? [browser] : [],
    };
    render(<WebAccessSettings />);
    expect(screen.queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    await user.click(
      await screen.findByRole("button", {
        name: management ? remotePhoneCopy[locale].connectNew : pc.connectPhone,
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: pc.dialogTitle });
    expect(within(dialog).queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    expect(within(dialog).queryByText(noInvitation)).toBeNull();
    const action = await within(dialog).findByRole("button", {
      name: remoteEntryCopy[locale].reenrollAccount,
    });
    // A new identity is only ever registered on purpose: no automatic send, no plain retry.
    expect(within(dialog).queryByRole("button", { name: pc.retryNow })).toBeNull();
    expect(request.mock.calls.some(([input]) => input.operation === "remote-enable")).toBe(false);
    expect(action).toBeEnabled();
    await user.click(action);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl,
        reenroll: true,
      }),
    );
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "keeps a self-hosted invitation in advanced settings and omits it after switching to official in %s",
  async (locale) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
    await changeLocale(locale);
    local = {
      ...local,
      config: {
        ...local.config,
        relay: { enabled: false, brokerUrl: "https://old-service.example.com" },
      },
    };
    render(<WebAccessSettings />);
    await user.click(await screen.findByRole("button", { name: pc.advanced }));
    const dialog = await screen.findByRole("dialog", { name: pc.advanced });
    const broker = within(dialog).getByLabelText(pc.serviceAddress);
    fireEvent.change(broker, { target: { value: "https://self-hosted.example.com" } });
    const invitation = within(dialog).getByLabelText(remoteEntryCopy[locale].invitation);
    expect(invitation).toBeVisible();
    expect(invitation).toHaveAccessibleDescription(webSettingsCopy[locale].invitationCodeHint);
    fireEvent.change(invitation, { target: { value: "self-hosted-invitation" } });
    await user.click(within(dialog).getByRole("radio", { name: new RegExp(`^${pc.official}`) }));
    expect(within(dialog).queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: pc.save }));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: remotePhoneCopy[locale].applyConnection }),
      ).getByRole("button", { name: remotePhoneCopy[locale].applyConnection }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
    expect(request.mock.calls.some(([input]) => "inviteCode" in input)).toBe(false);
    await user.click(await screen.findByRole("button", { name: pc.advanced }));
    const reopened = await screen.findByRole("dialog", { name: pc.advanced });
    await user.click(
      within(reopened).getByRole("radio", { name: new RegExp(`^${pc.selfHosted}`) }),
    );
    expect(within(reopened).getByLabelText(remoteEntryCopy[locale].invitation)).toHaveValue("");
  },
);

it("hides a phone code and blocks generation if an open connection dialog is paused", async () => {
  const user = userEvent.setup();
  ready();
  local = {
    ...local,
    devices: [browser],
    code: { value: "48291736", access: "full", expiresAt: Date.now() + 60_000 },
  };
  render(<WebAccessSettings />);
  await user.click(await screen.findByRole("button", { name: "Connect a new phone" }));
  const dialog = await screen.findByRole("dialog", { name: "Connect phone" });
  expect(await within(dialog).findByText("4829 1736")).toBeVisible();
  local = {
    ...local,
    config: { ...local.config, enabled: true, relay: { ...local.config.relay!, enabled: false } },
    running: true,
    relay: { phase: "disabled" },
  };
  await act(async () => {
    await requestWebAdmin({ operation: "relay-stop" });
  });
  expect(within(dialog).queryByText("4829 1736")).toBeNull();
  expect(within(dialog).queryByRole("img", { name: "Open on your phone" })).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: webSettingsCopy["en-US"].generateAccess }),
  ).toBeNull();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "generate-code" }));
  // A pause made while the window is open stays paused: the window offers the explicit action
  // instead of turning remote access back on by itself.
  expect(
    await within(dialog).findByRole("button", { name: remoteEntryCopy["en-US"].enable }),
  ).toBeEnabled();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "remote-enable" }));
});

it("resumes saved connection settings without applying unconfirmed provider or program drafts", async () => {
  const user = userEvent.setup();
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
  await screen.findByText(remotePhoneCopy["en-US"].noBrowsers);
  const dialog = await openAdvanced(user);
  fireEvent.change(within(dialog).getByLabelText(remotePageCopy["en-US"].serviceAddress), {
    target: { value: "https://draft.example.com" },
  });
  fireEvent.change(within(dialog).getByLabelText(remoteEntryCopy["en-US"].frpc), {
    target: { value: "/synthetic/draft-frpc" },
  });
  // Cancel discards the drafts; resuming then uses only what was saved.
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await gone();
  await user.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://saved.example.com",
      frpcPath: "/synthetic/saved-frpc",
    }),
  );
  const reopened = await openAdvanced(user);
  expect(within(reopened).getByLabelText(remotePageCopy["en-US"].serviceAddress)).toHaveValue(
    "https://saved.example.com",
  );
  expect(within(reopened).getByLabelText(remoteEntryCopy["en-US"].frpc)).toHaveValue(
    "/synthetic/saved-frpc",
  );
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "explains the code grant scope once beside first and additional phone generation in %s",
  async (locale) => {
    const pc = remotePageCopy[locale];
    const user = userEvent.setup();
    await changeLocale(locale);
    render(<WebAccessSettings />);
    await screen.findByRole("button", { name: pc.connectPhone });
    ready();
    serveCodes();
    await user.click(screen.getByRole("button", { name: pc.connectPhone }));
    const first = await screen.findByRole("dialog", { name: pc.dialogTitle });
    expect(await within(first).findByText(webSettingsCopy[locale].codeScope)).toBeVisible();
    expect(screen.queryByText(remotePhoneCopy[locale].codeHint)).toBeNull();
    expect(screen.getAllByText(webSettingsCopy[locale].codeScope)).toHaveLength(1);
    await user.keyboard("{Escape}");
    await gone();
    local = { ...local, devices: [browser] };
    await act(async () => {
      await requestWebAdmin({ operation: "status" });
    });
    await user.click(screen.getByRole("button", { name: remotePhoneCopy[locale].connectNew }));
    const dialog = await screen.findByRole("dialog", { name: pc.dialogTitle });
    expect(within(dialog).getByText(webSettingsCopy[locale].codeScope)).toBeVisible();
    expect(within(dialog).queryByText(remotePhoneCopy[locale].codeHint)).toBeNull();
    expect(within(dialog).getByText("4829 1736")).toBeVisible();
    expect(
      within(dialog).queryByText(
        `${webSettingsCopy[locale].accessLevel}: ${webSettingsCopy[locale].fullAccess}`,
      ),
    ).toBeNull();
    expect(screen.getAllByText(webSettingsCopy[locale].codeScope)).toHaveLength(1);
  },
);

it.each([
  ["zh-CN", "还没有授权的浏览器"],
  ["zh-TW", "還沒有授權的瀏覽器"],
  ["en-US", "No authorized browsers yet"],
  ["ja-JP", "認証済みのブラウザーはまだありません"],
] as const)("shows an authorized browser empty state in %s", async (locale, empty) => {
  await changeLocale(locale);
  ready();
  render(<WebAccessSettings />);
  expect(await screen.findByText(empty)).toBeVisible();
  local = { ...local, error: "web_unavailable" };
  await act(async () => {
    await requestWebAdmin({ operation: "status" });
  });
  expect(screen.queryByText(empty)).toBeNull();
  expect(screen.getByRole("alert")).toBeVisible();
});

it("does not present an unresolved or failed browser status read as an empty list", async () => {
  vi.useFakeTimers();
  ready();
  let resolve!: (value: WebAdminStatus) => void;
  request.mockReturnValueOnce(new Promise<WebAdminStatus>((done) => (resolve = done)));
  render(<WebAccessSettings />);
  expect(screen.queryByText(remotePhoneCopy["en-US"].noBrowsers)).toBeNull();
  await act(async () => resolve(local));
  expect(screen.getByText(remotePhoneCopy["en-US"].noBrowsers)).toBeVisible();
  request.mockRejectedValueOnce(new Error("status unavailable"));
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(screen.queryByText(remotePhoneCopy["en-US"].noBrowsers)).toBeNull();
  expect(screen.getByRole("alert")).toBeVisible();
  await act(async () => vi.advanceTimersByTimeAsync(2_000));
  expect(screen.getByText(remotePhoneCopy["en-US"].noBrowsers)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

// The page only offers the LAN window while LAN is enabled; a disabled LAN with no address has no
// entry on the page any more (the Wi-Fi path in the connect window has its own confirm step).
it.each(["192.168.50.99"])(
  "opens shared network settings from a LAN dialog with an unavailable address (%s)",
  async (address) => {
    const user = userEvent.setup();
    lan = {
      ...lan,
      config: { ...lan.config, lanAddress: address, enabled: !!address, allowPlaintext: true },
    };
    render(<WebAccessSettings />);
    await user.click(
      await screen.findByRole("button", { name: remotePageCopy["en-US"].lanManage }),
    );
    const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
    expect(within(dialog).getByText(webSettingsCopy["en-US"].lanNetworkRequired)).toBeVisible();
    const enabled = within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" });
    expect(within(dialog).getByRole("button", { name: "Save settings" })).toBeDisabled();
    await user.click(enabled);
    expect(within(dialog).getByRole("button", { name: "Save settings" })).toBeEnabled();
    await user.click(
      within(dialog).getByRole("button", { name: webSettingsCopy["en-US"].openNetworkSettings }),
    );
    expect(await screen.findByRole("dialog", { name: "Advanced settings" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "LAN direct connection" })).toBeNull();
  },
);

it("retries an unpersisted local configuration after every settings controller remounts", async () => {
  const user = userEvent.setup();
  request.mockImplementation(async (input) => {
    if (input.operation === "configure") {
      const { operation: _operation, ...config } = input;
      local = { ...local, config };
      throw new Error("synthetic local persistence failure");
    }
    return local;
  });
  const first = render(<WebAccessSettings />);
  const firstDialog = await openAdvanced(user);
  fireEvent.change(within(firstDialog).getByLabelText("Port"), { target: { value: "1444" } });
  await user.click(within(firstDialog).getByRole("button", { name: "Save" }));
  await screen.findByText(remoteEntryCopy["en-US"].saveFailed);
  first.unmount();
  request.mockImplementation(async () => local);
  render(<WebAccessSettings />);
  const dialog = await openAdvanced(user);
  expect(await within(dialog).findByText(webSettingsCopy["en-US"].unsaved)).toBeVisible();
  expect(within(dialog).getByLabelText("Port")).toHaveValue(1444);
  await user.click(within(dialog).getByRole("button", { name: "Save" }));
  expect(await screen.findByText(webSettingsCopy["en-US"].saved)).toBeVisible();
  expect(request.mock.calls.filter(([input]) => input.operation === "configure")).toHaveLength(2);
  expect(screen.queryByText(webSettingsCopy["en-US"].unsaved)).toBeNull();
});
