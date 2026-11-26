// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type ConversationSessionSummary } from "@agentkib/web-client";
import {
  createDesktopConversationAdapter,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";
import { EmbeddedConversation } from "../../desktop-embedded-conversation";
import {
  pendingScope,
  readPending,
  rememberPending,
  sessionCopyForSurface,
} from "@agentkib/session-ui";

const labels = [
  ["zh-CN", "待处理中心", "汇总本页已查看会话的待处理事项及当前访问尚未确认的请求。"],
  ["zh-Hant", "待處理中心", "彙整此頁已查看對話的待處理事項及目前存取尚未確認的請求。"],
  [
    "en-US",
    "Pending actions",
    "Pending actions from sessions viewed on this page and unconfirmed requests from this access.",
  ],
  [
    "ja-JP",
    "対応待ち",
    "このページで閲覧した会話の対応待ち項目と、現在のアクセスで未確認のリクエストを表示します。",
  ],
] as const;

const waitingSession: ConversationSessionSummary = {
  id: "waiting-session",
  title: "Waiting session",
  workspace_id: "workspace",
  agent: "codex",
  availability: "readable",
  archived: false,
  sidechain: false,
  pendingInteraction: true,
};

function fixture(sessions: ConversationSessionSummary[] = []) {
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "local",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "desktop-local",
      name: "Desktop",
      accessMode: "full",
      send: true,
      approve: true,
      manage: true,
      files: true,
      attachments: true,
      advancedControl: true,
    },
  };
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async (path) => {
      if (path === "access") return { status: 200, body: access };
      if (path === "catalog")
        return { status: 200, body: { indexEnabled: true, sessions, workspaces: [] } };
      if (path.startsWith("requests/"))
        return { status: 200, body: { found: false, requestId: path.slice("requests/".length) } };
      throw new Error(`Unexpected request: ${path}`);
    }),
    upload: vi.fn(async () => {
      throw new Error("Opening pending actions must not upload files");
    }),
    subscribe: vi.fn(async () => ({ subscriptionId: "catalog-observation", events: [] })),
    acknowledge: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}),
    onUnavailable: vi.fn(() => () => {}),
    onControlChanged: vi.fn(() => () => {}),
  };
  return {
    bridge,
    client: new WebClient(
      undefined,
      { type: "same-origin" },
      createDesktopConversationAdapter(() => bridge),
    ),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  document.querySelectorAll("[data-pending-test-host]").forEach((node) => node.remove());
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("desktop pending-center copy", () => {
  function toolbarSlots() {
    const host = document.createElement("div");
    host.dataset.pendingTestHost = "";
    const directorySlot = document.createElement("div");
    directorySlot.dataset.sessionDirectoryPendingSlot = "";
    const review = document.createElement("button");
    review.setAttribute("aria-label", "To review");
    directorySlot.append(review);
    const windowSlot = document.createElement("div");
    windowSlot.dataset.sessionWindowPendingSlot = "";
    host.append(directorySlot, windowSlot);
    document.body.append(host);
    return { review, directorySlot, windowSlot };
  }

  it("omits unknown business requests and clears orphans without discarding a bound receipt", async () => {
    const { client, bridge } = fixture();
    const slots = toolbarSlots();
    const pending = {
      requestId: "11111111-1111-4111-8111-111111111111",
      sessionId: "unconfirmed-session",
      kind: "stop" as const,
    };
    const scope = pendingScope(client.origin, "desktop-local");
    const orphan = { requestId: "22222222-2222-4222-8222-222222222222", kind: "stop" };
    sessionStorage.setItem(scope, JSON.stringify([pending, orphan]));
    render(<EmbeddedConversation client={client} locale="en-US" onSessionChange={vi.fn()} />);
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled());
    await waitFor(() => expect(sessionStorage.getItem(scope)).not.toContain(orphan.requestId));
    expect(screen.queryByRole("button", { name: /^Pending actions/ })).not.toBeInTheDocument();
    expect(slots.windowSlot).toBeEmptyDOMElement();
    expect(slots.review).toBeInTheDocument();
    expect(readPending(scope)).toMatchObject([pending]);
    expect(vi.mocked(bridge.request).mock.calls.every(([, body]) => body === undefined)).toBe(true);
  });

  it("does not add an empty pending action to the window toolbar", async () => {
    const { client, bridge } = fixture();
    const slots = toolbarSlots();
    render(<EmbeddedConversation client={client} locale="en-US" onSessionChange={vi.fn()} />);
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Pending actions" })).not.toBeInTheDocument();
    expect(slots.windowSlot).toBeEmptyDOMElement();
    expect(slots.review).toBeInTheDocument();
  });

  it.each(labels)(
    "opens the embedded pending center with access-neutral copy in %s",
    async (locale, title, description) => {
      const { bridge, client } = fixture([waitingSession]);
      const slots = toolbarSlots();
      const scope = pendingScope(client.origin, "desktop-local");
      const pending = {
        requestId: "11111111-1111-4111-8111-111111111111",
        sessionId: "unconfirmed-session",
        kind: "stop" as const,
      };
      rememberPending(scope, pending);
      render(<EmbeddedConversation client={client} locale={locale} onSessionChange={vi.fn()} />);

      const trigger = await screen.findByRole("button", { name: `${title} (1)` });
      expect(slots.windowSlot).toContainElement(trigger);
      expect(slots.directorySlot).not.toContainElement(trigger);
      expect(trigger.querySelector(".lucide-list-todo")).not.toBeNull();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: title });
      expect(within(dialog).queryByText(description)).not.toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Waiting session" })).toBeVisible();
      expect(
        within(dialog).queryByText(sessionCopyForSurface(locale).unknown),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole("button", { name: sessionCopyForSurface(locale).refresh }),
      ).not.toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(/浏览器|瀏覽器|browser|ブラウザー/i);
      expect(readPending(scope)).toMatchObject([pending]);
      expect(bridge.request).toHaveBeenCalledWith("access", undefined);
      expect(vi.mocked(bridge.request).mock.calls.every(([, body]) => body === undefined)).toBe(
        true,
      );
      expect(bridge.upload).not.toHaveBeenCalled();
      expect(bridge.subscribe).toHaveBeenCalledExactlyOnceWith("", undefined);
    },
  );
});
