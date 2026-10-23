// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type {
  ChangeSet,
  Manifest,
  RuntimeInfo,
  SessionHandoffLaunchRequest,
  WorkspaceScan,
} from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { Route } from "./changes";
import { Route as WorkspaceRoute } from "./route";
import { Route as DoctorRoute } from "./doctor";

const navigate = vi.hoisted(() => vi.fn());
const workspaces = vi.hoisted(() => vi.fn());
const outlet = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => ({ confirm }) }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({}),
  useLocation: () => ({ pathname: "/workspace/workspace/changes" }),
  Outlet: () => outlet(),
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeDoctorReport: () => ({ data: undefined, refetch: vi.fn() }),
  useHomeMemories: () => ({ data: [] }),
  homeKeys: { all: ["home"] },
  useHomeWorkspaces: () => ({ data: workspaces(), isPending: false }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({
  WorkspaceOpenWith: () => null,
}));
vi.mock("@/features/workspace/WorkspaceDoctorPage", () => ({
  WorkspaceDoctorPage: ({ onRepair }: { onRepair: () => Promise<void> }) => (
    <button onClick={() => void onRepair()}>Plan repairs</button>
  ),
}));
vi.mock("@/core/api", () => ({
  api: {
    plan: vi.fn(),
    apply: vi.fn(),
    scan: vi.fn(),
    manifest: vi.fn(),
    runtime: vi.fn(),
    updateOnboarding: vi.fn(),
    continueSessionHandoff: vi.fn(),
    launchSessionHandoff: vi.fn(),
  },
}));

const manifest = (shared: string): Manifest => ({
  schema_version: 2,
  workspace: { id: "workspace", name: "Workspace" },
  instructions: { shared, scoped: [], platform_overrides: {} },
  skills: [],
  mcp: { config: "mcp.json" },
  connections: [],
  memories: { require_approval: true },
  adapters: {},
});
const baseline = manifest("saved instructions");
const draft = manifest("unsaved instructions");
const diskAfterApply = manifest("applied instructions");
const changeSet: ChangeSet = {
  id: "plan-before-home",
  project_root: "/workspace",
  created_at: "2026-10-16T00:00:00Z",
  requires_home_approval: false,
  changes: [
    {
      target: "/workspace/AGENTS.md",
      scope: "project",
      before: "saved instructions",
      after: "planned instructions",
      risk: "low",
      validator: "markdown",
    },
  ],
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
async function renderRoute(withLayout = false, expectedHeading = "Change plan") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const WorkspaceChangesRoute = Route.options.component!;
  const Component = withLayout ? WorkspaceRoute.options.component! : WorkspaceChangesRoute;
  // Load both lazy routes before the layout renders its real changes outlet.
  await WorkspaceChangesRoute.preload?.();
  if (withLayout) await Component.preload?.();
  outlet.mockImplementation(() => <WorkspaceChangesRoute />);
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <Component />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  if (
    useWorkspaceStore.getState().changeSetOrigin === "standard" ||
    useWorkspaceStore.getState().changeSetOrigin === "doctor"
  )
    await screen.findByRole("region", { name: expectedHeading });
  else await screen.findByText(expectedHeading);
}
async function renderDoctor() {
  const Component = DoctorRoute.options.component!;
  await Component.preload?.();
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
  });
  await screen.findByRole("button", { name: "Plan repairs" });
}

