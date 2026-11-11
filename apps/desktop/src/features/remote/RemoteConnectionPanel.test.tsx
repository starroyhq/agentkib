// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { RemoteStatus } from "@/core/remote-types";
import { RemoteConnectionPanel, RemoteConnectionSettings } from "./RemoteConnectionPanel";
import { useRemoteStore } from "./remote-store";
import { QuickConnect } from "./QuickConnect";
import { remotePageCopy } from "./remote-page-copy";
import { remotePhoneCopy } from "./remote-phone-copy";
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
// The name is only editable on the sharing panel, so name tests start from a sharing computer.
const sharing: RemoteStatus = {
  ...status,
  local: { ...status.local, enabled: true, address: "192.168.1.3:42987" },
};
const host = {
  id: "host",
  name: "Laptop",
  address: "192.168.1.5:42987",
  status: "pending" as const,
  last_seen: null,
  error: null,
};
const page = remotePageCopy["en-US"];
const run = vi.fn();
let networkAddress = "192.168.1.3";
let networkBusy = false;
let networkDirty = false;
const saveNetwork = vi.fn();
const resetNetwork = vi.fn();
vi.mock("./RemoteNetworkSettings", () => ({
  useRemoteNetworkSettings: () => ({
    address: networkAddress,
    interfaces: [{ name: "Wi-Fi", address: "192.168.1.3" }],
    content: null,
    dirty: networkDirty,
    busy: networkBusy,
    valid: true,
    save: saveNetwork,
    reset: resetNetwork,
  }),
}));
// Stands in for the advanced window's footer: Save runs the page's callback, Cancel discards drafts.
vi.mock("./WebAccessSettings", () => ({
  WebAccessSettings: ({
    children,
    onSaveAdvanced,
    onDiscardAdvanced,
    advancedDirty,
    advancedValid,
  }: {
    children?: ReactNode;
    onSaveAdvanced?: () => Promise<boolean>;
    onDiscardAdvanced?: () => void;
    advancedDirty?: boolean;
    advancedValid?: boolean;
  }) => (
    <>
      {children}
      <button onClick={() => onDiscardAdvanced?.()}>Cancel</button>
      {advancedDirty && (
        <button disabled={!advancedValid} onClick={() => void onSaveAdvanced?.()}>
          Save
        </button>
      )}
    </>
  ),
}));
function renderSharing() {
  useRemoteStore.setState({ snapshot: sharing });
  return render(<RemoteConnectionSettings />);
}
/** The name is plain text until the pencil button turns it into an input. */
function startRenaming(label: string = page.editName) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  return screen.getByRole("textbox", { name: tr("remote.name") }) as HTMLInputElement;
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  networkAddress = "192.168.1.3";
  networkBusy = false;
  networkDirty = false;
  saveNetwork.mockReset().mockResolvedValue(true);
  resetNetwork.mockReset();
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

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "shows the nothing-found guidance only after discovery has finished in %s",
  async (locale) => {
    await changeLocale(locale);
    try {
      const copy = remotePageCopy[locale];
      let finish!: (value: RemoteStatus) => void;
      run.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      useRemoteStore.setState({ snapshot: null, loading: true });
      render(<RemoteConnectionSettings />);
      fireEvent.click(screen.getByRole("button", { name: copy.addComputer }));
      expect(screen.getByText(copy.searching)).toBeTruthy();
      expect(screen.queryByText(copy.notFoundTitle)).toBeNull();
      await act(async () => {
        useRemoteStore.setState({ snapshot: status, loading: false });
        finish(status);
      });
      expect(screen.getByText(copy.notFoundTitle)).toBeTruthy();
      expect(screen.queryByText(copy.searching)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.searchAgain") }));
      expect(screen.getByText(copy.searching)).toBeTruthy();
      expect(screen.queryByText(copy.notFoundTitle)).toBeNull();
      await act(async () => finish(status));
      expect(screen.getByText(copy.notFoundTitle)).toBeTruthy();
    } finally {
      await changeLocale("en-US");
    }
  },
);

