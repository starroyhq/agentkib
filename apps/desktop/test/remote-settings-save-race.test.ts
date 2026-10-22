// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Server } from "node:http";
import { initializeI18n } from "@/core/i18n";
import { RemoteConnectionSettings } from "@/features/remote/RemoteConnectionPanel";
import { useRemoteStore } from "@/features/remote/remote-store";
import { requestWebAdmin } from "@/features/remote/web-status";
import {
  HOSTED_ORIGIN,
  WebAccessService,
  type WebAdminRequest,
} from "../electron/main/web/service";

const adapters = vi.hoisted(() => ({ web: vi.fn(), native: vi.fn(), account: vi.fn() }));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    web: { request: adapters.web },
    account: { request: adapters.account, onStatus: () => () => {} },
  }),
}));
vi.mock("@/core/api", () => ({
  api: { remoteRequest: (input: unknown) => adapters.native(input) },
}));

let service: WebAccessService;
let directory: string;
let firstPort: number;
let nextPort: number;
const native = {
  local: { id: "fixture", name: "Fixture computer", enabled: false, address: null },
  interfaces: [
    { name: "Synthetic fixture", address: "192.168.20.10" },
    { name: "Second synthetic fixture", address: "10.20.0.10" },
  ],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const local = {
  config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
  running: false,
  localUrl: "http://127.0.0.1:1421",
  experimentalAvailable: false,
  pending: [],
  devices: [],
};
async function freePort() {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}
async function persistedLan() {
  return JSON.parse(await readFile(join(directory, "web-access.json"), "utf8")) as {
    config: { enabled: boolean; port: number; lanAddress: string };
    credentials: unknown[];
  };
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  firstPort = await freePort();
  nextPort = await freePort();
  // Exercise the real service and persistence without exposing the synthetic interface.
  const listen = Server.prototype.listen;
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (
    this: Server,
    ...args: unknown[]
  ) {
    args[1] = "127.0.0.1";
    return Reflect.apply(listen, this, args);
  } as typeof listen);
  directory = await mkdtemp(join(tmpdir(), "agentkib-settings-save-race-"));
  service = new WebAccessService({
    mode: "lan",
    dataDir: directory,
    staticDir: directory,
    runtimeRequest: async () => ({}),
    addresses: () => native.interfaces,
  });
  await service.initialize();
  await service.request({
    operation: "configure",
    enabled: true,
    port: firstPort,
    externalOrigin: HOSTED_ORIGIN,
    experimentalEnabled: false,
    lanAddress: "192.168.20.10",
    allowPlaintext: true,
  });
  adapters.native.mockReset().mockResolvedValue(native);
  adapters.account.mockReset().mockResolvedValue({ phase: "signed-out", secureStorage: true });
  adapters.web
    .mockReset()
    .mockImplementation((input: WebAdminRequest) =>
      input.target === "lan" ? service.request(input) : Promise.resolve(local),
    );
  useRemoteStore.setState({ snapshot: native, busy: false, loading: false });
});
afterEach(async () => {
  cleanup();
  try {
    await service?.dispose();
  } finally {
    vi.restoreAllMocks();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

it("blocks LAN changes while a deferred unified save still owns an older network draft", async () => {
  let finishLocal!: (value: typeof local) => void;
  adapters.web.mockImplementation((input: WebAdminRequest) => {
    if (input.target === "lan") return service.request(input);
    if (input.operation === "configure")
      return new Promise<typeof local>((resolve) => {
        finishLocal = resolve;
      });
    return Promise.resolve(local);
  });
  render(createElement(RemoteConnectionSettings));
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  await screen.findByLabelText("Phone LAN port");
  fireEvent.change(screen.getByLabelText("Phone LAN port"), {
    target: { value: String(nextPort) },
  });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(finishLocal).toBeTypeOf("function"));
  const openLan = screen.getByRole("button", { name: "Set up LAN direct connection" });
  try {
    expect(openLan).toBeDisabled();
    fireEvent.click(openLan);
    expect(screen.queryByRole("dialog", { name: "LAN direct connection" })).toBeNull();
  } finally {
    await act(async () => finishLocal({ ...local, config: { ...local.config, port: 1444 } }));
  }
  await waitFor(async () => expect((await persistedLan()).config.port).toBe(nextPort));
  await waitFor(() => expect(openLan).toBeEnabled());
  fireEvent.click(openLan);
  const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
  await waitFor(async () => expect((await persistedLan()).config.enabled).toBe(false));
  expect((await service.request({ operation: "status" })).running).toBe(false);
  expect((await persistedLan()).credentials).toEqual([]);
});

it("keeps every unified control locked after a pending LAN dialog is closed", async () => {
  render(createElement(RemoteConnectionSettings));
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  await screen.findByLabelText("Phone LAN port");
  fireEvent.change(screen.getByLabelText("Phone LAN port"), {
    target: { value: String(nextPort) },
  });
  fireEvent.change(screen.getByLabelText("Port"), { target: { value: "1444" } });
  fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
  fireEvent.click(screen.getByRole("button", { name: "Share this computer" }));
  fireEvent.change(screen.getByRole("textbox", { name: "This device name" }), {
    target: { value: "Renamed fixture" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Phones" }));
  fireEvent.click(screen.getByRole("button", { name: "Set up LAN direct connection" }));
  const dialog = await screen.findByRole("dialog", { name: "LAN direct connection" });
  const persistence = service as unknown as { save(): Promise<void> };
  const save = persistence.save.bind(service);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pendingSave = vi.spyOn(persistence, "save").mockImplementationOnce(async () => {
    await gate;
    await save();
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Enable LAN direct connection" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(pendingSave).toHaveBeenCalledOnce());
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  try {
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
    expect(screen.getByLabelText("Port")).toBeDisabled();
    expect(screen.getByLabelText("Phone LAN port")).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Shared LAN interface" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
    expect(screen.getByRole("textbox", { name: "This device name" })).toBeDisabled();
    const sharing = screen.getByRole("switch", {
      name: "Allow other computers to view (read-only)",
    });
    expect(sharing).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(sharing);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(
      adapters.web.mock.calls.filter(([input]) => input.operation === "configure"),
    ).toHaveLength(1);
    expect(adapters.native.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
  } finally {
    await act(async () => release());
  }
  await waitFor(async () => expect((await persistedLan()).config.enabled).toBe(false));
  expect((await service.request({ operation: "status" })).running).toBe(false);
});

it("does not use an unpersisted LAN interface after the entire settings view remounts", async () => {
  const user = userEvent.setup();
  const view = render(createElement(RemoteConnectionSettings));
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  await user.click(await screen.findByRole("combobox", { name: "Shared LAN interface" }));
  await user.click(await screen.findByRole("option", { name: /10\.20\.0\.10/ }));
  const persistence = service as unknown as { save(): Promise<void> };
  const failedWrite = vi
    .spyOn(persistence, "save")
    .mockRejectedValueOnce(new Error("fixture write failed"));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((notice) => notice.textContent?.includes("Phone LAN settings failed")),
    ).toBe(true),
  );
  expect(failedWrite).toHaveBeenCalledOnce();
  expect((await service.request({ operation: "status" })).config.lanAddress).toBe("10.20.0.10");
  expect((await persistedLan()).config.lanAddress).toBe("192.168.20.10");
  view.unmount();
  failedWrite.mockRestore();

  render(createElement(RemoteConnectionSettings));
  fireEvent.click(await screen.findByRole("button", { name: "Advanced settings" }));
  await act(async () => {
    await requestWebAdmin({ operation: "status", target: "lan" });
  });
  fireEvent.click(screen.getByRole("button", { name: "Other computers" }));
  fireEvent.click(screen.getByRole("button", { name: "Share this computer" }));
  const sharing = screen.getByRole("switch", { name: "Allow other computers to view (read-only)" });
  expect(sharing).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(sharing);
  expect(adapters.native.mock.calls.every(([input]) => input.operation === "status")).toBe(true);

  // Only another explicit successful save may authorize this in-memory address.
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(async () => expect((await persistedLan()).config.lanAddress).toBe("10.20.0.10"));
  await waitFor(() => expect(sharing).not.toHaveAttribute("aria-disabled", "true"));
  expect(adapters.native.mock.calls.every(([input]) => input.operation === "status")).toBe(true);
});
