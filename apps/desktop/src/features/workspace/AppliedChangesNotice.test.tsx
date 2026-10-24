// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, changeLocale } from "@/core/i18n";
import type { AppliedWorkspaceChanges } from "./workspace-store";
import { AppliedChangesNotice } from "./AppliedChangesNotice";
import { appliedChangeCopy } from "./applied-change-copy";

const result: AppliedWorkspaceChanges = {
  workspaceId: "example",
  project: "/sandbox/project",
  origin: "standard",
  changeSet: {
    id: "applied",
    project_root: "/sandbox/project",
    created_at: "",
    changes: [],
    requires_home_approval: false,
  },
  applied: ["/sandbox/project/AGENTS.md"],
  backupDir: "/sandbox/project/.agentkib/backups/example",
  diagnosis: {
    status: "complete",
    resolved: 1,
    issues: [
      {
        id: "import",
        code: "context.warning",
        severity: "warning",
        repairable: false,
        evidence: [
          {
            path: "/sandbox/project/CLAUDE.md",
            detail:
              "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
          },
        ],
      },
    ],
  },
};

describe("applied changes diagnosis", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders the real result and localized warning in %s",
    async (locale) => {
      await changeLocale(locale);
      const copy = appliedChangeCopy(locale);
      const onDoctor = vi.fn();
      const onDismiss = vi.fn();
      render(<AppliedChangesNotice result={result} onDismiss={onDismiss} onDoctor={onDoctor} />);
      expect(screen.getByText(copy.applied(1))).toBeVisible();
      expect(screen.getByText(copy.complete(1))).toBeVisible();
      expect(screen.getByText(copy.newIssues(1))).toBeVisible();
      expect(screen.getByRole("status")).not.toHaveTextContent("reads @AGENTS.md");
      expect(copy.applied(1)).not.toMatch(/[。.]$/);
      fireEvent.click(screen.getByRole("button", { name: copy.doctor }));
      expect(onDoctor).toHaveBeenCalledOnce();
      const close = screen.getAllByRole("button").at(-1)!;
      fireEvent.click(close);
      expect(onDismiss).toHaveBeenCalledOnce();
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "reports no new problems without inventing a zero-resolved claim in %s",
    async (locale) => {
      await changeLocale(locale);
      const copy = appliedChangeCopy(locale);
      render(
        <AppliedChangesNotice
          result={{
            ...result,
            diagnosis: { status: "complete", resolved: 0, remaining: 0, issues: [] },
          }}
          onDismiss={() => {}}
        />,
      );
      expect(screen.getByText(copy.noNewIssues)).toBeVisible();
      expect(screen.queryByText(copy.complete(0))).toBeNull();
      expect(screen.queryByText(copy.newIssues(0))).toBeNull();
    },
  );

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps unresolved original problems visible in %s",
    async (locale) => {
      await changeLocale(locale);
      const copy = appliedChangeCopy(locale);
      const onDoctor = vi.fn();
      render(
        <AppliedChangesNotice
          result={{
            ...result,
            diagnosis: { status: "complete", resolved: 0, remaining: 2, issues: [] },
          }}
          onDismiss={() => {}}
          onDoctor={onDoctor}
        />,
      );
      expect(screen.getByText(copy.remainingIssues(2))).toBeVisible();
      expect(screen.queryByText(copy.complete(0))).toBeNull();
      expect(screen.queryByText(copy.noNewIssues)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: copy.doctor }));
      expect(onDoctor).toHaveBeenCalledOnce();
    },
  );

  it("shows both genuinely resolved and still-present issues rather than presenting only the new findings", async () => {
    await changeLocale("en-US");
    const copy = appliedChangeCopy("en-US");
    render(
      <AppliedChangesNotice
        result={{ ...result, diagnosis: { ...result.diagnosis!, remaining: 2 } }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(copy.complete(1))).toBeVisible();
    expect(screen.getByText(copy.remainingIssues(2))).toBeVisible();
    expect(screen.getByText(copy.newIssues(1))).toBeVisible();
  });

  it.each(["checking", "failed"] as const)(
    "retains the applied result with only the %s diagnosis state",
    async (status) => {
      await changeLocale("en-US");
      const copy = appliedChangeCopy("en-US");
      render(
        <AppliedChangesNotice
          result={{ ...result, diagnosis: { status, issues: [] } }}
          onDismiss={() => {}}
        />,
      );
      expect(screen.getByText(copy.applied(1))).toBeVisible();
      expect(screen.getByText(copy[status])).toBeVisible();
      expect(screen.queryByText(copy.complete(0))).toBeNull();
    },
  );
});
