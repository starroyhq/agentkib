// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { Manifest, WorkspaceSummary } from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { Route } from "./route";

const confirm = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => ({ confirm }) }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/workspace/workspace/assets" }),
  useParams: () => ({ workspaceId: "workspace" }),
  Outlet: () => <p>Assets editor</p>,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeDoctorReport: () => ({ data: undefined, refetch: vi.fn() }),
  useHomeMemories: () => ({ data: [] }),
  useHomeWorkspaces: () => ({ data: [], isPending: false }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({ WorkspaceOpenWith: () => null }));

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
  workspace: { id: "workspace", name: "Workspace" },
  instructions: { shared: "saved text", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
const draft: Manifest = {
  ...baseline,
  instructions: { ...baseline.instructions, shared: "draft text" },
};
async function renderRoute() {
  const Component = Route.options.component!;
  // Route splitting loads the editor asynchronously; await that work before
  // measuring UI readiness with Testing Library's shorter lookup deadline.
  await Component.preload?.();
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
  });
  await screen.findByText("Assets editor");
}
describe("workspace draft controls", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    confirm.mockResolvedValue(true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
      scan: { root: workspace.path, manifest_exists: true, agents: [], assets: [], warnings: [] },
      workspaceDrafts: { workspace: draft },
    });
  });
  afterEach(cleanup);

  it("shows the unsaved state and restores the baseline only after confirmation", async () => {
    await renderRoute();
    expect(screen.getByText("Unsaved sections: 1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(useWorkspaceStore.getState().manifest).toEqual(baseline));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: "destructive" }));
    expect(screen.queryByText("Unsaved sections: 1")).toBeNull();
    expect(useWorkspaceStore.getState().workspaceDrafts.workspace).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    expect(screen.queryByText("There are no unsaved draft changes.")).toBeNull();
  });

  it("retains the draft and its cache when confirmation is cancelled", async () => {
    confirm.mockResolvedValue(false);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled(),
    );
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    expect(useWorkspaceStore.getState().workspaceDrafts.workspace).toEqual(draft);
  });

  it("does not discard changes typed while confirmation was open", async () => {
    let answer!: (value: boolean) => void;
    confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(confirm).toHaveBeenCalledOnce();
    const newer = { ...draft, instructions: { ...draft.instructions, shared: "newer text" } };
    act(() => useWorkspaceStore.getState().setManifest(newer));
    await act(async () => answer(true));
    expect(useWorkspaceStore.getState().manifest).toEqual(newer);
    expect(await screen.findByRole("alert")).toHaveTextContent("The draft changed.");
  });

  it("does not discard a newly selected workspace after an old confirmation", async () => {
    let answer!: (value: boolean) => void;
    confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    act(() =>
      useWorkspaceStore.setState({
        selectedWorkspace: { ...workspace, id: "other" },
        project: "/other",
      }),
    );
    await act(async () => answer(true));
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    expect(useWorkspaceStore.getState().workspaceDrafts.workspace).toEqual(draft);
  });

  it("disables discard while applying and shows an accurate review-disabled reason", async () => {
    useWorkspaceStore.getState().setApplyingChanges(true);
    await renderRoute();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
    expect(screen.getByText("Applying…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(confirm).not.toHaveBeenCalled();
  });
});
