// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { Manifest, WorkspaceSummary } from "@/core/types";
import { draftSectionCount } from "@/features/workspace/manifest-draft";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import { Route } from "./catalog";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(),
  scan: vi.fn(),
  manifest: vi.fn(),
  runtime: vi.fn(),
}));
const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Fixture workspace",
  path: "/sandbox/project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => ({ assetSection: "instructions" }),
  useNavigate: () => doubles.navigate,
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeCatalog: () => ({ data: [], isPending: false }),
  useHomeWorkspaces: () => ({ data: [workspace], isPending: false }),
  useHomeMemories: () => ({ data: [], isPending: false }),
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: doubles.confirm }),
}));
vi.mock("@/features/catalog/AssetCatalogPage", () => ({
  AssetCatalogPage: ({ onOpen }: { onOpen: (id: string) => void }) => (
    <button onClick={() => onOpen("workspace")}>Open fixture workspace</button>
  ),
}));
vi.mock("@/core/api", () => ({
  api: { scan: doubles.scan, manifest: doubles.manifest, runtime: doubles.runtime },
}));

function manifest(id = "original-id", shared = "Original shared rules"): Manifest {
  return {
    schema_version: 2,
    workspace: { id, name: workspace.name },
    instructions: { shared, scoped: [], platform_overrides: {} },
    skills: [],
    connections: [],
    adapters: {},
    mcp: { config: "mcp.json" },
    memories: { require_approval: true },
  };
}
async function renderRoute() {
  const Component = Route.options.component!;
  if ("preload" in Component && typeof Component.preload === "function") await Component.preload();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "Open fixture workspace" });
}
async function open() {
  const count = doubles.navigate.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Open fixture workspace" }));
  await waitFor(() => expect(doubles.navigate).toHaveBeenCalledTimes(count + 1));
}
function cache(baseline = manifest(), baselineIsDefault = false) {
  const draft = {
    ...baseline,
    instructions: { ...baseline.instructions, shared: "Unsaved draft" },
  };
  useWorkspaceStore
    .getState()
    .cacheWorkspaceDraft(workspace.id, draft, JSON.stringify(baseline), undefined, {
      baselineIsDefault,
    });
  return draft;
}
function expectOneDraft() {
  const state = useWorkspaceStore.getState();
  expect(state.manifest?.instructions.shared).toBe("Unsaved draft");
  expect(draftSectionCount(state.manifest, state.baselineManifest)).toBe(1);
}
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setWorkspaceDrafts({});
  useAppStore.getState().setRuntime(undefined);
  doubles.scan.mockResolvedValue({
    root: workspace.path,
    manifest_exists: true,
    agents: [],
    assets: [],
    warnings: [],
  });
  doubles.manifest.mockResolvedValue(manifest());
  doubles.runtime.mockResolvedValue({});
  doubles.confirm.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setWorkspaceDrafts({});
});

describe("catalog workspace draft opening", () => {
  it("retains a persisted draft and remembers deletion provenance across subsequent opens", async () => {
    const draft = cache();
    doubles.scan.mockResolvedValue({
      root: workspace.path,
      manifest_exists: false,
      agents: [],
      assets: [],
      warnings: [],
    });
    doubles.manifest.mockResolvedValue(manifest("deleted-first-id"));
    await renderRoute();
    await open();
    expect(doubles.confirm).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    expect(useWorkspaceStore.getState().baselineManifestIsDefault).toBe(false);
    expect(useWorkspaceStore.getState().workspaceDraftBaselineDefaults[workspace.id]).toBe(false);
    expect(useWorkspaceStore.getState().workspaceDraftDiskDefaults[workspace.id]).toBe(true);
    doubles.manifest.mockResolvedValue(manifest("deleted-second-id"));
    await open();
    expect(doubles.confirm).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
  });

  it("keeps a missing-manifest draft across fresh prepared identities without a false conflict", async () => {
    cache(manifest(), true);
    doubles.scan.mockResolvedValue({
      root: workspace.path,
      manifest_exists: false,
      agents: [],
      assets: [],
      warnings: [],
    });
    doubles.manifest
      .mockResolvedValueOnce(manifest("new-server-id-1"))
      .mockResolvedValueOnce(manifest("new-server-id-2"));
    await renderRoute();
    await open();
    expectOneDraft();
    await open();
    expectOneDraft();
    expect(doubles.confirm).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().manifest?.workspace.id).toBe("new-server-id-2");
  });

  it("acknowledges one retained external version without changing the original dirty-section baseline", async () => {
    const baseline = manifest();
    cache(baseline);
    const disk = { ...baseline, mcp: { config: "external-mcp.json" } };
    doubles.manifest.mockResolvedValue(disk);
    await renderRoute();
    await open();
    expectOneDraft();
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(baseline));
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBe(
      JSON.stringify(disk),
    );
    await open();
    expectOneDraft();
    expect(doubles.confirm).toHaveBeenCalledOnce();
    doubles.manifest.mockResolvedValue({ ...disk, mcp: { config: "newer-external-mcp.json" } });
    await open();
    expectOneDraft();
    expect(doubles.confirm).toHaveBeenCalledTimes(2);
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "shows explicit conflict actions in %s",
    async (locale) => {
      await initializeI18n(locale);
      cache();
      doubles.manifest.mockResolvedValue({ ...manifest(), mcp: { config: "external-mcp.json" } });
      await renderRoute();
      await open();
      expect(doubles.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: tr("workspace.refreshConflictTitle"),
          description: tr("workspace.refreshConflict"),
          confirmLabel: tr("workspace.refreshLoadDisk"),
          cancelLabel: tr("workspace.refreshKeepDraft"),
          tone: "warning",
        }),
      );
    },
  );

  it("cleans the draft and acknowledged snapshot when the reviewed external disk is chosen", async () => {
    cache();
    const disk = { ...manifest(), mcp: { config: "external-mcp.json" } };
    doubles.manifest.mockResolvedValue(disk);
    doubles.confirm.mockResolvedValue(true);
    await renderRoute();
    await open();
    expect(useWorkspaceStore.getState().manifest).toEqual(disk);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBeUndefined();
    expect(useWorkspaceStore.getState().workspaceDraftDisks[workspace.id]).toBeUndefined();
  });

  it("does not replace edits made while its external-version confirmation is open", async () => {
    const draft = cache();
    const newer = {
      ...draft,
      instructions: { ...draft.instructions, shared: "Typed while confirming" },
    };
    doubles.manifest.mockResolvedValue({ ...manifest(), mcp: { config: "external-mcp.json" } });
    let resolve!: (value: boolean) => void;
    doubles.confirm.mockReturnValue(
      new Promise<boolean>((yes) => {
        resolve = yes;
      }),
    );
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Open fixture workspace" }));
    await waitFor(() => expect(doubles.confirm).toHaveBeenCalledOnce());
    await act(async () => {
      useWorkspaceStore
        .getState()
        .cacheWorkspaceDraft(workspace.id, newer, JSON.stringify(manifest()));
      resolve(true);
    });
    await waitFor(() => expect(doubles.navigate).toHaveBeenCalledOnce());
    expect(useWorkspaceStore.getState().manifest?.instructions.shared).toBe(
      "Typed while confirming",
    );
    expect(
      draftSectionCount(
        useWorkspaceStore.getState().manifest,
        useWorkspaceStore.getState().baselineManifest,
      ),
    ).toBe(1);
  });
});
