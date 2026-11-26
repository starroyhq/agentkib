import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { SessionWorkspace } from "./session-workspace";
import { dictionaries, type Locale } from "@/features/conversation/i18n";
import { catalogCopy, SessionPlatformProvider, webLayoutCopy } from "@agentkib/session-ui";
import { webSessionPlatform } from "@/features/conversation/session-platform";

const fixture = vi.hoisted(() => ({
  locale: "zh-CN" as Locale,
  pathname: "/sessions",
  refresh: vi.fn(),
  setHistorySearchOpen: vi.fn(),
  choose: vi.fn(),
  navigate: vi.fn(),
}));
const workspace = { id: "workspace", name: "Project", path: "/projects/Project" };
const sessions: ConversationSessionSummary[] = [
  {
    id: "readable",
    workspace_id: workspace.id,
    title: "Readable session",
    agent: "codex",
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: "2026-10-16T00:00:00Z",
  },
];
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: fixture.pathname }),
  useNavigate: () => fixture.navigate,
  Outlet: () => null,
}));
vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: () => ({
    t: dictionaries[fixture.locale],
    locale: fixture.locale,
    selected: "readable",
    modal: null,
    currentTitle: sessions[0].title,
    currentWorkspace: workspace,
    online: true,
    controlReady: true,
    canSend: true,
    live: { status: "idle", approvals: [] },
    access: {
      status: "approved",
      experimentalEnabled: true,
      historySearch: true,
      device: { name: "Test browser", files: true },
    },
    sessions,
    workspaces: [workspace],
    pendingSessions: {},
    indexEnabled: true,
    setModal: vi.fn(),
    setHistorySearchOpen: fixture.setHistorySearchOpen,
    refresh: fixture.refresh,
    choose: fixture.choose,
    post: vi.fn(),
    leaveSession: vi.fn(),
  }),
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  PendingCenter: () => null,
}));
afterEach(() => {
  cleanup();
  fixture.locale = "zh-CN";
  fixture.pathname = "/sessions";
  vi.clearAllMocks();
});

function renderWorkspace() {
  return render(<SessionWorkspace />, {
    wrapper: ({ children }) => (
      <SessionPlatformProvider platform={webSessionPlatform}>{children}</SessionPlatformProvider>
    ),
  });
}

describe("Web session touch targets", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "keeps workspace toggle and path disclosure independently reachable in %s",
    (locale) => {
      fixture.locale = locale;
      renderWorkspace();
      expect(
        screen.queryByRole("button", { name: dictionaries[locale].refresh }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: dictionaries[locale].logout })).toHaveClass(
        "size-11",
      );
      const toggle = screen.getByRole("button", { name: "Project · 1" });
      expect(toggle).toHaveClass("h-auto", "min-h-11", "min-w-11");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      const region = screen.getByRole("region", { name: "Project" });
      const path = within(region).getByLabelText(`Project · ${catalogCopy[locale].path}`);
      expect(path.tagName).toBe("SUMMARY");
      expect(path.parentElement).toHaveClass("[&>summary]:size-11");
      expect(path.parentElement).not.toHaveAttribute("open");
      fireEvent.click(path);
      expect(path.parentElement).toHaveAttribute("open");
      expect(within(region).getByText(workspace.path)).toBeVisible();
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(fixture.choose).not.toHaveBeenCalled();
      fireEvent.click(path);
      expect(path.parentElement).not.toHaveAttribute("open");

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("button", { name: /Readable session/ })).toBeNull();
      fireEvent.click(toggle);
      const row = screen.getByRole("button", { name: /Readable session/ });
      expect(row).toHaveAttribute("aria-current", "page");
      fireEvent.click(row);
      expect(fixture.choose).toHaveBeenCalledExactlyOnceWith("readable");
      expect(fixture.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "readable" },
        resetScroll: false,
      });
    },
  );

  it("keeps the enlarged workspace toggle expanded during a matching search", () => {
    renderWorkspace();
    const toggle = screen.getByRole("button", { name: "Project · 1" });
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /Readable session/ })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: dictionaries["zh-CN"].search }), {
      target: { value: "Readable" },
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Readable session/ })).toBeVisible();
    expect(fixture.choose).not.toHaveBeenCalled();
  });

  it("keeps the same workspace controls when the route changes to a reader", () => {
    const view = renderWorkspace();
    const toggle = screen.getByRole("button", { name: "Project · 1" });
    fixture.pathname = "/sessions/readable";
    view.rerender(<SessionWorkspace />);
    expect(screen.getByRole("button", { name: "Project · 1" })).toBe(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Readable session/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("aligns history search and directory options with the directory title", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const title = screen.getByRole("heading", { name: dictionaries[fixture.locale].sessions });
    const header = title.closest("header")!;
    expect(header).not.toBeNull();
    const search = within(header).getByRole("button", { name: "搜索会话正文" });
    const options = within(header).getByRole("button", {
      name: catalogCopy[fixture.locale].options,
    });
    for (const button of [search, options]) {
      expect(button).toHaveClass("size-11");
      expect(button).not.toHaveClass("w-full");
      expect(button).toHaveTextContent(/^$/);
    }
    await user.hover(options);
    expect(
      await screen.findByRole("tooltip", { name: catalogCopy[fixture.locale].options }),
    ).toBeVisible();
    await user.click(search);
    expect(fixture.setHistorySearchOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.choose).not.toHaveBeenCalled();
  });

  it("shows a tooltip for the icon-only header control and opens files with Enter", async () => {
    fixture.pathname = "/sessions/readable";
    const user = userEvent.setup();
    renderWorkspace();
    const copy = webLayoutCopy[fixture.locale];
    const files = screen.getByRole("button", { name: copy.files });
    const actions = screen.getByRole("button", { name: copy.actions });
    expect(files).toHaveClass("size-11");
    expect(files).toHaveTextContent(/^$/);
    expect(actions).toHaveClass("size-11");
    expect(actions).toHaveTextContent(/^$/);
    await user.hover(files);
    expect(await screen.findByRole("tooltip", { name: copy.files })).toBeVisible();

    files.focus();
    await user.keyboard("{Enter}");
    expect(files).toHaveAttribute("aria-expanded", "true");
  });
});
