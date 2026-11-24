// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@agentkib/web-client";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { RemoteConnection } from "@/core/remote-types";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";
import { SessionHubPage } from "./SessionHubPage";
import { useSessionHub } from "./SessionHubContext";
import { SessionDirectoryNotices } from "./SessionSourceNotices";
import { catalogReadError, isCatalogReadTimeout } from "./catalog-read-error";
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
vi.mock("@/features/home/home-query", async (original) => ({
  ...(await original<typeof import("@/features/home/home-query")>()),
  useHomeInstallations: () => ({ data: [] }),
}));
vi.mock("./new-session/NewSessionPane", () => ({
  NewSessionPane: () => <div data-testid="new-session">New session composer</div>,
}));
vi.mock("./DesktopConversationPane", () => ({
  DesktopConversationPane: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="conversation" data-session-id={sessionId}>
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
    usable: true,
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

function sessionSurface() {
  return (
    <>
      <aside aria-label={tr("sessions.directory")}>
        <SessionDirectoryNotices />
      </aside>
      <main>
        <SessionHubPage />
      </main>
    </>
  );
}

function directory() {
  return within(screen.getByRole("complementary"));
}

function expandDetails() {
  const details = directory().getByRole("button", { name: tr("common.details") });
  if (details.getAttribute("aria-expanded") === "false") fireEvent.click(details);
}

function expectCatalogNotices() {
  expect(directory().getByText(tr("sessions.partialFailure", { count: 2 }))).toBeVisible();
  expandDetails();
  expect(directory().getByText("Conversation catalog unavailable")).toBeVisible();
  expect(directory().getByText("Studio Mac · Offline")).toBeVisible();
  expect(directory().getByText(tr("remote.error.offline"))).toBeVisible();
  expect(directory().getByText("Workspace list unavailable")).toBeVisible();
  expect(within(screen.getByRole("main")).queryByRole("alert")).toBeNull();
}

describe("session directory notices", () => {
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

  it("keeps directory-level failures out of the active conversation pane", () => {
    addCatalogNotices();
    render(<SessionHubPage />);

    expect(screen.getByTestId("conversation")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(tr("sessions.partialFailure", { count: 2 }))).toBeNull();
    expect(screen.queryByText("Conversation catalog unavailable")).toBeNull();
  });

  it("localizes read failures by code and only retries verified timeout responses", () => {
    expect(catalogReadError(new ApiError(504, "catalog_read_timeout"), tr)).toBe(
      tr("sessions.catalogReadTimeout"),
    );
    const legacy = new ApiError(504, "outcome_unknown");
    expect(catalogReadError(legacy, tr)).toBe(tr("sessions.catalogReadTimeout"));
    expect(isCatalogReadTimeout(legacy)).toBe(true);
    const wrapped = new Error("RuntimeRequestError: Error: outcome_unknown");
    expect(catalogReadError(wrapped, tr)).toBe(tr("sessions.catalogReadTimeout"));
    expect(isCatalogReadTimeout(wrapped)).toBe(false);
    expect(catalogReadError(new Error("RuntimeRequestError: stale_boot"), tr)).toBe(
      tr("sessions.catalogReadChanged"),
    );
    expect(catalogReadError(new ApiError(403, "permission_denied"), tr)).toBe(
      tr("sessions.catalogReadDenied"),
    );
    expect(catalogReadError(new Error("private diagnostic path"), tr)).toBe(
      tr("sessions.catalogReadUnavailable"),
    );
  });

  it.each(["codex", "claude-code", "antigravity"] as const)(
    "keeps the combined notice beside a local interactive %s session",
    (agent) => {
      addCatalogNotices();
      hub.selected = { ...session, agent };
      render(sessionSurface());

      expectCatalogNotices();
      expect(directory().getAllByRole("button", { name: tr("common.details") })).toHaveLength(1);
      expect(directory().getAllByRole("button", { name: tr("sessions.retry") })).toHaveLength(1);
      expect(screen.getByTestId("conversation")).toHaveAttribute("data-session-id", session.id);
      expect(api.sessionEvents).not.toHaveBeenCalled();
      // A directory-wide scan failure must not be attributed to this session's content.
      expect(within(screen.getByRole("main")).queryByText("Unrelated scan failed")).toBeNull();
      expect(screen.queryByText(/Unable to read this session/)).not.toBeInTheDocument();
    },
  );

  it("keeps catalog failures visible during creation without reusing a rejected-record notice", () => {
    addCatalogNotices();
    hub = { ...hub, selected: undefined, hiddenSessionNotice: true };
    useSessionViewStore.getState().setCreatingConversation(true);
    render(sessionSurface());

    expectCatalogNotices();
    expect(screen.getByTestId("new-session")).toBeVisible();
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
    const { rerender } = render(sessionSurface());
    fireEvent.click(directory().getByRole("button", { name: tr("sessions.retry") }));
    expect(hub.refresh).toHaveBeenCalledOnce();

    hub = { ...hub, refreshing: true };
    rerender(sessionSurface());
    const retry = directory().getByRole("button", { name: tr("sessions.retry") });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(hub.refresh).toHaveBeenCalledOnce();
  });

  it("retries both workspace and catalog reads with one action while cached sessions remain", () => {
    hub = { ...hub, catalogError: "Catalog not refreshed", workspacesError: "List not refreshed" };
    render(sessionSurface());

    fireEvent.click(directory().getByRole("button", { name: tr("sessions.retry") }));
    expect(hub.refresh).toHaveBeenCalledOnce();
    expect(hub.retryWorkspaces).toHaveBeenCalledOnce();
    expect(screen.getByTestId("conversation")).toBeVisible();
  });

  it("keeps scan failure details collapsed and lets the user retry", () => {
    hub = { ...hub, selected: undefined, errors: { [workspace.id]: "Scan request failed" } };
    const { rerender } = render(sessionSurface());

    const details = directory().getByRole("button", { name: tr("common.details") });
    const retry = directory().getByRole("button", { name: tr("sessions.retry") });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(directory().queryByText("Scan request failed")).not.toBeInTheDocument();

    fireEvent.click(details);
    expect(directory().getByText(workspace.name)).toBeVisible();
    expect(directory().getByText("Scan request failed")).toBeVisible();
    fireEvent.click(details);
    expect(details).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(retry);
    expect(hub.refresh).toHaveBeenCalledOnce();
    hub = { ...hub, refreshing: true };
    rerender(sessionSurface());
    expect(retry).toBeDisabled();

    hub = { ...hub, errors: {}, refreshing: false };
    rerender(sessionSurface());
    expect(directory().queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["offline", "disconnected"] as const)(
    "shows a named %s host without turning its status into a session error",
    (status) => {
      hub.remoteHosts = [{ ...host, status }];
      render(sessionSurface());

      expandDetails();
      expect(directory().getByText(`${host.name} · ${tr(`remote.state.${status}`)}`)).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByTestId("conversation")).toBeVisible();
    },
  );

  it("shows a connected host's localized error in the shared details", () => {
    hub.remoteHosts = [{ ...host, status: "online" }];
    hub.remoteErrors = { [host.id]: "RuntimeRequestError: REMOTE_REQUEST_FAILED" };
    render(sessionSurface());

    expandDetails();
    expect(directory().getByText(`${host.name} · ${tr("remote.state.online")}`)).toBeVisible();
    expect(directory().getByText(tr("remote.error.request"))).toBeVisible();
    expect(screen.queryByText(/RuntimeRequestError|REMOTE_REQUEST_FAILED/)).toBeNull();
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("ignores errors from removed hosts and does not warn for connected healthy hosts", () => {
    hub.remoteHosts = [{ ...host, status: "online" }];
    hub.remoteErrors = { removed: "REMOTE_OFFLINE" };
    render(sessionSurface());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(host.name, { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("removes recovered notices without remounting the active conversation or losing its draft", () => {
    addCatalogNotices();
    const { rerender } = render(sessionSurface());
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
    rerender(sessionSurface());

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByTestId("conversation")).toBe(pane);
    expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(draft);
    expect(draft).toHaveValue("Keep typing through catalog refresh");
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("keeps global notices when switching local sessions and updates host errors independently", () => {
    addCatalogNotices();
    const { rerender } = render(sessionSurface());
    hub = { ...hub, selected: { ...session, id: "session-b", agent: "claude-code" } };
    rerender(sessionSurface());

    expectCatalogNotices();
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-session-id", "session-b");
    hub = {
      ...hub,
      remoteHosts: [{ ...host, id: "host-b", name: "Office Mac", status: "disconnected" }],
    };
    rerender(sessionSurface());
    expect(screen.getByText("Office Mac · Disconnected")).toBeVisible();
    expect(screen.queryByText("Studio Mac · Offline")).not.toBeInTheDocument();
    expect(screen.queryByText(tr("remote.error.offline"))).not.toBeInTheDocument();
    expect(screen.getByText(tr("sessions.partialFailure", { count: 2 }))).toBeVisible();
  });

  it("keeps one copy of each notice across overview, embedded, and history branches", async () => {
    addCatalogNotices();
    hub.selected = undefined;
    const { rerender } = render(sessionSurface());
    expectCatalogNotices();

    hub = { ...hub, selected: session };
    rerender(sessionSurface());
    expectCatalogNotices();
    expect(directory().getAllByRole("status")).toHaveLength(1);

    hub = { ...hub, selected: { ...session, agent: "open-claw" } };
    rerender(sessionSurface());
    expect(await screen.findByText("Cached local history")).toBeVisible();
    expectCatalogNotices();
    expect(directory().getAllByRole("status")).toHaveLength(1);
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
    render(sessionSurface());

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

  it("offers an uncached workspace-list retry in the directory", () => {
    hub = {
      ...hub,
      workspaces: [],
      workspacesError: "Workspace list unavailable",
      selected: undefined,
      sessions: [],
      filtered: [],
    };
    render(sessionSurface());

    expandDetails();
    expect(directory().getByText("Workspace list unavailable")).toBeVisible();
    expect(within(screen.getByRole("main")).queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
    fireEvent.click(directory().getByRole("button", { name: tr("sessions.retry") }));
    expect(hub.retryWorkspaces).toHaveBeenCalledOnce();
    expect(hub.refresh).not.toHaveBeenCalled();
  });
});
