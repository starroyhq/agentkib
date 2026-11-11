// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import type { ConversationSessionSummary, RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { SessionHubProvider, useSessionHub } from "./SessionHubContext";
import { SessionHubPage } from "./SessionHubPage";
import { useSessionViewStore } from "./session-view-store";

const mocks = vi.hoisted(() => ({
  controlled: [] as ConversationSessionSummary[],
  refresh: vi.fn(),
  subscribed: vi.fn(),
  unsubscribed: vi.fn(),
  catalogListeners: new Set<() => void>(),
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ tr: String, localizeMessage: String, locale: "en-US" }),
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeWorkspaces: () => ({
    data: [{ id: "workspace", name: "Project", path: "/project" }],
    isPending: false,
  }),
  useHomeInstallations: () => ({ data: [] }),
}));
vi.mock("./new-session/NewSessionComposer", () => ({
  NewSessionComposer: ({ onCreated }: { onCreated: (sessionId: string) => Promise<void> }) => (
    <button onClick={() => void onCreated("created")}>Start session</button>
  ),
}));
vi.mock("./new-session/use-add-workspace", () => ({ useAddWorkspace: () => vi.fn() }));
vi.mock("@/core/conversation-bridge", () => ({
  hasDesktopConversation: () => true,
  createDesktopConversationClient: () => ({}),
}));
vi.mock("./useSessionCatalog", () => ({
  useSessionCatalog: () => ({
    sessions: [],
    ready: true,
    refreshing: false,
    errors: {},
    statuses: [],
  }),
}));
vi.mock("./conversation-catalog", () => ({
  useConversationCatalog: () => {
    const [, setVersion] = useState(0);
    useEffect(() => {
      const changed = () => setVersion((value) => value + 1);
      mocks.catalogListeners.add(changed);
      return () => {
        mocks.catalogListeners.delete(changed);
      };
    }, []);
    return { sessions: mocks.controlled, ready: true };
  },
  refreshConversationCatalog: mocks.refresh,
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({
  useRemoteCatalogEntries: () => ({ hosts: [], sessions: [], workspaces: [], errors: {} }),
}));
vi.mock("./useSessionHistory", () => ({
  useSessionHistory: () => ({}),
}));
vi.mock("./useSessionHistoryScroll", () => ({
  useSessionHistoryScroll: () => ({}),
}));
vi.mock("./SessionOverview", () => ({ SessionOverview: () => <p>Directory overview</p> }));
vi.mock("./SessionHistoryContent", () => ({
  SessionHistoryContent: () => <p>Static history</p>,
}));
vi.mock("./conversation/conversation", () => ({
  EmbeddedConversation: ({
    sessionId,
    onSessionChange,
    onCatalogChange,
  }: {
    sessionId?: string;
    onSessionChange: (id?: string) => void;
    onCatalogChange: () => void;
  }) => {
    const [internalId, setInternalId] = useState(sessionId);
    const previousExternal = useRef(sessionId);
    useEffect(() => {
      if (previousExternal.current === sessionId) return;
      previousExternal.current = sessionId;
      setInternalId(sessionId);
    }, [sessionId]);
    useEffect(() => {
      if (!internalId) return;
      mocks.subscribed(internalId);
      return () => mocks.unsubscribed(internalId);
    }, [internalId]);
    return (
      <>
        <button
          onClick={() => {
            setInternalId("created");
            onSessionChange("created");
          }}
        >
          Complete native creation
        </button>
        <button onClick={onCatalogChange}>Retry catalog</button>
        {internalId && <input aria-label="Draft" defaultValue="" />}
      </>
    );
  },
}));

const session = (id: string): ConversationSessionSummary => ({
  id,
  workspace_id: "workspace",
  agent: "codex",
  title: id,
  availability: "readable",
  archived: false,
  sidechain: false,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockReset();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  mocks.controlled = [session("previous")];
  useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo);
  useSessionViewStore.getState().resetFilters();
  useSessionViewStore.getState().setCreatingConversation(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSessionViewStore.getState().setCreatingConversation(false);
});

describe("desktop creation selection handoff", () => {
  // A fork opens from its source session's conversation; a new session starts in the pane below.
  it.each([
    { creating: false, recovery: "busy" },
    { creating: false, recovery: "missing" },
    { creating: false, recovery: "error" },
  ])(
    "finishes deferred catalog navigation without losing the draft or subscription (creating: $creating, recovery: $recovery)",
    async ({ creating, recovery }) => {
      useSessionViewStore.getState().setCreatingConversation(creating);
      if (recovery === "busy")
        mocks.refresh.mockRejectedValueOnce(new ApiError(409, "operation_busy"));
      else if (recovery === "error")
        mocks.refresh.mockRejectedValueOnce(new Error("catalog unavailable"));
      else mocks.refresh.mockResolvedValueOnce(mocks.controlled);
      const root = createRootRoute({
        component: () => (
          <SessionHubProvider>
            <Outlet />
          </SessionHubProvider>
        ),
      });
      const route = createRoute({
        getParentRoute: () => root,
        path: "/sessions",
        validateSearch: (search: Record<string, unknown>): { sessionId?: string } => ({
          sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
        }),
        component: SessionHubPage,
      });
      const router = createRouter({
        routeTree: root.addChildren([route]),
        history: createMemoryHistory({
          initialEntries: [creating ? "/sessions" : "/sessions?sessionId=previous"],
        }),
      });
      render(<RouterProvider router={router} />);
      fireEvent.click(await screen.findByText("Complete native creation"));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
      const draft = screen.getByRole("textbox", { name: "Draft" });
      fireEvent.change(draft, { target: { value: "Keep the first message" } });
      expect(useSessionViewStore.getState().creatingConversation).toBe(creating);
      expect(router.state.location.search).toEqual({
        sessionId: creating ? undefined : "previous",
      });
      const settleCatalog = () => {
        mocks.controlled = [session("previous"), session("created")];
        for (const changed of mocks.catalogListeners) changed();
        return mocks.controlled;
      };
      if (recovery === "error") {
        await waitFor(() =>
          expect(screen.getByText(/sessions\.conversationCatalogError/)).toHaveTextContent(
            "catalog unavailable",
          ),
        );
        expect(mocks.unsubscribed).not.toHaveBeenCalledWith("created");
        mocks.refresh.mockImplementationOnce(async () => settleCatalog());
        fireEvent.click(screen.getByText("Retry catalog"));
      } else {
        expect(screen.queryByText(/sessions\.conversationCatalogError/)).not.toBeInTheDocument();
        act(() => {
          settleCatalog();
        });
      }
      await waitFor(() => expect(router.state.location.search).toEqual({ sessionId: "created" }));
      expect(useSessionViewStore.getState().creatingConversation).toBe(false);
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
      expect(draft).toHaveValue("Keep the first message");
      expect(mocks.subscribed.mock.calls.filter(([id]) => id === "created")).toHaveLength(1);
      expect(mocks.unsubscribed).not.toHaveBeenCalledWith("created");
      expect(mocks.refresh).toHaveBeenCalledTimes(recovery === "error" ? 2 : 1);
    },
  );

  function renderHub(extra?: ReactNode) {
    const root = createRootRoute({
      component: () => (
        <SessionHubProvider>
          {extra}
          <Outlet />
        </SessionHubProvider>
      ),
    });
    const route = createRoute({
      getParentRoute: () => root,
      path: "/sessions",
      validateSearch: (search: Record<string, unknown>): { sessionId?: string } => ({
        sessionId: typeof search.sessionId === "string" ? search.sessionId : undefined,
      }),
      component: SessionHubPage,
    });
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/sessions"] }),
    });
    render(<RouterProvider router={router} />);
    return router;
  }
  const listCreated = () =>
    act(() => {
      mocks.controlled = [session("previous"), session("created")];
      for (const changed of mocks.catalogListeners) changed();
    });

  it("opens a new session only once the directory lists it, mounting its conversation once", async () => {
    mocks.refresh.mockImplementation(async () => mocks.controlled);
    const router = renderHub();
    fireEvent.click(await screen.findByText("Start session"));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    // The sessions page drops a selection its directory cannot find, so nothing opens yet.
    expect(useSessionViewStore.getState().creatingConversation).toBe(true);
    expect(router.state.location.search).toEqual({});
    expect(screen.getByText("Start session")).toBeVisible();
    listCreated();
    await waitFor(() => expect(router.state.location.search).toEqual({ sessionId: "created" }));
    await waitFor(() => expect(useSessionViewStore.getState().creatingConversation).toBe(false));
    expect(screen.queryByText("Start session")).not.toBeInTheDocument();
    expect(mocks.subscribed).toHaveBeenCalledExactlyOnceWith("created");
    expect(mocks.unsubscribed).not.toHaveBeenCalled();
  });

  it("does not open a new session over a conversation chosen meanwhile", async () => {
    mocks.refresh.mockImplementation(async () => mocks.controlled);
    function ManualSelection() {
      const hub = useSessionHub();
      return <button onClick={() => hub.select("previous")}>Choose existing conversation</button>;
    }
    const router = renderHub(<ManualSelection />);
    fireEvent.click(await screen.findByText("Start session"));
    fireEvent.click(screen.getByText("Choose existing conversation"));
    await waitFor(() => expect(router.state.location.search).toEqual({ sessionId: "previous" }));
    await waitFor(() => expect(useSessionViewStore.getState().creatingConversation).toBe(false));
    listCreated();
    await act(async () => {});
    expect(router.state.location.search).toEqual({ sessionId: "previous" });
    expect(mocks.subscribed).not.toHaveBeenCalledWith("created");
  });
});
