// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import type { SkillInventory } from "@/core/types";
import { SkillHubPage, type SkillHubSection } from "./SkillHubPage";

const mocks = vi.hoisted(() => ({
  installedSkills: vi.fn(),
  removedSkills: vi.fn(),
  skillInventory: vi.fn(),
  skillDeployments: vi.fn(),
  skillSyncState: vi.fn(),
  skillCatalog: vi.fn(),
  prepareSkillImport: vi.fn(),
  skillDetail: vi.fn(),
  readSkillDetailFile: vi.fn(),
}));
vi.mock("@/core/api", () => ({ api: mocks }));

const observation: SkillInventory["observations"][number] = {
  id: "native-one",
  name: "release-notes",
  path: "/fixture/project/.claude/skills/release-notes",
  resolved_path: "/fixture/project/.claude/skills/release-notes",
  scope: "workspace",
  workspace_id: "project",
  agents: ["claude-code"],
  kind: "directory",
  status: "visible",
  owner: "external",
  library_id: null,
  diagnostics: [],
};
const inventory: SkillInventory = { observations: [observation], warnings: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function mount(section?: SkillHubSection) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSectionChange = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <AppDialogProvider>
        <SkillHubPage
          section={section}
          onSectionChange={onSectionChange}
          workspaces={[
            {
              id: "project",
              name: "Demo project",
              path: "/fixture/project",
              status: "healthy",
              asset_count: 0,
              warning_count: 0,
              sources: [],
            },
          ]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockResolvedValue(undefined)}
        />
      </AppDialogProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, onSectionChange };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  mocks.installedSkills.mockResolvedValue([]);
  mocks.removedSkills.mockResolvedValue([]);
  mocks.skillInventory.mockResolvedValue(inventory);
  mocks.skillDeployments.mockResolvedValue([]);
  mocks.skillSyncState.mockResolvedValue({
    library: [],
    observations: [],
    deployments: [],
    warnings: [],
  });
  mocks.skillCatalog.mockResolvedValue({ entries: [], cached_at: "2026-10-22", stale: false });
});
afterEach(cleanup);

