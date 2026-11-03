// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopAccountStatus } from "../../../electron/main/account/state";
import { useDesktopReadScope } from "./read-state-scope";
const original = window.agentkibDesktop;
afterEach(() => {
  cleanup();
  Object.defineProperty(window, "agentkibDesktop", { configurable: true, value: original });
  vi.restoreAllMocks();
});
it("fences account/phase changes immediately and ignores a late initial identity read", async () => {
  let receive!: (value: DesktopAccountStatus) => void,
    finish!: (value: DesktopAccountStatus) => void;
  const request = vi.fn(
    () =>
      new Promise<DesktopAccountStatus>((resolve) => {
        finish = resolve;
      }),
  );
  const account = {
    request,
    onStatus: (listener: typeof receive) => {
      receive = listener;
      return vi.fn();
    },
  };
  Object.defineProperty(window, "agentkibDesktop", {
    configurable: true,
    value: { ...original, account },
  });
  const view = renderHook(useDesktopReadScope);
  expect(view.result.current.ready).toBe(false);
  expect(view.result.current.identityKey).toBeUndefined();
  const signedIn = (id: string): DesktopAccountStatus => ({
    phase: "signed-in",
    secureStorage: true,
    account: {
      id,
      username: id,
      status: "active",
      deviceLimit: 3,
      deviceCount: 1,
      totpEnabled: false,
    },
  });
  await act(async () => receive(signedIn("account-b")));
  const current = view.result.current;
  expect(current.ready).toBe(true);
  expect(current.key).toContain("account-b");
  expect(current.identityKey).toContain("account-b");
  await act(async () => receive(signedIn("account-b")));
  expect(view.result.current.identityKey).toBe(current.identityKey);
  await act(async () => finish(signedIn("old-account-a")));
  expect(view.result.current).toBe(current);
  await act(async () => receive({ phase: "signing-in", secureStorage: true }));
  expect(view.result.current.ready).toBe(false);
  expect(view.result.current.identityKey).toBeUndefined();
  await act(async () => receive({ phase: "signed-out", secureStorage: true }));
  expect(view.result.current.ready).toBe(true);
  expect(view.result.current.key).not.toBe(current.key);
});
