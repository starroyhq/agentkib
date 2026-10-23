// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { api } from "@/core/api";
import type { McpManagedEntry } from "@agentkib/runtime-protocol";
import type { WorkspaceSummary } from "@/core/types";
import { McpManagementPanel } from "./McpManagementPanel";
vi.mock("@/core/api", () => ({
  api: { mcpManagementState: vi.fn(), saveMcpConfiguration: vi.fn(), probeMcpRuntime: vi.fn() },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));
vi.mock("./McpServiceEditor", () => ({
  newMcpDraft: () => ({ json: "{}", secrets: { env: {}, headers: {} } }),
  McpServiceEditor: ({ project }: { project?: string }) => <p>Target: {project ?? "global"}</p>,
}));
const workspace = {
  id: "one",
  name: "northstar-api",
  path: "/fixture/one",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
} satisfies WorkspaceSummary;
const entry = (scope: "global" | "workspace", inherited = false): McpManagedEntry => ({
  config: {
    id: "same",
    name: scope === "global" ? "Global service" : "Project service",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "fixture-server"],
    env: {},
    headers: {},
    targets: ["codex"],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
  },
  scope,
  inherited,
  required_env: [],
  required_headers: [],
  configured_env: [],
  configured_headers: [],
  oauth_configured: false,
});
function show(scope = "__all_scopes__", workspaces = [workspace]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    scope,
    project: scope && scope !== "__all_scopes__" ? scope : undefined,
    onScopeChange: vi.fn(),
    workspaces,
    drafts: new Map(),
    onChanged: vi.fn().mockResolvedValue(undefined),
  };
  const view = render(
    <QueryClientProvider client={client}>
      <McpManagementPanel {...props} />
    </QueryClientProvider>,
  );
  return { ...view, props };
}
beforeEach(async () => {
  await initializeI18n("en-US");
  vi.resetAllMocks();
  vi.mocked(api.probeMcpRuntime).mockResolvedValue([]);
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: project ? "project-revision" : "global-revision",
    servers: project ? [entry("workspace")] : [entry("global")],
  }));
  vi.mocked(api.saveMcpConfiguration).mockResolvedValue({ revision: "saved", servers: [] });
});
afterEach(cleanup);
it("shows owned services from every scope without inherited duplicates and writes the exact row scope", async () => {
  show();
  const global = await screen.findByText("Global service", { selector: "strong" });
  const project = await screen.findByText("Project service", { selector: "strong" });
  expect(screen.getAllByText("Global service", { selector: "strong" })).toHaveLength(1);
  fireEvent.click(within(global.closest("tr")!).getByRole("switch"));
  await waitFor(() =>
    expect(api.saveMcpConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ project: undefined, revision: "global-revision" }),
    ),
  );
  fireEvent.click(within(project.closest("tr")!).getByRole("switch"));
  await waitFor(() =>
    expect(api.saveMcpConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ project: workspace.path, revision: "project-revision" }),
    ),
  );
});
it("keeps the selected empty scope informative about services in another scope", async () => {
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: project ? "p" : "g",
    servers: project ? [entry("workspace")] : [],
  }));
  const { props } = show("");
  expect(
    await screen.findByText(tr("mcp.manage.scopeEmpty", { scope: tr("mcp.globalScope") })),
  ).toBeVisible();
  expect(
    await screen.findByText(
      tr("mcp.manage.otherScopeCount", {
        scope: tr("mcp.manage.projectScope", { name: workspace.name }),
        count: 1,
      }),
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.viewAllScopes") }));
  expect(props.onScopeChange).toHaveBeenCalledWith("__all_scopes__");
  expect(screen.getAllByRole("button", { name: tr("mcp.manage.add") })).toHaveLength(1);
});
it("requires an explicit target before creating a service from all scopes", async () => {
  show();
  await screen.findByText("Project service", { selector: "strong" });
  fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.add") }));
  expect(screen.queryByText(/^Target:/)).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
  await user.click(await screen.findByRole("option", { name: workspace.name }));
  expect(await screen.findByText("Target: " + workspace.path)).toBeVisible();
  expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
});
it("never treats a failed scope as an empty catalog", async () => {
  vi.mocked(api.mcpManagementState).mockRejectedValue(new Error("Synthetic unreadable scope"));
  show();
  expect(
    await screen.findByText(tr("mcp.manage.scopeReadFailed", { scope: tr("mcp.globalScope") })),
  ).toBeVisible();
  expect(screen.queryByText(tr("mcp.manage.catalogEmpty"))).toBeNull();
});

