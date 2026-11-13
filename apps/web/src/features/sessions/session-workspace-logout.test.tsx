import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { WebClient, type ConversationClientBridge } from "@agentkib/web-client";
import {
  SessionProvider,
  useSession,
} from "@/features/conversation/features/sessions/session-context";
import type { Locale } from "@/features/conversation/i18n";
import { dictionaries } from "@/features/conversation/i18n";
import { SessionWorkspace } from "./session-workspace";
import { sessionAccessCopy } from "./session-access-copy";

const layout = vi.hoisted(() => ({ mounts: 0, navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: "/sessions/first" }),
  useNavigate: () => layout.navigate,
  Outlet: () => {
    const session = useSession();
    useEffect(() => {
      layout.mounts++;
    }, []);
    return (
      <>
        <p>{session.page?.events.map((event) => event.content).join("\n")}</p>
        <textarea
          aria-label="Unsent draft"
          value={session.message}
          onChange={(event) => session.setMessage(event.target.value)}
        />
      </>
    );
  },
}));
vi.mock("@/features/conversation/features/catalog/session-catalog", () => ({
  SessionCatalog: () => null,
}));
vi.mock("@/features/conversation/features/sessions/managed-tasks", () => ({
  ManagedTasks: () => null,
}));
vi.mock("@/features/conversation/features/sessions/pending-center", () => ({
  PendingCenter: () => null,
}));
vi.mock("@/features/conversation/features/history/history-search-controls", () => ({
  HistorySearchTrigger: () => null,
  HistorySearchControls: () => null,
}));

function hostFixture(readOnly = false) {
  const host = { approved: true, endOnLogout: true };
  const logout = vi.fn(async () => {});
  const request = vi.fn(async (path: string, _body?: unknown) => {
    const operation = path.split("?")[0];
    if (operation === "logout") {
      await logout();
      if (host.endOnLogout) host.approved = false;
      return undefined;
    }
    if (operation === "access")
      return {
        protocolVersion: 2,
        status: host.approved ? "approved" : "unpaired",
        csrfToken: "test-csrf",
        bootId: "test-boot",
        experimentalEnabled: true,
        device: host.approved
          ? {
              id: "test-device",
              name: "Test browser",
              send: !readOnly,
              approve: !readOnly,
              files: !readOnly,
            }
          : undefined,
      };
    if (operation === "catalog")
      return {
        indexEnabled: true,
        sessions: [
          {
            id: "first",
            workspace_id: "workspace",
            agent: "claude-code",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
        workspaces: [{ id: "workspace", name: "Project", path: "/tmp/project" }],
      };
    if (operation === "events")
      return {
        events: [
          {
            id: "history-first",
            kind: "agent-message",
            content: "Saved session history",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      };
    if (operation === "live")
      return { sessionId: "first", status: "idle", revision: 1, approvals: [], questions: [] };
    return { available: false };
  });
  const bridge: ConversationClientBridge = {
    request: async <Result,>(path: string, body?: unknown) => (await request(path, body)) as Result,
    stream: () => () => {},
    uploadAttachment: vi.fn(),
  };
  return {
    host,
    logout,
    request,
    client: new WebClient(undefined, { type: "same-origin" }, bridge),
  };
}

function AccessShell() {
  const { access, sessions, selected, choose } = useSession();
  useEffect(() => {
    if (access?.status === "approved" && sessions.length && !selected) void choose("first");
  }, [access?.status, sessions.length, selected, choose]);
  // This is the same authorization boundary used by SessionShell.
  return access?.status === "approved" ? <SessionWorkspace /> : <p>Pair again</p>;
}

async function start(locale: Locale = "en-US", readOnly = false) {
  const fixture = hostFixture(readOnly);
  const view = render(
    <SessionProvider client={fixture.client} embedded initialLocale={locale}>
      <AccessShell />
    </SessionProvider>,
  );
  await screen.findByText("Saved session history");
  const draft = screen.getByRole("textbox", { name: "Unsent draft" });
  fireEvent.change(draft, { target: { value: "Keep this unfinished message" } });
  return { ...fixture, view, draft };
}

function open(locale: Locale = "en-US") {
  const trigger = screen.getByRole("button", { name: dictionaries[locale].logout });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: sessionAccessCopy[locale].title }) };
}

beforeEach(() => {
  layout.mounts = 0;
  layout.navigate.mockReset();
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  {
    locale: "zh-CN",
    title: "结束此浏览器的访问？",
    cancel: "保留访问",
    description: "结束后，此浏览器需要重新配对才能再次访问这台电脑。",
  },
  {
    locale: "zh-Hant",
    title: "結束此瀏覽器的存取？",
    cancel: "保留存取",
    description: "結束後，此瀏覽器需要重新配對才能再次存取這台電腦。",
  },
  {
    locale: "en-US",
    title: "End access for this browser?",
    cancel: "Keep access",
    description: "This browser will need to pair again to access this computer afterward.",
  },
  {
    locale: "ja-JP",
    title: "このブラウザーのアクセスを終了しますか？",
    cancel: "アクセスを維持",
    description: "終了後、このコンピューターに再びアクセスするには再ペアリングが必要です。",
  },
] as const)(
  "confirms the consequence in $locale and initially focuses the safe cancellation action",
  async ({ locale, title, cancel, description }) => {
    const fixture = await start(locale);
    const { trigger, dialog } = open(locale);
    expect(dialog).toHaveAccessibleName(title);
    expect(dialog).toHaveAccessibleDescription(description);
    const keep = within(dialog).getByRole("button", { name: cancel });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(fixture.logout).not.toHaveBeenCalled();
    fireEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fixture.draft).toHaveValue("Keep this unfinished message");
    expect(screen.getByText("Saved session history")).toBeVisible();
    expect(layout.mounts).toBe(1);
    expect(fixture.logout).not.toHaveBeenCalled();
    expect(layout.navigate).not.toHaveBeenCalled();
  },
);

