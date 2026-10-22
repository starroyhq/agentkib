// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { homeKeys } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import type { InstalledSkill, SkillCandidate, WorkspaceSummary } from "@/core/types";
import { Route } from "./catalog";

const mocks = vi.hoisted(() => ({
  workspaces: vi.fn(),
  catalogAssets: vi.fn(),
  globalMemories: vi.fn(),
  installedSkills: vi.fn(),
  removedSkills: vi.fn(),
  skillCatalog: vi.fn(),
  skillInventory: vi.fn(),
  skillDeployments: vi.fn(),
  skillSyncState: vi.fn(),
  skillTargets: vi.fn(),
  mcpInstallations: vi.fn(),
  mcpRuntimes: vi.fn(),
  runtime: vi.fn(),
  mcpManagementState: vi.fn(),
  navigate: vi.fn(),
  search: { assetSection: "skills", skillSection: "library" },
}));
vi.mock("@/core/api", () => ({ api: mocks }));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

const workspace: WorkspaceSummary = {
  id: "one",
  name: "Recovered workspace",
  path: "/fixture/project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const skill: InstalledSkill = {
  name: "reviewer",
  display_name: "Independent Reviewer",
  description: "Review a local change",
  path: "/fixture/library/reviewer",
  size: 128,
  status: "current",
  can_rollback: false,
};
const candidate: SkillCandidate = {
  name: "Independent Discovery",
  description: "Find a new skill",
  source: {
    kind: "openai-curated",
    repository: "example/skills",
    ref: "main",
    path: "discovery",
    resolved_commit: "0123456789abcdef",
    tree_sha: "fixture-tree",
  },
};
const mcpState = {
  revision: "fixture-revision",
  servers: [
    {
      config: {
        id: "independent",
        name: "Independent MCP service",
        enabled: true,
        env: {},
        headers: {},
        targets: [],
        allow_tools: [],
        lan_allow_tools: [],
        supports_parallel_tool_calls: false,
        transport: "stdio",
        command: "fixture-mcp",
        args: [],
      },
      scope: "global",
      inherited: false,
      required_env: [],
      required_headers: [],
      configured_env: [],
      configured_headers: [],
      oauth_configured: false,
    },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function start(cachedWorkspaces?: WorkspaceSummary[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedWorkspaces) client.setQueryData(homeKeys.workspaces(), cachedWorkspaces);
  const Component = Route.options.component!;
  render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  return client;
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setWorkspaceDrafts({});
  useAppStore.getState().setRuntime(undefined);
  mocks.search = { assetSection: "skills", skillSection: "library" };
  mocks.workspaces.mockResolvedValue([]);
  mocks.catalogAssets.mockResolvedValue([]);
  mocks.globalMemories.mockResolvedValue([]);
  mocks.installedSkills.mockResolvedValue([skill]);
  mocks.removedSkills.mockResolvedValue([]);
  mocks.skillCatalog.mockResolvedValue({
    entries: [candidate],
    stale: false,
    cached_at: "2026-10-17",
  });
  mocks.skillInventory.mockResolvedValue({ observations: [], warnings: [] });
  mocks.skillDeployments.mockResolvedValue([]);
  mocks.skillSyncState.mockResolvedValue({
    library: [],
    deployments: [],
    observations: [],
    warnings: [],
  });
  mocks.skillTargets.mockResolvedValue([]);
  mocks.mcpInstallations.mockResolvedValue([]);
  mocks.mcpRuntimes.mockResolvedValue([]);
  mocks.runtime.mockResolvedValue(null);
  mocks.mcpManagementState.mockResolvedValue(mcpState);
});
afterEach(cleanup);

it.each(["pending", "failed"])(
  "keeps the real skill library usable while workspaces are %s",
  async (state) => {
    const pending = deferred<WorkspaceSummary[]>();
    if (state === "pending") mocks.workspaces.mockReturnValue(pending.promise);
    else mocks.workspaces.mockRejectedValue(new Error("Workspace list unavailable"));
    mocks.catalogAssets.mockRejectedValue(new Error("Catalog unavailable"));
    mocks.globalMemories.mockRejectedValue(new Error("Memories unavailable"));
    start();
    const card = (
      await screen.findByRole("heading", { name: skill.display_name })
    ).closest<HTMLElement>('[data-slot="card"]')!;
    expect(within(card).getByRole("button", { name: tr("skills.manager.deploy") })).toBeEnabled();
    expect(screen.queryByRole("status", { name: tr("loading.assets") })).not.toBeInTheDocument();
    if (state === "failed") {
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(tr("query.workspaces"));
      expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
      expect(alert).not.toHaveTextContent(tr("query.staleData"));
      expect(within(alert).getAllByRole("listitem")).toHaveLength(1);
    }
    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: tr("skills.manager.deploy") }));
    const scope = await screen.findByRole("combobox", { name: tr("skills.manager.scope") });
    expect(scope).toHaveTextContent(tr("skills.manager.personal"));
    await user.click(scope);
    expect(
      await screen.findByRole("option", { name: tr("skills.manager.personal") }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: workspace.name })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: tr("skills.manager.personal") }));
    await user.keyboard("{Escape}");
    if (state === "pending") await act(async () => pending.resolve([]));
  },
);