it("keeps successful project rows visible when another scope fails", async () => {
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => {
    if (!project) throw new Error("Synthetic global read failure");
    return { revision: "project-only", servers: [entry("workspace")] };
  });
  show();
  expect(await screen.findByText("Project service", { selector: "strong" })).toBeVisible();
  expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic global read failure");
  expect(screen.queryByText(tr("mcp.manage.catalogEmpty"))).toBeNull();
  fireEvent.click(screen.getByRole("switch"));
  await waitFor(() =>
    expect(api.saveMcpConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ project: workspace.path, revision: "project-only" }),
    ),
  );
});

it("keeps same-id batch operations separate and preserves per-scope revisions", async () => {
  show();
  await screen.findByText("Project service", { selector: "strong" });
  fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.selectVisible") }));
  fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.disableSelected") }));
  await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(2));
  expect(
    vi
      .mocked(api.saveMcpConfiguration)
      .mock.calls.map(([request]) => [
        request.project,
        request.revision,
        request.originalId,
        request.server.enabled,
      ]),
  ).toEqual([
    [undefined, "global-revision", "same", false],
    [workspace.path, "project-revision", "same", false],
  ]);
  expect(await screen.findByRole("status")).toHaveTextContent("Global service (same)");
  expect(screen.getByRole("status")).toHaveTextContent("Project service (same)");
});

it("keeps inherited entries read-only in a selected project and creates an explicit project override", async () => {
  const inherited = entry("global", true);
  inherited.config.id = "inherited-only";
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: "r",
    servers: project ? [inherited, entry("workspace")] : [entry("global")],
  }));
  show(workspace.path);
  const row = (await screen.findByText("Global service", { selector: "strong" })).closest("tr")!;
  expect(within(row).getByRole("switch")).toHaveAttribute("aria-disabled", "true");
  const user = userEvent.setup();
  await user.click(
    within(row).getByRole("button", {
      name: tr("mcp.manage.moreActions", { name: "Global service" }),
    }),
  );
  expect(
    await screen.findByRole("menuitem", { name: tr("mcp.manage.chooseAgents") }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(screen.queryByRole("menuitem", { name: tr("mcp.manage.removeOverride") })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.createOverride") }));
  expect(await screen.findByText("Target: " + workspace.path)).toBeVisible();
  expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
});

it("does not read or offer remote workspace paths as local scopes, including path collisions", async () => {
  const remote = {
    ...workspace,
    id: "remote",
    name: "Remote collision",
    remote: {
      host_id: "remote-host",
      host_name: "Fixture remote",
      original_id: "remote-source",
      online: true,
      last_synced_at: "2026-10-22",
    },
  };
  const anotherRemote = {
    ...remote,
    id: "remote-unique",
    name: "Remote only",
    path: "/remote/only",
  };
  show("__all_scopes__", [workspace, remote, anotherRemote]);
  await screen.findByText("Project service", { selector: "strong" });
  expect(api.mcpManagementState).toHaveBeenCalledTimes(2);
  expect(api.mcpManagementState).not.toHaveBeenCalledWith({ project: anotherRemote.path });
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
  expect(await screen.findByRole("option", { name: workspace.name })).toBeVisible();
  expect(screen.queryByRole("option", { name: remote.name })).toBeNull();
  expect(screen.queryByRole("option", { name: anotherRemote.name })).toBeNull();
});

it.each([false, true])(
  "handles a pending explicitly chosen destination without losing or reviving a cancelled editor (cancel=%s)",
  async (cancel) => {
    let resolve!: (value: { revision: string; servers: McpManagedEntry[] }) => void;
    const global = new Promise<{ revision: string; servers: McpManagedEntry[] }>((yes) => {
      resolve = yes;
    });
    vi.mocked(api.mcpManagementState).mockImplementation(({ project }) =>
      project ? Promise.resolve({ revision: "p", servers: [entry("workspace")] }) : global,
    );
    show();
    await screen.findByText("Project service", { selector: "strong" });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.add") }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(screen.queryByText(/^Target:/)).toBeNull();
    if (cancel) fireEvent.click(screen.getByRole("button", { name: tr("common.cancel") }));
    await act(async () => resolve({ revision: "ready-global", servers: [] }));
    if (cancel) expect(screen.queryByText(/^Target:/)).toBeNull();
    else expect(await screen.findByText("Target: global")).toBeVisible();
    expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
  },
);

it("filters legacy all-Agent targets without changing configuration and restores the full list", async () => {
  const global = entry("global");
  global.config.targets = [];
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: "r",
    servers: project ? [entry("workspace")] : [global],
  }));
  show();
  await screen.findByText("Project service", { selector: "strong" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.agentFilter") }));
  await user.click(await screen.findByRole("option", { name: "Claude Code" }));
  expect(screen.getByText("Global service", { selector: "strong" })).toBeVisible();
  expect(screen.queryByText("Project service", { selector: "strong" })).toBeNull();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.agentFilter") }));
  await user.click(await screen.findByRole("option", { name: tr("mcp.manage.allAgents") }));
  expect(screen.getByText("Project service", { selector: "strong" })).toBeVisible();
  expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
});

