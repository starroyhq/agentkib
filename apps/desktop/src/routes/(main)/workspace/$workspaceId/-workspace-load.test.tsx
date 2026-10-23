// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type {
  ChangeSet,
  Manifest,
  RuntimeInfo,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useWorkspaceTransitions } from "@/features/app/useWorkspaceTransitions";
import { Route } from "./route";

const doubles = vi.hoisted(() => ({
  workspaceId: "workspace",
  pathname: "/workspace/workspace/assets",
  navigate: vi.fn(),
  workspaces: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useParams: () => ({ workspaceId: doubles.workspaceId }),
  useLocation: () => ({ pathname: doubles.pathname }),
  Outlet: () => <WorkspaceContent />,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeDoctorReport: () => ({ data: undefined, refetch: vi.fn() }),
  useHomeMemories: () => ({ data: [] }),
  useHomeWorkspaces: () => ({ data: doubles.workspaces(), isPending: false }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({ WorkspaceOpenWith: () => null }));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: doubles.confirm }),
}));
vi.mock("@/core/api", () => ({
  api: { scan: vi.fn(), manifest: vi.fn(), runtime: vi.fn(), plan: vi.fn() },
}));

function WorkspaceContent() {
  const [selection, setSelection] = useState("");
  const current = useWorkspaceStore((state) => state.manifest);
  return (
    <div data-testid="workspace-scroll">
      <p>Workspace content</p>
      <input
        aria-label="Selected file"
        value={selection}
        onChange={(e) => setSelection(e.target.value)}
      />
      {current && (
        <textarea
          aria-label="Workspace draft"
          value={current.instructions.shared}
          onChange={(e) =>
            useWorkspaceStore.getState().setManifest({
              ...current,
              instructions: { ...current.instructions, shared: e.target.value },
            })
          }
        />
      )}
    </div>
  );
}

const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Workspace",
  path: "/workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const otherWorkspace: WorkspaceSummary = {
  ...workspace,
  id: "other",
  name: "Other",
  path: "/other",
};
const manifest: Manifest = {
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared: "saved instructions", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
  adapters: {},
};
const scan: WorkspaceScan = {
  root: workspace.path,
  manifest_exists: true,
  agents: [],
  assets: [],
  warnings: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function renderRoute() {
  const Component = Route.options.component!;
  // Wait for route splitting before checking the rendered UI's readiness.
  await Component.preload?.();
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
  });
  await screen.findByRole("heading", { name: workspace.name });
}

