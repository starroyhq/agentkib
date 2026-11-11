// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, Live } from "@agentkib/web-client";
import { homeSessionCopy, interactionCardCopy, readStateCopy } from "@agentkib/session-ui";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { HomeReplies } from "@/features/home/home-replies";
import { homeSessionGroups } from "@/features/home/home-sessions";
import { formatElapsed, MenuBarSessions } from "./menubar-sessions";
import { MenuBarRemote } from "./menubar-remote";
import type { WebAdminStatus } from "../../../electron/main/web/service";

const workspace = {
  id: "workspace",
  name: "northstar-api",
  path: "/work/northstar-api",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
} as WorkspaceSummary;

function session(
  id: string,
  title: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  return {
    id,
    workspace_id: workspace.id,
    agent: "codex",
    title,
    updated_at: "2026-11-11T10:00:00.000Z",
    archived: false,
    sidechain: false,
    availability: "readable",
    ...extra,
  };
}

const approval: Approval = {
  requestId: 42,
  turnId: "turn",
  method: "item/commandExecution/requestApproval",
  command: "pnpm test --filter auth",
  cwd: workspace.path,
  availableDecisions: ["accept", "decline"],
  supported: true,
};
const waiting: Live = {
  sessionId: "approval",
  status: "waiting-approval",
  revision: 3,
  sendEnabled: false,
  approvals: [approval],
  questions: [],
};

function replies(extra: Partial<HomeReplies> = {}) {
  const live = vi.fn(async () => waiting);
  const value: HomeReplies = {
    client: { live } as unknown as HomeReplies["client"],
    access: {
      status: "approved",
      csrfToken: "csrf",
      bootId: "boot",
      experimentalEnabled: true,
      device: { id: "desktop", name: "Desktop", send: true, approve: true },
    },
    unconfirmed: new Set(),
    answered: new Set(),
    reply: vi.fn(async () => ({ status: "accepted" as const, requestId: "r" })),
    stop: vi.fn(async () => ({ status: "accepted" as const, requestId: "s" })),
    markAnswered: vi.fn(),
    ...extra,
  };
  return { value, live };
}

const approvalSession = session("approval", "Fix the login timeout", {
  continuation: { status: "awaiting-approval" },
});
const questionSession = session("question", "Write the API docs", {
  agent: "claude-code",
  continuation: { status: "waiting-input" },
});
const runningSession = session("running", "Refactor the canvas drag", {
  continuation: { status: "running", executionLocation: "terminal" },
});
const appRunSession = session("codex-app", "Check the nightly retries", {
  externalTurn: { status: "running", startedAt: "2026-11-11T09:55:48.000Z" },
});
const doneSession = session("done", "Tidy the release notes", {
  readState: {
    source: "agentkib",
    status: "unread",
    freshness: "current",
    version: "1",
    firstUnread: { type: "result", resultId: "r", turnId: "t" },
    latestResult: { id: "r", turnId: "t", itemId: null, outcome: "completed", completedAt: null },
  },
});

function renderSessions(
  sessions: ConversationSessionSummary[],
  {
    value,
    expanded,
    now = Date.parse("2026-11-11T10:00:00.000Z"),
  }: { value?: HomeReplies; expanded?: string; now?: number } = {},
) {
  const props = { onExpand: vi.fn(), onOpen: vi.fn() };
  render(
    <MenuBarSessions
      groups={homeSessionGroups(sessions, { recent: 0 })}
      describe={(item) => ({ title: item.title ?? item.id, workspace: workspace.name })}
      replies={value}
      workspacePath={() => workspace.path}
      now={now}
      expanded={expanded}
      {...props}
    />,
  );
  return props;
}

const home = homeSessionCopy("en-US");
const card = interactionCardCopy("en-US");
const read = readStateCopy("en-US");
const group = (name: string) => screen.getByRole("region", { name });

