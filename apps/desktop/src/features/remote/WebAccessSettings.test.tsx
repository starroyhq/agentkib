// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import { WebAccessSettings } from "./WebAccessSettings";
import { remotePhoneCopy } from "./remote-phone-copy";
import { remotePageCopy } from "./remote-page-copy";
const request = vi.fn();
let lanTest = false;
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    web: {
      request: (input: { target?: string }) =>
        input.target === "lan" && !lanTest
          ? Promise.resolve({ ...status, mode: "lan", addresses: [] })
          : request(input),
    },
    account: {
      onStatus: () => () => {},
      request: () =>
        Promise.resolve({
          phase: "signed-in",
          secureStorage: true,
          account: {
            id: "test",
            username: "demo@example.com",
            deviceLimit: 3,
            deviceCount: 1,
            totpEnabled: false,
          },
          device: { ownership: "owned" },
        }),
    },
  }),
}));
const status = {
  config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
  running: false,
  localUrl: "http://127.0.0.1:1421",
  pending: [],
  devices: [],
};
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  lanTest = false;
  request.mockReset();
  request.mockResolvedValue(status);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Opens the advanced dialog from the page button (real timers). */
async function openAdvanced() {
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  return await screen.findByRole("dialog", { name: "Advanced settings" });
}
/** Expands the "More settings" collapsible that holds the local Web service form. */
function expandMore(name = "More settings") {
  // The trigger's name also carries its "Local Web service" side label.
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
}

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "names both controlled Agents in task permissions in %s",
  async (locale) => {
    const { webSettingsCopy } = await import("./web-settings-copy");
    request.mockResolvedValue({
      ...status,
      devices: [{ id: "d", name: "Phone", manage: true, createdAt: Date.now() }],
    });
    await act(() => changeLocale(locale));
    try {
      render(<WebAccessSettings />);
      const label = webSettingsCopy[locale].manage;
      expect(label).toContain("Codex");
      expect(label).toContain("Claude Code");
      expect(
        await screen.findByText(
          (_, element) => element?.tagName === "SMALL" && !!element.textContent?.includes(label),
        ),
      ).toBeVisible();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  },
);

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
// Re-scoped: the advanced settings are a dialog now. Closing it (Escape) is "Cancel" and discards
// drafts, so this protects keyboard opening, focus return and that nothing is sent.
it("supports keyboard access to advanced settings and discards unsaved values when it is closed", async () => {
  const user = userEvent.setup();
  render(<WebAccessSettings />);
  const trigger = await screen.findByRole("button", {
    name: "Advanced settings",
  });
  trigger.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("dialog", { name: "Advanced settings" })).toBeVisible();
  await user.click(screen.getByRole("radio", { name: /^Self-hosted/ }));
  fireEvent.change(screen.getByLabelText("Service address"), {
    target: { value: "https://self-hosted.example.com" },
  });
  expect(screen.getByLabelText("Service address")).toHaveValue("https://self-hosted.example.com");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("checkbox", { name: "Enable local Web service" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  await screen.findByRole("dialog", { name: "Advanced settings" });
  expect(screen.getByRole("radio", { name: /^Official/ })).toBeChecked();
  expect(screen.queryByLabelText("Service address")).toBeNull();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});
it("does not enable service until settings are saved", async () => {
  render(<WebAccessSettings />);
  await openAdvanced();
  expandMore();
  const toggle = await screen.findByRole("checkbox", { name: "Enable local Web service" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "configure",
      ...status.config,
      enabled: true,
    }),
  );
});
// The connect dialog turns remote access on by itself once per opening: no extra click.
it("connects with the default service and bundled connector without an invitation or binary path", async () => {
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect phone" }));
  await screen.findByRole("dialog", { name: "Connect phone" });
  expect(screen.queryByLabelText(/invitation/i)).toBeNull();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
    }),
  );
  expect(request.mock.calls.filter(([input]) => input.operation === "remote-enable")).toHaveLength(
    1,
  );
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
  fireEvent.click(await screen.findByRole("button", { name: "Connection diagnostics" }));
  expect(await screen.findByText("Preview public probe: Connection timed out")).toBeTruthy();
  expect(screen.getByText(/Next retry:/)).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
});
it("keeps multiline directory drafts intact and grants them only on save", async () => {
  render(<WebAccessSettings />);
  await openAdvanced();
  expandMore();
  const input = await screen.findByLabelText(
    "Additional read-only directories (one absolute path per line)",
  );
  fireEvent.change(input, { target: { value: "/tmp/reports\n" } });
  expect((input as HTMLTextAreaElement).value).toBe("/tmp/reports\n");
  fireEvent.change(input, { target: { value: "/tmp/reports\n/tmp/media" } });
  expect(request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  await act(async () => {});
  expandMore();
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
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
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
  await screen.findByRole("button", { name: "Authorize" });
  expect(screen.getByText("Phone", { selector: "strong" })).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
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
  expect(screen.getByText("Phone", { selector: "strong" })).toBeTruthy();
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
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => finishRevoke(status));
  expect(screen.queryByText("Phone", { selector: "strong" })).toBeNull();
  await act(async () => finishPoll(oldStatus));
  expect(screen.queryByText("Phone", { selector: "strong" })).toBeNull();
  cleanup();
  vi.useRealTimers();
});

