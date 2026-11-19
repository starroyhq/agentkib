// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConversationSubscription, SessionStreamEvent } from "@agentkib/conversation-state";
import type { Access, ConversationReadState, Live } from "@agentkib/web-client";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { conversationWords, initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import { homeKeys } from "@/features/home/home-query";
import { Route as mainRoute } from "@/routes/(main)/route";
import { Route as sessionsRoute } from "@/routes/(main)/sessions";
import { Route as rootRoute } from "@/routes/__root";
import { useAppStore } from "@/stores/app-store";
import { useSessionViewStore } from "./session-view-store";

vi.mock("@/features/app/AppRuntimeBridge", () => ({ AppRuntimeBridge: () => null }));
vi.mock("@/components/WindowToolbar", () => ({ WindowToolbar: () => null }));

const workspace = {
  id: "window-project",
  name: "Window test project",
  path: "/synthetic/project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
} satisfies WorkspaceSummary;
const readState: ConversationReadState = {
  source: "codex-native",
  status: "read",
  freshness: "current",
  version: "native:read",
  firstUnread: null,
  latestResult: null,
};
const session = {
  id: "window-session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Retained desktop conversation",
  availability: "readable",
  archived: false,
  sidechain: false,
  readState,
} satisfies ConversationSessionSummary;
const live: Live = {
  sessionId: session.id,
  status: "idle",
  revision: 1,
  sendEnabled: true,
  approvals: [],
  executionMode: "codex-managed",
};
const running: Live = {
  ...live,
  status: "running",
  turnId: "turn",
  sendEnabled: false,
  stopEnabled: true,
  executionLocation: "agentkib",
};
const access: Access = {
  protocolVersion: 2,
  readStateVersion: 1,
  status: "approved",
  csrfToken: "local",
  bootId: "boot",
  experimentalEnabled: true,
  device: {
    id: "test-desktop",
    name: "Test desktop",
    accessMode: "full",
    send: true,
    approve: true,
    advancedControl: true,
    manage: true,
  },
};
const transcriptEvent = (id: string, content: string) => ({
  id,
  kind: "agent-message" as const,
  content,
  attachment_count: 0,
  truncated: false,
});

function createHost({
  state = live,
  catalogSession = session,
}: {
  state?: Live;
  catalogSession?: ConversationSessionSummary;
} = {}) {
  const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
  const unavailableListeners = new Set<() => void>();
  let subscriptions = 0;
  let blockedAccess: Promise<Access> | undefined;
  const envelope = (seq: number) => ({
    protocolVersion: 2 as const,
    sessionId: session.id,
    subscriptionId: `session-${subscriptions}`,
    runtimeBootId: "runtime",
    epoch: "window-epoch",
    seq,
    cursor: `window-cursor-${seq}`,
  });
  const request = vi.fn(
    async (path: string, _body?: unknown): Promise<DesktopConversationResponse> => {
      switch (path.split("?")[0]) {
        case "access":
          return { status: 200, body: blockedAccess ? await blockedAccess : access };
        case "catalog":
          return {
            status: 200,
            body: { workspaces: [workspace], sessions: [catalogSession], indexEnabled: true },
          };
        case "events":
          return {
            status: 200,
            body: { events: [transcriptEvent("history", "Existing window history")], warnings: [] },
          };
        case "live":
          return { status: 200, body: state };
        case "read-state":
          return { status: 200, body: { readState } };
        default:
          return { status: 404, body: { code: "not-found" } };
      }
    },
  );
  const subscribe = vi.fn(async (id: string): Promise<ConversationSubscription<Live>> => {
    if (id !== session.id) return { subscriptionId: "catalog", events: [] };
    subscriptions++;
    const snapshot = { ...envelope(0), type: "snapshot" as const, payload: { live: state } };
    return { subscriptionId: snapshot.subscriptionId, events: [snapshot], cursor: snapshot.cursor };
  });
  const unsubscribe = vi.fn(async (_id: string) => {});
  const bridge: DesktopConversationBridge = {
    request,
    upload: vi.fn(async () => ({ status: 400, body: {} })),
    subscribe,
    acknowledge: vi.fn(async () => {}),
    unsubscribe,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onUnavailable: (listener) => {
      unavailableListeners.add(listener);
      return () => {
        unavailableListeners.delete(listener);
      };
    },
    onControlChanged: () => () => {},
  };
  return {
    bridge,
    request,
    subscribe,
    unsubscribe,
    envelope,
    holdAccess() {
      let release!: (result: Access) => void;
      blockedAccess = new Promise((resolve) => {
        release = resolve;
      });
      return (result = access) => release(result);
    },
    emit: (event: SessionStreamEvent<Live>) => {
      for (const listener of listeners) listener(event);
    },
    disconnect() {
      for (const listener of unavailableListeners) listener();
    },
  };
}

function renderDesktop() {
  const root = createRootRoute({
    component: rootRoute.options.component,
    validateSearch: rootRoute.options.validateSearch,
  });
  const main = createRoute({
    getParentRoute: () => root,
    id: "main",
    component: mainRoute.options.component,
  });
  const home = createRoute({
    getParentRoute: () => main,
    path: "/",
    staticData: { appRoute: { kind: "global", page: "home" } },
    component: () => <h1>Home content</h1>,
  });
  const sessions = createRoute({
    getParentRoute: () => main,
    path: "/sessions",
    component: sessionsRoute.options.component,
    staticData: sessionsRoute.options.staticData,
  });
  const routeTree = root.addChildren([main.addChildren([home, sessions])]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/sessions?sessionId=${session.id}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(homeKeys.workspaces(), [workspace]);
  client.setQueryData(homeKeys.continuations(workspace.id), [session]);
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <AppDialogProvider>
          <RouterProvider router={router} />
        </AppDialogProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return router;
}

function setIndexEnabled(enabled: boolean) {
  useAppStore.getState().setRuntime({ session_index_enabled: enabled } as RuntimeInfo);
}

beforeEach(async () => {
  await initializeI18n("en-US");
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(api, "workspaces").mockResolvedValue([workspace]);
  vi.spyOn(api, "workspaceSessions").mockResolvedValue([session]);
  vi.spyOn(api, "workspaceSessionStatus").mockResolvedValue([]);
  vi.spyOn(api, "refreshWorkspaceSessions").mockResolvedValue([session]);
  vi.spyOn(api, "globalMemories").mockResolvedValue([]);
  vi.spyOn(api, "refreshStatus").mockResolvedValue([]);
  vi.spyOn(api, "agentInstallations").mockResolvedValue([]);
  setIndexEnabled(true);
  useSessionViewStore.getState().resetFilters();
});

afterEach(() => {
  cleanup();
  delete window.desktopConversation;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openDesktopConversation(options?: Parameters<typeof createHost>[0]) {
  const host = createHost(options);
  window.desktopConversation = host.bridge;
  const router = renderDesktop();
  expect(await screen.findByText("Existing window history")).toBeVisible();
  await waitFor(() => expect(host.subscribe).toHaveBeenCalledWith(session.id, undefined));
  return { host, router };
}

function directorySpinner() {
  return screen
    .getByRole("button", { name: /^Retained desktop conversation/ })
    .closest(".session-directory-row")
    ?.querySelector(".session-directory-indicator .animate-spin");
}

function runningHint() {
  return document.querySelector("[data-session-turn-status='running']");
}

it("restores a running conversation and its editable draft while verifying access", async () => {
  const { host, router } = await openDesktopConversation({ state: running });
  const labels = conversationWords("en-US");
  act(() =>
    host.emit({
      ...host.envelope(1),
      type: "item-upsert",
      payload: { ...transcriptEvent("live-item", "Live reply"), turn_id: "turn" },
    }),
  );
  expect(await screen.findByText("Live reply")).toBeVisible();
  expect(screen.getByRole("button", { name: labels.stop })).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox", { name: labels.message }), {
    target: { value: "Draft from before Home" },
  });
  const subscription = host.envelope(0).subscriptionId;
  host.request.mockClear();
  host.subscribe.mockClear();
  host.unsubscribe.mockClear();

  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("nav.home") }));
  });
  expect(screen.getByRole("heading", { name: "Home content" })).toBeVisible();
  await act(async () => vi.advanceTimersByTimeAsync(10 * 60_000 - 1));
  expect(host.unsubscribe).not.toHaveBeenCalledWith(subscription);
  act(() =>
    host.emit({
      ...host.envelope(2),
      type: "text-delta",
      payload: {
        itemId: "live-item",
        turnId: "turn",
        offset: "Live reply".length,
        text: " updated while on Home",
      },
    }),
  );

  const requestsBeforeReturn = host.request.mock.calls.length;
  const releaseAccess = host.holdAccess();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.nav") }));
  });
  expect(host.request.mock.calls.slice(requestsBeforeReturn)).toContainEqual(["access", undefined]);
  expect(screen.getByText("Existing window history")).toBeVisible();
  expect(screen.getByText(/^Live reply/)).toBeVisible();
  expect(screen.queryByText(tr("conversation.loading"))).not.toBeInTheDocument();
  expect(screen.queryByText(tr("sessions.loading"))).not.toBeInTheDocument();
  expect(directorySpinner()).toBeVisible();
  expect(runningHint()).toBeVisible();
  const editor = screen.getByRole("textbox", { name: labels.message });
  expect(editor).toHaveValue("Draft from before Home");
  expect(editor).toBeEnabled();
  const stop = screen.getByRole("button", { name: labels.stop });
  expect(stop).toBeDisabled();
  fireEvent.click(stop);
  fireEvent.change(editor, { target: { value: "Edited during access verification" } });
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.submit(editor.closest("form")!);
  expect(editor).toHaveValue("Edited during access verification");

  await act(async () => releaseAccess());
  expect(screen.getByText("Live reply updated while on Home")).toBeVisible();
  expect(screen.getByText("Existing window history")).toBeVisible();
  expect(directorySpinner()).toBeVisible();
  expect(runningHint()).toBeVisible();
  expect(screen.getByRole("textbox", { name: labels.message })).toHaveValue(
    "Edited during access verification",
  );
  expect(screen.getByRole("button", { name: labels.stop })).toBeEnabled();
  expect(router.state.location.search).toMatchObject({ sessionId: session.id });
  const requestsBeforeProbe = host.request.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(100));
  const operations = host.request.mock.calls.map(([path]) => path.split("?")[0]);
  expect(operations.slice(requestsBeforeProbe)).toContain("read-state");
  expect(operations).not.toContain("events");
  expect(operations).not.toContain("live");
  expect(host.request.mock.calls.filter(([, body]) => body !== undefined)).toHaveLength(0);
  expect(host.subscribe.mock.calls.map(([id]) => id)).not.toContain(session.id);
});

