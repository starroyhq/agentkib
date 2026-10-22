// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { InstalledSkill, SkillDeployment } from "@/core/types";
import { appSearchSchema } from "@/features/app/app-search-schema";
import { Route } from "./catalog";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeCatalog: () => ({ data: [], isPending: false }),
  useHomeWorkspaces: () => ({ data: [], isPending: false }),
  useHomeMemories: () => ({ data: [], isPending: false }),
}));
vi.mock("@/features/catalog/AssetCatalogPage", () => ({
  AssetCatalogPage: () => <p>Instructions list</p>,
}));
vi.mock("@/core/api", () => ({
  api: {
    installedSkills: vi.fn(),
    removedSkills: vi.fn(),
    skillInventory: vi.fn(),
    skillDeployments: vi.fn(),
    skillSyncState: vi.fn(),
    skillCatalog: vi.fn(),
    discoverSkills: vi.fn(),
    rollbackSkill: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tabKey = {
  library: "skills.library",
  workspace: "skills.workspaceUsage",
  discover: "skills.discover",
} as const;
async function selected(section: keyof typeof tabKey) {
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: new RegExp(tr(tabKey[section])) })).toHaveAttribute(
      "aria-selected",
      "true",
    ),
  );
}
async function start(url = "/catalog?assetSection=skills") {
  const root = createRootRoute({ validateSearch: appSearchSchema, component: Outlet });
  const catalog = createRoute({
    getParentRoute: () => root,
    path: "/catalog",
    component: Route.options.component,
  });
  const home = createRoute({ getParentRoute: () => root, path: "/", component: () => <p>Home</p> });
  const history = createMemoryHistory({ initialEntries: [url] });
  const router = createRouter({ routeTree: root.addChildren([catalog, home]), history });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AppDialogProvider>
        <RouterProvider router={router} />
      </AppDialogProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole("tab", { name: new RegExp(tr("skills.library")) });
  return { ...view, router, history };
}
beforeAll(async () => {
  const component = Route.options.component;
  if (component && "preload" in component && typeof component.preload === "function")
    await component.preload();
});
beforeEach(async () => {
  vi.resetAllMocks();
  await initializeI18n("en-US");
  vi.mocked(api.installedSkills).mockResolvedValue([]);
  vi.mocked(api.removedSkills).mockResolvedValue([]);
  vi.mocked(api.skillInventory).mockResolvedValue({ observations: [], warnings: [] });
  vi.mocked(api.skillDeployments).mockResolvedValue([]);
  vi.mocked(api.skillSyncState).mockResolvedValue({
    library: [],
    deployments: [],
    observations: [],
    warnings: [],
  });
  vi.mocked(api.skillCatalog).mockResolvedValue({
    entries: [],
    cached_at: "2026-10-16T00:00:00Z",
    stale: false,
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("catalog Skills URL navigation", () => {
  it("opens populated usage for an empty library when the URL has no explicit subtab", async () => {
    vi.mocked(api.skillInventory).mockResolvedValue({
      observations: [
        {
          id: "native",
          name: "reviewer",
          path: "/fixture/skills/reviewer",
          resolved_path: "/fixture/skills/reviewer",
          scope: "personal",
          workspace_id: null,
          agents: ["codex"],
          kind: "directory",
          status: "visible",
          owner: "external",
          library_id: null,
          diagnostics: [],
        },
      ],
      warnings: [],
    });
    const { router } = await start();
    await selected("workspace");
    expect(screen.getByText("reviewer")).toBeVisible();
    expect(router.state.location.search.skillSection).toBeUndefined();
    expect(api.skillCatalog).not.toHaveBeenCalled();
  });
  it.each(["library", "workspace", "discover"] as const)(
    "loads and refreshes the %s deep link",
    async (section) => {
      const first = await start(`/catalog?assetSection=skills&skillSection=${section}`);
      await selected(section);
      const url = first.router.state.location.href;
      first.unmount();
      const refreshed = await start(url);
      await selected(section);
      expect(refreshed.router.state.location.search).toMatchObject({
        assetSection: "skills",
        skillSection: section,
      });
    },
  );

  it.each(["", "&skillSection=unknown", "&skillSection=%5B%22workspace%22%5D"])(
    "defaults safely to the library for %s",
    async (parameter) => {
      const { router } = await start(`/catalog?assetSection=skills${parameter}`);
      await selected("library");
      expect(router.state.location.search.skillSection).toBeUndefined();
      expect(api.skillCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "restores the localized usage tab from a deep link in %s",
    async (locale) => {
      await initializeI18n(locale);
      await start("/catalog?assetSection=skills&skillSection=workspace");
      await selected("workspace");
    },
  );

  it("writes only the subtab field and follows browser back and forward", async () => {
    const initial =
      "/catalog?assetSection=skills&catalogTarget=mcp-network&workspaceAssetSection=native&workspaceView=storage&sessionId=saved-session&agent=codex";
    const { router, history } = await start(initial);
    const original = { ...router.state.location.search };
    const user = userEvent.setup();
    await selected("library");
    await user.click(screen.getByRole("tab", { name: new RegExp(tr("skills.workspaceUsage")) }));
    await selected("workspace");
    expect(router.state.location.search).toEqual({ ...original, skillSection: "workspace" });
    await user.click(screen.getByRole("tab", { name: tr("skills.discover") }));
    await selected("discover");
    expect(router.state.location.search).toEqual({ ...original, skillSection: "discover" });
    await act(async () => history.back());
    await selected("workspace");
    await act(async () => history.back());
    await selected("library");
    await act(async () => history.forward());
    await selected("workspace");
    expect(router.state.location.search).toEqual({ ...original, skillSection: "workspace" });
  });

  it("keeps discovery input and a pending result across URL tab changes without remounting the hub", async () => {
    vi.mocked(api.installedSkills).mockResolvedValue([
      {
        name: "saved",
        display_name: "Saved",
        description: "Saved skill",
        path: "/fixture/library/saved",
        size: 1,
        status: "current",
        can_rollback: false,
      },
    ]);
    const result = deferred<Awaited<ReturnType<typeof api.discoverSkills>>>();
    vi.mocked(api.discoverSkills).mockReturnValue(result.promise);
    const { router, history } = await start("/catalog?assetSection=skills&skillSection=discover");
    await selected("discover");
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", { name: tr("skills.addFromGithub") });
    await user.type(input, "https://github.com/example/repo");
    await user.click(screen.getByRole("button", { name: tr("skills.inspectUrl") }));
    expect(input).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: new RegExp(tr("skills.library")) }));
    await selected("library");
    const librarySearch = screen.getByRole("textbox", { name: tr("skills.manager.searchLibrary") });
    await user.type(librarySearch, "keep-filter");
    await act(async () => history.back());
    await selected("discover");
    const restored = screen.getByRole("textbox", { name: tr("skills.addFromGithub") });
    expect(restored).toHaveValue("https://github.com/example/repo");
    expect(restored).toBeDisabled();
    expect(api.discoverSkills).toHaveBeenCalledOnce();
    await act(async () => result.resolve([]));
    await waitFor(() => expect(restored).toBeEnabled());
    await act(async () => history.forward());
    await selected("library");
    expect(screen.getByRole("textbox", { name: tr("skills.manager.searchLibrary") })).toHaveValue(
      "keep-filter",
    );
    expect(router.state.location.search.skillSection).toBe("library");
  });

  it("retains the subtab when leaving Skills and returning through the outer section or history", async () => {
    const { router, history } = await start(
      "/catalog?assetSection=skills&skillSection=discover&catalogTarget=mcp-network&workspaceAssetSection=native",
    );
    await selected("discover");
    const nav = within(screen.getByRole("navigation", { name: tr("nav.assets") }));
    fireEvent.click(nav.getByRole("button", { name: `${tr("assets.instructions")} 0` }));
    await screen.findByText("Instructions list");
    expect(router.state.location.search).toMatchObject({
      assetSection: "instructions",
      skillSection: "discover",
      workspaceAssetSection: "native",
    });
    expect(router.state.location.search.catalogTarget).toBeUndefined();
    fireEvent.click(nav.getByRole("button", { name: tr("assets.skills") }));
    await selected("discover");
    const returnUrl = router.state.location.href;
    await act(async () => router.navigate({ to: "/" }));
    await screen.findByText("Home");
    await act(async () => history.back());
    await selected("discover");
    expect(router.state.location.href).toBe(returnUrl);
  });

  it("writes the existing view-deployments success action to the same URL state", async () => {
    const skill: InstalledSkill = {
      name: "reviewer",
      display_name: "Reviewer",
      description: "Review",
      path: "/library/reviewer",
      size: 1,
      status: "current",
      can_rollback: true,
    };
    const deployment: SkillDeployment = {
      id: "deployment",
      library_id: skill.name,
      source_is_current_library: true,
      package_name: "Reviewer",
      package_hash: "hash",
      scope: "personal",
      workspace_id: null,
      scope_root: "/native",
      target: "/native/skills/reviewer",
      agents: ["codex"],
      visible_to: ["codex"],
      status: "active",
      diagnostics: [],
      previous_hash: null,
      operation_id: "operation",
      updated_at: "2026-10-16T00:00:00Z",
    };
    vi.mocked(api.installedSkills).mockResolvedValue([skill]);
    vi.mocked(api.skillDeployments).mockResolvedValue([deployment]);
    vi.mocked(api.rollbackSkill).mockResolvedValue(skill);
    const { router } = await start();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^More actions · Reviewer$/ }));
    await user.click(await screen.findByRole("menuitem", { name: tr("skills.rollback") }));
    await user.click(screen.getByRole("button", { name: tr("common.confirm") }));
    const action = await screen.findByRole("button", {
      name: tr("skills.manager.viewDeployments"),
    });
    await waitFor(() => expect(action).toBeEnabled());
    await user.click(action);
    await selected("workspace");
    expect(router.state.location.search).toMatchObject({
      assetSection: "skills",
      skillSection: "workspace",
    });
    expect(api.rollbackSkill).toHaveBeenCalledOnce();
  });
});
