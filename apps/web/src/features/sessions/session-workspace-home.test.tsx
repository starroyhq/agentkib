import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import { homeSessionCopy, newSessionCopy } from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";
import { codexCopyForSurface } from "@/features/conversation/features/sessions/codex-copy";
import { SessionWorkspace } from "./session-workspace";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  session: undefined as unknown as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: "/sessions" }),
  useNavigate: () => fixture.navigate,
  Outlet: () => <div data-testid="outlet" />,
}));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => fixture.session,
}));
vi.mock("@/features/conversation/features/catalog/session-catalog", () => ({
  SessionCatalog: () => null,
}));
vi.mock("./new-session/new-session-composer", () => ({
  NewSessionComposer: () => <section aria-label="composer" />,
}));

const home = homeSessionCopy("en-US");
function session(
  id: string,
  continuation?: ConversationSessionSummary["continuation"],
): ConversationSessionSummary {
  return {
    id,
    workspace_id: "north",
    agent: "codex",
    title: id,
    updated_at: "2026-11-11T10:00:00.000Z",
    archived: false,
    sidechain: false,
    availability: "readable",
    continuation,
  };
}
function setup(device: { send: boolean; manage: boolean } = { send: true, manage: true }) {
  const leaveSession = vi.fn();
  fixture.session = {
    t: dictionaries["en-US"],
    locale: "en-US",
    origin: "http://127.0.0.1:1423",
    client: {},
    selected: "",
    modal: undefined,
    live: undefined,
    access: {
      status: "approved",
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "browser", name: "My iPad", approve: true, ...device },
    },
    sessions: [
      session("approval", { status: "awaiting-approval" }),
      session("question", { status: "waiting-input" }),
      session("running", { status: "running", executionLocation: "agentkib" }),
      session("idle"),
    ],
    excludedSessionIds: new Set(),
    workspaces: [{ id: "north", name: "northstar-api", path: "/demo/northstar-api" }],
    pendingSessions: {},
    indexEnabled: true,
    setModal: vi.fn(),
    refresh: vi.fn(),
    post: vi.fn(),
    choose: vi.fn(),
    leaveSession,
  };
  render(<SessionWorkspace />);
  return { leaveSession };
}

describe("Web home in the workspace", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fixture.navigate.mockReset();
  });
  afterEach(cleanup);

  it("counts what needs the person beside Home and on the bell", () => {
    setup();
    const entry = screen.getByRole("button", { name: `${home.home} · ${home.needsYou} 2` });
    expect(entry).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("button", { name: `${codexCopyForSurface("en-US", "web").pending} (2)` }),
    ).toBeInTheDocument();
  });

  it("returns home from the AgentKib mark and from Home", () => {
    const { leaveSession } = setup();
    fireEvent.click(screen.getByRole("button", { name: `AgentKib · ${home.home}` }));
    fireEvent.click(screen.getByRole("button", { name: `${home.home} · ${home.needsYou} 2` }));
    expect(leaveSession).toHaveBeenCalledTimes(2);
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/sessions" });
  });

  it("switches between the home and all sessions at phone width", () => {
    setup();
    const directory = screen.getByRole("complementary");
    const homeTab = screen.getByRole("button", { name: home.home, pressed: true });
    expect(directory).toHaveClass("hidden");
    fireEvent.click(screen.getByRole("button", { name: home.allSessions, pressed: false }));
    expect(directory).not.toHaveClass("hidden");
    expect(homeTab).toHaveAttribute("aria-pressed", "false");
    // The authorized browser and sign-out stay with all sessions.
    expect(within(directory).getByText("My iPad")).toBeInTheDocument();
  });

  it("opens the new-session composer from + only for a visit that can send", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: newSessionCopy("en-US").newSession }));
    expect(screen.getByRole("dialog")).toContainElement(
      screen.getByRole("region", { name: "composer" }),
    );
    cleanup();
    setup({ send: false, manage: true });
    expect(
      screen.queryByRole("button", { name: newSessionCopy("en-US").newSession }),
    ).not.toBeInTheDocument();
  });
});
