// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { SessionTranscript } from "@agentkib/session-ui";
import boundaryFixture from "../../../../../../../../packages/runtime-protocol/test/fixtures/conversation-compaction-boundaries.json";

const labels = {
  process: "执行过程",
  tools: "次工具调用",
  failed: "失败",
  attachments: "附件",
  truncated: "已截断",
  unknownTool: "工具",
};

const fixture = boundaryFixture as unknown as {
  claudeCode: { events: ConversationEvent[] };
  codex: { events: ConversationEvent[] };
};

afterEach(cleanup);

describe("P0-6 compaction boundary rendering", () => {
  it("renders auto and manual Claude compaction boundaries as separators without message actions", () => {
    const { container } = render(
      <SessionTranscript
        events={fixture.claudeCode.events}
        labels={labels}
        locale="zh-CN"
        earlierLabel="加载更早记录"
      />,
    );
    const separators = screen.getAllByRole("separator");
    expect(separators).toHaveLength(2);
    expect(separators[0]).toHaveAttribute("data-compaction-boundary", "auto");
    expect(separators[0].textContent).toMatch(/已压缩上下文 · \d{2}:\d{2}（自动）/);
    expect(separators[1]).toHaveAttribute("data-compaction-boundary", "manual");
    expect(separators[1].textContent).toMatch(/已压缩上下文 · \d{2}:\d{2}（手动）/);
    // Boundaries must never get copy buttons or user bubbles.
    expect(container.querySelectorAll("[data-compaction-boundary] button")).toHaveLength(0);
  });

  it("omits trigger parentheses when compaction_trigger is unknown", () => {
    render(
      <SessionTranscript
        events={fixture.codex.events}
        labels={labels}
        locale="zh-CN"
        earlierLabel="加载更早记录"
      />,
    );
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("data-compaction-boundary", "unknown");
    expect(separator.textContent).toMatch(/^已压缩上下文 · \d{2}:\d{2}$/);
  });
});

describe("P1-3 process header tool summary and empty message filtering", () => {
  it("keeps turn boundaries, drops blank assistant rows, and summarizes tool names in each process heading", () => {
    const events: ConversationEvent[] = [
      {
        id: "u1",
        kind: "user-message",
        turn_id: "turn-1",
        content: "检查工作区，再读一下 README",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "t1",
        kind: "tool-summary",
        turn_id: "turn-1",
        tool_name: "Bash",
        tool_status: "completed",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "blank-assistant",
        kind: "agent-message",
        turn_id: "turn-1",
        content: "   \n  ",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "t2",
        kind: "tool-summary",
        turn_id: "turn-1",
        tool_name: "Read",
        tool_status: "completed",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "a1",
        kind: "agent-message",
        turn_id: "turn-1",
        content: "工作区干净，README 已读完。",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "u2",
        kind: "user-message",
        turn_id: "turn-2",
        content: "再看一下当前分支",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "t3",
        kind: "tool-summary",
        turn_id: "turn-2",
        tool_name: "Bash",
        tool_status: "completed",
        attachment_count: 0,
        truncated: false,
      },
      {
        id: "a2",
        kind: "agent-message",
        turn_id: "turn-2",
        content: "当前分支是 main。",
        attachment_count: 0,
        truncated: false,
      },
    ];

    const { container } = render(
      <SessionTranscript
        events={events}
        labels={labels}
        locale="zh-CN"
        earlierLabel="加载更早记录"
      />,
    );

    expect(container.querySelector('[data-event-id="blank-assistant"]')).toBeNull();
    const summaries = Array.from(container.querySelectorAll<HTMLElement>("[data-process-tools]"));
    expect(summaries.map((node) => node.textContent)).toEqual(["（Bash、Read）", "（Bash）"]);
    expect(screen.getByText("工作区干净，README 已读完。")).toBeVisible();
    expect(screen.getByText("当前分支是 main。")).toBeVisible();
  });
});
