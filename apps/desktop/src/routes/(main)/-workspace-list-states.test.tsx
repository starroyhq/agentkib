// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { homeKeys } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { ContextDoctorSummary, MemoryRecord, WorkspaceSummary } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { Route } from "./workspaces";

const doubles = vi.hoisted(() => ({
  workspaces: vi.fn(),
  doctor: vi.fn(),
  memories: vi.fn(),
  refresh: vi.fn(),
  reveal: vi.fn(),
  exclude: vi.fn(),
  view: "list",
  pick: vi.fn(),
  add: vi.fn(),
  navigate: vi.fn(),
  notify: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/core/api", () => ({
  api: {
    workspaces: doubles.workspaces,
    workspaceDoctorSummaries: doubles.doctor,
    globalMemories: doubles.memories,
    refreshWorkspace: doubles.refresh,
    openWorkspaceStoragePath: doubles.reveal,
    excludeWorkspace: doubles.exclude,
    discoveryReport: async () => null,
    refreshStatus: async () => [],
    pickDirectory: doubles.pick,
    addWorkspace: doubles.add,
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: doubles.confirm }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => ({ workspaceView: doubles.view }),
  useNavigate: () => doubles.navigate,
}));
const workspace: WorkspaceSummary = {
  id: "one",
  name: "Alpha workspace",
  path: "/alpha",
  status: "healthy",
  asset_count: 9,
  warning_count: 0,
  sources: [],
};
const summary: ContextDoctorSummary = {
  workspace_id: "one",
  error_count: 0,
  warning_count: 0,
  info_count: 0,
  repairable_count: 0,
  checked_at: "2026-10-23T01:00:00Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function start(cached = false) {
  const client = new QueryClient();
  if (cached) {
    client.setQueryData(homeKeys.workspaces(), [workspace]);
    client.setQueryData(homeKeys.doctorSummaries([workspace.id]), { [workspace.id]: summary });
    client.setQueryData(homeKeys.memories(), []);
    doubles.workspaces.mockResolvedValue([workspace]);
    doubles.doctor.mockResolvedValue([summary]);
  }
  const Component = Route.options.component!;
  const view = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={null}>
        <Component />
      </Suspense>
    </QueryClientProvider>,
  );
  return { client, ...view };
}
function workspaceButtonName() {
  return `${workspace.name}, ${tr("workspace.source.manual")}, ${tr("workspace.status.healthy")}`;
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.resetAllMocks();
  doubles.workspaces.mockResolvedValue([]);
  doubles.doctor.mockResolvedValue([summary]);
  doubles.memories.mockResolvedValue([]);
  doubles.view = "list";
  useAppStore.setState({ favoriteWorkspaceIds: [] });
  doubles.pick.mockResolvedValue(null);
  doubles.confirm.mockResolvedValue(true);
  useWorkspaceStore.getState().resetWorkspace();
  useWorkspaceStore.getState().setApplyingChanges(false);
  await initializeI18n("en-US");
});
afterEach(() => {
  cleanup();
  document.documentElement.dataset.platform = "linux";
});

it("shows initial loading without claiming no workspaces or no filter matches", async () => {
  const pending = deferred<WorkspaceSummary[]>();
  doubles.workspaces.mockReturnValue(pending.promise);
  start();
  expect(await screen.findByRole("status")).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
  await act(async () => pending.resolve([]));
  expect(await screen.findByText(tr("workspace.emptyTitle"))).toBeVisible();
});

it("uses the existing failure state and retries an initially unavailable workspace list", async () => {
  doubles.workspaces.mockRejectedValueOnce(new Error("unavailable"));
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("nav.workspaces"));
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  expect(await screen.findByRole("button", { name: workspaceButtonName() })).toBeVisible();
  expect(doubles.workspaces).toHaveBeenCalledTimes(2);
  expect(doubles.memories).toHaveBeenCalledTimes(1);
});

it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
  "explains a truly empty list in %s and keeps one executable add entry",
  async (locale) => {
    await initializeI18n(locale);
    start();
    expect(await screen.findByRole("heading", { name: tr("workspace.emptyTitle") })).toBeVisible();
    expect(
      screen.getByText(tr("workspace.emptyText", { action: tr("workspace.addWorkspace") })),
    ).toBeVisible();
    expect(screen.queryByText(tr("workspace.noMatch"))).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: tr("workspace.addWorkspace") });
    expect(buttons).toHaveLength(1);
    doubles.pick.mockResolvedValue("/chosen/project");
    doubles.add.mockResolvedValue({ ...workspace, path: "/chosen/project" });
    doubles.workspaces.mockResolvedValue([{ ...workspace, path: "/chosen/project" }]);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(doubles.add).toHaveBeenCalledExactlyOnceWith("/chosen/project"));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/workspace/$workspaceId",
        params: { workspaceId: "one" },
      }),
    );
    expect(useWorkspaceStore.getState().selectedWorkspace?.path).toBe("/chosen/project");
  },
);

