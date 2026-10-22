// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import type { RemoteStatus } from "@/core/remote-types";
import type { WebAdminStatus } from "../../../electron/main/web/service";
import { useRemoteNetworkSettings } from "./RemoteNetworkSettings";
import { remoteNetworkCopy } from "./remote-network-copy";
import { useRemoteStore } from "./remote-store";

const web = vi.hoisted(() => ({
  request: vi.fn(),
  listener: undefined as { status(value: WebAdminStatus): void; error(): void } | undefined,
  status: undefined as WebAdminStatus | undefined,
}));
vi.mock("./web-status", () => ({
  subscribeWebStatus: (target: string, listener: typeof web.listener) => {
    expect(target).toBe("lan");
    web.listener = listener;
    if (web.status) listener!.status(web.status);
    return () => {
      web.listener = undefined;
    };
  },
  requestWebAdmin: web.request,
}));
const run = vi.fn();
const interfaces = [
  { name: "Wi-Fi", address: "192.168.20.10" },
  { name: "Ethernet", address: "10.20.0.10" },
];
const native: RemoteStatus = {
  local: { id: "local", name: "Example computer", enabled: false, address: null },
  interfaces,
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const lan: WebAdminStatus = {
  config: {
    enabled: false,
    port: 1422,
    externalOrigin: "https://remote.agentkib.com",
    experimentalEnabled: false,
    lanAddress: "",
    allowPlaintext: false,
  },
  running: false,
  localUrl: "",
  experimentalAvailable: false,
  addresses: interfaces,
  pending: [],
  devices: [],
};
function Harness() {
  const settings = useRemoteNetworkSettings();
  return (
    <>
      {settings.content}
      <output aria-label="Saved address">{settings.address}</output>
      <output aria-label="Dirty">{String(settings.dirty)}</output>
      <output aria-label="Valid">{String(settings.valid)}</output>
      <button disabled={!settings.valid || settings.busy} onClick={() => void settings.save()}>
        Save network
      </button>
    </>
  );
}
async function choose(address = "192.168.20.10") {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Shared LAN interface" }));
  await user.click(await screen.findByRole("option", { name: new RegExp(address) }));
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  web.status = structuredClone(lan);
  web.request.mockReset().mockImplementation(async (input) => {
    const { operation: _operation, target: _target, ...config } = input;
    const next = { ...web.status!, config };
    web.status = next;
    web.listener?.status(next);
    return next;
  });
  run.mockReset().mockImplementation(async (input) => {
    const next = {
      ...useRemoteStore.getState().snapshot!,
      local: {
        ...useRemoteStore.getState().snapshot!.local,
        ...input,
      },
    };
    useRemoteStore.setState({ snapshot: next });
    return next;
  });
  useRemoteStore.setState({ snapshot: structuredClone(native), busy: false, run });
});
afterEach(async () => {
  cleanup();
  await act(() => changeLocale("en-US"));
});

it("requires an explicit interface choice and never starts a listener while editing", async () => {
  web.status!.addresses = [interfaces[0]];
  useRemoteStore.setState({ snapshot: { ...native, interfaces: [interfaces[0]] } });
  render(<Harness />);
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("false");
  expect(screen.getByLabelText("Valid")).toHaveTextContent("true");
  await choose();
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  expect(web.request).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Saved address")).toHaveTextContent("192.168.20.10"),
  );
  expect(web.request).toHaveBeenCalledExactlyOnceWith({
    operation: "configure",
    target: "lan",
    ...lan.config,
    lanAddress: "192.168.20.10",
  });
  expect(run).not.toHaveBeenCalled();
});

