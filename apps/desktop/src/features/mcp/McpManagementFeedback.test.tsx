// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagedEntry, McpManagementState } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, localizeMessage, tr } from "@/core/i18n";
import { McpManagementPanel, type McpEditorState } from "./McpManagementPanel";

vi.mock("@/core/api", () => ({
  api: {
    mcpManagementState: vi.fn(),
    saveMcpConfiguration: vi.fn(),
    probeMcpRuntime: vi.fn(),
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: vi.fn().mockResolvedValue(true) }),
}));

function entry(id: string, name = id, enabled = false, inherited = false): McpManagedEntry {
  return {
    config: {
      id,
      name,
      enabled,
      env: {},
      headers: {},
      transport: "stdio",
      command: "example-command",
      args: [],
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
function inventory(servers: McpManagedEntry[], revision = "initial"): McpManagementState {
  return { revision, servers };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function renderPanel(
  initial: McpManagementState,
  project = "/workspace/one",
  initialRead?: Promise<McpManagementState>,
) {
  if (initialRead) vi.mocked(api.mcpManagementState).mockReturnValue(initialRead);
  else vi.mocked(api.mcpManagementState).mockResolvedValue(initial);
  vi.mocked(api.saveMcpConfiguration).mockResolvedValue(initial);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const drafts = new Map<string, McpEditorState>();
  const onChanged = vi.fn().mockResolvedValue(undefined);
  const panel = (scope: string) => (
    <QueryClientProvider client={queryClient}>
      <McpManagementPanel
        key={scope}
        project={scope}
        workspaces={[]}
        drafts={drafts}
        onChanged={onChanged}
      />
    </QueryClientProvider>
  );
  const view = render(panel(project));
  return {
    ...view,
    queryClient,
    onChanged,
    changeScope: (scope: string) => view.rerender(panel(scope)),
  };
}
async function selectAll(count: number) {
  await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(count + 1));
  fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.selectVisible") }));
}
function batchButton(enabled = true) {
  return screen.getByRole("button", {
    name: tr(enabled ? "mcp.manage.enableSelected" : "mcp.manage.disableSelected"),
  });
}
function search(query: string) {
  fireEvent.change(screen.getByRole("textbox", { name: tr("mcp.manage.search") }), {
    target: { value: query },
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  vi.mocked(api.probeMcpRuntime).mockResolvedValue([]);
});
afterEach(cleanup);

describe("MCP management batch feedback", () => {
  it.each([
    ["zh-CN", "选择 Docs & tools"],
    ["zh-TW", "選取 Docs & tools"],
    ["en-US", "Select Docs & tools"],
    ["ja-JP", "Docs & tools を選択"],
  ] as const)("localizes the service selection control in %s", async (locale, label) => {
    await initializeI18n(locale);
    renderPanel(inventory([entry("docs", "Docs & tools"), entry("other", "Other service")]));
    const checkbox = await screen.findByRole("checkbox", { name: label });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(batchButton());
    await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(1));
    expect(api.saveMcpConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        originalId: "docs",
        server: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it.each([true, false])(
    "keeps operation names, ids and desired enabled=%s through partial results and retry",
    async (enabled) => {
      const initial = inventory([
        entry("one", "Original Alpha", !enabled),
        entry("two", "Original Beta", !enabled),
        entry("three", "Original Gamma", !enabled),
      ]);
      const latest = inventory(
        [
          entry("one", "Renamed Alpha"),
          entry("two", "Renamed Beta"),
          entry("three", "Inherited Gamma", false, true),
        ],
        "latest-read",
      );
      const saved = { ...latest, revision: "after-first-write" };
      const view = renderPanel(initial);
      await selectAll(3);
      vi.mocked(api.mcpManagementState).mockResolvedValue(latest);
      vi.mocked(api.saveMcpConfiguration)
        .mockResolvedValue(saved)
        .mockResolvedValueOnce(saved)
        .mockRejectedValueOnce(new Error("Second write failed"));
      fireEvent.click(batchButton(enabled));
      await waitFor(() => expect(view.onChanged).toHaveBeenCalledOnce());
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(`Original Alpha (one) · ${tr("mcp.manage.import_saved")}`);
      expect(status).toHaveTextContent(
        `Original Beta (two) · ${tr("mcp.manage.import_failed")} ${localizeMessage(new Error("Second write failed"))}`,
      );
      expect(status).toHaveTextContent(
        `Original Gamma (three) · ${tr("mcp.manage.import_skipped")}`,
      );
      expect(status).not.toHaveTextContent(/Renamed|Inherited Gamma/);
      expect(
        vi
          .mocked(api.saveMcpConfiguration)
          .mock.calls.map(([request]) => [
            request.originalId,
            request.revision,
            request.server.enabled,
            request.server.name,
          ]),
      ).toEqual([
        ["one", "latest-read", enabled, "Renamed Alpha"],
        ["two", "after-first-write", enabled, "Renamed Beta"],
      ]);
      fireEvent.click(screen.getByRole("button", { name: tr("mcp.manage.retryFailed") }));
      await waitFor(() => expect(view.onChanged).toHaveBeenCalledTimes(2));
      expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(3);
      expect(vi.mocked(api.saveMcpConfiguration).mock.calls[2]![0]).toMatchObject({
        project: "/workspace/one",
        revision: "latest-read",
        originalId: "two",
        server: { id: "two", name: "Renamed Beta", enabled },
      });
      expect(status).toHaveTextContent(`Original Beta (two) · ${tr("mcp.manage.import_saved")}`);
      expect(status).not.toHaveTextContent("Second write failed");
      expect(status).not.toHaveTextContent("Renamed Beta");
      expect(screen.queryByRole("button", { name: tr("mcp.manage.retryFailed") })).toBeNull();
    },
  );

  it("distinguishes services with identical names using their original ids", async () => {
    const initial = inventory([entry("first-id", "Browser"), entry("second-id", "Browser")]);
    renderPanel(initial);
    await selectAll(2);
    fireEvent.click(batchButton());
    const status = await screen.findByRole("status");
    await waitFor(() => {
      expect(status).toHaveTextContent(`Browser (first-id) · ${tr("mcp.manage.import_saved")}`);
      expect(status).toHaveTextContent(`Browser (second-id) · ${tr("mcp.manage.import_saved")}`);
    });
  });

  it("falls back to the id when the name is missing and avoids repeating an identical name", async () => {
    renderPanel(inventory([entry("legacy-id", ""), entry("same-id")]));
    await selectAll(2);
    fireEvent.click(batchButton());
    const status = await screen.findByRole("status");
    await waitFor(() =>
      expect(status).toHaveTextContent(`same-id · ${tr("mcp.manage.import_saved")}`),
    );
    expect(status).toHaveTextContent(`legacy-id · ${tr("mcp.manage.import_saved")}`);
    expect(status).not.toHaveTextContent("same-id (same-id)");
  });

  it("captures names before the preflight inventory resolves or a selected service disappears", async () => {
    const initial = inventory([entry("one", "Before Rename"), entry("two", "Before Removal")]);
    const view = renderPanel(initial);
    await selectAll(2);
    const read = deferred<McpManagementState>();
    vi.mocked(api.mcpManagementState).mockReturnValueOnce(read.promise);
    fireEvent.click(batchButton());
    const later = inventory([entry("one", "After Rename")], "later");
    await act(async () => {
      view.queryClient.setQueryData(["mcp", "management", "/workspace/one"], later);
    });
    vi.mocked(api.mcpManagementState).mockResolvedValue(later);
    vi.mocked(api.saveMcpConfiguration).mockResolvedValue(later);
    await act(async () => read.resolve(later));
    await waitFor(() => expect(view.onChanged).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(
      `Before Rename (one) · ${tr("mcp.manage.import_saved")}`,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      `Before Removal (two) · ${tr("mcp.manage.import_skipped")}`,
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("After Rename");
    expect(api.saveMcpConfiguration).toHaveBeenCalledOnce();
  });

  it("names every failure when the initial batch inventory cannot be read", async () => {
    const view = renderPanel(
      inventory([entry("one", "First Service"), entry("two", "Second Service")]),
    );
    await selectAll(2);
    vi.mocked(api.mcpManagementState).mockRejectedValueOnce(new Error("Inventory unavailable"));
    fireEvent.click(batchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Inventory unavailable");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      `First Service (one) · ${tr("mcp.manage.import_failed")} ${localizeMessage(new Error("Inventory unavailable"))}`,
    );
    expect(status).toHaveTextContent(
      `Second Service (two) · ${tr("mcp.manage.import_failed")} ${localizeMessage(new Error("Inventory unavailable"))}`,
    );
    expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
    expect(view.onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: tr("mcp.manage.retryFailed") })).toBeEnabled();
  });

  it("names unattempted items when a failure also prevents the revision refresh", async () => {
    const initial = inventory([
      entry("one", "First Service"),
      entry("two", "Second Service"),
      entry("three", "Third Service"),
    ]);
    renderPanel(initial);
    await selectAll(3);
    vi.mocked(api.mcpManagementState)
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("Refresh unavailable"));
    vi.mocked(api.saveMcpConfiguration)
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error("Write unavailable"));
    fireEvent.click(batchButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh unavailable");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(`First Service (one) · ${tr("mcp.manage.import_saved")}`);
    expect(status).toHaveTextContent(
      `Second Service (two) · ${tr("mcp.manage.import_failed")} ${localizeMessage(new Error("Write unavailable"))}`,
    );
    expect(status).toHaveTextContent(
      `Third Service (three) · ${tr("mcp.manage.import_failed")} ${tr("mcp.manage.notAttempted")}`,
    );
    expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(2);
  });

  it.each(["inventory", "write"] as const)(
    "does not publish old results or continue writes after a scope change during %s",
    async (phase) => {
      const initial = inventory([entry("one", "Old Scope One"), entry("two", "Old Scope Two")]);
      const replacement = inventory([entry("one", "New Scope One")], "new-scope");
      const view = renderPanel(initial);
      await selectAll(2);
      const pending = deferred<McpManagementState>();
      vi.mocked(api.mcpManagementState).mockImplementation(async ({ project }) => {
        if (project === "/workspace/two") return replacement;
        return phase === "inventory" ? pending.promise : initial;
      });
      if (phase === "write") vi.mocked(api.saveMcpConfiguration).mockReturnValue(pending.promise);
      fireEvent.click(batchButton());
      fireEvent.click(batchButton());
      expect(batchButton()).toBeDisabled();
      if (phase === "write")
        await waitFor(() => expect(api.saveMcpConfiguration).toHaveBeenCalledOnce());
      view.changeScope("/workspace/two");
      expect(await screen.findByText("New Scope One", { selector: "strong" })).toBeVisible();
      await act(async () => pending.resolve(initial));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByText(/Old Scope/)).toBeNull();
      expect(api.saveMcpConfiguration).toHaveBeenCalledTimes(phase === "write" ? 1 : 0);
      for (const [request] of vi.mocked(api.saveMcpConfiguration).mock.calls)
        expect(request.project).toBe("/workspace/one");
      expect(view.onChanged).not.toHaveBeenCalled();
    },
  );
});

describe("MCP inventory empty feedback", () => {
  it.each(["zh-CN", "zh-TW", "ja-JP", "en-US"] as const)(
    "distinguishes a search miss from an empty scope in %s",
    async (locale) => {
      await initializeI18n(locale);
      renderPanel(inventory([entry("one", "Blender")]));
      await screen.findByText("Blender", { selector: "strong" });
      search("unmatched-term");
      expect(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })).toContain("unmatched-term");
      expect(
        screen.getByText(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })),
      ).toBeVisible();
      expect(screen.queryByText(tr("mcp.configuredEmpty"))).toBeNull();
      search("");
      expect(screen.getByText("Blender", { selector: "strong" })).toBeVisible();
      expect(
        screen.queryByText(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })),
      ).toBeNull();
      search("example-command");
      expect(screen.getByText("Blender", { selector: "strong" })).toBeVisible();
      expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
    },
  );

  it.each(["zh-CN", "zh-TW", "ja-JP", "en-US"] as const)(
    "keeps the actual empty-scope message even with a query in %s",
    async (locale) => {
      await initializeI18n(locale);
      renderPanel(inventory([]));
      const emptyText = tr("mcp.manage.scopeEmpty", {
        scope: tr("mcp.manage.projectScope", { name: "/workspace/one" }),
      });
      expect(await screen.findByText(emptyText)).toBeVisible();
      search("unmatched-term");
      expect(screen.getByText(emptyText)).toBeVisible();
      expect(
        screen.queryByText(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })),
      ).toBeNull();
    },
  );

  it("shows loading and an initial error without claiming that the inventory is empty", async () => {
    const read = deferred<McpManagementState>();
    renderPanel(inventory([]), "/workspace/pending", read.promise);
    expect(screen.getByText(tr("common.loading"))).toBeVisible();
    search("unmatched-term");
    expect(screen.queryByText(tr("mcp.configuredEmpty"))).toBeNull();
    await act(async () => read.reject(new Error("Inventory failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Inventory failed");
    expect(screen.queryByText(tr("common.loading"))).toBeNull();
    expect(screen.queryByText(tr("mcp.configuredEmpty"))).toBeNull();
    expect(
      screen.queryByText(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })),
    ).toBeNull();
  });

  it("keeps a cached search miss and reports refresh failure separately", async () => {
    const view = renderPanel(inventory([entry("one", "Blender")]));
    await screen.findByText("Blender", { selector: "strong" });
    search("unmatched-term");
    vi.mocked(api.mcpManagementState).mockRejectedValue(new Error("Refresh failed"));
    await act(async () => {
      await view.queryClient.invalidateQueries({
        queryKey: ["mcp", "management", "/workspace/one"],
      });
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed");
    expect(
      screen.getByText(tr("mcp.manage.searchEmpty", { query: "unmatched-term" })),
    ).toBeVisible();
    expect(screen.queryByText(tr("mcp.configuredEmpty"))).toBeNull();
  });
});
