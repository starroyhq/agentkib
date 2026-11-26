// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationNote, orchestrationText } from "@agentkib/session-ui";

afterEach(cleanup);

describe("delegation line", () => {
  it.each([
    ["zh-CN", "项目 Agent · 已暂停", "Worker api · 委派自 发布计划"],
    ["zh-Hant", "專案 Agent · 已暫停", "Worker api · 委派自 发布计划"],
    ["en-US", "Project Agent · Paused", "Worker api · Delegated by 发布计划"],
    ["ja-JP", "プロジェクト Agent · 一時停止中", "ワーカー api · 委任元 发布计划"],
  ] as const)("names both roles in %s", (locale, lead, worker) => {
    expect(orchestrationText({ role: "lead", workers: 2, paused: true }, null, locale)).toBe(lead);
    expect(
      orchestrationText({ role: "worker", leadId: "l", name: "api" }, "发布计划", locale),
    ).toBe(worker);
  });

  it.each(["usage-limit", "report-undelivered"])(
    "shows only the Project Agent role during automatic %s recovery",
    (reason) => {
      render(
        <OrchestrationNote
          orchestration={{ role: "lead", workers: 2, paused: true, recovering: true, reason }}
          leadTitle={null}
          locale="zh-CN"
        />,
      );
      expect(screen.getByText("项目 Agent")).toBeVisible();
      expect(screen.queryByText(/正在恢复委派/)).not.toBeInTheDocument();
      expect(screen.queryByText(/已暂停/)).not.toBeInTheDocument();
    },
  );

  it("says only Project Agent while delegation runs, and for a Worker whose lead is not listed", () => {
    expect(orchestrationText({ role: "lead", workers: 0, paused: false }, null, "zh-CN")).toBe(
      "项目 Agent",
    );
    render(
      <OrchestrationNote
        orchestration={{ role: "worker", leadId: "gone", name: "api" }}
        leadTitle={null}
        locale="zh-CN"
      />,
    );
    expect(screen.getByText("Worker api · 委派自 项目 Agent")).toBeVisible();
  });
});
