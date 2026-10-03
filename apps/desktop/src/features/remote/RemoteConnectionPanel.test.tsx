// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { RemoteStatus } from "@/core/remote-types";
import { RemoteConnectionPanel, RemoteConnectionSettings } from "./RemoteConnectionPanel";
import { useRemoteStore } from "./remote-store";
import { remoteEntryCopy } from "./remote-entry-copy";
import { QuickConnect } from "./QuickConnect";

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
const webSnapshot = vi.hoisted(() => ({
  enabled: false,
  running: false,
}));
vi.mock("./web-status", () => ({
  subscribeWebStatus: (_target: unknown, listener: { status(value: unknown): void }) => {
    listener.status({ config: { enabled: webSnapshot.enabled }, running: webSnapshot.running });
    return () => {};
  },
}));
vi.mock("./WebAccessSettings", () => ({ WebAccessSettings: () => null }));
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  run.mockReset().mockResolvedValue(null);
  webSnapshot.enabled = false;
  webSnapshot.running = false;
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
    render(<RemoteConnectionSettings />);
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
    render(<RemoteConnectionSettings />);
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
    const { rerender } = render(<RemoteConnectionSettings />);
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
  it("shares only after an explicit switch action with a private address and port", () => {
    render(<RemoteConnectionSettings />);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Allow local network access" }));
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
    render(<RemoteConnectionSettings />);
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
    fireEvent.change(screen.getByLabelText("Host IPv4 address and port"), {
      target: { value: "192.168.1.5:42987" },
    });
    fireEvent.change(screen.getByLabelText("One-time pairing code"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair a host" }));
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
    render(<RemoteConnectionSettings />);
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(run).toHaveBeenCalledWith({ operation: "revoke", id: "device" });
  });
});

it("keeps an enabled LAN listener visible while its settings are collapsed", async () => {
  webSnapshot.enabled = true;
  webSnapshot.running = true;
  render(<RemoteConnectionSettings />);
  expect(await screen.findByText("LAN HTTP access is running")).toBeTruthy();
  expect(screen.getAllByText("LAN direct connection is not encrypted")).toHaveLength(1);
  expect(screen.getByText(/capture the access token/)).toBeTruthy();
  const summary = screen.getByRole("button", { name: "LAN access (advanced)" });
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Manage LAN access" }));
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(summary);
  const user = userEvent.setup();
  await user.keyboard("{Enter}");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  await user.keyboard(" ");
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("region", { name: "Connect to another computer" })).toBeTruthy();
});

it("shows an enabled but unavailable LAN service without reporting it as running", async () => {
  webSnapshot.enabled = true;
  render(<RemoteConnectionSettings />);
  expect(await screen.findByText("LAN access is enabled but unavailable")).toBeTruthy();
  expect(screen.queryByText("LAN HTTP access is running")).toBeNull();
  expect(screen.queryByText("LAN direct connection is not encrypted")).toBeNull();
});
