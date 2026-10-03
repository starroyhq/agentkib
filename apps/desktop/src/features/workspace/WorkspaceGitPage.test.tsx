// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  GitCommitPage,
  GitCommitSummary,
  GitWorkspaceSummary,
  WorkspaceSummary,
} from "@/core/types";
import { WorkspaceGitPage } from "./WorkspaceGitPage";

vi.mock("@/core/api", () => ({
  api: {
    workspaceGitSummary: vi.fn(),
    workspaceGitHistory: vi.fn(),
    gitCommitFiles: vi.fn(),
    gitDiff: vi.fn(),
  },
}));

const workspace = { id: "ws", name: "Repo", path: "/repo" } as WorkspaceSummary;
const summary: GitWorkspaceSummary = {
  repository_root: "/repo",
  worktree_root: "/repo",
  head: "main",
  ahead: 0,
  behind: 0,
  stash_count: 0,
  detached: false,
  refs: [],
  changes: [],
};
const commit = (oid: string, subject: string): GitCommitSummary => ({
  oid,
  parents: [],
  subject,
  author_name: "Dev",
  authored_at: "2026-09-01T00:00:00Z",
  refs: [],
});
const page = (commits: GitCommitSummary[], next_cursor?: string): GitCommitPage => ({
  commits,
  next_cursor,
  repository_fingerprint: "fp",
});

function renderPage(subview?: Parameters<typeof WorkspaceGitPage>[0]["subview"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceGitPage workspace={workspace} subview={subview} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceGitPage data loading", () => {
  beforeAll(async () => {
    await initializeI18n("en-US");
    // jsdom 没有实现元素滚动。
    window.Element.prototype.scrollTo ??= () => undefined;
  });
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("does not request history for a directory that is not a Git repository", async () => {
    vi.mocked(api.workspaceGitSummary).mockResolvedValue(undefined as never);
    renderPage();
    await waitFor(() => expect(api.workspaceGitSummary).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector("[aria-busy]")).toBeNull());
    expect(api.workspaceGitHistory).not.toHaveBeenCalled();
  });

  it("fetches the next history page once and reuses cached pages when going back", async () => {
    vi.mocked(api.workspaceGitSummary).mockResolvedValue(summary);
    vi.mocked(api.workspaceGitHistory).mockImplementation(async (_id, query) =>
      query?.cursor === "page-2"
        ? page([commit("b".repeat(40), "Second page commit")])
        : page([commit("a".repeat(40), "First page commit")], "page-2"),
    );
    renderPage();
    expect(await screen.findByText("First page commit")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: tr("git.nextPage") }));
    expect(await screen.findByText("Second page commit")).toBeTruthy();
    expect(api.workspaceGitHistory).toHaveBeenLastCalledWith(
      "ws",
      expect.objectContaining({ cursor: "page-2" }),
    );

    fireEvent.click(screen.getByRole("button", { name: tr("git.previousPage") }));
    expect(await screen.findByText("First page commit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("git.nextPage") }));
    expect(await screen.findByText("Second page commit")).toBeTruthy();
    expect(api.workspaceGitHistory).toHaveBeenCalledTimes(2);
  });

  it("returns to the first page and refetches only that page on refresh", async () => {
    let rewritten = false;
    vi.mocked(api.workspaceGitSummary).mockResolvedValue(summary);
    vi.mocked(api.workspaceGitHistory).mockImplementation(async (_id, query) => {
      // 模拟 force-push：刷新后历史只剩一页。
      if (rewritten) return page([commit("d".repeat(40), "Rewritten history")]);
      return query?.cursor === "page-2"
        ? page([commit("b".repeat(40), "Second page commit")])
        : page([commit("a".repeat(40), "First page commit")], "page-2");
    });
    renderPage();
    expect(await screen.findByText("First page commit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("git.nextPage") }));
    expect(await screen.findByText("Second page commit")).toBeTruthy();

    rewritten = true;
    vi.mocked(api.workspaceGitHistory).mockClear();
    fireEvent.click(screen.getByRole("button", { name: tr("common.refresh") }));
    expect(await screen.findByText("Rewritten history")).toBeTruthy();
    expect(api.workspaceGitHistory).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.workspaceGitHistory).mock.calls[0][1]?.cursor).toBeUndefined();
  });

  it("loads commit files and the commit diff for a commit subview", async () => {
    const oid = "c".repeat(40);
    vi.mocked(api.workspaceGitSummary).mockResolvedValue(summary);
    vi.mocked(api.workspaceGitHistory).mockResolvedValue(page([commit(oid, "Detail commit")]));
    vi.mocked(api.gitCommitFiles).mockResolvedValue([{ status: "M", path: "src/app.ts" }]);
    vi.mocked(api.gitDiff).mockResolvedValue({
      patch: "",
      binary: false,
      submodule: false,
      encoding_lossy: false,
      truncated: false,
    });
    renderPage({ kind: "commit", oid });
    // 文件以目录树显示，叶子节点只显示文件名。
    expect(await screen.findByText("app.ts")).toBeTruthy();
    expect(api.gitCommitFiles).toHaveBeenCalledWith("ws", oid);
    await waitFor(() =>
      expect(api.gitDiff).toHaveBeenCalledWith("ws", { kind: "commit", oid, path: undefined }),
    );
  });
});
