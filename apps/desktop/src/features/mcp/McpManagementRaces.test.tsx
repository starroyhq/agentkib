// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpBatchConnectionPlan,
  McpManagedEntry,
  McpManagementState,
  McpToolPolicySnapshot,
} from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import type { WorkspaceSummary } from "@/core/types";
import { McpServiceEditor, newMcpDraft } from "./McpServiceEditor";
import { McpManagementPanel } from "./McpManagementPanel";
import { McpPolicyEditor } from "./McpPolicyEditor";
import { McpImportPanel } from "./McpImportPanel";
import { McpBatchConnectionPanel } from "./McpBatchConnectionPanel";

const messages = vi.hoisted(() => ({
  tr: (key: string) => key,
  localizeMessage: (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
}));
vi.mock("@/core/useI18n", () => ({ useI18n: () => messages }));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));
vi.mock("@/core/api", () => ({
  api: {
    mcpManagementState: vi.fn(),
    saveMcpConfiguration: vi.fn(),
    getMcpPolicy: vi.fn(),
    saveMcpPolicy: vi.fn(),
    nativeMcpCandidates: vi.fn(),
    previewMcpMigration: vi.fn(),
    applyMcpMigration: vi.fn(),
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    verifyMcpConnection: vi.fn(),
    probeMcpRuntime: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "one",
  name: "One",
  path: "/workspace/one",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
function entry(id: string): McpManagedEntry {
  return {
    config: {
      id,
      name: id,
      enabled: false,
      env: {},
      headers: {},
      transport: "stdio",
      command: "node",
      args: [],
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
    },
    scope: "workspace",
    inherited: false,
    required_env: [],
    required_headers: [],
    configured_env: [],
    configured_headers: [],
    oauth_configured: false,
  };
}
const state: McpManagementState = { revision: "r1", servers: [entry("one"), entry("two")] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function directory(probed = true): McpToolPolicySnapshot {
  return {
    revision: "r1",
    rules: [],
    inherited_rules: [],
    effective_rules: [],
    catalog: [
      {
        server_id: "one",
        name: "one",
        probed,
        tools: [
          { server_id: "one", name: "read", input_schema: { type: "object" }, read_only: true },
        ],
      },
    ],
  };
}
const connectionPlan: McpBatchConnectionPlan = {
  workspace_id: "one",
  token: "preview",
  targets: [
    {
      agent: "codex",
      status: "missing",
      selected: true,
      target: "/workspace/one/.codex/config.toml",
      scope: "project",
    },
  ],
  changes: [
    {
      target: "/workspace/one/.codex/config.toml",
      scope: "project",
      before: "",
      after: "url = 'fixture'",
    },
  ],
  requires_home_approval: false,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.mcpManagementState).mockResolvedValue(state);
  vi.mocked(api.saveMcpConfiguration).mockResolvedValue(state);
  vi.mocked(api.getMcpPolicy).mockResolvedValue(directory());
  vi.mocked(api.planMcpConnections).mockResolvedValue(connectionPlan);
  vi.mocked(api.verifyMcpConnection).mockResolvedValue({
    url: "http://127.0.0.1/mcp",
    checked_at: "2026-10-09T00:00:00Z",
    builtin_tools: 0,
    external_tools: [],
  });
});
afterEach(cleanup);

describe("MCP management review regressions", () => {
  function renderTargets(
    surface: "table" | "editor",
    targets: McpManagedEntry["config"]["targets"],
  ) {
    const server = entry("one");
    server.config.targets = targets;
    const onDraft = vi.fn();
    if (surface === "editor") {
      render(
        <McpServiceEditor
          project={workspace.path}
          revision="r1"
          entry={server}
          draft={newMcpDraft(server)}
          onDraft={onDraft}
          onSaved={vi.fn().mockResolvedValue(undefined)}
          onCancel={vi.fn()}
        />,
      );
    } else {
      vi.mocked(api.mcpManagementState).mockResolvedValue({ ...state, servers: [server] });
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <McpManagementPanel
            project={workspace.path}
            workspaces={[workspace]}
            drafts={new Map()}
            onChanged={vi.fn().mockResolvedValue(undefined)}
          />
        </QueryClientProvider>,
      );
    }
    return onDraft;
  }

  it.each(["table", "editor"] as const)(
    "%s turns legacy all-targets into an explicit selection without mutating the original",
    async (surface) => {
      const original: McpManagedEntry["config"]["targets"] = [];
      const onDraft = renderTargets(surface, original);
      if (surface === "table") {
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "mcp.manage.moreActions" }));
        await user.click(await screen.findByRole("menuitem", { name: "mcp.manage.chooseAgents" }));
      }
      const checkbox = await screen.findByRole("checkbox", {
        name: surface === "table" ? "one Codex" : "Codex",
      });
      expect(checkbox).toBeChecked();
      expect(screen.queryByRole("checkbox", { name: /DeepSeek/ })).not.toBeInTheDocument();
      fireEvent.click(checkbox);
      const expected = [
        "claude-code",
        "antigravity",
        "cursor",
        "opencode",
        "open-claw",
        "hermes",
        "grok-build",
      ];
      if (surface === "table") {
        await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
        expect(vi.mocked(api.saveMcpConfiguration).mock.calls[0]![0].server.targets).toEqual(
          expected,
        );
      } else {
        expect(onDraft).toHaveBeenCalledTimes(1);
        expect(JSON.parse(onDraft.mock.calls[0]![0].json).targets).toEqual(expected);
        expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
      }
      expect(original).toEqual([]);
    },
  );

  it.each(["table", "editor"] as const)(
    "%s refuses to turn the last explicit target back into all-targets",
    async (surface) => {
      const onDraft = renderTargets(surface, ["codex"]);
      if (surface === "table") {
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "mcp.manage.moreActions" }));
        await user.click(await screen.findByRole("menuitem", { name: "mcp.manage.chooseAgents" }));
      }
      const checkbox = await screen.findByRole("checkbox", {
        name: surface === "table" ? "one Codex" : "Codex",
      });
      fireEvent.click(checkbox);
      expect(await screen.findByRole("alert")).toHaveTextContent("mcp.manage.lastTarget");
      expect(checkbox).toBeChecked();
      expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
      expect(onDraft).not.toHaveBeenCalled();
    },
  );

  it.each([
    { transport: "stdio" },
    { transport: "stdio", id: "one", name: "one", command: "node", args: 3, targets: [] },
    {
      transport: "streamable-http",
      id: "one",
      name: "one",
      url: "https://fixture.invalid",
      targets: null,
    },
  ])("keeps incomplete JSON editable without crashing the form: %j", (json) => {
    const draft = { ...newMcpDraft(), json: JSON.stringify(json) };
    render(
      <McpServiceEditor
        project={workspace.path}
        revision="r1"
        draft={draft}
        onDraft={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "MCP JSON" })).toHaveValue(draft.json);
  });

  it("does not replace another editor while a save is pending", async () => {
    const saving = deferred<McpManagementState>();
    vi.mocked(api.saveMcpConfiguration).mockReturnValue(saving.promise);
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <McpManagementPanel
          project={workspace.path}
          workspaces={[workspace]}
          drafts={new Map()}
          onChanged={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("one");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "mcp.manage.moreActions" })[0]!);
    await user.click(await screen.findByRole("menuitem", { name: "mcp.manage.edit" }));
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    await user.click(screen.getAllByRole("button", { name: "mcp.manage.moreActions" })[1]!);
    expect(await screen.findByRole("menuitem", { name: "mcp.manage.edit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "mcp.manage.add" })).toBeDisabled();
    await act(async () => saving.resolve(state));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "common.save" })).not.toBeInTheDocument(),
    );
  });

  it("refreshes a probed tool catalog while preserving unsaved selected rules", async () => {
    const props = {
      project: workspace.path,
      serverId: "one",
      onSaved: vi.fn().mockResolvedValue(undefined),
    };
    const view = render(<McpPolicyEditor {...props} revision="r1:0" />);
    const mode = await screen.findByRole("combobox", { name: "mcp.manage.rule" });
    await waitFor(() => expect(mode).not.toBeDisabled());
    const user = userEvent.setup();
    await user.click(mode);
    await user.click(await screen.findByRole("option", { name: "mcp.manage.rule_selected" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "read" }));
    view.rerender(<McpPolicyEditor {...props} revision="r1:1" />);
    await waitFor(() => expect(api.getMcpPolicy).toHaveBeenCalledTimes(2));
    expect(mode).toHaveTextContent("mcp.manage.rule_selected");
    expect(screen.getByRole("checkbox", { name: "read" })).toBeChecked();
  });

  it("preserves partial batch results when refreshing the failed item also fails", async () => {
    const batchState = { ...state, servers: [...state.servers, entry("three")] };
    vi.mocked(api.mcpManagementState)
      .mockResolvedValue(batchState)
      .mockResolvedValueOnce(batchState)
      .mockResolvedValueOnce(batchState)
      .mockRejectedValueOnce(new Error("State read failed"));
    vi.mocked(api.saveMcpConfiguration)
      .mockResolvedValue(batchState)
      .mockResolvedValueOnce(batchState)
      .mockRejectedValueOnce(new Error("Second write failed"));
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <McpManagementPanel
          project={workspace.path}
          workspaces={[workspace]}
          drafts={new Map()}
          onChanged={vi.fn().mockResolvedValue(undefined)}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("one");
    fireEvent.click(screen.getByRole("checkbox", { name: "mcp.manage.selectVisible" }));
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.enableSelected" }));
    await screen.findByText(/State read failed/);
    expect(screen.getByText(/one · mcp.manage.import_saved/)).toBeVisible();
    expect(screen.getByText(/two · mcp.manage.import_failed/)).toBeVisible();
    expect(
      screen.getByText(/three · mcp.manage.import_failed mcp.manage.notAttempted/),
    ).toBeVisible();
    expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.retryFailed" }));
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(4));
    expect(
      vi
        .mocked(api.saveMcpConfiguration)
        .mock.calls.map(([request]) => [request.server.id, request.server.enabled]),
    ).toEqual([
      ["one", true],
      ["two", true],
      ["two", true],
      ["three", true],
    ]);
  });

  it("invalidates a native migration preview after the source selection changes", async () => {
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue(
      ["a", "b"].map((id) => ({
        id,
        agent: "codex",
        scope: "project",
        name: `Native ${id}`,
        source_path: `/workspace/one/${id}.toml`,
        transport: "stdio",
        endpoint: "node",
        has_secret_values: false,
        supported: true,
        warnings: [],
      })),
    );
    vi.mocked(api.previewMcpMigration).mockResolvedValue({
      token: "migration-a",
      revision: "r1",
      requires_home_approval: false,
      changes: [{ target: "/workspace/one/a.toml", scope: "project", before: "old", after: "new" }],
    });
    render(
      <McpImportPanel project={workspace.path} onSaved={vi.fn().mockResolvedValue(undefined)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.scanNative" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Native a/ }));
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.migrate" }));
    await screen.findByRole("button", { name: "mcp.manage.applyConnection" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Native b/ }));
    expect(
      screen.queryByRole("button", { name: "mcp.manage.applyConnection" }),
    ).not.toBeInTheDocument();
    expect(api.applyMcpMigration).not.toHaveBeenCalled();
  });

  it("warns before a migration that rewrites Claude Code's global file", async () => {
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue([
      {
        id: "a",
        agent: "claude-code",
        scope: "home",
        name: "Native a",
        source_path: "/home/u/.claude.json",
        transport: "http",
        endpoint: "https://example.test",
        has_secret_values: false,
        supported: true,
        warnings: [],
      },
    ]);
    const preview = {
      token: "migration-a",
      revision: "r1",
      requires_home_approval: true,
      changes: [{ target: "/home/u/.claude.json", scope: "agent-home", before: "{}", after: "{}" }],
    };
    vi.mocked(api.previewMcpMigration).mockResolvedValue(preview);
    const { unmount } = render(
      <McpImportPanel project={workspace.path} onSaved={vi.fn().mockResolvedValue(undefined)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.scanNative" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Native a/ }));
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.migrate" }));
    expect(await screen.findByText("changes.claudeGlobalConfigWarning")).toBeVisible();
    unmount();
    vi.mocked(api.previewMcpMigration).mockResolvedValue({
      ...preview,
      changes: [
        { target: "/home/u/.codex/config.toml", scope: "agent-home", before: "", after: "" },
      ],
    });
    render(
      <McpImportPanel project={workspace.path} onSaved={vi.fn().mockResolvedValue(undefined)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.scanNative" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Native a/ }));
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.migrate" }));
    await screen.findByRole("button", { name: "mcp.manage.applyConnection" });
    expect(screen.queryByText("changes.claudeGlobalConfigWarning")).not.toBeInTheDocument();
  });
  it("shows batch recovery evidence when only the shared manifest could not be restored", async () => {
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      success: false,
      message: "Manifest recovery incomplete",
      backup_dir: "/private/backups/example",
      recovery: [
        {
          target: "/workspace/one/.agentkib/manifest.yaml",
          status: "unconfirmed",
          backup: "/private/backups/example/2.bak",
        },
      ],
      targets: [{ agent: "codex", status: "rolled-back", reason: "Agent config restored" }],
    });
    render(
      <McpBatchConnectionPanel
        project={workspace.path}
        workspaces={[workspace]}
        servicesRevision="r1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.checkPreview" }));
    fireEvent.click(await screen.findByRole("button", { name: "mcp.manage.applyConnection" }));
    expect(await screen.findByText("Manifest recovery incomplete")).toBeVisible();
    expect(screen.getByText(/\/workspace\/one\/\.agentkib\/manifest.yaml/)).toBeVisible();
    expect(screen.getAllByText(/\/private\/backups\/example/)).toHaveLength(2);
  });

  it("discards a late Hub tool list after the service-policy revision changes", async () => {
    const response = deferred<Awaited<ReturnType<typeof api.verifyMcpConnection>>>();
    vi.mocked(api.verifyMcpConnection).mockReturnValue(response.promise);
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      targets: [{ agent: "codex", status: "applied" }],
    });
    const props = { project: workspace.path, workspaces: [workspace] };
    const view = render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.checkPreview" }));
    fireEvent.click(await screen.findByRole("button", { name: "mcp.manage.applyConnection" }));
    await waitFor(() => expect(api.verifyMcpConnection).toHaveBeenCalledTimes(1));
    view.rerender(<McpBatchConnectionPanel {...props} servicesRevision="r2" />);
    await act(async () =>
      response.resolve({
        url: "http://127.0.0.1/mcp",
        checked_at: "2026-10-09T00:00:00Z",
        builtin_tools: 0,
        external_tools: ["revoked_tool"],
      }),
    );
    expect(screen.queryByText("revoked_tool")).not.toBeInTheDocument();
  });

  it("hides a completed Hub verification until the current revision is verified", async () => {
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      targets: [{ agent: "codex", status: "applied" }],
    });
    const verification = {
      url: "http://127.0.0.1/mcp",
      checked_at: "2026-10-09T00:00:00Z",
      builtin_tools: 0,
    };
    vi.mocked(api.verifyMcpConnection)
      .mockResolvedValueOnce({ ...verification, external_tools: ["previous_tool"] })
      .mockResolvedValueOnce({ ...verification, external_tools: ["current_tool"] });
    const props = { project: workspace.path, workspaces: [workspace] };
    const view = render(<McpBatchConnectionPanel {...props} servicesRevision="r1" />);
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.checkPreview" }));
    fireEvent.click(await screen.findByRole("button", { name: "mcp.manage.applyConnection" }));
    expect(await screen.findByText("previous_tool")).toBeVisible();
    view.rerender(<McpBatchConnectionPanel {...props} servicesRevision="r2" />);
    expect(screen.queryByText("previous_tool")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "mcp.manage.verifyHub" }));
    expect(await screen.findByText("current_tool")).toBeVisible();
    expect(screen.queryByText("previous_tool")).not.toBeInTheDocument();
    expect(api.verifyMcpConnection).toHaveBeenCalledTimes(2);
  });
});
