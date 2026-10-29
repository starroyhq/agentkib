// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionWorktree } from "@agentkib/web-client";
import { worktreeChip } from "./worktree-copy";
import { WorktreeNote } from "./worktree-note";

const worktree: SessionWorktree = {
  repository_group_id: "repo",
  name: "h2",
  path: "/codex/worktrees/h2/atlas",
  branch: "codex/h2",
  status: "present",
};

afterEach(cleanup);

describe("worktree chip", () => {
  it.each([
    ["present", "zh-CN", "工作树 h2 · codex/h2"],
    ["deleted", "zh-CN", "工作树 h2 · 已删除"],
    ["unknown", "zh-CN", "工作树 h2 · 状态未知"],
    ["deleted", "zh-TW", "工作樹 h2 · 已刪除"],
    ["deleted", "en-US", "Worktree h2 · deleted"],
    ["unknown", "ja-JP", "ワークツリー h2 · 状態不明"],
  ] as const)("names a %s worktree in %s", (status, locale, text) => {
    expect(worktreeChip({ ...worktree, status }, locale)).toBe(text);
  });

  it("leaves out a missing branch", () => {
    expect(worktreeChip({ ...worktree, branch: null }, "zh-CN")).toBe("工作树 h2");
  });

  it("says the folder is gone in the chip itself, without a second notice", () => {
    render(<WorktreeNote worktree={{ ...worktree, status: "deleted" }} locale="zh-CN" />);
    expect(screen.getByText("工作树 h2 · 已删除")).toBeVisible();
    expect(
      screen.getByRole("img", { name: /工作树 h2 的文件夹已经不在了，会话记录仍可查看/ }),
    ).toBeVisible();
    expect(screen.queryByRole("note")).toBeNull();
  });
});
