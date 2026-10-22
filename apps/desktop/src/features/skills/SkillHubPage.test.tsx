// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AppDialogProvider } from "@/components/AppDialogProvider";
import { changeLocale, initializeI18n, localizeMessage, tr } from "@/core/i18n";
import type {
  InstalledSkill,
  SkillCandidate,
  SkillDeployment,
  SkillOperationPreview,
} from "@/core/types";
import { SkillHubPage, type SkillHubSection } from "./SkillHubPage";

// 每个用例一个新的 QueryClient，避免技能库缓存在用例之间泄漏。
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function libraryAction(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole("button", { name: /^More actions · / }));
  await user.click(await screen.findByRole("menuitem", { name: label }));
}

const mocks = vi.hoisted(() => ({
  installedSkills: vi.fn(),
  removedSkills: vi.fn(),
  skillCatalog: vi.fn(),
  discoverSkills: vi.fn(),
  prepareSkillInstall: vi.fn(),
  prepareSkillUpdate: vi.fn(),
  listSkillVersions: vi.fn(),
  prepareSkillVersionChange: vi.fn(),
  discardSkillPreview: vi.fn(),
  prepareSkillImports: vi.fn(),
  applySkillImports: vi.fn(),
  applySkillOperation: vi.fn(),
  checkSkillUpdates: vi.fn(),
  rollbackSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  restoreSkill: vi.fn(),
  skillInventory: vi.fn(),
  skillDeployments: vi.fn(),
  skillTargets: vi.fn(),
  skillSyncState: vi.fn(),
  skillDetail: vi.fn(),
  readSkillDetailFile: vi.fn(),
  prepareSkillImport: vi.fn(),
  readSkillPreviewFile: vi.fn(),
  prepareSkillDeployment: vi.fn(),
  applySkillDeployment: vi.fn(),
}));

vi.mock("@/core/api", () => ({ api: mocks }));

const candidate: SkillCandidate = {
  name: "skill-installer",
  description: "Install Skills from curated sources or GitHub.",
  license: "Apache-2.0",
  source: {
    kind: "openai-curated",
    repository: "openai/skills",
    ref: "main",
    path: "skills/.curated/skill-installer",
    resolved_commit: "0123456789abcdef",
    tree_sha: "tree-sha",
  },
};

const preview: SkillOperationPreview = {
  token: "preview-token",
  operation: "install",
  skill: candidate,
  files: [{ path: "SKILL.md", size: 128, executable: false }],
  added: ["SKILL.md"],
  modified: [],
  removed: [],
  total_size: 128,
  local_modified: false,
  expires_at: "2030-01-01T00:00:00Z",
};

const librarySkill: InstalledSkill = {
  name: "library-reviewer-id",
  display_name: "Library Reviewer",
  description: "Review code",
  path: "/library/library-reviewer-id",
  size: 128,
  status: "current",
  can_rollback: true,
};
const libraryDeployment: SkillDeployment = {
  id: "deployment-1",
  library_id: librarySkill.name,
  source_is_current_library: true,
  package_name: librarySkill.display_name,
  package_hash: "deployed-hash",
  scope: "personal",
  workspace_id: null,
  scope_root: "/native",
  target: "/native/skills/library-reviewer-id",
  agents: ["codex"],
  visible_to: ["codex"],
  status: "active",
  diagnostics: [],
  previous_hash: null,
  operation_id: "deploy-operation",
  updated_at: "2026-10-16T00:00:00Z",
};

