// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  WebClient,
  type ConversationClientBridge,
  type ConversationEvent,
  type ConversationReadState,
  type Live,
} from "@agentkib/web-client";
import { EmbeddedConversation } from "./conversation/desktop-embedded-conversation";
const state: ConversationReadState = {
  source: "codex-native",
  status: "unread",
  freshness: "current",
  version: "native:opaque",
  firstUnread: { type: "result", resultId: "terminal", turnId: "turn" },
  latestResult: {
    id: "terminal",
    turnId: "turn",
    itemId: null,
    outcome: "cancelled",
    completedAt: "2026-11-19T06:17:05.000Z",
  },
};
const event: ConversationEvent = {
  id: "answer",
  kind: "agent-message",
  turn_id: "turn",
  content: "Actual terminal result",
  attachment_count: 0,
  truncated: false,
};
function setup({
  writeFailure,
  initial = state,
  events = [event],
  warnings = [],
  live = { sessionId: "s", status: "idle", revision: 1, sendEnabled: false, approvals: [] },
}: {
  writeFailure?: "unknown" | "conflict";
  initial?: ConversationReadState;
  events?: ConversationEvent[];
  warnings?: string[];
  live?: Live;
} = {}) {
  let readState = initial;
  const request = vi.fn(async (path: string, body?: unknown) => {
    const operation = path.split("?")[0];
    if (operation === "access")
      return {
        status: "approved",
        protocolVersion: 2,
        readStateVersion: 1,
        bootId: "boot",
        csrfToken: "csrf",
        experimentalEnabled: false,
        device: { id: "local", name: "Desktop", send: false, approve: false },
      };
    if (operation === "catalog")
      return {
        indexEnabled: true,
        workspaces: [{ id: "w", name: "Project", path: "/test" }],
        sessions: [
          {
            id: "s",
            workspace_id: "w",
            agent: "codex",
            title: "Read only",
            archived: false,
            sidechain: false,
            availability: "readable",
            readState,
          },
        ],
      };
    if (operation === "events") return { events, warnings };
    if (operation === "live") return live;
    if (operation === "read-state") {
      if (body) {
        if (writeFailure === "unknown") throw new ApiError(504, "outcome_unknown");
        if (writeFailure === "conflict" && readState.version === initial.version) {
          readState = { ...readState, version: "native:new" };
          throw new ApiError(409, "read_state_conflict");
        }
        readState = { ...readState, status: "read", firstUnread: null };
      }
      return { readState };
    }
    return {
      sessionId: "s",
      status: "idle",
      available: false,
      features: {},
      models: [],
      workspaces: [],
    };
  });
  const bridge: ConversationClientBridge = {
    async request<T>(path: string, body?: unknown) {
      return (await request(path, body)) as T;
    },
    stream(_id, handlers) {
      queueMicrotask(handlers.open);
      return () => {};
    },
    uploadAttachment: vi.fn(),
  };
  return {
    request,
    client: new WebClient(undefined, { type: "same-origin" }, bridge),
    acknowledgements: () =>
      request.mock.calls
        .filter(([path, body]) => path === "read-state" && body)
        .map(([, body]) => body),
  };
}

async function conversation(client: WebClient) {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <EmbeddedConversation
        client={client}
        sessionId="s"
        locale="en-US"
        onSessionChange={vi.fn()}
      />,
    );
  });
  const viewport = view.container.querySelector<HTMLElement>(".reader-scroll")!;
  Object.defineProperties(viewport, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 900 },
  });
  viewport.scrollTop = 180;
  fireEvent.wheel(viewport, { deltaY: -120 });
  fireEvent.scroll(viewport);
  return { ...view, focus, viewport };
}

async function finishReadCheck() {
  // Advance the read coalescer, then the animation frame and the foreground dwell.
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await act(async () => vi.advanceTimersByTimeAsync(220));
}

function scrollToEnd(viewport: HTMLElement) {
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  fireEvent.scroll(viewport);
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
describe("actual desktop reader read-state integration", () => {
  it("acknowledges a result from the bottom of the focused window despite history warnings", async () => {
    const f = setup({ warnings: ["TRANSCRIPT_SCAN_BUDGET"] });
    const { focus, viewport } = await conversation(f.client);
    expect(screen.getByText("Actual terminal result")).toBeVisible();
    expect(screen.getByText(/TRANSCRIPT_SCAN_BUDGET/)).toBeVisible();

    focus.mockReturnValue(true);
    fireEvent.focus(window);
    await finishReadCheck();
    expect(f.acknowledgements()).toEqual([]);

    focus.mockReturnValue(false);
    scrollToEnd(viewport);
    await finishReadCheck();
    expect(f.acknowledgements()).toEqual([]);

    focus.mockReturnValue(true);
    fireEvent.focus(window);
    await finishReadCheck();
    expect(f.acknowledgements()).toEqual([
      { sessionId: "s", expectedVersion: "native:opaque", seenResultId: "terminal" },
    ]);
    expect(f.request.mock.calls.some(([path]) => /adopt|reconcile|requests\//.test(path))).toBe(
      false,
    );
  });

  it("reconciles an unknown ACK with a GET without posting again on a passive refresh", async () => {
    const f = setup({ writeFailure: "unknown" });
    const { focus, viewport } = await conversation(f.client);
    focus.mockReturnValue(true);
    scrollToEnd(viewport);
    await finishReadCheck();
    expect(f.acknowledgements()).toHaveLength(1);
    const afterPost = f.request.mock.calls.findIndex(
      ([path, body]) => path === "read-state" && body,
    );
    expect(
      f.request.mock.calls
        .slice(afterPost + 1)
        .some(([path, body]) => path === "read-state?sessionId=s" && !body),
    ).toBe(true);
    fireEvent.focus(window);
    await finishReadCheck();
    expect(f.acknowledgements()).toHaveLength(1);
  });

  it("uses the refreshed version after a definite conflict while still reading at the bottom", async () => {
    const f = setup({ writeFailure: "conflict" });
    const { focus, viewport } = await conversation(f.client);
    focus.mockReturnValue(true);
    scrollToEnd(viewport);
    await finishReadCheck();
    await finishReadCheck();
    expect(f.acknowledgements()).toEqual([
      { sessionId: "s", expectedVersion: "native:opaque", seenResultId: "terminal" },
      { sessionId: "s", expectedVersion: "native:new", seenResultId: "terminal" },
    ]);
  });

  it("keeps an older cancellation on its turn above a newer running turn", async () => {
    const f = setup({
      events: [
        event,
        { ...event, id: "new", turn_id: "new-turn", kind: "user-message", content: "New prompt" },
        {
          ...event,
          id: "codex-turn-end:new-turn",
          turn_id: "new-turn",
          content: "",
          turn_meta: { outcome: "aborted" },
        },
      ],
      live: {
        sessionId: "s",
        revision: 2,
        status: "running",
        turnId: "new-turn",
        sendEnabled: false,
        approvals: [],
      },
    });
    const view = await conversation(f.client);
    await finishReadCheck();
    const prompt = screen.getByText("New prompt");
    const marker = screen.getByText("Cancelled");
    expect(marker).toHaveAttribute("data-read-result", "terminal");
    expect(screen.getAllByText("Cancelled")).toHaveLength(1);
    expect(marker.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('[data-session-turn-status="running"]')).toBeVisible();
    view.focus.mockReturnValue(true);
    scrollToEnd(view.viewport);
    await finishReadCheck();
    expect(f.acknowledgements()).toEqual([
      { sessionId: "s", expectedVersion: "native:opaque", seenResultId: "terminal" },
    ]);
  });
});
