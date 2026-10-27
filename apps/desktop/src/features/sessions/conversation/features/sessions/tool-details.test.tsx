// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationToolDetail, ConversationTurnMeta } from "@agentkib/runtime-protocol";
import {
  ToolDetailBody,
  ToolDetailRow,
  TurnFileChanges,
  formatToolDuration,
  isHiddenWrapperTool,
  toolDetailCopy,
  type ToolDetailView,
  type ToolEventView,
} from "@agentkib/session-ui";

// The shared view types mirror the protocol structurally; keep them assignable.
const asView = (value: ConversationToolDetail): ToolDetailView => value;
const asTurn = (value: ConversationTurnMeta): ToolEventView["turn_meta"] => value;
void asView;
void asTurn;

afterEach(cleanup);

function row(tool: ToolDetailView, extra: Partial<ToolEventView> = {}) {
  return {
    id: "row",
    kind: "tool-summary",
    tool_name: "shell",
    tool_status: "completed",
    ...extra,
    tool,
  };
}

describe("tool detail row", () => {
  it("shows a failed command expanded with its exit code and output", () => {
    render(
      <ToolDetailRow
        locale="en-US"
        statusLabel="Failed"
        event={row(
          {
            kind: "execute",
            title: "pnpm test",
            content: [
              {
                type: "terminal",
                command: "pnpm test",
                output: "1 failed",
                exit_code: 1,
                truncated: true,
              },
            ],
          },
          { tool_status: "failed", duration_ms: 2500 },
        )}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Hide details/ });
    expect(toggle).toHaveAccessibleName("Hide details: Run pnpm test, Failed, exit 1, 3s");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Run");
    expect(toggle).toHaveTextContent("pnpm test");
    expect(toggle).toHaveTextContent("Failed");
    expect(toggle).toHaveTextContent("exit 1");
    expect(toggle).toHaveTextContent("3s");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(body).toHaveTextContent("$ pnpm test");
    expect(body).toHaveTextContent("1 failed");
    expect(body).toHaveTextContent("Output truncated; showing the end");
    // The row summary already names the exit code.
    expect(body).not.toHaveTextContent("exit 1");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName(/^Show details: /);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();
  });

  it("renders diff previews as text with counts announced in words", () => {
    const { container } = render(
      <ToolDetailRow
        locale="en-US"
        statusLabel="Completed"
        event={row({
          kind: "edit",
          title: "src/app.ts",
          content: [
            {
              type: "diff",
              path: "src/app.ts",
              change: "update",
              added: 2,
              removed: 1,
              preview: "@@ -1 +1,2 @@\n-<script>old()</script>\n+new\n+<b>bold</b>",
            },
          ],
        })}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Show details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("2 lines added");
    expect(toggle).toHaveTextContent("1 line removed");
    expect(toggle).not.toHaveTextContent("Completed");
    fireEvent.click(toggle);
    expect(screen.getByText("-<script>old()</script>")).toBeVisible();
    expect(screen.getByText("+<b>bold</b>")).toBeVisible();
    expect(container.querySelector("script, b")).toBeNull();
  });

  it("uses the locale's punctuation in spoken names", () => {
    render(
      <ToolDetailRow
        locale="zh-CN"
        statusLabel="已完成"
        event={row({
          kind: "edit",
          title: "src/app.ts",
          content: [
            {
              type: "diff",
              path: "src/app.ts",
              change: "update",
              added: 2,
              removed: 1,
              preview: "+a",
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "展开详情：修改 src/app.ts，新增 2 行，删除 1 行",
    );
  });

  it("names the exit code when the body is shown on its own", () => {
    render(
      <ToolDetailBody
        locale="zh-CN"
        tool={{
          kind: "execute",
          content: [{ type: "terminal", command: "make", output: "error", exit_code: 2 }],
        }}
      />,
    );
    expect(screen.getByText("退出码 2")).toBeVisible();
  });

  it("does not offer an empty expansion for reads and searches", () => {
    render(
      <ToolDetailRow
        locale="zh-CN"
        statusLabel="已完成"
        event={row({ kind: "read", title: "README.md", locations: [{ path: "README.md" }] })}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("读取")).toBeVisible();
    expect(screen.getByText("README.md")).toBeVisible();
  });

  it("names MCP calls and sub-agent activity", () => {
    render(
      <>
        <ToolDetailRow
          locale="en-US"
          statusLabel="Completed"
          event={row({
            kind: "other",
            title: "docs · lookup",
            mcp: { server: "docs", tool: "lookup" },
          })}
        />
        <ToolDetailRow
          locale="en-US"
          statusLabel="Completed"
          event={{
            ...row({ kind: "other", agent: { action: "spawn", name: "reviewer" } }),
            id: "agent",
          }}
        />
      </>,
    );
    expect(screen.getByText("MCP")).toBeVisible();
    expect(screen.getByText("docs · lookup")).toBeVisible();
    expect(screen.getByText("Agent")).toBeVisible();
    expect(screen.getByText("start · reviewer")).toBeVisible();
  });
});

describe("turn file changes", () => {
  it("merges edits per file and opens each preview", () => {
    const edit = (id: string, path: string, added: number, removed: number, preview?: string) => ({
      id,
      kind: "tool-summary",
      tool_status: "completed",
      tool: {
        kind: "edit" as const,
        content: [
          {
            type: "diff" as const,
            path,
            change: "update" as const,
            added,
            removed,
            ...(preview ? { preview } : {}),
          },
        ],
      },
    });
    render(
      <TurnFileChanges
        locale="en-US"
        events={[
          edit("a", "src/a.ts", 2, 1, "+x"),
          edit("b", "src/b.ts", 1, 0),
          edit("c", "src/a.ts", 3, 0, "+y"),
          { ...edit("d", "src/c.ts", 9, 9, "+z"), tool_status: "failed" },
          { id: "m", kind: "agent-message" },
        ]}
      />,
    );
    const heading = screen.getByRole("heading", {
      name: "Edited 2 files, 6 lines added, 1 line removed",
    });
    const section = heading.closest("section")!;
    expect(section).not.toHaveTextContent("src/c.ts");
    const toggle = within(section).getByRole("button", {
      name: "Show diff: src/a.ts, 5 lines added, 1 line removed",
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("+x")).toBeVisible();
    expect(screen.getByText("+y")).toBeVisible();
    // A file without a preview is listed but not a button.
    expect(within(section).queryByRole("button", { name: /src\/b\.ts/ })).toBeNull();
    expect(within(section).getByText("src/b.ts")).toBeVisible();
  });

  it("renders nothing without file edits", () => {
    const { container } = render(
      <TurnFileChanges locale="en-US" events={[{ id: "x", kind: "tool-summary" }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("tool detail helpers", () => {
  it("formats turn durations in every locale", () => {
    expect(formatToolDuration(127_000, "zh-CN")).toBe("2 分 7 秒");
    expect(formatToolDuration(127_000, "zh-TW")).toBe("2 分 7 秒");
    expect(formatToolDuration(127_000, "en-US")).toBe("2m 7s");
    expect(formatToolDuration(127_000, "ja-JP")).toBe("2分7秒");
    expect(formatToolDuration(3_725_000, "en-US")).toBe("1h 2m");
    expect(formatToolDuration(120, "en-US")).toBe("1s");
  });

  it("hides wrappers that recorded items unless they failed", () => {
    const wrapper = {
      id: "w",
      kind: "tool-summary",
      tool_status: "completed",
      tool: { kind: "other" as const, children: 2 },
    };
    expect(isHiddenWrapperTool(wrapper)).toBe(true);
    expect(isHiddenWrapperTool({ ...wrapper, tool_status: "failed" })).toBe(false);
    expect(isHiddenWrapperTool({ ...wrapper, tool: { kind: "other" } })).toBe(false);
  });

  it("has the same copy keys in all four locales", () => {
    const keys = (locale: string) => {
      const copy = toolDetailCopy(locale);
      return [
        ...Object.keys(copy).sort(),
        ...Object.keys(copy.kinds).sort(),
        ...Object.keys(copy.agentActions).sort(),
      ];
    };
    for (const locale of ["zh-TW", "en-US", "ja-JP"]) expect(keys(locale)).toEqual(keys("zh-CN"));
  });
});
