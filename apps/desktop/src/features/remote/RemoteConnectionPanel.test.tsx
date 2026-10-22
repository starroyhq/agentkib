// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { RemoteStatus } from "@/core/remote-types";
import { RemoteConnectionPanel, RemoteConnectionSettings } from "./RemoteConnectionPanel";
import { useRemoteStore } from "./remote-store";
import { remoteEntryCopy } from "./remote-entry-copy";
import { QuickConnect } from "./QuickConnect";
import { remoteSettingsCopy } from "./remote-settings-copy";
import { focusSettingsTarget } from "@/features/settings/components/SettingsLayout";

const status: RemoteStatus = {
  local: { id: "local", name: "Desk", enabled: false, address: null },
  interfaces: [{ name: "Wi-Fi", address: "192.168.1.3" }],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const run = vi.fn();
let networkAddress = "192.168.1.3";
let networkBusy = false;
let networkDirty = false;
const saveNetwork = vi.fn();
vi.mock("./RemoteNetworkSettings", () => ({
  useRemoteNetworkSettings: () => ({
    address: networkAddress,
    content: null,
    dirty: networkDirty,
    busy: networkBusy,
    valid: true,
    save: saveNetwork,
  }),
}));
vi.mock("./WebAccessSettings", () => ({
  WebAccessSettings: ({
    children,
    onSaveAdvanced,
    advancedDirty,
    advancedValid,
  }: {
    children?: ReactNode;
    onSaveAdvanced?: () => Promise<boolean>;
    advancedDirty?: boolean;
    advancedValid?: boolean;
  }) => (
    <>
      {children}
      {advancedDirty && (
        <button disabled={!advancedValid} onClick={() => void onSaveAdvanced?.()}>
          Save settings
        </button>
      )}
    </>
  ),
}));
function renderSettings() {
  const view = render(<RemoteConnectionSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
  const setup = screen.queryByRole("button", { name: "Share this computer" });
  if (setup) fireEvent.click(setup);
  return view;
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  networkAddress = "192.168.1.3";
  networkBusy = false;
  networkDirty = false;
  saveNetwork.mockReset().mockResolvedValue(true);
  run.mockReset().mockResolvedValue(null);
  useRemoteStore.setState({
    snapshot: status,
    loading: false,
    busy: false,
    error: "",
    operationError: false,
    pairing: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    run,
  });
});
afterEach(cleanup);

describe("quick connection flow", () => {
  const now = Date.now();
  const pairing = {
    id: "host",
    verification: "123 456",
    status: "pending" as const,
    expires_at: now / 1000 + 300,
  };
  const host = {
    id: "host",
    name: "Laptop",
    address: "192.168.1.5:42987",
    status: "pending" as const,
    last_seen: null,
    error: null,
  };
  async function openManual() {
    const button = screen.getByRole("button", { name: tr("remote.quick.manual") });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
  }
  it("discovers once per opening and keeps manual inputs out of the initial view", async () => {
    const { rerender } = render(<QuickConnect now={now} onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(tr("remote.quick.empty"))).toBeTruthy());
    expect(screen.queryByLabelText(tr("remote.address"))).toBeNull();
    expect(screen.queryByText(tr("remote.quick.saved"))).toBeNull();
    await openManual();
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.back") }));
    rerender(<QuickConnect now={now + 2000} onDone={vi.fn()} />);
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.searchAgain") }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
  it("selects a nearby computer, requires eight digits, and returns without pairing", async () => {
    useRemoteStore.setState({ snapshot: { ...status, discovered: [host] } });
    render(<QuickConnect now={now} onDone={vi.fn()} />);
    const device = await screen.findByRole("button", { name: /Laptop/ });
    fireEvent.click(device);
    expect(screen.queryByLabelText(tr("remote.address"))).toBeNull();
    const input = screen.getByLabelText(tr("remote.code"));
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "1234567" } });
    expect(
      (screen.getByRole("button", { name: tr("remote.pair") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: "12345678" } });
    expect(
      (screen.getByRole("button", { name: tr("remote.pair") }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.back") }));
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
  });
  it("shows reconnect success only after the host is authoritatively online", async () => {
    useRemoteStore.setState({
      snapshot: { ...status, connections: [{ ...host, status: "offline" }] },
    });
    run.mockImplementation(async (request) => {
      if (request.operation !== "connect") return null;
      const snapshot: RemoteStatus = { ...status, connections: [{ ...host, status: "online" }] };
      useRemoteStore.setState({ snapshot });
      return snapshot;
    });
    const onDone = vi.fn();
    render(<QuickConnect now={now} onDone={onDone} />);
    const connect = screen.getByRole("button", { name: tr("remote.connect") });
    await waitFor(() => expect((connect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(connect);
    await screen.findByRole("button", { name: tr("remote.quick.done") });
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.done") }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ operation: "connect", id: host.id });
  });
  it("restores pending verification after reopening and tracks rejection without retrying", () => {
    useRemoteStore.setState({ pairing, snapshot: { ...status, connections: [host] } });
    const first = render(<QuickConnect now={now} onDone={vi.fn()} />);
    expect(screen.getByText(pairing.verification)).toBeTruthy();
    first.unmount();
    render(<QuickConnect now={now} onDone={vi.fn()} />);
    expect(screen.getByText(tr("remote.waitApproval"))).toBeTruthy();
    act(() =>
      useRemoteStore.setState({
        snapshot: { ...status, connections: [{ ...host, status: "rejected" }] },
      }),
    );
    expect(screen.getByText(tr("remote.state.rejected"))).toBeTruthy();
    expect(screen.queryByText(pairing.verification)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
  it("expires waiting verification and never reports success before an online snapshot", () => {
    useRemoteStore.setState({ pairing, snapshot: { ...status, connections: [host] } });
    const { rerender } = render(<QuickConnect now={now} onDone={vi.fn()} />);
    expect(screen.queryByRole("button", { name: tr("remote.quick.done") })).toBeNull();
    rerender(<QuickConnect now={now + 301000} onDone={vi.fn()} />);
    expect(screen.getByText(tr("remote.expired"))).toBeTruthy();
    expect(screen.queryByText(pairing.verification)).toBeNull();
    act(() =>
      useRemoteStore.setState({
        snapshot: { ...status, connections: [{ ...host, status: "online" }] },
      }),
    );
    expect(screen.getByRole("button", { name: tr("remote.quick.done") })).toBeTruthy();
  });
  it("submits once while pending and does not close or navigate when completion arrives after unmount", async () => {
    let finish!: (value: typeof pairing) => void;
    run.mockImplementation((request) =>
      request.operation === "pair"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null),
    );
    const onDone = vi.fn();
    const { unmount } = render(<QuickConnect now={now} onDone={onDone} />);
    await openManual();
    fireEvent.change(screen.getByLabelText(tr("remote.address")), {
      target: { value: host.address },
    });
    fireEvent.change(screen.getByLabelText(tr("remote.code")), { target: { value: "12345678" } });
    const form = screen.getByLabelText(tr("remote.code")).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(run.mock.calls.filter(([request]) => request.operation === "pair")).toEqual([
      [{ operation: "pair", address: host.address, code: "12345678" }],
    ]);
    unmount();
    await act(async () => finish(pairing));
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("remote connections UI", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows one computer empty state and preserves the setup draft across tabs in %s",
    async (locale) => {
      await act(() => changeLocale(locale));
      try {
        const copy = remoteSettingsCopy[locale];
        render(<RemoteConnectionSettings />);
        expect(screen.getByRole("heading", { name: copy.title })).toBeTruthy();
        expect(screen.getByRole("button", { name: copy.phone }).getAttribute("aria-pressed")).toBe(
          "true",
        );
        fireEvent.click(screen.getByRole("button", { name: copy.computers }));
        expect(screen.getAllByText(copy.emptyTitle)).toHaveLength(1);
        for (const key of ["remote.noConnections", "remote.noAuthorized", "remote.noNearby"])
          expect(screen.queryByText(tr(key))).toBeNull();
        expect(screen.queryByRole("switch")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: copy.discover }));
        expect(screen.getByRole("button", { name: copy.find })).toBeTruthy();
        expect(run).toHaveBeenCalledWith({ operation: "discover" });
        expect(run.mock.calls.some(([input]) => input.operation === "configure")).toBe(false);
        const input = screen.getByRole("textbox", { name: tr("remote.name") });
        fireEvent.change(input, { target: { value: "Synthetic draft" } });
        fireEvent.click(screen.getByRole("button", { name: copy.phone }));
        fireEvent.click(screen.getByRole("button", { name: copy.computers }));
        expect(
          (screen.getByRole("textbox", { name: tr("remote.name") }) as HTMLInputElement).value,
        ).toBe("Synthetic draft");
        expect(run.mock.calls.some(([request]) => request.operation === "configure")).toBe(false);
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );

  it("does not apply an unsaved name when the sharing switch takes effect immediately", () => {
    renderSettings();
    fireEvent.change(screen.getByRole("textbox", { name: tr("remote.name") }), {
      target: { value: "Unsaved name" },
    });
    fireEvent.click(screen.getByRole("switch", { name: remoteSettingsCopy["en-US"].enable }));
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: true,
      address: "192.168.1.3:42987",
      name: "Desk",
    });
  });

  it.each(["remote-access", "remote-devices"] as const)(
    "reveals and focuses the %s settings search target without enabling sharing",
    async (target) => {
      if (target === "remote-devices")
        useRemoteStore.setState({
          snapshot: {
            ...status,
            authorized: [{ id: "synthetic", name: "Laptop", approved_at: 1, last_seen: null }],
          },
        });
      render(<RemoteConnectionSettings />);
      for (let attempt = 0; attempt < 2; attempt++) {
        act(() => {
          focusSettingsTarget(target);
        });
        await waitFor(() => expect(document.activeElement?.id).toBe(`settings-target-${target}`));
        expect(
          screen.getByRole("button", { name: "Other computers" }).getAttribute("aria-pressed"),
        ).toBe("true");
        expect(run).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Phones" }));
      }
    },
  );

  it("saves a name on blur and preserves its draft for an explicit retry after failure", async () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        remoteSettingsCopy["en-US"].saveFailed,
      ),
    );
    expect((input as HTMLInputElement).value).toBe("New name");
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: false,
      address: "192.168.1.3:42987",
      name: "New name",
    });
    run.mockImplementation(async (request) => {
      const next = { ...status, local: { ...status.local, name: request.name } };
      useRemoteStore.setState({ snapshot: next });
      return next;
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry saving name" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(useRemoteStore.getState().snapshot?.local.name).toBe("New name");
    expect(screen.getByRole("status").textContent).toBe(remoteSettingsCopy["en-US"].saved);
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "saves the computer name separately from advanced settings and shows success in %s",
    async (locale) => {
      await act(() => changeLocale(locale));
      try {
        const copy = remoteSettingsCopy[locale];
        const view = render(<RemoteConnectionSettings />);
        fireEvent.click(screen.getByRole("button", { name: copy.computers }));
        fireEvent.click(screen.getByRole("button", { name: copy.shareAction }));
        const input = screen.getByRole("textbox", { name: tr("remote.name") });
        fireEvent.change(input, { target: { value: " New name " } });
        expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
        run.mockImplementation(async (request) => {
          const next = { ...status, local: { ...status.local, name: request.name } };
          useRemoteStore.setState({ snapshot: next });
          return next;
        });
        fireEvent.blur(input);
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(copy.saved));
        expect((input as HTMLInputElement).value).toBe("New name");
        expect(run).toHaveBeenCalledExactlyOnceWith({
          operation: "configure",
          enabled: false,
          address: "192.168.1.3:42987",
          name: "New name",
        });
        expect(saveNetwork).not.toHaveBeenCalled();
        view.unmount();
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );

  it("deduplicates Enter and blur while a name save is in flight", async () => {
    let finish!: (value: RemoteStatus) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(run).toHaveBeenCalledTimes(1);
    expect((input as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      const next = { ...status, local: { ...status.local, name: "New name" } };
      useRemoteStore.setState({ snapshot: next });
      finish(next);
    });
    expect(screen.getByRole("status").textContent).toBe(remoteSettingsCopy["en-US"].saved);
    fireEvent.blur(input);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps an independent name draft out of the advanced network save", async () => {
    networkDirty = true;
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "Name draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(saveNetwork).toHaveBeenCalledOnce());
    expect(run).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Name draft");
  });

  it("blocks a stale advanced save callback admitted in the same event batch as a name blur", async () => {
    networkDirty = true;
    let finish!: (value: RemoteStatus) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    const save = screen.getByRole("button", { name: "Save settings" });
    fireEvent.change(input, { target: { value: "New name" } });
    act(() => {
      fireEvent.blur(input);
      fireEvent.click(save);
    });
    expect(run).toHaveBeenCalledOnce();
    expect(saveNetwork).not.toHaveBeenCalled();
    await act(async () => finish({ ...status, local: { ...status.local, name: "New name" } }));
  });

  it("retains a dirty name across external updates and saves using the latest sharing address", async () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "Name draft" } });
    const next = {
      ...status,
      local: { ...status.local, name: "External", enabled: true, address: "10.20.0.5:43123" },
    };
    act(() => useRemoteStore.setState({ snapshot: next }));
    expect((input as HTMLInputElement).value).toBe("Name draft");
    fireEvent.blur(input);
    expect(run).toHaveBeenCalledExactlyOnceWith({
      operation: "configure",
      enabled: true,
      address: next.local.address,
      name: "Name draft",
    });
  });

  it("does not dispatch a name save during network work and keeps the draft for later", () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "Name draft" } });
    networkBusy = true;
    act(() => useRemoteStore.setState({ snapshot: { ...status } }));
    fireEvent.blur(input);
    expect(run).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Name draft");
    networkBusy = false;
    act(() => useRemoteStore.setState({ snapshot: { ...status } }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not save an invalid name or confirm an old request after unmount", async () => {
    const view = renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(run).not.toHaveBeenCalled();
    let finish!: (value: RemoteStatus) => void;
    run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => finish({ ...status, local: { ...status.local, name: "New name" } }));
    renderSettings();
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: tr("remote.name") }) as HTMLInputElement).value,
    ).toBe("Desk");
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows successful name feedback briefly and ignores Enter during input composition", async () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();
    run.mockImplementation(async (request) => {
      const next = { ...status, local: { ...status.local, name: request.name } };
      useRemoteStore.setState({ snapshot: next });
      return next;
    });
    vi.useFakeTimers();
    try {
      await act(async () => fireEvent.blur(input));
      expect(screen.getByRole("status").textContent).toBe(remoteSettingsCopy["en-US"].saved);
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a failed name notice after a status refresh confirms the requested name", async () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: tr("remote.name") });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    await screen.findByRole("button", { name: "Retry saving name" });
    act(() =>
      useRemoteStore.setState({
        snapshot: { ...status, local: { ...status.local, name: "New name" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry saving name" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an entered address and pairing code when the last discovered computer disappears", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        discovered: [{ id: "peer", name: "Example laptop", address: "192.168.1.20:42987" }],
      },
    });
    renderSettings();
    const address = screen.getByRole("textbox", { name: tr("remote.address") });
    const code = screen.getByRole("textbox", { name: tr("remote.code") });
    address.focus();
    fireEvent.change(address, { target: { value: "192.168.1.20:42987" } });
    expect(document.activeElement).toBe(address);
    fireEvent.change(code, { target: { value: "12345678" } });
    act(() => useRemoteStore.setState({ snapshot: status }));
    expect(screen.queryByText(remoteSettingsCopy["en-US"].emptyTitle)).toBeNull();
    expect(screen.getByRole("textbox", { name: tr("remote.address") })).toBe(address);
    expect((address as HTMLInputElement).value).toBe("192.168.1.20:42987");
    expect((code as HTMLInputElement).value).toBe("12345678");
    expect(run).not.toHaveBeenCalled();
  });

  it("shows friendly feedback for a real wrapped IPC error in the quick panel", () => {
    const failure = new Error(
      "Error invoking remote method 'agentkib:remote:request': REMOTE_PAIRING_INVALID",
    );
    useRemoteStore.setState({ error: failure, operationError: true });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain(tr("remote.error.pairing"));
    expect(screen.getByRole("alert").textContent).not.toContain("REMOTE_PAIRING_INVALID");
    fireEvent.click(screen.getByRole("button", { name: tr("errors.details") }));
    expect(screen.getByRole("alert").textContent).toContain(failure.message);
    expect(useRemoteStore.getState().error).toBe(failure);
  });
  it("retranslates a displayed structured error in all four languages and still clears it", async () => {
    const failure = { key: "errors.generic", detail: "REMOTE_PAIRING_DENIED" };
    useRemoteStore.setState({ error: failure, operationError: true });
    renderSettings();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(tr(failure.key));
    expect(alert.textContent).not.toContain(failure.detail);

    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("alert")).toBe(alert);
        expect(alert.textContent).toContain(tr(failure.key));
        expect(alert.textContent).not.toContain(failure.detail);
        expect(useRemoteStore.getState().error).toBe(failure);
      }
      fireEvent.click(screen.getByRole("button", { name: tr("common.close") }));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(useRemoteStore.getState().error).toBe("");
      expect(useRemoteStore.getState().operationError).toBe(false);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  it("translates an open pairing panel immediately without losing address/code input", async () => {
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: tr("remote.quick.manual") }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.manual") }));
    const address = screen.getByRole("textbox", { name: tr("remote.address") });
    fireEvent.change(address, { target: { value: "192.168.1.20:42987" } });
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(
          screen.getByRole("heading", { name: remoteEntryCopy[locale].nativeTitle }),
        ).toBeTruthy();
        expect(screen.getByRole("textbox", { name: tr("remote.address") })).toBe(address);
        expect((address as HTMLInputElement).value).toBe("192.168.1.20:42987");
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
  it("does not optimistically authorize a failed approval or retry it during status polling", async () => {
    const pending = {
      id: "request",
      device_id: "device",
      name: "Laptop",
      verification: "321 654",
      expires_at: Date.now() / 1000 + 300,
    };
    useRemoteStore.setState({ snapshot: { ...status, pending: [pending] } });
    run.mockImplementation(async () => {
      useRemoteStore.setState({ error: "Approval failed" });
      return null;
    });
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Digits match — approve" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(tr("remote.error.request")),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(useRemoteStore.getState().snapshot?.authorized).toEqual([]);
    expect(useRemoteStore.getState().snapshot?.pending).toEqual([pending]);
    expect(screen.getByText("321 654")).toBeTruthy();
  });
  it("does not expose a stale pairing code while sharing is off or after expiry", () => {
    const { rerender } = renderSettings();
    expect(screen.queryByRole("button", { name: "Generate new code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
    useRemoteStore.setState({
      snapshot: {
        ...status,
        local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
        pairing_code: "87654321",
        pairing_expires_at: Date.now() / 1000 - 1,
      },
    });
    rerender(<RemoteConnectionSettings />);
    expect(screen.queryByText("87654321")).toBeNull();
    expect(screen.getByRole("button", { name: "Generate new code" })).toBeTruthy();
  });
  it("shows sharing-disabled remote state without any message or execution controls", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        connections: [
          {
            id: "host",
            name: "Host",
            address: "192.168.1.5:42987",
            status: "sharing-disabled",
            last_seen: null,
            error: null,
          },
        ],
      },
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByText("Sharing is off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(send|stop|run|execute|approve)$/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /message/i })).toBeNull();
  });
  it("can stop sharing when the saved interface is unavailable or conflicts", () => {
    networkAddress = "";
    useRemoteStore.setState({
      snapshot: {
        ...status,
        local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
      },
    });
    renderSettings();
    fireEvent.click(
      screen.getByRole("switch", { name: "Allow other computers to view (read-only)" }),
    );
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: false,
      name: "Desk",
      address: "192.168.1.3:42987",
    });
  });

  it("shares only after an explicit switch action with a private address and port", () => {
    renderSettings();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("switch", { name: "Allow other computers to view (read-only)" }),
    );
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: true,
      name: "Desk",
      address: "192.168.1.3:42987",
    });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
  it("shows one-time credentials using Unix seconds and requires host approval", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
        pairing_code: "87654321",
        pairing_expires_at: Date.now() / 1000 + 300,
        pending: [
          {
            id: "request",
            device_id: "device",
            name: "Laptop",
            verification: "321 654",
            expires_at: Date.now() / 1000 + 300,
          },
        ],
      },
    });
    renderSettings();
    expect(screen.getByText("87654321")).toBeTruthy();
    expect(screen.getByText(/including workspaces added later/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Digits match — approve" }));
    expect(run).toHaveBeenCalledWith({ operation: "approve", id: "request" });
  });
  it("pairs manually without enabling this device's sharing", async () => {
    run.mockResolvedValue({
      id: "host",
      verification: "123 456",
      status: "pending",
      expires_at: Date.now() / 1000 + 300,
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} onSettings={vi.fn()} />);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: tr("remote.quick.manual") }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.manual") }));
    fireEvent.change(screen.getByLabelText("Computer IPv4 address and port"), {
      target: { value: "192.168.1.5:42987" },
    });
    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair a computer" }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({
        operation: "pair",
        address: "192.168.1.5:42987",
        code: "12345678",
      }),
    );
    expect(screen.queryByRole("switch")).toBeNull();
  });
  it("requires confirmation before revoking and offers no forced reconnect after identity change", () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        authorized: [{ id: "device", name: "Laptop", approved_at: 1_700_000_000, last_seen: null }],
        connections: [
          {
            id: "host",
            name: "Host",
            address: "192.168.1.5:42987",
            status: "identity-changed",
            last_seen: null,
            error: null,
          },
        ],
      },
    });
    renderSettings();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(run).toHaveBeenCalledWith({ operation: "revoke", id: "device" });
  });
});