it("removes both running indicators when the turn ends while on Home", async () => {
  const { host } = await openDesktopConversation({
    state: running,
    // Keep the catalog's running summary stale until a subsequent refresh can update it.
    catalogSession: {
      ...session,
      continuation: { status: "running", executionLocation: "agentkib" },
    },
  });
  const labels = conversationWords("en-US");
  await waitFor(() => expect(runningHint()).toBeVisible());
  expect(directorySpinner()).toBeVisible();
  await waitFor(() =>
    expect(host.request).toHaveBeenCalledWith(`read-state?sessionId=${session.id}`, undefined),
  );
  host.request.mockClear();
  host.subscribe.mockClear();
  const subscription = host.envelope(0).subscriptionId;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("nav.home") }));
  });
  expect(screen.getByRole("heading", { name: "Home content" })).toBeVisible();
  expect(host.unsubscribe).not.toHaveBeenCalledWith(subscription);
  act(() =>
    host.emit({
      ...host.envelope(1),
      type: "state",
      payload: { status: "idle", revision: 2, sendEnabled: true, stopEnabled: false },
    }),
  );

  const releaseAccess = host.holdAccess();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.nav") }));
  });
  expect(host.request).toHaveBeenCalledWith("access", undefined);
  expect(screen.getByText("Existing window history")).toBeVisible();
  expect(directorySpinner()).toBeNull();
  expect(runningHint()).toBeNull();
  const editor = screen.getByRole("textbox", { name: labels.message });
  const send = screen.getByRole("button", { name: labels.send });
  expect(editor).toBeEnabled();
  expect(send).toBeDisabled();
  fireEvent.change(editor, { target: { value: "Draft after the turn ended" } });
  fireEvent.click(send);
  fireEvent.keyDown(editor, { key: "Enter" });
  fireEvent.submit(editor.closest("form")!);

  await act(async () => releaseAccess());
  expect(screen.getByText("Existing window history")).toBeVisible();
  expect(screen.getByRole("textbox", { name: labels.message })).toHaveValue(
    "Draft after the turn ended",
  );
  expect(screen.getByRole("button", { name: labels.send })).toBeEnabled();
  expect(directorySpinner()).toBeNull();
  expect(runningHint()).toBeNull();
  const operations = host.request.mock.calls.map(([path]) => path.split("?")[0]);
  expect(operations).not.toContain("events");
  expect(operations).not.toContain("live");
  expect(host.request.mock.calls.filter(([, body]) => body !== undefined)).toHaveLength(0);
  expect(host.subscribe.mock.calls.map(([id]) => id)).not.toContain(session.id);
});

