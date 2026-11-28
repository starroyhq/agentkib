// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { useSessionHub } from "./SessionHubContext";
import { SessionWindowToolbar } from "./SessionWindowToolbar";
import { useSessionViewStore } from "./session-view-store";

vi.mock("@/core/conversation-bridge", () => ({
  hasDesktopConversation: () => true,
}));
vi.mock("./SessionHubContext", () => ({
  useSessionHub: vi.fn(),
}));
vi.mock("./useHistoryContinuation", () => ({
  useHistoryContinuation: () => ({
    canContinue: false,
    continueSession: vi.fn(),
    checking: false,
  }),
}));

const workspace = { id: "ws-1", name: "northstar", path: "/northstar" } as WorkspaceSummary;
const session: ConversationSessionSummary = {
  id: "session-1",
  workspace_id: workspace.id,
  agent: "claude-code",
  title: "Refactor auth refresh queue",
  availability: "readable",
  archived: false,
  sidechain: false,
};

describe("SessionWindowToolbar", () => {
  beforeAll(async () => {
    await initializeI18n("zh-CN");
  });

  beforeEach(() => {
    useSessionViewStore.getState().setCreatingConversation(false);
    vi.mocked(useSessionHub).mockReturnValue({
      localEnabled: true,
      selected: undefined,
      selectedWorkspace: undefined,
      historyRevision: 0,
      select: vi.fn(),
    } as unknown as ReturnType<typeof useSessionHub>);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hides the redundant new-conversation button while already on the New Session page", () => {
    const view = render(<SessionWindowToolbar />);
    expect(
      screen.getByRole("button", { name: tr("sessions.newConversation") }),
    ).toBeInTheDocument();

    useSessionViewStore.getState().setCreatingConversation(true);
    view.rerender(<SessionWindowToolbar />);
    expect(screen.getByText(tr("sessions.newConversation"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: tr("sessions.newConversation") }),
    ).not.toBeInTheDocument();
  });

  it("places the connection status slot directly beside the session title", () => {
    vi.mocked(useSessionHub).mockReturnValue({
      localEnabled: true,
      selected: session,
      selectedWorkspace: workspace,
      historyRevision: 0,
      select: vi.fn(),
    } as unknown as ReturnType<typeof useSessionHub>);

    const { container } = render(<SessionWindowToolbar />);
    const heading = screen.getByRole("heading", { name: "Refactor auth refresh queue" });
    const statusSlot = container.querySelector("[data-session-window-status-slot]");
    expect(statusSlot).not.toBeNull();
    expect(statusSlot?.parentElement).toBe(heading.parentElement);
    expect(heading.nextElementSibling).toBe(statusSlot);
  });
});
