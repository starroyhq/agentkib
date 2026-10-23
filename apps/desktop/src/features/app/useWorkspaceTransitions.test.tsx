// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { Manifest, WorkspaceSummary } from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useWorkspaceTransitions } from "./useWorkspaceTransitions";

const dialogs = vi.hoisted(() => ({
  notify: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => dialogs,
}));

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  path: "/workspace-1",
  name: "First workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const nextWorkspace: WorkspaceSummary = {
  ...workspace,
  id: "workspace-2",
  path: "/workspace-2",
  name: "Second workspace",
};
const manifest = (shared: string): Manifest => ({
  schema_version: 1,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared, scoped: [], platform_overrides: {} },
  skills: [],
  mcp: { config: "" },
  connections: [],
  memories: { require_approval: true },
  adapters: {},
});

function renderTransitions() {
  const navigateWorkspacePageFor = vi.fn();
  const invalidatePendingLoad = vi.fn();
  const hook = renderHook(() =>
    useWorkspaceTransitions({
      route: { kind: "workspace", workspaceId: workspace.id, page: "assets" },
      navigateWorkspacePageFor,
      clearGitSubview: vi.fn(),
      invalidatePendingLoad,
    }),
  );
  return { ...hook, navigateWorkspacePageFor, invalidatePendingLoad };
}

