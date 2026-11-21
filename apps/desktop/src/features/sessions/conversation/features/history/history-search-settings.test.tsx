// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type ConversationClientBridge,
  type HistorySearchStatus,
} from "@agentkib/web-client";
import {
  AppNavigationProvider,
  type AppNavigationContextValue,
} from "@/features/app/AppNavigationContext";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { GlobalSearchDialog } from "@/features/app/GlobalSearchDialog";
import { initializeI18n } from "@/core/i18n";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { DesktopHistorySearch } from "@/features/sessions/DesktopHistorySearch";
import { EmbeddedConversation } from "../../conversation";
import { HistorySearchPanel, historyAccessScope, historyCopy } from "@agentkib/session-ui";
import { render } from "../../desktop-reader-test-utils";

const doubles = vi.hoisted(() => ({
  client: undefined as WebClient | undefined,
  notify: vi.fn().mockResolvedValue(undefined),
  searchChanged: vi.fn(),
  variant: "directory",
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => doubles.client,
  hasDesktopConversation: () => true,
}));
vi.mock("@/features/sessions/SessionHubContext", () => ({
  useSessionHub: () => ({ selected: undefined, select: vi.fn() }),
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: vi.fn().mockResolvedValue(false) }),
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeWorkspaces: () => ({ data: [], isPending: false }),
  useHomeMemories: () => ({ data: [] }),
  useHomeRefreshJobs: () => ({ data: [] }),
}));
vi.mock("@/features/app/useSearchSessions", () => ({
  useSearchSessions: () => ({ sessions: [], loading: false, errors: {}, retry: vi.fn() }),
}));
vi.mock("@/features/app/useSearchAssets", () => ({
  SEARCH_ASSET_LIMIT: 500,
  useSearchAssets: () => ({
    assets: [],
    loading: false,
    error: "",
    limited: false,
    retry: vi.fn(),
  }),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => ({ sessions: [], ready: true }),
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({
  useRemoteCatalogEntries: () => ({ sessions: [], workspaces: [] }),
}));
const c = historyCopy["en-US"];
const status: HistorySearchStatus = {
  enabled: false,
  generation: "index",
  bytes: 0,
  limitBytes: 10000,
  budgetExceeded: false,
  coverage: {
    total: 0,
    ready: 0,
    building: 0,
    partial: 0,
    stale: 0,
    unavailable: 0,
    limitations: [],
  },
};
function fixture() {
  const grant = {
    protocolVersion: 2,
    status: "approved" as const,
    csrfToken: "test",
    bootId: "boot",
    experimentalEnabled: true,
    historySearch: true as const,
    historySearchScope: "scope",
    device: { id: "local", name: "Test", send: true, approve: true },
  };
  const live = (sessionId: string) => ({
    sessionId,
    status: "idle",
    revision: 1,
    sendEnabled: true,
    approvals: [],
    questions: [],
  });
  const request = vi.fn(async (path: string) => {
    const operation = path.split("?")[0];
    const id = new URLSearchParams(path.split("?")[1]).get("sessionId") ?? "";
    const result =
      operation === "access"
        ? grant
        : operation === "history/status"
          ? status
          : operation === "catalog"
            ? {
                indexEnabled: true,
                workspaces: [{ id: "workspace", name: "Workspace", path: "/workspace" }],
                sessions: [
                  {
                    id: "first",
                    workspace_id: "workspace",
                    agent: "claude-code",
                    availability: "readable",
                    archived: false,
                    sidechain: false,
                    origin: "interactive",
                  },
                ],
              }
            : operation === "events"
              ? {
                  events: [
                    {
                      id: "message",
                      kind: "agent-message",
                      content: "first history",
                      attachment_count: 0,
                      truncated: false,
                    },
                  ],
                  warnings: [],
                }
              : operation === "live"
                ? live(id)
                : { available: false };
    return result;
  });
  const bridge: ConversationClientBridge = {
    async request<T>(path: string) {
      return (await request(path)) as T;
    },
    stream(id, handlers) {
      let closed = false;
      queueMicrotask(() => {
        if (closed) return;
        handlers.open();
        if (id)
          handlers.event(
            "session-event",
            JSON.stringify({
              protocolVersion: 2,
              subscriptionId: id,
              sessionId: id,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor",
              type: "snapshot",
              payload: { live: live(id) },
            }),
          );
      });
      return () => {
        closed = true;
      };
    },
    uploadAttachment: vi.fn(),
  };
  return { client: new WebClient(undefined, { type: "same-origin" }, bridge), request, grant };
}
function MainRoot() {
  const app = useAppNavigation();
  return (
    <AppNavigationProvider value={{ app } as AppNavigationContextValue}>
      <Outlet />
    </AppNavigationProvider>
  );
}
function GlobalSearchHarness() {
  const [open, setOpen] = useState(true);
  return (
    <GlobalSearchDialog
      open={open}
      onOpenChange={(next) => {
        doubles.searchChanged(next);
        setOpen(next);
      }}
      entries={[]}
      workspaces={[]}
      onNavigate={vi.fn()}
      onOpenWorkspace={vi.fn()}
      onOpenSession={vi.fn()}
      onSessionSettings={vi.fn()}
    />
  );
}
async function renderMainRouter(variant: "directory" | "embedded" | "global-search") {
  doubles.variant = variant;
  const f = fixture();
  doubles.client = f.client;
  const root = createRootRoute({ component: MainRoot });
  const sessions = createRoute({
    getParentRoute: () => root,
    path: "/sessions",
    component: () =>
      doubles.variant === "directory" ? (
        <DesktopHistorySearch />
      ) : doubles.variant === "global-search" ? (
        <GlobalSearchHarness />
      ) : (
        <EmbeddedConversation
          client={f.client}
          sessionId="first"
          locale="en-US"
          initialPanel="search"
          onSessionChange={vi.fn()}
        />
      ),
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/settings",
    validateSearch: (search: Record<string, unknown>) => ({
      settingsSection: search.settingsSection,
    }),
    component: () => <p>Main settings destination</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([sessions, settings]),
    history: createMemoryHistory({ initialEntries: ["/sessions"] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  if (variant === "global-search") {
    fireEvent.change(await screen.findByRole("combobox"), {
      target: { value: "retained query" },
    });
  }
  if (variant === "embedded") await screen.findByRole("dialog", { name: c.title });
  else {
    fireEvent.click(await screen.findByRole("button", { name: c.title }));
    await screen.findByText(c.disabled);
  }
  return { ...f, router };
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  sessionStorage.clear();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  doubles.notify.mockClear();
  doubles.searchChanged.mockClear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop content search settings navigation", () => {
  it.each(["directory", "embedded"] as const)(
    "opens main Privacy settings from the %s search",
    async (variant) => {
      const f = await renderMainRouter(variant);
      fireEvent.click(screen.getByRole("button", { name: c.openSettings }));
      await screen.findByText("Main settings destination");
      expect(f.router.state.location.pathname).toBe("/settings");
      expect(f.router.state.location.search).toMatchObject({ settingsSection: "privacy" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        f.request.mock.calls.some(([path]) => /history\/(configure|clear|rebuild)/.test(path)),
      ).toBe(false);
    },
  );
  it("uses the existing apply guard when settings navigation is blocked", async () => {
    const f = await renderMainRouter("directory");
    fireEvent.change(screen.getByRole("textbox", { name: c.query }), {
      target: { value: "directory query" },
    });
    act(() => useWorkspaceStore.getState().setApplyingChanges(true));
    fireEvent.click(screen.getByRole("button", { name: c.openSettings }));
    await waitFor(() => expect(doubles.notify).toHaveBeenCalledOnce());
    expect(f.router.state.location.pathname).toBe("/sessions");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("textbox", { name: c.query })).toHaveValue("directory query");
    expect(
      f.request.mock.calls.some(([path]) => /history\/(configure|clear|rebuild)/.test(path)),
    ).toBe(false);
  });
  it("retains the global search window and query when the real main navigation blocks settings", async () => {
    const f = await renderMainRouter("global-search");
    expect(screen.getByRole("textbox", { name: c.query })).toHaveValue("retained query");
    act(() => useWorkspaceStore.getState().setApplyingChanges(true));
    fireEvent.click(screen.getByRole("button", { name: c.openSettings }));
    await waitFor(() => expect(doubles.notify).toHaveBeenCalledOnce());
    expect(doubles.searchChanged).not.toHaveBeenCalled();
    expect(f.router.state.location.pathname).toBe("/sessions");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("textbox", { name: c.query })).toHaveValue("retained query");
    fireEvent.click(screen.getByRole("button", { name: "Back to results" }));
    expect(screen.getByRole("combobox")).toHaveValue("retained query");
    expect(
      f.request.mock.calls.some(([path]) => /history\/(configure|clear|rebuild)/.test(path)),
    ).toBe(false);
  });
  it("closes global search exactly once after the real main navigation accepts settings", async () => {
    const f = await renderMainRouter("global-search");
    fireEvent.click(screen.getByRole("button", { name: c.openSettings }));
    await screen.findByText("Main settings destination");
    expect(f.router.state.location.pathname).toBe("/settings");
    expect(f.router.state.location.search).toMatchObject({ settingsSection: "privacy" });
    expect(doubles.searchChanged).toHaveBeenCalledExactlyOnceWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps clear manual settings instructions without a main navigation provider", async () => {
    const f = fixture();
    render(
      <HistorySearchPanel client={f.client} locale="en-US" scope={historyAccessScope(f.grant)} />,
    );
    expect(await screen.findByText(c.disabled)).toBeVisible();
    expect(screen.queryByRole("button", { name: c.openSettings })).toBeNull();
    expect(
      f.request.mock.calls.some(([path]) => /history\/(configure|clear|rebuild)/.test(path)),
    ).toBe(false);
  });
});
