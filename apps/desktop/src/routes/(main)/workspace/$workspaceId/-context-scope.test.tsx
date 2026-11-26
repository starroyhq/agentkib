// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ContextPreview, Manifest, WorkspaceSummary } from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { ContextPage, Route } from "./context";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({ agent: "codex" }),
}));
vi.mock("@/core/api", () => ({ api: { context: vi.fn() } }));

const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Workspace",
  path: "/workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const baseline: Manifest = {
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared: "Saved instruction", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
const draft: Manifest = {
  ...baseline,
  instructions: { ...baseline.instructions, shared: "Unapplied draft instruction" },
};
const preview: ContextPreview = {
  project: workspace.path,
  cwd: workspace.path,
  agent: "codex",
  sections: [],
  warnings: [],
  visible_skills: [],
  visible_connections: [],
  approved_memories: [],
};
function renderPage(route = false) {
  const Component = Route.options.component!;
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Suspense fallback={null}>
        {route ? (
          <Component />
        ) : (
          <ContextPage project={workspace.path} onOpenInstructions={() => {}} />
        )}
      </Suspense>
    </QueryClientProvider>,
  );
}
// Only the route branch is lazy; direct ContextPage rendering stays synchronous.
beforeAll(async () => {
  await Route.options.component!.preload?.();
});
beforeEach(async () => {
  await initializeI18n("en-US");
  vi.resetAllMocks();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({
    selectedWorkspace: workspace,
    project: workspace.path,
    scan: { root: workspace.path, manifest_exists: true, agents: [], assets: [], warnings: [] },
    manifest: draft,
    baselineManifest: JSON.stringify(baseline),
    workspaceDrafts: { [workspace.id]: draft },
  });
  vi.mocked(api.context).mockResolvedValue(preview);
});
afterEach(async () => {
  cleanup();
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  await changeLocale("en-US");
});

describe("Context disk preview scope", () => {
  it("does not ask to apply a draft when the editor matches the saved manifest", async () => {
    useWorkspaceStore.getState().setManifest(baseline);
    renderPage();
    expect(screen.queryByText(/This preview reads instruction files/)).toBeNull();
    expect(screen.queryByText(tr("context.previewScopeDraft"))).toBeNull();
    await screen.findByText(tr("context.noInstructions"));
  });
  it.each([
    ["en-US", "unapplied drafts"],
    ["zh-CN", "未应用草稿"],
    ["zh-Hant", "未套用草稿"],
    ["ja-JP", "未適用の下書き"],
  ] as const)(
    "identifies draft exclusion during loading, error and empty results in %s",
    async (locale, draftBoundary) => {
      await changeLocale(locale);
      let reject!: (reason: Error) => void;
      vi.mocked(api.context).mockReturnValueOnce(
        new Promise<ContextPreview>((_resolve, no) => {
          reject = no;
        }),
      );
      renderPage();
      const description = tr("context.previewScopeDraft");
      expect(description).not.toBe("context.previewScopeDraft");
      expect(description).toContain(draftBoundary);
      expect(screen.getByText(description)).toBeVisible();
      expect(screen.queryByText(tr("context.noInstructions"))).not.toBeInTheDocument();

      await act(async () => reject(new Error("Disk context unavailable")));
      expect(await screen.findByText(/Disk context unavailable/)).toBeVisible();
      expect(screen.getByText(description)).toBeVisible();

      fireEvent.click(screen.getByRole("button", { name: tr("context.resolve") }));
      expect(await screen.findByText(tr("context.noInstructions"))).toBeVisible();
      expect(screen.getByText(description)).toBeVisible();
      expect(api.context).toHaveBeenCalledTimes(2);
      expect(api.context).toHaveBeenLastCalledWith(workspace.path, workspace.path, "codex");
    },
  );

  it("keeps a dirty Assets draft intact and refreshes only the disk preview", async () => {
    const diskPreview: ContextPreview = {
      ...preview,
      sections: [
        {
          source: "/workspace/AGENTS.md",
          scope: "",
          content: baseline.instructions.shared,
          precedence: 0,
        },
      ],
      visible_skills: ["disk-skill"],
    };
    vi.mocked(api.context).mockResolvedValue(diskPreview);
    await act(async () => {
      renderPage(true);
    });
    expect(await screen.findByText("disk-skill")).toBeVisible();
    expect(screen.getByText(tr("context.previewScopeDraft"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("context.showContent") }));
    expect(await screen.findByText(baseline.instructions.shared)).toBeVisible();
    expect(screen.queryByText(draft.instructions.shared)).not.toBeInTheDocument();

    const newer = {
      ...draft,
      instructions: { ...draft.instructions, shared: "A newer unapplied draft" },
    };
    act(() => useWorkspaceStore.getState().setManifest(newer));
    expect(api.context).toHaveBeenCalledExactlyOnceWith(workspace.path, workspace.path, "codex");
    expect(screen.queryByText(newer.instructions.shared)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tr("context.resolve") }));
    await waitFor(() => expect(api.context).toHaveBeenCalledTimes(2));
    expect(api.context).toHaveBeenLastCalledWith(workspace.path, workspace.path, "codex");
    expect(useWorkspaceStore.getState().manifest).toBe(newer);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(baseline));
  });

  it("retains the empty preview's instructions shortcut without applying or discarding a draft", async () => {
    await act(async () => {
      renderPage(true);
    });
    expect(await screen.findByText(tr("context.noInstructions"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("context.openInstructions") }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/assets",
      params: { workspaceId: workspace.id },
      search: { workspaceAssetSection: "instructions" },
    });
    expect(useWorkspaceStore.getState().manifest).toBe(draft);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(api.context).toHaveBeenCalledExactlyOnceWith(workspace.path, workspace.path, "codex");
  });
});
