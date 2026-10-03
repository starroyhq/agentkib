// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import { WebAccessSettings } from "./WebAccessSettings";
const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ web: { request } }) }));
const status = {
  config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
  running: false,
  localUrl: "http://127.0.0.1:1421",
  pending: [],
  devices: [],
};
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue(status);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes active Web settings every two seconds and clears a recovered polling error without changed data", async () => {
  vi.useFakeTimers();
  const activeStatus = { ...status, running: true };
  request.mockResolvedValue(activeStatus);
  render(<WebAccessSettings />);
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  request.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999);
  });
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alert")).toBeNull();
});
it("supports keyboard access to advanced settings without losing unsaved values", async () => {
  const user = userEvent.setup();
  render(<WebAccessSettings />);
  const trigger = await screen.findByRole("button", {
    name: "Advanced connection and permissions",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const broker = screen.getByLabelText("Bridge service (official or self-hosted)");
  fireEvent.change(broker, { target: { value: "https://self-hosted.example.com" } });
  trigger.focus();
  await user.keyboard(" ");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("switch", { name: "Enable local Web service" })).toBeNull();
  await user.keyboard("{Enter}");
  expect(
    (screen.getByLabelText("Bridge service (official or self-hosted)") as HTMLInputElement).value,
  ).toBe("https://self-hosted.example.com");
  expect(document.activeElement).toBe(trigger);
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});
it("does not enable service until settings are saved", async () => {
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByText("Advanced connection and permissions"));
  const toggle = await screen.findByRole("switch", { name: "Enable local Web service" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "configure",
      ...status.config,
      enabled: true,
    }),
  );
});
it("connects with the default service and bundled connector without asking for a binary path", async () => {
  render(<WebAccessSettings />);
  const invitation = await screen.findByLabelText("Invitation (first connection only)");
  fireEvent.change(invitation, { target: { value: "invited-device" } });
  const connect = screen.getByRole("button", { name: "Enable remote access" });
  await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(connect);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
      inviteCode: "invited-device",
    }),
  );
  expect((invitation as HTMLInputElement).value).toBe("");
});
it("shows the failed relay stage and retry time without exposing raw errors or a pairing code", async () => {
  request.mockResolvedValue({
    ...status,
    config: {
      ...status.config,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: {
      phase: "offline",
      reason: "network",
      failure: { stage: "preview-probe", code: "timeout" },
      retryAt: Date.now() + 60_000,
      publicUrl: "https://device.control.remote.agentkib.com",
    },
  });
  render(<WebAccessSettings />);
  expect(await screen.findByText("Preview public probe: Connection timed out")).toBeTruthy();
  expect(screen.getByText(/Next retry:/)).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
});
it("keeps multiline directory drafts intact and grants them only on save", async () => {
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByText("Advanced connection and permissions"));
  const input = await screen.findByLabelText(
    "Additional read-only directories (one absolute path per line)",
  );
  fireEvent.change(input, { target: { value: "/tmp/reports\n" } });
  expect((input as HTMLTextAreaElement).value).toBe("/tmp/reports\n");
  fireEvent.change(input, { target: { value: "/tmp/reports\n/tmp/media" } });
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "configure",
      ...status.config,
      extraRoots: [
        { id: "extra-0", name: "reports", path: "/tmp/reports" },
        { id: "extra-1", name: "media", path: "/tmp/media" },
      ],
    }),
  );
});
it("saves the latest relay-managed origin without replacing other setting drafts", async () => {
  vi.useFakeTimers();
  const relay = { enabled: true, brokerUrl: "https://broker.example.com", frpcPath: "/tmp/frpc" };
  request.mockResolvedValue({ ...status, running: true, config: { ...status.config, relay } });
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByText("Advanced connection and permissions"));
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  request.mockResolvedValue({
    ...status,
    running: true,
    config: { ...status.config, relay, externalOrigin: "https://device.example.com" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  const input = screen.getByLabelText("External HTTPS origin") as HTMLInputElement;
  expect(input.value).toBe("https://device.example.com");
  expect(input.readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await act(async () => {});
  expect(request).toHaveBeenCalledWith({
    operation: "configure",
    ...status.config,
    relay,
    port: 1444,
    externalOrigin: "https://device.example.com",
  });
});
it("grants read only by default and keeps send and approval independent", async () => {
  request.mockResolvedValue({
    ...status,
    pending: [{ id: "p", name: "Phone", verification: "1234", expiresAt: Date.now() + 300000 }],
  });
  render(<WebAccessSettings />);
  await screen.findByText("Phone");
  expect(
    screen.getByRole("checkbox", { name: "Allow approvals" }).getAttribute("aria-checked"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow sending" }));
  fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "approve",
      id: "p",
      send: true,
      approve: false,
    }),
  );
});
it("shows binding error and invokes revocation without granting extra permissions", async () => {
  request.mockResolvedValue({
    ...status,
    error: "port_in_use",
    devices: [{ id: "d", name: "Phone", send: false, approve: false, createdAt: Date.now() }],
  });
  render(<WebAccessSettings />);
  expect((await screen.findByRole("alert")).textContent).toContain("This port is in use");
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "d" }));
});