it.each([
  ["zh-CN", "全部作用域", "全部 Agent", "已启用于", "选择 Agent…"],
  ["zh-TW", "全部作用域", "全部 Agent", "已啟用於", "選擇 Agent…"],
  ["en-US", "All scopes", "All Agents", "Enabled for", "Choose Agents…"],
  ["ja-JP", "すべてのスコープ", "すべての Agent", "有効な Agent", "Agent を選択…"],
] as const)(
  "renders the library and per-Agent controls in %s and restores keyboard focus",
  async (locale, allScopes, allAgents, enabledFor, chooseAgents) => {
    await initializeI18n(locale);
    show();
    const row = (await screen.findByText("Project service", { selector: "strong" })).closest("tr")!;
    expect(screen.getByRole("combobox", { name: tr("mcp.scope") })).toHaveTextContent(allScopes);
    expect(screen.getByRole("combobox", { name: tr("mcp.manage.agentFilter") })).toHaveTextContent(
      allAgents,
    );
    expect(within(row).getByText(enabledFor)).toBeVisible();
    const user = userEvent.setup();
    const more = within(row).getByRole("button", {
      name: tr("mcp.manage.moreActions", { name: "Project service" }),
    });
    await user.click(more);
    await user.click(await screen.findByRole("menuitem", { name: chooseAgents }));
    const dialog = await screen.findByRole("dialog", {
      name: `${tr("mcp.manage.chooseAgentsTitle")} · Project service`,
    });
    expect(within(dialog).getByRole("checkbox", { name: "Project service Codex" })).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: "Project service Claude Code" }),
    ).not.toBeChecked();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(more).toHaveFocus());
    expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
  },
);

it("does not repeat inherited global services from project snapshots in the all-scope list", async () => {
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: "r",
    servers: [entry("global", Boolean(project))],
  }));
  show();
  expect(await screen.findByText("Global service", { selector: "strong" })).toBeVisible();
  expect(screen.getAllByText("Global service", { selector: "strong" })).toHaveLength(1);
  expect(screen.getAllByRole("row")).toHaveLength(2);
});

it.each([
  ["zh-CN", "项目 northstar-api 里有 1 个服务"],
  ["zh-TW", "專案 northstar-api 裡有 1 個服務"],
] as const)("separates a Latin scope name from its Chinese suffix in %s", async (locale, text) => {
  await initializeI18n(locale);
  vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => ({
    revision: "r",
    servers: project ? [entry("workspace")] : [],
  }));
  show("");
  expect(await screen.findByText(text)).toBeVisible();
});
