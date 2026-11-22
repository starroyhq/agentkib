// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createContext, useContext, useState } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogCopy } from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";
import { render } from "../../desktop-reader-test-utils";
import { SessionDialogs } from "../../desktop-session-dialogs";

const MetadataContext = createContext<Record<string, unknown> | null>(null);
const session = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/features/sessions/conversation/desktop-session-context", () => ({
  useSession: () => useContext(MetadataContext) ?? { modal: "metadata", ...session.value },
}));

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
      t: conversationWords("zh-CN"),
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
    render(<SessionDialogs />);
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
      t: conversationWords("zh-CN"),
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
    render(<SessionDialogs />);
    expect(await screen.findAllByText("Codex 信息不可用")).toHaveLength(3);
    expect(screen.queryByText("stale-branch")).not.toBeInTheDocument();
  });
  it.each([
    ["zh-CN", "项目信息不可用，请更新这台电脑上的 AgentKib。"],
    ["zh-Hant", "專案資訊不可用，請更新這台電腦上的 AgentKib。"],
    ["en-US", "Project information unavailable. Update AgentKib on this computer."],
    [
      "ja-JP",
      "プロジェクト情報を取得できません。このコンピューター上の AgentKib を更新してください。",
    ],
  ] as const)(
    "shows the matching client's version and model only in session details in %s",
    async (locale, missingProject) => {
      const copy = catalogCopy[locale];
      session.value = {
        t: conversationWords(locale),
        c: copy,
        setModal: vi.fn(),
        current: { id: "claude-current", agent: "claude-code", workspace_id: "repo" },
        live: {
          sessionId: "claude-current",
          cliVersion: "2.1.302 (Claude Code)",
          model: "claude-model",
        },
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
      render(<SessionDialogs />);
      expect(
        screen.getByText(copy.project, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(missingProject);
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
        t: conversationWords(locale),
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
      const view = render(<SessionDialogs />);
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
      view.rerender(<SessionDialogs />);
      expect(screen.getByText("current-version")).toBeVisible();
      expect(screen.getByText("current-model")).toBeVisible();
      session.value = { ...session.value, current: { id: "next-session", agent: "claude-code" } };
      view.rerender(<SessionDialogs />);
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
        t: conversationWords("zh-CN"),
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
      render(<SessionDialogs />);
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
      t: conversationWords("zh-CN"),
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
    const view = render(<SessionDialogs />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    session.value = { ...session.value, current: { id: "current-session", agent: "claude-code" } };
    view.rerender(<SessionDialogs />);
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
    view.rerender(<SessionDialogs />);
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
        t: conversationWords(locale),
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
      const view = render(<SessionDialogs />);
      expect(
        screen.getByText(copy.source, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(interactive);
      session.value = {
        ...session.value,
        current: { id: "session", agent: "claude-code", origin: "auxiliary" },
      };
      view.rerender(<SessionDialogs />);
      expect(
        screen.getByText(copy.source, { selector: "dt" }).nextElementSibling,
      ).toHaveTextContent(auxiliary);
    },
  );
});

it("keeps the desktop metadata layout and restores focus after closing", async () => {
  const labels = conversationWords("en-US");
  const copy = catalogCopy["en-US"];
  function Harness() {
    const [modal, setModal] = useState<"metadata">();
    const fixture = {
      modal,
      setModal,
      t: labels,
      c: copy,
      formatCatalogTime: () => copy.unknown,
      online: false,
    };
    return (
      <MetadataContext value={fixture}>
        <button type="button" onClick={() => setModal("metadata")}>
          Open metadata
        </button>
        <SessionDialogs />
      </MetadataContext>
    );
  }
  render(<Harness />);
  const launch = screen.getByRole("button", { name: "Open metadata" });
  launch.focus();
  fireEvent.click(launch);

  const dialog = await screen.findByRole("dialog", { name: labels.metadata });
  expect(dialog).toHaveClass("max-h-[min(85dvh,760px)]");
  expect(dialog.querySelector(".dialog-body")).toHaveClass("overflow-y-auto");
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

  fireEvent.click(within(dialog).getByRole("button", { name: labels.close }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(launch).toHaveFocus());
});
