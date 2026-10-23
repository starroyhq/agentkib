// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagementState, McpManagedEntry } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  McpRuntimeStatus,
  McpServerConfig,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { McpHubPage } from "@/routes/(main)/catalog";
import {
  AppNavigationProvider,
  type AppNavigationContextValue,
} from "@/features/app/AppNavigationContext";

const dialogs = vi.hoisted(() => ({ confirm: vi.fn(), requestSecrets: vi.fn() }));

vi.mock("@/core/api", () => ({
  api: {
    mcpConnectionInfo: vi.fn(),
    searchMcpRegistry: vi.fn(),
    installMcp: vi.fn(),
    updateMcp: vi.fn(),
    uninstallMcp: vi.fn(),
    updateMcpNetwork: vi.fn(),
    verifyMcpConnection: vi.fn(),
    mcpServers: vi.fn(),
    mcpManagementState: vi.fn(),
    saveMcpConfiguration: vi.fn(),
    previewMcpImport: vi.fn(),
    applyMcpImport: vi.fn(),
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    getMcpPolicy: vi.fn(),
    saveMcpPolicy: vi.fn(),
    mcpInstallations: vi.fn(),
    mcpRuntimes: vi.fn(),
    restartMcpRuntime: vi.fn(),
    stopMcpRuntime: vi.fn(),
    runtime: vi.fn(),
    probeMcpRuntime: vi.fn(),
    saveMcpServer: vi.fn(),
    saveMcpLocalValues: vi.fn(),
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => dialogs,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => () => ({}),
  useNavigate: () => vi.fn(),
}));

const runtime: RuntimeInfo = {
  app_name: "AgentKib",
  app_version: "0.15.1",
  app_channel: "development",
  updates_enabled: false,
  data_dir: "/data",
  database_path: "/data/config.sqlite",
  mcp_package_root: "/data/mcp",
  mcp_network: { port: 47653, lan_enabled: false, lan_risk_accepted: false },
  mcp_hub: {
    running: true,
    bind_address: "127.0.0.1",
    port: 47653,
    lan_enabled: false,
    accessible_addresses: ["http://127.0.0.1:47653"],
    runtime_count: 0,
    error_count: 0,
  },
  locale_preference: "en-US",
  effective_locale: "en-US",
  theme_preference: "system",
  effective_theme: "light",
  accent_theme_preference: null,
  sidebar_width_preference: null,
  app_icon_preference: "white",
  tray_available: false,
  session_index_enabled: true,
  local_auto_refresh_enabled: false,
  quota_auto_refresh_enabled: false,
  quota_auto_refresh_prompt_seen: false,
  onboarding: {
    version: 1,
    acknowledged_version: 1,
    doctor_completed: false,
    repairable_count: 0,
    repair_applied: false,
  },
};
const workspaces: WorkspaceSummary[] = ["one", "two"].map((id) => ({
  id,
  name: `Workspace ${id}`,
  path: `/workspaces/${id}`,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
}));
const server = (name = "Blender"): McpServerConfig => ({
  id: "blender",
  name,
  enabled: true,
  env: {},
  headers: {},
  targets: [],
  allow_tools: [],
  lan_allow_tools: [],
  supports_parallel_tool_calls: false,
  transport: "stdio",
  command: "/bin/uvx",
  args: ["mcp-for-blender"],
});
const props = { runtime, workspaces, onRuntimeChanged: vi.fn(), onMigrationPlanned: vi.fn() };
const renderAllHub = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <McpHubPage {...props} />
    </QueryClientProvider>,
  );

// These regressions exercise operations in the explicitly selected global scope.
// The all-scope default is covered separately below.
const renderHub = async () => {
  const view = renderAllHub();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
  await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
  return view;
};

const entry = (name = "Blender"): McpManagedEntry => ({
  config: server(name),
  scope: "global",
  inherited: false,
  required_env: [],
  required_headers: [],
  configured_env: [],
  configured_headers: [],
  oauth_configured: false,
});
const state = (name = "Blender"): McpManagementState => ({
  revision: "r1",
  servers: [entry(name)],
});
const runtimeInstance = (name: string, project?: string | null): McpRuntimeStatus => ({
  server_id: "blender",
  server_name: name,
  config_hash: `hash-${name}`,
  project,
  state: "running",
});
const registryEntry = {
  name: "Registry fixture",
  description: "",
  version: "2",
  package_kind: "npm" as const,
  identifier: "fixture",
  required_env: ["API_KEY"],
  runtime_arguments: [],
  package_arguments: [],
};
const installation = {
  id: "fixture",
  name: "Installed fixture",
  package_kind: "npm" as const,
  identifier: "fixture",
  version: "1",
  status: "installed",
  installed_at: "2026-10-09",
  updated_at: "2026-10-09",
};
const installationResult = { server: server(), tools: [], installation };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const openAdvanced = () =>
  fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
const searchRegistry = async () => {
  fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
  await screen.findByRole("button", { name: tr("mcp.install") });
};

