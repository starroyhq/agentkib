// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { AGENT_LABELS } from "@/core/agents";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type {
  AgentKind,
  AgentToolAction,
  AgentToolExecutionResult,
  AgentToolSnapshot,
  AgentToolStatus,
} from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { AgentToolsSettings } from "./AgentToolsSettings";
import { acquireAgentToolsExecution, refreshAgentTools, useAgentTools } from "./agent-tools-query";

vi.mock("./agent-tools-query", () => ({
  useAgentTools: vi.fn(),
  refreshAgentTools: vi.fn(),
  acquireAgentToolsExecution: vi.fn(),
}));
vi.mock("@/core/api", () => ({
  api: {
    openExternal: vi.fn(),
    checkAppUpdate: vi.fn(),
    installAppUpdate: vi.fn(),
    executeAgentTool: vi.fn(),
  },
}));

function updateAction(agent: AgentKind, overrides: Partial<AgentToolAction> = {}): AgentToolAction {
  return {
    id: `${agent}:update:npm:1.1.0`,
    kind: "update",
    mode: "execute",
    channel: "npm",
    command: `/usr/local/bin/npm update ${agent}`,
    target_version: "1.1.0",
    installation_id: `${agent}:install`,
    manager_path: "/usr/local/bin/npm",
    ...overrides,
  };
}
function tool(agent: AgentKind, actions = [updateAction(agent)]): AgentToolStatus {
  return {
    agent,
    installed: true,
    current_version: "1.0.0",
    recommended_version: "1.1.0",
    state: "update-available",
    channel: "npm",
    installations: [
      {
        id: `${agent}:install`,
        path: `/usr/local/bin/${agent}`,
        resolved_path: `/usr/local/bin/${agent}`,
        version: "1.0.0",
        runnable: true,
        channel: "npm",
        environment: "system",
        is_path_default: true,
      },
    ],
    warnings: [],
    official_url: `https://example.com/${agent}`,
    actions,
  };
}
function snapshot(tools: AgentToolStatus[]): AgentToolSnapshot {
  return {
    tools,
    checked_at: "2026-10-16T08:00:00Z",
    latest_checked_at: "2026-10-16T08:00:00Z",
    cache_status: "fresh",
    errors: [],
  };
}
function setTools(tools: AgentToolStatus[]) {
  vi.mocked(useAgentTools).mockReturnValue({
    data: snapshot(tools),
    error: null,
    isPending: false,
  } as ReturnType<typeof useAgentTools>);
}
function result(
  agent: AgentKind,
  status: AgentToolExecutionResult["status"],
  overrides: Partial<AgentToolExecutionResult> = {},
): AgentToolExecutionResult {
  return {
    agent,
    action_id: updateAction(agent).id,
    status,
    output: "",
    completed_at: "2026-10-16T08:01:00Z",
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <AppDialogProvider>
        <AgentToolsSettings updatesEnabled={false} />
      </AppDialogProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refreshRender: () => view.rerender(tree()) };
}
async function startBatch(user: ReturnType<typeof userEvent.setup>, count: number) {
  await user.click(
    screen.getByRole("button", { name: tr("settings.tools.reviewUpdates", { count }) }),
  );
  await user.click(screen.getByRole("button", { name: tr("settings.tools.executeAllUpdates") }));
  await user.click(await screen.findByRole("button", { name: tr("common.confirm") }));
}
async function dismissResult(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: tr("common.ok") }));
}
function report() {
  return screen.getByRole("region", { name: tr("settings.tools.batchDetailsTitle") });
}
function row(agent: AgentKind) {
  return within(report())
    .getByRole("heading", { level: 4, name: AGENT_LABELS[agent] })
    .closest("li")!;
}

beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  vi.resetAllMocks();
  await changeLocale("en-US");
  useWorkspaceStore.getState().resetWorkspace();
  setTools([tool("codex")]);
  vi.mocked(api.executeAgentTool).mockImplementation(async (agent) => result(agent, "succeeded"));
  vi.mocked(acquireAgentToolsExecution).mockResolvedValue(vi.fn());
  vi.mocked(refreshAgentTools).mockResolvedValue(snapshot([]));
});
afterEach(cleanup);

