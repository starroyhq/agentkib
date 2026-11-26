import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { homeSessionCopy, SessionPlatformProvider } from "@agentkib/session-ui";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { dictionaries } from "@/features/conversation/i18n";
import { sessionCopyForSurface } from "@/features/conversation/session-copy";
import { webSessionPlatform } from "@/features/conversation/session-platform";
import { SessionHome } from "./home/session-home";
import { SessionWorkspace } from "./session-workspace";

const fixture = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: "/sessions" }),
  useNavigate: () => fixture.navigate,
  Outlet: () => <SessionHome />,
}));
vi.mock("@/features/conversation/web-session-context", () => ({
  useSession: () => fixture.session,
}));
vi.mock("./home/use-media-query", () => ({ useMediaQuery: () => true }));

const copy = sessionCopyForSurface("en-US", "web");
const home = homeSessionCopy("en-US");
const workspace = { id: "work", name: "Workspace", path: "/demo/workspace" };
const rows: ConversationSessionSummary[] = [
  { id: "newer", title: "Newer session", updated_at: "2026-11-24T12:00:00Z" },
  { id: "older", title: "Older session", updated_at: "2026-11-24T10:00:00Z" },
].map((row) => ({
  ...row,
  workspace_id: workspace.id,
  agent: "claude-code",
  archived: false,
  sidechain: false,
  availability: "readable",
  pinned: false,
  pinningAvailable: true,
  continuation: { status: "running" },
}));

function setup(organize: boolean) {
  let hostRows = rows;
  const setSessionPinned = vi.fn(async (id: string, pinned: boolean) => {
    hostRows = hostRows.map((session) => (session.id === id ? { ...session, pinned } : session));
    return { pinned };
  });
  const client = {
    setSessionPinned,
    sessionCapabilities: vi.fn(async (id: string) => ({
      sessionId: id,
      features: { rename: { available: true } },
    })),
  };
  const refresh = vi.fn();
  const choose = vi.fn();
  function Workspace() {
    const [sessions, setSessions] = useState(hostRows);
    fixture.session = {
      t: dictionaries["en-US"],
      locale: "en-US",
      origin: "http://127.0.0.1:1423",
      client,
      selected: "",
      online: true,
      access: {
        status: "approved",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "pin-test", name: "Paired browser", read: true, organize },
      },
      sessions,
      workspaces: [workspace],
      pendingSessions: {},
      excludedSessionIds: new Set(),
      indexEnabled: true,
      choose,
      refresh: (force: boolean) => {
        refresh(force);
        setSessions(hostRows);
      },
    };
    return (
      <SessionPlatformProvider platform={webSessionPlatform}>
        <SessionWorkspace />
      </SessionPlatformProvider>
    );
  }
  render(<Workspace />);
  return { client, refresh, choose };
}

const directory = () => screen.getByRole("region", { name: workspace.name });
const running = () => screen.getByRole("region", { name: home.inProgress });
const sessionRows = (group: HTMLElement) =>
  within(group).getAllByRole("button", { name: /(?:Older|Newer) session/ });
const rowMenu = (group: HTMLElement) =>
  within(group).getByRole("button", { name: copy.rowMenu, description: "Older session" });

afterEach(() => {
  cleanup();
  fixture.navigate.mockClear();
});

describe("session pins in the paired Web app", () => {
  it("pins from the directory and unpins from Home, refreshing both lists without opening a session", async () => {
    const { client, refresh, choose } = setup(true);
    const user = userEvent.setup();
    expect(sessionRows(directory())[0]).toHaveTextContent("Newer session");
    expect(sessionRows(running())[0]).toHaveTextContent("Newer session");

    await user.click(rowMenu(directory()));
    await user.click(await screen.findByRole("menuitem", { name: "Pin session" }));
    expect(client.setSessionPinned).toHaveBeenCalledExactlyOnceWith("older", true);
    await waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith(true));
    for (const group of [directory(), running()]) {
      const row = sessionRows(group)[0];
      expect(row).toHaveTextContent("Older session");
      expect(within(row).getByRole("img", { name: "Pinned" })).toBeVisible();
    }

    await user.click(rowMenu(running()));
    expect(screen.queryByRole("menuitem", { name: copy.rename })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: "Unpin session" }));
    expect(client.setSessionPinned).toHaveBeenLastCalledWith("older", false);
    await waitFor(() => expect(refresh.mock.calls).toEqual([[true], [true]]));
    expect(sessionRows(directory())[0]).toHaveTextContent("Newer session");
    expect(sessionRows(running())[0]).toHaveTextContent("Newer session");
    expect(screen.queryByRole("img", { name: "Pinned" })).not.toBeInTheDocument();
    expect(choose).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("disables pinning and the directory's management actions without organize permission", async () => {
    const { client, refresh } = setup(false);
    const user = userEvent.setup();
    for (const [group, managementMenu] of [
      [directory(), true],
      [running(), false],
    ] as const) {
      await user.click(rowMenu(group));
      const pin = await screen.findByRole("menuitem", { name: "Pin session" });
      expect(pin).toHaveAttribute("aria-disabled", "true");
      const rename = screen.queryByRole("menuitem", { name: copy.rename });
      if (managementMenu) expect(rename).toHaveAttribute("aria-disabled", "true");
      else expect(rename).not.toBeInTheDocument();
      await user.click(pin);
      await user.keyboard("{Escape}");
    }
    expect(client.sessionCapabilities).not.toHaveBeenCalled();
    expect(client.setSessionPinned).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