it("treats Escape as cancellation without ending access or remounting the current session", async () => {
  const fixture = await start();
  const { trigger, dialog } = open();
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Keep access" })).toHaveFocus(),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(fixture.logout).not.toHaveBeenCalled();
  expect(fixture.host.approved).toBe(true);
  expect(fixture.draft).toHaveValue("Keep this unfinished message");
  expect(screen.getByText("Saved session history")).toBeVisible();
  expect(layout.mounts).toBe(1);
});

it("sends one logout only after confirmation and leaves successful access cleanup to the controller", async () => {
  const fixture = await start();
  const { dialog } = open();
  expect(fixture.logout).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "End access" }));
  await screen.findByText("Pair again");
  expect(fixture.request.mock.calls.filter(([path]) => path === "logout")).toEqual([
    ["logout", {}],
  ]);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByText("Saved session history")).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Unsent draft" })).not.toBeInTheDocument();
  expect(
    fixture.request.mock.calls.filter(([path, body]) => body !== undefined && path !== "logout"),
  ).toEqual([]);
});

it("blocks duplicate confirmation and dismissal while logout is pending, then preserves content after a failure", async () => {
  const fixture = await start();
  let fail!: (reason: unknown) => void;
  fixture.logout.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
  );
  const { dialog } = open();
  const confirm = within(dialog).getByRole("button", { name: "End access" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(fixture.logout).toHaveBeenCalledTimes(1);
  expect(dialog).toHaveAttribute("aria-busy", "true");
  expect(within(dialog).getByRole("button", { name: "Ending access…" })).toBeDisabled();
  const keep = within(dialog).getByRole("button", { name: "Keep access" });
  expect(keep).toBeDisabled();
  fireEvent.click(keep);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBe(dialog);
  await act(async () => fail(new Error("connection failed")));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Access has not been confirmed as ended",
  );
  expect(within(dialog).getByRole("button", { name: "End access" })).toBeEnabled();
  expect(keep).toBeEnabled();
  expect(fixture.draft).toHaveValue("Keep this unfinished message");
  expect(screen.getByText("Saved session history")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "End access" }));
  await screen.findByText("Pair again");
  expect(fixture.logout).toHaveBeenCalledTimes(2);
});

it("does not infer logout success from a resolved post when access remains approved", async () => {
  const fixture = await start();
  fixture.host.endOnLogout = false;
  const { dialog, trigger } = open();
  fireEvent.click(within(dialog).getByRole("button", { name: "End access" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    sessionAccessCopy["en-US"].failed,
  );
  expect(fixture.host.approved).toBe(true);
  expect(fixture.draft).toHaveValue("Keep this unfinished message");
  expect(screen.getByText("Saved session history")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep access" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  const reopened = open().dialog;
  expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  fixture.host.endOnLogout = true;
  fireEvent.click(within(reopened).getByRole("button", { name: "End access" }));
  await screen.findByText("Pair again");
  expect(fixture.logout).toHaveBeenCalledTimes(2);
});

it("allows ending read-only access through the same logout path without granting control", async () => {
  const fixture = await start("en-US", true);
  expect(screen.queryByRole("button", { name: "Files & artifacts" })).not.toBeInTheDocument();
  fireEvent.click(within(open().dialog).getByRole("button", { name: "End access" }));
  await screen.findByText("Pair again");
  expect(fixture.request.mock.calls.filter(([_path, body]) => body !== undefined)).toEqual([
    ["logout", {}],
  ]);
});

it("does not refresh or reopen a workspace after it is unmounted during logout", async () => {
  const fixture = await start();
  let finish!: () => void;
  fixture.logout.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(within(open().dialog).getByRole("button", { name: "End access" }));
  fixture.view.unmount();
  const readsBefore = fixture.request.mock.calls.filter(([path]) => path === "access").length;
  await act(async () => finish());
  expect(fixture.request.mock.calls.filter(([path]) => path === "access")).toHaveLength(
    readsBefore,
  );
  expect(fixture.logout).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
