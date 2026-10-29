// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { RemoteConnection } from "@/core/remote-types";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";
import { SessionHubPage } from "./SessionHubPage";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/core/api", () => ({
  api: {
    sessionEvents: vi.fn(),
    sessionSourceCapability: vi.fn(),
    setSessionIndexEnabled: vi.fn(),
  },
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("./DesktopConversationPane", () => ({
  DesktopConversationPane: ({ sessionId, create }: { sessionId?: string; create?: boolean }) => (
    <div data-testid="conversation" data-session-id={sessionId} data-create={String(create)}>
      <input aria-label="Conversation draft" defaultValue="" />
    </div>
  ),
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({ readRemoteHistory: vi.fn() }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: () => <span aria-hidden="true" />,
}));

const workspace: WorkspaceSummary = {
  id: "workspace-a",
  name: "Design kit",
  path: "/projects/design-kit",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const session: ConversationSessionSummary = {
  id: "session-a",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Review theme switching",
  availability: "readable",
  archived: false,
  sidechain: false,
};
const host: RemoteConnection = {
  id: "host-a",
  name: "Studio Mac",
  address: "192.168.1.20:42987",
  status: "offline",
  last_seen: null,
  error: null,
};

function defaultHub(): ReturnType<typeof useSessionHub> {
  return {
    remoteHosts: [],
    remoteErrors: {},
    localEnabled: true,
    workspaces: [workspace],
    sessions: [session],
    filtered: [session],
    selected: session,
    selectedWorkspace: workspace,
    statuses: [],
    errors: {},
    loading: false,
    refreshing: false,
    ready: true,
    historyRevision: 0,
    conversationRefreshRevision: 0,
    runtimeReady: true,
    enabled: true,
    workspacesLoading: false,
    workspacesError: "",
    catalogError: "",
    hiddenSessionNotice: false,
    visibility: { execution: false },
    select: vi.fn(),
    selectionVersion: () => 0,
    refresh: vi.fn().mockResolvedValue(undefined),
    retryWorkspaces: vi.fn(),
  };
}

let hub: ReturnType<typeof useSessionHub>;

function addCatalogNotices() {
  hub = {
    ...hub,
    catalogError: "Conversation catalog unavailable",
    remoteHosts: [host],
    remoteErrors: { [host.id]: "RuntimeRequestError: REMOTE_OFFLINE" },
    workspacesError: "Workspace list unavailable",
    errors: { "workspace-b": "Unrelated scan failed", "workspace-c": "Another scan failed" },
  };
}

function expectCatalogNotices() {
  expect(screen.getByText("Conversation catalog unavailable")).toBeVisible();
  expect(screen.getByText("Studio Mac · Offline")).toBeVisible();
  expect(screen.getByText(tr("remote.error.offline"))).toBeVisible();
  expect(screen.getByText("Workspace list unavailable")).toBeVisible();
  expect(screen.getByText(tr("sessions.partialFailure", { count: 2 }))).toBeVisible();
}

describe("SessionHubPage catalog notices", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionViewStore.getState().resetFilters();
    useSessionViewStore.getState().setCreatingConversation(false);
    Object.defineProperty(window, "desktopConversation", { configurable: true, value: {} });
    hub = defaultHub();
    vi.mocked(useSessionHub).mockImplementation(() => hub);
    vi.mocked(api.sessionEvents).mockResolvedValue({
      events: [
        {
          id: "saved-message",
          kind: "agent-message",
          content: "Cached local history",
          attachment_count: 0,
          truncated: false,
        },
      ],
      warnings: [],
    });
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({ status: "supported" });
    vi.mocked(readRemoteHistory).mockResolvedValue({
      events: [
        {
          id: "remote-message",
          kind: "agent-message",
          content: "Cached remote history",
          attachment_count: 0,
          truncated: false,
        },
      ],
      warnings: [],
    });
  });
  afterEach(() => {
    cleanup();
    delete window.desktopConversation;
  });

  it.each(["codex", "claude-code", "antigravity"] as const)(
    "keeps every catalog notice above a local interactive %s session",
    (agent) => {
      addCatalogNotices();
      hub.selected = { ...session, agent };
      render(<SessionHubPage />);

      expectCatalogNotices();
      expect(screen.getAllByRole("alert")).toHaveLength(4);
      expect(screen.getByRole("region", { name: tr("sessions.directory") })).toHaveAttribute(
        "tabindex",
        "0",
      );
      expect(screen.getByTestId("conversation")).toHaveAttribute("data-session-id", session.id);
      expect(api.sessionEvents).not.toHaveBeenCalled();
      // A directory-wide scan failure must not be attributed to this session's content.
      expect(screen.queryByText("Unrelated scan failed")).not.toBeInTheDocument();
      expect(screen.queryByText(/Unable to read this session/)).not.toBeInTheDocument();
    },
  );

  it("keeps catalog failures visible during creation without reusing a rejected-record notice", () => {
    addCatalogNotices();
    hub = { ...hub, selected: undefined, hiddenSessionNotice: true };
    useSessionViewStore.getState().setCreatingConversation(true);
    render(<SessionHubPage />);

    expectCatalogNotices();
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-create", "true");
    expect(screen.queryByText(tr("sessions.hiddenRecord"))).not.toBeInTheDocument();
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("retains the rejected-record explanation when returning to the directory", () => {
    hub = { ...hub, selected: undefined, hiddenSessionNotice: true };
    render(<SessionHubPage />);

    expect(screen.getByText(tr("sessions.hiddenRecord"))).toBeVisible();
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  });

  it("uses the existing catalog retry action and disables it during refresh", () => {
    hub.catalogError = "Catalog not refreshed";
    const { rerender } = render(<SessionHubPage />);
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.retry") }));
    expect(hub.refresh).toHaveBeenCalledOnce();

    hub = { ...hub, refreshing: true };
    rerender(<SessionHubPage />);
    const retry = screen.getByRole("button", { name: tr("sessions.retry") });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(hub.refresh).toHaveBeenCalledOnce();
  });

  it("keeps the workspace retry separate from the catalog retry while cached sessions remain", () => {
    hub = { ...hub, catalogError: "Catalog not refreshed", workspacesError: "List not refreshed" };
    render(<SessionHubPage />);

    const catalog = screen.getByText("Catalog not refreshed").closest('[role="alert"]')!;
    const workspaces = screen.getByText("List not refreshed").closest('[role="alert"]')!;
    fireEvent.click(within(catalog as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(hub.refresh).toHaveBeenCalledOnce();
    expect(hub.retryWorkspaces).not.toHaveBeenCalled();
    fireEvent.click(within(workspaces as HTMLElement).getByRole("button", { name: "Retry" }));
    expect(hub.retryWorkspaces).toHaveBeenCalledOnce();
    expect(screen.getByTestId("conversation")).toBeVisible();
  });

  it.each(["offline", "disconnected"] as const)(
    "shows a named %s host without turning its status into a session error",
    (status) => {
      hub.remoteHosts = [{ ...host, status }];
      render(<SessionHubPage />);

      expect(screen.getByRole("status")).toHaveTextContent(
        `${host.name} · ${tr(`remote.state.${status}`)}`,
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByTestId("conversation")).toBeVisible();
    },
  );

  it("shows a connected host's catalog error with localized summary and opt-in diagnostics", () => {
    hub.remoteHosts = [{ ...host, status: "online" }];
    hub.remoteErrors = { [host.id]: "RuntimeRequestError: REMOTE_REQUEST_FAILED" };
    render(<SessionHubPage />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(`${host.name} · ${tr("remote.state.online")}`);
    expect(alert).toHaveTextContent(tr("remote.error.request"));
    expect(alert).not.toHaveTextContent("RuntimeRequestError");
    fireEvent.click(screen.getByRole("button", { name: tr("errors.details") }));
    expect(alert).toHaveTextContent("RuntimeRequestError: REMOTE_REQUEST_FAILED");
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("ignores errors from removed hosts and does not warn for connected healthy hosts", () => {
    hub.remoteHosts = [{ ...host, status: "online" }];
    hub.remoteErrors = { removed: "REMOTE_OFFLINE" };
    render(<SessionHubPage />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(host.name, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("removes recovered notices without remounting the active conversation or losing its draft", () => {
    addCatalogNotices();
    const { rerender } = render(<SessionHubPage />);
    const pane = screen.getByTestId("conversation");
    const draft = screen.getByRole("textbox", { name: "Conversation draft" });
    fireEvent.change(draft, { target: { value: "Keep typing through catalog refresh" } });

    hub = {
      ...hub,
      catalogError: "",
      workspacesError: "",
      errors: {},
      remoteHosts: [{ ...host, status: "online" }],
      remoteErrors: {},
    };
    rerender(<SessionHubPage />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation")).toBe(pane);
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep typing through catalog refresh");
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("keeps global notices when switching local sessions and updates host errors independently", () => {
    addCatalogNotices();
    const { rerender } = render(<SessionHubPage />);
    hub = { ...hub, selected: { ...session, id: "session-b", agent: "claude-code" } };
    rerender(<SessionHubPage />);

    expectCatalogNotices();
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-session-id", "session-b");
    hub = {
      ...hub,
      remoteHosts: [{ ...host, id: "host-b", name: "Office Mac", status: "disconnected" }],
    };
    rerender(<SessionHubPage />);
    expect(screen.getByText("Office Mac · Disconnected")).toBeVisible();
    expect(screen.queryByText("Studio Mac · Offline")).not.toBeInTheDocument();
    expect(screen.queryByText(tr("remote.error.offline"))).not.toBeInTheDocument();
    expect(screen.getByText(tr("sessions.partialFailure", { count: 2 }))).toBeVisible();
  });

  it("keeps one copy of each notice across overview, embedded, and history branches", async () => {
    addCatalogNotices();
    hub.selected = undefined;
    const { rerender } = render(<SessionHubPage />);
    expectCatalogNotices();

    hub = { ...hub, selected: session };
    rerender(<SessionHubPage />);
    expectCatalogNotices();
    expect(screen.getAllByRole("alert")).toHaveLength(4);

    hub = { ...hub, selected: { ...session, agent: "open-claw" } };
    rerender(<SessionHubPage />);
    expect(await screen.findByText("Cached local history")).toBeVisible();
    expectCatalogNotices();
    expect(screen.getAllByRole("alert")).toHaveLength(4);
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
    expect(api.sessionEvents).toHaveBeenCalledExactlyOnceWith(session.id);
  });

  it("keeps offline remote cached history readable with catalog failures and no live controls", async () => {
    addCatalogNotices();
    const remote = {
      host_id: host.id,
      host_name: host.name,
      original_id: session.id,
      online: false,
      last_synced_at: "2026-10-16T01:00:00Z",
    };
    const selected = { ...session, id: "remote-session", remote };
    hub = {
      ...hub,
      localEnabled: false,
      selected,
      selectedWorkspace: { ...workspace, remote },
    };
    render(<SessionHubPage />);

    expect(await screen.findByText("Cached remote history")).toBeVisible();
    expectCatalogNotices();
    expect(readRemoteHistory).toHaveBeenCalledExactlyOnceWith(selected);
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
    expect(screen.getByText(tr("sessions.historyReadonly"))).toBeVisible();
  });

  it.each(["runtimeReady", "enabled", "workspacesLoading"] as const)(
    "keeps the existing %s gate before exposing catalog notices or live content",
    (gate) => {
      addCatalogNotices();
      hub = { ...hub, [gate]: gate === "workspacesLoading" };
      render(<SessionHubPage />);

      expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
      expect(screen.queryByText("Conversation catalog unavailable")).not.toBeInTheDocument();
      expect(screen.queryByText("Studio Mac · Offline")).not.toBeInTheDocument();
      expect(api.sessionEvents).not.toHaveBeenCalled();
    },
  );

  it("keeps an uncached workspace-list failure blocking with its existing retry", () => {
    addCatalogNotices();
    hub.workspaces = [];
    render(<SessionHubPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("Workspace list unavailable");
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.retry") }));
    expect(hub.retryWorkspaces).toHaveBeenCalledOnce();
    expect(hub.refresh).not.toHaveBeenCalled();
  });
});