describe("SkillHubPage", () => {
  it("keeps deployment primary and groups library maintenance actions in a menu", async () => {
    const user = userEvent.setup();
    mocks.installedSkills.mockResolvedValue([
      {
        ...librarySkill,
        status: "update-available",
        source: candidate.source,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    const name = await screen.findByRole("heading", { name: librarySkill.display_name });
    const card = within(name.closest<HTMLElement>('[data-slot="card"]')!);
    expect(card.getAllByRole("button")).toHaveLength(3);
    expect(card.getByRole("button", { name: tr("skills.manager.deploy") })).toHaveClass(
      "bg-primary",
    );
    expect(card.queryByRole("button", { name: tr("skills.update") })).toBeNull();
    await user.click(card.getByRole("button", { name: /^More actions/ }));
    for (const key of [
      "skills.versions.choose",
      "skills.update",
      "skills.rollback",
      "skills.moveToTrash",
    ])
      expect(await screen.findByRole("menuitem", { name: tr(key) })).toBeVisible();
  });
  it("accepts externally controlled sections without rewriting them or requiring a router", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({ entries: [], cached_at: "2026-10-16", stale: false });
    const onSectionChange = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (section: SkillHubSection) => (
      <QueryClientProvider client={client}>
        <AppDialogProvider>
          <SkillHubPage
            section={section}
            onSectionChange={onSectionChange}
            workspaces={[]}
            onOpen={vi.fn()}
            onReload={vi.fn()}
          />
        </AppDialogProvider>
      </QueryClientProvider>
    );
    const view = render(page("workspace"));
    expect(screen.getByRole("tab", { name: /Usage locations/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.setup().click(screen.getByRole("tab", { name: "Discover Skills" }));
    expect(onSectionChange).toHaveBeenCalledExactlyOnceWith("discover");
    expect(screen.getByRole("tab", { name: /Usage locations/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(mocks.skillCatalog).not.toHaveBeenCalled();
    view.rerender(page("discover"));
    await waitFor(() => expect(mocks.skillCatalog).toHaveBeenCalledOnce());
    expect(screen.getByRole("tab", { name: "Discover Skills" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    view.rerender(page("library"));
    expect(screen.getByRole("tab", { name: /Skill library/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(onSectionChange).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["en-US", "Skill library", "The Skill library is empty"],
    ["zh-CN", "技能库", "技能库还是空的"],
    ["zh-TW", "技能庫", "技能庫還是空的"],
    ["ja-JP", "スキルライブラリ", "スキルライブラリは空です"],
  ] as const)("names the library consistently in %s", async (locale, label, empty) => {
    await initializeI18n(locale);
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    expect(await screen.findByText(empty)).toBeVisible();
    expect(screen.getByRole("tab", { name: `${label} 0` })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("heading", { name: new RegExp(label) })).toBeVisible();
    await initializeI18n("en-US");
  });
  it("shows failed update checks without claiming the Skill is current", async () => {
    const user = userEvent.setup();
    const skill = {
      name: "network-reviewer",
      display_name: "Network Reviewer",
      description: "",
      path: "/library/network-reviewer",
      size: 128,
      status: "current",
      source: candidate.source,
      can_rollback: false,
    };
    mocks.installedSkills.mockResolvedValue([skill]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.checkSkillUpdates.mockResolvedValue([
      { ...skill, update_check: "failed", update_error: "GitHub rate limit" },
    ]);
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={async () => {}} />
      </AppDialogProvider>,
    );
    await screen.findByText("Network Reviewer");
    await user.click(screen.getByRole("button", { name: tr("skills.checkUpdates") }));
    await screen.findByText(tr("skills.sync.checkFailed"));
    expect(screen.getByRole("status").textContent).toContain("GitHub rate limit");
    expect(screen.queryByText(tr("skills.status.current"))).toBeNull();
  });
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    mocks.discardSkillPreview.mockResolvedValue(undefined);
    mocks.skillInventory.mockResolvedValue({ observations: [], warnings: [] });
    mocks.skillDeployments.mockResolvedValue([]);
    mocks.skillTargets.mockResolvedValue([]);
    mocks.skillSyncState.mockResolvedValue({
      library: [],
      deployments: [],
      observations: [],
      warnings: [],
    });
    mocks.readSkillPreviewFile.mockResolvedValue({
      path: "SKILL.md",
      before: null,
      after: "Package instructions",
      binary: false,
      truncated: false,
    });
  });
  afterEach(async () => {
    cleanup();
    vi.clearAllMocks();
    await initializeI18n("en-US");
  });

  it("separates the AgentKib library from workspace usage", async () => {
    mocks.installedSkills.mockResolvedValue([
      {
        name: "local-reviewer",
        display_name: "local-reviewer",
        description: "Review local changes",
        path: "/tmp/.agentkib/skills/local-reviewer",
        size: 256,
        status: "unmanaged",
        can_rollback: false,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("local-reviewer")).toBeTruthy();
    expect(screen.getByText("Local · not managed by AgentKib")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Usage locations/ })).toBeTruthy();
    expect(screen.getByText(/not enabled for any Agent automatically/)).toBeTruthy();
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "keeps library and usage counts tied to their own lists in %s",
    async (locale) => {
      await initializeI18n(locale);
      mocks.installedSkills.mockResolvedValue([
        librarySkill,
        { ...librarySkill, name: "second-reviewer", display_name: "Second Reviewer" },
      ]);
      mocks.removedSkills.mockResolvedValue([]);
      mocks.skillDeployments.mockResolvedValue([libraryDeployment]);
      renderWithClient(
        <AppDialogProvider>
          <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
        </AppDialogProvider>,
      );
      await screen.findByText("Second Reviewer");
      expect(screen.getByRole("tab", { name: `${tr("skills.library")} 2` })).toBeVisible();
      expect(screen.getByRole("tab", { name: `${tr("skills.workspaceUsage")} 1` })).toBeVisible();
    },
  );

  it("combines source, package status and usage filters in My Skills", async () => {
    const local = {
      name: "local-reviewer",
      display_name: "local-reviewer",
      description: "Local review",
      path: "/library/local-reviewer",
      size: 20,
      status: "unmanaged",
      source: null,
      can_rollback: false,
    };
    mocks.installedSkills.mockResolvedValue([
      local,
      {
        ...local,
        name: "remote-reviewer",
        display_name: "remote-reviewer",
        status: "current",
        source: { ...candidate.source!, kind: "github" },
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillDeployments.mockResolvedValue([
      {
        id: "deployment",
        library_id: "remote-reviewer",
        source_is_current_library: true,
        scope: "personal",
        status: "active",
        target: "/native/remote-reviewer",
      },
      {
        id: "foreign-deployment",
        library_id: "local-reviewer",
        source_is_current_library: false,
        scope: "personal",
        status: "active",
        target: "/native/foreign-reviewer",
      },
    ]);
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    await screen.findByText("remote-reviewer");
    const user = userEvent.setup();
    const chooseFilter = async (label: string, option: string) => {
      const trigger = screen.getByRole("combobox", { name: label });
      await user.click(trigger);
      // Base UI defers pointer-triggered opening to an animation frame.
      await user.click(await screen.findByRole("option", { name: option }));
      await waitFor(() => {
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByRole("listbox")).toBeNull();
        expect(trigger.textContent).toContain(option);
      });
    };
    await chooseFilter(tr("catalog.source"), tr("skills.localSource"));
    expect(screen.queryByText("remote-reviewer")).toBeNull();
    expect(screen.getByText("local-reviewer")).toBeTruthy();
    await chooseFilter("Package status", tr("skills.status.current"));
    expect(screen.queryByText("local-reviewer")).toBeNull();
    await chooseFilter("Package status", "All statuses");
    expect(screen.getByText("local-reviewer")).toBeTruthy();
    await chooseFilter("Usage locations", "Personal");
    expect(screen.queryByText("local-reviewer")).toBeNull();
    await chooseFilter("Usage locations", "Not deployed");
    expect(screen.getByText("local-reviewer")).toBeTruthy();
  });

  it("copies an external package through review and preserves successful import warnings", async () => {
    mocks.installedSkills
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("Library refresh failed"));
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillInventory.mockResolvedValue({
      observations: [
        {
          id: "external-1",
          name: "external-reviewer",
          path: "/native/reviewer",
          resolved_path: "/cc-switch/reviewer",
          scope: "personal",
          workspace_id: null,
          agents: ["claude-code"],
          kind: "symlink",
          status: "observed",
          owner: "cc-switch",
          library_id: null,
          diagnostics: [],
        },
      ],
      warnings: ["A scan root was unavailable"],
    });
    mocks.prepareSkillImport.mockResolvedValue({
      ...preview,
      skill: { ...candidate, name: "external-reviewer", source: null },
    });
    mocks.applySkillOperation.mockResolvedValue({
      name: "imported-reviewer",
      display_name: "external-reviewer",
      path: "/library/imported-reviewer",
      description: "Copied package",
      size: 128,
      status: "unmanaged",
      source: null,
      can_rollback: false,
      warnings: ["Registry refresh failed after import"],
    });
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    expect(await screen.findByText("A scan root was unavailable")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Usage locations/ }));
    await user.click(await screen.findByRole("button", { name: "Add to library" }));
    expect(await screen.findByText("Review Skill package")).toBeTruthy();
    expect(mocks.prepareSkillImport).toHaveBeenCalledWith("external-1");
    await user.click(screen.getByRole("button", { name: "Add to Skill library" }));
    expect(await screen.findByText("Registry refresh failed after import")).toBeTruthy();
    expect(
      screen.getByText(tr("skills.manager.libraryAdded", { name: "external-reviewer" }), {
        exact: false,
      }),
    ).toBeTruthy();
    expect(mocks.applySkillOperation).toHaveBeenCalledWith("preview-token", false);
    await user.click(await screen.findByRole("button", { name: "Deploy to…" }));
    expect(await screen.findByRole("dialog", { name: "Deploy Skill" })).toBeTruthy();
    expect(mocks.skillTargets).toHaveBeenCalledTimes(1);
    expect(mocks.applySkillDeployment).not.toHaveBeenCalled();
  });

  it("exposes localized accessible names for discover inputs", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));

    try {
      for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("textbox", { name: tr("skills.addFromGithub") })).toBeTruthy();
        expect(screen.getByRole("textbox", { name: tr("skills.search") })).toBeTruthy();
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it.each([1, 2])(
    "keeps %i imported packages and their result when refresh fails",
    async (count) => {
      const names = Array.from({ length: count }, (_, index) => `reviewer-${index + 1}`);
      mocks.installedSkills
        .mockResolvedValueOnce([])
        .mockRejectedValue(new Error("Batch refresh failed"));
      mocks.removedSkills.mockResolvedValue([]);
      mocks.skillInventory.mockResolvedValue({
        observations: names.map((name) => ({
          id: name,
          name,
          path: `/native/${name}`,
          resolved_path: `/native/${name}`,
          agents: ["codex"],
          scope: "personal",
          workspace_id: null,
          kind: "directory",
          owner: "external",
          status: "observed",
          library_id: null,
          diagnostics: [],
        })),
        warnings: [],
      });
      mocks.prepareSkillImports.mockResolvedValue({
        token: "batch",
        expires_at: preview.expires_at,
        total_size: 128,
        items: names.map((name) => ({
          id: name,
          observation_ids: [name],
          paths: [`/native/${name}`],
          agents: ["codex"],
          resolved_path: `/native/${name}`,
          library_id: name,
          display_name: name,
          status: "ready",
          preview,
        })),
      });
      const imported = {
        name: "reviewer",
        display_name: "reviewer",
        description: "Imported package",
        path: "/library/reviewer",
        size: 128,
        status: "current",
        source: null,
        can_rollback: false,
      };
      mocks.applySkillImports.mockResolvedValue({
        token: "batch",
        items: names.map((name) => ({
          id: name,
          observation_ids: [name],
          status: "imported",
          library_id: name,
          skill: { ...imported, name, display_name: name, description: `Imported ${name}` },
        })),
      });
      renderWithClient(
        <AppDialogProvider>
          <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
        </AppDialogProvider>,
      );
      const user = userEvent.setup();
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: `Import from local Agents (${count})`,
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      await user.click(screen.getByRole("button", { name: `Import from local Agents (${count})` }));
      await user.click(screen.getByRole("button", { name: "Review selected packages" }));
      await user.click(await screen.findByRole("button", { name: "Import ready packages" }));
      expect(await screen.findAllByText("Imported")).toHaveLength(count);
      await waitFor(() =>
        expect(screen.getAllByText(/Batch refresh failed/).length).toBeGreaterThan(0),
      );
      await user.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
      await user.click(screen.getByRole("tab", { name: new RegExp(tr("skills.library")) }));
      for (const name of names) expect(await screen.findByText(`Imported ${name}`)).toBeTruthy();
      const message = screen.getByText(
        count === 1
          ? tr("skills.manager.libraryAdded", { name: names[0] })
          : tr("skills.manager.libraryAddedMultiple", { count }),
        { exact: false },
      );
      const result = within(message.closest<HTMLElement>('[role="status"]')!);
      expect(result.queryByRole("button", { name: tr("skills.manager.deploy") }) !== null).toBe(
        count === 1,
      );
      expect(
        result.queryByRole("button", { name: tr("skills.manager.viewDeployments") }),
      ).toBeNull();
      expect(mocks.applySkillImports).toHaveBeenCalledOnce();
    },
  );

  it("uses a stable source identity when choosing another version from discovery", async () => {
    mocks.installedSkills.mockResolvedValue([
      {
        name: "existing-id",
        display_name: candidate.name,
        description: candidate.description,
        path: "/library/existing-id",
        size: 128,
        status: "current",
        source: { ...candidate.source, ref: "v1.0" },
        can_rollback: false,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [{ ...candidate, installed: false }],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.listSkillVersions.mockResolvedValue({
      type: "tag",
      page: 1,
      has_more: false,
      entries: [{ name: "v2.0", commit: "b".repeat(40) }],
    });
    mocks.prepareSkillVersionChange.mockResolvedValue({
      ...preview,
      operation: "update",
      previous_source: { ...candidate.source, ref: "v1.0" },
      skill: { ...candidate, source: { ...candidate.source, ref: "v2.0" } },
    });
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
    await user.click(await screen.findByRole("button", { name: "Choose version" }));
    await user.click(await screen.findByRole("button", { name: /v2.0/ }));
    await user.click(screen.getByRole("button", { name: "Review version" }));
    expect(mocks.prepareSkillVersionChange).toHaveBeenCalledWith("existing-id", {
      type: "tag",
      value: "v2.0",
    });
    expect(await screen.findByText("Current reference and commit")).toBeTruthy();
    expect(screen.getByText(/v1.0 ·/)).toBeTruthy();
    expect(screen.getByText(/v2.0 ·/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.discardSkillPreview).toHaveBeenCalledWith(preview.token);
  });

  it.each([
    {
      label: "a different ref",
      installedRef: "v1.0",
      installedType: "tag" as const,
      candidateRef: "main",
      candidateType: "branch" as const,
    },
    {
      label: "a same-named tag and branch",
      installedRef: "release",
      installedType: "tag" as const,
      candidateRef: "release",
      candidateType: "branch" as const,
    },
    {
      label: "an untyped legacy reference",
      installedRef: "main",
      installedType: undefined,
      candidateRef: "main",
      candidateType: "branch" as const,
    },
  ])(
    "routes the primary discovery action for $label through version selection",
    async ({ installedRef, installedType, candidateRef, candidateType }) => {
      mocks.installedSkills.mockResolvedValue([
        {
          name: "installed-id",
          display_name: candidate.name,
          description: candidate.description,
          path: "/library/installed-id",
          size: 128,
          status: "current",
          source: { ...candidate.source!, ref: installedRef, ref_type: installedType },
          can_rollback: false,
        },
      ]);
      mocks.removedSkills.mockResolvedValue([]);
      mocks.skillCatalog.mockResolvedValue({
        entries: [
          {
            ...candidate,
            source: { ...candidate.source!, ref: candidateRef, ref_type: candidateType },
            installed: false,
          },
        ],
        cached_at: "2026-09-02T00:00:00Z",
        stale: false,
      });
      mocks.listSkillVersions.mockResolvedValue({
        type: installedType ?? "tag",
        page: 1,
        has_more: false,
        entries: [],
      });
      renderWithClient(
        <AppDialogProvider>
          <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
        </AppDialogProvider>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
      await user.click(await screen.findByRole("button", { name: "Choose version" }));
      expect(
        await screen.findByRole("dialog", { name: `Choose a version for ${candidate.name}` }),
      ).toBeTruthy();
      expect(mocks.listSkillVersions).toHaveBeenCalledWith({
        library_id: "installed-id",
        type: installedType ?? "tag",
        page: 1,
      });
      expect(mocks.prepareSkillInstall).not.toHaveBeenCalled();
      expect(mocks.prepareSkillUpdate).not.toHaveBeenCalled();
      expect(mocks.prepareSkillVersionChange).not.toHaveBeenCalled();
    },
  );

  it.each(["install", "update"] as const)(
    "reviews an immutable curated package before %s",
    async (operation) => {
      const installed: InstalledSkill = {
        name: candidate.name,
        display_name: candidate.name,
        description: candidate.description,
        path: "/tmp/.agentkib/skills/skill-installer",
        size: 128,
        status: "current",
        source: candidate.source,
        can_rollback: false,
      };
      mocks.installedSkills
        .mockResolvedValueOnce(operation === "install" ? [] : [installed])
        .mockResolvedValue([installed]);
      mocks.removedSkills.mockResolvedValue([]);
      mocks.skillCatalog.mockResolvedValue({
        entries: [{ ...candidate, installed: false }],
        cached_at: "2026-09-02T00:00:00Z",
        stale: false,
      });
      mocks.prepareSkillInstall.mockResolvedValue({ ...preview, operation });
      mocks.applySkillOperation.mockResolvedValue(installed);
      const user = userEvent.setup();

      renderWithClient(
        <AppDialogProvider>
          <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
        </AppDialogProvider>,
      );

      await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
      expect(await screen.findByText("skill-installer")).toBeTruthy();
      await user.click(
        screen.getByRole("button", {
          name: operation === "install" ? "Add to Skill library" : "Update",
        }),
      );

      const previewTitle = tr(
        operation === "install" ? "skills.installPreview" : "skills.updatePreview",
      );
      expect(await screen.findByText(previewTitle)).toBeTruthy();
      expect(screen.getByText("0123456789ab")).toBeTruthy();
      const review = screen.getByRole("dialog", { name: previewTitle });
      await user.click(
        within(review).getByRole("button", {
          name: operation === "install" ? "Add to Skill library" : "Apply update",
        }),
      );

      await waitFor(() =>
        expect(mocks.applySkillOperation).toHaveBeenCalledWith("preview-token", false),
      );
      const message = await screen.findByText(
        tr(
          operation === "install" ? "skills.manager.libraryAdded" : "skills.manager.libraryUpdated",
          {
            name: candidate.name,
          },
        ),
      );
      const result = within(message.closest<HTMLElement>('[role="status"]')!);
      expect(result.getByRole("button", { name: tr("skills.manager.deploy") })).toBeTruthy();
      expect(
        result.queryByRole("button", { name: tr("skills.manager.viewDeployments") }),
      ).toBeNull();
    },
  );

  it("matches an installed source before reporting a display-name conflict", async () => {
    mocks.installedSkills.mockResolvedValue([
      {
        name: "local-skill-installer",
        display_name: candidate.name,
        description: "Local package with the same display name",
        path: "/tmp/.agentkib/skills/local-skill-installer",
        size: 64,
        status: "unmanaged",
        can_rollback: false,
      },
      {
        name: "skill-installer",
        display_name: candidate.name,
        description: candidate.description,
        path: "/tmp/.agentkib/skills/skill-installer",
        size: 128,
        status: "current",
        source: {
          ...candidate.source,
          repository: "OpenAI/Skills",
        },
        can_rollback: false,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [{ ...candidate, installed: true }],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.prepareSkillInstall.mockResolvedValue({ ...preview, operation: "update" });
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
    const updateButton = await screen.findByRole("button", { name: "Update" });
    expect((updateButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(updateButton);

    await waitFor(() => expect(mocks.prepareSkillInstall).toHaveBeenCalledWith(candidate.source));
  });

  it("clears candidates before inspecting another GitHub URL", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.discoverSkills
      .mockResolvedValueOnce([candidate])
      .mockRejectedValueOnce(new Error("inspection failed"));
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
    const input = screen.getByPlaceholderText(
      "https://github.com/owner/repo/tree/main/path/to/skill",
    );
    await user.type(input, "https://github.com/owner/first");
    await user.click(screen.getByRole("button", { name: "Inspect" }));
    expect(await screen.findByText("skill-installer")).toBeTruthy();

    await user.clear(input);
    await user.type(input, "https://github.com/owner/second");
    expect(screen.queryByText("skill-installer")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Inspect" }));

    expect(await screen.findByText(/inspection failed/)).toBeTruthy();
    expect(screen.queryByText("skill-installer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to Skill library" })).toBeNull();
  });

  it("keeps directories visible and reads removed files using the immutable preview token", async () => {
    mocks.installedSkills.mockResolvedValue([
      {
        name: candidate.name,
        display_name: candidate.name,
        description: candidate.description,
        path: "/library/reviewer",
        status: "current",
        source: candidate.source,
        size: 128,
        can_rollback: false,
      },
    ]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.prepareSkillUpdate.mockResolvedValue({
      ...preview,
      operation: "update",
      files: [
        ...preview.files,
        { path: "output/", size: 0, executable: false },
        { path: "output/nested/", size: 0, executable: false },
      ],
      added: ["output/", "output/nested/"],
      removed: ["old.txt", "old/"],
    });
    mocks.readSkillPreviewFile.mockImplementation(async (_token, path) => ({
      path,
      before: path === "old.txt" ? "Removed instructions" : null,
      after: path === "old.txt" ? null : "New instructions",
      binary: false,
      truncated: false,
    }));
    const user = userEvent.setup();
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    await libraryAction(user, "Update");
    const tree = within(await screen.findByRole("navigation", { name: "Package files" }));
    expect(tree.getByTitle("output/nested/")).toBeTruthy();
    expect(tree.getByTitle("old/")).toBeTruthy();
    expect(within(screen.getByText("Directories").parentElement!).getByText("2")).toBeTruthy();
    expect(within(screen.getByText("Files").parentElement!).getByText("1")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "old.txt" }));
    await waitFor(() =>
      expect(mocks.readSkillPreviewFile).toHaveBeenCalledWith("preview-token", "old.txt"),
    );
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    expect(await screen.findByText("− Removed instructions")).toBeTruthy();
    expect(mocks.readSkillPreviewFile.mock.calls.every(([, path]) => !path.endsWith("/"))).toBe(
      true,
    );
  });

  it("does not start another URL inspection from Enter while one is pending", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.discoverSkills.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
    const input = screen.getByPlaceholderText(
      "https://github.com/owner/repo/tree/main/path/to/skill",
    );
    await user.type(input, "https://github.com/owner/repo{Enter}");
    await waitFor(() => expect(mocks.discoverSkills).toHaveBeenCalledTimes(1));
    expect((input as HTMLInputElement).disabled).toBe(true);

    await user.keyboard("{Enter}");
    expect(mocks.discoverSkills).toHaveBeenCalledTimes(1);
  });

  it("keeps separate trash records for repeated removals of the same Skill", async () => {
    const current = {
      name: "reviewer",
      display_name: "reviewer",
      description: "Current version",
      path: "/tmp/.agentkib/skills/reviewer",
      size: 128,
      status: "current" as const,
      can_rollback: false,
    };
    const previousRemoval = {
      id: "skill-previous",
      name: "reviewer",
      display_name: "reviewer",
      removed_at: "2026-09-01T00:00:00Z",
      path: "/tmp/.agentkib/trash/skills/skill-previous/package",
    };
    const latestRemoval = {
      ...previousRemoval,
      id: "skill-latest",
      removed_at: "2026-09-02T00:00:00Z",
      path: "/tmp/.agentkib/trash/skills/skill-latest/package",
    };
    mocks.installedSkills
      .mockResolvedValueOnce([current])
      .mockRejectedValue(new Error("refresh failed"));
    mocks.removedSkills
      .mockResolvedValueOnce([previousRemoval])
      .mockRejectedValue(new Error("refresh failed"));
    mocks.uninstallSkill.mockResolvedValue(latestRemoval);
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage
          workspaces={[]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockRejectedValue(new Error("reload failed"))}
        />
      </AppDialogProvider>,
    );

    await libraryAction(user, "Move to trash");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mocks.uninstallSkill).toHaveBeenCalledWith("reviewer"));
    expect(await screen.findAllByRole("button", { name: "Restore" })).toHaveLength(2);
  });

  it("keeps a successful rollback and refresh error while refreshing the catalog", async () => {
    const refreshFailure = { key: "errors.providerUnavailable" };
    const catalogFailure = { key: "errors.conversations.refreshFailed" };
    const reloadFailure = new Error("reload failed");
    const current = {
      name: "reviewer",
      display_name: "reviewer",
      description: "Current version",
      path: "/tmp/.agentkib/skills/reviewer",
      size: 128,
      status: "current" as const,
      can_rollback: true,
    };
    mocks.installedSkills.mockResolvedValueOnce([current]).mockRejectedValue(refreshFailure);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog
      .mockResolvedValueOnce({
        entries: [],
        cached_at: "2026-09-02T00:00:00Z",
        stale: false,
      })
      .mockRejectedValue(catalogFailure);
    mocks.rollbackSkill.mockResolvedValue({
      ...current,
      description: "Previous version",
      can_rollback: false,
    });
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage
          workspaces={[]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockRejectedValue(reloadFailure)}
        />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover Skills" }));
    await waitFor(() => expect(mocks.skillCatalog).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("tab", { name: /Skill library/ }));
    await libraryAction(user, "Roll back");
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Previous version")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    const failures = [refreshFailure, reloadFailure, catalogFailure];
    const englishError = failures.map((failure) => localizeMessage(failure)).join(" · ");
    const message = await screen.findByText(englishError);
    const resultMessage = screen.getByText(
      tr("skills.manager.libraryRolledBack", { name: current.display_name }),
      { exact: false },
    );
    expect(resultMessage.textContent).toContain(tr("skills.manager.refreshFailed"));
    expect(mocks.skillCatalog).toHaveBeenCalledTimes(2);
    try {
      await act(() => changeLocale("zh-CN"));
      expect(
        screen.getByText(failures.map((failure) => localizeMessage(failure)).join(" · ")),
      ).toBe(message);
      expect(screen.queryByText(englishError)).toBeNull();
      expect(
        screen.getByText(tr("skills.manager.libraryRolledBack", { name: current.display_name }), {
          exact: false,
        }),
      ).toBe(resultMessage);
      expect(resultMessage.textContent).toContain(tr("skills.manager.refreshFailed"));
      expect(screen.getByText("Previous version")).toBeTruthy();
      expect(mocks.skillCatalog).toHaveBeenCalledTimes(2);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it.each([
    {
      operation: "rollback",
      action: "skills.rollback",
      success: "skills.manager.libraryRolledBack",
    },
    {
      operation: "trash",
      action: "skills.moveToTrash",
      success: "skills.manager.libraryMovedToTrash",
    },
    { operation: "restore", action: "skills.restore", success: "skills.manager.libraryRestored" },
  ] as const)(
    "describes a $operation result and links to its unchanged deployments",
    async ({ operation, action, success }) => {
      const removedSkill = {
        id: "removed-reviewer",
        name: librarySkill.name,
        display_name: librarySkill.display_name,
        path: "/trash/library-reviewer-id",
        removed_at: "2026-10-16T00:00:00Z",
      };
      let installed = operation === "restore" ? [] : [librarySkill];
      let removed = operation === "restore" ? [removedSkill] : [];
      mocks.installedSkills.mockImplementation(async () => installed);
      mocks.removedSkills.mockImplementation(async () => removed);
      mocks.skillDeployments.mockResolvedValue([libraryDeployment]);
      mocks.rollbackSkill.mockImplementation(async () => {
        installed = [{ ...librarySkill, can_rollback: false }];
        return installed[0];
      });
      mocks.uninstallSkill.mockImplementation(async () => {
        installed = [];
        removed = [removedSkill];
        return removedSkill;
      });
      mocks.restoreSkill.mockImplementation(async () => {
        installed = [librarySkill];
        removed = [];
        return librarySkill;
      });
      mocks.skillTargets.mockResolvedValue([
        {
          id: "codex-personal",
          agent: "codex",
          scope: "personal",
          workspace_id: null,
          profile: null,
          root: "/native/codex/skills",
          scope_root: "/native",
          visible_to: ["codex"],
          writable: true,
          reason: null,
          conditions: [],
        },
      ]);
      mocks.prepareSkillDeployment.mockResolvedValue({
        token: "deployment-preview",
        operation: "deploy",
        library_id: librarySkill.name,
        expires_at: preview.expires_at,
        requires_home_approval: true,
        targets: [],
      });
      const user = userEvent.setup();
      renderWithClient(
        <AppDialogProvider>
          <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
        </AppDialogProvider>,
      );

      if (operation === "restore") {
        await user.click(screen.getByRole("tab", { name: new RegExp(tr("skills.library")) }));
        await user.click(await screen.findByRole("button", { name: tr(action) }));
      } else await libraryAction(user, tr(action));
      if (operation !== "restore") {
        await user.click(screen.getByRole("button", { name: tr("common.confirm") }));
      }
      const message = await screen.findByText(tr(success, { name: librarySkill.display_name }), {
        exact: false,
      });
      const result = within(message.closest<HTMLElement>('[role="status"]')!);
      expect(message.textContent).toContain(tr("skills.manager.deploymentsUnchanged"));
      expect(message.textContent).not.toContain(tr("skills.manager.libraryChanged"));
      await waitFor(() =>
        expect(
          (
            result.getByRole("button", {
              name: tr("skills.manager.viewDeployments"),
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      await user.click(result.getByRole("button", { name: tr("skills.manager.viewDeployments") }));
      expect(
        screen.getByRole("tab", { name: /Usage locations/ }).getAttribute("aria-selected"),
      ).toBe("true");
      expect(await screen.findByText(libraryDeployment.target)).toBeTruthy();
      expect(mocks.prepareSkillDeployment).not.toHaveBeenCalled();
      expect(mocks.applySkillDeployment).not.toHaveBeenCalled();

      if (operation === "trash") {
        expect(result.queryByRole("button", { name: tr("skills.manager.deploy") })).toBeNull();
      } else {
        await user.click(result.getByRole("button", { name: tr("skills.manager.deploy") }));
        expect(
          await screen.findByRole("dialog", { name: tr("skills.manager.operation.deploy") }),
        ).toBeTruthy();
        await waitFor(() =>
          expect(screen.getByRole("dialog").textContent).toContain("/native/codex/skills"),
        );
        await user.click(await screen.findByRole("checkbox", { name: /\/native\/codex\/skills/ }));
        await user.click(
          screen.getByRole("button", { name: tr("skills.manager.reviewDeployment") }),
        );
        await waitFor(() =>
          expect(mocks.prepareSkillDeployment).toHaveBeenCalledWith({
            operation: "deploy",
            library_id: librarySkill.name,
            target_ids: ["codex-personal"],
          }),
        );
        expect(mocks.applySkillDeployment).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      condition: "another Skill",
      deployment: { ...libraryDeployment, library_id: "another-skill" },
    },
    {
      condition: "another library",
      deployment: { ...libraryDeployment, source_is_current_library: false },
    },
    {
      condition: "a withdrawn deployment",
      deployment: { ...libraryDeployment, status: "inactive" },
    },
  ])("does not link a rollback result to $condition", async ({ deployment }) => {
    mocks.installedSkills.mockResolvedValue([librarySkill]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillDeployments.mockResolvedValue([deployment]);
    mocks.rollbackSkill.mockResolvedValue(librarySkill);
    const user = userEvent.setup();
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    await libraryAction(user, tr("skills.rollback"));
    await user.click(screen.getByRole("button", { name: tr("common.confirm") }));
    const message = await screen.findByText(
      tr("skills.manager.libraryRolledBack", { name: librarySkill.display_name }),
    );
    const result = within(message.closest<HTMLElement>('[role="status"]')!);
    expect(result.queryByRole("button", { name: tr("skills.manager.viewDeployments") })).toBeNull();
    expect(message.textContent).not.toContain(tr("skills.manager.deploymentsUnchanged"));
  });

  it("hides the deploy shortcut when the refreshed library no longer contains the result Skill", async () => {
    mocks.installedSkills.mockResolvedValueOnce([librarySkill]).mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.rollbackSkill.mockResolvedValue(librarySkill);
    const user = userEvent.setup();
    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );
    await libraryAction(user, tr("skills.rollback"));
    await user.click(screen.getByRole("button", { name: tr("common.confirm") }));
    await screen.findByText(tr("skills.libraryEmpty"));
    const message = screen.getByText(
      tr("skills.manager.libraryRolledBack", { name: librarySkill.display_name }),
    );
    const result = within(message.closest<HTMLElement>('[role="status"]')!);
    expect(result.queryByRole("button", { name: tr("skills.manager.deploy") })).toBeNull();
    expect(result.queryByRole("button", { name: tr("skills.manager.viewDeployments") })).toBeNull();
  });
});