describe("v15 Skill library", () => {
  it("defaults to populated usage when the library is empty", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Usage locations 1/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(await screen.findByText("release-notes")).toBeVisible();
    expect(mocks.skillCatalog).not.toHaveBeenCalled();
    for (const name of [/Skill library 0/, /Usage locations 1/]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.querySelector('[data-slot="badge"]')).toBeNull();
      expect(tab.querySelector(".tabular-nums")).toHaveClass("text-muted-foreground");
    }
  });
  it.each(["library", "discover"] as const)("keeps an explicit %s destination", async (section) => {
    mount(section);
    await waitFor(() => expect(mocks.skillInventory).toHaveBeenCalled());
    const tab = section === "library" ? /Skill library 0/ : "Discover Skills";
    expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  });
  it("waits for delayed inventory and does not overwrite a manual tab choice", async () => {
    const pending = deferred<SkillInventory>();
    mocks.skillInventory.mockReturnValueOnce(pending.promise);
    mount();
    await userEvent.setup().click(screen.getByRole("tab", { name: "Discover Skills" }));
    await act(async () => pending.resolve(inventory));
    expect(screen.getByRole("tab", { name: "Discover Skills" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("does not flash an empty-library result while the default destination is still loading", async () => {
    const pending = deferred<SkillInventory>();
    mocks.skillInventory.mockReturnValueOnce(pending.promise);
    mount();
    await waitFor(() => expect(mocks.removedSkills).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("The Skill library is empty")).toBeNull();
    await act(async () => pending.resolve(inventory));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Usage locations 1/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });
  it("does not derive an empty-library destination from a failed inventory", async () => {
    mocks.skillInventory.mockRejectedValue(new Error("Inventory unavailable"));
    mount();
    expect(await screen.findByText(/Inventory unavailable/)).toBeVisible();
    expect(screen.getByRole("tab", { name: /Skill library 0/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("keeps an automatic initial destination stable after a library refresh", async () => {
    const view = mount();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Usage locations 1/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await act(async () =>
      view.client.setQueryData(["skills", "library"], {
        installed: [
          {
            name: "saved",
            display_name: "Saved",
            description: "",
            path: "/fixture/library/saved",
            size: 1,
            status: "current",
            can_rollback: false,
          },
        ],
        removed: [],
      }),
    );
    expect(screen.getByRole("tab", { name: /Usage locations 1/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("shows one empty-library card without filters and keeps maintenance in More", async () => {
    mount("library");
    expect(await screen.findByText("The Skill library is empty")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: tr("skills.manager.searchLibrary") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("skills.checkUpdates") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("skills.sync.policy") })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: tr("common.moreActions") }));
    expect(await screen.findByRole("menuitem", { name: tr("skills.sync.policy") })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: tr("skills.sync.history") })).toBeVisible();
  });
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders translated source filters and native actions in %s",
    async (locale) => {
      await initializeI18n(locale);
      mount("workspace");
      expect(await screen.findByText("release-notes")).toBeVisible();
      expect(screen.getByRole("combobox", { name: tr("skills.manager.scope") })).toHaveTextContent(
        tr("skills.manager.allSources"),
      );
      expect(screen.getByRole("combobox", { name: tr("workspace.allAgents") })).toHaveTextContent(
        tr("workspace.allAgents"),
      );
      expect(screen.queryByText("all", { exact: true })).toBeNull();
      expect(screen.queryByText("external", { exact: true })).toBeNull();
      expect(screen.getAllByTitle(observation.path)).toHaveLength(1);
      expect(
        screen.getByText(tr("skills.manager.projectSource", { name: "Demo project" })),
      ).toBeVisible();
      expect(screen.getAllByText(tr("skills.manager.inventoryNotice"))).toHaveLength(1);
      expect(screen.getByRole("button", { name: tr("skills.manager.viewNative") })).toHaveClass(
        "border-border",
        "bg-background",
      );
      expect(screen.getByRole("button", { name: tr("skills.manager.addNative") })).toHaveClass(
        "border-border",
        "bg-background",
      );
      expect(
        screen.getByRole("button", { name: tr("skills.imports.countedTitle", { count: 1 }) }),
      ).toHaveClass("bg-primary");
    },
  );
  it("counts only readable import groups while retaining an external alias of an active deployment", async () => {
    mocks.skillInventory.mockResolvedValue({
      observations: [
        { ...observation, resolved_path: "/fixture/managed" },
        {
          ...observation,
          id: "alias",
          path: "/fixture/.agents/skills/release-notes",
          resolved_path: "/fixture/managed",
        },
        {
          ...observation,
          id: "broken",
          path: "/fixture/broken",
          resolved_path: null,
          status: "broken-link",
        },
        { ...observation, id: "managed", path: "/fixture/managed", owner: "agentkib" },
      ],
      warnings: [],
    });
    mocks.skillDeployments.mockResolvedValue([
      {
        id: "managed",
        library_id: "saved",
        library_root: "/fixture/library",
        source_is_current_library: true,
        package_name: "Saved",
        package_hash: "hash",
        scope: "workspace",
        workspace_id: "project",
        scope_root: "/fixture",
        target: "/fixture/managed",
        agents: ["codex"],
        visible_to: ["codex"],
        status: "active",
        diagnostics: [],
        previous_hash: null,
        operation_id: "managed",
        updated_at: "2026-10-22",
      },
    ]);
    mount("workspace");
    expect(
      await screen.findByRole("button", { name: "Import from local Agents (1)" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Import from local Agents (2)" })).toBeNull();
  });
  it("opens discovery from the empty card without adding redundant filters", async () => {
    mocks.skillInventory.mockResolvedValue({ observations: [], warnings: [] });
    mount();
    expect(
      await screen.findByRole("button", { name: "Import from local Agents (0)" }),
    ).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Browse curated Skills" }));
    expect(screen.getByRole("tab", { name: "Discover Skills" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByRole("textbox", { name: tr("skills.addFromGithub") })).toBeVisible();
  });
});