describe("McpHubPage management", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    dialogs.confirm.mockResolvedValue(true);
    dialogs.requestSecrets.mockResolvedValue({});
    await initializeI18n("en-US");
    vi.mocked(api.verifyMcpConnection).mockResolvedValue({
      url: "http://127.0.0.1/mcp",
      checked_at: "2026-10-09T00:00:00Z",
      builtin_tools: 0,
      external_tools: [],
    });
    vi.mocked(api.mcpInstallations).mockResolvedValue([]);
    vi.mocked(api.mcpRuntimes).mockResolvedValue([]);
    vi.mocked(api.runtime).mockResolvedValue(runtime);
    vi.mocked(api.mcpManagementState).mockResolvedValue(state());
    vi.mocked(api.saveMcpConfiguration).mockResolvedValue(state());
  });
  afterEach(cleanup);

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows the MCP page explanation and advanced summary before expansion in %s",
    async (locale) => {
      await initializeI18n(locale);
      renderAllHub();
      expect(
        screen.getByRole("heading", { name: tr("mcp.servicesTitle"), level: 1 }),
      ).toBeVisible();
      expect(screen.getByText(tr("mcp.hubExplanation"))).toBeVisible();
      const advanced = screen.getByRole("button", { name: tr("mcp.manage.advanced") });
      expect(advanced).toHaveTextContent(tr("mcp.manage.advancedSections"));
      expect(advanced).toHaveAttribute("aria-expanded", "false");
      expect(advanced).toHaveAttribute("aria-describedby");
      expect(advanced.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("spinbutton", { name: tr("mcp.port") })).toBeNull();
      await userEvent.setup().click(advanced);
      expect(advanced).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByText(tr("mcp.hubExplanation"))).toHaveLength(1);
      await userEvent.setup().click(advanced);
      expect(advanced).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText(tr("mcp.manage.advancedSections"))).toBeVisible();
    },
  );

  it("labels known runtime ownership in all scopes and never infers an unknown or removed scope", async () => {
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Global runtime", null),
      runtimeInstance("Project runtime", workspaces[0].path),
      runtimeInstance("Legacy runtime"),
      runtimeInstance("Removed scope runtime", "/removed/project"),
    ]);
    renderAllHub();
    await screen.findByText("Blender");
    openAdvanced();
    const row = (await screen.findByText("Project runtime")).closest("article")!;
    expect(
      within(row).getByText(tr("mcp.manage.projectScope", { name: workspaces[0].name })),
    ).toBeVisible();
    expect(screen.getByText("Global runtime")).toBeVisible();
    expect(screen.queryByText("Legacy runtime")).toBeNull();
    expect(screen.queryByText("Removed scope runtime")).toBeNull();
    await userEvent.setup().click(within(row).getByRole("button", { name: tr("mcp.restart") }));
    expect(api.restartMcpRuntime).toHaveBeenCalledExactlyOnceWith("blender", workspaces[0].path);
  });

  it("starts with all local scopes and requires an explicit registry destination", async () => {
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    dialogs.requestSecrets.mockResolvedValue({ API_KEY: "fixture-only" });
    vi.mocked(api.installMcp).mockResolvedValue(installationResult);
    renderAllHub();
    await screen.findByText("Blender");
    expect(screen.getByRole("combobox", { name: tr("mcp.scope") })).toHaveTextContent(
      tr("mcp.manage.allScopes"),
    );
    expect(screen.queryByRole("heading", { name: tr("mcp.scope") })).toBeNull();
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    openAdvanced();
    await searchRegistry();
    const install = screen.getByRole("button", { name: tr("mcp.install") });
    expect(install).toBeDisabled();
    fireEvent.click(install);
    expect(dialogs.confirm).not.toHaveBeenCalled();
    expect(api.installMcp).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
    await user.click(await screen.findByRole("option", { name: workspaces[0].name }));
    expect(install).toBeEnabled();
    await user.click(install);
    await waitFor(() =>
      expect(api.installMcp).toHaveBeenCalledExactlyOnceWith(registryEntry, workspaces[0].path),
    );
    expect(api.saveMcpLocalValues).toHaveBeenCalledExactlyOnceWith(
      "blender",
      { API_KEY: "fixture-only" },
      {},
      workspaces[0].path,
    );
    expect(api.updateMcpNetwork).not.toHaveBeenCalled();
  });

  it("cancels a registry installation when its explicit destination changes during secrets entry", async () => {
    const secrets = deferred<Record<string, string> | null>();
    dialogs.requestSecrets.mockReturnValueOnce(secrets.promise);
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    renderAllHub();
    await screen.findByText("Blender");
    openAdvanced();
    await searchRegistry();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    await user.click(screen.getByRole("button", { name: tr("mcp.install") }));
    await waitFor(() => expect(dialogs.requestSecrets).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
    await user.click(await screen.findByRole("option", { name: workspaces[1].name }));
    await act(async () => secrets.resolve({ API_KEY: "fixture-only" }));
    expect(api.installMcp).not.toHaveBeenCalled();
    expect(api.saveMcpLocalValues).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: tr("mcp.install") })).toBeEnabled();
  });

  it("keeps an all-scope editor draft bound to its selected destination and original revision", async () => {
    const user = userEvent.setup();
    renderAllHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.add") }));
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.targetScope") }));
    await user.click(await screen.findByRole("option", { name: workspaces[0].name }));
    const name = await screen.findByRole("textbox", { name: tr("mcp.manage.name") });
    fireEvent.change(name, { target: { value: "Project-scoped draft" } });
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    await screen.findByText("Blender");
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.manage.allScopes") }));
    expect(await screen.findByRole("textbox", { name: tr("mcp.manage.name") })).toHaveValue(
      "Project-scoped draft",
    );
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledOnce());
    expect(api.saveMcpConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        project: workspaces[0].path,
        revision: "r1",
        server: expect.objectContaining({ name: "Project-scoped draft", enabled: false }),
      }),
    );
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
  });
  it.each([
    ["zh-CN", "高级设置", "官方目录、运行实例与网络", "官方目录"],
    ["zh-TW", "進階設定", "官方目錄、執行實例與網路", "官方目錄"],
    [
      "en-US",
      "Advanced settings",
      "Official directory, runtimes and network",
      "Official directory",
    ],
    ["ja-JP", "詳細設定", "公式ディレクトリ・実行インスタンス・ネットワーク", "公式ディレクトリ"],
  ] as const)(
    "labels the advanced section and directory without starting a search in %s",
    async (locale, advanced, sections, directory) => {
      await initializeI18n(locale);
      await renderHub();
      const toggle = screen.getByRole("button", { name: advanced });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText(sections)).toBeVisible();
      fireEvent.click(toggle);
      expect(screen.getByText(sections)).toBeVisible();
      expect(screen.getByRole("heading", { name: directory })).toBeVisible();
      expect(api.searchMcpRegistry).not.toHaveBeenCalled();
    },
  );
  it("requires confirmation before stopping a service in every scope", async () => {
    const confirmation = deferred<boolean>();
    dialogs.confirm.mockReturnValueOnce(confirmation.promise).mockResolvedValueOnce(true);
    vi.mocked(api.mcpRuntimes).mockResolvedValue([runtimeInstance("Global runtime", null)]);
    vi.mocked(api.stopMcpRuntime).mockResolvedValue(undefined);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    const stop = await screen.findByRole("button", { name: tr("mcp.stopAllScopes") });
    fireEvent.click(stop);
    expect(dialogs.confirm).toHaveBeenCalledExactlyOnceWith({
      description: tr("mcp.stopAllScopesConfirm", { name: "Global runtime" }),
      tone: "warning",
    });
    expect(api.stopMcpRuntime).not.toHaveBeenCalled();
    expect(stop).toBeDisabled();
    await act(async () => confirmation.resolve(false));
    expect(api.stopMcpRuntime).not.toHaveBeenCalled();
    fireEvent.click(stop);
    await waitFor(() => expect(api.stopMcpRuntime).toHaveBeenCalledExactlyOnceWith("blender"));
  });

  it("labels installed-package removal as an uninstall with a destructive icon control", async () => {
    vi.mocked(api.mcpInstallations).mockResolvedValue([installation]);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    const uninstall = await screen.findByRole("button", {
      name: `${tr("mcp.uninstall")} ${installation.name}`,
    });
    expect(uninstall).toHaveAttribute("title", `${tr("mcp.uninstall")} ${installation.name}`);
    expect(uninstall).toHaveClass("bg-[var(--destructive-soft)]", "text-destructive-text");
    expect(screen.getByText(tr("mcp.checkUpdatesHint"))).toBeVisible();
    expect(api.searchMcpRegistry).not.toHaveBeenCalled();
  });
  it("validates ports before mutation and refreshes the same field from runtime props", async () => {
    const client = new QueryClient();
    const view = (port: number) => (
      <QueryClientProvider client={client}>
        <McpHubPage
          {...props}
          runtime={{ ...runtime, mcp_network: { ...runtime.mcp_network, port } }}
        />
      </QueryClientProvider>
    );
    const rendered = render(view(47653));
    await screen.findByText("Blender");
    openAdvanced();
    const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
    rendered.rerender(view(48000));
    expect(input).toHaveValue(48000);
    fireEvent.change(input, { target: { value: "65536" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent(tr("mcp.portInvalid"));
    expect(api.updateMcpNetwork).not.toHaveBeenCalled();
    rendered.rerender(view(49000));
    expect(input).toHaveValue(65536);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue(49000);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("acknowledges the saved runtime, caches it and preserves existing LAN consent", async () => {
    const initial = {
      ...runtime,
      mcp_network: { port: 47653, lan_enabled: true, lan_risk_accepted: true },
    };
    const saved = { ...initial, mcp_network: { ...initial.mcp_network, port: 49000 } };
    const client = new QueryClient();
    vi.mocked(api.runtime).mockResolvedValueOnce(initial).mockResolvedValueOnce(saved);
    const view = () => (
      <QueryClientProvider client={client}>
        <McpHubPage {...props} runtime={initial} />
      </QueryClientProvider>
    );
    const rendered = render(view());
    await screen.findByText("Blender");
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(initial));
    openAdvanced();
    const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(saved));
    expect(api.updateMcpNetwork).toHaveBeenCalledExactlyOnceWith({
      port: 49000,
      lan_enabled: true,
      lan_risk_accepted: true,
    });
    expect(client.getQueryData(["mcp", "runtime"])).toEqual(saved);
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.blur(input);
    expect(api.updateMcpNetwork).toHaveBeenCalledTimes(1);
    rendered.unmount();
    const background = deferred<RuntimeInfo>();
    vi.mocked(api.runtime).mockReturnValue(background.promise);
    props.onRuntimeChanged.mockClear();
    render(view());
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(saved));
    expect(props.onRuntimeChanged).not.toHaveBeenCalledWith(initial);
  });
  it.each(["write", "readback", "mismatch"] as const)(
    "keeps a typed port and reports an unconfirmed %s without automatic retries",
    async (failure) => {
      await renderHub();
      await screen.findByText("Blender");
      await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(runtime));
      if (failure === "write") {
        vi.mocked(api.updateMcpNetwork).mockRejectedValueOnce(new Error("Port is occupied"));
      } else if (failure === "readback") {
        vi.mocked(api.runtime).mockRejectedValueOnce(new Error("Runtime read failed"));
      }
      openAdvanced();
      const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
      fireEvent.change(input, { target: { value: "49000" } });
      fireEvent.blur(input);
      await waitFor(() => expect(input).toBeEnabled());
      expect(input).toHaveValue(49000);
      expect(input).toHaveAccessibleDescription(expect.stringContaining(tr("mcp.portUnconfirmed")));
      expect(screen.getByRole("alert")).toHaveTextContent(
        failure === "write"
          ? "Port is occupied"
          : failure === "readback"
            ? "Runtime read failed"
            : tr("mcp.portUnconfirmed"),
      );
      expect(api.updateMcpNetwork).toHaveBeenCalledTimes(1);
    },
  );
  it("retires a runtime read started before saving so its late response cannot revert the port", async () => {
    const older = deferred<RuntimeInfo>();
    const saved = { ...runtime, mcp_network: { ...runtime.mcp_network, port: 49000 } };
    vi.mocked(api.runtime).mockReturnValueOnce(older.promise).mockResolvedValueOnce(saved);
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <McpHubPage {...props} />
      </QueryClientProvider>,
    );
    await screen.findByText("Blender");
    openAdvanced();
    const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.blur(input);
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(saved));
    await act(async () => older.resolve(runtime));
    expect(client.getQueryData(["mcp", "runtime"])).toEqual(saved);
    expect(props.onRuntimeChanged).not.toHaveBeenCalledWith(runtime);
    expect(input).toHaveValue(49000);
  });
  it("retires a refresh started during saving before publishing the confirmed runtime", async () => {
    const writing = deferred<Awaited<ReturnType<typeof api.updateMcpNetwork>>>();
    const older = deferred<RuntimeInfo>();
    const saved = { ...runtime, mcp_network: { ...runtime.mcp_network, port: 49000 } };
    const client = new QueryClient();
    vi.mocked(api.updateMcpNetwork).mockReturnValue(writing.promise);
    render(
      <QueryClientProvider client={client}>
        <McpHubPage {...props} />
      </QueryClientProvider>,
    );
    await screen.findByText("Blender");
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(runtime));
    props.onRuntimeChanged.mockClear();
    openAdvanced();
    const input = screen.getByRole("spinbutton", { name: tr("mcp.port") });
    fireEvent.change(input, { target: { value: "49000" } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.updateMcpNetwork).toHaveBeenCalledTimes(1));
    vi.mocked(api.runtime).mockReturnValueOnce(older.promise).mockResolvedValueOnce(saved);
    let refresh!: Promise<void>;
    act(() => {
      refresh = client.invalidateQueries({ queryKey: ["mcp", "runtime"], exact: true });
    });
    await waitFor(() => expect(api.runtime).toHaveBeenCalledTimes(2));
    await act(async () => writing.resolve({ ...runtime.mcp_hub!, port: 49000 }));
    await waitFor(() => expect(props.onRuntimeChanged).toHaveBeenCalledWith(saved));
    await act(async () => {
      older.resolve(runtime);
      await refresh;
    });
    expect(client.getQueryData(["mcp", "runtime"])).toEqual(saved);
    expect(props.onRuntimeChanged).not.toHaveBeenCalledWith(runtime);
    expect(input).toHaveValue(49000);
  });
  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "distinguishes Registry prompts, pending searches and no matches in %s",
    async (locale) => {
      await initializeI18n(locale);
      const request = deferred<(typeof registryEntry)[]>();
      vi.mocked(api.searchMcpRegistry).mockReturnValueOnce(request.promise);
      await renderHub();
      await screen.findByText("Blender");
      openAdvanced();
      expect(screen.getByText(tr("mcp.registryEmpty"))).toBeVisible();
      expect(api.searchMcpRegistry).not.toHaveBeenCalled();
      fireEvent.change(screen.getByPlaceholderText(tr("mcp.searchPlaceholder")), {
        target: { value: "missing-service" },
      });
      fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
      expect(await screen.findByText(tr("mcp.registrySearching"))).toBeVisible();
      expect(screen.queryByText(tr("mcp.registryEmpty"))).not.toBeInTheDocument();
      expect(screen.queryByText(tr("mcp.registryNoResults"))).not.toBeInTheDocument();
      await act(async () => request.resolve([]));
      expect(await screen.findByText(tr("mcp.registryNoResults"))).toBeVisible();
      expect(screen.queryByText(tr("mcp.registrySearching"))).not.toBeInTheDocument();
      expect(api.searchMcpRegistry).toHaveBeenCalledExactlyOnceWith("missing-service");
      vi.mocked(api.searchMcpRegistry).mockResolvedValueOnce([registryEntry]);
      fireEvent.change(screen.getByPlaceholderText(tr("mcp.searchPlaceholder")), {
        target: { value: "fixture" },
      });
      await searchRegistry();
      expect(screen.getByText(registryEntry.name)).toBeVisible();
      expect(screen.queryByText(tr("mcp.registryNoResults"))).not.toBeInTheDocument();
    },
  );
  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "distinguishes Registry failure from no matches and permits retry in %s",
    async (locale) => {
      await initializeI18n(locale);
      vi.mocked(api.searchMcpRegistry)
        .mockRejectedValueOnce(new Error("Registry unavailable"))
        .mockResolvedValueOnce([]);
      await renderHub();
      await screen.findByText("Blender");
      openAdvanced();
      fireEvent.change(screen.getByPlaceholderText(tr("mcp.searchPlaceholder")), {
        target: { value: "fixture" },
      });
      fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(tr("mcp.registrySearchFailed"));
      expect(alert).toHaveTextContent("Registry unavailable");
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(screen.queryByText(tr("mcp.registryEmpty"))).not.toBeInTheDocument();
      expect(screen.queryByText(tr("mcp.registryNoResults"))).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
      expect(await screen.findByText(tr("mcp.registryNoResults"))).toBeVisible();
      expect(screen.queryByText(tr("mcp.registrySearchFailed"))).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(api.searchMcpRegistry).toHaveBeenCalledTimes(2);
    },
  );
  it("opens and focuses the existing network controls from the settings destination", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <McpHubPage {...props} focusNetworkSettings />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("spinbutton", { name: tr("mcp.port") })).toBeVisible();
    expect(document.getElementById("catalog-mcp-network")).toHaveFocus();
    expect(api.updateMcpNetwork).not.toHaveBeenCalled();
  });
  it("returns to the integration settings anchor through application navigation", async () => {
    const openSettings = vi.fn().mockReturnValue(true);
    const navigation = { app: { openSettings } } as unknown as AppNavigationContextValue;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AppNavigationProvider value={navigation}>
          <McpHubPage {...props} />
        </AppNavigationProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.more") }));
    await user.click(
      await screen.findByRole("menuitem", { name: tr("mcp.openIntegrationSettings") }),
    );
    expect(openSettings).toHaveBeenCalledExactlyOnceWith("integrations", "integrations-mcp");
    expect(api.updateMcpNetwork).not.toHaveBeenCalled();
  });
  it("preserves unsubmitted port input when a navigation target changes on the same page", () => {
    const client = new QueryClient();
    const view = (focusNetworkSettings: boolean) => (
      <QueryClientProvider client={client}>
        <McpHubPage {...props} focusNetworkSettings={focusNetworkSettings} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(true));
    const port = screen.getByRole("spinbutton", { name: tr("mcp.port") });
    port.focus();
    fireEvent.change(port, { target: { value: "49000" } });
    rerender(view(false));
    expect(screen.getByRole("spinbutton", { name: tr("mcp.port") })).toBe(port);
    expect(port).toHaveValue(49000);
    rerender(view(true));
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(port).toHaveValue(49000);
    expect(port).toHaveFocus();
    expect(api.updateMcpNetwork).not.toHaveBeenCalled();
  });
  it.each([
    ["en-US", "MCP Hub", "one connection to enabled services"],
    ["zh-CN", "MCP 服务中心", "向 Agent 提供已启用的服务"],
    ["zh-TW", "MCP 服務中心", "向 Agent 提供已啟用的服務"],
    ["ja-JP", "MCP ハブ", "共通の接続を通じて"],
  ] as const)(
    "preserves the MCP entry explanation above advanced settings in %s",
    async (locale, label, explanation) => {
      await initializeI18n(locale);
      await renderHub();
      expect(screen.getByRole("note")).toHaveTextContent(explanation);
      expect(screen.queryByText("STREAMABLE HTTP MCP HUB")).toBeNull();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByRole("note")).toHaveTextContent(explanation);
    },
  );
  it("shows query failures while advanced controls are collapsed and recovers on refresh", async () => {
    vi.mocked(api.mcpInstallations)
      .mockRejectedValueOnce(new Error("Package inventory unavailable"))
      .mockResolvedValue([]);
    await renderHub();
    expect(await screen.findByRole("alert")).toHaveTextContent("Package inventory unavailable");
    expect(screen.getByRole("button", { name: tr("mcp.manage.advanced") })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: tr("common.refresh") }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.mcpInstallations).toHaveBeenCalledTimes(2);
  });
  it("locks installation through confirmation, secrets and the request, then permits retry", async () => {
    const confirmation = deferred<boolean>();
    const secrets = deferred<Record<string, string> | null>();
    const installing = deferred<typeof installationResult>();
    dialogs.confirm.mockReturnValueOnce(confirmation.promise);
    dialogs.requestSecrets.mockReturnValueOnce(secrets.promise);
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    vi.mocked(api.installMcp)
      .mockReturnValueOnce(installing.promise)
      .mockResolvedValue(installationResult);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    await searchRegistry();
    const install = screen.getByRole("button", { name: tr("mcp.install") });
    fireEvent.click(install);
    fireEvent.click(install);
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    expect(install).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(tr("common.loading"));
    await act(async () => confirmation.resolve(true));
    expect(dialogs.requestSecrets).toHaveBeenCalledTimes(1);
    expect(api.installMcp).not.toHaveBeenCalled();
    fireEvent.click(install);
    await act(async () => secrets.resolve({ API_KEY: "local-value" }));
    expect(api.installMcp).toHaveBeenCalledExactlyOnceWith(registryEntry, undefined);
    fireEvent.click(install);
    expect(api.installMcp).toHaveBeenCalledTimes(1);
    await act(async () => installing.reject(new Error("Install failed")));
    openAdvanced();
    expect(screen.getByRole("alert")).toHaveTextContent("Install failed");
    openAdvanced();
    expect(screen.getByRole("button", { name: tr("mcp.install") })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.install") }));
    await waitFor(() => expect(api.installMcp).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("locks update during secrets entry and shows a failure before retrying", async () => {
    const secrets = deferred<Record<string, string> | null>();
    dialogs.requestSecrets.mockReturnValueOnce(secrets.promise);
    vi.mocked(api.mcpInstallations).mockResolvedValue([installation]);
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    vi.mocked(api.updateMcp)
      .mockRejectedValueOnce(new Error("Update failed"))
      .mockResolvedValue(installationResult);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    await searchRegistry();
    const update = screen.getByRole("button", { name: tr("mcp.update") });
    fireEvent.click(update);
    fireEvent.click(update);
    await waitFor(() => expect(dialogs.requestSecrets).toHaveBeenCalledTimes(1));
    expect(update).toBeDisabled();
    expect(
      screen.getByRole("button", { name: `${tr("mcp.uninstall")} ${installation.name}` }),
    ).toBeDisabled();
    expect(api.updateMcp).not.toHaveBeenCalled();
    await act(async () => secrets.resolve({ API_KEY: "local-value" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Update failed");
    expect(update).toBeEnabled();
    fireEvent.click(update);
    await waitFor(() => expect(api.updateMcp).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(update).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("locks uninstall from confirmation through failure and preserves retry", async () => {
    const confirmation = deferred<boolean>();
    const uninstalling = deferred<void>();
    dialogs.confirm.mockReturnValueOnce(confirmation.promise);
    vi.mocked(api.mcpInstallations).mockResolvedValue([installation]);
    vi.mocked(api.uninstallMcp)
      .mockReturnValueOnce(uninstalling.promise)
      .mockResolvedValue(undefined);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    const remove = await screen.findByRole("button", {
      name: `${tr("mcp.uninstall")} ${installation.name}`,
    });
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
    expect(remove).toBeDisabled();
    await act(async () => confirmation.resolve(true));
    expect(api.uninstallMcp).toHaveBeenCalledExactlyOnceWith("fixture");
    fireEvent.click(remove);
    await act(async () => uninstalling.reject(new Error("Uninstall failed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Uninstall failed");
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    await waitFor(() => expect(api.uninstallMcp).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(remove).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each([
    ["mcp.restart", "restartMcpRuntime"],
    ["mcp.stopAllScopes", "stopMcpRuntime"],
  ] as const)("locks %s, shows rejection and allows retry", async (label, method) => {
    const request = deferred<void>();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([runtimeInstance("Global runtime", null)]);
    vi.mocked(api.restartMcpRuntime)
      .mockImplementationOnce(async () => {
        await request.promise;
        return [];
      })
      .mockResolvedValue([]);
    vi.mocked(api.stopMcpRuntime).mockReturnValueOnce(request.promise).mockResolvedValue(undefined);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    const action = await screen.findByRole("button", { name: tr(label) });
    fireEvent.click(action);
    fireEvent.click(action);
    await waitFor(() => expect(api[method]).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: tr("mcp.restart") })).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("mcp.stopAllScopes") })).toBeDisabled();
    await act(async () => request.reject(new Error("Runtime operation failed")));
    openAdvanced();
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime operation failed");
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: tr(label) }));
    await waitFor(() => expect(api[method]).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not install into an old scope after secrets complete in another scope", async () => {
    const user = userEvent.setup();
    const secrets = deferred<Record<string, string> | null>();
    dialogs.requestSecrets.mockReturnValueOnce(secrets.promise);
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    await searchRegistry();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.install") }));
    await waitFor(() => expect(dialogs.requestSecrets).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    await act(async () => secrets.resolve({ API_KEY: "local-value" }));
    expect(api.installMcp).not.toHaveBeenCalled();
    expect(api.saveMcpLocalValues).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: tr("mcp.install") })).toBeEnabled();
  });
  it("discards late operation errors after switching scopes and releases the lock", async () => {
    const user = userEvent.setup();
    const restarting = deferred<Awaited<ReturnType<typeof api.restartMcpRuntime>>>();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Global runtime", null),
      runtimeInstance("Workspace two runtime", "/workspaces/two"),
    ]);
    vi.mocked(api.restartMcpRuntime).mockReturnValueOnce(restarting.promise).mockResolvedValue([]);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.restart") }));
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByText("Workspace two runtime")).toBeVisible();
    await act(async () => restarting.reject(new Error("Old scope failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const restart = screen.getByRole("button", { name: tr("mcp.restart") });
    expect(restart).toBeEnabled();
    fireEvent.click(restart);
    expect(api.restartMcpRuntime).toHaveBeenLastCalledWith("blender", "/workspaces/two");
    await waitFor(() => expect(restart).toBeEnabled());
  });
  it.each(["uninstall", "port", "network", "stop"] as const)(
    "keeps an in-flight global %s failure visible after switching scopes",
    async (operation) => {
      const user = userEvent.setup();
      const request = deferred<never>();
      vi.mocked(api.mcpInstallations).mockResolvedValue([installation]);
      vi.mocked(api.mcpRuntimes).mockResolvedValue([runtimeInstance("Global runtime", null)]);
      vi.mocked(api.uninstallMcp).mockReturnValue(request.promise);
      vi.mocked(api.updateMcpNetwork).mockReturnValue(request.promise);
      vi.mocked(api.stopMcpRuntime).mockReturnValue(request.promise);
      await renderHub();
      await screen.findByText("Blender");
      openAdvanced();
      if (operation === "uninstall") {
        fireEvent.click(
          screen.getByRole("button", { name: `${tr("mcp.uninstall")} ${installation.name}` }),
        );
        await waitFor(() => expect(api.uninstallMcp).toHaveBeenCalledTimes(1));
      } else if (operation === "port") {
        const port = screen.getByRole("spinbutton", { name: tr("mcp.port") });
        fireEvent.change(port, { target: { value: "47654" } });
        fireEvent.blur(port);
        await waitFor(() =>
          expect(api.updateMcpNetwork).toHaveBeenCalledExactlyOnceWith({
            port: 47654,
            lan_enabled: false,
            lan_risk_accepted: false,
          }),
        );
      } else if (operation === "network") {
        fireEvent.click(screen.getByRole("switch", { name: tr("mcp.lanMode") }));
        await waitFor(() =>
          expect(api.updateMcpNetwork).toHaveBeenCalledExactlyOnceWith({
            port: 47653,
            lan_enabled: true,
            lan_risk_accepted: true,
          }),
        );
      } else {
        fireEvent.click(screen.getByRole("button", { name: tr("mcp.stopAllScopes") }));
        await waitFor(() => expect(api.stopMcpRuntime).toHaveBeenCalledExactlyOnceWith("blender"));
      }
      await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
      await user.click(await screen.findByRole("option", { name: "Workspace two" }));
      await act(async () => request.reject(new Error("Global operation failed")));
      openAdvanced();
      expect(screen.getByRole("alert")).toHaveTextContent("Global operation failed");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );
  it("cancels an unsubmitted global uninstall when its confirmation finishes in another scope", async () => {
    const user = userEvent.setup();
    const confirmation = deferred<boolean>();
    dialogs.confirm.mockReturnValueOnce(confirmation.promise);
    vi.mocked(api.mcpInstallations).mockResolvedValue([installation]);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    fireEvent.click(
      screen.getByRole("button", { name: `${tr("mcp.uninstall")} ${installation.name}` }),
    );
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    await act(async () => confirmation.resolve(true));
    expect(api.uninstallMcp).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `${tr("mcp.uninstall")} ${installation.name}` }),
    ).toBeEnabled();
  });
  it("finishes an already-started installation in its original scope without replacing the new scope", async () => {
    const user = userEvent.setup();
    const installing = deferred<typeof installationResult>();
    let installed = false;
    dialogs.requestSecrets.mockResolvedValue({ API_KEY: "local-value" });
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    vi.mocked(api.installMcp).mockReturnValue(installing.promise);
    vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) =>
      state(
        project ? "Workspace service" : installed ? "Installed global service" : "Global service",
      ),
    );
    await renderHub();
    await screen.findByText("Global service");
    openAdvanced();
    await searchRegistry();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.install") }));
    await waitFor(() => expect(api.installMcp).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByText("Workspace service")).toBeVisible();
    installed = true;
    await act(async () => installing.resolve(installationResult));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(api.saveMcpLocalValues).toHaveBeenCalledExactlyOnceWith(
      "blender",
      { API_KEY: "local-value" },
      {},
      undefined,
    );
    expect(screen.getByText("Workspace service")).toBeVisible();
    expect(screen.queryByText("Installed global service")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(await screen.findByText("Installed global service")).toBeVisible();
  });
  it("releases the action lock when confirmation or secrets are cancelled", async () => {
    dialogs.confirm.mockResolvedValueOnce(false);
    dialogs.requestSecrets.mockResolvedValueOnce(null);
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registryEntry]);
    await renderHub();
    await screen.findByText("Blender");
    openAdvanced();
    await searchRegistry();
    const install = screen.getByRole("button", { name: tr("mcp.install") });
    fireEvent.click(install);
    await waitFor(() => expect(install).toBeEnabled());
    expect(dialogs.requestSecrets).not.toHaveBeenCalled();
    fireEvent.click(install);
    await waitFor(() => expect(install).toBeEnabled());
    expect(dialogs.requestSecrets).toHaveBeenCalledTimes(1);
    expect(api.installMcp).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("shows and restarts only runtime instances owned by the selected scope", async () => {
    const user = userEvent.setup();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Global runtime", null),
      runtimeInstance("Workspace one runtime", "/workspaces/one"),
      runtimeInstance("Workspace two runtime", "/workspaces/two"),
      runtimeInstance("Legacy runtime"),
    ]);
    await renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    expect(await screen.findByText("Global runtime")).toBeVisible();
    expect(screen.queryByText("Workspace one runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace two runtime")).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("mcp.restart") }));
    expect(api.restartMcpRuntime).toHaveBeenLastCalledWith("blender", undefined);

    for (const workspace of workspaces) {
      await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
      await user.click(await screen.findByRole("option", { name: workspace.name }));
      expect(await screen.findByText(`${workspace.name} runtime`)).toBeVisible();
      expect(screen.queryByText("Global runtime")).not.toBeInTheDocument();
      expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: tr("mcp.restart") })).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: tr("mcp.restart") }));
      expect(api.restartMcpRuntime).toHaveBeenLastCalledWith("blender", workspace.path);
    }
    expect(api.restartMcpRuntime).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole("button", { name: tr("mcp.stopAllScopes") }));
    expect(api.stopMcpRuntime).toHaveBeenCalledExactlyOnceWith("blender");

    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(await screen.findByText("Global runtime")).toBeVisible();
    expect(screen.queryByText("Workspace two runtime")).not.toBeInTheDocument();
  });
  it("shows the scope empty state instead of exposing other or unknown runtime actions", async () => {
    const user = userEvent.setup();
    vi.mocked(api.mcpRuntimes).mockResolvedValue([
      runtimeInstance("Workspace two runtime", "/workspaces/two"),
      runtimeInstance("Legacy runtime"),
    ]);
    await renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    expect(await screen.findByText(tr("mcp.runtimesEmpty"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("mcp.restart") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: tr("mcp.stopAllScopes") })).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace one" }));
    expect(await screen.findByText(tr("mcp.runtimesEmpty"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("mcp.restart") })).not.toBeInTheDocument();
    expect(screen.queryByText("Legacy runtime")).not.toBeInTheDocument();
    expect(api.restartMcpRuntime).not.toHaveBeenCalled();
  });
  it("discards late global state after choosing a workspace", async () => {
    const user = userEvent.setup();
    let resolve!: (value: McpManagementState) => void;
    const old = new Promise<McpManagementState>((yes) => {
      resolve = yes;
    });
    vi.mocked(api.mcpManagementState).mockImplementation((request) =>
      request.project ? Promise.resolve(state("Workspace service")) : old,
    );
    await renderHub();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByText("Workspace service")).toBeVisible();
    await act(async () => resolve(state("Global service")));
    expect(screen.queryByText("Global service")).toBeNull();
    expect(api.mcpManagementState).toHaveBeenLastCalledWith({ project: "/workspaces/two" });
  });
  it("preserves an editor draft across scope switches and keeps its original revision", async () => {
    const user = userEvent.setup();
    await renderHub();
    await screen.findByText("Blender");
    await user.click(
      screen.getByRole("button", { name: tr("mcp.manage.moreActions", { name: "Blender" }) }),
    );
    await user.click(await screen.findByRole("menuitem", { name: tr("mcp.manage.edit") }));
    await user.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByRole("textbox", { name: "MCP JSON" });
    fireEvent.change(json, {
      target: { value: JSON.stringify({ ...server(), name: "Draft name" }) },
    });
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    await screen.findByText("Blender");
    await user.click(screen.getByRole("combobox", { name: tr("mcp.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("mcp.globalScope") }));
    expect(await screen.findByRole("textbox", { name: tr("mcp.manage.name") })).toHaveValue(
      "Draft name",
    );
    await user.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveMcpConfiguration).mock.calls[0][0]).toMatchObject({
      revision: "r1",
      originalId: "blender",
      server: { name: "Draft name" },
    });
  });
  it("saves a manual new service disabled without probing", async () => {
    await renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.add") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.save") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.save") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.saveMcpConfiguration).mock.calls[0][0].server.enabled).toBe(false);
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
    expect(api.saveMcpLocalValues).not.toHaveBeenCalled();
  });
  it("uses import preview for wrappers and never probes during collection", async () => {
    vi.mocked(api.previewMcpImport).mockResolvedValue({
      token: "t",
      revision: "r1",
      items: [
        {
          key: "one",
          config: server(),
          status: "new",
          warnings: [],
          required_env: [],
          required_headers: [],
        },
      ],
    });
    vi.mocked(api.applyMcpImport).mockResolvedValue({
      revision: "r2",
      results: [{ key: "one", status: "saved" }],
    });
    await renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.import") }));
    const text = JSON.stringify({ mcpServers: { blender: { command: "uvx" } } });
    fireEvent.change(screen.getByRole("textbox", { name: tr("mcp.manage.paste") }), {
      target: { value: text },
    });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.previewPaste") }));
    await screen.findByRole("button", { name: tr("mcp.manage.collect") });
    expect(api.previewMcpImport).toHaveBeenCalledWith({ project: undefined, text });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.collect") }));
    await waitFor(() => expect(api.applyMcpImport).toHaveBeenCalledTimes(1));
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
    expect(api.saveMcpServer).not.toHaveBeenCalled();
  });
  it("requires an explicit workspace for global bulk connection and gates home writes", async () => {
    const user = userEvent.setup();
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      token: "t",
      workspace_id: "two",
      targets: [
        {
          agent: "hermes",
          status: "missing",
          selected: true,
          target: "/home/config.yaml",
          scope: "agent-home",
        },
      ],
      changes: [
        { target: "/home/config.yaml", scope: "agent-home", before: "", after: "redacted" },
      ],
      requires_home_approval: true,
    });
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      targets: [{ agent: "hermes", status: "applied" }],
    });
    await renderHub();
    await screen.findByText("Blender");
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.more") }));
    await user.click(await screen.findByRole("menuitem", { name: tr("mcp.manage.connect") }));
    expect(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") })).toBeDisabled();
    await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.workspace") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.selectAllAgents") }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") }));
    const apply = await screen.findByRole("button", { name: tr("mcp.manage.applyConnection") });
    expect(apply).toBeDisabled();
    expect(vi.mocked(api.planMcpConnections).mock.calls[0][0].targetAgents).toHaveLength(8);
    fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.homeApproval") }));
    fireEvent.click(apply);
    fireEvent.click(apply);
    await waitFor(() => expect(api.applyMcpConnections).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(tr("mcp.manage.reloadHint"))).toBeVisible();
  });
  it("refreshes the management inventory after a registry installation", async () => {
    const registry = {
      name: "Registry fixture",
      description: "",
      version: "1",
      package_kind: "npm" as const,
      identifier: "fixture",
      required_env: [],
      runtime_arguments: [],
      package_arguments: [],
    };
    vi.mocked(api.searchMcpRegistry).mockResolvedValue([registry]);
    vi.mocked(api.installMcp).mockImplementation(async () => {
      vi.mocked(api.mcpManagementState).mockResolvedValue(state("Installed fixture"));
      return {
        server: server("Installed fixture"),
        tools: [],
        installation: {
          id: "fixture",
          name: "Registry fixture",
          package_kind: "npm",
          identifier: "fixture",
          version: "1",
          status: "installed",
          installed_at: "2026-10-09",
          updated_at: "2026-10-09",
        },
      };
    });
    await renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.advanced") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.search") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("mcp.install") }));
    expect(await screen.findByText("Installed fixture")).toBeVisible();
    expect(screen.queryByText("Blender")).not.toBeInTheDocument();
  });
  it("retries only failed selected services with the original desired state", async () => {
    const initial = {
      revision: "r1",
      servers: [
        entry("Blender"),
        { ...entry("Other"), config: { ...server("Other"), id: "other" } },
      ],
    };
    vi.mocked(api.mcpManagementState).mockResolvedValue(initial);
    vi.mocked(api.saveMcpConfiguration).mockImplementation(async (request) => {
      if (
        request.server.id === "other" &&
        vi.mocked(api.saveMcpConfiguration).mock.calls.filter(([r]) => r.server.id === "other")
          .length === 1
      )
        throw new Error("external edit");
      return initial;
    });
    await renderHub();
    await screen.findByText("Blender");
    fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.selectVisible") }));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.disableSelected") }));
    fireEvent.click(await screen.findByRole("button", { name: tr("mcp.manage.retryFailed") }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(3));
    expect(
      vi
        .mocked(api.saveMcpConfiguration)
        .mock.calls.map(([request]) => [request.server.id, request.server.enabled]),
    ).toEqual([
      ["blender", false],
      ["other", false],
      ["other", false],
    ]);
  });
});
