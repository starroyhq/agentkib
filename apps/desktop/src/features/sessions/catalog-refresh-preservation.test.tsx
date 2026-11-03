// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { api } from "@/core/api";
import { homeKeys } from "@/features/home/home-query";
import { useAppStore } from "@/stores/app-store";
import { useSessionViewStore } from "./session-view-store";
import { SessionHubProvider, useSessionHub } from "./SessionHubContext";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  mounted: vi.fn(),
  unmounted: vi.fn(),
  search: { sessionId: "cached-session" } as { sessionId?: string },
  frames: [] as Array<{ ids: string[]; selected?: string; ready: boolean; loading: boolean }>,
}));
vi.mock("@/core/useI18n", () => ({
  useI18n: () => ({ tr: String, localizeMessage: String, locale: "zh-CN" }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => doubles.navigate,
  useSearch: () => doubles.search,
}));
vi.mock("@/core/api", () => ({
  api: {
    workspaces: vi.fn(),
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
  },
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({
  useRemoteCatalogEntries: () => ({ hosts: [], sessions: [], workspaces: [], errors: {} }),
  refreshRemoteCatalog: vi.fn(),
}));

const workspace = {
  id: "workspace",
  name: "Synthetic project",
  path: "/synthetic/project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
} satisfies WorkspaceSummary;
const cached = {
  id: "cached-session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Synthetic selected conversation",
  availability: "readable",
  archived: false,
  sidechain: false,
} satisfies ConversationSessionSummary;
const clients: QueryClient[] = [];
const pendingScans: Array<() => void> = [];

function holdScan() {
  let resolve!: (sessions: ConversationSessionSummary[]) => void;
  const promise = new Promise<ConversationSessionSummary[]>((done) => {
    resolve = done;
  });
  pendingScans.push(() => resolve([cached]));
  return { promise, resolve };
}
function CurrentConversation({ id }: { id: string }) {
  useEffect(() => {
    doubles.mounted(id);
    return () => doubles.unmounted(id);
  }, [id]);
  return <div data-testid="current-conversation">{id}</div>;
}
function Consumer() {
  const hub = useSessionHub();
  doubles.frames.push({
    ids: hub.sessions.map((session) => session.id),
    selected: hub.selected?.id,
    ready: hub.ready,
    loading: hub.loading,
  });
  return (
    <>
      <output data-testid="ready">{String(hub.ready)}</output>
      <output data-testid="usable">{String(hub.usable)}</output>
      <output data-testid="loading">{String(hub.loading)}</output>
      <output data-testid="refreshing">{String(hub.refreshing)}</output>
      {hub.catalogError && <p role="alert">{hub.catalogError}</p>}
      <button onClick={() => void hub.refresh()}>Refresh directory</button>
      {hub.sessions.map((session) => (
        <div data-testid="directory-row" key={session.id}>
          {session.title}
        </div>
      ))}
      {hub.selected && <CurrentConversation key={hub.selected.id} id={hub.selected.id} />}
    </>
  );
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(homeKeys.workspaces(), [workspace]);
  client.setQueryData(homeKeys.continuations(workspace.id), [cached]);
  const request = vi.fn(async (): Promise<DesktopConversationResponse> => ({
    status: 200,
    body: { workspaces: [workspace], sessions: [cached], indexEnabled: true },
  }));
  const bridge: DesktopConversationBridge = {
    request,
    upload: vi.fn(async () => ({ status: 400, body: {} })),
    subscribe: vi.fn(async () => ({ subscriptionId: "catalog-refresh", events: [] })),
    unsubscribe: vi.fn(async () => {}),
    acknowledge: vi.fn(async () => {}),
    onEvent: () => () => {},
    onUnavailable: () => () => {},
    onControlChanged: () => () => {},
  };
  window.desktopConversation = bridge;
  const content = (active = true) => (
    <QueryClientProvider client={client}>
      <SessionHubProvider active={active}>
        <Consumer />
      </SessionHubProvider>
    </QueryClientProvider>
  );
  const view = render(content());
  return { ...view, client, request, content };
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.frames = [];
  doubles.search = { sessionId: cached.id };
  vi.mocked(api.workspaces).mockResolvedValue([workspace]);
  vi.mocked(api.workspaceSessions).mockResolvedValue([cached]);
  vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
  vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cached]);
  useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo);
  useSessionViewStore.getState().resetFilters();
  useSessionViewStore.getState().setCreatingConversation(false);
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const resolve of pendingScans.splice(0)) resolve();
  });
  for (const client of clients.splice(0)) client.clear();
  delete window.desktopConversation;
});

