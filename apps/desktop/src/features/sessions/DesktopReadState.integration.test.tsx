// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  unknown = false,
  initial = state,
  events = [event],
  live = { sessionId: "s", status: "idle", revision: 1, sendEnabled: false, approvals: [] },
}: {
  unknown?: boolean;
  initial?: ConversationReadState;
  events?: ConversationEvent[];
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
    if (operation === "events") return { events, warnings: [] };
    if (operation === "live") return live;
    if (operation === "read-state") {
      if (body) {
        if (unknown) throw new ApiError(409, "read_state_conflict");
        readState = { ...initial, status: "read" };
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
  return { request, client: new WebClient(undefined, { type: "same-origin" }, bridge) };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
describe("actual desktop reader read-state integration", () => {
  it.each([false, true])(
    "uses read permission with a fresh visible cancelled result, without business receipts or retrying an unknown ACK (%s)",
    async (unknown) => {
      const f = setup({ unknown });
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 300,
        right: 400,
        width: 400,
        height: 300,
        toJSON() {},
      }));
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => document.querySelector('[data-read-result="terminal"]'),
      });
      const view = render(
        <EmbeddedConversation
          client={f.client}
          sessionId="s"
          locale="en-US"
          onSessionChange={vi.fn()}
        />,
      );
      expect(await screen.findByText("Actual terminal result")).toBeVisible();
      await waitFor(() =>
        expect(
          f.request.mock.calls.filter(([path, body]) => path === "read-state" && body),
        ).toHaveLength(1),
      );
      const body = f.request.mock.calls.find(([path, body]) => path === "read-state" && body)![1];
      expect(body).toEqual({
        sessionId: "s",
        expectedVersion: "native:opaque",
        seenResultId: "terminal",
      });
      fireEvent.keyDown(document.body, { key: "a" });
      view.rerender(
        <EmbeddedConversation
          client={f.client}
          sessionId="s"
          locale="en-US"
          onSessionChange={vi.fn()}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(
        f.request.mock.calls.filter(([path, body]) => path === "read-state" && body),
      ).toHaveLength(1);
      expect(f.request.mock.calls.some(([path]) => /adopt|reconcile|requests\//.test(path))).toBe(
        false,
      );
    },
  );

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
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const view = render(
      <EmbeddedConversation
        client={f.client}
        sessionId="s"
        locale="en-US"
        onSessionChange={vi.fn()}
      />,
    );
    const prompt = await screen.findByText("New prompt");
    const marker = await screen.findByText("Cancelled");
    expect(marker).toHaveAttribute("data-read-result", "terminal");
    expect(screen.getAllByText("Cancelled")).toHaveLength(1);
    expect(marker.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('[data-session-turn-status="running"]')).toBeVisible();
  });
});
