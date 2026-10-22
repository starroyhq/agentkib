import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { dictionaries } from "@/features/conversation/i18n";
import { SessionReader } from "@/features/conversation/features/sessions/session-reader";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";
import {
  claudeConnectionCopy,
  claudeConnectionReason,
} from "@/features/conversation/features/sessions/claude-connection-copy";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";

vi.mock("@/features/conversation/features/sessions/session-context", () => ({
  useSession: vi.fn(),
}));
vi.mock("@/features/conversation/features/sessions/session-operations", () => ({
  SessionOperations: () => null,
}));
vi.mock("@/features/conversation/features/sessions/artifact-browser", () => ({
  ArtifactBrowser: () => null,
}));

let state: ReturnType<typeof useSession>;
function message(id: string, content: string): ConversationEvent {
  return { id, content, kind: "agent-message", attachment_count: 0, truncated: false };
}
const latest = webLayoutCopy["zh-CN"].newMessages;

beforeEach(() => {
  state = {
    selected: "first",
    liveContentVersion: 0,
    access: { protocolVersion: 2, experimentalEnabled: false },
    current: { id: "first", agent: "codex" },
    t: dictionaries["zh-CN"],
    locale: "zh-CN",
    page: { events: [message("tail", "First answer")], warnings: [], next_cursor: "older" },
    scroll: { current: null },
    earlier: vi.fn(),
    setModal: vi.fn(),
  } as unknown as ReturnType<typeof useSession>;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

function viewport(height = 1200) {
  const node = state.scroll.current!;
  Object.defineProperties(node, {
    scrollHeight: { value: height, configurable: true },
    clientHeight: { value: 300, configurable: true },
  });
  return node;
}
function moveTo(top: number) {
  const node = viewport();
  node.scrollTop = top;
  fireEvent.scroll(node);
  return node;
}

describe("conversation reading position", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "renders authenticated reconnect failures in %s and clears the prior reason",
    (locale) => {
      state = {
        ...state,
        locale,
        t: dictionaries[locale],
        online: true,
        controlReady: true,
        canSend: false,
        canStop: false,
        busy: false,
        message: "",
        setMessage: vi.fn(),
        control: vi.fn(),
        access: {
          ...state.access!,
          status: "approved",
          experimentalEnabled: true,
          device: {
            id: "device",
            name: "Test browser",
            accessMode: "full",
            send: true,
            approve: false,
            advancedControl: false,
          },
        },
        current: { ...state.current!, agent: "claude-code" },
        capabilities: {
          sessionId: "first",
          executionMode: "claude-follower",
          status: "unsupported",
          features: { send: { available: false } },
        },
        live: {
          sessionId: "first",
          status: "unsupported",
          revision: 1,
          approvals: [],
          executionMode: "claude-follower",
          executionLocation: null,
          sendEnabled: false,
          stopEnabled: false,
          terminalSend: false,
        },
      };
      const view = render(<SessionReader />);
      for (const reason of [
        "bridge-cli-too-old",
        "bridge-cli-unsupported",
        "bridge-capabilities-missing",
        "bridge-plugin-update-required",
      ]) {
        const failure = { reason, cliVersion: "2.1.300" };
        state.live = { ...state.live!, reason, bridgeConnectionFailure: failure };
        view.rerender(<SessionReader />);
        const text = claudeConnectionReason(locale, reason, "desktop", failure)!;
        expect(screen.getAllByText(text)[0]).toBeVisible();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.queryByRole("button", { name: state.t.send })).toBeNull();
        expect(screen.queryByRole("button", { name: state.t.stop })).toBeNull();
        state.live = { ...state.live!, bridgeConnectionFailure: null };
        view.rerender(<SessionReader />);
        expect(screen.queryByText(text)).toBeNull();
        state.live = { ...state.live!, reason: "claude-bridge-disconnected" };
      }
    },
  );
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "keeps unverified native version details out of the session page in %s without enabling controls",
    (locale) => {
      state = {
        ...state,
        locale,
        t: dictionaries[locale],
        online: true,
        current: { ...state.current!, agent: "claude-code" },
        live: {
          sessionId: "first",
          status: "idle",
          revision: 1,
          approvals: [],
          executionMode: "claude-follower",
          sendEnabled: false,
          stopEnabled: false,
          terminalSend: false,
          reason: "claude-follower-send-unverified",
          bridgeCompatibility: { cliVersion: "2.1.307", status: "unverified" },
        },
      };
      const view = render(<SessionReader />);
      const text = claudeConnectionCopy[locale].unverifiedVersion.replace("{version}", "2.1.307");
      expect(screen.queryByText(text)).toBeNull();
      expect(view.container.querySelector("[data-terminal-compatibility]")).toBeNull();
      expect(screen.getByText("First answer")).toBeVisible();
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      state.live = { ...state.live!, bridgeCompatibility: null };
      view.rerender(<SessionReader />);
      expect(view.container.querySelector("[data-terminal-compatibility]")).toBeNull();
      state.live = {
        ...state.live!,
        bridgeCompatibility: { cliVersion: "2.1.301", status: "verified" },
      };
      view.rerender(<SessionReader />);
      expect(view.container.querySelector("[data-terminal-compatibility]")).toBeNull();
      state.live = {
        ...state.live!,
        executionMode: "claude-managed",
        bridgeCompatibility: { cliVersion: "2.1.307", status: "unverified" },
      };
      view.rerender(<SessionReader />);
      expect(view.container.querySelector("[data-terminal-compatibility]")).toBeNull();
    },
  );

  it("anchors a pending user before a reply that arrives ahead of native persistence", () => {
    state.pendingSend = { sessionId: "first", text: "next question", afterEventId: "tail" };
    state.page!.events.push(message("new-answer", "New answer"));
    const view = render(<SessionReader />);
    const roles = [...view.container.querySelectorAll("[data-message-role]")];
    expect(roles.map((node) => node.textContent)).toEqual([
      "First answer",
      "next question",
      "New answer",
    ]);
  });

  it("keeps a repeated pending prompt until its native user arrives after the anchor", () => {
    state.page!.events = [
      { ...message("old-user", "repeat"), kind: "user-message" },
      message("anchor", "old reply"),
      message("reply", "new reply"),
    ];
    state.pendingSend = { sessionId: "first", text: "repeat", afterEventId: "anchor" };
    const view = render(<SessionReader />);
    expect(view.container.querySelectorAll('[data-message-role="user"]')).toHaveLength(2);
    const nativeUser = { ...message("new-user", "repeat"), kind: "user-message" as const };
    state.page = {
      ...state.page!,
      events: [state.page!.events[0], state.page!.events[1], nativeUser, state.page!.events[2]],
    };
    view.rerender(<SessionReader />);
    expect(view.container.querySelectorAll('[data-message-role="user"]')).toHaveLength(2);
    expect(view.container.querySelector('[data-event-id="session-pending:user"]')).toBeNull();
  });

  it("places an empty-history pending user before the live stream fallback", () => {
    state.page = { events: [], warnings: [] };
    state.pendingSend = { sessionId: "first", text: "question" };
    state.live = {
      sessionId: "first",
      status: "running",
      revision: 1,
      sendEnabled: false,
      turnId: "turn",
      streamText: "answer",
      approvals: [],
    };
    const view = render(<SessionReader />);
    const roles = [...view.container.querySelectorAll("[data-message-role]")].map((node) =>
      node.getAttribute("data-message-role"),
    );
    expect(roles).toEqual(["user", "assistant"]);
  });
  it.each(["native-model-unconfirmed", "native-effort-unconfirmed"] as const)(
    "shows the source-settings recovery instruction for %s even without a composer",
    (reason) => {
      state = { ...state, notice: "notDispatched", noticeReason: reason };
      render(<SessionReader />);
      expect(screen.getByText(codexReason("zh-CN", reason).text)).toBeVisible();
      expect(screen.queryByText(dictionaries["zh-CN"].notDispatched)).not.toBeInTheDocument();
    },
  );
  it("does not repeat the generic rejection beside Codex settings recovery", () => {
    state = { ...state, notice: "notDispatched", noticeReason: "unsupported-model" };
    const view = render(<SessionReader />);
    expect(screen.queryByText(dictionaries["zh-CN"].notDispatched)).not.toBeInTheDocument();
    state = { ...state, noticeReason: undefined };
    view.rerender(<SessionReader />);
    expect(screen.getByText(dictionaries["zh-CN"].notDispatched)).toBeVisible();
  });

  it("uses the same live usage gauge for an ACP composer without settings", () => {
    state = {
      ...state,
      online: true,
      busy: false,
      canSend: true,
      canStop: false,
      message: "hello",
      setMessage: vi.fn(),
      control: vi.fn(),
      current: { ...state.current!, agent: "antigravity" },
      access: {
        ...state.access!,
        experimentalEnabled: true,
        device: {
          id: "device",
          name: "Test browser",
          approve: false,
          send: true,
          accessMode: "full",
          advancedControl: true,
        },
      },
      live: {
        sessionId: "first",
        status: "idle",
        revision: 1,
        sendEnabled: true,
        approvals: [],
        usage: { available: true, state: "ready", reportId: 1, usedTokens: 0, contextWindow: 100 },
      },
    };
    const view = render(<SessionReader />);
    expect(screen.getByRole("button", { name: "上下文用量" })).toHaveTextContent("0%");
    state.live = { ...state.live!, activity: "compacting" };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: state.t.send })).toBeDisabled();
    fireEvent.submit(screen.getByRole("button", { name: state.t.send }).closest("form")!);
    expect(state.control).not.toHaveBeenCalled();
    state = {
      ...state,
      access: { ...state.access!, device: { ...state.access!.device!, send: false } },
      live: {
        ...state.live!,
        activity: null,
        usage: { available: true, state: "ready", reportId: 2, usedTokens: 5, contextWindow: 100 },
      },
    };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: "上下文用量" })).toHaveTextContent("5%");
    expect(screen.queryByRole("button", { name: state.t.send })).not.toBeInTheDocument();
  });
  it("keeps the reading position and offers an accessible jump for an appended reply", () => {
    const view = render(<SessionReader />);
    const node = moveTo(250);
    state = {
      ...state,
      page: { ...state.page!, events: [...state.page!.events, message("new", "New answer")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(250);
    const jump = screen.getByRole("button", { name: latest });
    expect(jump.closest('[role="status"]')).not.toBeNull();
    jump.focus();
    expect(jump).toHaveFocus();
    fireEvent.click(jump);
    expect(node.scrollTop).toBe(node.scrollHeight);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    state = {
      ...state,
      page: { ...state.page!, events: [...state.page!.events, message("newer", "Next answer")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    viewport(1500);
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(1500);
  });

  it("does not report earlier pages or replay of the same tail as new messages", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    fireEvent.click(screen.getByRole("button", { name: dictionaries["zh-CN"].earlier }));
    expect(state.earlier).toHaveBeenCalledOnce();
    state = {
      ...state,
      page: {
        ...state.page!,
        events: [message("older", "Old answer"), message("tail", "First answer")],
      },
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(100);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
  });

  it("notifies once for incremental text and clears the notice near the bottom", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getAllByRole("button", { name: latest })).toHaveLength(1);
    expect(node.scrollTop).toBe(100);
    node.scrollTop = 850;
    fireEvent.scroll(node);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    viewport(1400);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues again")] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(node.scrollTop).toBe(1400);
  });

  it("notifies for a text delta even when another tool follows that message", () => {
    const tool: ConversationEvent = {
      ...message("tool", ""),
      kind: "tool-summary",
      tool_name: "shell",
    };
    state = { ...state, page: { ...state.page!, events: [...state.page!.events, tool] } };
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      page: { ...state.page!, events: [message("tail", "First answer continues"), tool] },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: latest })).toBeVisible();
    expect(node.scrollTop).toBe(100);
  });

  it("handles fallback streaming and resets following when switching conversations", () => {
    const view = render(<SessionReader />);
    const node = moveTo(100);
    state = {
      ...state,
      live: {
        sessionId: "first",
        status: "running",
        revision: 1,
        sendEnabled: false,
        approvals: [],
        streamText: "Live answer",
      },
      liveContentVersion: state.liveContentVersion + 1,
    };
    view.rerender(<SessionReader />);
    expect(screen.getByRole("button", { name: latest })).toBeVisible();
    expect(node.scrollTop).toBe(100);
    state = {
      ...state,
      selected: "second",
      live: undefined,
      page: { events: [message("second-tail", "Another conversation")], warnings: [] },
    };
    view.rerender(<SessionReader />);
    expect(screen.queryByRole("button", { name: latest })).not.toBeInTheDocument();
    expect(node.scrollTop).toBe(1200);
  });
});
