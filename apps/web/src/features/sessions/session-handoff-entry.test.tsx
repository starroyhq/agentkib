// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionReader } from "@/features/conversation/features/sessions/session-reader";
import { SessionPanelsContext } from "@/features/conversation/features/sessions/session-panels";
import type { SessionController } from "@/features/conversation/features/sessions/use-session-controller";
import { dictionaries } from "@/features/conversation/i18n";
const words = dictionaries["en-US"];

let session: SessionController;
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => session,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/features/conversation/features/sessions/session-composer", () => ({
  SessionComposer: () => <p>Existing composer</p>,
}));
vi.mock("@/features/conversation/features/sessions/artifact-browser", () => ({
  ArtifactBrowser: () => null,
}));
vi.mock("@/features/conversation/components/dialog", () => ({
  Dialog: ({ title, children }: { title: string; children: ReactNode }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
function View() {
  const [actionsOpen, setActionsOpen] = useState(false);
  return (
    <SessionPanelsContext
      value={{ filesOpen: false, setFilesOpen: vi.fn(), actionsOpen, setActionsOpen }}
    >
      <button onClick={() => setActionsOpen(true)}>Open actions</button>
      <SessionReader />
    </SessionPanelsContext>
  );
}
const request = vi.fn(async (path: string) =>
  path.startsWith("managed/options")
    ? { available: true, workspaces: [], models: [] }
    : { sessionId: "session", reconciled: true },
);
beforeEach(() => {
  sessionStorage.clear();
  request.mockClear();
  session = {
    locale: "en-US",
    t: words,
    selected: "session",
    current: {
      id: "session",
      agent: "codex",
      title: "Native source",
      availability: "readable",
      archived: false,
      origin: "interactive",
    },
    access: {
      status: "approved",
      protocolVersion: 2,
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "device", name: "Device", send: true, manage: true },
    },
    live: {
      sessionId: "session",
      executionMode: "codex-follower",
      status: "idle",
      reason: "handoff-required",
      revision: 1,
      approvals: [],
      questions: [],
      sendEnabled: false,
    },
    capabilities: {
      sessionId: "session",
      status: "idle",
      executionMode: "codex-follower",
      features: {
        resume: { available: true },
        adopt: { available: false },
        send: { available: false, reason: "handoff-required" },
      },
    },
    canSend: false,
    busy: false,
    online: true,
    controlReady: true,
    page: { events: [], warnings: [] },
    liveContentVersion: 0,
    scroll: { current: null },
    client: {
      request,
      codexQueue: vi.fn(async () => ({ sessionId: "session", data: [] })),
      // A Codex session may lead workers; this one cannot.
      projectAgent: vi.fn(async () => ({ lead: null, capable: false })),
    },
    refresh: vi.fn(async () => {}),
    codexAction: vi.fn(async () => ({ accepted: true })),
    setModal: vi.fn(),
  } as unknown as SessionController;
});
afterEach(cleanup);
describe("reader handoff entries", () => {
  it("shows the composer directly and removes native resume confirmation from operations", async () => {
    session.canSend = true;
    Object.assign(session.live!, {
      executionMode: "codex-managed",
      reason: undefined,
      sendEnabled: true,
      executionLocation: null,
    });
    session.capabilities!.features.send = { available: true };
    render(<View />);
    expect(screen.getByText("Existing composer")).toBeVisible();
    expect(screen.queryByText("Resume required")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
    const dialog = await screen.findByRole("dialog", { name: "Session actions" });
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Resume execution" }),
    ).not.toBeInTheDocument();
    expect(session.codexAction).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([path]) => path === "managed/adopt")).toBe(false);
  });
  it("does not expose the old Codex handoff even when legacy capabilities advertise adoption", async () => {
    session.capabilities!.features.resume = { available: false };
    session.capabilities!.features.adopt = { available: true };
    render(<View />);
    expect(screen.getByText("Existing composer")).toBeVisible();
    expect(screen.queryByText("Handoff required")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open actions" }));
    const dialog = await screen.findByRole("dialog", { name: "Session actions" });
    expect(
      within(dialog).queryByRole("button", { name: "Hand over to AgentKib" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => path === "managed/adopt")).toBe(false);
    expect(session.codexAction).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude-code"] as const)(
    "marks a %s branch with its source title without exposing a missing source id",
    (agent) => {
      session.current!.agent = agent;
      session.current!.forked_from_session_id = "source-id";
      session.sessions = [{ ...session.current!, id: "source-id", title: "Original session" }];
      session.sourceTitle = vi.fn(() => "Original session");
      const view = render(<View />);
      expect(screen.getByText("Forked from Original session")).toBeVisible();
      session.sessions = [];
      view.rerender(<View />);
      expect(screen.queryByText(/source-id/)).not.toBeInTheDocument();
    },
  );
  it.each(["codex", "claude-code"] as const)(
    "shows an optimistic %s user message once and reconciles its persisted history",
    (agent) => {
      session.current!.agent = agent;
      session.pendingSend = { sessionId: "session", text: "Continue without a manual step" };
      const view = render(<View />);
      expect(screen.getAllByText("Continue without a manual step")).toHaveLength(1);
      session.page!.events = [
        {
          id: "persisted-user",
          kind: "user-message",
          content: "Continue without a manual step",
          attachment_count: 0,
          truncated: false,
        },
      ];
      view.rerender(<View />);
      expect(screen.getAllByText("Continue without a manual step")).toHaveLength(1);
      session.pendingSend = { sessionId: "old-session", text: "Old pending message" };
      view.rerender(<View />);
      expect(screen.queryByText("Old pending message")).not.toBeInTheDocument();
    },
  );
  it.each([
    "metadata",
    "remote",
    "unsupported",
    "permission",
    "verification",
    "uncertain",
    "compacting",
  ] as const)("does not add a misleading native resume shortcut for %s", (blocked) => {
    if (blocked === "metadata") session.current!.availability = "metadata-only";
    if (blocked === "remote") Object.assign(session.current!, { remote: { host_id: "remote" } });
    if (blocked === "unsupported") session.live!.status = "unsupported";
    if (blocked === "permission") session.access!.device!.send = false;
    if (blocked === "verification") session.capabilities!.sessionId = "previous";
    if (blocked === "uncertain") session.notice = "uncertain";
    if (blocked === "compacting") session.live!.activity = "compacting";
    render(<View />);
    expect(screen.queryByRole("button", { name: "Resume execution" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(session.codexAction).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("leaves Claude's existing strictly gated composer entry in place without adding a duplicate reader shortcut", () => {
    session.current!.agent = "claude-code";
    session.capabilities!.features.adopt = { available: true };
    session.capabilities!.features.resume = { available: false };
    render(<View />);
    expect(screen.getByText("Existing composer")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Hand over to AgentKib" })).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});