describe("workspace changes lifecycle", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    confirm.mockResolvedValue(true);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      project: "/workspace",
      selectedWorkspace: {
        id: "workspace",
        path: "/workspace",
        name: "Workspace",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      },
      manifest: draft,
      scan: { root: "/workspace", manifest_exists: true, agents: [], assets: [], warnings: [] },
      baselineManifest: JSON.stringify(baseline),
      workspaceDrafts: { workspace: baseline, other: manifest("other draft") },
    });
    workspaces.mockReturnValue([useWorkspaceStore.getState().selectedWorkspace]);
    useWorkspaceStore.getState().setChangeSet(changeSet, draft);
    vi.mocked(api.apply).mockResolvedValue({ applied: [], backup_dir: "/backup" });
    vi.mocked(api.scan).mockResolvedValue({
      root: "/workspace",
      manifest_exists: true,
      agents: [],
      assets: [],
      warnings: [],
    });
    vi.mocked(api.manifest).mockResolvedValue(diskAfterApply);
    vi.mocked(api.runtime).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
    vi.mocked(api.updateOnboarding).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
  });
  afterEach(cleanup);

  it("keeps Home planning pending and excludes apply, reject and duplicate planning", async () => {
    const request = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValue(request.promise);
    await renderRoute();
    const includeHome = screen.getByRole("button", { name: "Include global configuration" });
    const apply = screen.getByRole("button", { name: "Apply 1 change" });
    const reject = screen.getByRole("button", { name: /^Reject( Changes)?$/ });
    fireEvent.click(includeHome);
    fireEvent.click(includeHome);
    fireEvent.click(apply);
    fireEvent.click(reject);
    expect(api.plan).toHaveBeenCalledOnce();
    expect(api.plan).toHaveBeenCalledWith("/workspace", draft, true);
    expect(includeHome).toBeDisabled();
    expect(includeHome).toHaveAttribute("aria-busy", "true");
    expect(apply).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(api.apply).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => request.resolve({ ...changeSet, id: "home-plan" }));
    expect(includeHome).toBeDisabled();
    expect(includeHome).toHaveTextContent("Global configuration included");
    expect(apply).toBeEnabled();
    expect(reject).toBeEnabled();
    expect(useWorkspaceStore.getState().changeSetManifest).toBe(JSON.stringify(draft));
  });

  it("shows a Home planning failure locally and permits retry", async () => {
    vi.mocked(api.plan).mockRejectedValueOnce(new Error("home planning failed"));
    await renderRoute();
    const includeHome = screen.getByRole("button", { name: "Include global configuration" });
    fireEvent.click(includeHome);
    expect(await screen.findByRole("alert")).toHaveTextContent("home planning failed");
    expect(useWorkspaceStore.getState().message).toBe("");
    expect(includeHome).toBeEnabled();
    vi.mocked(api.plan).mockResolvedValue({ ...changeSet, id: "retried-home-plan" });
    fireEvent.click(includeHome);
    await waitFor(() =>
      expect(useWorkspaceStore.getState().changeSet?.id).toBe("retried-home-plan"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("blocks parent review and scan actions throughout an in-flight application", async () => {
    const applyRequest = deferred<Awaited<ReturnType<typeof api.apply>>>();
    vi.mocked(api.apply).mockReturnValue(applyRequest.promise);
    await renderRoute(true);
    expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
    const scan = screen.getByRole("button", { name: "Scan" });
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));

    expect(scan).toBeDisabled();

    fireEvent.click(scan);
    expect(api.plan).not.toHaveBeenCalled();
    expect(api.scan).not.toHaveBeenCalled();
    await act(async () => applyRequest.resolve({ applied: [], backup_dir: "/backup" }));
    await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
    expect(useWorkspaceStore.getState().applyingChanges).toBe(false);
    expect(api.apply).toHaveBeenCalledOnce();
    expect(api.scan).toHaveBeenCalledOnce();
  });

  it("does not install a standard plan if its draft changes during generation", async () => {
    const request = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValue(request.promise);
    await renderRoute(true);
    act(() => useWorkspaceStore.getState().setChangeSetInvalidated(true));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    act(() => useWorkspaceStore.getState().setManifest(manifest("newer editor draft")));
    await act(async () => request.resolve({ ...changeSet, id: "obsolete-standard-plan" }));
    expect(useWorkspaceStore.getState().changeSet?.id).toBe(changeSet.id);
    expect(useWorkspaceStore.getState().changeSetInvalidated).toBe(true);
    expect(useWorkspaceStore.getState().manifest).toEqual(manifest("newer editor draft"));
    expect(useWorkspaceStore.getState().busy).toBe(false);
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("does not restore an obsolete Home plan after the draft changes", async () => {
    const request = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValue(request.promise);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    act(() => useWorkspaceStore.getState().setManifest(manifest("newer edit")));
    await act(async () => request.resolve({ ...changeSet, id: "obsolete-home-plan" }));
    expect(useWorkspaceStore.getState().changeSet?.id).toBe(changeSet.id);
    expect(useWorkspaceStore.getState().changeSetInvalidated).toBe(true);
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeDisabled();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("records Doctor's disk input and preserves the separate editor draft after applying", async () => {
    vi.mocked(api.manifest).mockResolvedValueOnce(baseline);
    vi.mocked(api.plan).mockResolvedValue({ ...changeSet, id: "doctor-plan" });
    await renderDoctor();
    fireEvent.click(screen.getByRole("button", { name: "Plan repairs" }));
    await waitFor(() => expect(useWorkspaceStore.getState().changeSet?.id).toBe("doctor-plan"));
    expect(api.plan).toHaveBeenCalledWith("/workspace", baseline, false);
    expect(useWorkspaceStore.getState().changeSetManifest).toBe(JSON.stringify(baseline));
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    cleanup();
    navigate.mockClear();
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(diskAfterApply));
  });

  it("retains a Doctor response generated from disk when the separate editor draft changes", async () => {
    const request = deferred<ChangeSet>();
    vi.mocked(api.manifest).mockResolvedValue(baseline);
    vi.mocked(api.plan).mockReturnValue(request.promise);
    await renderDoctor();
    fireEvent.click(screen.getByRole("button", { name: "Plan repairs" }));
    await waitFor(() => expect(api.plan).toHaveBeenCalled());
    act(() => useWorkspaceStore.getState().setManifest(manifest("newer editor draft")));
    await act(async () => request.resolve({ ...changeSet, id: "obsolete-doctor-plan" }));
    expect(useWorkspaceStore.getState().changeSet?.id).toBe("obsolete-doctor-plan");
    expect(useWorkspaceStore.getState().changeSetOrigin).toBe("doctor");
    expect(useWorkspaceStore.getState().manifest?.instructions.shared).toBe("newer editor draft");
    expect(navigate).toHaveBeenCalled();
  });

  it.each(["doctor", "handoff", "handoff-setup"] as const)(
    "preserves an unconsumed draft after applying a %s plan",
    async (origin) => {
      const state = useWorkspaceStore.getState();
      state.setChangeSetOrigin(origin);
      state.setChangeSet(changeSet, origin === "doctor" ? baseline : undefined);
      await renderRoute();
      fireEvent.click(
        screen.getByRole("button", {
          name: origin === "doctor" ? "Apply 1 change" : "Apply 1 Changes",
        }),
      );
      await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
      const current = useWorkspaceStore.getState();
      expect(current.manifest).toEqual(draft);
      expect(current.baselineManifest).toBe(JSON.stringify(diskAfterApply));
      expect(current.workspaceDrafts.workspace).toEqual(draft);
      expect(current.workspaceDrafts.other).toEqual(manifest("other draft"));
    },
  );

  it("consumes the reviewed standard draft and removes its old cache", async () => {
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
    const current = useWorkspaceStore.getState();
    expect(current.manifest).toEqual(diskAfterApply);
    expect(current.baselineManifest).toBe(JSON.stringify(diskAfterApply));
    expect(current.workspaceDrafts.workspace).toBeUndefined();
    expect(current.workspaceDrafts.other).toEqual(manifest("other draft"));
    expect(current.applyingChanges).toBe(false);
  });

  it("keeps a visible success result and a read-only copy of the applied diff", async () => {
    vi.mocked(api.apply).mockResolvedValue({
      applied: ["/workspace/AGENTS.md"],
      backup_dir: "/backups/last-apply",
    });
    await renderRoute(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
    expect(await screen.findByText("Changes applied to 1 file")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "View applied changes" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("/workspace/AGENTS.md");
    expect(dialog).toHaveTextContent("saved instructions");
    expect(dialog).toHaveTextContent("planned instructions");
    expect(dialog).toHaveTextContent("/backups/last-apply");
    expect(api.apply).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
  });

  it("retains the applied result even if the post-apply refresh fails", async () => {
    vi.mocked(api.apply).mockResolvedValue({
      applied: ["/workspace/AGENTS.md"],
      backup_dir: "/backups/last-apply",
    });
    vi.mocked(api.scan).mockRejectedValue(new Error("reload failed"));
    await renderRoute(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await screen.findByText("Changes applied to 1 file");
    await waitFor(() => expect(useWorkspaceStore.getState().message).toContain("reload failed"));
    expect(useWorkspaceStore.getState().appliedChanges?.changeSet.id).toBe(changeSet.id);
    expect(api.apply).toHaveBeenCalledOnce();
  });

  it("keeps the reviewed diff mounted but blocks mutations while the workspace is refreshing", async () => {
    vi.mocked(api.manifest).mockResolvedValueOnce(baseline);
    const refresh = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(refresh.promise);
    await renderRoute(true);
    const heading = screen.getByRole("region", { name: "Change plan" });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(screen.getByRole("region", { name: "Change plan" })).toBe(heading);
    const apply = screen.getByRole("button", { name: "Apply 1 change" });
    const home = screen.getByRole("button", { name: "Include global configuration" });
    const reject = screen.getByRole("button", { name: /^Reject( Changes)?$/ });
    expect(apply).toBeDisabled();
    expect(home).toBeDisabled();
    expect(reject).toBeDisabled();
    fireEvent.click(apply);
    fireEvent.click(home);
    fireEvent.click(reject);
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.plan).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () =>
      refresh.resolve({
        root: "/workspace",
        manifest_exists: true,
        agents: [],
        assets: [],
        warnings: [],
      }),
    );
    expect(screen.getByRole("region", { name: "Change plan" })).toBe(heading);
    expect(apply).toBeEnabled();
    expect(home).toBeEnabled();
  });

  it.each([
    ["a new edit", manifest("edited during reload")],
    ["an edit reverting to the old baseline", baseline],
  ])("preserves %s while the applied files are reloading", async (_label, newerDraft) => {
    const reload = deferred<Manifest>();
    vi.mocked(api.manifest).mockReturnValue(reload.promise);
    await renderRoute();
    fireEvent.click(screen.getByRole("button", { name: "Apply 1 change" }));
    await waitFor(() => expect(api.manifest).toHaveBeenCalled());
    act(() => useWorkspaceStore.getState().setManifest(newerDraft));
    await act(async () => reload.resolve(diskAfterApply));
    expect(useWorkspaceStore.getState().manifest).toEqual(newerDraft);
    expect(useWorkspaceStore.getState().workspaceDrafts.workspace).toEqual(newerDraft);
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(diskAfterApply));
  });

  it.each(["transport interruption", "unknown outcome"])(
    "retains the reviewed diff through %s and only reports success after reconciliation",
    async (outcome) => {
      const request: SessionHandoffLaunchRequest = {
        mode: "native-import",
        operation_id: "operation",
        plan_hash: "hash",
        target_agent: "opencode",
        workspace_id: "workspace",
      };
      useWorkspaceStore.getState().setChangeSet(changeSet);
      useWorkspaceStore.getState().setChangeSetOrigin("handoff");
      useWorkspaceStore.getState().setHandoffLaunchRequest(request);
      if (outcome === "transport interruption")
        vi.mocked(api.continueSessionHandoff).mockRejectedValue(new Error("transport interrupted"));
      else
        vi.mocked(api.continueSessionHandoff).mockResolvedValue({
          status: "import-outcome-unknown",
          error: { key: "runtime.unknown" },
        });
      vi.mocked(api.launchSessionHandoff)
        .mockRejectedValueOnce(new Error("verification still pending"))
        .mockResolvedValue({ target_agent: "opencode", terminal: "Terminal" });
      await renderRoute(true);
      fireEvent.click(screen.getByRole("button", { name: "Apply and continue in OpenCode" }));
      await screen.findByRole("button", { name: "Check import and continue" });
      await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
      expect(useWorkspaceStore.getState().manifest).toEqual(draft);
      expect(useWorkspaceStore.getState().handoffLaunchRequest).toEqual(request);
      expect(useWorkspaceStore.getState().handoffRecoveryChanges).toEqual({
        workspaceId: "workspace",
        project: "/workspace",
        changeSet,
      });
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(screen.queryByText("Applied files: 1")).toBeNull();

      cleanup();
      await renderRoute(true, "Import needs verification");
      fireEvent.click(screen.getByRole("button", { name: "Check import and continue" }));
      await screen.findByText(/verification still pending/);
      expect(useWorkspaceStore.getState().handoffRecoveryChanges?.changeSet).toEqual(changeSet);
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(screen.queryByText("Applied files: 1")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Check import and continue" }));
      expect(await screen.findByText("Applied files: 1")).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "View applied changes" }));
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveTextContent("/workspace/AGENTS.md");
      expect(dialog).toHaveTextContent("saved instructions");
      expect(dialog).toHaveTextContent("planned instructions");
      expect(useWorkspaceStore.getState().handoffRecoveryChanges).toBeUndefined();
      expect(useWorkspaceStore.getState().handoffLaunchRequest).toBeUndefined();
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/workspace/$workspaceId/sessions" }),
      );
      expect(api.launchSessionHandoff).toHaveBeenCalledTimes(2);
      expect(api.launchSessionHandoff).toHaveBeenLastCalledWith(request);
      expect(api.continueSessionHandoff).toHaveBeenCalledOnce();
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it("keeps known applied results while retrying a failed handoff launch", async () => {
    const request: SessionHandoffLaunchRequest = {
      mode: "native-import",
      operation_id: "operation",
      plan_hash: "hash",
      target_agent: "opencode",
      workspace_id: "workspace",
    };
    useWorkspaceStore.getState().setChangeSet(changeSet);
    useWorkspaceStore.getState().setChangeSetOrigin("handoff");
    useWorkspaceStore.getState().setHandoffLaunchRequest(request);
    vi.mocked(api.continueSessionHandoff).mockResolvedValue({
      status: "applied-launch-failed",
      error: { key: "runtime.unknown" },
    });
    vi.mocked(api.launchSessionHandoff).mockResolvedValue({
      target_agent: "opencode",
      terminal: "Terminal",
    });
    await renderRoute(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply and continue in OpenCode" }));
    expect(await screen.findByText("Applied files: 1")).toBeVisible();
    await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
    const applied = useWorkspaceStore.getState().appliedChanges;
    expect(useWorkspaceStore.getState().handoffRecoveryChanges).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Check import and continue" }));
    await waitFor(() => expect(useWorkspaceStore.getState().handoffLaunchRequest).toBeUndefined());
    expect(useWorkspaceStore.getState().appliedChanges).toBe(applied);
    expect(api.continueSessionHandoff).toHaveBeenCalledOnce();
    expect(api.apply).not.toHaveBeenCalled();
  });
});
