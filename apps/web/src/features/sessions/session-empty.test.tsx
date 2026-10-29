import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import { SessionEmpty } from "./session-empty";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { dictionaries } from "@/features/conversation/i18n";
import type { ConversationSessionSummary } from "@agentkib/web-client";

const doubles = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to: _to,
    params,
    onClick,
    ...props
  }: {
    to: string;
    params: { sessionId: string };
    onClick: () => void;
    children: React.ReactNode;
    className: string;
  }) => (
    <a
      {...props}
      href={`/sessions/${params.sessionId}`}
      onClick={(event) => {
        event.preventDefault();
        onClick();
      }}
    />
  ),
}));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const session: ConversationSessionSummary = {
  id: "idle",
  workspace_id: "workspace",
  agent: "claude-code",
  availability: "readable",
  title: "Idle",
  archived: false,
  sidechain: false,
};

describe("recent sessions on the Web home", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows observed status and leaves idle sessions unlabelled in %s",
    (locale) => {
      const copy = sessionContinuationCopy(locale);
      vi.mocked(useSession).mockReturnValue({
        locale,
        t: dictionaries[locale],
        choose: doubles.choose,
        workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
        sessions: [
          session,
          {
            ...session,
            id: "running",
            title: "Running",
            continuation: { status: "starting", executionLocation: "agentkib" },
          },
          {
            ...session,
            id: "terminal",
            title: "Connected",
            continuation: { status: "idle", executionLocation: "terminal" },
          },
          {
            ...session,
            id: "busy",
            title: "External",
            continuation: {
              status: "idle",
              executionLocation: "external",
              ownershipReason: "claude-owner-busy",
            },
          },
          {
            ...session,
            id: "unsupported",
            title: "Unsupported",
            continuation: { status: "unsupported", reason: "platform-unsupported" },
          },
          { ...session, id: "archived", title: "Archived", archived: true },
          { ...session, id: "helper", title: "Helper", origin: "auxiliary" },
        ],
      } as unknown as ReturnType<typeof useSession>);
      render(<SessionEmpty />);
      expect(screen.getByText(copy.running)).toBeVisible();
      expect(screen.getByText(copy.terminalBadge)).toBeVisible();
      // Use elsewhere is confirmed after opening a session, never guessed in the list.
      expect(screen.queryByText(copy.busy("Claude Code"))).toBeNull();
      expect(
        within(screen.getByRole("link", { name: /External/ })).queryByRole("status"),
      ).toBeNull();
      expect(screen.getByText(copy.viewOnly)).toBeVisible();
      expect(within(screen.getByRole("link", { name: /Idle/ })).queryByRole("status")).toBeNull();
      expect(screen.queryByRole("link", { name: /Archived|Helper/ })).toBeNull();
      fireEvent.click(screen.getByRole("link", { name: /Idle/ }));
      expect(doubles.choose).toHaveBeenCalledWith("idle");
      expect(screen.getByRole("link", { name: /Idle/ })).toHaveAttribute("href", "/sessions/idle");
    },
  );

  it("names a worktree session after its repository, as the directory does", () => {
    const checkout = {
      repository_group_id: "repo",
      kind: "primary" as const,
      primary_path: "/work/atlas",
      name: null,
      branch: "main",
      status: "present" as const,
    };
    vi.mocked(useSession).mockReturnValue({
      locale: "zh-CN",
      t: dictionaries["zh-CN"],
      choose: doubles.choose,
      workspaces: [
        { id: "atlas", name: "atlas", path: "/work/atlas", checkout },
        { id: "work", name: "work", path: "/work" },
      ],
      sessions: [
        {
          ...session,
          id: "gone",
          title: "旧的实验分支",
          workspace_id: "work",
          worktree: {
            repository_group_id: "repo",
            name: "gone",
            path: "/work/atlas-worktrees/gone",
            branch: null,
            status: "deleted",
          },
        },
        { ...session, id: "notes", title: "整理笔记", workspace_id: "work" },
      ],
    } as unknown as ReturnType<typeof useSession>);
    render(<SessionEmpty />);
    expect(screen.getByRole("link", { name: /旧的实验分支/ })).toHaveTextContent("atlas");
    expect(screen.getByRole("link", { name: /整理笔记/ })).toHaveTextContent("work");
  });
});
