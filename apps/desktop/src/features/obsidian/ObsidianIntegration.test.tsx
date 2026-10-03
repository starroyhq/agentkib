// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ObsidianIntegration } from "@/core/types";
import { ObsidianSettingsCard, WorkspaceObsidianCard } from "./ObsidianIntegration";

vi.mock("@/core/api", () => ({
  api: { obsidianIntegration: vi.fn(), linkWorkspaceToObsidian: vi.fn() },
}));

describe("WorkspaceObsidianCard", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    vi.mocked(api.obsidianIntegration).mockReset();
  });
  afterEach(cleanup);

  it("defaults to the first vault and reloads the shared integration after linking", async () => {
    const integration = {
      installation: { installed: true, cli_available: true },
      vaults: [
        { name: "Notes", path: "/vaults/notes", source: "config" },
        { name: "Work", path: "/vaults/work", source: "config" },
      ],
      workspace_links: [],
    } as unknown as ObsidianIntegration;
    vi.mocked(api.obsidianIntegration).mockResolvedValue(integration);
    vi.mocked(api.linkWorkspaceToObsidian).mockResolvedValue(undefined as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <WorkspaceObsidianCard workspaceId="ws" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: tr("obsidian.link") }));
    await waitFor(() =>
      expect(api.linkWorkspaceToObsidian).toHaveBeenCalledWith("ws", "/vaults/notes", ""),
    );
    await waitFor(() => expect(api.obsidianIntegration).toHaveBeenCalledTimes(2));
  });
});

describe("ObsidianSettingsCard locale changes", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    vi.mocked(api.obsidianIntegration).mockReset();
  });
  afterEach(cleanup);

  it("retranslates loading and an existing structured error without restarting the request", async () => {
    vi.mocked(api.obsidianIntegration).mockRejectedValue({ key: "obsidian.notInstalled" });
    render(<ObsidianSettingsCard />);
    expect((await screen.findByRole("alert")).textContent).toContain(tr("obsidian.notInstalled"));
    const addVault = screen.getByRole("button", { name: tr("obsidian.addVault") });

    await act(() => changeLocale("zh-TW"));

    expect(screen.getByRole("alert").textContent).toContain(tr("obsidian.notInstalled"));
    expect(screen.getByRole("status", { name: tr("common.loading") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("obsidian.addVault") })).toBe(addVault);
    expect(api.obsidianIntegration).toHaveBeenCalledOnce();
  });
});
