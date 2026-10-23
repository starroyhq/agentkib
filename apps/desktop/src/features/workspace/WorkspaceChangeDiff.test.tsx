// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n } from "@/core/i18n";
import { WorkspaceChangeDiff } from "./WorkspaceChangeDiff";

beforeAll(() => initializeI18n("en-US"));
afterEach(cleanup);
const manifest = (checksum: string, instruction = "Keep checksums visible here") =>
  [
    "instructions:",
    "  shared: |",
    `    ${instruction}`,
    "adapters:",
    "  claude-code:",
    "    enabled: true",
    "    generated_hashes:",
    `      CLAUDE.md: ${checksum}`,
  ].join("\n");

describe("manifest diff checksums", () => {
  it("supports keyboard expansion and collapse without hiding actual instruction changes", async () => {
    await changeLocale("en-US");
    render(
      <WorkspaceChangeDiff
        before={manifest("a".repeat(64))}
        after={manifest("b".repeat(64), "Update CHANGELOG")}
        target="/sandbox/.agentkib/manifest.yaml"
      />,
    );
    const user = userEvent.setup();
    const toggle = screen.getByRole("button", {
      name: "Automatically generated checksums: 3 lines (collapsed)",
    });
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(new RegExp("b".repeat(64)))).toBeVisible();
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByText(new RegExp("b".repeat(64)))).toBeNull());
    expect(screen.getByText(/Update CHANGELOG/)).toBeVisible();
  });
  it.each([
    ["zh-CN", "自动生成的校验信息 3 行（已折叠）"],
    ["zh-TW", "自動產生的校驗資訊 3 行（已摺疊）"],
    ["en-US", "Automatically generated checksums: 3 lines (collapsed)"],
    ["ja-JP", "自動生成されたチェックサム 3 行（折りたたみ）"],
  ] as const)("keeps actual instructions and settings visible in %s", async (locale, label) => {
    await changeLocale(locale);
    render(
      <WorkspaceChangeDiff
        before={manifest("a".repeat(64))}
        after={manifest("b".repeat(64), "Update CHANGELOG")}
        target="/sandbox/.agentkib/manifest.yaml"
      />,
    );
    const toggle = screen.getByRole("button", { name: label });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText(/Update CHANGELOG/)).toBeVisible();
    expect(screen.getByText(/enabled: true/)).toBeVisible();
    expect(screen.queryByText(new RegExp("a".repeat(64)))).toBeNull();
    expect(screen.queryByText(new RegExp("b".repeat(64)))).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(new RegExp("a".repeat(64)))).toBeVisible();
    expect(screen.getByText(new RegExp("b".repeat(64)))).toBeVisible();
    const added = screen.getByText(/Update CHANGELOG/).closest("div")!;
    const same = screen.getByText(/enabled: true/).closest("div")!;
    expect(added.className).toContain("bg-emerald-50");
    expect(same.className).not.toContain("bg-emerald-50");
    expect(same.className).not.toContain("bg-red-50");
  });

  it("preserves old callers and never folds lookalike content in instruction files", () => {
    render(<WorkspaceChangeDiff before="" after={manifest("a".repeat(64))} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/CLAUDE.md:/)).toBeVisible();
  });
});
