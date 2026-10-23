// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationIndexStatus, ConversationSessionSummary } from "@/core/types";
import { SessionSourceNotices } from "./SessionSourceNotices";

const status: ConversationIndexStatus = {
  workspace_id: "project",
  agent: "antigravity",
  freshness: "unavailable",
  session_count: 0,
  error_key: "errors.conversations.sourceUnavailable",
};
beforeAll(() => initializeI18n("en-US"));
afterEach(cleanup);
describe("named source notices", () => {
  it("keeps an unused installed Agent neutral and retries with the existing refresh action", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={["antigravity"]}
        refreshing={false}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      tr("sessions.sourceUnavailable", { agent: "Antigravity" }),
    );
    expect(screen.getByRole("status")).toHaveClass("text-muted-foreground");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveClass("text-primary-text");
    expect(
      screen.getByText(tr("sessions.sourceUnavailable", { agent: "Antigravity" })),
    ).not.toHaveClass("truncate");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={["antigravity"]}
        refreshing
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
  it("uses warning only for this workspace's previous Agent records", () => {
    const other = { workspace_id: "other", agent: "antigravity" } as ConversationSessionSummary;
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[other]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveClass("text-muted-foreground");
    rerender(
      <SessionSourceNotices
        statuses={[{ ...status, session_count: 1 }]}
        sessions={[other]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveClass("text-warning");
    rerender(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[{ ...other, workspace_id: "project" }]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveClass("text-warning");
  });
  it("hides uninstalled or recovered source errors", () => {
    const { rerender } = render(
      <SessionSourceNotices
        statuses={[status]}
        sessions={[]}
        installedAgents={[]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <SessionSourceNotices
        statuses={[{ ...status, error_key: undefined }]}
        sessions={[]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["zh-CN", "暂时读不到 Antigravity、Codex 的会话", "重试"],
    ["zh-TW", "暫時讀不到 Antigravity、Codex 的會話", "重試"],
    ["en-US", "Antigravity, Codex sessions are temporarily unavailable", "Retry"],
    ["ja-JP", "Antigravity、Codex のセッションを一時的に読み取れません", "再試行"],
  ] as const)(
    "groups several unavailable Agents into one complete notice in %s",
    async (locale, text, retryText) => {
      await initializeI18n(locale);
      try {
        const retry = vi.fn();
        render(
          <SessionSourceNotices
            statuses={[status, { ...status, workspace_id: "other" }, { ...status, agent: "codex" }]}
            sessions={[]}
            installedAgents={["antigravity", "codex"]}
            refreshing={false}
            onRetry={retry}
          />,
        );
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(screen.getByRole("status")).toHaveTextContent(text);
        expect(screen.getByText(text)).toHaveClass("whitespace-normal");
        expect(screen.getByText(text)).not.toHaveClass("truncate");
        fireEvent.click(screen.getByRole("button", { name: retryText }));
        expect(retry).toHaveBeenCalledOnce();
      } finally {
        await initializeI18n("en-US");
      }
    },
  );
});
