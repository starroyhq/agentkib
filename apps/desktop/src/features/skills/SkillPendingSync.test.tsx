// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillDeployment, SkillSyncState } from "@/core/types";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { SkillHubPage, type SkillHubSection } from "./SkillHubPage";

vi.mock("@/core/api", () => ({
  api: {
    installedSkills: vi.fn(),
    removedSkills: vi.fn(),
    skillInventory: vi.fn(),
    skillDeployments: vi.fn(),
    skillSyncState: vi.fn(),
    skillCatalog: vi.fn(),
    discoverSkills: vi.fn(),
    prepareSkillSync: vi.fn(),
    applySkillSync: vi.fn(),
    discardSkillPreview: vi.fn(),
    readSkillPreviewFile: vi.fn(),
    prepareSkillDeployment: vi.fn(),
    applySkillDeployment: vi.fn(),
  },
}));
const syncStates = ["incoming", "conflict", "missing", "blocked", "unverified"] as const;
function deployment(id: string, status = "active"): SkillDeployment {
  return {
    id,
    library_id: `library-${id}`,
    library_root: "/library",
    source_is_current_library: true,
    package_name: `Skill ${id}`,
    package_hash: "base",
    scope: "personal",
    workspace_id: null,
    scope_root: "/native",
    target: `/native/skills/${id}`,
    agents: ["codex"],
    visible_to: ["codex"],
    status,
    diagnostics: [],
    previous_hash: null,
    operation_id: `operation-${id}`,
    updated_at: "2026-10-16T00:00:00Z",
  };
}
function syncRow(
  item: SkillDeployment,
  sync_state: SkillSyncState["deployments"][number]["sync_state"],
): SkillSyncState["deployments"][number] {
  return {
    ...item,
    base_hash: "base",
    library_hash: "base",
    target_hash: "edited",
    sync_state,
    baseline_available: true,
    owner_key: `owner-${item.id}`,
    target_key: `target-${item.id}`,
    policy: null,
  };
}
function configure(
  deployments: SkillDeployment[],
  rows = deployments.map((item) => syncRow(item, "incoming")),
) {
  const state: SkillSyncState = { library: [], observations: [], warnings: [], deployments: rows };
  vi.mocked(api.skillDeployments).mockResolvedValue(deployments);
  vi.mocked(api.skillSyncState).mockResolvedValue(state);
  vi.mocked(api.installedSkills).mockResolvedValue(
    deployments.map((item) => ({
      name: item.library_id,
      display_name: item.package_name,
      description: "",
      path: `/library/${item.library_id}`,
      size: 1,
      status: "current",
      can_rollback: false,
    })),
  );
  return state;
}
function mount(section?: SkillHubSection) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSectionChange = vi.fn();
  const page = (controlledSection?: SkillHubSection) => (
    <QueryClientProvider client={client}>
      <AppDialogProvider>
        <SkillHubPage
          section={controlledSection}
          onSectionChange={onSectionChange}
          workspaces={[]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockResolvedValue(undefined)}
        />
      </AppDialogProvider>
    </QueryClientProvider>
  );
  const view = render(page(section));
  return {
    ...view,
    client,
    onSectionChange,
    changeSection: (next: SkillHubSection) => view.rerender(page(next)),
  };
}
async function pendingButton(count = 1) {
  return screen.findByRole("button", { name: tr("skills.sync.pending", { count }) });
}
async function openPending(count = 1) {
  await userEvent.setup().click(await pendingButton(count));
  const region = await screen.findByRole("region", { name: tr("skills.sync.pending", { count }) });
  await waitFor(() => expect(within(region).getByRole("heading")).toHaveFocus());
  return region;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  vi.mocked(api.installedSkills).mockResolvedValue([]);
  vi.mocked(api.removedSkills).mockResolvedValue([]);
  vi.mocked(api.skillInventory).mockResolvedValue({ observations: [], warnings: [] });
  vi.mocked(api.skillCatalog).mockResolvedValue({
    entries: [],
    cached_at: "2026-10-16T00:00:00Z",
    stale: false,
  });
  vi.mocked(api.discardSkillPreview).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("pending synchronization navigation", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "is keyboard reachable and opens only the actual pending rows in %s",
    async (locale) => {
      await initializeI18n(locale);
      const item = deployment("incoming");
      configure(
        [item, deployment("current")],
        [syncRow(item, "incoming"), syncRow(deployment("current"), "current")],
      );
      mount();
      const button = await pendingButton();
      const user = userEvent.setup();
      for (let step = 0; step < 12 && document.activeElement !== button; step++) await user.tab();
      expect(button).toHaveFocus();
      await user.keyboard("{Enter}");
      const region = await screen.findByRole("region", {
        name: tr("skills.sync.pending", { count: 1 }),
      });
      await waitFor(() => expect(within(region).getByRole("heading")).toHaveFocus());
      expect(region).toHaveTextContent(tr("skills.sync.pendingDescription"));
      expect(tr("skills.sync.pendingDescription")).not.toContain("skills.sync.");
      expect(within(region).getByText(item.target)).toBeVisible();
      expect(within(region).queryByText("Skill current", { selector: "strong" })).toBeNull();
      expect(
        within(region).getByRole("button", { name: tr("skills.sync.operation.pull") }),
      ).toBeEnabled();
      expect(api.prepareSkillSync).not.toHaveBeenCalled();
      expect(api.applySkillSync).not.toHaveBeenCalled();
      button.focus();
      await user.keyboard(" ");
      expect(button).toHaveAttribute("aria-pressed", "false");
      const all = screen.getByRole("region", { name: tr("skills.workspaceUsage") });
      expect(within(all).getByText("Skill current", { selector: "strong" })).toBeVisible();
    },
  );

  it("uses the original five-state and lifecycle count and retains the existing recovery/bind actions", async () => {
    const pending = syncStates.map((state) => ({
      ...deployment(state),
      ...(state === "unverified" ? { library_root: undefined } : {}),
    }));
    const recovery = deployment("recovery", "recovery-required");
    const excluded = [
      deployment("current"),
      deployment("outgoing"),
      deployment("converged"),
      deployment("inactive", "inactive"),
      deployment("lifecycle-inactive"),
    ];
    const rows = [
      ...pending.map((item, index) => syncRow(item, syncStates[index])),
      syncRow(recovery, "blocked"),
      ...excluded.map((item, index) => ({
        ...syncRow(
          item,
          (["current", "outgoing", "converged", "incoming", "incoming"] as const)[index],
        ),
        ...(item.id === "lifecycle-inactive" ? { lifecycle_status: "inactive" as const } : {}),
      })),
    ];
    configure([...pending, recovery, ...excluded], rows);
    vi.mocked(api.skillInventory).mockResolvedValue({
      observations: [
        {
          id: "external",
          name: "External copy",
          path: "/external/copy",
          resolved_path: "/external/copy",
          scope: "personal",
          workspace_id: null,
          agents: ["codex"],
          kind: "directory",
          status: "visible",
          owner: "external",
          library_id: null,
          diagnostics: [],
        },
      ],
      warnings: [],
    });
    mount();
    const region = await openPending(6);
    for (const item of [...pending, recovery])
      expect(within(region).getByText(item.package_name, { selector: "strong" })).toBeVisible();
    for (const item of excluded)
      expect(within(region).queryByText(item.package_name, { selector: "strong" })).toBeNull();
    expect(within(region).queryByText("External copy")).toBeNull();
    for (const key of [
      "skills.sync.operation.pull",
      "skills.sync.reviewConflict",
      "skills.sync.operation.restore",
      "skills.sync.operation.bind",
      "skills.manager.operation.recover",
    ])
      expect(within(region).getByRole("button", { name: tr(key) })).toBeVisible();
    expect(api.prepareSkillSync).not.toHaveBeenCalled();
    expect(api.prepareSkillDeployment).not.toHaveBeenCalled();
    expect(api.applySkillDeployment).not.toHaveBeenCalled();
  });

  it("overrides old usage filters while pending and restores them when viewing all", async () => {
    const item = deployment("incoming");
    const other = { ...deployment("current"), visible_to: ["claude-code" as const] };
    configure([item, other], [syncRow(item, "incoming"), syncRow(other, "current")]);
    mount("workspace");
    const user = userEvent.setup();
    const search = await screen.findByRole("textbox", { name: tr("skills.search") });
    await user.type(search, "does-not-match");
    await user.click(screen.getByRole("combobox", { name: tr("skills.manager.scope") }));
    await user.click(await screen.findByRole("option", { name: tr("skills.manager.project") }));
    const selectedScope = screen.getByRole("combobox", {
      name: tr("skills.manager.scope"),
    }).textContent;
    await user.click(screen.getByRole("combobox", { name: tr("workspace.allAgents") }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));
    const selectedAgent = screen.getByRole("combobox", {
      name: tr("workspace.allAgents"),
    }).textContent;
    const region = await openPending();
    expect(within(region).getByText(item.target)).toBeVisible();
    expect(within(region).queryByRole("textbox", { name: tr("skills.search") })).toBeNull();
    await user.click(within(region).getByRole("button", { name: tr("skills.sync.showAllUsage") }));
    const all = screen.getByRole("region", { name: tr("skills.workspaceUsage") });
    expect(within(all).getByRole("textbox", { name: tr("skills.search") })).toHaveValue(
      "does-not-match",
    );
    expect(
      within(all).getByRole("combobox", { name: tr("skills.manager.scope") }).textContent,
    ).toBe(selectedScope);
    expect(within(all).getByRole("combobox", { name: tr("workspace.allAgents") }).textContent).toBe(
      selectedAgent,
    );
    expect(within(all).queryByText(item.target)).toBeNull();
    expect(within(all).getByRole("heading")).toHaveFocus();
  });

  it("requests the existing controlled workspace tab and focuses only after the parent accepts it", async () => {
    const item = deployment("incoming");
    configure([item]);
    const view = mount("library");
    await userEvent.setup().click(await pendingButton());
    expect(view.onSectionChange).toHaveBeenCalledExactlyOnceWith("workspace");
    expect(screen.queryByRole("region")).toBeNull();
    view.changeSection("workspace");
    const region = await screen.findByRole("region", {
      name: tr("skills.sync.pending", { count: 1 }),
    });
    await waitFor(() => expect(within(region).getByRole("heading")).toHaveFocus());
    expect(view.onSectionChange).toHaveBeenCalledTimes(1);
    view.changeSection("discover");
    expect(screen.getByRole("tab", { name: tr("skills.discover") })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    view.changeSection("workspace");
    expect(
      screen.getByRole("region", { name: tr("skills.sync.pending", { count: 1 }) }),
    ).toBeVisible();
  });

  it.each(["missing", "target", "library", "inactive"])(
    "names a pending item but does not attach controls to %s metadata",
    async (difference) => {
      const item = deployment("incoming");
      const current =
        difference === "missing"
          ? []
          : [
              {
                ...item,
                package_name: "Unrelated deployment",
                ...(difference === "target"
                  ? { target: "/different/location" }
                  : difference === "library"
                    ? { library_id: "different-library" }
                    : { status: "inactive" }),
              },
            ];
      configure(current, [syncRow(item, "incoming")]);
      mount();
      const region = await openPending();
      expect(region).toHaveTextContent(item.package_name);
      expect(region).toHaveTextContent(item.target);
      expect(region).toHaveTextContent(tr("skills.sync.pendingUnavailable"));
      expect(region).not.toHaveTextContent("Unrelated deployment");
      expect(
        within(region).queryByRole("button", { name: tr("skills.sync.operation.pull") }),
      ).toBeNull();
      expect(region).not.toHaveTextContent(tr("skills.sync.noPending"));
      expect(api.prepareSkillSync).not.toHaveBeenCalled();
    },
  );

  it("refreshes pending identities and keeps an empty pending view accurate when work is resolved", async () => {
    const item = deployment("incoming");
    configure([], [syncRow(item, "incoming")]);
    mount();
    const region = await openPending();
    expect(region).toHaveTextContent(tr("skills.sync.pendingUnavailable"));
    configure([item], [syncRow(item, "current")]);
    await userEvent
      .setup()
      .click(within(region).getByRole("button", { name: tr("skills.manager.refresh") }));
    await screen.findByText(tr("skills.sync.noPending"));
    expect(
      screen.queryByRole("button", { name: tr("skills.sync.pending", { count: 1 }) }),
    ).toBeNull();
    expect(screen.queryByText(tr("skills.sync.pendingUnavailable"))).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: tr("skills.sync.showAllUsage") }));
    expect(screen.getByText(item.target)).toBeVisible();
    expect(api.applySkillSync).not.toHaveBeenCalled();
  });

  it("retains a pending discovery request and its draft while navigating, without enabling synchronization writes", async () => {
    const item = deployment("incoming");
    configure([item]);
    const request = deferred<Awaited<ReturnType<typeof api.discoverSkills>>>();
    vi.mocked(api.discoverSkills).mockReturnValue(request.promise);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: tr("skills.discover") }));
    const input = screen.getByRole("textbox", { name: tr("skills.addFromGithub") });
    await user.type(input, "https://github.com/example/repo");
    await user.click(screen.getByRole("button", { name: tr("skills.inspectUrl") }));
    const region = await openPending();
    expect(
      within(region).getByRole("button", { name: tr("skills.sync.operation.pull") }),
    ).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: tr("skills.discover") }));
    const restored = screen.getByRole("textbox", { name: tr("skills.addFromGithub") });
    expect(restored).toHaveValue("https://github.com/example/repo");
    expect(restored).toBeDisabled();
    await act(async () => request.resolve([]));
    await waitFor(() => expect(restored).toBeEnabled());
    expect(api.discoverSkills).toHaveBeenCalledOnce();
    expect(api.prepareSkillSync).not.toHaveBeenCalled();
  });

  it("keeps the pending destination loading until deployment identities are available", async () => {
    const item = deployment("incoming");
    configure([item]);
    const read = deferred<SkillDeployment[]>();
    vi.mocked(api.skillDeployments).mockReturnValue(read.promise);
    mount();
    const region = await openPending();
    expect(await within(region).findByRole("status", { name: tr("common.loading") })).toBeVisible();
    expect(region).not.toHaveTextContent(tr("skills.sync.pendingUnavailable"));
    expect(region).not.toHaveTextContent(tr("skills.sync.noPending"));
    await act(async () => read.resolve([item]));
    expect(await within(region).findByText(item.target)).toBeVisible();
    expect(
      within(region).getByRole("button", { name: tr("skills.sync.operation.pull") }),
    ).toBeEnabled();
  });

  it("retains the failed inventory explanation and refreshes the same pending destination", async () => {
    const item = deployment("incoming");
    configure([item]);
    vi.mocked(api.skillDeployments).mockRejectedValue(
      new Error("Deployment inventory unavailable"),
    );
    mount();
    const region = await openPending();
    expect(await screen.findByText(/Deployment inventory unavailable/)).toBeVisible();
    expect(region).toHaveTextContent(tr("skills.sync.pendingUnavailable"));
    expect(
      within(region).queryByRole("button", { name: tr("skills.sync.operation.pull") }),
    ).toBeNull();
    vi.mocked(api.skillDeployments).mockResolvedValue([item]);
    await userEvent
      .setup()
      .click(within(region).getByRole("button", { name: tr("skills.manager.refresh") }));
    await waitFor(() =>
      expect(
        within(region).getByRole("button", { name: tr("skills.sync.operation.pull") }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText(/Deployment inventory unavailable/)).toBeNull();
    expect(region).not.toHaveTextContent(tr("skills.sync.pendingUnavailable"));
    expect(api.prepareSkillSync).not.toHaveBeenCalled();
    expect(api.applySkillSync).not.toHaveBeenCalled();
  });

  it("opens the original review dialog from a listed row and still requires personal-directory approval", async () => {
    const item = deployment("incoming");
    configure([item]);
    vi.mocked(api.prepareSkillSync).mockResolvedValue({
      token: "reviewed",
      operation: "pull",
      library_id: item.library_id,
      requires_home_approval: true,
      targets: [
        {
          target_id: "target",
          deployment_id: item.id,
          path: item.target,
          base_hash: "base",
          library_hash: "base",
          target_hash: "edited",
          state: "incoming",
          added: ["SKILL.md"],
          modified: [],
          removed: [],
          conflicts: [],
        },
      ],
      expires_at: "2030-01-01T00:00:00Z",
    });
    mount();
    const region = await openPending();
    await userEvent
      .setup()
      .click(within(region).getByRole("button", { name: tr("skills.sync.operation.pull") }));
    const dialog = await screen.findByRole("dialog", { name: tr("skills.sync.operation.pull") });
    await waitFor(() =>
      expect(api.prepareSkillSync).toHaveBeenCalledExactlyOnceWith({
        operation: "pull",
        deployment_id: item.id,
      }),
    );
    expect(within(dialog).getByRole("button", { name: tr("skills.sync.confirm") })).toBeDisabled();
    await userEvent
      .setup()
      .click(within(dialog).getByRole("checkbox", { name: tr("skills.manager.approveHome") }));
    expect(within(dialog).getByRole("button", { name: tr("skills.sync.confirm") })).toBeEnabled();
    expect(api.applySkillSync).not.toHaveBeenCalled();
  });
});