it.each(["pending", "failed"])(
  "keeps real skill discovery and search usable while workspaces are %s",
  async (state) => {
    mocks.search.skillSection = "discover";
    const pending = deferred<WorkspaceSummary[]>();
    if (state === "pending") mocks.workspaces.mockReturnValue(pending.promise);
    else mocks.workspaces.mockRejectedValue(new Error("Workspace list unavailable"));
    start();
    expect(await screen.findByRole("heading", { name: candidate.name })).toBeVisible();
    expect(mocks.skillCatalog).toHaveBeenCalledExactlyOnceWith(false);
    const search = screen.getByRole("textbox", { name: tr("skills.search") });
    fireEvent.change(search, { target: { value: "No match" } });
    expect(screen.queryByRole("heading", { name: candidate.name })).not.toBeInTheDocument();
    expect(screen.getByText(tr("skills.noResults"))).toBeVisible();
    if (state === "pending") await act(async () => pending.resolve([]));
  },
);

it.each(["pending", "failed"])(
  "keeps real global MCP management usable while workspaces are %s",
  async (state) => {
    mocks.search.assetSection = "mcp";
    const pending = deferred<WorkspaceSummary[]>();
    if (state === "pending") mocks.workspaces.mockReturnValue(pending.promise);
    else mocks.workspaces.mockRejectedValue(new Error("Workspace list unavailable"));
    start();
    expect(await screen.findByText("Independent MCP service")).toBeVisible();
    expect(mocks.mcpManagementState).toHaveBeenCalledExactlyOnceWith({ project: undefined });
    expect(screen.getByRole("button", { name: tr("mcp.manage.add") })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: tr("mcp.scope") })).toHaveTextContent(
      tr("mcp.manage.allScopes"),
    );
    const menuUser = userEvent.setup();
    await menuUser.click(screen.getByRole("button", { name: tr("mcp.manage.more") }));
    await menuUser.click(await screen.findByRole("menuitem", { name: tr("mcp.manage.connect") }));
    expect(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") })).toBeDisabled();
    if (state === "pending") {
      await act(async () => pending.resolve([workspace]));
      const user = userEvent.setup();
      await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
      expect(await screen.findByRole("option", { name: workspace.name })).toBeVisible();
      await user.keyboard("{Escape}");
    }
  },
);

it("preserves skill search and an open deployment dialog when workspace choices recover", async () => {
  mocks.workspaces.mockRejectedValue(new Error("Workspace list unavailable"));
  const client = start();
  await screen.findByRole("heading", { name: skill.display_name });
  const search = screen.getByRole("textbox", { name: tr("skills.manager.searchLibrary") });
  fireEvent.change(search, { target: { value: "Independent" } });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: tr("skills.manager.deploy") }));
  const scope = await screen.findByRole("combobox", { name: tr("skills.manager.scope") });
  mocks.workspaces.mockResolvedValue([workspace]);
  await act(async () => client.invalidateQueries({ queryKey: homeKeys.workspaces() }));
  expect(screen.getByRole("combobox", { name: tr("skills.manager.scope") })).toBe(scope);
  expect(search).toHaveValue("Independent");
  expect(mocks.installedSkills).toHaveBeenCalledOnce();
  await user.click(scope);
  expect(await screen.findByRole("option", { name: workspace.name })).toBeVisible();
  await user.click(screen.getByRole("option", { name: workspace.name }));
  await user.keyboard("{Escape}");
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "names an unavailable workspace query and restores MCP project choices after retry in %s",
  async (locale) => {
    await initializeI18n(locale);
    mocks.search.assetSection = "mcp";
    mocks.workspaces
      .mockRejectedValueOnce(new Error("Workspace list unavailable"))
      .mockResolvedValue([workspace]);
    start();
    expect(await screen.findByText("Independent MCP service")).toBeVisible();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(tr("query.workspaces"));
    expect(alert).toHaveTextContent(tr("query.initialUnavailable"));
    expect(alert).not.toHaveTextContent(tr("query.staleData"));
    fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(mocks.workspaces).toHaveBeenCalledTimes(2);
    expect(mocks.mcpManagementState).toHaveBeenCalledTimes(2);
    expect(mocks.mcpManagementState.mock.calls).toEqual([
      [{ project: undefined }],
      [{ project: workspace.path }],
    ]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: workspace.name }));
    await waitFor(() =>
      expect(mocks.mcpManagementState).toHaveBeenLastCalledWith({ project: workspace.path }),
    );
  },
);

it("retains the selected MCP project and accurately labels cached workspaces during a refresh failure", async () => {
  mocks.search.assetSection = "mcp";
  const client = start([workspace]);
  await screen.findByText("Independent MCP service");
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
  await user.click(await screen.findByRole("option", { name: workspace.name }));
  await waitFor(() =>
    expect(mocks.mcpManagementState).toHaveBeenLastCalledWith({ project: workspace.path }),
  );
  mocks.workspaces.mockRejectedValue(new Error("Refresh failed"));
  await act(async () => client.invalidateQueries({ queryKey: homeKeys.workspaces() }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.staleData"));
  expect(alert).not.toHaveTextContent(tr("query.initialUnavailable"));
  expect(screen.getByRole("combobox", { name: tr("mcp.scope") })).toHaveTextContent(workspace.name);
  expect(screen.getByText("Independent MCP service")).toBeVisible();
});