it("preserves a search with no results instead of pretending the whole list is empty", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const search = await screen.findByRole("textbox", { name: tr("workspace.searchPlaceholder") });
  fireEvent.change(search, { target: { value: "missing-project" } });
  expect(screen.getByText(tr("workspace.noMatch"))).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(search).toHaveValue("missing-project");
  expect(doubles.pick).not.toHaveBeenCalled();
});

it("keeps non-search filter semantics when existing workspaces do not match", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  start();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("combobox", { name: tr("workspace.allAgents") }));
  await user.click(await screen.findByRole("option", { name: "Codex" }));
  expect(screen.getByText(tr("workspace.noMatch"))).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: tr("workspace.allAgents") })).toHaveTextContent(
    "Codex",
  );
});

it("preserves the mounted list and search on a failed workspace refresh", async () => {
  const { client } = start(true);
  const search = await screen.findByRole("textbox", { name: tr("workspace.searchPlaceholder") });
  fireEvent.change(search, { target: { value: "Alpha" } });
  const pending = deferred<WorkspaceSummary[]>();
  doubles.workspaces.mockReturnValueOnce(pending.promise);
  let refresh!: Promise<void>;
  act(() => {
    refresh = client.invalidateQueries({ queryKey: homeKeys.workspaces() });
  });
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
  await act(async () => {
    pending.reject(new Error("refresh failed"));
    await refresh;
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.workspaces"));
  expect(alert).toHaveTextContent(tr("query.staleData"));
  expect(search).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
  expect(screen.getByRole("button", { name: workspaceButtonName() })).toBeVisible();
  expect(screen.queryByText(tr("workspace.emptyTitle"))).not.toBeInTheDocument();
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(search).toHaveValue("Alpha");
  expect(screen.getByRole("textbox", { name: tr("workspace.searchPlaceholder") })).toBe(search);
});

it("keeps the list visible with an undiagnosed status when diagnostics are unavailable", async () => {
  doubles.workspaces.mockResolvedValue([workspace]);
  doubles.doctor.mockRejectedValue(new Error("diagnostics unavailable"));
  start();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.doctorSummaries"));
  expect(
    screen.getByRole("button", {
      name: `${workspace.name}, ${tr("workspace.source.manual")}, ${tr("workspace.status.undiagnosed")}`,
    }),
  ).toBeVisible();
  doubles.doctor.mockResolvedValue([summary]);
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  expect(await screen.findByRole("button", { name: workspaceButtonName() })).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});

it("retains cached rows but marks diagnostics unchecked when a refresh fails", async () => {
  const { client } = start(true);
  await screen.findByRole("button", { name: workspaceButtonName() });
  doubles.doctor.mockRejectedValueOnce(new Error("diagnostics refresh failed"));
  await act(async () => {
    await client.invalidateQueries({ queryKey: homeKeys.doctorSummaries([workspace.id]) });
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(tr("query.doctorSummaries"));
  expect(alert).toHaveTextContent(tr("query.staleData"));
  expect(
    screen.getByRole("button", {
      name: `${workspace.name}, ${tr("workspace.source.manual")}, ${tr("workspace.status.undiagnosed")}`,
    }),
  ).toBeVisible();
  fireEvent.click(within(alert).getByRole("button", { name: tr("runtime.retry") }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(doubles.workspaces).not.toHaveBeenCalled();
});

it("opens a workspace overview on one click and keeps actions from opening it", async () => {
  start(true);
  fireEvent.click(await screen.findByRole("button", { name: workspaceButtonName() }));
  await waitFor(() =>
    expect(doubles.navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId",
      params: { workspaceId: workspace.id },
    }),
  );
  doubles.navigate.mockClear();
  fireEvent.click(
    screen.getByRole("button", { name: tr("workspace.addFavorite", { name: workspace.name }) }),
  );
  expect(useAppStore.getState().favoriteWorkspaceIds).toContain(workspace.id);
  expect(doubles.navigate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: tr("common.details") })).not.toBeInTheDocument();
  expect(screen.queryByRole("group", { name: tr("workspace.pagination") })).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: tr("workspace.moreActions", { name: workspace.name }) }),
  );
  expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual([
    tr("workspace.rescan"),
    tr("storage.openLocation"),
    tr("workspace.ignore"),
  ]);
  await user.click(await screen.findByRole("menuitem", { name: tr("storage.openLocation") }));
  await waitFor(() => expect(doubles.reveal).toHaveBeenCalledExactlyOnceWith(workspace.id, ""));
  expect(doubles.navigate).not.toHaveBeenCalled();
});

