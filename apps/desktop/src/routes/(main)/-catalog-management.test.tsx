// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { CatalogAsset } from "@/core/types";
import { Route } from "./catalog";

const doubles = vi.hoisted(() => ({
  search: {} as { assetSection?: string; catalogTarget?: string },
  navigate: vi.fn(),
  assets: [] as CatalogAsset[],
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => doubles.search,
  useNavigate: () => doubles.navigate,
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeCatalog: () => ({ data: doubles.assets, isPending: false }),
  useHomeWorkspaces: () => ({ data: [], isPending: false }),
  useHomeMemories: () => ({ data: [], isPending: false }),
}));
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => ({ confirm: vi.fn() }) }));
vi.mock("@/features/mcp/McpManagementPanel", () => ({
  MCP_ALL_SCOPES: "__all_scopes__",
  McpManagementPanel: () => <p>Synthetic MCP management panel</p>,
}));
vi.mock("@/core/api", () => ({
  api: {
    mcpInstallations: async () => [],
    mcpRuntimes: async () => [],
    runtime: async () => ({ mcp_network: { port: 47653 } }),
  },
}));

async function renderRoute() {
  const Component = Route.options.component!;
  if ("preload" in Component && typeof Component.preload === "function") await Component.preload();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  await screen.findByText("Synthetic MCP management panel");
}
describe("catalog network settings destination", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    doubles.assets = [];
    await initializeI18n("en-US");
  });
  afterEach(cleanup);
  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "omits unrelated scan counts from Skills and MCP navigation in %s",
    async (locale) => {
      await initializeI18n(locale);
      doubles.search = { assetSection: "mcp" };
      doubles.assets = ["skill", "skill", "connection", "instruction", "hook"].map(
        (kind, index) => ({
          id: `scan-${index}`,
          scope: "workspace",
          workspace_id: "one",
          kind,
          name: `scanned-${kind}-${index}`,
          path: `/workspaces/one/${index}`,
          summary: "",
          size: 1,
        }),
      );
      await renderRoute();
      const navigation = within(screen.getByRole("navigation", { name: tr("nav.assets") }));
      expect(navigation.getByRole("button", { name: tr("assets.skills") })).toHaveTextContent(
        new RegExp(`^${tr("assets.skills")}$`),
      );
      expect(navigation.getByRole("button", { name: "MCP" })).toHaveTextContent(/^MCP$/);
      expect(
        navigation.getByRole("button", { name: `${tr("assets.instructions")} 1` }),
      ).toBeVisible();
      expect(
        navigation.getByRole("button", { name: `${tr("assets.hooksProfiles")} 1` }),
      ).toBeVisible();
      const memories = navigation.getByRole("button", { name: `${tr("assets.memories")} 0` });
      expect(memories).toBeVisible();
      expect(within(memories).getByText("0")).toHaveClass("text-muted-foreground");
      expect(memories.querySelector('[data-slot="badge"]')).toBeNull();
    },
  );
  it.each([
    { assetSection: "mcp", catalogTarget: "mcp-network" },
    { catalogTarget: "mcp-network" },
  ])("opens the actual MCP network panel for %j", async (search) => {
    doubles.search = search;
    await renderRoute();
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: tr("mcp.port") })).toBeVisible();
    expect(document.getElementById("catalog-mcp-network")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(tr("assets.instructions")) }));
    const options = doubles.navigate.mock.lastCall?.[0];
    expect(options.to).toBe("/catalog");
    expect(options.search(search)).toMatchObject({
      assetSection: "instructions",
      catalogTarget: undefined,
    });
  });
  it("keeps advanced settings collapsed for ordinary MCP navigation", async () => {
    doubles.search = { assetSection: "mcp" };
    await renderRoute();
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("spinbutton", { name: tr("mcp.port") })).toBeNull();
  });
});
