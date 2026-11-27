// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { SessionTranscript } from "@agentkib/session-ui";
import workerReportsFixture from "../../../../../../../../packages/runtime-protocol/test/fixtures/worker-reports.json";

const fixture = workerReportsFixture as unknown as {
  events: ConversationEvent[];
};

const baseProps = {
  labels: {
    process: "执行过程",
    tools: "次工具调用",
    failed: "失败",
    attachments: "附件",
    truncated: "已截断",
    unknownTool: "工具",
  },
  locale: "zh-CN",
  earlierLabel: "加载更早记录",
};

afterEach(cleanup);

describe("Worker report cards in SessionTranscript", () => {
  it("renders every recorded worker report kind from the protocol fixture without model-side prompt leaks", () => {
    const onOpenSession = vi.fn();
    for (const event of fixture.events) {
      if (!event.worker_reports?.parts.length) continue;
      const { container, unmount } = render(
        <SessionTranscript {...baseProps} events={[event]} onOpenSession={onOpenSession} />,
      );
      expect(container.querySelector('[data-message-role="report"]')).not.toBeNull();
      expect(container.querySelector('[data-user-message-bubble="true"]')).toBeNull();
      const text = container.textContent ?? "";
      expect(text, event.id).not.toContain("[AgentKib report]");
      expect(text, event.id).not.toContain("Below is the worker's last reply");
      expect(text, event.id).not.toContain("Use worker_read");
      expect(text, event.id).not.toContain("[AgentKib report ID:");
      expect(text, event.id).not.toContain("宿主机");
      unmount();
    }
  });

  it("keeps unverified messages starting with [AgentKib report] as ordinary user bubbles", () => {
    const plain = fixture.events.find((event) => event.id === "message-without-delivery")!;
    const { container } = render(<SessionTranscript {...baseProps} events={[plain]} />);
    expect(container.querySelector('[data-message-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-message-role="report"]')).toBeNull();
    expect(container.querySelector('[data-user-message-bubble="true"]')).toHaveTextContent(
      plain.content!,
    );
  });

  it("renders short replies directly and collapses replies exceeding 6 lines or 320 chars", () => {
    const shortEvent = fixture.events.find((event) => event.id === "turn-ended-completed")!;
    const longReply = Array.from({ length: 8 }, (_, index) => `Line ${index + 1} result`).join(
      "\n",
    );
    const longEvent: ConversationEvent = {
      ...shortEvent,
      id: "turn-ended-long",
      worker_reports: {
        reportId: "long-report-id",
        parts: [{ ...shortEvent.worker_reports!.parts[0], reply: longReply }],
      },
    };

    const shortView = render(<SessionTranscript {...baseProps} events={[shortEvent]} />);
    expect(
      shortView.container.querySelector('[data-worker-report-reply="expanded"]'),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开全部" })).not.toBeInTheDocument();
    shortView.unmount();

    const longView = render(<SessionTranscript {...baseProps} events={[longEvent]} />);
    expect(
      longView.container.querySelector('[data-worker-report-reply="collapsed"]'),
    ).not.toBeNull();
    const expandButton = screen.getByRole("button", { name: "展开全部" });
    fireEvent.click(expandButton);
    expect(
      longView.container.querySelector('[data-worker-report-reply="expanded"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(
      longView.container.querySelector('[data-worker-report-reply="collapsed"]'),
    ).not.toBeNull();
  });

  it("groups batched reports with requiresUser pinned on top, toggles rows, and opens the worker session", () => {
    const batched = fixture.events.find((event) => event.id === "batch-mixed")!;
    const onOpenSession = vi.fn();
    render(<SessionTranscript {...baseProps} events={[batched]} onOpenSession={onOpenSession} />);

    const group = screen.getByRole("region", { name: "收到 3 条 Worker 汇报" });
    expect(within(group).getByText("1 条需你处理")).toBeVisible();
    expect(within(group).getByText("1 条失败")).toBeVisible();
    expect(within(group).getByText("1 条完成")).toBeVisible();
    expect(within(group).getByText(/部分长正文已按大小上限省略/)).toBeVisible();

    const items = group.querySelectorAll<HTMLElement>("[data-worker-report-item]");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAttribute("data-worker-report-item", "waiting-approval");
    expect(within(items[0]).getByText("git status --short")).toBeVisible();
    expect(within(items[1]).getByText("The worktree checks passed.")).toBeVisible();
    expect(within(items[1]).queryByText(/Unit tests passed/)).not.toBeInTheDocument();

    fireEvent.click(within(items[0]).getByRole("button", { name: "前往处理" }));
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith("worker-session-b");

    fireEvent.click(within(group).getByRole("button", { name: "全部展开" }));
    expect(within(items[1]).getByText(/Unit tests passed/)).toBeVisible();
    expect(within(group).getByRole("button", { name: "全部收起" })).toBeVisible();
  });

  it("merges consecutive back-to-back worker report events into a single group", () => {
    const first = fixture.events.find((event) => event.id === "turn-ended-completed")!;
    const second = fixture.events.find((event) => event.id === "waiting-question-person")!;
    render(<SessionTranscript {...baseProps} events={[first, second]} />);

    const group = screen.getByRole("region", { name: "收到 2 条 Worker 汇报" });
    const items = group.querySelectorAll<HTMLElement>("[data-worker-report-item]");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-worker-report-item", "waiting-question");
    expect(items[1]).toHaveAttribute("data-worker-report-item", "turn-ended");
  });
});
