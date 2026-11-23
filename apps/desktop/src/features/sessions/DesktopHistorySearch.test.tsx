// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { DesktopHistorySearch } from "./DesktopHistorySearch";
import { useSessionViewStore } from "./session-view-store";

const { desktop, requestConversationPanel, select } = vi.hoisted(() => ({
  desktop: {
    available: true,
    selected: undefined as { agent: string; availability: string; remote?: boolean } | undefined,
  },
  requestConversationPanel: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale: "en-US" }) }));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => ({}),
  hasDesktopConversation: () => desktop.available,
}));
vi.mock("./SessionHubContext", () => ({
  useSessionHub: () => ({ selected: desktop.selected, select }),
}));
vi.mock("./conversation-panel-commands", () => ({ requestConversationPanel }));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  HistorySearchLauncher: ({
    onOpen,
    onOpenSession,
  }: {
    onOpen?: () => void;
    onOpenSession: (source: ConversationSessionSummary) => void;
  }) => (
    <>
      <button onClick={onOpen}>{onOpen ? "Open embedded search" : "Open standalone search"}</button>
      <button
        onClick={() =>
          onOpenSession({
            id: "source",
            workspace_id: "workspace",
            agent: "claude-code",
            availability: "readable",
            archived: true,
            sidechain: false,
            created_at: null,
            git_branch: null,
            forked_from_session_id: null,
            spawned_by_session_id: null,
          })
        }
      >
        Open source
      </button>
    </>
  ),
}));
beforeEach(() => {
  desktop.available = true;
  desktop.selected = undefined;
  requestConversationPanel.mockClear();
  select.mockClear();
  useSessionViewStore.getState().resetFilters();
});
afterEach(cleanup);

it.each(["codex", "claude-code", "antigravity"])(
  "opens embedded history search for a readable local %s conversation",
  (agent) => {
    desktop.selected = { agent, availability: "readable" };
    render(<DesktopHistorySearch />);
    fireEvent.click(screen.getByRole("button", { name: "Open embedded search" }));
    expect(requestConversationPanel).toHaveBeenCalledExactlyOnceWith("search");
  },
);

it.each([
  { agent: "codex", availability: "metadata-only" },
  { agent: "claude-code", availability: "readable", remote: true },
  { agent: "deepseek-harness", availability: "readable" },
  { agent: "devin", availability: "readable" },
  { agent: "unknown", availability: "readable" },
  undefined,
])("keeps the standalone launcher for %j", (selected) => {
  desktop.selected = selected;
  render(<DesktopHistorySearch />);
  fireEvent.click(screen.getByRole("button", { name: "Open standalone search" }));
  expect(requestConversationPanel).not.toHaveBeenCalled();
});

it("omits the desktop launcher without the conversation bridge", () => {
  desktop.available = false;
  render(<DesktopHistorySearch />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("reveals the readable source in the desktop directory before selecting it", () => {
  useSessionViewStore.setState({ filter: "metadata", agent: "codex", host: "remote" });
  render(<DesktopHistorySearch />);
  fireEvent.click(screen.getByRole("button", { name: "Open source" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("source");
  expect(useSessionViewStore.getState()).toMatchObject({
    filter: "all",
    agent: "all",
    host: "all",
    collapsed: { workspace: false },
  });
});
