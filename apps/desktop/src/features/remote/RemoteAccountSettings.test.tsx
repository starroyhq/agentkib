// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, changeLocale } from "@/core/i18n";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import { RemoteAccountSettings } from "./RemoteAccountSettings";
import { remoteAccountCopy } from "./remote-account-copy";

const request = vi.fn();
const refresh = vi.fn();
const release = vi.fn();
let listener: ((value: DesktopAccountStatus) => void) | undefined;
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    account: {
      request,
      onStatus: (next: typeof listener) => {
        listener = next;
        return release;
      },
    },
  }),
}));
vi.mock("./web-status", () => ({ requestWebAdmin: (value: unknown) => refresh(value) }));
const signedOut: DesktopAccountStatus = { phase: "signed-out", secureStorage: true };
const signedIn: DesktopAccountStatus = {
  phase: "signed-in",
  secureStorage: true,
  account: {
    id: "account-1",
    username: "test-user",
    status: "active",
    deviceLimit: 3,
    deviceCount: 1,
    totpEnabled: false,
  },
  device: { deviceId: "a".repeat(32), ownership: "unclaimed" },
};
beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  await changeLocale("en-US");
  request.mockReset().mockResolvedValue(signedOut);
  refresh.mockReset().mockResolvedValue({});
  release.mockReset();
  listener = undefined;
});
afterEach(cleanup);

it("starts browser sign-in without enabling remote access and accepts async completion", async () => {
  render(<RemoteAccountSettings />);
  const login = await screen.findByRole("button", { name: "Sign in with your browser" });
  await waitFor(() => expect(login).toBeEnabled());
  request.mockResolvedValueOnce({ phase: "signing-in", secureStorage: true });
  fireEvent.click(login);
  expect(await screen.findByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  act(() => listener?.(signedIn));
  expect(await screen.findByText("test-user")).toBeVisible();
  expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["status", "login"]);
  expect(refresh).not.toHaveBeenCalled();
});

it("does not overwrite a login event with an older initial read", async () => {
  let resolve!: (value: DesktopAccountStatus) => void;
  request.mockReturnValueOnce(
    new Promise<DesktopAccountStatus>((done) => {
      resolve = done;
    }),
  );
  render(<RemoteAccountSettings />);
  act(() => listener?.(signedIn));
  await act(async () => resolve(signedOut));
  expect(screen.getByText("test-user")).toBeVisible();
});

it("claims only on explicit action and refreshes remote state after logout", async () => {
  request.mockResolvedValue(signedIn);
  const view = render(<RemoteAccountSettings />);
  const claim = await screen.findByRole("button", { name: "Link this computer to this account" });
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce({
    ...signedIn,
    device: { ...signedIn.device, ownership: "owned" },
  });
  fireEvent.click(claim);
  await screen.findByText("This computer is linked to this account");
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  request.mockResolvedValueOnce(signedOut);
  fireEvent.click(screen.getByRole("button", { name: "Sign out and pause public access" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  expect(request).toHaveBeenLastCalledWith({ operation: "logout" });
  expect(screen.getByRole("status")).toHaveTextContent("Signed out");
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("does not expose claim for a computer belonging to another account", async () => {
  request.mockResolvedValue({ ...signedIn, device: { ...signedIn.device, ownership: "other" } });
  render(<RemoteAccountSettings />);
  await screen.findByText(
    "This computer belongs to another account. Sign in to the original account.",
  );
  expect(screen.queryByRole("button", { name: "Link this computer to this account" })).toBeNull();
});

it("blocks login without safe storage and never renders raw service errors", async () => {
  request.mockResolvedValue({
    phase: "error",
    secureStorage: false,
    error: "server-supplied-secret",
  });
  render(<RemoteAccountSettings />);
  await screen.findByText(remoteAccountCopy["en-US"].storage);
  expect(screen.getByRole("button", { name: "Sign in with your browser" })).toBeDisabled();
  expect(screen.queryByText("server-supplied-secret")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent(remoteAccountCopy["en-US"].failed);
});

it.each(Object.keys(remoteAccountCopy) as (keyof typeof remoteAccountCopy)[])(
  "shows account controls in %s",
  async (locale) => {
    await changeLocale(locale);
    render(<RemoteAccountSettings />);
    expect(
      await screen.findByRole("heading", { name: remoteAccountCopy[locale].title }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: remoteAccountCopy[locale].login })).toBeVisible();
  },
);

it("cancels an in-progress browser sign-in without changing Web access", async () => {
  request.mockResolvedValue({ phase: "signing-in", secureStorage: true });
  render(<RemoteAccountSettings variant="step" />);
  const cancel = await screen.findByRole("button", { name: "Cancel sign-in" });
  request.mockResolvedValueOnce(signedOut);
  fireEvent.click(cancel);
  expect(await screen.findByRole("button", { name: "Sign in with your browser" })).toBeEnabled();
  expect(request).toHaveBeenLastCalledWith({ operation: "cancel-login" });
  expect(refresh).not.toHaveBeenCalled();
});
it("shows how the account lists this computer once the name is known", async () => {
  request.mockResolvedValue({
    ...signedIn,
    device: { deviceId: "a".repeat(32), ownership: "owned", name: "Alice’s MacBook (2)" },
  });
  render(<RemoteAccountSettings />);
  expect(
    await screen.findByText("This computer appears as Alice’s MacBook (2) in your account"),
  ).toBeVisible();
  cleanup();
  request.mockResolvedValue({
    ...signedIn,
    device: { deviceId: "a".repeat(32), ownership: "owned" },
  });
  render(<RemoteAccountSettings />);
  expect(await screen.findByText(remoteAccountCopy["en-US"].owned)).toBeVisible();
  expect(screen.queryByText(/appears as/)).toBeNull();
});
