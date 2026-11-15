// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useLayoutEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { AppMessageBanner } from "./AppMessageBanner";
import { usePageMessageScope } from "./usePageMessageScope";

function Scope() {
  usePageMessageScope(useLocation({ select: (location) => location.href }));
  return <Outlet />;
}
function Page({ failure }: { failure?: string }) {
  useLayoutEffect(() => {
    if (failure) useWorkspaceStore.getState().setMessage(failure);
  }, [failure]);
  return (
    <>
      <AppMessageBanner />
      <textarea aria-label="Draft" defaultValue="Keep this draft" />
    </>
  );
}
async function start() {
  const root = createRootRoute({ component: Scope });
  const first = createRoute({ getParentRoute: () => root, path: "/workspaces", component: Page });
  const second = createRoute({ getParentRoute: () => root, path: "/catalog", component: Page });
  const failed = createRoute({
    getParentRoute: () => root,
    path: "/insights",
    component: () => <Page failure="New destination failure" />,
  });
  const repeated = createRoute({
    getParentRoute: () => root,
    path: "/quota",
    component: () => <Page failure="Old failure" />,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    component: () => <p>Settings page</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/workspaces"] });
  const router = createRouter({
    routeTree: root.addChildren([first, second, failed, repeated, settings]),
    history,
  });
  render(<RouterProvider router={router} />);
  await screen.findByRole("textbox", { name: "Draft" });
  return router;
}
beforeEach(async () => {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  await initializeI18n("en-US");
});
afterEach(cleanup);

describe("global action notice", () => {
  it.each([
    ["en-US", "Close"],
    ["zh-CN", "关闭"],
    ["zh-Hant", "關閉"],
    ["ja-JP", "閉じる"],
  ] as const)(
    "can be dismissed with the keyboard in %s without changing the draft or apply lock",
    async (locale, close) => {
      await initializeI18n(locale);
      useWorkspaceStore.setState({ applyingChanges: true });
      useWorkspaceStore.getState().setMessage("Write failed");
      render(<Page />);
      expect(screen.getByRole("alert")).toHaveTextContent("Write failed");
      const button = screen.getByRole("button", { name: close });
      const user = userEvent.setup();
      await user.tab();
      expect(button).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("Keep this draft");
      expect(useWorkspaceStore.getState()).toMatchObject({
        message: "Write failed",
        applyingChanges: true,
        messageDismissed: true,
      });
      act(() => useWorkspaceStore.getState().setMessage("Write failed"));
      expect(screen.getByRole("alert")).toHaveTextContent("Write failed");
    },
  );

  it("retires an old notice on navigation and keeps it retired after returning from settings", async () => {
    const router = await start();
    act(() => useWorkspaceStore.getState().setMessage("Old failure"));
    expect(screen.getByRole("alert")).toBeVisible();
    await act(async () => router.navigate({ to: "/catalog" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => router.navigate({ to: "/settings" }));
    expect(screen.getByText("Settings page")).toBeVisible();
    await act(async () => router.navigate({ to: "/workspaces" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useWorkspaceStore.getState().message).toBe("Old failure");
  });

  it.each(["/insights", "/quota"] as const)(
    "retains an error published by the destination at %s during commit",
    async (to) => {
      const router = await start();
      act(() => useWorkspaceStore.getState().setMessage("Old failure"));
      await act(async () => router.navigate({ to }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          to === "/insights" ? "New destination failure" : "Old failure",
        ),
      );
      expect(useWorkspaceStore.getState().messageDismissed).toBe(false);
    },
  );

  it.each(["Write failed", "Another failure"])(
    "does not dismiss a newer %s before the new render commits",
    (next) => {
      useWorkspaceStore.getState().setMessage("Write failed");
      render(<Page />);
      const close = screen.getByRole("button", { name: "Close" });
      act(() => {
        useWorkspaceStore.getState().setMessage(next);
        fireEvent.click(close);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(next);
      expect(useWorkspaceStore.getState().messageDismissed).toBe(false);
    },
  );
});
