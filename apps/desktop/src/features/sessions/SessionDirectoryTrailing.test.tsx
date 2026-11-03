// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readStateCopy, sessionContinuationCopy } from "@agentkib/session-ui";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary } from "@/core/types";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { SessionDirectoryEntry } from "./SessionDirectoryEntry";
import { SessionDirectoryTrailing } from "./SessionDirectoryTrailing";
import { worktreeLabel } from "./session-labels";
import { codexCopy } from "./conversation/features/sessions/codex-copy";

const { client, select, changed, deleted } = vi.hoisted(() => ({
  client: {
    sessionCapabilities: vi.fn(),
    access: vi.fn(),
    live: vi.fn(),
    sessionAction: vi.fn(),
  },
  select: vi.fn(),
  changed: vi.fn(),
  deleted: vi.fn(),
}));
vi.mock("@/core/conversation-bridge", () => ({
  createDesktopConversationClient: () => client,
}));

const worktree = {
  repository_group_id: "repository",
  name: "feature",
  path: "/projects/worktrees/feature",
  branch: "feature/status",
  status: "present" as const,
};
const unread = {
  source: "codex-native" as const,
  status: "unread" as const,
  freshness: "current" as const,
  version: "native:1",
  firstUnread: { type: "result" as const, resultId: "result", turnId: "turn" },
  latestResult: {
    id: "result",
    turnId: "turn",
    itemId: null,
    outcome: "completed" as const,
    completedAt: null,
  },
};
const summary = (fields: Partial<ConversationSessionSummary> = {}) =>
  ({
    id: "session",
    agent: "codex",
    title: "Synthetic session",
    workspace_id: "workspace",
    availability: "readable",
    archived: false,
    sidechain: false,
    ...fields,
  }) as ConversationSessionSummary;

function Row({ session, local = true }: { session: ConversationSessionSummary; local?: boolean }) {
  return (
    <AppDialogProvider>
      <div className="session-directory-row group/session">
        <button type="button" onClick={() => select(session.id)}>
          <SessionDirectoryEntry session={session} sessions={[session]} hideIndicators />
        </button>
        <SessionDirectoryTrailing
          session={session}
          sessions={[session]}
          local={local}
          onChanged={changed}
          onDeleted={deleted}
        />
      </div>
    </AppDialogProvider>
  );
}

function visualIndicator(container: HTMLElement) {
  return container.querySelector<HTMLElement>(".session-directory-indicator")!;
}

beforeEach(() => {
  initializeI18n("en-US");
  vi.clearAllMocks();
  client.sessionCapabilities.mockResolvedValue({
    sessionId: "session",
    features: { rename: { available: true } },
  });
  client.access.mockResolvedValue({ status: "approved", bootId: "boot", csrfToken: "" });
  client.live.mockResolvedValue({ sessionId: "session", revision: 1, status: "idle" });
  client.sessionAction.mockResolvedValue({ accepted: true });
});
afterEach(cleanup);

describe("the desktop directory's shared trailing status slot", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "prioritizes unread, then worktree, while retaining accessible runtime details in %s",
    (locale) => {
      initializeI18n(locale);
      const session = summary({
        readState: unread,
        worktree,
        continuation: { status: "running", executionLocation: "agentkib" },
      });
      const view = render(<Row session={session} />);
      const indicator = visualIndicator(view.container);
      expect(indicator.querySelector("[data-unread]")).toHaveAttribute(
        "title",
        expect.stringContaining(readStateCopy(locale).unread),
      );
      expect(indicator.querySelector("[data-worktree-mark]")).toBeNull();
      const entry = screen.getByRole("button", { name: /^Synthetic session/ });
      expect(entry).toHaveAccessibleName(
        expect.stringContaining(sessionContinuationCopy(locale).running),
      );
      expect(entry).toHaveAccessibleName(expect.stringContaining(worktreeLabel(worktree, tr)));
      expect(indicator).toHaveAttribute("aria-hidden", "true");

      view.rerender(<Row session={{ ...session, readState: { ...unread, status: "read" } }} />);
      const afterRead = visualIndicator(view.container);
      expect(afterRead.querySelector("[data-unread]")).toBeNull();
      expect(afterRead.querySelector("[data-worktree-mark]")).toHaveAttribute(
        "title",
        worktreeLabel(worktree, tr),
      );
      expect(afterRead.querySelector(".animate-spin")).toBeNull();
    },
  );

  it("still shows native manual unread for a metadata-only session", () => {
    const view = render(
      <Row
        session={summary({
          availability: "metadata-only",
          readState: { ...unread, firstUnread: { type: "threadStart" }, latestResult: null },
        })}
      />,
    );
    expect(visualIndicator(view.container).querySelector("[data-unread]")).toHaveAttribute(
      "title",
      readStateCopy("en-US").manualUnread,
    );
    expect(screen.getByRole("button", { name: /^Synthetic session/ })).toHaveAccessibleName(
      expect.stringContaining(readStateCopy("en-US").manualUnread),
    );
  });

  it.each([
    { agent: "codex", local: false },
    { agent: "opencode", local: true },
    { agent: "antigravity", local: true },
  ] as const)("retains unread without offering a menu for %j", ({ agent, local }) => {
    const view = render(<Row session={summary({ agent, readState: unread })} local={local} />);
    const slot = view.container.querySelector(".session-directory-trailing")!;
    expect(slot).not.toHaveAttribute("data-has-menu");
    expect(slot).toHaveAttribute("data-has-indicator", "true");
    expect(visualIndicator(view.container).querySelector("[data-unread]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: codexCopy["en-US"].rowMenu })).toBeNull();
  });

  it("falls back to runtime state when there is no unread result or worktree", () => {
    const view = render(
      <Row
        session={summary({ continuation: { status: "running", executionLocation: "agentkib" } })}
      />,
    );
    expect(visualIndicator(view.container).querySelector(".animate-spin")).toHaveAttribute(
      "title",
      sessionContinuationCopy("en-US").running,
    );
  });

  it("allows a keyboard user to open an empty slot's menu without selecting the session", async () => {
    const user = userEvent.setup();
    const view = render(<Row session={summary()} />);
    const slot = view.container.querySelector(".session-directory-trailing")!;
    expect(slot).toHaveAttribute("data-has-menu", "true");
    expect(slot).not.toHaveAttribute("data-has-indicator");
    await user.tab();
    expect(screen.getByRole("button", { name: /^Synthetic session/ })).toHaveFocus();
    await user.tab();
    const menuButton = screen.getByRole("button", { name: codexCopy["en-US"].rowMenu });
    expect(menuButton).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("menu")).toBeVisible();
    expect(menuButton).toHaveAttribute("data-popup-open");
    expect(await screen.findByRole("menuitem", { name: codexCopy["en-US"].rename })).toBeEnabled();
    expect(select).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(menuButton).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
    expect(deleted).not.toHaveBeenCalled();
  });

  it("keeps the workspace entry's default indicators unchanged", () => {
    const session = summary({ readState: unread, worktree });
    const view = render(
      <button type="button">
        <SessionDirectoryEntry session={session} sessions={[session]} />
      </button>,
    );
    expect(view.container.querySelector("[data-unread]")).not.toBeNull();
    expect(screen.getByRole("img", { name: worktreeLabel(worktree, tr) })).toBeVisible();
  });
});