describe("workspace load recovery", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.workspaceId = workspace.id;
    doubles.pathname = "/workspace/workspace/assets";
    doubles.workspaces.mockReturnValue([workspace, otherWorkspace]);
    doubles.confirm.mockResolvedValue(false);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({ project: workspace.path, selectedWorkspace: workspace });
    vi.mocked(api.scan).mockResolvedValue(scan);
    vi.mocked(api.manifest).mockResolvedValue(manifest);
    vi.mocked(api.runtime).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
  });
  afterEach(cleanup);

  it.each([true, false, "unchanged"] as const)(
    "retains a draft's disk baseline across workspace switches (resolution: %s)",
    async (resolution) => {
      const draft = {
        ...manifest,
        instructions: { ...manifest.instructions, shared: "cached edit" },
      };
      const disk =
        resolution === "unchanged"
          ? manifest
          : {
              ...manifest,
              instructions: { ...manifest.instructions, shared: "external edit while away" },
            };
      useWorkspaceStore.setState({
        manifest: draft,
        scan,
        baselineManifest: JSON.stringify(manifest),
      });
      const transitions = renderHook(() =>
        useWorkspaceTransitions({
          route: { kind: "workspace", workspaceId: workspace.id, page: "assets" },
          navigateWorkspacePageFor: doubles.navigate,
          clearGitSubview: vi.fn(),
          invalidatePendingLoad: vi.fn(),
        }),
      );
      await act(async () => {
        await transitions.result.current.openWorkspace(otherWorkspace);
        await transitions.result.current.openWorkspace(workspace);
      });
      transitions.unmount();
      expect(useWorkspaceStore.getState().baselineManifest).toBe("");
      expect(useWorkspaceStore.getState().workspaceDraftBaselines[workspace.id]).toBe(
        JSON.stringify(manifest),
      );
      doubles.confirm.mockResolvedValue(resolution === true);
      vi.mocked(api.manifest).mockResolvedValueOnce(disk);
      await renderRoute();
      await screen.findByRole("textbox", { name: "Workspace draft" });
      expect(doubles.confirm).toHaveBeenCalledTimes(resolution === "unchanged" ? 0 : 1);
      const expected = resolution === true ? disk : draft;
      expect(useWorkspaceStore.getState().manifest).toEqual(expected);
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(disk));
      expect(useWorkspaceStore.getState().workspaceDraftBaselines[workspace.id]).toBe(
        resolution === true ? undefined : JSON.stringify(disk),
      );
    },
  );

  it("preserves the cached baseline after a failed manifest read so retry detects external edits", async () => {
    const draft = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "cached edit" },
    };
    useWorkspaceStore.getState().cacheWorkspaceDraft(workspace.id, draft, JSON.stringify(manifest));
    vi.mocked(api.manifest).mockRejectedValueOnce(new Error("manifest unavailable"));
    await renderRoute();
    await screen.findByRole("textbox", { name: "Workspace draft" });
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(manifest));
    expect(useWorkspaceStore.getState().workspaceDraftBaselines[workspace.id]).toBe(
      JSON.stringify(manifest),
    );
    vi.mocked(api.manifest).mockResolvedValueOnce({
      ...manifest,
      instructions: { ...manifest.instructions, shared: "external update" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(doubles.confirm).toHaveBeenCalledOnce());
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
  });

  it("replaces a failed first scan with a visible cause and a working retry", async () => {
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("scan unavailable"));
    await renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("scan unavailable");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("Workspace content")).toBeNull();
    expect(useWorkspaceStore.getState().message).toBe("");
    const retry = screen.getByRole("button", { name: "Rescan workspace" });
    const retryRequest = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(retryRequest.promise);
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(retry).toHaveAttribute("aria-busy", "true");
    expect(api.scan).toHaveBeenCalledTimes(2);
    await act(async () => retryRequest.resolve(scan));
    await screen.findByText("Workspace content");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useWorkspaceStore.getState().scan).toEqual(scan);
  });

  it("also shows runtime loading failures instead of leaving a skeleton", async () => {
    vi.mocked(api.runtime).mockRejectedValueOnce(new Error("runtime unavailable"));
    await renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("runtime unavailable");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Rescan workspace" }));
    await screen.findByText("Workspace content");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps an existing draft and content available after a failed refresh", async () => {
    const draft = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "unsaved edit" },
    };
    useWorkspaceStore.setState({
      scan,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest),
    });
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("refresh failed"));
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("refresh failed");
    expect(screen.getByText("Workspace content")).toBeVisible();
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    fireEvent.click(screen.getByRole("button", { name: "Rescan workspace" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
  });

  it("loads external manifest updates without creating a false draft", async () => {
    useWorkspaceStore.setState({ scan, manifest, baselineManifest: JSON.stringify(manifest) });
    const disk = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "external update" },
    };
    vi.mocked(api.manifest).mockResolvedValueOnce(disk);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Workspace draft" })).toHaveValue(
        "external update",
      ),
    );
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(disk));
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    expect(doubles.confirm).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "asks before resolving external edits against an unsaved draft (load disk: %s)",
    async (loadDisk) => {
      const draft = {
        ...manifest,
        instructions: { ...manifest.instructions, shared: "unsaved edit" },
      };
      const disk = {
        ...manifest,
        instructions: { ...manifest.instructions, shared: "external update" },
      };
      useWorkspaceStore.setState({
        scan,
        manifest: draft,
        baselineManifest: JSON.stringify(manifest),
      });
      vi.mocked(api.manifest).mockResolvedValueOnce(disk);
      doubles.confirm.mockResolvedValueOnce(loadDisk);
      await renderRoute();
      fireEvent.click(screen.getByRole("button", { name: "Scan" }));
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      expect(doubles.confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: "warning" }));
      expect(useWorkspaceStore.getState().manifest).toEqual(loadDisk ? disk : draft);
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(disk));
    },
  );

  it("does not apply an old workspace's failure after switching workspaces", async () => {
    const oldRequest = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(oldRequest.promise);
    await renderRoute();
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith(workspace.path));
    const otherManifest = { ...manifest, workspace: { id: "other", name: "Other" } };
    vi.mocked(api.manifest).mockResolvedValue(otherManifest);
    vi.mocked(api.scan).mockResolvedValue({ ...scan, root: otherWorkspace.path });
    act(() => {
      doubles.workspaceId = otherWorkspace.id;
      doubles.pathname = "/workspace/other/assets";
      useWorkspaceStore.setState({
        selectedWorkspace: otherWorkspace,
        project: otherWorkspace.path,
        scan: undefined,
        manifest: undefined,
        baselineManifest: "",
      });
    });
    await screen.findByRole("heading", { name: "Other" });
    await screen.findByText("Workspace content");
    await act(async () => oldRequest.reject(new Error("obsolete failure")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useWorkspaceStore.getState().manifest).toEqual(otherManifest);
  });

  it("clears a previous refresh error when another refresh entry loads a new scan", async () => {
    useWorkspaceStore.setState({ scan, manifest, baselineManifest: JSON.stringify(manifest) });
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("refresh failed"));
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("alert");

    // The global toolbar loads into the same store without invoking this route's retry handler.
    act(() => useWorkspaceStore.getState().setScan({ ...scan }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Workspace content")).toBeVisible();
  });

  it("does not carry a previous workspace's visible failure into another workspace", async () => {
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("workspace one failed"));
    await renderRoute();
    await screen.findByRole("alert");
    act(() => {
      doubles.workspaceId = otherWorkspace.id;
      doubles.pathname = "/workspace/other/assets";
      useWorkspaceStore.setState({
        selectedWorkspace: otherWorkspace,
        project: otherWorkspace.path,
      });
    });
    await screen.findByText("Workspace content");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not show an older pending failure after another refresh has succeeded", async () => {
    useWorkspaceStore.setState({ scan, manifest, baselineManifest: JSON.stringify(manifest) });
    const olderRequest = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(olderRequest.promise);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    act(() => useWorkspaceStore.getState().setScan({ ...scan }));
    await act(async () => olderRequest.reject(new Error("older refresh failed")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Workspace content")).toBeVisible();
  });

  it("keeps Doctor accessible when the workspace scan fails", async () => {
    doubles.pathname = "/workspace/workspace/doctor";
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("scan failed"));
    await renderRoute();
    await screen.findByRole("alert");
    expect(screen.getByText("Workspace content")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("blocks the error-state retry while a ChangeSet is applying", async () => {
    vi.mocked(api.scan).mockRejectedValueOnce(new Error("scan failed"));
    await renderRoute();
    await screen.findByRole("alert");
    act(() => useWorkspaceStore.getState().setApplyingChanges(true));
    const retry = screen.getByRole("button", { name: "Rescan workspace" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(api.scan).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])(
    "retains the mounted Git selection and scroll during refresh %s",
    async (outcome) => {
      doubles.pathname = "/workspace/workspace/git";
      useWorkspaceStore.setState({ scan, manifest, baselineManifest: JSON.stringify(manifest) });
      const pending = deferred<WorkspaceScan>();
      vi.mocked(api.scan).mockReturnValueOnce(pending.promise);
      await renderRoute();
      const viewport = screen.getByTestId("workspace-scroll");
      viewport.scrollTop = 240;
      fireEvent.change(screen.getByRole("textbox", { name: "Selected file" }), {
        target: { value: "src/app.ts" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Scan" }));

      expect(screen.getByTestId("workspace-scroll")).toBe(viewport);
      expect(screen.getByRole("textbox", { name: "Selected file" })).toHaveValue("src/app.ts");
      expect(viewport.scrollTop).toBe(240);
      expect(screen.getByRole("status")).toHaveTextContent("Updating workspace");
      expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
      await act(async () => {
        if (outcome === "success") pending.resolve({ ...scan });
        else pending.reject(new Error("refresh failed"));
      });
      expect(screen.getByTestId("workspace-scroll")).toBe(viewport);
      expect(screen.getByRole("textbox", { name: "Selected file" })).toHaveValue("src/app.ts");
      expect(viewport.scrollTop).toBe(240);
      expect(screen.queryByRole("status")).toBeNull();
      if (outcome === "failure")
        expect(screen.getByRole("alert")).toHaveTextContent("refresh failed");
    },
  );

  it.each(["typed during refresh", "saved instructions"])(
    "preserves the newer draft %s while updating its disk baseline",
    async (text) => {
      const draft = {
        ...manifest,
        instructions: { ...manifest.instructions, shared: "original draft" },
      };
      const disk = {
        ...manifest,
        instructions: { ...manifest.instructions, shared: "new disk content" },
      };
      useWorkspaceStore.setState({
        scan,
        manifest: draft,
        baselineManifest: JSON.stringify(manifest),
      });
      const pending = deferred<WorkspaceScan>();
      vi.mocked(api.scan).mockReturnValueOnce(pending.promise);
      vi.mocked(api.manifest).mockResolvedValueOnce(disk);
      await renderRoute();
      fireEvent.click(screen.getByRole("button", { name: "Scan" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Workspace draft" }), {
        target: { value: text },
      });
      await act(async () => pending.resolve(scan));
      expect(screen.getByRole("textbox", { name: "Workspace draft" })).toHaveValue(text);
      expect(useWorkspaceStore.getState().manifest?.instructions.shared).toBe(text);
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(disk));
    },
  );

  it("retains content during planning and ignores a plan superseded by a new edit", async () => {
    const draft = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "original draft" },
    };
    useWorkspaceStore.setState({
      scan,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest),
    });
    const pending = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValueOnce(pending.promise);
    await renderRoute();
    const viewport = screen.getByTestId("workspace-scroll");
    fireEvent.change(screen.getByRole("textbox", { name: "Selected file" }), {
      target: { value: "unchanged selection" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByTestId("workspace-scroll")).toBe(viewport);
    expect(screen.getByRole("status")).toHaveTextContent("Generating change plan");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace draft" }), {
      target: { value: "newer draft" },
    });
    await act(async () =>
      pending.resolve({
        id: "old-plan",
        project_root: workspace.path,
        created_at: "",
        changes: [],
        requires_home_approval: false,
      }),
    );
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
    expect(doubles.navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId("workspace-scroll")).toBe(viewport);
    expect(screen.getByRole("textbox", { name: "Selected file" })).toHaveValue(
      "unchanged selection",
    );
    expect(screen.getByRole("textbox", { name: "Workspace draft" })).toHaveValue("newer draft");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("The draft changed. Review changes again.");
  });

  it("shows a failed change plan locally without leaving an error in the global banner", async () => {
    const draft = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "unsaved edit" },
    };
    useWorkspaceStore.setState({
      scan,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest),
    });
    vi.mocked(api.plan).mockRejectedValueOnce(new Error("planning unavailable"));
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("planning unavailable");
    expect(useWorkspaceStore.getState().message).toBe("");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeEnabled();
  });

  it("does not carry the planning label into another workspace's scan", async () => {
    const pendingPlan = deferred<ChangeSet>();
    const draft = {
      ...manifest,
      instructions: { ...manifest.instructions, shared: "unsaved edit" },
    };
    useWorkspaceStore.setState({
      scan,
      manifest: draft,
      baselineManifest: JSON.stringify(manifest),
    });
    vi.mocked(api.plan).mockReturnValueOnce(pendingPlan.promise);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("status")).toHaveTextContent("Generating change plan");
    const nextScan = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(nextScan.promise);
    act(() => {
      doubles.workspaceId = otherWorkspace.id;
      doubles.pathname = "/workspace/other/assets";
      useWorkspaceStore.setState({
        selectedWorkspace: otherWorkspace,
        project: otherWorkspace.path,
        busy: false,
        manifest,
        scan: { ...scan, root: otherWorkspace.path },
        baselineManifest: JSON.stringify(manifest),
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(screen.getByRole("status")).toHaveTextContent("Updating workspace");
    await act(async () => nextScan.resolve({ ...scan, root: otherWorkspace.path }));
    await act(async () =>
      pendingPlan.resolve({
        id: "old",
        project_root: workspace.path,
        created_at: "",
        requires_home_approval: false,
        changes: [],
      }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
  });
});