it("keeps rescan and confirmed ignore in the row menu", async () => {
  start(true);
  const user = userEvent.setup();
  const more = await screen.findByRole("button", {
    name: tr("workspace.moreActions", { name: workspace.name }),
  });
  await user.click(more);
  await user.click(await screen.findByRole("menuitem", { name: tr("workspace.rescan") }));
  await waitFor(() => expect(doubles.refresh).toHaveBeenCalledExactlyOnceWith(workspace.id));
  await user.click(more);
  await user.click(await screen.findByRole("menuitem", { name: tr("workspace.ignore") }));
  await waitFor(() =>
    expect(doubles.confirm).toHaveBeenCalledWith({
      description: tr("workspace.ignoreConfirm"),
      tone: "destructive",
    }),
  );
  await waitFor(() => expect(doubles.exclude).toHaveBeenCalledExactlyOnceWith(workspace.id));
  expect(doubles.navigate).not.toHaveBeenCalled();
});

it("filters by shared diagnostic and pending-memory counts instead of the stored status", async () => {
  const unchecked = { ...workspace, id: "unchecked", name: "Unchecked", path: "/unchecked" };
  const warning = { ...workspace, id: "warning", name: "Warning", path: "/warning" };
  const memory: MemoryRecord = {
    id: "pending",
    project_id: workspace.id,
    memory_type: "project_fact",
    content: "Review this",
    status: "pending",
    created_at: "2026-10-23T01:00:00Z",
  };
  doubles.workspaces.mockResolvedValue([workspace, unchecked, warning]);
  doubles.doctor.mockResolvedValue([
    summary,
    { ...summary, workspace_id: warning.id, warning_count: 2 },
  ]);
  doubles.memories.mockResolvedValue([memory]);
  start();
  expect(
    await screen.findByRole("button", {
      name: `${workspace.name}, ${tr("workspace.source.manual")}, ${tr("workspace.status.attention", { count: 1 })}`,
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: `Warning, ${tr("workspace.source.manual")}, ${tr("workspace.status.attention", { count: 2 })}`,
    }),
  ).toBeVisible();
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: tr("workspace.allStatuses") }));
  await user.click(await screen.findByRole("option", { name: tr("workspace.status.undiagnosed") }));
  expect(
    screen.getByRole("button", {
      name: `Unchecked, ${tr("workspace.source.manual")}, ${tr("workspace.status.undiagnosed")}`,
    }),
  ).toBeVisible();
  expect(screen.queryByText(workspace.name)).not.toBeInTheDocument();
  expect(screen.queryByText(warning.name)).not.toBeInTheDocument();
});

it("keeps pagination for multiple pages and places the count by the list title", async () => {
  doubles.workspaces.mockResolvedValue(
    Array.from({ length: 9 }, (_, index) => ({
      ...workspace,
      id: String(index),
      name: `Workspace ${index}`,
      path: `/workspace-${index}`,
    })),
  );
  start();
  const pagination = await screen.findByRole("group", { name: tr("workspace.pagination") });
  expect(
    screen.getByRole("heading", { name: tr("nav.workspaces") }).parentElement,
  ).toHaveTextContent(tr("workspace.listCount", { count: 9 }));
  fireEvent.click(within(pagination).getByRole("button", { name: tr("workspace.nextPage") }));
  expect(screen.getByText("Workspace 8")).toBeVisible();
  expect(screen.queryByText("Workspace 0")).not.toBeInTheDocument();
});

it("preserves the space view switch", async () => {
  start(true);
  fireEvent.click(await screen.findByRole("button", { name: tr("workspace.view.storage") }));
  expect(doubles.navigate).toHaveBeenCalledWith({
    to: "/workspaces",
    search: expect.any(Function),
  });
  const request = doubles.navigate.mock.calls.at(-1)![0];
  expect(request.search({})).toEqual({ workspaceView: "storage" });
});

it("keeps the existing apply lock when adding from an empty workspace page", async () => {
  start();
  const add = await screen.findByRole("button", { name: tr("workspace.addWorkspace") });
  useWorkspaceStore.getState().setApplyingChanges(true);
  fireEvent.click(add);
  await waitFor(() => expect(doubles.notify).toHaveBeenCalledWith(tr("workspace.changesApplying")));
  expect(doubles.pick).not.toHaveBeenCalled();
  expect(doubles.add).not.toHaveBeenCalled();
});

it.each([
  ["macos", "storage.revealInFinder"],
  ["windows", "storage.revealInExplorer"],
  ["linux", "storage.openLocation"],
] as const)(
  "uses the native file manager name on %s and reveals the same workspace",
  async (platform, key) => {
    document.documentElement.dataset.platform = platform;
    start(true);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: tr("workspace.moreActions", { name: workspace.name }),
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: tr(key) }));
    await waitFor(() => expect(doubles.reveal).toHaveBeenCalledExactlyOnceWith(workspace.id, ""));
    expect(doubles.navigate).not.toHaveBeenCalled();
  },
);
