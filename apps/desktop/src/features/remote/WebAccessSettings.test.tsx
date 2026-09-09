// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
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
it("does not enable service until settings are saved", async () => {
  render(<WebAccessSettings />);
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
