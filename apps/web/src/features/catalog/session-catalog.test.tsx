import { sessionContinuationCopy } from "@agentkib/session-ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationSessionSummary } from "@agentkib/web-client";
import { SessionCatalog } from "@/features/conversation/features/catalog/session-catalog";

const workspaces = [
  { id: "alpha", name: "project", path: "/work/client-a/project" },
  { id: "beta", name: "project", path: "/work/client-b/project" },
];

const sessions = [
  {
    id: "primary",
    workspace_id: "alpha",
    title: "Primary session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-08T00:00:00Z",
  },
  {
    id: "newest",
    workspace_id: "beta",
    title: "Newest session",
    agent: "claude-code",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-09T00:00:00Z",
  },
  {
    id: "helper",
    workspace_id: "alpha",
    title: "Helper session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    origin: "auxiliary",
  },
  {
    id: "metadata",
    workspace_id: "alpha",
    title: "Metadata session",
    agent: "codex",
    availability: "metadata-only",
    archived: false,
    sidechain: false,
  },
] as ConversationSessionSummary[];

afterEach(cleanup);

describe("SessionCatalog", () => {
  it.each([
    ["zh-CN", "项目信息不可用，请更新电脑上的 AgentKib。"],
    ["zh-TW", "專案資訊不可用，請更新電腦上的 AgentKib。"],
    ["en-US", "Project information unavailable. Update AgentKib on your computer."],
    ["ja-JP", "プロジェクト情報を取得できません。コンピューター上の AgentKib を更新してください。"],
  ] as const)(
    "directs a legacy Web catalog to update the computer application in %s",
    (locale, notice) => {
      const onSelect = vi.fn();
      render(
        <SessionCatalog sessions={sessions} selected="" onSelect={onSelect} locale={locale} />,
      );
      expect(screen.getByRole("status")).toHaveTextContent(notice);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("reorders rows after an accepted catalog update without changing selection", () => {
    const props = { sessions, workspaces, selected: "primary", onSelect: vi.fn() };
    const view = render(<SessionCatalog {...props} />);
    const rows = () =>
      screen
        .getAllByRole("button", { name: /^(Codex|Claude Code) ·/ })
        .map((node) => node.getAttribute("aria-label"));
    expect(rows()[0]).toContain("Newest session");
    view.rerender(
      <SessionCatalog
        {...props}
        sessions={sessions.map((item) =>
          item.id === "primary" ? { ...item, updated_at: "2026-10-20T03:00:00Z" } : item,
        )}
      />,
    );
    expect(rows()[0]).toContain("Primary session");
    expect(screen.getByRole("button", { name: /Primary session/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  it("groups duplicate workspace names by path identity and hides auxiliary sessions by default", () => {
    render(
      <SessionCatalog sessions={sessions} workspaces={workspaces} selected="" onSelect={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Metadata session/ })).toBeNull();
    expect(screen.getByRole("button", { name: /client-b/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /client-a/ })).toBeVisible();
  });

  it("supports search and selection without an auxiliary visibility option", () => {
    const onSelect = vi.fn();
    render(
      <SessionCatalog
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={onSelect}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "Newest" },
    });
    expect(screen.getByRole("button", { name: /Newest session/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Newest session/ }));
    expect(onSelect).toHaveBeenCalledWith("newest");

    fireEvent.click(screen.getByText("目录选项"));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "记录类型" }), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
      target: { value: "Helper" },
    });
    expect(screen.queryByRole("button", { name: /Helper session/ })).toBeNull();
  });

  it("counts five ordinary conversations without the 36 execution records", () => {
    const ordinary: ConversationSessionSummary[] = Array.from({ length: 5 }, (_, index) => ({
      ...sessions[0],
      id: `ordinary-${index}`,
      title: index === 0 ? undefined : `Ordinary ${index}`,
      origin: index === 1 ? "unknown" : "interactive",
      ...(index === 2 ? { executionMode: "codex-managed" } : {}),
      ...(index === 3 ? { forked_from_session_id: "parent" } : {}),
    }));
    const executions: ConversationSessionSummary[] = Array.from({ length: 36 }, (_, index) => ({
      ...sessions[0],
      id: `exec-${index}`,
      title: undefined,
      origin: "execution",
    }));
    render(
      <SessionCatalog
        sessions={[...ordinary, ...executions]}
        workspaces={[workspaces[0]]}
        selected=""
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "project · 5" })).toBeVisible();
    expect(screen.getByRole("button", { name: /未命名会话/ })).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Codex ·/ })).toHaveLength(5);
  });

  it.each(["projectless", "unclassified"])(
    "keeps ordinary conversations in the %s collection while hiding internal records from counts and search",
    (kind) => {
      const collection = { id: `session-collection:codex:${kind}`, name: kind, path: "" };
      const ordinary: ConversationSessionSummary = {
        ...sessions[0],
        workspace_id: collection.id,
        origin: "unknown",
      };
      render(
        <SessionCatalog
          sessions={[
            ordinary,
            { ...ordinary, id: "execution", title: "Execution record", origin: "execution" },
            { ...ordinary, id: "auxiliary", title: "Auxiliary record", origin: "auxiliary" },
          ]}
          workspaces={[collection]}
          selected=""
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: `${kind} · 1` })).toBeVisible();
      expect(screen.getByRole("button", { name: /Primary session/ })).toBeVisible();
      fireEvent.change(screen.getByRole("textbox", { name: "搜索会话" }), {
        target: { value: "record" },
      });
      expect(
        screen.queryByRole("button", { name: /Execution record|Auxiliary record/ }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: `${kind} · 1` })).toBeNull();
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "labels an old Codex runtime as view-only in %s without probing rows",
    (locale) => {
      render(
        <SessionCatalog
          locale={locale}
          selected=""
          onSelect={vi.fn()}
          workspaces={workspaces}
          sessions={[
            {
              ...sessions[0],
              continuation: { status: "unsupported", reason: "codex-cli-version-too-old" },
            },
          ]}
        />,
      );
      expect(screen.getByText(sessionContinuationCopy(locale).viewOnly)).toBeVisible();
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps runtime dots distinct from pending interactions in %s",
    (locale) => {
      const copy = sessionContinuationCopy(locale);
      render(
        <SessionCatalog
          locale={locale}
          workspaces={workspaces}
          selected=""
          onSelect={vi.fn()}
          pendingSessions={{ running: true }}
          sessions={[
            { ...sessions[0], id: "idle", title: "Idle" },
            {
              ...sessions[0],
              id: "running",
              title: "Running",
              continuation: { status: "starting", executionLocation: "agentkib" },
            },
            {
              ...sessions[1],
              id: "terminal",
              title: "Terminal",
              continuation: { status: "idle", executionLocation: "terminal" },
            },
            {
              ...sessions[1],
              id: "busy",
              title: "Busy",
              continuation: {
                status: "idle",
                executionLocation: "external",
                ownershipReason: "claude-owner-busy",
              },
            },
            {
              ...sessions[1],
              id: "unsupported",
              title: "Unsupported",
              continuation: { status: "unsupported", reason: "platform-unsupported" },
            },
          ]}
        />,
      );
      const runningSession = screen.getByRole("button", { name: /Codex · Running/ });
      expect(runningSession).toHaveAccessibleName(new RegExp(copy.running));
      expect(within(runningSession).getByTitle(copy.running)).toHaveClass("bg-primary");
      const terminalSession = screen.getByRole("button", { name: /Claude Code · Terminal/ });
      expect(terminalSession).toHaveAccessibleName(new RegExp(copy.terminalBadge));
      expect(within(terminalSession).getByTitle(copy.terminalBadge)).toHaveClass(
        "bg-muted-foreground",
      );
      // Use elsewhere is confirmed after opening a session, never guessed in the list.
      expect(screen.queryByRole("status", { name: copy.busy("Claude Code") })).toBeNull();
      expect(screen.queryByRole("status", { name: copy.viewOnly })).toBeNull();
      expect(screen.getByRole("button", { name: /Running/ }).textContent).toContain("●");
      // Static runtime metadata is included in each session's accessible name, not a live region.
      expect(screen.queryAllByRole("status")).toHaveLength(0);
    },
  );
  it.each([
    ["zh-CN", "没有匹配的会话"],
    ["zh-TW", "沒有符合的對話"],
    ["en-US", "No matching sessions"],
    ["ja-JP", "該当する会話はありません"],
  ] as const)("uses session terminology in empty search feedback in %s", (locale, noResults) => {
    render(
      <SessionCatalog
        locale={locale}
        sessions={sessions}
        workspaces={workspaces}
        selected=""
        onSelect={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "No such session title" } });
    expect(screen.getByText(noResults)).toBeVisible();
  });
});

