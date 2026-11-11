// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { homeSessionCopy } from "@agentkib/session-ui";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, QuotaSnapshot } from "@/core/types";
import { MenuBarPopover } from "./MenuBarPopover";

const state = vi.hoisted(() => ({
  indexEnabled: true,
  sessions: [] as ConversationSessionSummary[],
  snapshot: undefined as QuotaSnapshot | undefined,
  create: vi.fn(async () => "new-session"),
}));

vi.mock("./use-popover", () => ({
  usePopoverOpen: () => ({ open: true, opened: 1 }),
  usePopoverRuntime: () => ({ session_index_enabled: state.indexEnabled }),
  usePopoverHeight: () => undefined,
  useNow: () => Date.parse("2026-11-11T10:00:00.000Z"),
}));
vi.mock("@/core/conversation-bridge", async (original) => ({
  ...(await original<typeof import("@/core/conversation-bridge")>()),
  hasDesktopConversation: () => true,
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => ({
    sessions: state.sessions,
    usable: true,
    ready: true,
    refreshing: false,
    accessDenied: false,
  }),
}));
vi.mock("@/features/home/home-replies", () => ({
  useHomeReplies: () => ({
    client: {},
    unconfirmed: new Set(),
    answered: new Set(),
    reply: vi.fn(),
    stop: vi.fn(),
    markAnswered: vi.fn(),
  }),
}));
vi.mock("@/features/home/home-query", () => ({
  homeKeys: { workspaces: () => ["w"], remoteStatus: () => ["r"] },
  useHomeWorkspaces: () => ({
    data: [{ id: "workspace", name: "northstar-api", path: "/work/northstar-api" }],
  }),
  useHomeInstallations: () => ({ data: [] }),
  useHomeRemoteStatus: () => ({ data: undefined }),
}));
vi.mock("@/features/quota/quota-query", () => ({
  DEFAULT_QUOTA_PREFERENCES: { hidden_providers: [], hidden_windows: [] },
  useQuotaSnapshot: () => ({ data: state.snapshot }),
  useQuotaPreferences: () => ({ data: undefined }),
  useQuotaRefreshJob: () => ({ data: undefined }),
  useQuotaRefreshMutation: () => ({ isPending: false, mutateAsync: vi.fn(async () => undefined) }),
  useQuotaQueryEvents: () => undefined,
}));
vi.mock("@/features/sessions/new-session/use-new-session", () => ({
  failureOf: () => ({ reason: "failed" }),
  useNewSession: () => ({
    ready: true,
    options: {
      data: { available: true, models: [] },
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    },
    busy: false,
    failure: undefined,
    unknown: false,
    create: state.create,
  }),
}));

const shell = { openMain: vi.fn(async () => undefined), quit: vi.fn(), hideWindow: vi.fn() };

function renderPopover() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MenuBarPopover />
    </QueryClientProvider>,
  );
}

const home = homeSessionCopy("en-US");

describe("menu bar popover", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    state.indexEnabled = true;
    state.sessions = [];
    state.snapshot = undefined;
    state.create.mockClear();
    for (const fn of Object.values(shell)) fn.mockClear();
    Object.assign(window.agentkibDesktop as object, { shell });
    localStorage.clear();
  });
  afterEach(cleanup);

  it("says all is clear when nothing waits, runs or is unread", () => {
    renderPopover();
    expect(screen.getByRole("heading", { name: home.allClear })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /New session/ })).toBeInTheDocument();
  });

  it("points to the home while the session index is off", () => {
    state.indexEnabled = false;
    renderPopover();
    expect(screen.getByText(tr("menubar.indexOff"))).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: tr("menubar.openApp") })[0]);
    expect(shell.openMain).toHaveBeenCalledWith({ page: "home", configure_popover: false });
  });

  it("starts a session and hands its first message to the main window", async () => {
    renderPopover();
    const input = screen.getByRole("textbox", { name: /New session/ });
    fireEvent.change(input, { target: { value: "  Fix the login timeout  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(state.create).toHaveBeenCalledWith({ workspaceId: "workspace" }));
    await waitFor(() =>
      expect(shell.openMain).toHaveBeenCalledWith({
        page: "sessions",
        session_id: "new-session",
        draft: "Fix the login timeout",
        configure_popover: false,
      }),
    );
    expect(input).toHaveValue("");
  });

  it("opens an Agent's quota windows from its ring", () => {
    state.snapshot = {
      schema_version: 1,
      backend: "codexbar",
      generated_at: "2026-11-11T10:00:00.000Z",
      fetched_at: "2026-11-11T09:58:00.000Z",
      stale_after_seconds: 3_600,
      freshness: "fresh",
      providers: [
        {
          id: "codex",
          name: "Codex",
          enabled: true,
          accounts: [],
          windows: [
            { kind: "session", label: "", used_percent: 62, remaining_percent: 38 },
            { kind: "weekly", label: "", used_percent: 29, remaining_percent: 71 },
          ],
        },
      ],
    } as unknown as QuotaSnapshot;
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: "Codex, 38% left" }));
    expect(screen.getByRole("region", { name: "Codex" })).toHaveTextContent("5-hour window");
    expect(screen.getByRole("region", { name: "Codex" })).toHaveTextContent("71% remaining");
    fireEvent.click(screen.getByRole("button", { name: tr("menubar.openQuota") }));
    expect(shell.openMain).toHaveBeenCalledWith({
      page: "quota",
      provider: "codex",
      configure_popover: false,
    });
  });

  it("opens the app, quits, or closes with Escape", () => {
    renderPopover();
    fireEvent.click(screen.getByRole("button", { name: tr("menubar.openApp") }));
    expect(shell.openMain).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByRole("button", { name: tr("menubar.quit") }));
    expect(shell.quit).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell.hideWindow).toHaveBeenCalled();
  });
});
