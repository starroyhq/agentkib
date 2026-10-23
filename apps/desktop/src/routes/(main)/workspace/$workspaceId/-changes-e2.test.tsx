// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n } from "@/core/i18n";
import type {
  ChangeSet,
  ContextDoctorReport,
  DoctorIssue,
  Manifest,
  RuntimeInfo,
} from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { Route } from "./changes";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({}),
}));
vi.mock("@/features/home/home-query", () => ({
  homeKeys: {
    all: ["home"],
    doctorReport: (workspaceId: string) => ["home", "doctor", workspaceId],
  },
}));
vi.mock("@/core/api", () => ({
  api: {
    plan: vi.fn(),
    apply: vi.fn(),
    scan: vi.fn(),
    manifest: vi.fn(),
    runtime: vi.fn(),
    workspaceDoctorReport: vi.fn(),
    updateOnboarding: vi.fn(),
    continueSessionHandoff: vi.fn(),
    launchSessionHandoff: vi.fn(),
  },
}));

function manifest(shared: string): Manifest {
  return {
    schema_version: 2,
    workspace: { id: "workspace", name: "Workspace" },
    instructions: { shared, scoped: [], platform_overrides: {} },
    skills: [],
    mcp: { config: "mcp.json" },
    connections: [],
    memories: { require_approval: true },
    adapters: {},
  };
}
const baseline = manifest("Saved instructions");
const draft = manifest("Edited instructions");
const diskChanged = manifest("Externally changed instructions");
const changeSet: ChangeSet = {
  id: "reviewed-plan",
  project_root: "/workspace",
  created_at: "2026-10-23T00:00:00Z",
  requires_home_approval: false,
  changes: [
    {
      target: "/workspace/.agentkib/manifest.yaml",
      scope: "project",
      before: "old manifest",
      after: "new manifest",
      risk: "low",
      validator: "yaml",
    },
    {
      target: "/workspace/AGENTS.md",
      scope: "project",
      before: "Saved instructions",
      after: "Edited instructions",
      risk: "medium",
      validator: "markdown",
    },
  ],
};
function report(issues: DoctorIssue[] = []): ContextDoctorReport {
  return {
    summary: {
      workspace_id: "workspace",
      checked_at: "2026-10-23T00:00:00Z",
      error_count: issues.filter((issue) => issue.severity === "error").length,
      warning_count: issues.filter((issue) => issue.severity === "warning").length,
      info_count: issues.filter((issue) => issue.severity === "info").length,
      repairable_count: issues.filter((issue) => issue.repairable).length,
    },
    matrix: [],
    issues,
  };
}
const oldIssue: DoctorIssue = {
  id: "old-duplicate",
  code: "instruction.exact-duplicate",
  severity: "warning",
  repairable: false,
  agent: "grok-build",
  evidence: [{ path: "/workspace/CLAUDE.md", detail: "Exact duplicate of /workspace/AGENTS.md" }],
};
const existingIssue: DoctorIssue = {
  id: "existing",
  code: "instruction.missing",
  severity: "warning",
  repairable: false,
  agent: "codex",
  evidence: [
    { path: "/workspace/AGENTS.override.md", detail: "Expected instructions are missing" },
  ],
};
const newIssue: DoctorIssue = {
  id: "new-literal-import",
  code: "context.warning",
  severity: "warning",
  repairable: false,
  agent: "deepseek-harness",
  evidence: [
    {
      path: "/workspace/CLAUDE.md",
      detail:
        "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
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
async function view(button = "Apply 2 changes") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = Route.options.component!;
  await Component.preload?.();
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <Component />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await screen.findByRole("button", { name: button });
  return { ...rendered, client };
}

beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  await changeLocale("en-US");
  vi.resetAllMocks();
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
  });
  useWorkspaceStore.getState().setChangeSet(changeSet, draft);
  vi.mocked(api.apply).mockResolvedValue({
    applied: changeSet.changes.map((file) => file.target),
    backup_dir: "/sandbox/backups/apply",
  });
  vi.mocked(api.scan).mockResolvedValue({
    root: "/workspace",
    manifest_exists: true,
    agents: [],
    assets: [],
    warnings: [],
  });
  vi.mocked(api.manifest).mockResolvedValue(draft);
  vi.mocked(api.runtime).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
  vi.mocked(api.updateOnboarding).mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
  vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report());
});
afterEach(cleanup);