it("does not reconfigure either service when no network setting changed", async () => {
  web.status!.config.lanAddress = "192.168.20.10";
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await act(async () => {});
  expect(web.request).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("keeps conflicting running addresses unchanged until the user chooses", async () => {
  web.status!.config = {
    ...lan.config,
    enabled: true,
    allowPlaintext: true,
    lanAddress: "10.20.0.10",
  };
  useRemoteStore.setState({
    snapshot: {
      ...native,
      local: {
        ...native.local,
        enabled: true,
        address: "192.168.20.10:43000",
      },
    },
  });
  render(<Harness />);
  expect(screen.getByRole("alert")).toHaveTextContent("different interfaces");
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("false");
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await act(async () => {});
  expect(web.request).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  await choose("10.20.0.10");
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(run).toHaveBeenCalledExactlyOnceWith({
      operation: "configure",
      enabled: true,
      name: native.local.name,
      address: "10.20.0.10:43000",
    }),
  );
  expect(web.request).not.toHaveBeenCalled();
});

it("does not migrate a missing saved interface to the only remaining interface", async () => {
  web.status!.config.lanAddress = "192.168.20.99";
  web.status!.addresses = [interfaces[0]];
  render(<Harness />);
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  expect(screen.getByLabelText("Valid")).toHaveTextContent("true");
  expect(web.request).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("changes only the LAN port and preserves enabled, risk and permission settings", async () => {
  web.status!.config = {
    ...lan.config,
    enabled: true,
    allowPlaintext: true,
    experimentalEnabled: true,
    lanAddress: "192.168.20.10",
  };
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Phone LAN port"), { target: { value: "1442" } });
  expect(screen.getByText(/revokes existing LAN browser authorizations/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(web.request).toHaveBeenCalledExactlyOnceWith({
      operation: "configure",
      target: "lan",
      ...web.status!.config,
      port: 1442,
    }),
  );
  expect(run).not.toHaveBeenCalled();
});

it("preserves a partial failure and retries only the uncommitted service", async () => {
  web.status!.config.lanAddress = "192.168.20.10";
  useRemoteStore.setState({
    snapshot: {
      ...native,
      local: {
        ...native.local,
        enabled: true,
        address: "192.168.20.10:42987",
      },
    },
  });
  run.mockResolvedValueOnce(null);
  render(<Harness />);
  await choose("10.20.0.10");
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Phone LAN settings saved"),
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Computer sharing settings failed");
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("true");
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() => expect(screen.getByLabelText("Dirty")).toHaveTextContent("false"));
  expect(web.request).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText("Saved address")).toHaveTextContent("10.20.0.10");
});

it("keeps a failed LAN save retryable even if polling shows the in-memory draft", async () => {
  render(<Harness />);
  await choose();
  web.request.mockImplementationOnce(async (input) => {
    const { operation: _operation, target: _target, ...config } = input;
    web.listener!.status({ ...lan, config });
    throw new Error("example persistence failure");
  });
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Phone LAN settings failed"),
  );
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("true");
  expect(screen.getByLabelText("Saved address")).toBeEmptyDOMElement();
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() => expect(screen.getByLabelText("Dirty")).toHaveTextContent("false"));
  expect(web.request).toHaveBeenCalledTimes(2);
});

it("validates only edited network fields and keeps drafts across status refreshes", async () => {
  web.status!.config.lanAddress = "192.168.20.10";
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Phone LAN port"), { target: { value: "80" } });
  expect(screen.getByRole("button", { name: "Save network" })).toBeDisabled();
  await act(() => web.listener!.status({ ...lan, config: { ...lan.config, port: 1444 } }));
  expect(screen.getByLabelText("Phone LAN port")).toHaveValue(80);
  expect(web.request).not.toHaveBeenCalled();
});

it("does not restart computer sharing if it was turned off during the LAN save", async () => {
  web.status!.config.lanAddress = "192.168.20.10";
  const active = {
    ...native,
    local: { ...native.local, enabled: true, address: "192.168.20.10:42987" },
  };
  useRemoteStore.setState({ snapshot: active });
  let finish: ((value: WebAdminStatus) => void) | undefined;
  web.request.mockImplementationOnce(
    () =>
      new Promise<WebAdminStatus>((resolve) => {
        finish = resolve;
      }),
  );
  render(<Harness />);
  await choose("10.20.0.10");
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  expect(screen.getByRole("button", { name: "Save network" })).toBeDisabled();
  await act(async () => {
    useRemoteStore.setState({
      snapshot: { ...active, local: { ...active.local, enabled: false } },
    });
    finish!({ ...web.status!, config: { ...web.status!.config, lanAddress: "10.20.0.10" } });
  });
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("false");
  expect(screen.getByLabelText("Saved address")).toHaveTextContent("10.20.0.10");
});