it("does not restore a revoked browser from an older shared poll", async () => {
  vi.useFakeTimers();
  const oldStatus = {
    ...status,
    running: true,
    devices: [{ id: "d", name: "Phone", send: false, approve: false, createdAt: Date.now() }],
  };
  request.mockResolvedValueOnce(oldStatus);
  render(<WebAccessSettings />);
  await act(async () => {});
  expect(screen.getByText("Phone")).toBeTruthy();
  let finishRevoke!: (value: typeof status) => void;
  let finishPoll!: (value: typeof oldStatus) => void;
  request.mockImplementation(
    ({ operation }) =>
      new Promise((resolve) => {
        if (operation === "revoke") finishRevoke = resolve;
        else finishPoll = resolve;
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => finishRevoke(status));
  expect(screen.queryByText("Phone")).toBeNull();
  await act(async () => finishPoll(oldStatus));
  expect(screen.queryByText("Phone")).toBeNull();
  cleanup();
  vi.useRealTimers();
});

it.each(["https://remote.agentkib.com", "https://api.remote.agentkib.com"])(
  "requires explicit migration from %s and a new invitation",
  async (legacyUrl) => {
    request.mockResolvedValue({
      ...status,
      config: {
        ...status.config,
        relay: { enabled: false, brokerUrl: legacyUrl },
      },
    });
    render(<WebAccessSettings />);
    await screen.findByText(/The official connection service address has changed/);
    const advanced = screen.getByText("Advanced connection and permissions");
    fireEvent.click(advanced);
    expect(
      (screen.getByLabelText("Bridge service (official or self-hosted)") as HTMLInputElement).value,
    ).toBe(legacyUrl);
    expect(
      (screen.getByRole("button", { name: "Enable remote access" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Prepare service migration" }));
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    const confirm = screen.getByRole("button", { name: "Confirm migration and enable access" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Invitation (first connection only)"), {
      target: { value: "new-invitation" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
        inviteCode: "new-invitation",
      }),
    );
    expect(request.mock.calls.filter(([input]) => input.operation !== "status")).toHaveLength(1);
  },
);

it("preserves a custom broker and submits one enable command while a request is pending", async () => {
  request.mockResolvedValueOnce({
    ...status,
    config: {
      ...status.config,
      relay: { enabled: false, brokerUrl: "https://bridge.example.com" },
    },
  });
  render(<WebAccessSettings />);
  const enable = await screen.findByRole("button", { name: "Enable remote access" });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  let finish!: (value: typeof status) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(enable);
  fireEvent.click(enable);
  expect(request.mock.calls.filter(([input]) => input.operation === "remote-enable")).toEqual([
    [
      {
        operation: "remote-enable",
        brokerUrl: "https://bridge.example.com",
      },
    ],
  ]);
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
  await act(async () => finish(status));
});

it("shows the public entry only when ready and never rotates pairing codes on polling or reconnect", async () => {
  vi.useFakeTimers();
  const connected = {
    ...status,
    running: true,
    relay: { phase: "ready", publicUrl: "https://device.control.remote.agentkib.com" },
    code: { value: "12345678", expiresAt: Date.now() + 6000 },
  };
  request.mockResolvedValue(connected);
  render(<WebAccessSettings />);
  await act(async () => {});
  expect(screen.getByRole("img", { name: "Open on your phone" })).toBeTruthy();
  expect(screen.getByText("12345678")).toBeTruthy();
  request.mockResolvedValue({ ...connected, relay: { ...connected.relay, phase: "offline" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
  expect(screen.queryByText("12345678")).toBeNull();
  request.mockResolvedValue(connected);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(screen.getByRole("img", { name: "Open on your phone" })).toBeTruthy();
  expect(screen.queryByText("12345678")).toBeNull();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Generate 8-digit pairing code" }));
  await act(async () => {});
  expect(request).toHaveBeenCalledWith({ operation: "generate-code" });
});

it("keeps advanced controls hidden and translates all primary actions in four languages", async () => {
  const { remoteEntryCopy } = await import("./remote-entry-copy");
  render(<WebAccessSettings />);
  await screen.findByRole("button", { name: "Enable remote access" });
  expect(
    screen
      .getByRole("button", { name: "Advanced connection and permissions" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("switch", { name: "Enable local Web service" })).toBeNull();
  try {
    for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
      await act(() => changeLocale(locale));
      const copy = remoteEntryCopy[locale];
      expect(screen.getByRole("button", { name: copy.enable })).toBeTruthy();
      expect(screen.getByRole("button", { name: copy.pause })).toBeTruthy();
      expect(screen.getByText(copy.advanced)).toBeTruthy();
    }
  } finally {
    await act(() => changeLocale("en-US"));
  }
});

it("shows a durable save error without exposing a public entry", async () => {
  request.mockResolvedValue({ ...status, error: "web_state_save_failed" });
  render(<WebAccessSettings />);
  expect((await screen.findByRole("alert")).textContent).toContain("Settings could not be saved");
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
});

it("keeps manual pairing inside advanced settings without exposing an unready relay code", async () => {
  vi.useFakeTimers();
  const manual = {
    ...status,
    running: true,
    config: { ...status.config, enabled: true, externalOrigin: "https://manual.example.com" },
    code: { value: "24681357", expiresAt: Date.now() + 60000 },
  };
  request.mockResolvedValue(manual);
  render(<WebAccessSettings />);
  await act(async () => {});
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
  expect(screen.getByText("24681357").closest("[hidden]")).not.toBeNull();
  fireEvent.click(screen.getByText("Advanced connection and permissions"));
  expect(screen.getByText(/Local or manually configured access/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Generate 8-digit pairing code" }));
  await act(async () => {});
  expect(request).toHaveBeenCalledWith({ operation: "generate-code" });
  request.mockResolvedValue({
    ...manual,
    config: {
      ...manual.config,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "connecting" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByText("24681357")).toBeNull();
  expect(screen.queryByRole("button", { name: "Generate 8-digit pairing code" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
});

it("marks a ready connection enabled and restores setup only after changing its service or connector", async () => {
  request.mockResolvedValue({
    ...status,
    running: true,
    config: {
      ...status.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://device.control.remote.agentkib.com" },
  });
  render(<WebAccessSettings />);
  const enabled = await screen.findByRole("button", { name: "Remote access is enabled" });
  expect((enabled as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByLabelText("Invitation (first connection only)")).toBeNull();
  expect(screen.getByRole("img", { name: "Open on your phone" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Pause public access" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByText("Advanced connection and permissions"));
  const connector = screen.getByLabelText("Custom frpc executable (optional)");
  fireEvent.change(connector, { target: { value: "/tmp/custom-frpc" } });
  expect(screen.getByLabelText("Invitation (first connection only)")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Enable remote access" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.change(connector, { target: { value: "" } });
  expect(screen.queryByLabelText("Invitation (first connection only)")).toBeNull();
  fireEvent.change(screen.getByLabelText("Bridge service (official or self-hosted)"), {
    target: { value: "https://bridge.example.com" },
  });
  expect(screen.getByLabelText("Invitation (first connection only)")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Enable remote access" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});

it("shows code-only full access without confirmation or per-workspace grants for new browsers", async () => {
  request.mockResolvedValue({
    ...status,
    pairingMode: "code",
    workspaces: [{ id: "workspace", name: "Private project", path: "/tmp/project" }],
    devices: [{ id: "full", name: "Trusted phone", accessMode: "full", send: true, approve: true }],
  });
  render(<WebAccessSettings />);
  expect(await screen.findByText("Trusted phone")).toBeTruthy();
  expect(screen.getByText("Full remote access")).toBeTruthy();
  expect(screen.getByText(/authorizes all AgentKib workspaces at the selected level/)).toBeTruthy();
  expect(screen.queryByText("Pending browsers")).toBeNull();
  fireEvent.click(screen.getByText("Advanced connection and permissions"));
  expect(screen.queryByRole("checkbox", { name: "Private project" })).toBeNull();
  expect(screen.queryByRole("switch", { name: /Enable experimental controls/ })).toBeNull();
  expect(
    screen.getByLabelText("Additional read-only directories (one absolute path per line)"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "full" }));
});

it("generates a read-only code and changes an authorized device's access level", async () => {
  const user = userEvent.setup();
  request.mockResolvedValue({
    ...status,
    config: { ...status.config, enabled: true },
    running: true,
    pairingMode: "code",
    devices: [
      {
        id: "tablet",
        name: "Tablet",
        accessMode: "full",
        accessLevel: "read",
        send: false,
        approve: false,
        files: true,
      },
    ],
  });
  render(<WebAccessSettings />);
  expect(await screen.findByText("Tablet")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Access level: Tablet" }).textContent).toContain(
    "Read-only (sessions and files)",
  );

  await user.click(screen.getByText("Advanced connection and permissions"));
  await user.click(screen.getByRole("combobox", { name: "Access level" }));
  await user.click(await screen.findByRole("option", { name: "Read-only (sessions and files)" }));
  await user.click(screen.getByRole("button", { name: "Generate 8-digit access code" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "read" }),
  );

  await user.click(screen.getByRole("combobox", { name: "Access level: Tablet" }));
  await user.click(await screen.findByRole("option", { name: "Full remote access" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ operation: "set-access", id: "tablet", access: "full" }),
  );
});

it("hides an expired pairing code at its deadline without a per-second clock", async () => {
  vi.useFakeTimers();
  const setInterval = vi.spyOn(window, "setInterval");
  const expiresAt = Date.now() + 5_000;
  request.mockResolvedValue({
    ...status,
    config: { ...status.config, enabled: true },
    running: true,
    pairingMode: "code",
    code: { value: "12345678", expiresAt, access: "full" },
  });
  render(<WebAccessSettings />);
  await act(async () => {});
  expect(screen.getByText("12345678")).toBeTruthy();
  expect(setInterval).not.toHaveBeenCalledWith(expect.any(Function), 1000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.queryByText("12345678")).toBeNull();
});

it("re-arms the deadline timer when it fires before the pairing code expires", async () => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 5_000;
  request.mockResolvedValue({
    ...status,
    config: { ...status.config, enabled: true },
    running: true,
    pairingMode: "code",
    code: { value: "12345678", expiresAt, access: "full" },
  });
  render(<WebAccessSettings />);
  await act(async () => {});
  // 系统时钟回拨 2 秒：计时器按原定 5 秒触发时，Date.now() 仍早于截止时间。
  vi.setSystemTime(Date.now() - 2_000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.getByText("12345678")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.queryByText("12345678")).toBeNull();
});

it("keeps legacy grant settings explicitly separate on code-only hosts", async () => {
  request.mockResolvedValue({
    ...status,
    pairingMode: "code",
    devices: [{ id: "legacy", name: "Old phone", send: false, approve: false }],
    workspaces: [{ id: "workspace", name: "Private project", path: "/tmp/project" }],
  });
  render(<WebAccessSettings />);
  await screen.findByText("Old phone");
  fireEvent.click(screen.getByText("Advanced connection and permissions"));
  expect(screen.getByText("Legacy browser permissions")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Private project" })).toBeTruthy();
  expect(screen.queryByText("Full remote access")).toBeNull();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "configure" }));
});

it("explains full code grants in all four locales without changing LAN pairing", async () => {
  const { webSettingsCopy } = await import("./web-settings-copy");
  const { remoteEntryCopy } = await import("./remote-entry-copy");
  request.mockResolvedValue({ ...status, pairingMode: "code" });
  try {
    for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
      await act(() => changeLocale(locale));
      const view = render(<WebAccessSettings />);
      expect(await screen.findByText(webSettingsCopy[locale].codeScope)).toBeTruthy();
      expect(screen.getByText(remoteEntryCopy[locale].codeInstructions)).toBeTruthy();
      expect(screen.queryByText(webSettingsCopy[locale].pending)).toBeNull();
      view.unmount();
    }
  } finally {
    await act(() => changeLocale("en-US"));
  }
  request.mockResolvedValue({
    ...status,
    pairingMode: "confirmation",
    pending: [
      {
        id: "lan-pending",
        name: "LAN phone",
        verification: "12345678",
        expiresAt: Date.now() + 300000,
      },
    ],
  });
  render(<WebAccessSettings target="lan" />);
  expect(await screen.findByText("LAN phone")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Authorize" })).toBeTruthy();
  expect(screen.queryByText(webSettingsCopy["en-US"].codeScope)).toBeNull();
});
