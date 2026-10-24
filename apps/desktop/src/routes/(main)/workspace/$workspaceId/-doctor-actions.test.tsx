// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { DoctorIssueDestination } from "@/features/workspace/doctor-manual-actions";
import type { AgentKind } from "@/core/types";
import { Route } from "./doctor";

const navigate = vi.hoisted(() => vi.fn());
const reveal = vi.hoisted(() => ({
  callback: undefined as undefined | ((path: string) => void | Promise<void>),
}));
vi.mock("@/core/api", () => ({ api: { openWorkspaceStoragePath: vi.fn() } }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => navigate,
  useParams: () => ({ workspaceId: "workspace" }),
  useSearch: () => ({}),
}));
vi.mock("@/features/workspace/WorkspaceDoctorPage", () => ({
  WorkspaceDoctorPage: ({
    onOpenIssue,
    onRevealPath,
  }: {
    onOpenIssue: (to: DoctorIssueDestination, agent?: AgentKind) => void;
    onRevealPath: (path: string) => void | Promise<void>;
  }) => {
    reveal.callback = onRevealPath;
    return (
      <>
        <button onClick={() => onOpenIssue("context", "grok-build")}>grok context</button>
        {(["context", "skills", "mcp"] as const).map((to) => (
          <button key={to} onClick={() => onOpenIssue(to)}>
            {to}
          </button>
        ))}
      </>
    );
  },
}));

async function renderDoctor() {
  const Component = Route.options.component!;
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <Component />
      </Suspense>,
    );
  });
}

describe("doctor issue navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    navigate.mockReset();
    vi.mocked(api.openWorkspaceStoragePath).mockReset().mockResolvedValue(undefined);
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
    });
  });
  afterEach(cleanup);

  it("opens context issues in the current workspace", async () => {
    await renderDoctor();
    fireEvent.click(await screen.findByRole("button", { name: "context" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/context",
      params: { workspaceId: "workspace" },
    });
  });
  it("opens instruction context with the affected Agent already selected", async () => {
    await renderDoctor();
    fireEvent.click(await screen.findByRole("button", { name: "grok context" }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/context",
      params: { workspaceId: "workspace" },
      search: { agent: "grok-build" },
    });
  });

  it.each(["skills", "mcp"] as const)("opens the matching %s asset section", async (section) => {
    await renderDoctor();
    fireEvent.click(await screen.findByRole("button", { name: section }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: "/workspace/$workspaceId/assets",
      params: { workspaceId: "workspace" },
      search: { workspaceAssetSection: section },
    });
  });
  it.each([
    ["/workspace/CLAUDE.md", ""],
    ["/workspace/src/AGENTS.md", "src"],
    ["/workspace/.agentkib/manifest.yaml", ".agentkib"],
  ])("opens only the containing directory for %s", async (file, directory) => {
    await renderDoctor();
    await act(async () => reveal.callback!(file));
    expect(api.openWorkspaceStoragePath).toHaveBeenCalledExactlyOnceWith("workspace", directory);
  });

  it.each(["/other/CLAUDE.md", "/workspace-neighbor/CLAUDE.md", "/workspace/../other/CLAUDE.md"])(
    "rejects an out-of-scope evidence path %s",
    async (file) => {
      await renderDoctor();
      await act(async () => reveal.callback!(file));
      expect(api.openWorkspaceStoragePath).not.toHaveBeenCalled();
    },
  );

  it("shows a failed folder operation and does not leak it into another workspace", async () => {
    vi.mocked(api.openWorkspaceStoragePath).mockRejectedValue(new Error("Folder unavailable"));
    await renderDoctor();
    await act(async () => reveal.callback!("/workspace/CLAUDE.md"));
    expect(useWorkspaceStore.getState().message).toContain("Folder unavailable");
    useWorkspaceStore.getState().setMessage("");
    const previous = reveal.callback!;
    act(() => useWorkspaceStore.getState().setProject("/other"));
    await act(async () => previous("/workspace/CLAUDE.md"));
    expect(useWorkspaceStore.getState().message).toBe("");
  });
});