describe("batch update result details", () => {
  it("keeps each actual returned status, output and request error without treating unknown outcomes as success", async () => {
    const agents = [
      "codex",
      "claude-code",
      "antigravity",
      "cursor",
      "opencode",
      "open-claw",
      "hermes",
    ] as const;
    const statuses = [
      "succeeded",
      "failed",
      "timed-out",
      "busy",
      "unchanged",
      "verification-failed",
    ] as const;
    setTools(agents.map((agent) => tool(agent)));
    vi.mocked(api.executeAgentTool).mockImplementation(async (agent) => {
      if (agent === "hermes") throw new Error("transport response lost");
      const status = statuses[agents.indexOf(agent as (typeof agents)[number])];
      return result(agent, status, {
        output: agent === "cursor" ? "" : `${agent} command output`,
        ...(agent === "codex"
          ? { before_version: "1.0.0", after_version: "1.1.0", exit_code: 0 }
          : {}),
        ...(agent === "claude-code" ? { exit_code: 13 } : {}),
      });
    });
    const user = userEvent.setup();
    const view = renderSettings();
    await startBatch(user, 7);
    await dismissResult(user);
    expect(within(report()).getAllByRole("listitem")).toHaveLength(7);
    statuses.forEach((status, index) => {
      expect(row(agents[index])).toHaveTextContent(tr(`settings.tools.result.${status}`));
    });
    expect(row("codex")).toHaveTextContent(
      tr("settings.tools.versionChange", { before: "1.0.0", after: "1.1.0" }),
    );
    expect(row("codex")).toHaveTextContent(tr("settings.tools.executionExitCode", { code: 0 }));
    expect(row("claude-code")).toHaveTextContent("claude-code command output");
    expect(row("claude-code")).toHaveTextContent(
      tr("settings.tools.executionExitCode", { code: 13 }),
    );
    expect(row("cursor")).toHaveTextContent(tr("settings.tools.batchBusyDescription"));
    expect(row("cursor")).not.toHaveTextContent(tr("settings.tools.noCommandOutput"));
    expect(row("hermes")).toHaveTextContent(tr("settings.tools.batchUnconfirmed"));
    expect(row("hermes")).toHaveTextContent(tr("settings.tools.batchUnconfirmedDescription"));
    expect(row("hermes")).toHaveTextContent("transport response lost");
    expect(row("hermes")).not.toHaveTextContent(tr("settings.tools.result.succeeded"));
    expect(within(report()).getByRole("status")).toHaveTextContent(
      tr("settings.tools.batchResult", { succeeded: 1, failed: 6 }),
    );
    expect(api.executeAgentTool).toHaveBeenCalledTimes(7);
    view.refreshRender();
    await user.click(screen.getByRole("button", { name: tr("settings.tools.detectAgain") }));
    await waitFor(() => expect(refreshAgentTools).toHaveBeenCalledTimes(2));
    expect(api.executeAgentTool).toHaveBeenCalledTimes(7);
    expect(row("hermes")).toHaveTextContent("transport response lost");
  });

  it("explains a returned failure even when the backend supplies no output or version", async () => {
    vi.mocked(api.executeAgentTool).mockResolvedValue(result("codex", "failed", { exit_code: 2 }));
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 1);
    await dismissResult(user);
    expect(row("codex")).toHaveTextContent(tr("settings.tools.result.failed"));
    expect(row("codex")).toHaveTextContent(tr("settings.tools.executionExitCode", { code: 2 }));
    expect(row("codex")).toHaveTextContent(tr("settings.tools.batchNoDetails"));
    expect(within(report()).getByRole("status")).toHaveTextContent(
      tr("settings.tools.batchResult", { succeeded: 0, failed: 1 }),
    );
  });

  it("shows unstarted and running targets and keeps the confirmed plan stable across a new tools snapshot", async () => {
    setTools([tool("codex"), tool("claude-code"), tool("cursor")]);
    const pending = deferred<AgentToolExecutionResult>();
    vi.mocked(api.executeAgentTool).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    const view = renderSettings();
    const detect = screen.getByRole("button", { name: tr("settings.tools.detectAgain") });
    const update = screen.getAllByRole("button", { name: tr("settings.tools.updateNow") })[0];
    await startBatch(user, 3);
    await waitFor(() => expect(api.executeAgentTool).toHaveBeenCalledTimes(1));
    expect(row("codex")).toHaveTextContent(tr("settings.tools.batchRunning"));
    expect(row("claude-code")).toHaveTextContent(tr("settings.tools.batchWaiting"));
    expect(row("cursor")).toHaveTextContent(tr("settings.tools.batchWaiting"));
    expect(within(report()).getByRole("status")).toHaveTextContent(
      tr("settings.tools.batchProgress", { completed: 0, total: 3 }),
    );
    expect(detect).toBeDisabled();
    expect(update).toBeDisabled();
    fireEvent.click(detect);
    fireEvent.click(update);
    expect(refreshAgentTools).not.toHaveBeenCalled();
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);
    setTools([tool("opencode")]);
    view.refreshRender();
    expect(row("codex")).toHaveTextContent(tr("settings.tools.channel.npm"));
    expect(row("claude-code")).toHaveTextContent("1.1.0");
    await act(async () => pending.resolve(result("codex", "succeeded")));
    await dismissResult(user);
    expect(api.executeAgentTool).toHaveBeenNthCalledWith(1, "codex", updateAction("codex").id);
    expect(api.executeAgentTool).toHaveBeenNthCalledWith(
      2,
      "claude-code",
      updateAction("claude-code").id,
    );
    expect(api.executeAgentTool).toHaveBeenNthCalledWith(3, "cursor", updateAction("cursor").id);
    expect(api.executeAgentTool).toHaveBeenCalledTimes(3);
    expect(within(report()).queryByRole("heading", { name: "OpenCode" })).not.toBeInTheDocument();
    expect(within(report()).getByRole("status")).toHaveTextContent(
      tr("settings.tools.batchResult", { succeeded: 3, failed: 0 }),
    );
  });

  it("locks duplicate submissions and detection while waiting for the existing execution gate", async () => {
    const pending = deferred<(() => void) | undefined>();
    const release = vi.fn();
    vi.mocked(acquireAgentToolsExecution).mockReturnValueOnce(pending.promise);
    const user = userEvent.setup();
    renderSettings();
    const detect = screen.getByRole("button", { name: tr("settings.tools.detectAgain") });
    await user.click(
      screen.getByRole("button", { name: tr("settings.tools.reviewUpdates", { count: 1 }) }),
    );
    const run = screen.getByRole("button", { name: tr("settings.tools.executeAllUpdates") });
    fireEvent.click(run);
    fireEvent.click(run);
    expect(acquireAgentToolsExecution).toHaveBeenCalledTimes(1);
    expect(run).toBeDisabled();
    expect(detect).toBeDisabled();
    await act(async () => pending.resolve(release));
    await user.click(await screen.findByRole("button", { name: tr("common.cancel") }));
    await waitFor(() => expect(run).not.toBeDisabled());
    expect(release).toHaveBeenCalled();
    expect(api.executeAgentTool).not.toHaveBeenCalled();
    expect(refreshAgentTools).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("region", { name: tr("settings.tools.batchDetailsTitle") }),
    ).not.toBeInTheDocument();
  });

  it("leaves the previous report intact when a later confirmation is cancelled", async () => {
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 1);
    await dismissResult(user);
    const previous = report();
    await user.click(
      screen.getByRole("button", { name: tr("settings.tools.reviewUpdates", { count: 1 }) }),
    );
    await user.click(screen.getByRole("button", { name: tr("settings.tools.executeAllUpdates") }));
    await user.click(await screen.findByRole("button", { name: tr("common.cancel") }));
    await user.keyboard("{Escape}");
    expect(report()).toBe(previous);
    expect(row("codex")).toHaveTextContent(tr("settings.tools.result.succeeded"));
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);
  });

  it("does not replace a previous report or execute when the global gate is already owned", async () => {
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 1);
    await dismissResult(user);
    const previous = report();
    vi.mocked(acquireAgentToolsExecution).mockResolvedValueOnce(undefined);
    await user.click(
      screen.getByRole("button", { name: tr("settings.tools.reviewUpdates", { count: 1 }) }),
    );
    await user.click(screen.getByRole("button", { name: tr("settings.tools.executeAllUpdates") }));
    await waitFor(() => expect(acquireAgentToolsExecution).toHaveBeenCalledTimes(2));
    await user.keyboard("{Escape}");
    expect(report()).toBe(previous);
    expect(
      screen.getByRole("button", { name: tr("settings.tools.detectAgain") }),
    ).not.toBeDisabled();
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);
  });

  it("retains the actual results when post-update detection fails and retries only detection", async () => {
    vi.mocked(refreshAgentTools).mockRejectedValueOnce(new Error("detection response lost"));
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 1);
    await dismissResult(user);
    const previous = report();
    expect(useWorkspaceStore.getState().message).toContain("detection response lost");
    expect(row("codex")).toHaveTextContent(tr("settings.tools.result.succeeded"));
    await user.click(screen.getByRole("button", { name: tr("settings.tools.detectAgain") }));
    await waitFor(() => expect(refreshAgentTools).toHaveBeenCalledTimes(2));
    expect(useWorkspaceStore.getState().message).toBe("");
    expect(report()).toBe(previous);
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);
  });

  it("does not run later targets or report into another page after unmount", async () => {
    setTools([tool("codex"), tool("claude-code")]);
    const pending = deferred<AgentToolExecutionResult>();
    const release = vi.fn();
    vi.mocked(api.executeAgentTool).mockReturnValueOnce(pending.promise);
    vi.mocked(acquireAgentToolsExecution).mockResolvedValueOnce(release);
    const user = userEvent.setup();
    const view = renderSettings();
    await startBatch(user, 2);
    await waitFor(() => expect(api.executeAgentTool).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => pending.resolve(result("codex", "succeeded")));
    expect(api.executeAgentTool).toHaveBeenCalledTimes(1);
    expect(refreshAgentTools).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps manual, install and documentation actions outside the original executable-update batch", async () => {
    setTools([
      tool("codex"),
      tool("claude-code", [updateAction("claude-code", { mode: "copy-command" })]),
      tool("cursor", [updateAction("cursor", { kind: "install" })]),
      tool("opencode", [
        { id: "docs", kind: "open-documentation", mode: "open-documentation", channel: "unknown" },
      ]),
    ]);
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 1);
    await dismissResult(user);
    expect(within(report()).getAllByRole("listitem")).toHaveLength(1);
    expect(row("codex")).toHaveTextContent(tr("settings.tools.result.succeeded"));
    expect(api.executeAgentTool).toHaveBeenCalledExactlyOnceWith("codex", updateAction("codex").id);
  });

  it("keeps separate action results when one Agent has multiple executable update channels", async () => {
    setTools([
      tool("codex", [
        updateAction("codex"),
        updateAction("codex", {
          id: "codex:update:brew:1.2.0",
          channel: "homebrew",
          target_version: "1.2.0",
        }),
      ]),
    ]);
    vi.mocked(api.executeAgentTool).mockImplementation(async (agent, id) =>
      result(agent, id.includes("brew") ? "failed" : "succeeded", { action_id: id, output: id }),
    );
    const user = userEvent.setup();
    renderSettings();
    await startBatch(user, 2);
    await dismissResult(user);
    const rows = within(report()).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Codex");
    expect(rows[0]).toHaveTextContent(tr("settings.tools.channel.npm"));
    expect(rows[0]).toHaveTextContent(tr("settings.tools.result.succeeded"));
    expect(rows[1]).toHaveTextContent("Codex");
    expect(rows[1]).toHaveTextContent(tr("settings.tools.channel.homebrew"));
    expect(rows[1]).toHaveTextContent("1.2.0");
    expect(rows[1]).toHaveTextContent(tr("settings.tools.result.failed"));
    expect(api.executeAgentTool).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["zh-CN", "批量更新逐项结果", "结果尚未确认"],
    ["zh-Hant", "批次更新逐項結果", "結果尚未確認"],
    ["en-US", "Batch update results", "Outcome unconfirmed"],
    ["ja-JP", "一括更新の個別結果", "結果未確認"],
  ] as const)(
    "renders actual four-language results in %s and updates them without rerunning tools",
    async (locale, title, unconfirmed) => {
      await changeLocale(locale);
      setTools([tool("codex"), tool("claude-code"), tool("cursor")]);
      vi.mocked(api.executeAgentTool).mockImplementation(async (agent) => {
        if (agent === "cursor") throw new Error("connection closed");
        return result(agent, agent === "codex" ? "succeeded" : "busy");
      });
      const user = userEvent.setup();
      renderSettings();
      await startBatch(user, 3);
      await dismissResult(user);
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(row("cursor")).toHaveTextContent(unconfirmed);
      expect(row("cursor")).toHaveTextContent(tr("settings.tools.batchUnconfirmedDescription"));
      expect(row("claude-code")).toHaveTextContent(tr("settings.tools.batchBusyDescription"));
      expect(within(report()).getByRole("status")).toHaveTextContent(
        tr("settings.tools.batchResult", { succeeded: 1, failed: 2 }),
      );
      expect(report().textContent).not.toContain("settings.tools.");
      const previous = report();
      await act(() => changeLocale(locale === "en-US" ? "ja-JP" : "en-US"));
      expect(report()).toBe(previous);
      expect(row("cursor")).toHaveTextContent(tr("settings.tools.batchUnconfirmed"));
      expect(api.executeAgentTool).toHaveBeenCalledTimes(3);
    },
  );
});
