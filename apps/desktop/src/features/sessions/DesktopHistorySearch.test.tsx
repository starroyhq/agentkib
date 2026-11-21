// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { DesktopHistorySearch } from "./DesktopHistorySearch";
import { useSessionViewStore } from "./session-view-store";

const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/core/useI18n", () => ({ useI18n: () => ({ locale: "en-US" }) }));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => ({}),
  hasDesktopConversation: () => true,
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: () => ({ selected: undefined, select }) }));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  HistorySearchLauncher: ({
    onOpenSession,
  }: {
    onOpenSession: (source: ConversationSessionSummary) => void;
  }) => (
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
  ),
}));
beforeEach(() => {
  select.mockClear();
  useSessionViewStore.getState().resetFilters();
});
afterEach(cleanup);

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
