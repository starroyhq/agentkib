// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { initializeI18n, tr } from "@/core/i18n";
import type { CatalogAsset } from "@/core/types";
import { GlobalSettings, type GlobalSettingsProps } from "@/features/settings/GlobalSettings";
import { AgentAssetsPanel } from "@/features/agents/AgentAssetsPanel";
import { AppNavigationProvider, type AppNavigationContextValue } from "./AppNavigationContext";

vi.mock("@/features/obsidian/ObsidianIntegration", () => ({ ObsidianSettingsCard: () => null }));
vi.mock("@/features/settings/RemoteGateways", () => ({ RemoteGatewaysSettings: () => null }));

const navigateGlobal = vi.fn();
const navigation = { app: { navigateGlobal } } as unknown as AppNavigationContextValue;
const noop = async () => undefined;
const settings: GlobalSettingsProps = {
  section: "integrations",
  workspaces: [],
  remoteGateways: [],
  scanRoots: [],
  excluded: [],
  activity: [],
  onAddRoot: noop,
  onRemoveRoot: noop,
  onRestore: noop,
  onCloseBehaviorChanged: noop,
  onLocaleChanged: vi.fn(),
  onSessionIndexCleared: vi.fn(),
  onOnboardingRestarted: noop,
  onRemoteGatewaysChanged: noop,
  onRefreshDiagnostics: noop,
};
const asset = (kind: string): CatalogAsset => ({
  id: kind,
  name: `Example ${kind}`,
  kind,
  scope: "agent-home",
  agent: "codex",
  path: `/agent/${kind}`,
  summary: "",
  size: 1,
});
function renderAssets({ loading = false, error = false, withNavigation = true } = {}) {
  const assets = [asset("skill"), asset("connection"), asset("instruction")];
  const panel = (
    <AgentAssetsPanel
      homeAssets={assets}
      visibleAssets={assets}
      assetKinds={[]}
      query=""
      kind="all"
      loading={loading}
      error={error}
      onQueryChange={vi.fn()}
      onKindChange={vi.fn()}
      onRetry={vi.fn()}
    />
  );
  return render(
    withNavigation ? (
      <AppNavigationProvider value={navigation}>{panel}</AppNavigationProvider>
    ) : (
      panel
    ),
  );
}

describe("management destinations", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await initializeI18n("en-US");
  });
  afterEach(cleanup);
  it.each(["en-US", "zh-CN", "zh-Hant", "ja-JP"] as const)(
    "links integrations to MCP network settings in %s",
    async (locale) => {
      await initializeI18n(locale);
      render(
        <AppNavigationProvider value={navigation}>
          <AppDialogProvider>
            <GlobalSettings {...settings} />
          </AppDialogProvider>
        </AppNavigationProvider>,
      );
      expect(screen.getByText(tr("settings.mcpLocation"))).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: tr("settings.manageMcp") }));
      expect(navigateGlobal).toHaveBeenCalledExactlyOnceWith("catalog", false, {
        assetSection: "mcp",
        catalogTarget: "mcp-network",
      });
      expect(tr("settings.section.discovery")).not.toBe(tr("skills.discover"));
      expect(screen.queryByRole("spinbutton")).toBeNull();
    },
  );
  it("offers the supported management pages for Agent assets", () => {
    renderAssets();
    fireEvent.click(screen.getByRole("button", { name: "Open skill library" }));
    expect(navigateGlobal).toHaveBeenLastCalledWith("catalog", false, {
      assetSection: "skills",
      skillSection: "library",
      catalogTarget: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open MCP management" }));
    expect(navigateGlobal).toHaveBeenLastCalledWith("catalog", false, {
      assetSection: "mcp",
      catalogTarget: undefined,
    });
    expect(screen.queryByRole("button", { name: /Example instruction/ })).toBeNull();
  });
  it.each([{ loading: true }, { error: true }, { withNavigation: false }])(
    "avoids unavailable management shortcuts for %j",
    (options) => {
      renderAssets(options);
      expect(screen.queryByRole("button", { name: /Open.*management/ })).toBeNull();
      expect(navigateGlobal).not.toHaveBeenCalled();
    },
  );
});