it.each(["https://remote.agentkib.com", "https://api.remote.agentkib.com"])(
  "requires explicit account migration from %s without an invitation",
  async (legacyUrl) => {
    request.mockResolvedValue({
      ...status,
      config: {
        ...status.config,
        relay: { enabled: false, brokerUrl: legacyUrl },
      },
    });
    render(<WebAccessSettings />);
    expect(await screen.findByRole("button", { name: "Resume" })).toBeDisabled();
    await openAdvanced();
    await screen.findByText(/The official connection service address has changed/);
    // A retired address is neither choice until its migration is prepared.
    expect(screen.getByRole("radio", { name: /^Official/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^Self-hosted/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Prepare service migration" }));
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    const confirm = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.queryByLabelText(/invitation/i)).toBeNull();
    fireEvent.click(confirm);
    const dialog = await screen.findByRole("dialog", { name: "Apply connection settings" });
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply connection settings" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://api.agentkib.com",
      }),
    );
    expect(request.mock.calls.filter(([input]) => input.operation !== "status")).toHaveLength(1);
  },
);

// The saved setup is paused here, so the page offers "Resume" with the saved broker.
it("preserves a custom broker and submits one enable command while a request is pending", async () => {
  request.mockResolvedValueOnce({
    ...status,
    config: {
      ...status.config,
      relay: { enabled: false, brokerUrl: "https://bridge.example.com" },
    },
  });
  render(<WebAccessSettings />);
  const enable = await screen.findByRole("button", { name: "Resume" });
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

// The relay is enabled in the saved config (as it is whenever it reports ready) so the page
// offers "Connect a new phone"; the code lives 60 s so it outlasts the simulated outage.
it("shows the public entry only when ready and never rotates pairing codes on polling or reconnect", async () => {
  vi.useFakeTimers();
  const connected = {
    ...status,
    running: true,
    config: {
      ...status.config,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://device.control.remote.agentkib.com" },
    code: { value: "12345678", expiresAt: Date.now() + 60_000 },
  };
  request.mockResolvedValue(connected);
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Connect a new phone" }));
  await act(async () => {});
  expect(screen.getByRole("img", { name: "Open on your phone" })).toBeTruthy();
  expect(screen.getByText("1234 5678")).toBeTruthy();
  request.mockResolvedValue({ ...connected, relay: { ...connected.relay, phase: "offline" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
  expect(screen.queryByText("1234 5678")).toBeNull();
  request.mockResolvedValue(connected);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  // Back online the same, still valid code is shown again; nothing was regenerated.
  expect(screen.getByText("1234 5678")).toBeTruthy();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
  await act(async () => {});
  expect(request).toHaveBeenCalledWith({ operation: "generate-code" });
});

it("keeps advanced controls hidden and translates all primary actions in four languages", async () => {
  render(<WebAccessSettings />);
  await screen.findByRole("button", { name: remotePageCopy["en-US"].connectPhone });
  expect(screen.getByRole("button", { name: "Advanced settings" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Enable local Web service" })).toBeNull();
  try {
    for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
      await act(() => changeLocale(locale));
      expect(
        screen.getByRole("button", { name: remotePageCopy[locale].connectPhone }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: remotePhoneCopy[locale].pause })).toBeNull();
      expect(screen.getByRole("button", { name: remotePhoneCopy[locale].advanced })).toBeTruthy();
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
  // The advanced dialog is not mounted while closed, so the manual code is nowhere on the page.
  expect(screen.queryByText("24681357")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  await act(async () => {});
  expandMore();
  expect(screen.getByText(/Local or manually configured access/)).toBeTruthy();
  expect(screen.getByText("24681357")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
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
  expect(screen.queryByRole("button", { name: "Generate pairing code" })).toBeNull();
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
  // The connection state now lives in the connect-phone dialog.
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect phone" }));
  await act(async () => {});
  expect(screen.getByText("Connecting")).toBeVisible();
  expect(screen.queryByRole("img", { name: "Open on your phone" })).toBeNull();
});

// Re-scoped: the connector path is saved with the dialog's single "Save" (no separate Apply).
it("keeps completed connection setup stable while connector changes need an explicit application", async () => {
  request.mockResolvedValue({
    ...status,
    running: true,
    config: {
      ...status.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://device.example.com" },
  });
  render(<WebAccessSettings />);
  expect(await screen.findByLabelText("Authorized browsers 0", {}).catch(() => null)).toBeNull();
  expect(await screen.findByText("No authorized browsers yet")).toBeVisible();
  await openAdvanced();
  expandMore();
  const apply = screen.getByRole("button", { name: "Save" });
  expect(apply).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Custom frpc executable (optional)"), {
    target: { value: "/tmp/custom-frpc" },
  });
  expect(apply).toBeEnabled();
  expect(screen.getByText("No authorized browsers yet")).toBeVisible();
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
  expect(screen.getByText("Full control")).toBeTruthy();
  expect(screen.queryByText(/authorizes all AgentKib workspaces at the selected level/)).toBeNull();
  expect(screen.getByLabelText("Authorized browsers 1")).toBeVisible();
  expect(screen.queryByText("Pending browsers")).toBeNull();
  await openAdvanced();
  expandMore();
  expect(screen.queryByRole("checkbox", { name: "Private project" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: /Enable experimental controls/ })).toBeNull();
  expect(
    screen.getByLabelText("Additional read-only directories (one absolute path per line)"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "revoke", id: "full" }));
});

it.each([
  ["zh-CN", "完整控制", "生成授权码", "授权档位"],
  ["zh-TW", "完整控制", "產生授權碼", "授權等級"],
  ["en-US", "Full control", "Generate access code", "Access level"],
  ["ja-JP", "フルコントロール", "認証コードを生成", "アクセスレベル"],
] as const)(
  "uses the approved remote terms while keeping full grants unchanged in %s",
  async (locale, fullControl, generate, level) => {
    request.mockResolvedValue({
      ...status,
      config: { ...status.config, enabled: true },
      running: true,
      pairingMode: "code",
    });
    await act(() => changeLocale(locale));
    try {
      render(<WebAccessSettings />);
      fireEvent.click(
        await screen.findByRole("button", { name: remotePhoneCopy[locale].advanced }),
      );
      expandMore(remotePageCopy[locale].moreSettings);
      expect(await screen.findByRole("combobox", { name: level })).toHaveTextContent(fullControl);
      fireEvent.click(screen.getByRole("button", { name: generate }));
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "full" }),
      );
      expect(
        request.mock.calls.every(([body]) => ["status", "generate-code"].includes(body.operation)),
      ).toBe(true);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  },
);

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

  await openAdvanced();
  await user.click(screen.getByRole("button", { name: /^More settings/ }));
  await user.click(screen.getByRole("combobox", { name: "Access level" }));
  await user.click(await screen.findByRole("option", { name: "Read-only (sessions and files)" }));
  await user.click(screen.getByRole("button", { name: "Generate access code" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "read" }),
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await user.click(screen.getByRole("combobox", { name: "Access level: Tablet" }));
  await user.click(await screen.findByRole("option", { name: "Full control" }));
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
    config: {
      ...status.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    running: true,
    pairingMode: "code",
    relay: { phase: "ready", publicUrl: "https://device.example.com" },
    code: { value: "12345678", expiresAt, access: "full" },
  });
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Connect a new phone" }));
  await act(async () => {});
  expect(screen.getByText("1234 5678")).toBeTruthy();
  expect(setInterval).not.toHaveBeenCalledWith(expect.any(Function), 1000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.queryByText("1234 5678")).toBeNull();
  // The code that was showing counts as this opening's code: expiry waits for "Regenerate".
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "generate-code" }));
  expect(screen.getByRole("button", { name: "Generate access code" })).toBeEnabled();
});

it("re-arms the deadline timer when it fires before the pairing code expires", async () => {
  vi.useFakeTimers();
  const expiresAt = Date.now() + 5_000;
  request.mockResolvedValue({
    ...status,
    config: {
      ...status.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    running: true,
    pairingMode: "code",
    relay: { phase: "ready", publicUrl: "https://device.example.com" },
    code: { value: "12345678", expiresAt, access: "full" },
  });
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Connect a new phone" }));
  await act(async () => {});
  // 系统时钟回拨 2 秒：计时器按原定 5 秒触发时，Date.now() 仍早于截止时间。
  vi.setSystemTime(Date.now() - 2_000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.getByText("1234 5678")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(screen.queryByText("1234 5678")).toBeNull();
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
  await openAdvanced();
  expandMore();
  expect(screen.getByText("Legacy browser permissions")).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Private project" })).toBeTruthy();
  expect(screen.queryByText("Full control")).toBeNull();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "configure" }));
});

it("explains full code grants in all four locales without changing LAN pairing", async () => {
  const { webSettingsCopy } = await import("./web-settings-copy");
  const { remoteEntryCopy } = await import("./remote-entry-copy");
  request.mockResolvedValue({ ...status, pairingMode: "code" });
  try {
    for (const locale of ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const) {
      await act(() => changeLocale(locale));
      const view = render(<WebAccessSettings />);
      expect(
        await screen.findByRole("heading", { name: remotePageCopy[locale].phone }),
      ).toBeTruthy();
      expect(screen.queryByText(webSettingsCopy[locale].codeScope)).toBeNull();
      expect(screen.queryByText(remoteEntryCopy[locale].codeInstructions)).toBeNull();
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
  lanTest = true;
  render(<WebAccessSettings target="lan" />);
  expect(await screen.findByText("LAN phone")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Authorize" })).toBeTruthy();
  expect(screen.queryByText(webSettingsCopy["en-US"].codeScope)).toBeNull();
});

it("shows the experimental-control warning in the selected locale without mixed Chinese scripts", async () => {
  const warnings = {
    "zh-CN":
      "实验功能仅在通过验证的这台电脑与会话上可用；停止仅表示中断当前轮次，不保证后台命令已结束。",
    "zh-TW":
      "實驗功能僅在通過驗證的這台電腦與對話上可用；停止僅表示中斷目前輪次，不保證背景命令已結束。",
    "en-US":
      "Experimental controls require a verified computer and session. Stopping interrupts a turn; background commands may still run.",
    "ja-JP":
      "実験的な操作は検証済みのこのコンピューターと会話のみで利用できます。停止は現在のターンを中断しますが、バックグラウンドコマンドの終了を保証するものではありません。",
  };
  request.mockResolvedValue({ ...status, experimentalAvailable: true });
  await act(() => changeLocale("en-US"));
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: remotePhoneCopy["en-US"].advanced }));
  expandMore();
  try {
    for (const locale of ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const) {
      await act(() => changeLocale(locale));
      expect(await screen.findByText(warnings[locale])).toBeVisible();
    }
    expect(request.mock.calls.every(([body]) => body.operation === "status")).toBe(true);
  } finally {
    await act(() => changeLocale("en-US"));
  }
});

// Re-scoped: unsaved notices render inside the open advanced dialog (outside its "More settings"
// section); Save closes the dialog and the page then reports the saved state.
it("keeps unsaved settings visible outside advanced controls and saves once while every editable field is locked", async () => {
  const user = userEvent.setup();
  render(<WebAccessSettings />);
  await openAdvanced();
  expandMore();
  const toggle = screen.getByRole("checkbox", { name: "Enable local Web service" });
  const directories = screen.getByLabelText(
    "Additional read-only directories (one absolute path per line)",
  );
  fireEvent.click(toggle);
  fireEvent.change(directories, { target: { value: "/tmp/reports\n" } });
  // The advanced window's Save is the cue; the "Save settings" hint is only for the LAN window.
  expect(
    screen.queryByText("These settings take effect after choosing “Save settings”."),
  ).toBeNull();
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  expandMore();
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  expandMore();

  let finish!: (value: typeof status) => void;
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.click(save);
  fireEvent.click(save);
  expect(request.mock.calls.filter(([input]) => input.operation === "configure")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Saving settings…" })).toBeDisabled();
  expect(directories).toBeDisabled();
  for (const radio of screen.getAllByRole("radio"))
    expect(radio).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByLabelText("Custom frpc executable (optional)")).toBeDisabled();
  expect(screen.getByLabelText("Preview bandwidth (KiB/s; save settings to apply)")).toBeDisabled();
  expect(screen.queryByLabelText(/invitation/i)).toBeNull();
  await user.type(directories, "/tmp/not-granted");
  expect(directories).toHaveValue("/tmp/reports\n");
  const savedStatus = {
    ...status,
    config: {
      ...status.config,
      enabled: true,
      extraRoots: [{ id: "extra-0", name: "reports", path: "/tmp/reports" }],
    },
  };
  await act(async () => finish(savedStatus));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  expect(screen.getByText("Settings saved.")).toBeVisible();
  await openAdvanced();
  expandMore();
  const reopened = screen.getByLabelText(
    "Additional read-only directories (one absolute path per line)",
  );
  expect(reopened).toHaveValue("/tmp/reports");
  expect(reopened).toBeEnabled();
});

it("preserves save failure and the draft across a recovered poll, then clears them only after a successful save", async () => {
  vi.useFakeTimers();
  const active = { ...status, running: true };
  request.mockResolvedValue(active);
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  await act(async () => {});
  expandMore();
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  request.mockRejectedValueOnce(new Error("save failed"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(screen.getByLabelText("Port")).toHaveValue(1444);
  // An in-memory server snapshot is not evidence that a failed disk write succeeded.
  request.mockResolvedValue({ ...active, config: { ...active.config, port: 1444 } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  expect(screen.getByText("Settings saved.")).toBeVisible();
  expect(request.mock.calls.filter(([input]) => input.operation === "configure")).toHaveLength(2);
});

it("offers an explicit retry after the initial settings load fails", async () => {
  request.mockRejectedValueOnce(new Error("offline"));
  render(<WebAccessSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Web settings unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  await openAdvanced();
  expandMore();
  expect(screen.getByLabelText("Port")).toHaveValue(1421);
  expect(request.mock.calls).toEqual([[{ operation: "status" }], [{ operation: "status" }]]);
});

it("keeps directory edits and a single visible error when saving returns an explicit failure status", async () => {
  render(<WebAccessSettings />);
  await openAdvanced();
  expandMore();
  const directories = screen.getByLabelText(
    "Additional read-only directories (one absolute path per line)",
  );
  fireEvent.change(directories, { target: { value: "/tmp/reports\n" } });
  request.mockResolvedValue({ ...status, error: "web_state_save_failed" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be saved");
  expect(directories).toHaveValue("/tmp/reports\n");
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

// Re-scoped: a remote-enable can no longer run while advanced drafts are open apart from the
// dialog's own "Save", which saves the local drafts first and then applies the connection change.
it("retains unrelated setting and directory drafts when remote enable updates the running configuration", async () => {
  render(<WebAccessSettings />);
  await openAdvanced();
  expandMore();
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  fireEvent.change(
    screen.getByLabelText("Additional read-only directories (one absolute path per line)"),
    {
      target: { value: "/tmp/reports" },
    },
  );
  fireEvent.change(screen.getByLabelText("Custom frpc executable (optional)"), {
    target: { value: "/tmp/custom-frpc" },
  });
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "configure",
      ...status.config,
      port: 1444,
      extraRoots: [{ id: "extra-0", name: "reports", path: "/tmp/reports" }],
    }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
      frpcPath: "/tmp/custom-frpc",
    }),
  );
  const calls = request.mock.calls.map(([input]) => input.operation);
  expect(calls.indexOf("configure")).toBeLessThan(calls.indexOf("remote-enable"));
});

it("refreshes untouched fields but preserves edited ports and an intentionally cleared connector path", async () => {
  vi.useFakeTimers();
  const active = {
    ...status,
    running: true,
    config: {
      ...status.config,
      relay: { enabled: true, brokerUrl: "https://bridge.example.com", frpcPath: "/tmp/frpc" },
    },
    relay: { phase: "offline" },
  };
  request.mockResolvedValue(active);
  render(<WebAccessSettings />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Advanced settings" }));
  await act(async () => {});
  expandMore();
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  fireEvent.change(screen.getByLabelText("Custom frpc executable (optional)"), {
    target: { value: "" },
  });
  request.mockResolvedValue({
    ...active,
    config: {
      ...active.config,
      enabled: true,
      port: 1555,
      relay: { ...active.config.relay, brokerUrl: "https://new.example.com" },
    },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByLabelText("Port")).toHaveValue(1444);
  expect(screen.getByRole("checkbox", { name: "Enable local Web service" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.getByLabelText("Service address")).toHaveValue("https://new.example.com");
  expect(screen.getByLabelText("Custom frpc executable (optional)")).toHaveValue("");
  expect(screen.getByText("Unsaved changes")).toBeVisible();
});

// Re-scoped: pausing is in the page's "More actions" menu, which is unreachable while the
// advanced dialog (the only holder of drafts) is open. Pause first, then check the paused
// snapshot reaches the advanced form without any configure request.
it("retains an edited port while pausing remote access updates only the saved relay and origin", async () => {
  const connected = {
    ...status,
    running: true,
    config: {
      ...status.config,
      enabled: true,
      externalOrigin: "https://device.example.com",
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://device.example.com" },
  };
  request.mockResolvedValue(connected);
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "More actions" }));
  request.mockResolvedValue({
    ...connected,
    config: {
      ...connected.config,
      externalOrigin: "",
      relay: { ...connected.config.relay, enabled: false },
    },
    relay: { phase: "disabled" },
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Pause remote access" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm pause" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "relay-stop" }));
  await screen.findByRole("button", { name: "Resume" });
  await openAdvanced();
  expandMore();
  await waitFor(() => expect(screen.getByLabelText("External HTTPS origin")).toHaveValue(""));
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  expect(screen.getByLabelText("Port")).toHaveValue(1444);
  expect(screen.getByText("Unsaved changes")).toBeVisible();
  expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ operation: "configure" }));
});

// Re-scoped: while the service or relay is not ready the connect dialog never offers a code, it
// stays on the "turning on" step (the old explanatory hint no longer exists). Nothing is sent.
it.each([
  { running: false, phase: "disabled" },
  { running: true, phase: "connecting" },
  { running: false, phase: "ready" },
])(
  "explains code generation while running=$running and relay=$phase without sending a request",
  async ({ running, phase }) => {
    request.mockResolvedValue({
      ...status,
      pairingMode: "code",
      running,
      config: { ...status.config, relay: { enabled: true, brokerUrl: "https://api.agentkib.com" } },
      relay: { phase },
    });
    render(<WebAccessSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect phone" }));
    await screen.findByText("Turning on remote access…");
    expect(screen.queryByRole("button", { name: "Generate access code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull();
    expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  },
);

// Re-scoped: the dialog turns remote access on and then asks for the code by itself.
it("enables code generation only after the service and remote connection become ready", async () => {
  request.mockResolvedValue({ ...status, pairingMode: "code" });
  render(<WebAccessSettings />);
  const connect = await screen.findByRole("button", { name: "Connect phone" });
  expect(screen.queryByRole("button", { name: "Generate access code" })).toBeNull();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  const connected = {
    ...status,
    pairingMode: "code",
    running: true,
    config: {
      ...status.config,
      enabled: true,
      relay: { enabled: true, brokerUrl: "https://api.agentkib.com" },
    },
    relay: { phase: "ready", publicUrl: "https://device.example.com" },
  };
  request.mockResolvedValue(connected);
  fireEvent.click(connect);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "remote-enable",
      brokerUrl: "https://api.agentkib.com",
    }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({ operation: "generate-code", access: "full" }),
  );
  expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
});

// The error step shows reason and retry time; engineering details stay behind the toggle.
it("keeps relay phase and retry guidance visible while engineering details require keyboard expansion", async () => {
  const user = userEvent.setup();
  request.mockResolvedValue({
    ...status,
    config: { ...status.config, relay: { enabled: true, brokerUrl: "https://api.agentkib.com" } },
    relay: {
      phase: "offline",
      reason: "connector",
      error: "internal-connector-text",
      failure: { stage: "preview-probe", code: "timeout" },
      connectorExit: { code: 17, signal: "SIGTERM" },
      channels: { control: true, preview: false },
      retryAt: Date.now() + 60_000,
    },
  });
  render(<WebAccessSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect phone" }));
  const diagnostics = await screen.findByRole("button", { name: "Connection diagnostics" });
  expect(screen.getByText(/Connector unavailable; retrying/)).toBeVisible();
  expect(screen.getByText(/Next retry:/)).toBeVisible();
  expect(screen.queryByText("Preview public probe: Connection timed out")).not.toBeInTheDocument();
  expect(screen.queryByText(/Process exit code/)).not.toBeInTheDocument();
  expect(screen.queryByText("internal-connector-text")).not.toBeInTheDocument();
  diagnostics.focus();
  await user.keyboard("{Enter}");
  expect(screen.getByText("Preview public probe: Connection timed out")).toBeVisible();
  expect(screen.getByText(/Process exit code: 17/)).toBeVisible();
  expect(screen.getByText(/Process termination signal: SIGTERM/)).toBeVisible();
  expect(screen.getByText(/Control：✓/)).toBeVisible();
  diagnostics.focus();
  await user.keyboard(" ");
  expect(screen.queryByText(/Process exit code/)).not.toBeInTheDocument();
  expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});

// Re-scoped: one "Save" in the advanced dialog applies the connection change; the dialog stays
// open on failure and closes after the retry succeeds, so the cleared invitation is checked on
// reopening.
it("retains a self-hosted invitation after registration fails and permits an explicit retry", async () => {
  const user = userEvent.setup();
  render(<WebAccessSettings />);
  await openAdvanced();
  await user.click(screen.getByRole("radio", { name: /^Self-hosted/ }));
  fireEvent.change(screen.getByLabelText("Service address"), {
    target: { value: "https://self-hosted.example.com" },
  });
  const invitation = screen.getByLabelText("Self-hosted service invitation (if required)");
  fireEvent.change(invitation, { target: { value: "new-invitation" } });
  request.mockRejectedValueOnce(new Error("failed"));
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Web settings unavailable");
  expect(invitation).toHaveValue("new-invitation");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await openAdvanced();
  expect(screen.getByLabelText("Self-hosted service invitation (if required)")).toHaveValue("");
  expect(request.mock.calls.filter(([input]) => input.operation === "remote-enable")).toHaveLength(
    2,
  );
  expect(request).toHaveBeenCalledWith({
    operation: "remote-enable",
    brokerUrl: "https://self-hosted.example.com",
    inviteCode: "new-invitation",
  });
});

it.each([
  { locale: "zh-CN", unsaved: "有未保存的更改" },
  { locale: "zh-TW", unsaved: "有尚未儲存的變更" },
  { locale: "en-US", unsaved: "Unsaved changes" },
  { locale: "ja-JP", unsaved: "未保存の変更があります" },
] as const)(
  "renders setting state, disable reasons and distinct code purposes in $locale",
  async ({ locale, unsaved }) => {
    const { webSettingsCopy } = await import("./web-settings-copy");
    const { remoteEntryCopy } = await import("./remote-entry-copy");
    const c = webSettingsCopy[locale];
    request.mockResolvedValue({
      ...status,
      pairingMode: "code",
      relay: { phase: "offline", failure: { stage: "broker", code: "timeout" } },
    });
    await act(() => changeLocale(locale));
    try {
      const view = render(<WebAccessSettings />);
      await screen.findByRole("heading", { name: remotePageCopy[locale].phone });
      expect(screen.queryByRole("button", { name: c.generateAccess })).toBeNull();
      expect(screen.queryByText(c.accessCodeHint)).toBeNull();
      expect(screen.queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
      expect(screen.queryByText(c.invitationCodeHint)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: remotePhoneCopy[locale].advanced }));
      expandMore(remotePageCopy[locale].moreSettings);
      expect(screen.queryByLabelText(remoteEntryCopy[locale].invitation)).toBeNull();
      fireEvent.click(await screen.findByRole("checkbox", { name: c.enabled }));
      expect(screen.getByText(unsaved)).toBeVisible();
      // The advanced window's own Save is the cue; its "Save settings" hint belongs to LAN.
      expect(screen.queryByText(c.saveHint)).toBeNull();
      expect(screen.getByRole("button", { name: remotePageCopy[locale].save })).toBeEnabled();
      view.unmount();
      request.mockResolvedValue({ ...status, pairingMode: "confirmation" });
      lanTest = true;
      render(<WebAccessSettings target="lan" />);
      expect(await screen.findByText(c.pairingCodeHint)).toBeVisible();
      expect(screen.getAllByText(c.saveHint)).toHaveLength(1);
      const { lanSettingsCopy } = await import("./lan-settings-copy");
      expect(
        screen.getByRole("checkbox", { name: lanSettingsCopy[locale].enabled }),
      ).toHaveAccessibleDescription(c.saveHint);
      expect(screen.getByRole("button", { name: c.generate })).toHaveAccessibleDescription(
        c.generateNeedsLanService,
      );
      expect(screen.queryByText(c.invitationCodeHint)).not.toBeInTheDocument();
      expect(request.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  },
);