it("removes retained history when the return access check reports that access ended", async () => {
  const { host } = await openDesktopConversation();
  await waitFor(() =>
    expect(host.request).toHaveBeenCalledWith(`read-state?sessionId=${session.id}`, undefined),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("nav.home") }));
  });
  const releaseAccess = host.holdAccess();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.nav") }));
  });
  expect(screen.getByText("Existing window history")).toBeVisible();

  await act(async () =>
    releaseAccess({ ...access, status: "ended", csrfToken: "", device: undefined }),
  );
  expect(screen.queryByText("Existing window history")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
});

it("removes the preview if the parked stream disconnects before access is verified", async () => {
  const { host } = await openDesktopConversation();
  await waitFor(() =>
    expect(host.request).toHaveBeenCalledWith(`read-state?sessionId=${session.id}`, undefined),
  );
  const subscription = host.envelope(0).subscriptionId;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("nav.home") }));
  });
  const releaseAccess = host.holdAccess();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.nav") }));
  });
  expect(screen.getByText("Existing window history")).toBeVisible();

  act(() => host.disconnect());
  expect(screen.queryByText("Existing window history")).not.toBeInTheDocument();
  await act(async () => releaseAccess());
  expect(await screen.findByText("Existing window history")).toBeVisible();
  expect(host.envelope(0).subscriptionId).not.toBe(subscription);
});

it("opens a fresh subscription when the index is re-enabled during a conversation", async () => {
  const { host } = await openDesktopConversation();
  await waitFor(() =>
    expect(host.request).toHaveBeenCalledWith(`read-state?sessionId=${session.id}`, undefined),
  );
  const subscription = host.envelope(0).subscriptionId;
  await act(async () => setIndexEnabled(false));
  expect(screen.getByText(tr("conversations.indexDisabled"))).toBeVisible();
  expect(host.unsubscribe).toHaveBeenCalledWith(subscription);
  host.request.mockClear();
  host.subscribe.mockClear();

  await act(async () => setIndexEnabled(true));
  expect(await screen.findByText("Existing window history")).toBeVisible();
  await waitFor(() => expect(host.subscribe).toHaveBeenCalledWith(session.id, undefined));
  expect(host.envelope(0).subscriptionId).not.toBe(subscription);
  const operations = host.request.mock.calls.map(([path]) => path.split("?")[0]);
  expect(operations).toContain("events");
  expect(operations).toContain("live");
});
