// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { WebAccessSettings } from "./WebAccessSettings";
import { ConnectionQr } from "./ConnectionQr";

const request = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ web: { request } }) }));
const status = {
  config: {
    enabled: false,
    port: 1422,
    externalOrigin: "https://remote.agentkib.com",
    experimentalEnabled: false,
    lanAddress: "192.168.1.10",
    allowPlaintext: false,
  },
  running: false,
  localUrl: "http://192.168.1.10:1422",
  addresses: [{ name: "en0", address: "192.168.1.10" }],
  pending: [],
  devices: [],
  experimentalAvailable: false,
};
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => request.mockReset().mockResolvedValue(status));
afterEach(cleanup);

it("requires plaintext acknowledgement and routes configuration to LAN only", async () => {
  render(<WebAccessSettings target="lan" />);
  fireEvent.click(await screen.findByRole("switch", { name: "Enable LAN direct connection" }));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  expect(request).toHaveBeenCalledWith({ operation: "status", target: "lan" });
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "configure",
      target: "lan",
      ...status.config,
      enabled: true,
      allowPlaintext: true,
    }),
  );
});

it("does not allow enabling a disappeared address, but allows disabling it", async () => {
  request.mockResolvedValue({
    ...status,
    config: { ...status.config, enabled: true, allowPlaintext: true },
    addresses: [],
    error: "lan_address_unavailable",
  });
  render(<WebAccessSettings target="lan" />);
  await screen.findByRole("alert");
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("switch", { name: "Enable LAN direct connection" }));
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
});

it("shows an address-only QR and link only for a running listener", async () => {
  const connectionUrl = "https://remote.agentkib.com/#connect=http%3A%2F%2F192.168.1.10%3A1422";
  request.mockResolvedValue({ ...status, running: true, connectionUrl });
  render(<WebAccessSettings target="lan" />);
  expect(await screen.findByRole("img", { name: /Scan to connect/ })).toBeVisible();
  expect(screen.getByLabelText("Connection link")).toHaveValue(connectionUrl);
  expect(screen.getByRole("switch", { name: /Enable experimental/ })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

it("does not reuse local browser authorization when granting LAN access", async () => {
  request.mockResolvedValue({
    ...status,
    pending: [
      { id: "p", name: "Chromium", verification: "12345678", expiresAt: Date.now() + 10000 },
    ],
  });
  render(<WebAccessSettings target="lan" />);
  await screen.findByText("Chromium");
  fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith({
      operation: "approve",
      target: "lan",
      id: "p",
      send: false,
      approve: false,
    }),
  );
});

it("renders QR geometry locally and updates it when the endpoint changes", () => {
  const view = render(
    <ConnectionQr
      label="QR"
      url="https://remote.agentkib.com/#connect=http%3A%2F%2F192.168.1.10%3A1422"
    />,
  );
  const path = view.container.querySelector("path")?.getAttribute("d");
  expect(path).toContain("M");
  view.rerender(
    <ConnectionQr
      label="QR"
      url="https://remote.agentkib.com/#connect=http%3A%2F%2F192.168.1.11%3A1422"
    />,
  );
  expect(view.container.querySelector("path")?.getAttribute("d")).not.toBe(path);
  expect(view.container.querySelector("image")).toBeNull();
});
