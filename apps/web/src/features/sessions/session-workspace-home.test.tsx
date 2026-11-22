import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSessionSummary } from "@agentkib/web-client";
import {
  homeSessionCopy,
  interactionCardCopy,
  newSessionCopy,
  pendingScope,
  rememberPending,
  SessionPlatformProvider,
} from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";
import { codexCopyForSurface } from "@/features/conversation/features/sessions/codex-copy";
import { SessionWorkspace } from "./session-workspace";
import { webSessionPlatform } from "@/features/conversation/session-platform";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  session: undefined as unknown as Record<string, unknown>,
  pathname: "/sessions",
  wide: false,
  catalog: undefined as { reviewLane?: boolean } | undefined,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: { pathname: string }) => unknown }) =>
    select({ pathname: fixture.pathname }),
  useNavigate: () => fixture.navigate,
  Outlet: () => <div data-testid="outlet" />,
}));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => fixture.session,
}));
vi.mock("@/features/conversation/features/catalog/session-catalog", () => ({
  SessionCatalog: (props: { reviewLane?: boolean }) => {
    fixture.catalog = props;
    return null;
  },
}));
vi.mock("./home/use-media-query", () => ({ useMediaQuery: () => fixture.wide }));
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
function setup(
  device: { send: boolean; manage: boolean } = { send: true, manage: true },
  overrides?: {
    sessions: ConversationSessionSummary[];
    pendingSessions?: Record<string, boolean>;
  },
) {
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
    sessions: overrides?.sessions ?? [
      session("approval", { status: "awaiting-approval" }),
      session("question", { status: "waiting-input" }),
      session("running", { status: "running", executionLocation: "agentkib" }),
      session("idle"),
    ],
    excludedSessionIds: new Set(),
    workspaces: [{ id: "north", name: "northstar-api", path: "/demo/northstar-api" }],
    pendingSessions: overrides?.pendingSessions ?? {},
    indexEnabled: true,
    setModal: vi.fn(),
    refresh: vi.fn(),
    post: vi.fn(),
    choose: vi.fn(),
    leaveSession,
  };
  render(
    <SessionPlatformProvider platform={webSessionPlatform}>
      <SessionWorkspace />
    </SessionPlatformProvider>,
  );
  return { leaveSession };
}

describe("Web home in the workspace", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fixture.navigate.mockReset();
    fixture.pathname = "/sessions";
    fixture.wide = false;
  });
  afterEach(cleanup);

  it("counts what needs the person beside Home and on the bell", () => {
    setup();
    const entry = screen.getByRole("button", { name: `${home.home} · ${home.needsYou} 2` });
    expect(entry).toHaveAttribute("aria-current", "page");
    const copy = codexCopyForSurface("en-US", "web");
    const trigger = screen.getByRole("button", { name: `${copy.pending} (2)` });
    expect(trigger).toHaveClass("size-11");
    fireEvent.click(trigger);
    const dialog = within(screen.getByRole("dialog", { name: copy.pending }));
    const card = interactionCardCopy("en-US");
    expect(dialog.getByText(card.waitingApproval)).toBeVisible();
    expect(dialog.getByText(card.waitingAnswer)).toBeVisible();
    expect(dialog.queryByRole("button", { name: "running" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "idle" })).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "question" }));
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "question" },
    });
  });

  it("hides the bell for an empty home group even when other sessions have pending controls", () => {
    rememberPending(pendingScope("http://127.0.0.1:1423", "browser"), {
      requestId: "11111111-1111-4111-8111-111111111111",
      sessionId: "outside-home",
      kind: "stop",
    });
    setup(undefined, {
      sessions: [session("idle")],
      pendingSessions: { "outside-home": true },
    });
    const title = codexCopyForSurface("en-US", "web").pending;
    expect(screen.queryByRole("button", { name: new RegExp(title) })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: home.home, pressed: true })).toBeInTheDocument();
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

  it("leaves unread results to the home beside the directory on a wide screen", () => {
    fixture.wide = true;
    setup();
    expect(fixture.catalog?.reviewLane).toBe(false);
    cleanup();
    // Reading a session, the directory lists them again.
    fixture.pathname = "/sessions/approval";
    setup();
    expect(fixture.catalog?.reviewLane).toBe(true);
    cleanup();
    // At phone width the home and the directory take turns, so the directory keeps them.
    fixture.wide = false;
    fixture.pathname = "/sessions";
    setup();
    expect(fixture.catalog?.reviewLane).toBe(true);
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
