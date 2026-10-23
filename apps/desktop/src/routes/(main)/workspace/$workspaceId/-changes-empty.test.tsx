// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { ChangeSet, FileChange, Manifest, SessionHandoffLaunchRequest } from "@/core/types";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import { Changes, Route } from "./changes";

const doubles = vi.hoisted(() => ({ navigate: vi.fn(), search: {} as Record<string, unknown> }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => doubles.search,
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
const change = (name: string, after = `new ${name}`): FileChange => ({
  target: `/workspace/${name}`,
  scope: "project",
  before: `old ${name}`,
  after,
  risk: "low",
  validator: "markdown",
});
const empty: ChangeSet = {
  id: "empty-plan",
  project_root: "/workspace",
  created_at: "2026-10-16T00:00:00Z",
  changes: [],
  requires_home_approval: false,
};
const draft: Manifest = {
  schema_version: 2,
  workspace: { id: "workspace", name: "Workspace" },
  instructions: { shared: "Preserve this draft", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
  adapters: {},
};
const nativeImport: SessionHandoffLaunchRequest = {
  mode: "native-import",
  operation_id: "import-operation",
  plan_hash: "plan-hash",
  target_agent: "opencode",
  workspace_id: "workspace",
};
function props() {
  return {
    origin: "standard" as const,
    onPlanHome: vi.fn(),
    onApplied: vi.fn(),
    onLaunchCompleted: vi.fn(),
    onRejected: vi.fn(),
    onApplyingChange: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function mountRoute(plan = empty, origin: ChangeSetOrigin = "standard") {
  const state = useWorkspaceStore.getState();
  state.setChangeSet(plan, draft);
  state.setChangeSetOrigin(origin);
  if (origin === "handoff") state.setHandoffLaunchRequest(nativeImport);
  const Component = Route.options.component!;
  // Wait for route splitting before checking the rendered UI's readiness.
  await Component.preload?.();
  await act(async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Suspense fallback={null}>
          <Component />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await screen.findByRole("heading", { name: "Change plan" });
}
function noWrites() {
  expect(api.apply).not.toHaveBeenCalled();
  expect(api.continueSessionHandoff).not.toHaveBeenCalled();
  expect(api.launchSessionHandoff).not.toHaveBeenCalled();
}
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({
    project: "/workspace",
    selectedWorkspace: {
      id: "workspace",
      name: "Workspace",
      path: "/workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    },
    manifest: draft,
    baselineManifest: "saved baseline",
    workspaceDrafts: { workspace: draft },
  });
  doubles.search = {
    handoffSession: "source",
    handoffTarget: "opencode",
    handoffBudget: 64000,
    handoffFormat: "markdown",
    handoffPreCompaction: true,
  };
  vi.mocked(api.apply).mockResolvedValue({ applied: [], backup_dir: "/backup" });
  vi.mocked(api.plan).mockResolvedValue(empty);
});
afterEach(cleanup);

describe("empty change-plan review", () => {
  it.each([
    ["zh-CN", "本计划没有文件变更", "没有需要应用的文件变更，可返回继续操作。", "返回"],
    ["zh-TW", "此計畫沒有檔案變更", "沒有需要套用的檔案變更，可返回繼續操作。", "返回"],
    [
      "en-US",
      "No file changes in this plan",
      "There are no file changes to apply. You can go back to continue.",
      "Back",
    ],
    [
      "ja-JP",
      "このプランにファイルの変更はありません",
      "適用するファイルの変更はありません。戻って操作を続けられます。",
      "戻る",
    ],
  ] as const)(
    "explains the actual empty plan and offers a safe keyboard return in %s",
    async (locale, title, description, back) => {
      await initializeI18n(locale);
      const callbacks = props();
      render(<Changes {...callbacks} changeSet={{ ...empty, requires_home_approval: true }} />);
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(screen.getByText(description)).toBeVisible();
      expect(screen.queryByRole("button", { name: tr("changes.reject") })).toBeNull();
      expect(screen.queryByRole("button", { name: tr("changes.apply", { count: 0 }) })).toBeNull();
      expect(screen.queryByText(tr("changes.hashValidation"))).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByText(tr("changes.synced"))).toBeNull();
      const button = screen.getByRole("button", { name: back });
      expect(button).toBeEnabled();
      button.focus();
      await userEvent.setup().keyboard("{Enter}");
      expect(callbacks.onRejected).toHaveBeenCalledOnce();
      expect(callbacks.onApplied).not.toHaveBeenCalled();
      expect(callbacks.onApplyingChange).not.toHaveBeenCalled();
      noWrites();
    },
  );

  it.each(["standard", "doctor", "handoff", "handoff-setup"] as const)(
    "returns an empty %s plan to its original flow without recording an apply",
    async (origin) => {
      await mountRoute(empty, origin);
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(doubles.navigate).toHaveBeenCalledOnce();
      const navigation = doubles.navigate.mock.lastCall![0];
      expect(navigation).toMatchObject({
        to:
          origin === "standard"
            ? "/workspace/$workspaceId"
            : origin === "doctor"
              ? "/workspace/$workspaceId/doctor"
              : "/workspace/$workspaceId/sessions",
        params: { workspaceId: "workspace" },
        replace: true,
      });
      if (origin === "handoff-setup")
        expect(navigation.search({ unrelated: "preserved" })).toMatchObject({
          ...doubles.search,
          unrelated: "preserved",
          handoffResume: "return",
        });
      else expect(navigation.search).toBeUndefined();
      expect(useWorkspaceStore.getState()).toMatchObject({
        manifest: draft,
        workspaceDrafts: { workspace: draft },
        applyingChanges: false,
      });
      expect(useWorkspaceStore.getState().changeSet).toBeUndefined();
      expect(useWorkspaceStore.getState().handoffLaunchRequest).toBeUndefined();
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(api.updateOnboarding).not.toHaveBeenCalled();
      expect(api.scan).not.toHaveBeenCalled();
      noWrites();
    },
  );

  it("can still generate a Home plan from an empty standard plan and blocks return or duplicate planning while pending", async () => {
    const request = deferred<ChangeSet>();
    vi.mocked(api.plan).mockReturnValue(request.promise);
    await mountRoute();
    const home = screen.getByRole("button", { name: "Include global configuration" });
    const back = screen.getByRole("button", { name: "Back" });
    fireEvent.click(home);
    fireEvent.click(home);
    fireEvent.click(back);
    expect(api.plan).toHaveBeenCalledExactlyOnceWith("/workspace", draft, true);
    expect(home).toBeDisabled();
    expect(back).toBeDisabled();
    expect(doubles.navigate).not.toHaveBeenCalled();
    noWrites();
    const planned = {
      ...empty,
      id: "home-plan",
      requires_home_approval: true,
      changes: [change("home.md")],
    };
    await act(async () => request.resolve(planned));
    expect(await screen.findByText("new home.md")).toBeVisible();
    expect(screen.queryByText(tr("changes.noFileChanges"))).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
    expect(useWorkspaceStore.getState().changeSet).toEqual(planned);
    noWrites();
  });

  it("keeps an empty Home-planning error visible and allows retry or return", async () => {
    vi.mocked(api.plan).mockRejectedValueOnce(new Error("Home planning failed"));
    await mountRoute();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Home planning failed");
    expect(screen.getByRole("heading", { name: "No file changes in this plan" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    await waitFor(() => expect(api.plan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    noWrites();
  });

  it("restarts file review and Home approval when a new Home plan replaces a selected later file", async () => {
    const old = {
      ...empty,
      id: "old-plan",
      requires_home_approval: true,
      changes: [change("one.md"), change("two.md")],
    };
    const planned = { ...old, id: "new-plan", changes: [change("new.md")] };
    vi.mocked(api.plan).mockResolvedValue(planned);
    await mountRoute(old);
    fireEvent.click(screen.getByRole("button", { name: /^two.md/ }));
    expect(screen.getByText("new two.md")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: tr("changes.homeApproval") }));
    expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    expect(await screen.findByText("new new.md")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: tr("changes.homeApproval") })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeDisabled();
    expect(screen.queryByText(tr("changes.synced"))).toBeNull();
    expect(screen.queryByText(tr("changes.noFileChanges"))).toBeNull();
    noWrites();
  });

  it("falls back to the first real file when the previous preview index is out of range even with the same plan id", () => {
    const callbacks = props();
    const old = { ...empty, id: "same-plan", changes: [change("one.md"), change("two.md")] };
    const view = render(<Changes {...callbacks} changeSet={old} />);
    fireEvent.click(screen.getByRole("button", { name: /^two.md/ }));
    expect(screen.getByText("new two.md")).toBeVisible();
    view.rerender(<Changes {...callbacks} changeSet={{ ...old, changes: [change("one.md")] }} />);
    expect(screen.getByText("new one.md")).toBeVisible();
    expect(screen.getByRole("button", { name: /^one.md/ })).toHaveClass("bg-muted");
    expect(screen.getByRole("button", { name: "Apply 1 change" })).toBeEnabled();
    expect(screen.queryByText(tr("changes.synced"))).toBeNull();
    expect(screen.queryByText(tr("changes.noFileChanges"))).toBeNull();
    noWrites();
  });

  it("treats file buttons as Diff navigation rather than deselecting the plan", async () => {
    const callbacks = props();
    const plan = { ...empty, changes: [change("one.md"), change("two.md")] };
    render(<Changes {...callbacks} changeSet={plan} />);
    const file = screen.getByRole("button", { name: /^two.md/ });
    fireEvent.click(file);
    fireEvent.click(file);
    expect(screen.getByText("new two.md")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply 2 changes" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Apply 2 changes" }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledExactlyOnceWith(plan, false, undefined));
    expect(callbacks.onApplied).toHaveBeenCalledOnce();
  });

  it("blocks an empty plan's stale return callback immediately when workspace loading starts", () => {
    const callbacks = props();
    render(<Changes {...callbacks} changeSet={empty} />);
    const back = screen.getByRole("button", { name: "Back" });
    act(() => {
      useWorkspaceStore.getState().setBusy(true);
      fireEvent.click(back);
    });
    expect(back).toBeDisabled();
    expect(callbacks.onRejected).not.toHaveBeenCalled();
    noWrites();
  });

  it("retains native-import recovery when no change plan remains", async () => {
    vi.mocked(api.launchSessionHandoff).mockResolvedValue({
      target_agent: "opencode",
      terminal: "Terminal",
    });
    const callbacks = props();
    render(<Changes {...callbacks} origin="handoff" launchRequest={nativeImport} />);
    expect(screen.queryByText(tr("changes.noFileChanges"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check import and continue" }));
    await waitFor(() =>
      expect(api.launchSessionHandoff).toHaveBeenCalledExactlyOnceWith(nativeImport),
    );
    expect(callbacks.onLaunchCompleted).toHaveBeenCalledOnce();
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.continueSessionHandoff).not.toHaveBeenCalled();
    expect(callbacks.onRejected).not.toHaveBeenCalled();
  });
});