describe("menu bar sessions", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("lists what waits, then what runs, then unread results", () => {
    renderSessions([doneSession, runningSession, questionSession, approvalSession]);
    const regions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(regions).toEqual([home.needsYou, home.inProgress, read.pending]);
    expect(within(group(home.needsYou)).getByRole("heading")).toHaveTextContent(
      `${home.needsYou}2`,
    );
    expect(
      within(group(home.needsYou)).getByRole("button", { name: /Fix the login timeout/ }),
    ).toHaveTextContent(`northstar-api · ${card.waitingApproval}`);
    expect(
      within(group(home.inProgress)).getByRole("button", { name: /Refactor the canvas drag/ }),
    ).toHaveTextContent(`northstar-api · ${tr("menubar.placeTerminal")}`);
    expect(
      within(group(read.pending)).getByRole("button", { name: /Tidy the release notes/ }),
    ).toHaveTextContent(`northstar-api · ${read.completed}`);
  });

  it("counts a running turn's time to the second", () => {
    renderSessions([appRunSession]);
    expect(
      within(group(home.inProgress)).getByRole("button", { name: /Check the nightly retries/ }),
    ).toHaveTextContent(`Codex · ${formatElapsed(4 * 60_000 + 12_000, tr)}`);
    expect(formatElapsed(4 * 60_000 + 12_000, tr)).toBe("4m 12s");
    expect(formatElapsed(42_000, tr)).toBe("42s");
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000, tr)).toBe("2h 5m");
  });

  it("answers the open approval in one click and folds once nothing waits", async () => {
    const { value, live } = replies();
    live.mockResolvedValueOnce(waiting).mockResolvedValueOnce({ ...waiting, approvals: [] });
    const props = renderSessions([approvalSession], { value, expanded: "approval" });
    expect(await screen.findByText("pnpm test --filter auth")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: card.allowOnce }));
    await waitFor(() =>
      expect(value.reply).toHaveBeenCalledWith(approvalSession, {
        kind: "approve",
        approval,
        decision: "accept",
      }),
    );
    await waitFor(() => expect(props.onExpand).toHaveBeenCalledWith(undefined));
    expect(value.markAnswered).toHaveBeenCalledWith("approval");
  });

  it("offers deny-and-stop when the request has no plain denial", async () => {
    const { value, live } = replies();
    live.mockResolvedValue({
      ...waiting,
      approvals: [{ ...approval, availableDecisions: ["accept", "cancel"] }],
    });
    renderSessions([approvalSession], { value, expanded: "approval" });
    fireEvent.click(await screen.findByRole("button", { name: card.denyAndStop }));
    await waitFor(() =>
      expect(value.reply).toHaveBeenCalledWith(
        approvalSession,
        expect.objectContaining({ decision: "cancel" }),
      ),
    );
  });

  it("opens the session for more options, a question or a result", async () => {
    const { value } = replies();
    const props = renderSessions([approvalSession, questionSession, doneSession], {
      value,
      expanded: "approval",
    });
    fireEvent.click(await screen.findByRole("button", { name: card.moreOptions }));
    fireEvent.click(screen.getByRole("button", { name: /Write the API docs/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tidy the release notes/ }));
    expect(props.onOpen.mock.calls.map(([item]) => item.id)).toEqual([
      "approval",
      "question",
      "done",
    ]);
  });

  it("folds and unfolds an approval row instead of opening it", () => {
    const { value } = replies();
    const props = renderSessions([approvalSession], { value });
    fireEvent.click(screen.getByRole("button", { name: /Fix the login timeout/ }));
    expect(props.onExpand).toHaveBeenCalledWith("approval");
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("stops a running turn from its row, which waits for the list to drop it", async () => {
    const { value } = replies();
    renderSessions([runningSession], { value });
    const stop = screen.getByRole("button", { name: tr("menubar.stop") });
    fireEvent.click(stop);
    await waitFor(() => expect(value.stop).toHaveBeenCalledWith(runningSession));
    expect(stop).toBeDisabled();
  });

  it("says when a turn cannot be stopped from here", async () => {
    const { value } = replies({ stop: vi.fn(async () => ({ status: "gone" as const })) });
    renderSessions([runningSession], { value });
    fireEvent.click(screen.getByRole("button", { name: tr("menubar.stop") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(tr("menubar.stopElsewhere"));
    expect(screen.getByRole("button", { name: tr("menubar.stop") })).toBeEnabled();
  });

  it("offers no stop for a turn another app runs", () => {
    const { value } = replies();
    renderSessions([appRunSession], { value });
    expect(screen.queryByRole("button", { name: tr("menubar.stop") })).not.toBeInTheDocument();
  });
});

function remoteStatus(
  relay: Partial<NonNullable<WebAdminStatus["config"]["relay"]>> | undefined,
  phase?: string,
) {
  return {
    running: true,
    localUrl: "http://127.0.0.1:1430",
    experimentalAvailable: true,
    pending: [],
    devices: [{ id: "phone", name: "iPhone", send: true, approve: true, createdAt: 1 }],
    config: {
      relay: relay ? { enabled: true, brokerUrl: "https://relay.example", ...relay } : undefined,
    },
    relay: phase ? { phase } : undefined,
  } as unknown as WebAdminStatus;
}

describe("menu bar remote access", () => {
  const request = vi.fn();
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    request.mockReset();
    Object.assign(window.agentkibDesktop as object, { web: { request } });
  });
  afterEach(cleanup);

  it("stays out until remote access has been set up", () => {
    const { container } = render(
      <MenuBarRemote
        status={remoteStatus(undefined)}
        onChanged={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says how remote access is doing and pauses it with the switch", async () => {
    request.mockResolvedValue({});
    const onChanged = vi.fn();
    render(
      <MenuBarRemote
        status={remoteStatus({}, "ready")}
        onChanged={onChanged}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 device/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: tr("menubar.remote") }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ operation: "relay-stop" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("resumes with the saved connection, and sends the person to the remote page when it cannot", async () => {
    request.mockRejectedValueOnce(new Error("account_login_required"));
    const onOpenSettings = vi.fn();
    render(
      <MenuBarRemote
        status={remoteStatus({ enabled: false, frpcPath: "/opt/frpc" })}
        onChanged={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: tr("menubar.remote") }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        operation: "remote-enable",
        brokerUrl: "https://relay.example",
        frpcPath: "/opt/frpc",
      }),
    );
    await waitFor(() => expect(onOpenSettings).toHaveBeenCalled());
  });
});