describe("git worktrees and program-started sessions", () => {
  const checkout = {
    repository_group_id: "repo",
    kind: "primary" as const,
    primary_path: "/work/atlas",
    name: null,
    branch: "main",
    status: "present" as const,
  };
  const repository = [
    { id: "main", name: "atlas", path: "/work/atlas", checkout },
    {
      id: "h1a",
      name: "atlas",
      path: "/codex/worktrees/h1a/atlas",
      checkout: { ...checkout, kind: "worktree" as const, name: "h1a" },
    },
  ];
  const row = (
    id: string,
    workspace_id: string,
    extra: Partial<ConversationSessionSummary> = {},
  ): ConversationSessionSummary => ({
    id,
    workspace_id,
    title: `${id} session`,
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-09-08T00:00:00Z",
    ...extra,
  });

  it("merges a repository's worktrees into one group and marks worktree rows with an icon", () => {
    const worktree = {
      repository_group_id: "repo",
      name: "h1a",
      path: "/codex/worktrees/h1a/atlas",
      branch: "codex/h1a",
      status: "present" as const,
    };
    render(
      <SessionCatalog
        sessions={[row("main", "main"), row("wt", "h1a", { worktree })]}
        workspaces={repository}
        selected=""
        onSelect={vi.fn()}
        locale="zh-CN"
      />,
    );
    expect(screen.getAllByRole("region")).toHaveLength(1);
    const label = "在 git 工作树 h1a 中运行 · 分支 codex/h1a · /codex/worktrees/h1a/atlas";
    expect(screen.getByRole("img", { name: label })).toHaveAttribute("title", label);
    expect(screen.getByRole("button", { name: /wt session/ })).toHaveAccessibleName(
      expect.stringContaining(label),
    );
    expect(screen.getByRole("button", { name: /atlas · 1 个工作树: h1a · 2/ })).toBeVisible();
  });

  it("lists program-started sessions only when the option is on", () => {
    const onExecutionChange = vi.fn();
    const records = [row("ordinary", "main"), row("pen", "main", { origin: "execution" })];
    const { rerender } = render(
      <SessionCatalog
        sessions={records}
        workspaces={repository}
        selected=""
        onSelect={vi.fn()}
        locale="en-US"
        onExecutionChange={onExecutionChange}
      />,
    );
    expect(screen.queryByText("pen session")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show program-started sessions" }));
    expect(onExecutionChange).toHaveBeenCalledWith(true);
    rerender(
      <SessionCatalog
        sessions={records}
        workspaces={repository}
        selected=""
        onSelect={vi.fn()}
        locale="en-US"
        execution
        onExecutionChange={onExecutionChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: /pen session · Started by a program/ }),
    ).toBeVisible();
  });
});