describe("real desktop catalog and selection refresh composition", () => {
  it("shows the selected stored directory while its initial background scan is still running", async () => {
    const scan = holdScan();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValue(scan.promise);
    setup();
    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalled());
    expect(screen.getByTestId("directory-row")).toHaveTextContent(cached.title);
    expect(screen.getByTestId("current-conversation")).toHaveTextContent(cached.id);
    expect(screen.getByTestId("refreshing")).toHaveTextContent("true");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(screen.getByTestId("usable")).toHaveTextContent("true");
    // Cache usability is independent of this generation's completed scan/read.
    expect(screen.getByTestId("ready")).toHaveTextContent("false");
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("keeps the same current conversation mounted throughout a manual scan and catalog read", async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    await screen.findByTestId("current-conversation");
    const node = screen.getByTestId("current-conversation");
    const scan = holdScan();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(scan.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("true"));
    expect(screen.getByTestId("current-conversation")).toBe(node);
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    await act(async () => scan.resolve([cached]));
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    expect(screen.getByTestId("current-conversation")).toBe(node);
    expect(doubles.mounted).toHaveBeenCalledOnce();
    expect(doubles.unmounted).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("retains the current directory and selection after transient scan and catalog failures", async () => {
    const { request } = setup();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    const node = await screen.findByTestId("current-conversation");
    vi.mocked(api.refreshWorkspaceSessions).mockRejectedValueOnce(
      new Error("temporary source failure"),
    );
    request.mockRejectedValueOnce(new Error("temporary catalog failure"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await screen.findByRole("alert");
    expect(screen.getByTestId("directory-row")).toHaveTextContent(cached.title);
    expect(screen.getByTestId("current-conversation")).toBe(node);
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("preserves an incomplete source's current conversation, then accepts a complete deletion", async () => {
    const { request } = setup();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    const node = await screen.findByTestId("current-conversation");
    request.mockResolvedValue({
      status: 200,
      body: {
        workspaces: [workspace],
        sessions: [],
        indexEnabled: true,
        complete: false,
        incompleteSources: [{ workspaceId: workspace.id, agent: cached.agent }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    expect(screen.getByTestId("current-conversation")).toBe(node);
    expect(screen.getByTestId("directory-row")).toHaveTextContent(cached.title);
    expect(doubles.navigate).not.toHaveBeenCalled();

    request.mockResolvedValue({
      status: 200,
      body: { workspaces: [workspace], sessions: [], indexEnabled: true, complete: true },
    });
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await waitFor(() => expect(screen.queryByTestId("directory-row")).toBeNull());
    expect(screen.queryByTestId("current-conversation")).toBeNull();
    await waitFor(() => expect(doubles.navigate).toHaveBeenCalled());
  });

  it("uses the retained catalog immediately when returning before the next scan finishes", async () => {
    const view = setup();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    await screen.findByTestId("current-conversation");
    view.rerender(view.content(false));
    const scan = holdScan();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(scan.promise);
    doubles.frames = [];
    view.rerender(view.content(true));
    expect(doubles.frames[0]?.ids).toContain(cached.id);
    expect(doubles.frames[0]?.loading).toBe(false);
    expect(screen.getByTestId("usable")).toHaveTextContent("true");
    expect(screen.getByTestId("current-conversation")).toHaveTextContent(cached.id);
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("true"));
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("clears disabled-index rows and does not restore a late scan or expose them on re-enable", async () => {
    const { request } = setup();
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("false"));
    await screen.findByTestId("current-conversation");
    const scan = holdScan();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(scan.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh directory" }));
    await waitFor(() => expect(screen.getByTestId("refreshing")).toHaveTextContent("true"));
    act(() => useAppStore.getState().setRuntime({ session_index_enabled: false } as RuntimeInfo));
    expect(screen.queryByTestId("directory-row")).toBeNull();
    expect(screen.queryByTestId("current-conversation")).toBeNull();
    await act(async () => scan.resolve([cached]));
    expect(screen.queryByTestId("directory-row")).toBeNull();
    request.mockResolvedValue({
      status: 200,
      body: { workspaces: [workspace], sessions: [], indexEnabled: true },
    });
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    doubles.frames = [];
    act(() => useAppStore.getState().setRuntime({ session_index_enabled: true } as RuntimeInfo));
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(doubles.frames.every((frame) => !frame.ids.includes(cached.id))).toBe(true);
    expect(screen.queryByTestId("directory-row")).toBeNull();
  });
});
