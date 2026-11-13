// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import { AssetCatalogPage } from "./AssetCatalogPage";
import type { CatalogAssetGroup } from "./catalog";

const asset: CatalogAssetGroup = {
  id: "fixture",
  scope: "workspace",
  workspace_id: "workspace",
  kind: "instructions",
  name: "Fixture instructions",
  path: "/fixture/AGENTS.md",
  summary: "",
  size: 12,
  agents: ["codex", "claude-code", "cursor"],
  shared: false,
  records: [],
};
const copy = {
  "zh-CN": ["另外 1 个 Agent", "另外 2 个 Agent"],
  "zh-Hant": ["另外 1 個 Agent", "另外 2 個 Agent"],
  "ja-JP": ["ほか 1 個の Agent", "ほか 2 個の Agent"],
  "en-US": ["1 more Agent", "2 more Agents"],
} as const;

afterEach(cleanup);

describe("catalog additional Agent labels", () => {
  it.each(["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const)(
    "localizes the visible tooltip and accessible name in %s",
    async (locale) => {
      await initializeI18n(locale);
      const onOpen = vi.fn();
      const view = render(<AssetCatalogPage assets={[asset]} workspaces={[]} onOpen={onOpen} />);
      expect(screen.getByLabelText(copy[locale][0])).toHaveAttribute("title", copy[locale][0]);
      expect(screen.getByLabelText(copy[locale][0])).toHaveTextContent("+1");
      view.rerender(
        <AssetCatalogPage
          assets={[{ ...asset, agents: [...asset.agents, "opencode"] }]}
          workspaces={[]}
          onOpen={onOpen}
        />,
      );
      expect(screen.getByLabelText(copy[locale][1])).toHaveAttribute("title", copy[locale][1]);
      expect(screen.getByLabelText(copy[locale][1])).toHaveTextContent("+2");
      await act(async () => initializeI18n(locale === "en-US" ? "zh-Hant" : "en-US"));
      expect(
        screen.getByLabelText(locale === "en-US" ? copy["zh-Hant"][1] : copy["en-US"][1]),
      ).toHaveTextContent("+2");
      expect(onOpen).not.toHaveBeenCalled();
    },
  );
});
