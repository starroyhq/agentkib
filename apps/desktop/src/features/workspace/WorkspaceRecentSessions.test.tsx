// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { WorkspaceRecentSessions } from "./WorkspaceRecentSessions";
import { useSessionViewStore } from "@/features/sessions/session-view-store";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn(),
  catalog: vi.fn(),
  managed: vi.fn(),
  installations: vi.fn(),
  refreshManaged: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => doubles.navigate }));
vi.mock("@/features/sessions/useSessionCatalog", () => ({
  useSessionCatalog: (...args: unknown[]) => doubles.catalog(...args),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => doubles.managed(),
  refreshConversationCatalog: () => doubles.refreshManaged(),
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeInstallations: () => doubles.installations(),
}));
const workspace: WorkspaceSummary = {
  id: "project",
  name: "Project",
  path: "/fixture/project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const session = (
  id: string,
  at: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary => ({
  id,
  workspace_id: workspace.id,
  agent: "claude-code",
  title: id,
  updated_at: at,
  availability: "readable",
  archived: false,
  sidechain: false,
  origin: "unknown",
  ...extra,
});
describe("workspace recent sessions", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.managed.mockReturnValue({ sessions: [], ready: true });
    doubles.installations.mockReturnValue({ data: [] });
    doubles.catalog.mockReturnValue({
      sessions: [],
      statuses: [],
      errors: {},
      ready: true,
      loading: false,
      refreshing: false,
      refresh: doubles.refresh,
    });
  });
  afterEach(cleanup);
  it("opens the latest three visible histories directly in the conversation page", () => {
    doubles.catalog.mockReturnValue({
      sessions: [
        session("old", "2026-10-19"),
        session("second", "2026-10-22"),
        session("latest", "2026-10-23"),
        session("third", "2026-10-21"),
        session("archived", "2026-10-24", { archived: true }),
        session("metadata", "2026-10-25", { availability: "metadata-only" }),
      ],
      statuses: [],
      errors: {},
      ready: true,
    });
    render(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(
      screen.getAllByRole("button", { name: /Open session/ }).map((button) => button.textContent),
    ).toEqual([
      expect.stringContaining("latest"),
      expect.stringContaining("second"),
      expect.stringContaining("third"),
    ]);
    expect(screen.queryByText("old")).toBeNull();
    expect(screen.queryByText("metadata")).toBeNull();
    useSessionViewStore.setState({
      agent: "codex",
      host: "remote-host",
      filter: "archived",
      creatingConversation: true,
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Open session/ })[0]);
    expect(doubles.navigate).toHaveBeenCalledWith({
      to: "/sessions",
      search: { sessionId: "latest" },
    });
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "all",
      host: "all",
      filter: "all",
      creatingConversation: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(doubles.navigate).toHaveBeenLastCalledWith({
      to: "/workspace/$workspaceId/sessions",
      params: { workspaceId: workspace.id },
    });
  });
  it("keeps disabled indexing and empty history distinct", () => {
    const view = render(<WorkspaceRecentSessions workspace={workspace} enabled={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Session reading is not enabled");
    expect(doubles.catalog).toHaveBeenLastCalledWith([workspace], false);
    view.rerender(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "No readable sessions were found in recent workspaces.",
    );
  });
  it("shows a read failure with retry while keeping cached rows usable", () => {
    doubles.catalog.mockReturnValue({
      sessions: [session("cached", "2026-10-23")],
      errors: { project: "Read failed" },
      statuses: [],
      ready: true,
      refreshing: false,
      refresh: doubles.refresh,
    });
    render(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByRole("alert")).toHaveTextContent("Read failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(doubles.refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Open session/ })).toBeVisible();
  });
  it("shows a newly managed session before its native history has been indexed", () => {
    doubles.managed.mockReturnValue({
      sessions: [
        session("new managed", "2026-10-23", { origin: "interactive" }),
        session("other project", "2026-10-24", { workspace_id: "other" }),
      ],
      ready: true,
    });
    render(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByText("new managed")).toBeVisible();
    expect(screen.queryByText("other project")).toBeNull();
  });
  it("does not call an unfinished or failed managed catalog an empty history", () => {
    doubles.managed.mockReturnValue({ sessions: [], ready: false });
    const view = render(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    doubles.managed.mockReturnValue({
      sessions: [],
      ready: true,
      error: new Error("managed unavailable"),
    });
    view.rerender(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByText("No readable sessions were found in recent workspaces.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(doubles.refreshManaged).toHaveBeenCalledOnce();
  });
  it("only reports source failures for installed Agents", () => {
    doubles.catalog.mockReturnValue({
      sessions: [],
      statuses: [{ agent: "codex", error_key: "errors.conversations.sourceUnavailable" }],
      errors: {},
      ready: true,
      refresh: doubles.refresh,
    });
    const view = render(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.queryByRole("alert")).toBeNull();
    doubles.installations.mockReturnValue({ data: [{ agent: "codex", installed: true }] });
    view.rerender(<WorkspaceRecentSessions workspace={workspace} enabled />);
    expect(screen.getByRole("alert")).toHaveTextContent("Some session sources are unavailable");
  });
});
