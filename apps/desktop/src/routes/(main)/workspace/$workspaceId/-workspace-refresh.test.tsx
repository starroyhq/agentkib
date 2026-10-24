// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { Manifest, RuntimeInfo, WorkspaceScan, WorkspaceSummary } from "@/core/types";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import { draftSectionCount } from "@/features/workspace/manifest-draft";
import { Route } from "./route";

const doubles = vi.hoisted(() => ({
  workspaceId: "workspace",
  pathname: "/workspace/workspace/assets",
  navigate: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(false),
  workspaces: vi.fn(),
  emptyQuery: { data: [], isPending: false },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useParams: () => ({ workspaceId: doubles.workspaceId }),
  useLocation: () => ({ pathname: doubles.pathname }),
  useSearch: () => ({}),
  Outlet: () => <p>Workspace content</p>,
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeDoctorReport: () => ({ data: undefined, refetch: vi.fn() }),
  useHomeWorkspaces: () => ({ data: doubles.workspaces(), isPending: false }),
  useHomeMemories: () => doubles.emptyQuery,
  useHomeRefreshJobs: () => doubles.emptyQuery,
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({
    notify: doubles.notify,
    confirm: doubles.confirm,
  }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({ WorkspaceOpenWith: () => null }));
vi.mock("@/core/api", () => ({
  api: { scan: vi.fn(), manifest: vi.fn(), runtime: vi.fn(), plan: vi.fn() },
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  path: "/workspace",
  name: "Workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const otherWorkspace: WorkspaceSummary = {
  ...workspace,
  id: "other",
  path: "/other",
  name: "Other",
};
function manifestFor(target = workspace): Manifest {
  return {
    schema_version: 2,
    workspace: { id: target.id, name: target.name },
    instructions: { shared: "saved " + target.id, scoped: [], platform_overrides: {} },
    skills: [],
    connections: [],
    adapters: {},
    mcp: { config: "mcp.json" },
    memories: { require_approval: true },
  };
}
function scanFor(target = workspace): WorkspaceScan {
  return { root: target.path, manifest_exists: true, agents: [], assets: [], warnings: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Harness() {
  const app = useAppNavigation({
    kind: "workspace",
    workspaceId: doubles.workspaceId,
    page: "assets",
  });
  const Layout = Route.options.component!;
  return (
    <>
      <button onClick={() => void app.refreshCurrentView()}>Refresh from app</button>
      <Layout />
    </>
  );
}
async function renderWorkspace() {
  // Wait for route splitting before checking the rendered UI's readiness.
  await Route.options.component!.preload?.();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await screen.findByText("Workspace content");
}
async function refresh(entry: "local" | "global") {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: entry === "local" ? "Scan" : "Refresh from app",
      }),
    );
  });
}
beforeAll(() => initializeI18n("en-US"));
beforeEach(() => {
  vi.resetAllMocks();
  doubles.workspaceId = workspace.id;
  doubles.pathname = "/workspace/workspace/assets";
  doubles.workspaces.mockReturnValue([workspace, otherWorkspace]);
  doubles.navigate.mockResolvedValue(undefined);
  doubles.notify.mockResolvedValue(undefined);
  doubles.confirm.mockResolvedValue(false);
  useAppStore.setState(useAppStore.getInitialState(), true);
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  const manifest = manifestFor();
  useWorkspaceStore.setState({
    selectedWorkspace: workspace,
    project: workspace.path,
    scan: scanFor(),
    manifest,
    baselineManifest: JSON.stringify(manifest),
  });
  vi.mocked(api.scan).mockImplementation(async (project) =>
    scanFor(project === otherWorkspace.path ? otherWorkspace : workspace),
  );
  vi.mocked(api.manifest).mockImplementation(async (project) =>
    manifestFor(project === otherWorkspace.path ? otherWorkspace : workspace),
  );
  vi.mocked(api.runtime).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
});
afterEach(cleanup);

describe("workspace refresh entry coordination", () => {
  it.each(["local", "global"] as const)(
    "keeps the persisted identity and separate source metadata after a real manifest is deleted via %s refresh",
    async (entry) => {
      const baseline = manifestFor();
      const draft = { ...baseline, instructions: { ...baseline.instructions, shared: "draft" } };
      useWorkspaceStore.setState({ manifest: draft });
      vi.mocked(api.scan).mockResolvedValue({ ...scanFor(), manifest_exists: false });
      vi.mocked(api.manifest).mockResolvedValue({
        ...baseline,
        workspace: { ...baseline.workspace, id: "first-prepared-id" },
      });
      await renderWorkspace();
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledOnce();
      expect(useWorkspaceStore.getState().manifest).toEqual(draft);
      expect(useWorkspaceStore.getState().baselineManifestIsDefault).toBe(false);
      expect(useWorkspaceStore.getState().workspaceDraftBaselineDefaults[workspace.id]).toBe(false);
      expect(useWorkspaceStore.getState().workspaceDraftDiskDefaults[workspace.id]).toBe(true);
      vi.mocked(api.manifest).mockResolvedValue({
        ...baseline,
        workspace: { ...baseline.workspace, id: "second-prepared-id" },
      });
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledOnce();
      expect(useWorkspaceStore.getState().manifest).toEqual(draft);
      expect(draftSectionCount(draft, useWorkspaceStore.getState().baselineManifest)).toBe(1);
      vi.mocked(api.scan).mockResolvedValue(scanFor());
      vi.mocked(api.manifest).mockResolvedValue(baseline);
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["local", "global"] as const)(
    "remembers an acknowledged disk version across %s refresh without changing the editor baseline",
    async (entry) => {
      const baseline = manifestFor();
      const draft = { ...baseline, instructions: { ...baseline.instructions, shared: "draft" } };
      const disk = { ...baseline, workspace: { ...baseline.workspace, name: "external name" } };
      useWorkspaceStore.setState({ manifest: draft });
      vi.mocked(api.manifest).mockResolvedValue(disk);
      await renderWorkspace();
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledOnce();
      expect(
        draftSectionCount(
          useWorkspaceStore.getState().manifest,
          useWorkspaceStore.getState().baselineManifest,
        ),
      ).toBe(1);
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledOnce();
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(baseline));
      expect(useWorkspaceStore.getState().manifest).toEqual(draft);
      expect(
        draftSectionCount(
          useWorkspaceStore.getState().manifest,
          useWorkspaceStore.getState().baselineManifest,
        ),
      ).toBe(1);
      vi.mocked(api.manifest).mockResolvedValue({
        ...disk,
        workspace: { ...disk.workspace, name: "external again" },
      });
      await refresh(entry);
      expect(doubles.confirm).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["local", "global"] as const)(
    "preserves a default-manifest draft through %s refresh without a false conflict",
    async (entry) => {
      const baseline = manifestFor();
      const draft = {
        ...baseline,
        instructions: { ...baseline.instructions, shared: "one-section draft" },
      };
      const disk = { ...baseline, workspace: { ...baseline.workspace, id: "new-server-draft" } };
      useWorkspaceStore.setState({ manifest: draft, baselineManifestIsDefault: true });
      vi.mocked(api.scan).mockResolvedValue({ ...scanFor(), manifest_exists: false });
      vi.mocked(api.manifest).mockResolvedValue(disk);
      await renderWorkspace();
      await refresh(entry);
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      expect(doubles.confirm).not.toHaveBeenCalled();
      const current = useWorkspaceStore.getState();
      expect(current.manifest?.instructions.shared).toBe("one-section draft");
      expect(current.manifest?.workspace.id).toBe("new-server-draft");
      expect(draftSectionCount(current.manifest, current.baselineManifest)).toBe(1);
    },
  );

  it.each(["local", "global"] as const)(
    "keeps the original dirty-section count after declining a real %s refresh conflict",
    async (entry) => {
      const baseline = manifestFor();
      const draft = {
        ...baseline,
        instructions: { ...baseline.instructions, shared: "one-section draft" },
      };
      const disk = {
        ...manifestFor(),
        workspace: { id: "externally-replaced", name: "External" },
        instructions: { ...baseline.instructions, shared: "external source edit" },
      };
      useWorkspaceStore.setState({ manifest: draft });
      vi.mocked(api.manifest).mockResolvedValue(disk);
      await renderWorkspace();
      await refresh(entry);
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      expect(doubles.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: "Configuration changed on disk",
          confirmLabel: "Discard draft and load disk version",
          cancelLabel: "Keep draft",
        }),
      );
      const current = useWorkspaceStore.getState();
      expect(current.manifest).toEqual(draft);
      expect(current.baselineManifest).toBe(JSON.stringify(baseline));
      expect(draftSectionCount(current.manifest, current.baselineManifest)).toBe(1);
    },
  );
  it.each(["local", "global"] as const)(
    "keeps one pending scan and its busy state when %s starts before the other entry",
    async (first) => {
      const pending = deferred<WorkspaceScan>();
      vi.mocked(api.scan).mockReturnValueOnce(pending.promise);
      await renderWorkspace();
      await refresh(first);
      await waitFor(() => expect(api.scan).toHaveBeenCalledOnce());
      expect(useWorkspaceStore.getState().busy).toBe(true);
      expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();

      await refresh(first === "local" ? "global" : "local");

      expect(api.scan).toHaveBeenCalledOnce();
      expect(api.manifest).toHaveBeenCalledOnce();
      expect(api.runtime).toHaveBeenCalledOnce();
      expect(useWorkspaceStore.getState().busy).toBe(true);
      expect(screen.getByText("Workspace content")).toBeVisible();
      await act(async () => pending.resolve(scanFor()));
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));

      await refresh(first === "local" ? "global" : "local");
      await waitFor(() => expect(api.scan).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      expect(useWorkspaceStore.getState().selectedWorkspace?.id).toBe(workspace.id);
    },
  );

  it.each(["local", "global"] as const)(
    "allows retrying through the other entry after a failed %s refresh",
    async (first) => {
      const pending = deferred<WorkspaceScan>();
      vi.mocked(api.scan).mockReturnValueOnce(pending.promise);
      await renderWorkspace();
      await refresh(first);
      await waitFor(() => expect(api.scan).toHaveBeenCalledOnce());
      await act(async () => pending.reject(new Error("scan unavailable")));
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      if (first === "local")
        expect(screen.getByRole("alert")).toHaveTextContent("scan unavailable");
      else expect(useWorkspaceStore.getState().message).toContain("scan unavailable");

      await refresh(first === "local" ? "global" : "local");

      await waitFor(() => expect(api.scan).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(useWorkspaceStore.getState().busy).toBe(false));
      expect(screen.getByText("Workspace content")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(useWorkspaceStore.getState().message).toBe("");
    },
  );

  it.each(["before", "after"] as const)(
    "starts a new workspace's first load despite old busy state and ignores an old result arriving %s it",
    async (oldResultOrder) => {
      const oldScan = deferred<WorkspaceScan>();
      const nextScan = deferred<WorkspaceScan>();
      vi.mocked(api.scan).mockImplementation((project) =>
        project === workspace.path ? oldScan.promise : nextScan.promise,
      );
      await renderWorkspace();
      await refresh("local");
      expect(useWorkspaceStore.getState().busy).toBe(true);

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

      await waitFor(() => expect(api.scan).toHaveBeenCalledWith(otherWorkspace.path));
      expect(api.scan).toHaveBeenCalledTimes(2);
      expect(useWorkspaceStore.getState().busy).toBe(true);
      expect(screen.queryByText("Workspace content")).toBeNull();
      if (oldResultOrder === "before") {
        await act(async () => oldScan.resolve(scanFor()));
        expect(useWorkspaceStore.getState().busy).toBe(true);
        expect(useWorkspaceStore.getState().scan).toBeUndefined();
        expect(useWorkspaceStore.getState().manifest).toBeUndefined();
      }
      await act(async () => nextScan.resolve(scanFor(otherWorkspace)));
      await screen.findByText("Workspace content");
      if (oldResultOrder === "after") await act(async () => oldScan.resolve(scanFor()));
      const state = useWorkspaceStore.getState();
      expect(state.busy).toBe(false);
      expect(state.selectedWorkspace?.id).toBe(otherWorkspace.id);
      expect(state.project).toBe(otherWorkspace.path);
      expect(state.scan?.root).toBe(otherWorkspace.path);
      expect(state.manifest).toEqual(manifestFor(otherWorkspace));
      expect(state.baselineManifest).toBe(JSON.stringify(manifestFor(otherWorkspace)));
    },
  );
});
