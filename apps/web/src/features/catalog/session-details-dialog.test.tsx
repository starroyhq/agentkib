import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogCopy } from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";

const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session.value,
}));

import { SessionDetailsDialog } from "@/features/conversation/features/catalog/session-details-dialog";

afterEach(cleanup);

describe("Codex native session details", () => {
  it("queries only the selected thread and labels its creation-time branch", async () => {
    const request = vi.fn().mockResolvedValue({
      available: true,
      cwd: "/repo/worktree",
      projectId: "native-project",
      branchAtCreation: "feature/start",
    });
    session.value = {
      t: dictionaries["zh-CN"],
      c: catalogCopy["zh-CN"],
      setModal: vi.fn(),
      current: { id: "thread-one", agent: "codex", workspace_id: "repo" },
      live: { sessionId: "thread-one", cliVersion: "0.147.0", model: "codex-model" },
      currentWorkspace: { name: "Repo", path: "/repo" },
      formatCatalogTime: () => "现在",
      sourceTitle: () => "",
      online: true,
      liveText: "空闲",
      client: { request },
      access: { status: "approved", protocolVersion: 2, device: { id: "browser" } },
    };
    render(<SessionDetailsDialog />);
    expect(await screen.findByText("/repo/worktree")).toBeInTheDocument();
    expect(screen.getByText("创建时分支")).toBeInTheDocument();
    expect(screen.getByText("feature/start")).toBeInTheDocument();
    expect(screen.getByText("0.147.0")).toBeInTheDocument();
    expect(screen.getByText("codex-model")).toBeInTheDocument();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "managed/context?sessionId=thread-one",
        undefined,
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not substitute the indexed branch when Codex metadata is unavailable", async () => {
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    session.value = {
      t: dictionaries["zh-CN"],
      c: catalogCopy["zh-CN"],
      setModal: vi.fn(),
      current: { id: "thread-two", agent: "codex", git_branch: "stale-branch" },
      currentWorkspace: { name: "Repo", path: "/repo" },
      formatCatalogTime: () => "现在",
      sourceTitle: () => "",
      online: false,
      liveText: "",
      client: { request },
      access: { status: "approved", protocolVersion: 2, device: { id: "browser" } },
    };
    render(<SessionDetailsDialog />);
    expect(await screen.findAllByText("Codex 信息不可用")).toHaveLength(3);
    expect(screen.queryByText("stale-branch")).not.toBeInTheDocument();
  });
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows the matching client's version and model only in session details in %s",
    async (locale) => {
      const copy = catalogCopy[locale];
      session.value = {
        t: dictionaries[locale],
        c: copy,
        setModal: vi.fn(),
        current: { id: "claude-current", agent: "claude-code", workspace_id: "repo" },
        live: {
          sessionId: "claude-current",
          cliVersion: "2.1.302 (Claude Code)",
          model: "claude-model",
        },
        currentWorkspace: { name: "Repo", path: "/repo" },
        formatCatalogTime: () => copy.unknown,
        sourceTitle: () => "",
        online: true,
        liveText: "",
        client: {
          request: vi
            .fn()
            .mockResolvedValue({ available: true, sourceFile: "/private/claude-current.jsonl" }),
        },
        access: { status: "approved", device: { id: "browser" } },
      };
      render(<SessionDetailsDialog />);
      expect(await screen.findByText("/private/claude-current.jsonl")).toBeVisible();
      expect(
        screen.getByText(copy.sourceFile, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent("/private/claude-current.jsonl");
      expect(
        screen.getByText(copy.clientVersion, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent("2.1.302 (Claude Code)");
      expect(screen.getByText(copy.model, { selector: "dt" }).nextElementSibling).toHaveTextContent(
        "claude-model",
      );
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "does not show a previous session's runtime metadata while switching in %s",
    (locale) => {
      const copy = catalogCopy[locale];
      session.value = {
        t: dictionaries[locale],
        c: copy,
        setModal: vi.fn(),
        current: { id: "claude-current", agent: "claude-code", workspace_id: "repo" },
        live: {
          sessionId: "claude-previous",
          cliVersion: "private-previous-version",
          model: "private-previous-model",
        },
        currentWorkspace: { name: "Repo", path: "/repo" },
        formatCatalogTime: () => copy.unknown,
        sourceTitle: () => "",
        online: true,
        liveText: "",
        client: { request: vi.fn().mockResolvedValue({ available: false }) },
        access: { status: "approved", device: { id: "browser" } },
      };
      const view = render(<SessionDetailsDialog />);
      expect(screen.queryByText("private-previous-version")).toBeNull();
      expect(screen.queryByText("private-previous-model")).toBeNull();
      expect(
        screen.getByText(copy.clientVersion, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(copy.unknown);
      expect(screen.getByText(copy.model, { selector: "dt" }).nextElementSibling).toHaveTextContent(
        copy.unknown,
      );
      session.value = {
        ...session.value,
        live: {
          sessionId: "claude-current",
          cliVersion: "current-version",
          model: "current-model",
        },
      };
      view.rerender(<SessionDetailsDialog />);
      expect(screen.getByText("current-version")).toBeVisible();
      expect(screen.getByText("current-model")).toBeVisible();
      session.value = { ...session.value, current: { id: "next-session", agent: "claude-code" } };
      view.rerender(<SessionDetailsDialog />);
      expect(screen.queryByText("current-version")).toBeNull();
      expect(screen.queryByText("current-model")).toBeNull();
    },
  );
  it.each([null, undefined])(
    "uses unknown when the host has no verified source file (%s)",
    async (sourceFile) => {
      const copy = catalogCopy["zh-CN"];
      const request = vi.fn().mockResolvedValue({ available: true, sourceFile });
      session.value = {
        t: dictionaries["zh-CN"],
        c: copy,
        setModal: vi.fn(),
        current: { id: "claude-current", agent: "claude-code" },
        formatCatalogTime: () => copy.unknown,
        sourceTitle: () => "",
        online: true,
        liveText: "",
        client: { request },
        access: { status: "approved", device: { id: "browser" } },
      };
      render(<SessionDetailsDialog />);
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          "managed/context?sessionId=claude-current",
          undefined,
          expect.any(AbortSignal),
        ),
      );
      expect(
        screen.getByText(copy.sourceFile, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(copy.unknown);
    },
  );

  it("discards a late source file response after switching sessions and hides it after access ends", async () => {
    const copy = catalogCopy["zh-CN"];
    let resolveOld!: (value: object) => void;
    let resolveCurrent!: (value: object) => void;
    const oldResult = new Promise<object>((resolve) => {
      resolveOld = resolve;
    });
    const currentResult = new Promise<object>((resolve) => {
      resolveCurrent = resolve;
    });
    const request = vi.fn((url: string) =>
      url.endsWith("old-session") ? oldResult : currentResult,
    );
    session.value = {
      t: dictionaries["zh-CN"],
      c: copy,
      setModal: vi.fn(),
      current: { id: "old-session", agent: "claude-code" },
      formatCatalogTime: () => copy.unknown,
      sourceTitle: () => "",
      online: true,
      liveText: "",
      client: { request },
      access: { status: "approved", device: { id: "browser" } },
    };
    const view = render(<SessionDetailsDialog />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    session.value = { ...session.value, current: { id: "current-session", agent: "claude-code" } };
    view.rerender(<SessionDetailsDialog />);
    await act(async () => {
      resolveCurrent({ available: true, sourceFile: "/private/current.jsonl" });
    });
    expect(await screen.findByText("/private/current.jsonl")).toBeVisible();
    await act(async () => {
      resolveOld({ available: true, sourceFile: "/private/old.jsonl" });
    });
    expect(screen.queryByText("/private/old.jsonl")).toBeNull();
    expect(
      screen.getByText(copy.sourceFile, { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent("/private/current.jsonl");
    session.value = { ...session.value, access: { status: "ended", device: { id: "browser" } } };
    view.rerender(<SessionDetailsDialog />);
    expect(screen.queryByText("/private/current.jsonl")).toBeNull();
    expect(
      screen.getByText(copy.sourceFile, { selector: "dt" }).nextElementSibling,
    ).toHaveTextContent(copy.unknown);
  });
  it.each([
    ["zh-CN", "交互会话", "辅助会话"],
    ["zh-Hant", "互動對話", "輔助對話"],
    ["en-US", "Interactive session", "Auxiliary session"],
    ["ja-JP", "対話型の会話", "補助会話"],
  ] as const)(
    "uses session terminology for source labels in %s",
    (locale, interactive, auxiliary) => {
      const copy = catalogCopy[locale];
      session.value = {
        t: dictionaries[locale],
        c: copy,
        setModal: vi.fn(),
        current: { id: "session", agent: "claude-code", origin: "interactive" },
        currentWorkspace: { name: "Repo", path: "/repo" },
        formatCatalogTime: () => copy.unknown,
        sourceTitle: () => "",
        online: true,
        liveText: "",
        client: { request: vi.fn().mockResolvedValue({ available: false }) },
        access: { status: "approved", device: { id: "browser" } },
      };
      const view = render(<SessionDetailsDialog />);
      expect(
        screen.getByText(copy.source, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(interactive);
      session.value = {
        ...session.value,
        current: { id: "session", agent: "claude-code", origin: "auxiliary" },
      };
      view.rerender(<SessionDetailsDialog />);
      expect(
        screen.getByText(copy.source, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(auxiliary);
    },
  );
});
