// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCatalog } from "./session-catalog";
import { catalogCopy, catalogCopyForSurface } from "./catalog-copy";

afterEach(cleanup);

describe("desktop legacy catalog instructions", () => {
  it.each([
    ["zh-CN", "项目信息不可用，请更新这台电脑上的 AgentKib。"],
    ["zh-Hant", "專案資訊不可用，請更新這台電腦上的 AgentKib。"],
    ["en-US", "Project information unavailable. Update AgentKib on this computer."],
    [
      "ja-JP",
      "プロジェクト情報を取得できません。このコンピューター上の AgentKib を更新してください。",
    ],
  ] as const)("keeps the update instruction local in %s", (locale, notice) => {
    const onSelect = vi.fn();
    render(<SessionCatalog sessions={[]} selected="" onSelect={onSelect} locale={locale} />);
    expect(screen.getByRole("status")).toHaveTextContent(notice);
    expect(onSelect).not.toHaveBeenCalled();
    expect(catalogCopyForSurface(locale)).toBe(catalogCopy[locale]);
    expect(catalogCopyForSurface(locale, "web").missing).not.toBe(notice);
  });
});