describe("E2 reviewed plan safety", () => {
  it.each(["new-plan", changeSet.id])(
    "rejects a stale click before React renders the replacement plan %s",
    async (id) => {
      await view();
      const apply = screen.getByRole("button", { name: "Apply 2 changes" });
      const replacement = { ...changeSet, id, changes: [...changeSet.changes] };
      act(() => {
        useWorkspaceStore.getState().setChangeSet(replacement, draft);
        fireEvent.click(apply);
      });
      expect(api.apply).not.toHaveBeenCalled();
      expect(api.workspaceDoctorReport).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().changeSet).toBe(replacement);
    },
  );

  it.each(["edit", "replace-plan", "leave-workspace", "unmount"] as const)(
    "does not dispatch after %s while the before-apply diagnosis is pending",
    async (change) => {
      const before = deferred<ContextDoctorReport>();
      vi.mocked(api.workspaceDoctorReport).mockReturnValue(before.promise);
      const rendered = await view();
      fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
      await waitFor(() => expect(api.workspaceDoctorReport).toHaveBeenCalledTimes(1));
      expect(api.apply).not.toHaveBeenCalled();
      act(() => {
        if (change === "edit") useWorkspaceStore.getState().setManifest(manifest("Newer draft"));
        else if (change === "replace-plan")
          useWorkspaceStore.getState().setChangeSet({ ...changeSet, id: "new-plan" }, draft);
        else if (change === "leave-workspace")
          useWorkspaceStore.setState({
            project: "/other",
            selectedWorkspace: {
              ...useWorkspaceStore.getState().selectedWorkspace!,
              id: "other",
              path: "/other",
            },
          });
        else rendered.unmount();
      });
      await act(async () => before.resolve(report()));
      expect(api.apply).not.toHaveBeenCalled();
    },
  );

  it("keeps Doctor's reviewed disk source when global configuration is included", async () => {
    useWorkspaceStore.getState().setChangeSetOrigin("doctor");
    useWorkspaceStore.getState().setChangeSet(changeSet, baseline);
    vi.mocked(api.manifest).mockResolvedValue(baseline);
    vi.mocked(api.plan).mockResolvedValue({ ...changeSet, id: "doctor-home" });
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    await waitFor(() => expect(useWorkspaceStore.getState().changeSet?.id).toBe("doctor-home"));
    expect(api.plan).toHaveBeenCalledWith("/workspace", baseline, true);
    expect(useWorkspaceStore.getState().manifest).toEqual(draft);
    expect(useWorkspaceStore.getState().changeSetManifest).toBe(JSON.stringify(baseline));
    expect(useWorkspaceStore.getState().changeSetOrigin).toBe("doctor");
  });

  it("keeps the conflict state while its disk version is being read", async () => {
    const disk = deferred<Manifest>();
    vi.mocked(api.apply).mockRejectedValueOnce(
      new Error("File was modified externally: /workspace/.agentkib/manifest.yaml"),
    );
    vi.mocked(api.manifest).mockReturnValue(disk.promise);
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(useWorkspaceStore.getState().changeSetConflict).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Use disk version" }));
    expect(screen.getByRole("button", { name: "Use disk version" })).toBeDisabled();
    expect(screen.queryByText("Generating change plan…")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("manifest on disk");
    await act(async () => disk.resolve(diskChanged));
    expect(useWorkspaceStore.getState().changeSetInvalidated).toBe(true);
    expect(api.plan).not.toHaveBeenCalled();
  });

  it.each(["disk", "draft"] as const)(
    "requires regeneration and review after choosing the %s version of a manifest conflict",
    async (choice) => {
      vi.mocked(api.apply).mockRejectedValueOnce(
        new Error("File was modified externally: /workspace/.agentkib/manifest.yaml"),
      );
      vi.mocked(api.manifest).mockResolvedValue(diskChanged);
      vi.mocked(api.plan).mockResolvedValue({ ...changeSet, id: "regenerated-plan" });
      await view();
      fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
      await waitFor(() => expect(useWorkspaceStore.getState().changeSetConflict).toBe(true));
      expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeDisabled();
      const includeHome = screen.getByRole("button", { name: "Include global configuration" });
      expect(includeHome).toBeDisabled();
      fireEvent.click(includeHome);
      expect(api.plan).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("button", {
          name: choice === "disk" ? "Use disk version" : "Keep my draft",
        }),
      );
      await waitFor(() => expect(useWorkspaceStore.getState().changeSetInvalidated).toBe(true));
      expect(useWorkspaceStore.getState().changeSetConflict).toBe(false);
      expect(useWorkspaceStore.getState().changeSet?.id).toBe("reviewed-plan");
      expect(useWorkspaceStore.getState().manifest).toEqual(
        choice === "disk" ? diskChanged : draft,
      );
      expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(diskChanged));
      expect(api.plan).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
      expect(api.apply).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
      await waitFor(() =>
        expect(useWorkspaceStore.getState().changeSet?.id).toBe("regenerated-plan"),
      );
      expect(api.plan).toHaveBeenCalledWith(
        "/workspace",
        choice === "disk" ? diskChanged : draft,
        false,
      );
      expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
      expect(api.apply).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps non-manifest hash failures as errors without offering disk/draft reconciliation", async () => {
    vi.mocked(api.apply).mockRejectedValueOnce(
      new Error("File was modified externally: /workspace/AGENTS.md"),
    );
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File was modified externally: /workspace/AGENTS.md",
    );
    expect(useWorkspaceStore.getState().changeSetConflict).toBe(false);
    expect(useWorkspaceStore.getState().changeSet?.id).toBe(changeSet.id);
    expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
  });

  it("compares real before/after diagnosis and shows only new findings in the applied result", async () => {
    vi.mocked(api.workspaceDoctorReport)
      .mockResolvedValueOnce(report([oldIssue, existingIssue]))
      .mockResolvedValueOnce(report([existingIssue, newIssue]));
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().appliedChanges?.diagnosis?.status).toBe("complete"),
    );
    const result = useWorkspaceStore.getState().appliedChanges!;
    expect(result.diagnosis).toEqual({ status: "complete", resolved: 1, issues: [newIssue] });
    expect(result.backupDir).toBe("/sandbox/backups/apply");
    expect(result.plannedManifest).toBe(JSON.stringify(draft));
    expect(result.baselineManifest).toBe(JSON.stringify(baseline));
    const summary = screen.getByText(/^You changed:/).textContent;
    expect(summary).toContain("Edited instructions");
    expect(summary).not.toContain("when applied");
    expect(screen.queryByRole("button", { name: "Apply 2 changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    act(() => useWorkspaceStore.getState().setManifest(manifest("Later unrelated draft")));
    expect(screen.getByText(/^You changed:/).textContent).toBe(summary);
    expect(screen.getByText("Original files backed up, recheck: 1 resolved")).toBeVisible();
    expect(screen.getByText("1 new issue found")).toBeVisible();
    expect(
      screen.getByText("DeepSeek Harness does not expand the reference in CLAUDE.md"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to diagnosis" })).toBeEnabled();
    expect(api.apply).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful apply when post-apply diagnosis fails", async () => {
    vi.mocked(api.workspaceDoctorReport)
      .mockResolvedValueOnce(report([oldIssue]))
      .mockRejectedValueOnce(new Error("Recheck unavailable"));
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().appliedChanges?.diagnosis?.status).toBe("failed"),
    );
    expect(useWorkspaceStore.getState().appliedChanges?.applied).toEqual(
      changeSet.changes.map((change) => change.target),
    );
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
    expect(
      screen.getByText("Files applied, but the recheck failed — retry on the diagnosis page"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply 2 changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(api.apply).toHaveBeenCalledTimes(1);
  });

  it("does not claim a resolved count when the initial diagnosis failed", async () => {
    vi.mocked(api.workspaceDoctorReport)
      .mockRejectedValueOnce(new Error("Initial report unavailable"))
      .mockResolvedValueOnce(report([newIssue]));
    await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().appliedChanges?.diagnosis?.status).toBe("complete"),
    );
    expect(useWorkspaceStore.getState().appliedChanges?.diagnosis?.resolved).toBeUndefined();
    expect(screen.getByText("Original files backed up, recheck complete")).toBeVisible();
    expect(screen.getByText("1 issues currently need attention")).toBeVisible();
  });

  it("does not overwrite a newer result with a late post-apply diagnosis", async () => {
    const after = deferred<ContextDoctorReport>();
    vi.mocked(api.workspaceDoctorReport)
      .mockResolvedValueOnce(report([oldIssue]))
      .mockReturnValueOnce(after.promise);
    const rendered = await view();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(api.workspaceDoctorReport).toHaveBeenCalledTimes(2));
    const newerResult = {
      ...useWorkspaceStore.getState().appliedChanges!,
      changeSet: { ...changeSet, id: "newer-apply" },
      diagnosis: { status: "complete" as const, resolved: 8, issues: [] },
    };
    act(() => useWorkspaceStore.getState().setAppliedChanges(newerResult));
    await act(async () => after.resolve(report([newIssue])));
    expect(useWorkspaceStore.getState().appliedChanges).toBe(newerResult);
    expect(rendered.client.getQueryData(["home", "doctor", "workspace"])).toBeUndefined();
  });

  it.each(["handoff", "handoff-setup"] as const)(
    "does not add diagnosis waits to the existing %s apply path",
    async (origin) => {
      useWorkspaceStore.getState().setChangeSetOrigin(origin);
      await view("Apply 2 Changes");
      fireEvent.click(screen.getByRole("button", { name: "Apply 2 Changes" }));
      await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(useWorkspaceStore.getState().applyingChanges).toBe(false));
      expect(api.workspaceDoctorReport).not.toHaveBeenCalled();
      expect(useWorkspaceStore.getState().appliedChanges?.diagnosis).toBeUndefined();
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/workspace/$workspaceId/sessions" }),
      );
    },
  );
});
