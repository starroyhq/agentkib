// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { ConversationWindowTools } from "./conversation-window-tools";
import type { SessionController } from "./conversation/desktop-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
}));

vi.mock("./conversation/desktop-session-context", () => ({
  useSession: () => doubles.session as SessionController,
}));

function mountToolbar() {
  const host = document.createElement("div");
  host.dataset.sessionWindowSession = "session";
  const status = document.createElement("div");
  status.dataset.sessionWindowStatusSlot = "";
  host.appendChild(status);
  document.body.appendChild(host);
  return { host, status };
}

describe("ConversationWindowTools connection status indicator", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = mountToolbar().host;
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "claude-code" } as SessionController["current"],
      locale: "zh-CN",
      t: { error: "连接失败", retry: "重试" } as SessionController["t"],
      online: true,
      error: undefined,
      streamReconnecting: false,
      controlReady: true,
      live: {
        sessionId: "session",
        revision: 1,
        status: "idle",
        sendEnabled: true,
        approvals: [],
        questions: [],
      },
      refresh: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    host.remove();
    vi.restoreAllMocks();
  });

  it("renders a green healthy dot when the session connection is normal", () => {
    render(
      <ConversationWindowTools
        filesOpen={false}
        onFilesOpenChange={vi.fn()}
        onStatusInToolbarChange={vi.fn()}
      />,
    );
    const dot = host.querySelector<HTMLElement>("[data-connection-tone]");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("data-connection-tone", "healthy");
    expect(dot?.className).toContain("bg-[var(--green)]");
  });

  it("renders a warning dot when the session outcome is uncertain", () => {
    doubles.session.live = {
      ...doubles.session.live!,
      status: "outcome-unknown",
      sendEnabled: false,
      reason: "control-outcome-unconfirmed",
    };
    render(
      <ConversationWindowTools
        filesOpen={false}
        onFilesOpenChange={vi.fn()}
        onStatusInToolbarChange={vi.fn()}
      />,
    );
    const dot = host.querySelector<HTMLElement>("[data-connection-tone]");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("data-connection-tone", "warning");
    expect(dot?.className).toContain("bg-warning");
  });

  it("renders a red error dot when the session connection is offline", () => {
    doubles.session.online = false;
    doubles.session.error = true;
    render(
      <ConversationWindowTools
        filesOpen={false}
        onFilesOpenChange={vi.fn()}
        onStatusInToolbarChange={vi.fn()}
      />,
    );
    const dot = host.querySelector<HTMLElement>("[data-connection-tone]");
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute("data-connection-tone", "error");
    expect(dot?.className).toContain("bg-destructive-icon");
    expect(screen.getByRole("button", { name: "已断线" })).toBeInTheDocument();
  });
});
