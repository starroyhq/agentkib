// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpManagedEntry } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
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

function entry(enabled: boolean, inherited: boolean): McpManagedEntry {
  return {
    config: {
      id: "reviewed-service",
      name: "Reviewed service",
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

async function renderRow(enabled: boolean, inherited: boolean) {
  vi.mocked(api.mcpManagementState).mockResolvedValue({
    revision: "reviewed-revision",
    servers: [entry(enabled, inherited)],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AppDialogProvider>
        <McpManagementPanel
          project="/workspace"
          workspaces={[]}
          drafts={new Map()}
          onChanged={async () => {}}
        />
      </AppDialogProvider>
    </QueryClientProvider>,
  );
  const row = (await screen.findByText("Reviewed service", { selector: "strong" })).closest("tr")!;
  const buttons = within(row).getAllByRole("button");
  const primary = enabled ? buttons[0] : undefined;
  const more = buttons.at(-1)!;
  return { primary, more, toggle: within(row).getByRole("switch") };
}

beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MCP action focus in a horizontally scrollable table", () => {
  it.each([
    ["enabled", true, false],
    ["disabled", false, false],
    ["inherited", false, true],
  ] as const)(
    "reveals the available %s actions without dispatching them",
    async (_state, enabled, inherited) => {
      const { primary, more, toggle } = await renderRow(enabled, inherited);
      const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
      const user = userEvent.setup();
      const first = primary ?? more;
      for (let index = 0; index < 40 && document.activeElement !== first; index++) await user.tab();
      expect(first).toHaveFocus();
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(first);
      if (primary) {
        await user.tab();
        expect(toggle).toHaveFocus();
        expect(scroll.mock.contexts.at(-1)).toBe(toggle);
        await user.tab();
      }
      expect(more).toHaveFocus();
      expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
      expect(scroll.mock.contexts.at(-1)).toBe(more);
      expect(api.probeMcpRuntime).not.toHaveBeenCalled();
      expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
      expect(api.removeMcpConfiguration).not.toHaveBeenCalled();
      expect(api.startMcpOAuth).not.toHaveBeenCalled();
    },
  );

  it("keeps portal menu focus outside the table reveal handler and returns to the trigger", async () => {
    const { more } = await renderRow(true, false);
    const user = userEvent.setup();
    act(() => more.focus());
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    const menuScroll = vi.spyOn(menu, "scrollIntoView");
    fireEvent.focus(menu);
    expect(menuScroll).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(more).toHaveFocus();
    expect(api.probeMcpRuntime).not.toHaveBeenCalled();
    expect(api.saveMcpConfiguration).not.toHaveBeenCalled();
    expect(api.startMcpOAuth).not.toHaveBeenCalled();
  });
});
