import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, ConversationSessionSummary, Live } from "@agentkib/web-client";
import { homeSessionCopy, interactionCardCopy, readStateCopy } from "@agentkib/session-ui";
import { dictionaries } from "@/features/conversation/i18n";
import { publishSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import {
  pendingScope,
  readPending,
  rememberPending,
} from "@/features/conversation/features/sessions/pending-controls";
import { HomeAttentionProvider } from "./home-attention";
import { HomeViewContext, SessionHome } from "./session-home";

const fixture = vi.hoisted(() => ({
  navigate: vi.fn(),
  session: undefined as unknown as Record<string, unknown>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => fixture.navigate }));
vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: () => fixture.session,
}));
vi.mock("../new-session/new-session-composer", () => ({
  NewSessionComposer: ({ disabled }: { disabled?: boolean }) => (
    <section aria-label="composer" data-disabled={disabled || undefined} />
  ),
}));

const home = homeSessionCopy("en-US");
const card = interactionCardCopy("en-US");
const approval: Approval = {
  requestId: 42,
  turnId: "turn",
  method: "item/commandExecution/requestApproval",
  command: "pnpm test",
  cwd: "/demo/northstar-api",
  availableDecisions: ["accept", "decline"],
  supported: true,
};
const waiting: Live = {
  sessionId: "login",
  status: "waiting-approval",
  revision: 5,
  sendEnabled: false,
  approvals: [approval],
  questions: [],
  executionMode: "codex-managed",
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function session(
  id: string,
  title: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  return {
    id,
    workspace_id: "north",
    agent: "codex",
    title,
    updated_at: minutesAgo(30),
    archived: false,
    sidechain: false,
    availability: "readable",
    ...extra,
  };
}
const unread = (outcome: "completed" | "failed"): ConversationSessionSummary["readState"] => ({
  source: "agentkib",
  status: "unread",
  freshness: "current",
  version: "1",
  firstUnread: { type: "result", resultId: "r", turnId: "t" },
  latestResult: { id: "r", turnId: "t", itemId: null, outcome, completedAt: null },
});
const sessions = [
  session("login", "Fix the login timeout", {
    updated_at: minutesAgo(2),
    continuation: { status: "awaiting-approval" },
  }),
  session("retry", "Check the nightly retries", {
    updated_at: minutesAgo(12),
    readState: unread("completed"),
  }),
  session("canvas", "Refactor the canvas drag", {
    updated_at: minutesAgo(4),
    continuation: { status: "running", executionLocation: "terminal" },
  }),
  session("a11y", "Check button accessibility", { updated_at: minutesAgo(60) }),
  session("routes", "Map the routes", { agent: "claude-code", updated_at: minutesAgo(1500) }),
  session("tests", "Add regression tests", { updated_at: minutesAgo(3000) }),
  session("older", "Older work", { updated_at: minutesAgo(5000) }),
];

function client() {
  return {
    live: vi.fn(async () => waiting),
    request: vi.fn(async () => ({ accepted: true })),
    access: vi.fn(async () => fixture.session.access),
    receipt: vi.fn(async (requestId: string) => ({ found: false, requestId })),
  };
}
function setup({
  wide = true,
  device = { send: true, manage: true },
  error,
  list = sessions,
}: {
  wide?: boolean;
  device?: { send: boolean; manage: boolean };
  error?: string;
  list?: ConversationSessionSummary[];
} = {}) {
  const fake = client();
  window.matchMedia = vi.fn(() => ({
    matches: wide,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  fixture.session = {
    t: dictionaries["en-US"],
    locale: "en-US",
    sessions: list,
    workspaces: [{ id: "north", name: "northstar-api", path: "/demo/northstar-api" }],
    access: {
      status: "approved",
      csrfToken: "csrf",
      bootId: "boot",
      protocolVersion: 2,
      experimentalEnabled: true,
      device: { id: "browser", name: "Browser", approve: true, ...device },
    },
    origin: "http://127.0.0.1:1423",
    client: fake,
    indexEnabled: true,
    catalogStatus: "ready",
    error,
    choose: vi.fn(),
    refresh: vi.fn(),
  };
  const showAll = vi.fn();
  render(
    <HomeAttentionProvider>
      <HomeViewContext value={{ showAll }}>
        <SessionHome />
      </HomeViewContext>
    </HomeAttentionProvider>,
  );
  return { fake, showAll };
}
const row = (name: RegExp) => screen.getByRole("button", { name });

describe("Web home", () => {
  beforeEach(() => {
    sessionStorage.clear();
    fixture.navigate.mockReset();
  });
  afterEach(cleanup);

  it("starts with the composer and the three groups on a wide screen, without recent sessions", () => {
    setup();
    expect(screen.getByRole("region", { name: "composer" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: home.needsYou })).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: readStateCopy("en-US").pending }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: home.inProgress })).toBeInTheDocument();
    expect(row(/Fix the login timeout/)).toHaveTextContent("Codex · northstar-api · 2 minutes ago");
    expect(row(/Fix the login timeout/)).toHaveTextContent(card.waitingApproval);
    expect(screen.queryByText(home.recentSessions)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check button accessibility/ })).toBeNull();
  });

  it("hides the composer from a visit that cannot send", () => {
    setup({ device: { send: false, manage: true } });
    expect(screen.queryByRole("region", { name: "composer" })).not.toBeInTheDocument();
  });

  it("puts the state first on the second line at phone width and lists three recent sessions", () => {
    const { showAll } = setup({ wide: false });
    expect(screen.queryByRole("region", { name: "composer" })).not.toBeInTheDocument();
    expect(row(/Fix the login timeout/)).toHaveTextContent(
      `Fix the login timeout${card.waitingApproval} · Codex · northstar-api`,
    );
    expect(row(/Check the nightly retries/)).toHaveTextContent(
      `${readStateCopy("en-US").completed} · Codex · 12 minutes ago`,
    );
    const recent = screen.getByRole("region", { name: home.recentSessions });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(3);
    expect(within(recent).queryByText("Older work")).toBeNull();
    fireEvent.click(within(recent).getByRole("button", { name: home.allSessions }));
    expect(showAll).toHaveBeenCalledOnce();
  });

  it("is all caught up when nothing waits, runs or is unread", () => {
    setup({ list: sessions.slice(3) });
    expect(screen.getByRole("heading", { name: home.allClear })).toBeInTheDocument();
    expect(screen.getByText(home.allClearHint)).toBeInTheDocument();
  });

  it("answers an approval in its row through the shared checks and drops the row", async () => {
    const { fake } = setup();
    fake.live.mockResolvedValueOnce(waiting).mockResolvedValueOnce(waiting);
    fake.live.mockResolvedValue({ ...waiting, revision: 6, approvals: [] });
    fireEvent.click(row(/Fix the login timeout/));
    const region = await screen.findByRole("region", { name: card.waitingApproval });
    expect(region).toHaveTextContent("pnpm test");
    fireEvent.click(within(region).getByRole("button", { name: /Allow once/ }));
    await waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith("approve", {
        sessionId: "login",
        bootId: "boot",
        expectedRevision: 5,
        requestId: expect.any(String),
        turnId: "turn",
        approvalId: 42,
        decision: "accept",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Fix the login timeout/ })).toBeNull(),
    );
    expect(readPending(pendingScope("http://127.0.0.1:1423", "browser"))).toEqual([]);
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("never sends again when the outcome is unknown and lists the session to verify", async () => {
    const { fake } = setup();
    fake.request.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(row(/Fix the login timeout/));
    const region = await screen.findByRole("region", { name: card.waitingApproval });
    fireEvent.click(within(region).getByRole("button", { name: /Allow once/ }));
    await waitFor(() => expect(row(/Fix the login timeout/)).toHaveTextContent(home.verifyResult));
    expect(fake.request).toHaveBeenCalledOnce();
    expect(row(/Fix the login timeout/)).not.toHaveAttribute("aria-expanded");
    fireEvent.click(row(/Fix the login timeout/));
    expect(fixture.navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "login" },
    });
  });

  it("settles a kept decision once the host's receipt says it ran", async () => {
    const scope = pendingScope("http://127.0.0.1:1423", "browser");
    const requestId = "00000000-0000-4000-8000-000000000001";
    rememberPending(scope, { requestId, sessionId: "login", kind: "approve" });
    const { fake } = setup();
    expect(row(/Fix the login timeout/)).toHaveTextContent(home.verifyResult);
    fake.receipt.mockResolvedValue({
      found: true,
      requestId,
      sessionId: "login",
      operation: "approve",
      status: "accepted",
      completionObserved: false,
    } as never);
    await act(async () => publishSessionInvalidation(fake, "login", ["receipts"]));
    await waitFor(() =>
      expect(row(/Fix the login timeout/)).toHaveTextContent(card.waitingApproval),
    );
    expect(readPending(scope)).toEqual([]);
  });

  it("keeps the lists readable while disconnected, without answering or starting sessions", async () => {
    const { fake } = setup({ error: "Connection lost" });
    expect(screen.getByRole("region", { name: "composer" })).toHaveAttribute("data-disabled");
    fireEvent.click(row(/Fix the login timeout/));
    const region = await screen.findByRole("region", { name: card.waitingApproval });
    expect(screen.getByText(home.disconnected)).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: /Allow once/ })).toBeDisabled();
    expect(fake.request).not.toHaveBeenCalled();
  });
});