it("keeps startup errors retryable without applying the computer half of the save", async () => {
  web.status!.config = {
    ...lan.config,
    enabled: true,
    allowPlaintext: true,
    lanAddress: "192.168.20.10",
  };
  useRemoteStore.setState({
    snapshot: {
      ...native,
      local: {
        ...native.local,
        enabled: true,
        address: "192.168.20.10:42987",
      },
    },
  });
  web.request.mockImplementationOnce(async (input) => ({
    ...web.status!,
    config: { ...web.status!.config, lanAddress: input.lanAddress },
    error: "port_in_use",
  }));
  render(<Harness />);
  await choose("10.20.0.10");
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Phone LAN settings failed"),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Computer sharing settings have not been applied",
  );
  expect(screen.getByLabelText("Dirty")).toHaveTextContent("true");
  expect(run).not.toHaveBeenCalled();
});

it("can save a disabled LAN port despite an old address error", async () => {
  web.request.mockImplementationOnce(async () => ({
    ...lan,
    config: { ...lan.config, port: 1442 },
    error: "lan_address_unavailable",
  }));
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Phone LAN port"), { target: { value: "1442" } });
  fireEvent.click(screen.getByRole("button", { name: "Save network" }));
  await waitFor(() => expect(screen.getByLabelText("Dirty")).toHaveTextContent("false"));
  expect(screen.getByText(/Phone LAN settings saved/)).toBeVisible();
  expect(run).not.toHaveBeenCalled();
});

it.each(["address", "port"] as const)(
  "keeps a newer %s draft after an older save callback commits its captured settings",
  async (field) => {
    const hook = renderHook(useRemoteNetworkSettings);
    const view = render(<>{hook.result.current.content}</>);
    await choose("192.168.20.10");
    fireEvent.change(screen.getByLabelText("Phone LAN port"), {
      target: { value: "1442" },
    });
    const saveEarlierDraft = hook.result.current.save;
    view.rerender(<>{hook.result.current.content}</>);
    if (field === "address") await choose("10.20.0.10");
    else
      fireEvent.change(screen.getByLabelText("Phone LAN port"), {
        target: { value: "1443" },
      });

    await act(async () => {
      expect(await saveEarlierDraft()).toBe(true);
    });
    expect(web.request).toHaveBeenCalledExactlyOnceWith({
      operation: "configure",
      target: "lan",
      ...lan.config,
      lanAddress: "192.168.20.10",
      port: 1442,
    });
    expect(hook.result.current.address).toBe("192.168.20.10");
    expect(hook.result.current.dirty).toBe(true);
    view.rerender(<>{hook.result.current.content}</>);
    expect(screen.getByLabelText("Phone LAN port")).toHaveValue(field === "port" ? 1443 : 1442);
    expect(screen.getByRole("combobox", { name: "Shared LAN interface" })).toHaveTextContent(
      field === "address" ? "10.20.0.10" : "192.168.20.10",
    );

    await act(async () => {
      expect(await hook.result.current.save()).toBe(true);
    });
    expect(web.request).toHaveBeenNthCalledWith(2, {
      operation: "configure",
      target: "lan",
      ...lan.config,
      lanAddress: field === "address" ? "10.20.0.10" : "192.168.20.10",
      port: field === "port" ? 1443 : 1442,
    });
    expect(hook.result.current.dirty).toBe(false);
    expect(run).not.toHaveBeenCalled();
  },
);

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "localizes shared network settings in %s",
  async (locale) => {
    await act(() => changeLocale(locale));
    render(<Harness />);
    expect(
      screen.getByRole("combobox", { name: remoteNetworkCopy[locale].interface }),
    ).toBeVisible();
    expect(screen.getByLabelText(remoteNetworkCopy[locale].port)).toBeVisible();
    expect(screen.getByText(remoteNetworkCopy[locale].explicitChoice)).toBeVisible();
  },
);
