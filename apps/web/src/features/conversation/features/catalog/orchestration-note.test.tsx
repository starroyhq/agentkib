// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationNote, orchestrationText } from "@agentkib/session-ui";

afterEach(cleanup);

describe("delegation line", () => {
  it.each([
    ["zh-CN", "项目 Agent · 委派已暂停", "Worker api · 委派自 发布计划"],
    ["zh-Hant", "專案 Agent · 委派已暫停", "Worker api · 委派自 发布计划"],
    ["en-US", "Project Agent · Delegation paused", "Worker api · Delegated by 发布计划"],
    ["ja-JP", "プロジェクト Agent · 委任を一時停止中", "ワーカー api · 委任元 发布计划"],
  ] as const)("names both roles in %s", (locale, lead, worker) => {
    expect(orchestrationText({ role: "lead", workers: 2, paused: true }, null, locale)).toBe(lead);
    expect(
      orchestrationText({ role: "worker", leadId: "l", name: "api" }, "发布计划", locale),
    ).toBe(worker);
  });

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
