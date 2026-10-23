// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type {
  ChangeSet,
  ContextDoctorReport,
  ContextDoctorSummary,
  Manifest,
  MemoryRecord,
  SupportedLocale,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { PathDisplayProvider } from "@/lib/usePathDisplay";
import { Route } from "./route";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  confirm: vi.fn(),
  refetch: vi.fn(),
  displayContext: vi.fn(),
  copy: vi.fn(),
  workspaces: [] as WorkspaceSummary[],
  memories: [] as MemoryRecord[],
  report: undefined as ContextDoctorReport | undefined,
  reportError: false,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useLocation: () => ({ pathname: "/workspace/workspace/assets" }),
  Outlet: () => <p>Workspace editor fixture</p>,
}));
vi.mock("@/features/home/home-query", () => ({
  useHomeDoctorReport: () => ({
    data: doubles.report,
    isError: doubles.reportError,
    refetch: doubles.refetch,
  }),
  useHomeMemories: () => ({ data: doubles.memories }),
  useHomeWorkspaces: () => ({ data: doubles.workspaces, isPending: false }),
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ confirm: doubles.confirm }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({ WorkspaceOpenWith: () => null }));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ paths: { displayContext: doubles.displayContext } }),
}));
vi.mock("@/core/api", () => ({
  api: { plan: vi.fn(), scan: vi.fn(), manifest: vi.fn(), runtime: vi.fn() },
}));

