// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagedEntry, McpManagementState } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { McpManagementPanel } from "./McpManagementPanel";

vi.mock("@/core/api", () => ({
  api: {
    mcpManagementState: vi.fn(),
    saveMcpConfiguration: vi.fn(),
    removeMcpConfiguration: vi.fn(),
    startMcpOAuth: vi.fn(),
    openExternal: vi.fn(),
    probeMcpRuntime: vi.fn(),
  },
}));
vi.mock("./McpServiceEditor", () => ({
  newMcpDraft: () => ({ json: "{}" }),
  McpServiceEditor: ({ entry }: { entry?: McpManagedEntry }) => <p>Editing {entry?.config.name}</p>,
}));
vi.mock("./McpPolicyEditor", () => ({
  McpPolicyEditor: ({ serverId }: { serverId: string | null }) => <p>Policy for {serverId}</p>,
}));

function entry(id = "blender", enabled = true, inherited = false): McpManagedEntry {
  return {
    config: {
      id,
      name: id === "blender" ? "Blender" : "Second service",
      enabled,
      transport: "streamable-http",
      url: "https://service.example.test/mcp",
      env: {},
      headers: {},
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
    },
    scope: inherited ? "global" : "workspace",
    inherited,
    required_env: [],
    required_headers: [],
    configured_env: [],
    configured_headers: [],
    oauth_configured: false,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function renderPanel(servers = [entry()], project?: string) {
  const state: McpManagementState = { revision: "revision-before-action", servers };
  vi.mocked(api.mcpManagementState).mockResolvedValue(state);
  vi.mocked(api.saveMcpConfiguration).mockResolvedValue(state);
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const panel = (key: string) => (
    <QueryClientProvider client={queryClient}>
      <AppDialogProvider>
        <McpManagementPanel
          key={key}
          project={project}
          workspaces={[]}
          drafts={new Map()}
          onChanged={onChanged}
        />
      </AppDialogProvider>
    </QueryClientProvider>
  );
  const view = render(panel("initial"));
  return { ...view, onChanged, replacePanel: () => view.rerender(panel("replacement")) };
}
async function serviceRow(name = "Blender") {
  const label = await screen.findByText(name, { selector: "strong" });
  return label.closest("tr")!;
}
async function openMore(user: ReturnType<typeof userEvent.setup>, name = "Blender") {
  await user.click(
    within(await serviceRow(name)).getByRole("button", {
      name: tr("mcp.manage.moreActions", { name }),
    }),
  );
  return screen.findByRole("menu");
}

beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  vi.mocked(api.probeMcpRuntime).mockResolvedValue([]);
  vi.mocked(api.startMcpOAuth).mockResolvedValue({
    authorization_url: "https://auth.example.test/authorize",
  });
  vi.mocked(api.openExternal).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("MCP row action hierarchy", () => {
  it.each([true, false])("keeps one recommended action when enabled=%s", async (enabled) => {
    renderPanel([entry("blender", enabled)]);
    const row = await serviceRow();
    expect(within(row).getAllByRole("button")).toHaveLength(enabled ? 2 : 1);
    if (enabled) expect(within(row).getByRole("button", { name: tr("mcp.probe") })).toBeVisible();
    expect(within(row).queryByRole("button", { name: tr("mcp.manage.edit") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("mcp.manage.copy") })).toBeNull();
    const user = userEvent.setup();
    const menu = await openMore(user);
    for (const key of [
      "mcp.manage.copy",
      "mcp.manage.toolPolicy",
      "mcp.authorize",
      "common.remove",
    ])
      expect(within(menu).getByRole("menuitem", { name: tr(key) })).toBeVisible();
    expect(within(menu).queryByRole("menuitem", { name: tr("mcp.probe") })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: tr("mcp.manage.edit") })).toBeVisible();
  });

  it("preserves public copying, policy editing and scoped OAuth in the menu", async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderPanel([entry()], "/workspace/one");
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.copy") }));
    expect(clipboard).toHaveBeenCalledWith(JSON.stringify(entry().config, null, 2));
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.toolPolicy") }));
    expect(screen.getByText("Policy for blender")).toBeVisible();
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.authorize") }));
    await waitFor(() =>
      expect(api.startMcpOAuth).toHaveBeenCalledWith("blender", "/workspace/one"),
    );
    expect(api.openExternal).toHaveBeenCalledWith("https://auth.example.test/authorize");
  });

  it("keeps a pending probe mounted when opening and closing more actions", async () => {
    const probe = deferred<Awaited<ReturnType<typeof api.probeMcpRuntime>>>();
    vi.mocked(api.probeMcpRuntime).mockReturnValue(probe.promise);
    renderPanel();
    const user = userEvent.setup();
    fireEvent.click(within(await serviceRow()).getByRole("button", { name: tr("mcp.probe") }));
    expect(screen.getByRole("button", { name: tr("mcp.probing") })).toBeDisabled();
    await openMore(user);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: tr("mcp.probing") })).toBeDisabled();
    expect(api.probeMcpRuntime).toHaveBeenCalledOnce();
    await act(async () => probe.resolve([]));
    expect(await screen.findByText(tr("mcp.probeResult", { count: 0 }))).toBeVisible();
  });

  it("keeps inherited rows read-only while allowing a workspace override", async () => {
    renderPanel([entry("blender", true, true)], "/workspace/one");
    const row = await serviceRow();
    expect(within(row).getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    const user = userEvent.setup();
    await openMore(user);
    expect(screen.getByRole("menuitem", { name: tr("mcp.manage.chooseAgents") })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.queryByRole("menuitem", { name: tr("mcp.manage.removeOverride") })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: tr("common.remove") })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.createOverride") }));
    expect(screen.getByText("Editing Blender")).toBeVisible();
    expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
    expect(api.removeMcpConfiguration).not.toHaveBeenCalled();
  });

  it("preserves in-flight mutation locks for menu actions", async () => {
    const saving = deferred<McpManagementState>();
    vi.mocked(api.saveMcpConfiguration).mockReturnValue(saving.promise);
    renderPanel([entry(), entry("second")]);
    // Install the deferred after the fixture's normal save response.
    vi.mocked(api.saveMcpConfiguration).mockReturnValue(saving.promise);
    fireEvent.click(
      within(await serviceRow()).getByRole("switch", {
        name: `Blender ${tr("mcp.manage.enabled")}`,
      }),
    );
    const user = userEvent.setup();
    const menu = await openMore(user, "Second service");
    for (const key of ["mcp.manage.edit", "mcp.authorize", "common.remove"])
      expect(within(menu).getByRole("menuitem", { name: tr(key) })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    expect(within(menu).getByRole("menuitem", { name: tr("mcp.manage.copy") })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(api.removeMcpConfiguration).not.toHaveBeenCalled();
    expect(api.startMcpOAuth).not.toHaveBeenCalled();
    await act(async () =>
      saving.resolve({ revision: "after", servers: [entry(), entry("second")] }),
    );
  });

  it.each(["zh-CN", "zh-TW", "ja-JP", "en-US"] as const)(
    "names the service in a destructive confirmation and preserves cancel in %s",
    async (locale) => {
      await initializeI18n(locale);
      const user = userEvent.setup();
      renderPanel();
      const menu = await openMore(user);
      const remove = within(menu).getByRole("menuitem", { name: tr("common.remove") });
      expect(remove).toHaveAttribute("data-variant", "destructive");
      await user.click(remove);
      const dialog = await screen.findByRole("alertdialog");
      expect(within(dialog).getByRole("heading")).toHaveTextContent(
        tr("mcp.manage.removeNamedTitle", { name: "Blender" }),
      );
      expect(dialog).toHaveTextContent(tr("mcp.manage.removeConfirm", { name: "Blender" }));
      expect(within(dialog).getByRole("button", { name: tr("common.confirm") })).toHaveClass(
        "text-destructive-text",
      );
      await user.click(within(dialog).getByRole("button", { name: tr("common.cancel") }));
      expect(api.removeMcpConfiguration).not.toHaveBeenCalled();
    },
  );

  it("removes only the confirmed definition using its original scope and revision", async () => {
    renderPanel([entry()], "/workspace/one");
    const user = userEvent.setup();
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.removeOverride") }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: tr("common.confirm") }));
    await waitFor(() =>
      expect(api.removeMcpConfiguration).toHaveBeenCalledExactlyOnceWith({
        project: "/workspace/one",
        revision: "revision-before-action",
        id: "blender",
      }),
    );
  });

  it("does not dispatch removal after the original scoped panel unmounts", async () => {
    const view = renderPanel([entry()], "/workspace/one");
    const user = userEvent.setup();
    await openMore(user);
    await user.click(screen.getByRole("menuitem", { name: tr("mcp.manage.removeOverride") }));
    const dialog = await screen.findByRole("alertdialog");
    view.replacePanel();
    await user.click(within(dialog).getByRole("button", { name: tr("common.confirm") }));
    expect(api.removeMcpConfiguration).not.toHaveBeenCalled();
  });
});
