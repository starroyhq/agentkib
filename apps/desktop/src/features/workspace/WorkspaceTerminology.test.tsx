// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ChangeSet } from "@/core/types";
import { Changes } from "@/routes/(main)/workspace/$workspaceId/changes";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => () => ({}),
}));

const plan: ChangeSet = {
  id: "unchanged-plan-id",
  project_root: "/workspace",
  created_at: "2026-10-16T00:00:00Z",
  requires_home_approval: false,
  changes: [
    {
      target: "/workspace/AGENTS.md",
      before: "Old instructions",
      after: "New instructions",
      scope: "project",
      risk: "low",
      validator: "markdown",
    },
  ],
};

describe("localized change plan explanation", () => {
  afterEach(cleanup);
  it.each([
    ["en-US", "Change plan", "Files are written only when you apply."],
    ["zh-CN", "变更计划", "点击应用后才会写入"],
    ["zh-TW", "變更計畫", "點擊套用後才會寫入"],
    ["ja-JP", "変更プラン", "適用するまでファイルは書き換えられません"],
  ] as const)(
    "explains the reviewed object in %s without changing file contents",
    async (locale, title, explanation) => {
      await initializeI18n(locale);
      render(
        <Changes
          changeSet={plan}
          origin="standard"
          onPlanHome={vi.fn()}
          onApplied={vi.fn()}
          onLaunchCompleted={vi.fn()}
          onRejected={vi.fn()}
          onApplyingChange={vi.fn()}
        />,
      );
      expect(screen.getByRole("heading", { name: title })).toHaveClass("sr-only");
      expect(screen.getByText(new RegExp(explanation))).toHaveClass("sr-only");
      expect(screen.queryByText("ChangeSet")).toBeNull();
      expect(screen.getByText("Old instructions")).toBeVisible();
      expect(screen.getByText("New instructions")).toBeVisible();
    },
  );
});
