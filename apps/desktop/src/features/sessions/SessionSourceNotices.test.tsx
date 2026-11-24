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
        statuses={[{ ...status, freshness: "stale", error_key: undefined }]}
        sessions={[]}
        refreshing={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    ["zh-CN", "暂时读不到 Antigravity、Codex 的会话", "重试"],
    ["zh-Hant", "暫時讀不到 Antigravity、Codex 的會話", "重試"],
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

it("keeps scan errors compact and reveals only the affected sources when expanded", () => {
  const retry = vi.fn();
  const partialRead = tr("sessions.sourcePartialRead");
  const unknownDetail = "Unexpected diagnostic for /private/source.jsonl";
  render(
    <SessionSourceNotices
      statuses={[
        {
          ...status,
          session_count: 1,
          error_detail:
            "Some conversation sources could not be read; previous records were retained",
        },
        {
          ...status,
          workspace_id: "other",
          error_key: "unknown-error",
          error_detail: unknownDetail,
        },
        { ...status, workspace_id: "healthy", freshness: "stale", error_key: undefined },
      ]}
      sessions={[]}
      workspaces={[
        { id: "project", name: "App" },
        { id: "other", name: "Docs" },
        { id: "healthy", name: "Healthy" },
      ]}
      refreshing={false}
      onRetry={retry}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent(
    tr("sessions.sourceUnavailable", { agent: "Antigravity" }),
  );
  const details = screen.getByRole("button", { name: tr("common.details") });
  expect(details).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("App · Antigravity")).toBeNull();
  expect(screen.queryByText(partialRead)).toBeNull();
  fireEvent.click(details);
  expect(details).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("App · Antigravity")).toBeVisible();
  expect(screen.getByText("Docs · Antigravity")).toBeVisible();
  expect(screen.getByText(partialRead)).toBeVisible();
  expect(screen.getByText(tr("errors.conversations.sourceUnavailable"))).toBeVisible();
  expect(screen.queryByText("Healthy · Antigravity")).toBeNull();
  expect(screen.queryByText(unknownDetail)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: tr("sessions.retry") }));
  expect(retry).toHaveBeenCalledOnce();
});

it("lists each Antigravity failure category once across affected workspaces", () => {
  const acp = "antigravity-acp-list";
  render(
    <SessionSourceNotices
      statuses={[
        {
          ...status,
          error_detail: JSON.stringify([acp, "antigravity-database-record"]),
        },
        { ...status, workspace_id: "other", error_detail: JSON.stringify([acp]) },
      ]}
      sessions={[]}
      workspaces={[
        { id: "project", name: "App" },
        { id: "other", name: "Docs" },
      ]}
      refreshing={false}
      onRetry={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: tr("common.details") }));
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getByText("App, Docs · Antigravity")).toBeVisible();
  expect(screen.getByText("App · Antigravity")).toBeVisible();
  expect(screen.getByText("The ACP session list could not be read.")).toBeVisible();
  expect(screen.getByText("Some local database records could not be read.")).toBeVisible();
  expect(screen.queryByText(acp)).toBeNull();
});