describe("quick connection flow", () => {
  const now = Date.now();
  const pairing = {
    id: "host",
    verification: "123 456",
    status: "pending" as const,
    expires_at: now / 1000 + 300,
  };
  async function openManual(label: string = page.enterAddress) {
    const link = await screen.findByRole("button", { name: label });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
  }
  it("discovers once per opening and keeps manual inputs out of the initial view", async () => {
    const { rerender } = render(<QuickConnect now={now} onDone={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(page.notFoundTitle)).toBeTruthy());
    expect(screen.queryByLabelText(page.computerAddress)).toBeNull();
    expect(screen.queryByText(tr("remote.quick.saved"))).toBeNull();
    await openManual();
    // Without a chosen computer the way back is named after the list it returns to.
    fireEvent.click(screen.getByRole("button", { name: tr("remote.nearby") }));
    rerender(<QuickConnect now={now + 2000} onDone={vi.fn()} />);
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
    fireEvent.click(screen.getByRole("button", { name: tr("remote.quick.searchAgain") }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });
  it("selects a nearby computer, sends nothing for fewer than eight digits, and returns without pairing", async () => {
    const user = userEvent.setup();
    useRemoteStore.setState({ snapshot: { ...status, discovered: [host] } });
    render(<QuickConnect now={now} onDone={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: `${tr("remote.pair")}: Laptop` }));
    expect(screen.queryByLabelText(page.computerAddress)).toBeNull();
    const slots = within(screen.getByRole("group", { name: tr("remote.code") })).getAllByRole(
      "textbox",
    );
    expect(slots).toHaveLength(8);
    expect(document.activeElement).toBe(slots[0]);
    await user.keyboard("1234567");
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
    await user.click(screen.getByRole("button", { name: "Laptop" }));
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
    expect(screen.getByRole("button", { name: `${tr("remote.pair")}: Laptop` })).toBeTruthy();
  });
  it("pairs a selected nearby computer by itself once the eighth digit is entered", async () => {
    const user = userEvent.setup();
    useRemoteStore.setState({ snapshot: { ...status, discovered: [host] } });
    run.mockImplementation(async (request) => {
      if (request.operation !== "pair") return null;
      useRemoteStore.setState({ pairing });
      return pairing;
    });
    render(<QuickConnect now={now} onDone={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: `${tr("remote.pair")}: Laptop` }));
    await user.keyboard("12345678");
    await screen.findByText(pairing.verification);
    expect(run.mock.calls.filter(([request]) => request.operation === "pair")).toEqual([
      [{ operation: "pair", address: host.address, code: "12345678" }],
    ]);
    expect(screen.getByText(tr("remote.waitApproval"))).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText(page.computerAddress), {
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
    "shows one computers empty state and finding computers never turns sharing on in %s",
    async (locale) => {
      await act(() => changeLocale(locale));
      try {
        const copy = remoteSettingsCopy[locale];
        const text = remotePageCopy[locale];
        render(<RemoteConnectionSettings />);
        expect(screen.getByRole("heading", { name: copy.title })).toBeTruthy();
        expect(screen.getByRole("heading", { name: text.computers })).toBeTruthy();
        expect(screen.getAllByText(text.noneYet)).toHaveLength(1);
        for (const key of ["remote.noConnections", "remote.noAuthorized", "remote.noNearby"])
          expect(screen.queryByText(tr(key))).toBeNull();
        expect(screen.queryByText(copy.emptyTitle)).toBeNull();
        expect(screen.getByRole("switch", { name: text.share }).getAttribute("aria-checked")).toBe(
          "false",
        );
        fireEvent.click(screen.getByRole("button", { name: text.addComputer }));
        expect(screen.getByRole("heading", { name: text.addComputer })).toBeTruthy();
        // The settings page is already open, so the window offers no way back to it.
        expect(screen.queryByRole("button", { name: tr("remote.quick.settings") })).toBeNull();
        expect(run).toHaveBeenCalledWith({ operation: "discover" });
        expect(run.mock.calls.some(([input]) => input.operation === "configure")).toBe(false);
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );

  it("does not apply an unsaved name when the sharing switch takes effect immediately", () => {
    renderSharing();
    fireEvent.change(startRenaming(), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("switch", { name: page.share }));
    expect(run).toHaveBeenLastCalledWith({
      operation: "configure",
      enabled: false,
      address: "192.168.1.3:42987",
      name: "Desk",
    });
    // The switch changes nothing but sharing, so turning it back on keeps the saved name too.
    act(() => useRemoteStore.setState({ snapshot: status }));
    fireEvent.click(screen.getByRole("switch", { name: page.share }));
    expect(run).toHaveBeenLastCalledWith({
      operation: "configure",
      enabled: true,
      address: "192.168.1.3:42987",
      name: "Desk",
    });
  });

  it("asks for a network before sharing when none is saved, then saves it and starts sharing", async () => {
    const user = userEvent.setup();
    networkAddress = "";
    render(<RemoteConnectionSettings />);
    await user.click(screen.getByRole("switch", { name: page.share }));
    expect(run).not.toHaveBeenCalled();
    expect(saveNetwork).not.toHaveBeenCalled();
    const start = screen.getByRole("button", { name: page.startSharing }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await user.click(screen.getByRole("combobox", { name: page.shareNetwork }));
    await user.click(await screen.findByRole("option", { name: /192\.168\.1\.3/ }));
    expect(start.disabled).toBe(false);
    expect(saveNetwork).not.toHaveBeenCalled();
    await user.click(start);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(saveNetwork).toHaveBeenCalledExactlyOnceWith("192.168.1.3");
    expect(saveNetwork.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: true,
      address: "192.168.1.3:42987",
      name: "Desk",
    });
  });

  it("does not start sharing when the chosen network cannot be saved, and switching off cancels the choice", async () => {
    const user = userEvent.setup();
    networkAddress = "";
    saveNetwork.mockResolvedValue(false);
    render(<RemoteConnectionSettings />);
    await user.click(screen.getByRole("switch", { name: page.share }));
    await user.click(screen.getByRole("combobox", { name: page.shareNetwork }));
    await user.click(await screen.findByRole("option", { name: /192\.168\.1\.3/ }));
    await user.click(screen.getByRole("button", { name: page.startSharing }));
    await waitFor(() => expect(saveNetwork).toHaveBeenCalledOnce());
    expect(run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch", { name: page.share }));
    expect(screen.queryByRole("button", { name: page.startSharing })).toBeNull();
    expect(run).not.toHaveBeenCalled();
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
        expect(screen.getByRole("heading", { name: page.computers })).toBeTruthy();
        expect(run).not.toHaveBeenCalled();
        // Both cards are always on the page; a later request has to bring focus back again.
        act(() => screen.getByRole("button", { name: page.addComputer }).focus());
      }
    },
  );

  it("saves a name on blur and preserves its draft for an explicit retry after failure", async () => {
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        remoteSettingsCopy["en-US"].saveFailed,
      ),
    );
    expect(input.value).toBe("New name");
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: true,
      address: "192.168.1.3:42987",
      name: "New name",
    });
    run.mockImplementation(async (request) => {
      const next = { ...sharing, local: { ...sharing.local, name: request.name } };
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
        const view = renderSharing();
        const input = startRenaming(remotePageCopy[locale].editName);
        fireEvent.change(input, { target: { value: " New name " } });
        expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
        run.mockImplementation(async (request) => {
          const next = { ...sharing, local: { ...sharing.local, name: request.name } };
          useRemoteStore.setState({ snapshot: next });
          return next;
        });
        fireEvent.blur(input);
        await waitFor(() => expect(screen.getByRole("status").textContent).toBe(copy.saved));
        // Saving puts the trimmed name back as plain text.
        expect(screen.queryByRole("textbox", { name: tr("remote.name") })).toBeNull();
        expect(screen.getByText("New name")).toBeTruthy();
        expect(run).toHaveBeenCalledExactlyOnceWith({
          operation: "configure",
          enabled: true,
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
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(run).toHaveBeenCalledTimes(1);
    expect(input.disabled).toBe(true);
    await act(async () => {
      const next = { ...sharing, local: { ...sharing.local, name: "New name" } };
      useRemoteStore.setState({ snapshot: next });
      finish(next);
    });
    expect(screen.getByRole("status").textContent).toBe(remoteSettingsCopy["en-US"].saved);
    // A later blur of the unchanged name must not send the request again.
    fireEvent.blur(startRenaming());
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps an independent name draft out of the advanced network save", async () => {
    networkDirty = true;
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Name draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveNetwork).toHaveBeenCalledOnce());
    expect(run).not.toHaveBeenCalled();
    expect(input.value).toBe("Name draft");
  });

  it("discards the network drafts but not a name draft when the advanced window is cancelled", () => {
    networkDirty = true;
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Name draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(resetNetwork).toHaveBeenCalledOnce();
    expect(saveNetwork).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(input.value).toBe("Name draft");
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
    renderSharing();
    const input = startRenaming();
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.change(input, { target: { value: "New name" } });
    act(() => {
      fireEvent.blur(input);
      fireEvent.click(save);
    });
    expect(run).toHaveBeenCalledOnce();
    expect(saveNetwork).not.toHaveBeenCalled();
    await act(async () => finish({ ...sharing, local: { ...sharing.local, name: "New name" } }));
  });

  it("retains a dirty name across external updates and saves using the latest sharing address", async () => {
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Name draft" } });
    const next = {
      ...status,
      local: { ...status.local, name: "External", enabled: true, address: "10.20.0.5:43123" },
    };
    act(() => useRemoteStore.setState({ snapshot: next }));
    expect(input.value).toBe("Name draft");
    fireEvent.blur(input);
    expect(run).toHaveBeenCalledExactlyOnceWith({
      operation: "configure",
      enabled: true,
      address: next.local.address,
      name: "Name draft",
    });
  });

  it("does not dispatch a name save during network work and keeps the draft for later", () => {
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "Name draft" } });
    networkBusy = true;
    act(() => useRemoteStore.setState({ snapshot: { ...sharing } }));
    fireEvent.blur(input);
    expect(run).not.toHaveBeenCalled();
    expect(input.value).toBe("Name draft");
    networkBusy = false;
    act(() => useRemoteStore.setState({ snapshot: { ...sharing } }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not save an invalid name or confirm an old request after unmount", async () => {
    const view = renderSharing();
    const input = startRenaming();
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
    await act(async () => finish({ ...sharing, local: { ...sharing.local, name: "New name" } }));
    renderSharing();
    expect(screen.queryByRole("status")).toBeNull();
    expect(startRenaming().value).toBe("Desk");
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows successful name feedback briefly and ignores Enter during input composition", async () => {
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(run).not.toHaveBeenCalled();
    run.mockImplementation(async (request) => {
      const next = { ...sharing, local: { ...sharing.local, name: request.name } };
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
    renderSharing();
    const input = startRenaming();
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.blur(input);
    await screen.findByRole("button", { name: "Retry saving name" });
    act(() =>
      useRemoteStore.setState({
        snapshot: { ...sharing, local: { ...sharing.local, name: "New name" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry saving name" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps an entered address and pairing code when the last discovered computer disappears", async () => {
    useRemoteStore.setState({
      snapshot: {
        ...status,
        discovered: [{ id: "peer", name: "Example laptop", address: "192.168.1.20:42987" }],
      },
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} />);
    // With a nearby computer listed, the manual entry is the "can't find it" link.
    const link = await screen.findByRole("button", { name: page.notFoundLink });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    const address = screen.getByRole("textbox", { name: page.computerAddress }) as HTMLInputElement;
    const code = screen.getByRole("textbox", { name: tr("remote.code") }) as HTMLInputElement;
    address.focus();
    fireEvent.change(address, { target: { value: "192.168.1.20:42987" } });
    expect(document.activeElement).toBe(address);
    fireEvent.change(code, { target: { value: "12345678" } });
    act(() => useRemoteStore.setState({ snapshot: status }));
    expect(screen.queryByText(page.notFoundTitle)).toBeNull();
    expect(screen.getByRole("textbox", { name: page.computerAddress })).toBe(address);
    expect(address.value).toBe("192.168.1.20:42987");
    expect(code.value).toBe("12345678");
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
  });

  it("keeps a partly entered pairing code when the selected computer disappears from the list", async () => {
    const user = userEvent.setup();
    useRemoteStore.setState({
      snapshot: {
        ...status,
        discovered: [{ id: "peer", name: "Example laptop", address: "192.168.1.20:42987" }],
      },
    });
    render(<RemoteConnectionPanel open onOpenChange={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: `${tr("remote.pair")}: Example laptop` }),
    );
    await user.keyboard("1234");
    act(() => useRemoteStore.setState({ snapshot: status }));
    const slots = within(screen.getByRole("group", { name: tr("remote.code") })).getAllByRole(
      "textbox",
    ) as HTMLInputElement[];
    expect(slots.map((slot) => slot.value).join("")).toBe("1234");
    expect(document.activeElement).toBe(slots[4]);
    expect(run.mock.calls).toEqual([[{ operation: "discover" }]]);
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
    const link = await screen.findByRole("button", { name: page.enterAddress });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    const address = screen.getByRole("textbox", { name: page.computerAddress }) as HTMLInputElement;
    const code = screen.getByRole("textbox", { name: tr("remote.code") }) as HTMLInputElement;
    fireEvent.change(address, { target: { value: "192.168.1.20:42987" } });
    fireEvent.change(code, { target: { value: "1234" } });
    try {
      for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(
          screen.getByRole("heading", { name: remotePageCopy[locale].addComputer }),
        ).toBeTruthy();
        expect(screen.getByRole("textbox", { name: remotePageCopy[locale].computerAddress })).toBe(
          address,
        );
        expect(screen.getByRole("textbox", { name: tr("remote.code") })).toBe(code);
        expect(address.value).toBe("192.168.1.20:42987");
        expect(code.value).toBe("1234");
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
    expect(screen.queryByText("8765 4321")).toBeNull();
    expect(screen.queryByRole("button", { name: remotePhoneCopy["en-US"].regenerate })).toBeNull();
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
    render(<RemoteConnectionSettings />);
    fireEvent.click(screen.getByRole("switch", { name: page.share }));
    expect(run).toHaveBeenCalledWith({
      operation: "configure",
      enabled: false,
      name: "Desk",
      address: "192.168.1.3:42987",
    });
  });

  it("shares only after an explicit switch action with a private address and port", () => {
    render(<RemoteConnectionSettings />);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: page.share }));
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
    expect(screen.getByText("8765 4321")).toBeTruthy();
    expect(screen.getByRole("button", { name: remotePhoneCopy["en-US"].regenerate })).toBeTruthy();
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
    const link = await screen.findByRole("button", { name: page.enterAddress });
    await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(link);
    fireEvent.change(screen.getByLabelText("Computer address"), {
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
    render(<RemoteConnectionSettings />);
    // A changed identity gets no Connect button at all, so it cannot be forced.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(run).toHaveBeenCalledWith({ operation: "revoke", id: "device" });
  });
  it("disconnects an online computer directly but removes it only after confirmation", () => {
    useRemoteStore.setState({
      snapshot: { ...status, connections: [{ ...host, status: "online" }] },
    });
    render(<RemoteConnectionSettings />);
    fireEvent.click(screen.getByRole("button", { name: tr("remote.disconnect") }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ operation: "disconnect", id: host.id });
    run.mockClear();
    fireEvent.click(screen.getByRole("button", { name: `${tr("remote.remove")}: ${host.name}` }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: tr("remote.confirm") }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ operation: "remove", id: host.id });
  });
});
