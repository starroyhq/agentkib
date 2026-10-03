// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppDialogProvider } from "@/components/AppDialogProvider";
import { changeLocale, initializeI18n, localizeMessage, tr } from "@/core/i18n";
import type { SkillCandidate, SkillOperationPreview } from "@/core/types";
import { SkillHubPage } from "./SkillHubPage";

// 每个用例一个新的 QueryClient，避免技能库缓存在用例之间泄漏。
function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const mocks = vi.hoisted(() => ({
  installedSkills: vi.fn(),
  removedSkills: vi.fn(),
  skillCatalog: vi.fn(),
  discoverSkills: vi.fn(),
  prepareSkillInstall: vi.fn(),
  prepareSkillUpdate: vi.fn(),
  applySkillOperation: vi.fn(),
  checkSkillUpdates: vi.fn(),
  rollbackSkill: vi.fn(),
  uninstallSkill: vi.fn(),
  restoreSkill: vi.fn(),
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

describe("SkillHubPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
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
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("local-reviewer")).toBeTruthy();
    expect(screen.getByText("Local unmanaged")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Workspace usage/ })).toBeTruthy();
    expect(screen.getByText(/not enabled for any Agent automatically/)).toBeTruthy();
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
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));

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

  it("reviews an immutable curated package before adding it", async () => {
    mocks.installedSkills.mockResolvedValue([]);
    mocks.removedSkills.mockResolvedValue([]);
    mocks.skillCatalog.mockResolvedValue({
      entries: [{ ...candidate, installed: false }],
      cached_at: "2026-09-02T00:00:00Z",
      stale: false,
    });
    mocks.prepareSkillInstall.mockResolvedValue(preview);
    mocks.applySkillOperation.mockResolvedValue({
      name: candidate.name,
      display_name: candidate.name,
      description: candidate.description,
      path: "/tmp/.agentkib/skills/skill-installer",
      size: 128,
      status: "current",
      source: candidate.source,
      can_rollback: false,
    });
    const user = userEvent.setup();

    renderWithClient(
      <AppDialogProvider>
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
    expect(await screen.findByText("skill-installer")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to library" }));

    expect(await screen.findByText("Review Skill package")).toBeTruthy();
    expect(screen.getByText("0123456789ab")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add to library" }));

    await waitFor(() =>
      expect(mocks.applySkillOperation).toHaveBeenCalledWith("preview-token", false),
    );
  });

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
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
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
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
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
    expect(screen.queryByRole("button", { name: "Add to library" })).toBeNull();
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
        <SkillHubPage workspaceAssets={[]} workspaces={[]} onOpen={vi.fn()} onReload={vi.fn()} />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
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
          workspaceAssets={[]}
          workspaces={[]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockRejectedValue(new Error("reload failed"))}
        />
      </AppDialogProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Move to trash" }));
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
          workspaceAssets={[]}
          workspaces={[]}
          onOpen={vi.fn()}
          onReload={vi.fn().mockRejectedValue(reloadFailure)}
        />
      </AppDialogProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Discover" }));
    await waitFor(() => expect(mocks.skillCatalog).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("tab", { name: /Library/ }));
    await user.click(await screen.findByRole("button", { name: "Roll back" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Previous version")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull();
    const failures = [refreshFailure, reloadFailure, catalogFailure];
    const englishError = failures.map((failure) => localizeMessage(failure)).join(" · ");
    const message = await screen.findByText(englishError);
    expect(mocks.skillCatalog).toHaveBeenCalledTimes(2);
    try {
      await act(() => changeLocale("zh-CN"));
      expect(
        screen.getByText(failures.map((failure) => localizeMessage(failure)).join(" · ")),
      ).toBe(message);
      expect(screen.queryByText(englishError)).toBeNull();
      expect(screen.getByText("Previous version")).toBeTruthy();
      expect(mocks.skillCatalog).toHaveBeenCalledTimes(2);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
