// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AgentsPage } from "./AgentsPage";
import type { ComponentProps } from "react";
import type { AgentKind, WorkspaceSummary } from "@/core/types";
import { useAgentViewStore } from "./agent-view-store";

vi.mock("@/lib/usePathDisplay", () => ({
  usePathDisplay: () => (path: string) => path.replace(/^\/fixture\/home(?=\/|$)/, "~"),
}));
const workspace = (agent: AgentKind, id = agent): WorkspaceSummary => ({
  id,
  name: `${id} project`,
  path: `/fixture/home/${id}`,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [{ agent, evidence: "session-cwd", session_count: 1 }],
});
const props = (): ComponentProps<typeof AgentsPage> => ({
  installations: [
    { agent: "codex", installed: true, configured: true, warnings: [] },
    { agent: "claude-code", installed: true, configured: true, warnings: [] },
  ],
  assets: [],
  workspaces: [],
  remoteGateways: [],
  filter: "all",
  onSelectedAgentChange: vi.fn(),
  onOpen: vi.fn().mockResolvedValue(undefined),
});

describe("AgentsPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => useAgentViewStore.setState({ query: "", sort: "status", sections: {} }));
  afterEach(async () => {
    cleanup();
    await changeLocale("en-US");
  });

  it("renders OpenCode without unsupported usage UI", () => {
    render(
      <AgentsPage
        installations={[
          {
            agent: "opencode",
            installed: true,
            configured: true,
            warnings: [],
          },
        ]}
        assets={[]}
        workspaces={[]}
        remoteGateways={[]}
        onOpen={vi.fn().mockResolvedValue(undefined)}
        filter="all"
        selectedAgent="opencode"
        onSelectedAgentChange={vi.fn()}
      />,
    );

    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(0);
    expect(screen.queryByRole("tab", { name: "Usage" })).toBeNull();
  });
  it("selects the first Agent with data only after initial sources settle", () => {
    const base = { ...props(), workspaces: [workspace("claude-code")] };
    const view = render(<AgentsPage {...base} loading={{ assets: true }} />);
    expect(screen.getByRole("heading", { name: /^Codex / })).toBeTruthy();
    view.rerender(<AgentsPage {...base} loading={{ assets: false }} />);
    expect(screen.getByRole("heading", { name: /^Claude Code / })).toBeTruthy();
    expect(base.onSelectedAgentChange).not.toHaveBeenCalled();
    expect(screen.getByText("claude-code project")).toBeTruthy();
  });

  it("chooses the first Agent with data after a failed initial source succeeds on retry", () => {
    const base = props();
    const view = render(<AgentsPage {...base} errors={{ workspaces: true }} />);
    view.rerender(
      <AgentsPage
        {...base}
        workspaces={[workspace("claude-code")]}
        errors={{ workspaces: false }}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Claude Code / })).toBeTruthy();
    expect(base.onSelectedAgentChange).not.toHaveBeenCalled();
  });

  it("keeps a deliberate selection when a failed source succeeds on retry", () => {
    const base = props();
    const view = render(<AgentsPage {...base} errors={{ workspaces: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Codex / }));
    view.rerender(
      <AgentsPage
        {...base}
        workspaces={[workspace("claude-code")]}
        errors={{ workspaces: false }}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Codex / })).toBeTruthy();
    expect(base.onSelectedAgentChange).toHaveBeenCalledExactlyOnceWith("codex");
  });

  it("keeps an explicit selection even when another Agent has data", () => {
    render(
      <AgentsPage {...props()} selectedAgent="codex" workspaces={[workspace("claude-code")]} />,
    );
    expect(screen.getByRole("heading", { name: /^Codex / })).toBeTruthy();
    expect(screen.queryByText("claude-code project")).toBeNull();
  });

  it("does not override a deliberate selection when pending data arrives", () => {
    const base = props();
    const view = render(<AgentsPage {...base} loading={{ workspaces: true }} />);
    fireEvent.click(screen.getByRole("button", { name: /^Codex / }));
    view.rerender(
      <AgentsPage
        {...base}
        workspaces={[workspace("claude-code")]}
        loading={{ workspaces: false }}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Codex / })).toBeTruthy();
    expect(base.onSelectedAgentChange).toHaveBeenCalledExactlyOnceWith("codex");
  });

  it("uses global configurations as data and retains the selected asset filters", () => {
    render(
      <AgentsPage
        {...props()}
        assets={[
          {
            id: "instruction",
            agent: "claude-code",
            scope: "agent-home",
            kind: "instruction",
            name: "Guide",
            path: "/fixture/home/.claude/CLAUDE.md",
            summary: "",
            size: 1,
          },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Claude Code / })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: tr("agents.section.assets") }));
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(screen.getByTitle("/fixture/home/.claude/CLAUDE.md").textContent).toBe(
      "~/.claude/CLAUDE.md",
    );
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders grouped agents and actionable empty data in %s",
    async (locale) => {
      await act(() => changeLocale(locale));
      const { container } = render(<AgentsPage {...props()} selectedAgent="codex" />);
      expect(screen.getByRole("complementary", { name: tr("nav.agents") })).toBeTruthy();
      expect(screen.getByRole("heading", { name: tr("agents.group.installed") })).toBeTruthy();
      expect(screen.getByRole("heading", { name: tr("agents.group.uninstalled") })).toBeTruthy();
      expect(screen.getByText(tr("agents.workspaceNextStep", { agent: "Codex" }))).toBeTruthy();
      expect(screen.getAllByText(tr("agents.noWorkspacesYet"))).toHaveLength(2);
      expect(screen.queryByText(tr("agents.homeAssetTypes"))).toBeNull();
      expect(screen.queryByText(tr("agents.provider"))).toBeNull();
      expect(screen.queryAllByText(tr("agents.continuationCapability"))).toHaveLength(
        tr("agents.continuationCapability") === tr("agents.capability.continuation") ? 1 : 0,
      );
      expect(container.textContent).not.toMatch(/\b0\b/);
      const capabilities = screen.getByRole("region", { name: tr("agents.capabilities") });
      expect(within(capabilities).getAllByText(tr("agents.capability.unknown"))).toHaveLength(5);
    },
  );

  it("keeps runtime capabilities, one configuration path, version warnings and beta notices", () => {
    const base = props();
    render(
      <AgentsPage
        {...base}
        selectedAgent="deepseek-harness"
        installations={[
          {
            agent: "deepseek-harness",
            installed: true,
            configured: true,
            home: "/fixture/home/.deepseek",
            version: "0.1.0",
            warnings: ["DeepSeek Harness workspace storage version is not supported"],
            support: {
              workspace_discovery: true,
              session_list: true,
              history_read: true,
              continuation: false,
              control: "experimental",
            },
          },
        ]}
      />,
    );
    expect(screen.getByText(tr("agents.deepseekReadOnly"))).toBeTruthy();
    expect(screen.getByText(tr("errors.deepseekWorkspaceVersion"))).toBeTruthy();
    expect(screen.getAllByTitle("/fixture/home/.deepseek")).toHaveLength(1);
    expect(screen.getByText("~/.deepseek")).toBeTruthy();
    const capabilities = screen.getByRole("region", { name: tr("agents.capabilities") });
    expect(within(capabilities).getAllByText(tr("agents.capability.supported"))).toHaveLength(3);
    expect(within(capabilities).getByText(tr("agents.capability.unavailable"))).toBeTruthy();
    expect(
      within(capabilities).getByText(tr("agents.capability.control.experimental")),
    ).toBeTruthy();
  });

  it("does not turn source failures into empty cards or hide retry controls", () => {
    const onRetry = { assets: vi.fn(), workspaces: vi.fn(), gateways: vi.fn(), insights: vi.fn() };
    render(
      <AgentsPage
        {...props()}
        selectedAgent="codex"
        errors={{ assets: true, workspaces: true, gateways: true, insights: true }}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByText(tr("agents.workspaceNextStep", { agent: "Codex" }))).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(4);
    for (const button of screen.getAllByRole("button", { name: tr("runtime.retry") }))
      fireEvent.click(button);
    for (const retry of Object.values(onRetry)) expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps configured but uninstalled Agents discoverable with their local-data status", () => {
    render(
      <AgentsPage
        {...props()}
        filter="available"
        installations={[{ agent: "codex", installed: false, configured: true, warnings: [] }]}
      />,
    );
    expect(
      screen.getByRole("button", { name: new RegExp(`Codex.*${tr("agents.localDataFound")}`) }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Claude Code / })).toBeNull();
  });
  it("does not treat a healthy provider without imported usage as data", () => {
    render(
      <AgentsPage
        {...props()}
        workspaces={[workspace("claude-code")]}
        insightsStatus={{
          running: false,
          providers: [{ agent: "codex", available: true, imported_events: 0, quality: "exact" }],
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: /^Claude Code / })).toBeTruthy();
  });
  it("omits empty provider cards while preserving the explicit usage view's no-data explanation", () => {
    render(
      <AgentsPage
        {...props()}
        selectedAgent="codex"
        insightsStatus={{
          running: false,
          providers: [{ agent: "codex", available: true, imported_events: 0, quality: "exact" }],
        }}
      />,
    );
    expect(screen.queryByText(tr("agents.provider"))).toBeNull();
    expect(screen.queryByText(tr("insights.noData"))).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: tr("agents.section.usage") }));
    expect(screen.getByText(tr("insights.noData"))).toBeTruthy();
    expect(screen.queryByText(tr("agents.provider"))).toBeNull();
  });
});
