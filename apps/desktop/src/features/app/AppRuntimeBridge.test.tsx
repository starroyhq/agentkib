// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { changeLocale, initializeI18n } from "@/core/i18n";
import { api } from "@/core/api";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import type { DesktopRuntimeStatus } from "../../../electron/api";
import { AppRuntimeBridge } from "./AppRuntimeBridge";
import { useSidebarWidthStore } from "./sidebar-width-store";

const { runtimeInfo, addWorkspace, setAccentThemePreference, setSidebarWidthPreference } =
  vi.hoisted(() => ({
    runtimeInfo: vi.fn(),
    addWorkspace: vi.fn(),
    setAccentThemePreference: vi.fn(),
    setSidebarWidthPreference: vi.fn(),
  }));

vi.mock("@/core/api", () => ({
  api: {
    runtime: runtimeInfo,
    addWorkspace,
    setAccentThemePreference,
    setSidebarWidthPreference,
    quitApp: vi.fn(),
  },
}));

describe("AppRuntimeBridge", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-accent-theme");
    useAppStore.getState().reset();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useSidebarWidthStore.setState(useSidebarWidthStore.getInitialState());
    await initializeI18n("zh-CN");
  });

  it.each([
    [true, "AgentKib is applying a ChangeSet. Wait for it to finish before quitting.", "OK"],
    [false, "Discard unsaved workspace drafts and quit AgentKib?", "Cancel"],
  ])(
    "uses the new locale for quit prompts without leaking subscriptions (applying: %s)",
    async (applyingChanges, description, dismiss) => {
      runtimeInfo.mockResolvedValue({
        effective_theme: "light",
        effective_locale: "zh-CN",
        accent_theme_preference: "vtron",
      });
      window.agentkibDesktop!.runtime.status = vi
        .fn()
        .mockResolvedValue({ state: "ready", restartCount: 0 });
      useWorkspaceStore.setState({
        applyingChanges,
        workspaceDrafts: {
          draft: {
            schema_version: 1,
            workspace: { id: "draft", name: "Draft" },
            instructions: { shared: "", scoped: [], platform_overrides: {} },
            skills: [],
            mcp: { config: "" },
            connections: [],
            memories: { require_approval: true },
            adapters: {},
          },
        },
      });
      const listeners = new Set<() => void>();
      const unsubscribers: ReturnType<typeof vi.fn>[] = [];
      vi.spyOn(window.agentkibDesktop!.events, "onQuitRequested").mockImplementation((listener) => {
        listeners.add(listener);
        const unsubscribe = vi.fn(() => {
          listeners.delete(listener);
        });
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const mounted = render(
        <QueryClientProvider client={queryClient}>
          <AppDialogProvider>
            <AppRuntimeBridge />
          </AppDialogProvider>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(useAppStore.getState().runtime?.effective_locale).toBe("zh-CN"));
      await act(async () => {
        await changeLocale("en-US");
      });
      expect(listeners.size).toBe(1);
      act(() => {
        listeners.forEach((listener) => listener());
      });
      expect(await screen.findByText(description)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: dismiss }));
      await waitFor(() => expect(screen.queryByText(description)).toBeNull());
      await act(async () => {
        await changeLocale("ja-JP");
      });
      expect(listeners.size).toBe(1);
      mounted.unmount();
      expect(listeners.size).toBe(0);
      expect(unsubscribers.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
      expect(api.quitApp).not.toHaveBeenCalled();
    },
  );

  it("reads workspace drafts at quit time instead of on every render", async () => {
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "en-US",
      accent_theme_preference: "vtron",
    });
    await changeLocale("en-US");
    let quit: (() => void) | undefined;
    vi.spyOn(window.agentkibDesktop!.events, "onQuitRequested").mockImplementation((listener) => {
      quit = listener;
      return () => undefined;
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(useAppStore.getState().runtime?.effective_locale).toBe("en-US"));
    const manifest = { schema_version: 1 } as never;
    act(() => {
      useWorkspaceStore.setState({ manifest, baselineManifest: "{}" });
    });
    expect(stringify).not.toHaveBeenCalledWith(manifest);

    act(() => quit!());
    expect(
      await screen.findByText("Discard unsaved workspace drafts and quit AgentKib?"),
    ).toBeTruthy();
    expect(stringify).toHaveBeenCalledWith(manifest);
  });

  it("synchronizes Runtime information when legacy workspace migration fails", async () => {
    window.localStorage.setItem("agentkib.project", "/missing/legacy-workspace");
    addWorkspace.mockRejectedValue(new Error("legacy workspace missing"));
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "vtron",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(addWorkspace).toHaveBeenCalledWith("/missing/legacy-workspace"));
    await waitFor(() => expect(runtimeInfo).toHaveBeenCalledOnce());
    expect(useAppStore.getState().runtime).toMatchObject({ effective_locale: "zh-CN" });
    expect(window.localStorage.getItem("agentkib.project")).toBe("/missing/legacy-workspace");
  });

  it.each([undefined, "new workspace error"])(
    "clears only its own startup error after Runtime recovery (new message: %s)",
    async (newMessage) => {
      let statusListener: ((status: DesktopRuntimeStatus) => void) | undefined;
      const retry = vi.fn().mockResolvedValue(undefined);
      const desktop = window.agentkibDesktop!;
      desktop.events.onRuntimeStatus = vi.fn((listener) => {
        statusListener = listener;
        return () => undefined;
      });
      desktop.runtime.status = vi.fn().mockResolvedValue({
        state: "failed",
        restartCount: 3,
        error: "fixture startup failure",
      });
      desktop.runtime.retry = retry;
      runtimeInfo.mockRejectedValue(new Error("fixture startup failure"));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

      render(
        <QueryClientProvider client={queryClient}>
          <AppDialogProvider>
            <AppRuntimeBridge />
          </AppDialogProvider>
        </QueryClientProvider>,
      );

      expect((await screen.findByRole("alert")).textContent).toContain("本地 Runtime 启动失败");
      await waitFor(() =>
        expect(useWorkspaceStore.getState().message).toContain("fixture startup failure"),
      );
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await waitFor(() => expect(retry).toHaveBeenCalledOnce());

      runtimeInfo.mockResolvedValue({
        effective_theme: "light",
        effective_locale: "zh-CN",
        accent_theme_preference: "vtron",
      });
      if (newMessage) useWorkspaceStore.getState().setMessage(newMessage);
      await act(async () => statusListener?.({ state: "ready", restartCount: 0 }));
      await waitFor(() => expect(runtimeInfo).toHaveBeenCalledTimes(2));
      expect(useAppStore.getState().runtime).toMatchObject({ effective_locale: "zh-CN" });
      expect(useWorkspaceStore.getState().message).toBe(newMessage ?? "");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("clears the old startup error when focus successfully synchronizes Runtime", async () => {
    window.agentkibDesktop!.runtime.status = vi
      .fn()
      .mockResolvedValue({ state: "ready", restartCount: 0 });
    runtimeInfo.mockRejectedValue(new Error("fixture startup failure"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(useWorkspaceStore.getState().message).toContain("fixture startup failure"),
    );
    // A failed refresh must keep the diagnostic until the Runtime actually recovers.
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(runtimeInfo).toHaveBeenCalledTimes(2));
    expect(useWorkspaceStore.getState().message).toContain("fixture startup failure");
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "vtron",
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(useWorkspaceStore.getState().message).toBe(""));
  });

  it("migrates a legacy cached accent when Runtime has no preference", async () => {
    window.localStorage.setItem("agentkib.accent-theme", "black");
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: null,
    });
    setAccentThemePreference.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "minimal-neutral",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(setAccentThemePreference).toHaveBeenCalledWith("minimal-neutral"));
    expect(useAppStore.getState().runtime).toMatchObject({
      accent_theme_preference: "minimal-neutral",
    });
    expect(document.documentElement.dataset.accentTheme).toBe("minimal-neutral");
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("minimal-neutral");
  });

  it("uses the Runtime accent as authoritative over the startup cache", async () => {
    window.localStorage.setItem("agentkib.accent-theme", "sakura");
    runtimeInfo.mockResolvedValue({
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "ocean-breeze",
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(document.documentElement.dataset.accentTheme).toBe("ocean-breeze"));
    expect(setAccentThemePreference).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("agentkib.accent-theme")).toBe("ocean-breeze");
  });

  it("restores sidebar width and rejects a focus response older than the completed save", async () => {
    const initial = {
      effective_theme: "light",
      effective_locale: "zh-CN",
      accent_theme_preference: "vtron",
      sidebar_width_preference: 300,
    };
    runtimeInfo.mockResolvedValue(initial);
    window.agentkibDesktop!.runtime.status = vi
      .fn()
      .mockResolvedValue({ state: "ready", restartCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AppDialogProvider>
          <AppRuntimeBridge />
        </AppDialogProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(useSidebarWidthStore.getState().width).toBe(300));
    let resolve!: (value: typeof initial) => void;
    runtimeInfo.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent(window, new Event("focus"));
    setSidebarWidthPreference.mockResolvedValue({ ...initial, sidebar_width_preference: 360 });
    await act(async () => {
      await useSidebarWidthStore.getState().save(360);
    });
    await act(async () => resolve(initial));
    expect(useSidebarWidthStore.getState().width).toBe(360);
    expect(useAppStore.getState().runtime?.sidebar_width_preference).toBe(360);
  });
});