const homeDirectory = "/synthetic-home";
const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Example workspace",
  path: `${homeDirectory}/projects/large-example-system/packages/workspace-management/fixtures/sample-project`,
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const baseline: Manifest = {
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared: "Saved instructions", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
const draft: Manifest = {
  ...baseline,
  instructions: { ...baseline.instructions, shared: "Draft instructions" },
};
const scan: WorkspaceScan = {
  root: workspace.path,
  manifest_exists: true,
  agents: [],
  assets: [],
  warnings: [],
};
const summary: ContextDoctorSummary = {
  workspace_id: workspace.id,
  error_count: 1,
  warning_count: 2,
  info_count: 8,
  repairable_count: 1,
  checked_at: "2026-10-23T08:00:00Z",
};
const report = (value: ContextDoctorSummary): ContextDoctorReport => ({
  summary: value,
  matrix: [],
  issues: [],
});
const memory = (project_id: string, status: MemoryRecord["status"] = "pending"): MemoryRecord => ({
  id: `${project_id}:${status}`,
  project_id,
  status,
  memory_type: "project_fact",
  content: "Synthetic memory",
  created_at: "2026-10-23T08:00:00Z",
});
const changeSet: ChangeSet = {
  id: "synthetic-plan",
  project_root: workspace.path,
  created_at: "2026-10-23T08:00:00Z",
  requires_home_approval: false,
  changes: [],
};
const copies: Record<
  SupportedLocale,
  { healthy: string; attention: (count: number) => string; undiagnosed: string }
> = {
  "zh-CN": { healthy: "正常", attention: (count) => `需关注 ${count} 项`, undiagnosed: "未诊断" },
  "zh-TW": { healthy: "正常", attention: (count) => `需關注 ${count} 項`, undiagnosed: "未診斷" },
  "en-US": {
    healthy: "Healthy",
    attention: (count) => `Needs attention: ${count}`,
    undiagnosed: "Not diagnosed",
  },
  "ja-JP": { healthy: "正常", attention: (count) => `要確認 ${count} 件`, undiagnosed: "未診断" },
};
const locales = Object.keys(copies) as SupportedLocale[];

async function renderRoute() {
  const Component = Route.options.component!;
  await Component.preload?.();
  const content = () => (
    <PathDisplayProvider>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </PathDisplayProvider>
  );
  const view = render(content());
  await screen.findByText("Workspace editor fixture");
  const header = screen.getByRole("heading", { name: workspace.name }).closest("section")!;
  return { header, rerender: () => view.rerender(content()) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("v15 workspace header", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.workspaces = [{ ...workspace }];
    doubles.memories = [];
    doubles.report = report({ ...summary, error_count: 0, warning_count: 0 });
    doubles.reportError = false;
    doubles.displayContext.mockResolvedValue({ homeDirectory });
    doubles.refetch.mockResolvedValue(undefined);
    doubles.copy.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: doubles.copy },
    });
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      scan,
      manifest: baseline,
      baselineManifest: JSON.stringify(baseline),
    });
    vi.mocked(api.plan).mockResolvedValue(changeSet);
    vi.mocked(api.scan).mockResolvedValue(scan);
    vi.mocked(api.manifest).mockResolvedValue(baseline);
  });
  afterEach(cleanup);

  it.each(locales)(
    "counts diagnosis issues and matching pending memories in %s",
    async (locale) => {
      await changeLocale(locale);
      doubles.report = report(summary);
      doubles.memories = [
        memory(workspace.id),
        memory("other-workspace"),
        memory(workspace.id, "approved"),
      ];
      const { header } = await renderRoute();
      expect(within(header).getByText(copies[locale].attention(4))).toHaveClass("text-warning");
      expect(within(header).queryByText(copies[locale].healthy)).toBeNull();
    },
  );

  it.each(locales)(
    "ignores a legacy attention status when diagnosis is healthy in %s",
    async (locale) => {
      await changeLocale(locale);
      doubles.workspaces = [{ ...workspace, status: "attention", warning_count: 9 }];
      const { header } = await renderRoute();
      expect(within(header).getByText(copies[locale].healthy)).toBeVisible();
      expect(within(header).queryByText(copies[locale].attention(9))).toBeNull();
    },
  );

  it.each(locales)(
    "keeps missing or failed diagnosis neutral but shows known pending work in %s",
    async (locale) => {
      await changeLocale(locale);
      doubles.report = undefined;
      const { header, rerender } = await renderRoute();
      const neutral = within(header).getByText(copies[locale].undiagnosed);
      expect(neutral).toHaveClass("bg-muted", "text-muted-foreground");
      expect(neutral).not.toHaveClass("text-warning");
      doubles.memories = [memory(workspace.id)];
      rerender();
      expect(within(header).getByText(copies[locale].attention(1))).toHaveClass("text-warning");
      doubles.memories = [];
      doubles.report = report({ ...summary, error_count: 0, warning_count: 0 });
      doubles.reportError = true;
      rerender();
      expect(within(header).getByText(copies[locale].undiagnosed)).toBeVisible();
      doubles.memories = [memory(workspace.id)];
      rerender();
      expect(within(header).getByText(copies[locale].attention(1))).toHaveClass("text-warning");
    },
  );

  it.each(locales)(
    "does not retain a healthy badge after a diagnosis refresh fails in %s",
    async (locale) => {
      await changeLocale(locale);
      const { header, rerender } = await renderRoute();
      expect(within(header).getByText(copies[locale].healthy)).toBeVisible();
      doubles.reportError = true;
      rerender();
      expect(within(header).queryByText(copies[locale].healthy)).toBeNull();
      expect(within(header).getByText(copies[locale].undiagnosed)).toHaveClass(
        "text-muted-foreground",
      );
    },
  );

  it.each(locales)(
    "shows review only for an unsaved draft and plans its current snapshot in %s",
    async (locale) => {
      await changeLocale(locale);
      const { header } = await renderRoute();
      expect(
        within(header).queryByRole("button", { name: tr("workspace.reviewChanges") }),
      ).toBeNull();
      expect(screen.queryByText(tr("workspace.noDraftChanges"))).toBeNull();
      act(() => useWorkspaceStore.getState().setManifest(draft));
      const review = within(header).getByRole("button", { name: tr("workspace.reviewChanges") });
      const pending = deferred<ChangeSet>();
      vi.mocked(api.plan).mockReturnValueOnce(pending.promise);
      fireEvent.click(review);
      fireEvent.click(review);
      expect(api.plan).toHaveBeenCalledOnce();
      expect(api.plan).toHaveBeenCalledWith(workspace.path, draft, false);
      expect(review).toBeDisabled();
      await act(async () => pending.resolve(changeSet));
      await waitFor(() =>
        expect(doubles.navigate).toHaveBeenCalledWith({
          to: "/workspace/$workspaceId/changes",
          params: { workspaceId: workspace.id },
        }),
      );
      expect(useWorkspaceStore.getState()).toMatchObject({
        changeSet,
        changeSetManifest: JSON.stringify(draft),
        changeSetOrigin: "standard",
        busy: false,
      });
      expect(screen.queryByText(tr("workspace.noDraftChanges"))).toBeNull();
    },
  );

  it.each(locales)("does not accept a plan after its draft changes in %s", async (locale) => {
    await changeLocale(locale);
    useWorkspaceStore.getState().setManifest(draft);
    const pending = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValueOnce(pending.promise);
    const { header } = await renderRoute();
    fireEvent.click(within(header).getByRole("button", { name: tr("workspace.reviewChanges") }));
    const newer = { ...draft, instructions: { ...draft.instructions, shared: "Newer draft" } };
    act(() => useWorkspaceStore.getState().setManifest(newer));
    await act(async () => pending.resolve(changeSet));
    expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
    expect(useWorkspaceStore.getState().manifest).toEqual(newer);
    expect(doubles.navigate).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(tr("workspace.planSuperseded"));
  });

  it.each(locales)(
    "shortens only the displayed path and copies its full original value in %s",
    async (locale) => {
      await changeLocale(locale);
      const { header } = await renderRoute();
      const path = within(header).getByTitle(workspace.path);
      await waitFor(() => expect(path.textContent).toMatch(/^~\/.*….*sample-project$/));
      expect(path.textContent!.length).toBeLessThanOrEqual(68);
      expect(path).toHaveAttribute("title", workspace.path);
      expect(within(header).getAllByTitle(workspace.path)).toHaveLength(1);
      fireEvent.click(within(header).getByRole("button", { name: tr("workspace.copyPath") }));
      expect(doubles.copy).toHaveBeenCalledWith(workspace.path);
      expect(doubles.displayContext).toHaveBeenCalledOnce();
    },
  );
});