describe("workspace draft transitions", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setWorkspaceDrafts({});
    dialogs.notify.mockReset().mockResolvedValue(undefined);
    dialogs.confirm.mockReset().mockResolvedValue(false);
  });
  afterEach(async () => {
    cleanup();
    await initializeI18n("en-US");
  });

  it.each(["cold", "warm"] as const)(
    "prepares a destination plan after %s workspace initialization and before navigation",
    async (state) => {
      if (state === "warm")
        useWorkspaceStore.setState({
          selectedWorkspace: nextWorkspace,
          project: nextWorkspace.path,
        });
      const plan = {
        id: "prepared-plan",
        project_root: nextWorkspace.path,
        created_at: "",
        changes: [],
        requires_home_approval: false,
      };
      const { result, navigateWorkspacePageFor } = renderTransitions();
      navigateWorkspacePageFor.mockImplementation(() => {
        expect(useWorkspaceStore.getState().selectedWorkspace).toBe(nextWorkspace);
        expect(useWorkspaceStore.getState().changeSet).toBe(plan);
      });
      await act(async () => {
        expect(
          await result.current.openWorkspace(nextWorkspace, "changes", undefined, () =>
            useWorkspaceStore.getState().setChangeSet(plan),
          ),
        ).toBe(true);
      });
      expect(navigateWorkspacePageFor).toHaveBeenCalledOnce();
    },
  );

  it("does not prepare a plan when workspace changes are locked", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const prepare = vi.fn();
    const { result, navigateWorkspacePageFor } = renderTransitions();
    await act(async () => {
      expect(await result.current.openWorkspace(nextWorkspace, "changes", undefined, prepare)).toBe(
        false,
      );
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(navigateWorkspacePageFor).not.toHaveBeenCalled();
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "uses an operation warning when navigation is locked in %s",
    async (locale) => {
      await initializeI18n(locale);
      useWorkspaceStore.setState({
        applyingChanges: true,
        selectedWorkspace: workspace,
        project: workspace.path,
      });
      const { result, navigateWorkspacePageFor, invalidatePendingLoad } = renderTransitions();
      const next = vi.fn();
      await act(async () => {
        expect(await result.current.ensureWorkspaceChangeAllowed()).toBe(false);
        expect(await result.current.leaveWorkspace(next)).toBe(false);
        expect(await result.current.openWorkspace(nextWorkspace)).toBe(false);
      });
      expect(dialogs.notify.mock.calls).toEqual(
        Array.from({ length: 3 }, () => [tr("workspace.changesApplying")]),
      );
      expect(dialogs.notify).not.toHaveBeenCalledWith(tr("dialog.quit.changesApplying"));
      expect(next).not.toHaveBeenCalled();
      expect(navigateWorkspacePageFor).not.toHaveBeenCalled();
      expect(invalidatePendingLoad).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    },
  );

  it("caches the latest draft before switching and retains other workspaces' drafts", async () => {
    const baseline = manifest("saved");
    const draft = manifest("latest edit");
    const otherDraft = manifest("other workspace edit");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: {
        [workspace.id]: manifest("older cached edit"),
        [nextWorkspace.id]: otherDraft,
      },
      workspaceDraftBaselines: { [nextWorkspace.id]: "other baseline" },
    });
    const { result, navigateWorkspacePageFor } = renderTransitions();

    await act(async () => {
      expect(await result.current.openWorkspace(nextWorkspace)).toBe(true);
    });

    expect(useWorkspaceStore.getState().workspaceDrafts).toEqual({
      [workspace.id]: draft,
      [nextWorkspace.id]: otherDraft,
    });
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(useWorkspaceStore.getState().workspaceDraftBaselines).toEqual({
      [workspace.id]: JSON.stringify(baseline),
      [nextWorkspace.id]: "other baseline",
    });
    expect(useWorkspaceStore.getState().manifest).toBeUndefined();
    expect(navigateWorkspacePageFor).toHaveBeenCalledWith(nextWorkspace.id, "overview", undefined);

    await act(async () => {
      await result.current.openWorkspace(workspace);
    });

    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(useWorkspaceStore.getState().workspaceDrafts[nextWorkspace.id]).toBe(otherDraft);
  });

  it("removes an older cached draft when the current manifest matches the baseline", async () => {
    const saved = manifest("saved");
    const otherDraft = manifest("other workspace edit");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: { ...saved },
      baselineManifest: JSON.stringify(saved),
      workspaceDrafts: {
        [workspace.id]: manifest("already applied edit"),
        [nextWorkspace.id]: otherDraft,
      },
      workspaceDraftBaselines: {
        [workspace.id]: "old baseline",
        [nextWorkspace.id]: "other baseline",
      },
    });
    const { result } = renderTransitions();

    await act(async () => {
      await result.current.openWorkspace(nextWorkspace);
      await result.current.openWorkspace(workspace);
    });

    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBeUndefined();
    expect(useWorkspaceStore.getState().workspaceDraftBaselines).toEqual({
      [nextWorkspace.id]: "other baseline",
    });
    expect(useWorkspaceStore.getState().workspaceDrafts[nextWorkspace.id]).toBe(otherDraft);
  });

  it.each(["manifest", "baseline"] as const)(
    "preserves the existing cache when the %s has not loaded",
    async (missing) => {
      const cached = manifest("cached edit");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        project: workspace.path,
        manifest: missing === "manifest" ? undefined : manifest("saved"),
        baselineManifest: missing === "baseline" ? "" : JSON.stringify(manifest("saved")),
        workspaceDrafts: { [workspace.id]: cached },
      });
      const { result } = renderTransitions();

      await act(async () => {
        await result.current.openWorkspace(nextWorkspace);
      });

      expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(cached);
    },
  );

  it("does not change the current draft or cache while changes are applying", async () => {
    const draft = manifest("current edit");
    const cached = manifest("older cached edit");
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest("saved")),
      workspaceDrafts: { [workspace.id]: cached },
      applyingChanges: true,
    });
    const { result, navigateWorkspacePageFor, invalidatePendingLoad } = renderTransitions();

    await act(async () => {
      expect(await result.current.openWorkspace(nextWorkspace)).toBe(false);
    });

    expect(useWorkspaceStore.getState().manifest).toBe(draft);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(cached);
    expect(navigateWorkspacePageFor).not.toHaveBeenCalled();
    expect(invalidatePendingLoad).not.toHaveBeenCalled();
    expect(dialogs.notify).toHaveBeenCalledOnce();
  });

  it.each(["leave", "switch"])(
    "clears an applied result when the user chooses to %s workspaces",
    async (transition) => {
      const saved = manifest("saved");
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        project: workspace.path,
        manifest: saved,
        baselineManifest: JSON.stringify(saved),
        appliedChanges: {
          workspaceId: workspace.id,
          project: workspace.path,
          applied: ["AGENTS.md"],
          backupDir: "",
          changeSet: {
            id: "applied",
            project_root: workspace.path,
            created_at: "",
            changes: [],
            requires_home_approval: false,
          },
        },
      });
      const { result } = renderTransitions();
      await act(async () => {
        if (transition === "leave") await result.current.leaveWorkspace(vi.fn());
        else await result.current.openWorkspace(nextWorkspace);
      });
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
    },
  );
});
