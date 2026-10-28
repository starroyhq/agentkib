// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { SessionTranscript } from "./session-transcript";

const props = {
  labels: {
    process: "Process",
    tools: "tools",
    failed: "failed",
    incomplete: "incomplete",
    details: "Details",
    attachments: "attachments",
    truncated: "truncated",
    unknownTool: "Tool",
  },
  locale: "en-US",
  earlierLabel: "Earlier",
  onTool: vi.fn(),
};

function event(
  id: string,
  kind: ConversationEvent["kind"] = "tool-summary",
  turnId = "turn",
): ConversationEvent {
  return {
    id,
    kind,
    turn_id: turnId,
    content: id,
    tool_name: id,
    tool_status: "completed",
    attachment_count: 0,
    truncated: false,
  };
}

afterEach(cleanup);

describe("production transcript identity", () => {
  it("keeps partial paged commentary expanded without an incomplete label", () => {
    const commentary: ConversationEvent = {
      ...event("commentary", "agent-message"),
      content: "Still working",
      message_phase: "commentary",
    };
    const tool = event("tool");
    const view = render(<SessionTranscript {...props} events={[commentary, tool]} incomplete />);
    expect(screen.getByText("Still working")).toBeVisible();
    expect(screen.queryByText(props.labels.incomplete)).not.toBeInTheDocument();
    const row = view.container.querySelector('[data-event-id="commentary"]');
    view.rerender(
      <SessionTranscript
        {...props}
        events={[event("older", "tool-summary", "earlier-turn"), commentary, tool]}
        incomplete
      />,
    );
    expect(view.container.querySelector('[data-event-id="commentary"]')).toBe(row);
    expect(screen.getByText("Still working")).toBeVisible();
    expect(screen.queryByText(props.labels.incomplete)).not.toBeInTheDocument();
  });

  it.each([
    ["zh-CN", "执行中", "已完成"],
    ["zh-TW", "執行中", "已完成"],
    ["en-US", "Running", "Completed"],
    ["ja-JP", "実行中", "完了"],
  ])(
    "localizes a native inProgress tool in %s and completes the same row",
    (locale, running, completed) => {
      const tool: ConversationEvent = {
        ...event("active-tool"),
        turn_id: undefined,
        tool_name: "shell",
        tool_status: "inProgress",
      };
      const view = render(<SessionTranscript {...props} events={[tool]} locale={locale} />);
      fireEvent.click(screen.getByRole("button", { name: /Process/ }));
      const row = view.container.querySelector('[data-event-id="active-tool"]');
      expect(screen.getByRole("button", { name: `shell ${running}` })).toBeVisible();
      view.rerender(
        <SessionTranscript
          {...props}
          events={[{ ...tool, tool_status: "completed" }]}
          locale={locale}
        />,
      );
      expect(screen.getByRole("button", { name: `shell ${completed}` })).toBeVisible();
      expect(view.container.querySelector('[data-event-id="active-tool"]')).toBe(row);
    },
  );

  it("keeps an expanded process and existing rows mounted when another item arrives", () => {
    const tool = { ...event("first"), tool_status: undefined };
    const view = render(<SessionTranscript {...props} events={[tool]} />);
    const toggle = screen.getByRole("button", { name: /Process/ });
    fireEvent.click(toggle);
    const firstRow = view.container.querySelector('[data-event-id="first"]');
    view.rerender(
      <SessionTranscript
        {...props}
        events={[tool, { ...tool, id: "second", content: "second" }]}
      />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector('[data-event-id="first"]')).toBe(firstRow);
    expect(view.container.querySelector('[data-event-id="second"]')).toBeVisible();
  });

  it("keeps Markdown images, raw HTML and unsafe links inert", () => {
    const message = {
      ...event("markdown", "agent-message"),
      content: [
        "<script>window.evil = true</script>",
        '<img src="https://example.test/pixel" onerror="alert(1)">',
        "![tracking](https://example.test/tracking)",
        "[unsafe](javascript:alert(1))",
        "[local](file:///private/document)",
        "[relative](/private/document)",
        "[secure](https://example.test/secure)",
        "[plain](http://example.test/plain)",
      ].join("\n\n"),
    };
    const view = render(<SessionTranscript {...props} events={[message]} />);
    expect(view.container.querySelector("img, script")).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.test/secure",
      "http://example.test/plain",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    }
  });

  it("shows text Claude Code wrote itself with its line breaks and placeholders", () => {
    // CLI 2.1.311's reply to a bare /model, run offline against a local API stub; shortened.
    const content =
      "Current model: `Haiku 5.5`\nUsage: /model <name>. Available: sonnet, opus, or a full model ID.";
    const view = render(
      <SessionTranscript
        {...props}
        events={[
          { ...event("output", "agent-message", "turn-1"), content, cli_output: true },
          { ...event("reply", "agent-message", "turn-2"), content },
        ]}
      />,
    );
    const output = view.container.querySelector('[data-event-id="output"]')!;
    expect(output.querySelectorAll("br")).toHaveLength(1);
    expect(output).toHaveTextContent("Usage: /model <name>. Available:");
    expect(output.querySelector("code")).toHaveTextContent("Haiku 5.5");
    // A model's reply is Markdown as before.
    const reply = view.container.querySelector('[data-event-id="reply"]')!;
    expect(reply.querySelectorAll("br")).toHaveLength(0);
    expect(reply).not.toHaveTextContent("<name>");
  });

  it("keeps a text row and its focused link when earlier text is prepended", () => {
    const current = {
      ...event("current", "agent-message"),
      content: "[Current link](https://example.test/current)",
    };
    const view = render(<SessionTranscript {...props} events={[current]} />, {
      wrapper: StrictMode,
    });
    const row = view.container.querySelector('[data-event-id="current"]');
    const link = screen.getByRole("link", { name: "Current link" });
    link.focus();
    view.rerender(
      <SessionTranscript {...props} events={[event("earlier", "agent-message"), current]} />,
    );
    expect(view.container.querySelector('[data-event-id="current"]')).toBe(row);
    expect(screen.getByRole("link", { name: "Current link" })).toBe(link);
    expect(document.activeElement).toBe(link);
  });

  it("keeps expanded processes, focus and rows through same-turn prepends and live appends", () => {
    const first = event("first");
    const second = event("second");
    const earlier = event("earlier");
    const view = render(<SessionTranscript {...props} events={[first, second]} />, {
      wrapper: StrictMode,
    });
    const toggle = screen.getByRole("button", { name: /Process/ });
    fireEvent.click(toggle);
    toggle.focus();
    const row = view.container.querySelector('[data-event-id="first"]');
    const secondRow = view.container.querySelector('[data-event-id="second"]');
    expect(row).toBeVisible();
    expect(secondRow).toBeVisible();

    view.rerender(<SessionTranscript {...props} events={[earlier, first, second]} />);
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(view.container.querySelector('[data-event-id="first"]')).toBe(row);
    expect(view.container.querySelector('[data-event-id="second"]')).toBe(secondRow);
    const earlierRow = view.container.querySelector('[data-event-id="earlier"]');
    expect(earlierRow).toBeVisible();

    view.rerender(
      <SessionTranscript {...props} events={[earlier, first, second, event("later")]} />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(toggle);
    expect(view.container.querySelector('[data-event-id="first"]')).toBe(row);
    expect(view.container.querySelector('[data-event-id="second"]')).toBe(secondRow);
    expect(view.container.querySelector('[data-event-id="earlier"]')).toBe(earlierRow);
    expect(view.container.querySelector('[data-event-id="later"]')).toBeVisible();
  });

  it("keeps a failed process manually collapsed when earlier tools load", () => {
    const failed = { ...event("failed"), tool_status: "failed" };
    const view = render(<SessionTranscript {...props} events={[failed]} />);
    const toggle = screen.getByRole("button", { name: /Process/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    view.rerender(<SessionTranscript {...props} events={[event("earlier"), failed]} />);
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector('[data-event-id="failed"]')).toBeNull();
  });

  it.each(["agent-message", "user-message"] as const)(
    "keeps independent processes across repeated turn IDs and an %s boundary",
    (boundaryKind) => {
      const first = event("first");
      const separator = event("separator", "agent-message");
      const second = event("second");
      const boundary = event("boundary", boundaryKind, "another-turn");
      const repeated = event("repeated");
      const events = [first, separator, second, boundary, repeated];
      const view = render(<SessionTranscript {...props} events={events} />);
      const [firstToggle, secondToggle, repeatedToggle] = screen.getAllByRole("button", {
        name: /Process/,
      });
      fireEvent.click(firstToggle);
      const row = view.container.querySelector('[data-event-id="first"]');
      expect(row).toBeVisible();
      view.rerender(
        <SessionTranscript
          {...props}
          events={[event("older-turn", "tool-summary", "older-turn"), event("earlier"), ...events]}
        />,
      );
      const toggles = screen.getAllByRole("button", { name: /Process/ });
      expect(toggles).toHaveLength(4);
      expect(toggles[1]).toBe(firstToggle);
      expect(toggles[2]).toBe(secondToggle);
      expect(toggles[3]).toBe(repeatedToggle);
      expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual([
        "false",
        "true",
        "false",
        "false",
      ]);
      expect(view.container.querySelector('[data-event-id="first"]')).toBe(row);
      fireEvent.click(secondToggle);
      expect(toggles.map((toggle) => toggle.getAttribute("aria-expanded"))).toEqual([
        "false",
        "true",
        "true",
        "false",
      ]);
      expect(view.container.querySelector('[data-event-id="second"]')).toBeVisible();
      expect(
        [...view.container.querySelectorAll("[data-event-id]")].map((node) =>
          node.getAttribute("data-event-id"),
        ),
      ).toEqual(["earlier", "first", "separator", "second", "boundary"]);
    },
  );

  it("keeps the assistant process when pagination adds the user at the start of its turn", () => {
    const tool = event("tool");
    const final = { ...event("answer", "agent-message"), message_phase: "final_answer" as const };
    const view = render(<SessionTranscript {...props} events={[tool, final]} />);
    const toggle = screen.getByRole("button", { name: /Process/ });
    fireEvent.click(toggle);
    const row = view.container.querySelector('[data-event-id="tool"]');
    view.rerender(
      <SessionTranscript {...props} events={[event("question", "user-message"), tool, final]} />,
    );
    expect(screen.getByRole("button", { name: /Process/ })).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelector('[data-event-id="tool"]')).toBe(row);
    expect(
      [...view.container.querySelectorAll("[data-message-role]")].map((node) =>
        node.getAttribute("data-message-role"),
      ),
    ).toEqual(["user", "assistant"]);
    expect(
      [...view.container.querySelectorAll("[data-event-id]")].map((node) =>
        node.getAttribute("data-event-id"),
      ),
    ).toEqual(["question", "tool", "answer"]);
  });

  it("shows typed tool rows inline, hides wrappers with recorded items and summarizes edits", () => {
    const question = event("question", "user-message");
    const wrapper: ConversationEvent = {
      ...event("wrapper"),
      tool_name: "exec",
      tool: { kind: "other", children: 2 },
    };
    const shell: ConversationEvent = {
      ...event("shell"),
      tool_name: "shell",
      tool_status: "failed",
      tool: {
        kind: "execute",
        title: "pnpm test",
        content: [{ type: "terminal", command: "pnpm test", output: "1 failed", exit_code: 1 }],
      },
    };
    const edit: ConversationEvent = {
      ...event("edit"),
      tool_name: "apply_patch",
      tool: {
        kind: "edit",
        title: "src/app.ts",
        content: [
          {
            type: "diff",
            path: "src/app.ts",
            change: "update",
            added: 2,
            removed: 1,
            preview: "+b",
          },
        ],
      },
    };
    const answer: ConversationEvent = {
      ...event("answer", "agent-message"),
      content: "Fixed.",
      message_phase: "final_answer",
      turn_meta: { duration_ms: 127_000, outcome: "completed" },
    };
    const view = render(
      <SessionTranscript {...props} events={[question, wrapper, shell, edit, answer]} />,
    );
    const process = screen.getByRole("button", { name: /^Worked 2m 7s 2 tools · 1 failed$/ });
    expect(process).toHaveAttribute("aria-expanded", "true");
    expect(view.container.querySelector('[data-event-id="wrapper"]')).toBeNull();
    const shellToggle = screen.getByRole("button", { name: /pnpm test/ });
    expect(shellToggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(shellToggle.getAttribute("aria-controls")!)).toHaveTextContent(
      "1 failed",
    );
    expect(screen.getByRole("heading", { name: /Edited 1 file/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Show diff: src\/app\.ts/ }));
    expect(screen.getAllByText("+b")[0]).toBeVisible();
    expect(props.onTool).not.toHaveBeenCalled();
  });

  it("associates each process toggle with its own body across transcript instances", () => {
    const sharedTool = event("shared-tool");
    render(
      <>
        <SessionTranscript {...props} events={[{ ...sharedTool, tool_name: "first-instance" }]} />
        <SessionTranscript {...props} events={[{ ...sharedTool, tool_name: "second-instance" }]} />
      </>,
    );
    const [firstToggle, secondToggle] = screen.getAllByRole("button", { name: /Process/ });
    fireEvent.click(firstToggle);
    fireEvent.click(secondToggle);

    const firstBody = document.getElementById(firstToggle.getAttribute("aria-controls")!);
    const secondBody = document.getElementById(secondToggle.getAttribute("aria-controls")!);
    expect(firstBody).toContainElement(
      screen.getByRole("button", { name: "first-instance Completed" }),
    );
    expect(secondBody).toContainElement(
      screen.getByRole("button", { name: "second-instance Completed" }),
    );
    expect(firstBody).not.toBe(secondBody);
  });
});
