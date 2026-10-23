// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "@/core/i18n";
import type { ChangeSet, Manifest, WorkspaceSummary } from "@/core/types";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import { Route } from "./index";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
}));
vi.mock("@/features/home/home-query", () => ({ useHomeDoctorReport: () => ({ data: undefined }) }));
vi.mock("@/features/obsidian/ObsidianIntegration", () => ({ WorkspaceObsidianCard: () => null }));
vi.mock("@/features/workspace/WorkspaceRecentSessions", () => ({
  WorkspaceRecentSessions: () => null,
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
const manifest: Manifest = {
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared: "draft", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
const plan: ChangeSet = {
  id: "pending",
  project_root: workspace.path,
  created_at: "",
  requires_home_approval: false,
  changes: [
    {
      target: "/workspace/AGENTS.md",
      scope: "project",
      before: "old",
      after: "new",
      risk: "low",
      validator: "markdown",
    },
  ],
};
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
  await screen.findByText("Shared assets");
}

describe("overview pending changes", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    navigate.mockReset();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest,
      scan: { root: workspace.path, manifest_exists: true, agents: [], assets: [], warnings: [] },
      changeSet: plan,
      changeSetManifest: JSON.stringify(manifest),
    });
  });
  afterEach(cleanup);

  it("keeps zero Agent assets subdued without hiding unconfigured Agents", async () => {
    useWorkspaceStore.setState({
      scan: {
        root: workspace.path,
        manifest_exists: true,
        agents: [{ agent: "claude-code", detected: false, asset_count: 0, warnings: [] }],
        assets: [],
        warnings: [],
      },
    });
    await renderRoute();
    const summary = screen.getByRole("button", { name: "0 assets in Agent folders from 0 Agents" });
    expect(summary).toHaveClass("text-muted-foreground");
    expect(summary.querySelector("svg")).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByRole("button", { name: "Other Agent (1)" })).toBeVisible();
  });

  it.each([
    [1, "1 asset in Agent folders from 1 Agent"],
    [2, "2 assets in Agent folders from 1 Agent"],
  ] as const)("pluralizes %i Agent assets independently of Agent count", async (count, text) => {
    useWorkspaceStore.setState({
      scan: {
        root: workspace.path,
        manifest_exists: true,
        agents: [{ agent: "claude-code", detected: true, asset_count: count, warnings: [] }],
        assets: [],
        warnings: [],
      },
    });
    await renderRoute();
    expect(screen.getByRole("button", { name: text })).toBeVisible();
  });

  it.each<ChangeSetOrigin>(["standard", "doctor", "handoff", "handoff-setup"])(
    "offers the actual pending %s plan with accurate wording",
    async (origin) => {
      useWorkspaceStore.getState().setChangeSetOrigin(origin);
      await renderRoute();
      expect(
        screen.getByText(
          origin === "doctor" ? "Repair plan awaiting review" : "Pending changes: 1",
        ),
      ).toBeVisible();
      if (origin !== "doctor") expect(screen.queryByText("Repair plan awaiting review")).toBeNull();
      const button = screen.getByRole("button", { name: "Review pending changes" });
      fireEvent.click(button);
      expect(navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/workspace/$workspaceId/changes",
        params: { workspaceId: workspace.id },
      });
      expect(useWorkspaceStore.getState().changeSet).toBe(plan);
    },
  );

  it.each(["absent", "empty", "other project", "stale draft", "other workspace"])(
    "does not advertise an %s plan",
    async (reason) => {
      if (reason === "absent") useWorkspaceStore.getState().setChangeSet(undefined);
      else if (reason === "empty")
        useWorkspaceStore.setState({ changeSet: { ...plan, changes: [] } });
      else if (reason === "other project")
        useWorkspaceStore.setState({ changeSet: { ...plan, project_root: "/other" } });
      else if (reason === "stale draft")
        useWorkspaceStore.setState({ changeSetManifest: "obsolete" });
      else useWorkspaceStore.setState({ selectedWorkspace: { ...workspace, id: "other" } });
      await renderRoute();
      expect(screen.queryByRole("button", { name: "Review pending changes" })).toBeNull();
      expect(screen.queryByText("Pending changes: 1")).toBeNull();
      expect(screen.queryByText("Repair plan awaiting review")).toBeNull();
    },
  );

  it("keeps a Doctor plan visible when it intentionally leaves an existing draft unconsumed", async () => {
    useWorkspaceStore.setState({ changeSetOrigin: "doctor", changeSetManifest: "disk snapshot" });
    await renderRoute();
    expect(screen.getByText("Repair plan awaiting review")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review pending changes" }));
    expect(navigate).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().manifest).toBe(manifest);
  });

  it("offers the remaining handoff recovery after file changes have been applied", async () => {
    useWorkspaceStore.setState({
      changeSet: undefined,
      handoffLaunchRequest: {
        mode: "handoff-file",
        workspace_id: workspace.id,
        target_agent: "codex",
        filename: "handoff.md",
      },
    });
    await renderRoute();
    expect(screen.getByText("Handoff needs attention")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Continue handoff" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/workspace/$workspaceId/changes",
      params: { workspaceId: workspace.id },
    });
  });

  it.each(["busy", "applyingChanges"] as const)(
    "does not navigate away through the new entry while %s",
    async (key) => {
      useWorkspaceStore.setState({ [key]: true });
      await renderRoute();
      const button = screen.getByRole("button", { name: "Review pending changes" });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});
