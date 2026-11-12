// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type {
  AgentKind,
  ChangeSet,
  McpConnectionInfo,
  McpConnectionVerification,
  WorkspaceSummary,
} from "@/core/types";
import { McpConnectionCard } from "./McpConnectionCard";

vi.mock("@/core/api", () => ({
  api: {
    mcpConnectionInfo: vi.fn(),
    planMcpConnection: vi.fn(),
    verifyMcpConnection: vi.fn(),
    apply: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const workspaces: WorkspaceSummary[] = ["one", "two"].map((id) => ({
  id,
  name: `Workspace ${id}`,
  path: `/workspaces/${id}`,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
}));
function info(workspace = "one", agent: AgentKind = "codex", port = 47653): McpConnectionInfo {
  return {
    workspace_id: workspace,
    target_agent: agent,
    url: `http://127.0.0.1:${port}/mcp/${workspace}/${agent}`,
    config:
      agent === "codex"
        ? `[mcp_servers.agentkib]\nurl = "http://127.0.0.1:${port}/mcp/${workspace}/${agent}"`
        : JSON.stringify(
            {
              mcpServers: {
                agentkib: {
                  type: "http",
                  url: `http://127.0.0.1:${port}/mcp/${workspace}/${agent}`,
                },
              },
            },
            null,
            2,
          ),
    target:
      agent === "codex" ? "/agent-home/.codex/config.toml" : `/workspaces/${workspace}/.mcp.json`,
    format: agent === "codex" ? "toml" : "json",
    scope: agent === "codex" ? "agent-home" : "project",
    hub_running: true,
  };
}
const plan: ChangeSet = {
  id: "connect-one-codex",
  project_root: "/workspaces/one",
  created_at: "2026-10-06T00:00:00Z",
  requires_home_approval: true,
  changes: [
    {
      target: "/agent-home/.codex/config.toml",
      scope: "agent-home",
      before: 'model = "existing"\n',
      after:
        'model = "existing"\n[mcp_servers.agentkib]\nurl = "http://127.0.0.1:47653/mcp/one/codex"\n',
      risk: "medium",
      validator: "toml",
    },
  ],
};
const verified: McpConnectionVerification = {
  url: info().url,
  checked_at: "2026-10-06T00:00:00Z",
  builtin_tools: 3,
  external_tools: ["blender__get_scene_info", "blender__execute_blender_code"],
};
const runtime = (port = 47653) => ({
  mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
  mcp_hub: {
    running: true,
    bind_address: "127.0.0.1",
    port,
    lan_enabled: false,
    accessible_addresses: [`http://127.0.0.1:${port}`],
    runtime_count: 1,
    error_count: 0,
  },
});
const props = {
  workspaces,
  runtime: runtime(),
  servicesRevision: "initial",
  onManageWorkspaces: vi.fn(),
};

describe("McpConnectionCard", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await initializeI18n("en-US");
    vi.mocked(api.mcpConnectionInfo).mockImplementation(async (workspace, agent) =>
      info(workspace, agent),
    );
    vi.mocked(api.planMcpConnection).mockResolvedValue(plan);
    vi.mocked(api.verifyMcpConnection).mockResolvedValue(verified);
    vi.mocked(api.apply).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(cleanup);

  it("directs users without a workspace to add one without requesting a URL", () => {
    render(<McpConnectionCard {...props} workspaces={[]} />);
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.addWorkspace") }));
    expect(props.onManageWorkspaces).toHaveBeenCalledOnce();
    expect(api.mcpConnectionInfo).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: tr("mcp.connection.verify") })).toBeNull();
  });

  it("shows the complete scoped URL, format, config and path and copies their exact values", async () => {
    render(<McpConnectionCard {...props} />);
    expect(await screen.findByTestId("mcp-connection-url")).toHaveTextContent(info().url);
    expect(screen.getByTestId("mcp-connection-config").textContent).toBe(info().config);
    expect(screen.getByText(info().target)).toBeVisible();
    expect(screen.getByText(/TOML/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.copyUrl") }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(info().url));
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.copyConfig") }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(info().config));
  });

  it("offers the nine supported Agents and regenerates the target format and URL", async () => {
    const user = userEvent.setup();
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    // Keyboard opening avoids Base UI's pointer hold/release timing under parallel Worker tests.
    screen.getByRole("combobox", { name: tr("mcp.connection.agent") }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findAllByRole("option")).toHaveLength(9);
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(
        info("one", "claude-code").url,
      ),
    );
    expect(screen.getByText(/JSON/)).toBeVisible();
    expect(screen.getByTestId("mcp-connection-config")).toHaveTextContent("mcpServers");
    expect(api.mcpConnectionInfo).toHaveBeenLastCalledWith("one", "claude-code");
  });

  it("ignores an old workspace info response after switching workspaces", async () => {
    const user = userEvent.setup();
    const old = deferred<McpConnectionInfo>();
    vi.mocked(api.mcpConnectionInfo).mockImplementation((workspace, agent) =>
      workspace === "one" ? old.promise : Promise.resolve(info(workspace, agent)),
    );
    render(<McpConnectionCard {...props} />);
    await user.click(screen.getByRole("combobox", { name: tr("mcp.connection.workspace") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    expect(await screen.findByTestId("mcp-connection-url")).toHaveTextContent(info("two").url);
    await act(async () => old.resolve(info()));
    expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(info("two").url);
  });

  it("requires Agent Home approval, preserves unrelated diff lines and locks selection while applying", async () => {
    const writing = deferred<void>();
    vi.mocked(api.apply).mockReturnValue(writing.promise);
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    const workspaceSelector = screen.getByRole("combobox", {
      name: tr("mcp.connection.workspace"),
    });
    const agentSelector = screen.getByRole("combobox", { name: tr("mcp.connection.agent") });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    const apply = await screen.findByRole("button", { name: tr("mcp.connection.apply") });
    expect(apply).toBeDisabled();
    expect(screen.getByText('model = "existing"')).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(api.apply).toHaveBeenCalledWith(plan, true);
    expect(workspaceSelector).toBeDisabled();
    expect(agentSelector).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("common.cancel") })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => writing.resolve());
    expect(screen.getByText(tr("mcp.connection.applied"))).toBeVisible();
    expect(screen.getByRole("combobox", { name: tr("mcp.connection.agent") })).toBeEnabled();
  });

  it.each([false, true])(
    "finishes a pending write before processing a background refresh (failure: %s)",
    async (fails) => {
      const writing = deferred<void>();
      vi.mocked(api.apply).mockReturnValue(writing.promise);
      const { rerender } = render(<McpConnectionCard {...props} />);
      await screen.findByTestId("mcp-connection-url");
      fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
      const apply = await screen.findByRole("button", { name: tr("mcp.connection.apply") });
      fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
      fireEvent.click(apply);
      const requests = vi.mocked(api.mcpConnectionInfo).mock.calls.length;
      rerender(
        <McpConnectionCard
          {...props}
          servicesRevision="probe-completed-during-write"
          runtime={runtime(47654)}
        />,
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(screen.getByRole("button", { name: tr("mcp.connection.applying") })).toBeDisabled();
      expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests);
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(screen.getByRole("dialog")).toBeVisible();
      await act(async () =>
        fails ? writing.reject("Write failed after refresh") : writing.resolve(),
      );
      await waitFor(() => expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests + 1));
      expect(screen.queryByRole("dialog")).toBeNull();
      if (fails)
        expect(await screen.findByRole("alert")).toHaveTextContent("Write failed after refresh");
      expect(api.apply).toHaveBeenCalledExactlyOnceWith(plan, true);
    },
  );

  it.each([false, true])(
    "releases a stale write after its workspace disappears (failure: %s)",
    async (fails) => {
      const writing = deferred<void>();
      vi.mocked(api.apply).mockReturnValue(writing.promise);
      const { rerender } = render(<McpConnectionCard {...props} />);
      await screen.findByTestId("mcp-connection-url");
      fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
      const apply = await screen.findByRole("button", { name: tr("mcp.connection.apply") });
      fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
      fireEvent.click(apply);

      const remaining = workspaces.slice(1);
      rerender(<McpConnectionCard {...props} workspaces={remaining} />);
      await waitFor(() =>
        expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(info("two").url),
      );
      await act(async () =>
        fails ? writing.reject("Stale workspace write failed") : writing.resolve(),
      );
      expect(screen.queryByText(tr("mcp.connection.applied"))).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();

      vi.mocked(api.mcpConnectionInfo).mockImplementation(async (workspace, agent) =>
        info(workspace, agent, 47654),
      );
      const requests = vi.mocked(api.mcpConnectionInfo).mock.calls.length;
      rerender(<McpConnectionCard {...props} workspaces={remaining} runtime={runtime(47654)} />);
      await waitFor(() => expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests + 1));
      await waitFor(() =>
        expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(
          info("two", "codex", 47654).url,
        ),
      );

      vi.mocked(api.verifyMcpConnection).mockResolvedValue({
        ...verified,
        url: info("two", "codex", 47654).url,
      });
      fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
      await screen.findByText(tr("mcp.connection.verified"));
      rerender(
        <McpConnectionCard
          {...props}
          workspaces={remaining}
          runtime={runtime(47654)}
          servicesRevision="updated-after-workspace-removal"
        />,
      );
      expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
      await waitFor(() => expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests + 2));
    },
  );

  it("does not let an old write release a newer write's frozen review", async () => {
    const oldWriting = deferred<void>();
    const newWriting = deferred<void>();
    vi.mocked(api.apply)
      .mockReturnValueOnce(oldWriting.promise)
      .mockReturnValueOnce(newWriting.promise);
    const { rerender } = render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    let apply = await screen.findByRole("button", { name: tr("mcp.connection.apply") });
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    fireEvent.click(apply);

    const remaining = workspaces.slice(1);
    rerender(<McpConnectionCard {...props} workspaces={remaining} />);
    await waitFor(() =>
      expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(info("two").url),
    );
    vi.mocked(api.planMcpConnection).mockResolvedValue({
      ...plan,
      id: "connect-two-codex",
      project_root: "/workspaces/two",
    });
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    apply = await screen.findByRole("button", { name: tr("mcp.connection.apply") });
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    fireEvent.click(apply);

    vi.mocked(api.mcpConnectionInfo).mockImplementation(async (workspace, agent) =>
      info(workspace, agent, 47654),
    );
    const requests = vi.mocked(api.mcpConnectionInfo).mock.calls.length;
    rerender(
      <McpConnectionCard
        {...props}
        workspaces={remaining}
        runtime={runtime(47654)}
        servicesRevision="updated-during-new-write"
      />,
    );
    await act(async () => oldWriting.resolve());
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("button", { name: tr("mcp.connection.applying") })).toBeDisabled();
    expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests);

    await act(async () => newWriting.resolve());
    await waitFor(() => expect(api.mcpConnectionInfo).toHaveBeenCalledTimes(requests + 1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(
        info("two", "codex", 47654).url,
      ),
    );
    expect(api.apply).toHaveBeenCalledTimes(2);
  });

  it("shows existing configuration without allowing an empty ChangeSet to be applied", async () => {
    vi.mocked(api.planMcpConnection).mockResolvedValue({
      ...plan,
      requires_home_approval: false,
      changes: [],
    });
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    expect(await screen.findByText(tr("mcp.connection.noChanges"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("mcp.connection.apply") })).toBeNull();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("reports Hub tools without claiming that the target Agent connected and clears verification on port changes", async () => {
    const { rerender } = render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByText(tr("mcp.connection.verified"))).toBeVisible();
    expect(screen.getByText("3 built-in tools · 2 external tools")).toBeVisible();
    expect(screen.getByText("blender__get_scene_info")).toBeVisible();
    expect(screen.getByText(tr("mcp.connection.verificationScope"))).toBeVisible();
    vi.mocked(api.mcpConnectionInfo).mockResolvedValue(info("one", "codex", 47654));
    rerender(<McpConnectionCard {...props} runtime={runtime(47654)} />);
    expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
    expect(await screen.findByTestId("mcp-connection-url")).toHaveTextContent(":47654/");
  });

  it("discards pending plan and verification responses when Agent or service revision changes", async () => {
    const user = userEvent.setup();
    const oldPlan = deferred<ChangeSet>();
    vi.mocked(api.planMcpConnection).mockReturnValue(oldPlan.promise);
    const { rerender } = render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    await user.click(screen.getByRole("combobox", { name: tr("mcp.connection.agent") }));
    await user.click(await screen.findByRole("option", { name: "Cursor" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent("/cursor"),
    );
    await act(async () => oldPlan.resolve(plan));
    expect(screen.queryByRole("button", { name: tr("mcp.connection.apply") })).toBeNull();
    const oldVerify = deferred<McpConnectionVerification>();
    vi.mocked(api.verifyMcpConnection).mockReturnValue(oldVerify.promise);
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    rerender(<McpConnectionCard {...props} servicesRevision="updated-service" />);
    await screen.findByTestId("mcp-connection-url");
    await act(async () => oldVerify.resolve(verified));
    expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
  });

  it("handles info and verification failures and supports retry without a false success", async () => {
    vi.mocked(api.mcpConnectionInfo).mockRejectedValueOnce("Details unavailable");
    vi.mocked(api.verifyMcpConnection).mockRejectedValueOnce("Hub timed out");
    render(<McpConnectionCard {...props} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Details unavailable");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.retry") }));
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Hub timed out");
    expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByText(tr("mcp.connection.verified"))).toBeVisible();
  });

  it("keeps the configuration visible while Hub verification is disabled for a stopped Hub", async () => {
    vi.mocked(api.mcpConnectionInfo).mockResolvedValue({ ...info(), hub_running: false });
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    expect(screen.getByRole("button", { name: tr("mcp.connection.verify") })).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("mcp.connection.preview") })).toBeEnabled();
    expect(screen.getByText(tr("mcp.connection.hubStopped"))).toBeVisible();
  });

  it("retranslates the connection flow in all four locales", async () => {
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    for (const locale of ["zh-CN", "zh-TW", "ja-JP", "en-US"] as const) {
      await act(() => changeLocale(locale));
      expect(screen.getByText(tr("mcp.connection.title"))).toBeVisible();
      expect(screen.getByRole("button", { name: tr("mcp.connection.preview") })).toBeVisible();
      expect(tr("mcp.connection.verificationScope")).not.toContain("mcp.connection.");
    }
  });

  it("discards Hub verification for a different URL and explains an empty external tool catalog", async () => {
    vi.mocked(api.verifyMcpConnection)
      .mockResolvedValueOnce({ ...verified, url: info("two").url })
      .mockResolvedValueOnce({ ...verified, external_tools: [] });
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(tr("mcp.connection.urlChanged"));
    expect(screen.queryByText(tr("mcp.connection.verified"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.verify") }));
    expect(await screen.findByText(tr("mcp.connection.noExternalTools"))).toBeVisible();
  });

  it("lets users cancel the review before changing workspaces and resets Home approval", async () => {
    const user = userEvent.setup();
    render(<McpConnectionCard {...props} />);
    await screen.findByTestId("mcp-connection-url");
    expect(
      screen.getByText(tr("mcp.connection.homeScope", { workspace: "Workspace one" })),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    fireEvent.click(screen.getByRole("button", { name: tr("common.cancel") }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("combobox", { name: tr("mcp.connection.workspace") }));
    await user.click(await screen.findByRole("option", { name: "Workspace two" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-connection-url")).toHaveTextContent(info("two").url),
    );
    fireEvent.click(screen.getByRole("button", { name: tr("mcp.connection.preview") }));
    expect(await screen.findByRole("button", { name: tr("mcp.connection.apply") })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: tr("changes.homeApproval") })).not.toBeChecked();
    expect(api.planMcpConnection).toHaveBeenLastCalledWith("two", "codex");
  });
});
