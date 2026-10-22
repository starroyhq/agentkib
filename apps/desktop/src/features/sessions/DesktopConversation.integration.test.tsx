// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EmbeddedConversation as Conversation,
  type EmbeddedConversationProps,
} from "./conversation/conversation";

import { WebClient, type Access, type Live } from "@agentkib/web-client";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import {
  permissionModeCopy,
  permissionModeSummaryCopy,
} from "./conversation/features/sessions/permission-mode-copy";
import {
  claudeConnectionCopy,
  claudeConnectionReason,
} from "./conversation/features/sessions/claude-connection-copy";
import type { ConversationSubscription, SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";

function EmbeddedConversation(props: EmbeddedConversationProps) {
  return (
    <>
      <header data-session-window-session={props.sessionId}>
        <div data-session-window-status-slot />
        <div data-session-window-files-slot />
        <div data-session-window-pending-slot />
      </header>
      <Conversation {...props} />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("desktop embedded conversation", () => {
  it("rechecks Claude safety through the trusted bridge and continues without a handoff while retaining the draft", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    sessionStorage.clear();
    const state: { live: Live; owned: boolean } = {
      owned: false,
      live: {
        sessionId: "claude-session",
        status: "idle",
        revision: 1,
        sendEnabled: true,
        approvals: [],
        questions: [],
        executionMode: "claude-managed",
        executionLocation: null,
        cliVersion: "2.1.296 (Claude Code)",
      },
    };
    const access: Access = {
      protocolVersion: 2,
      status: "approved",
      csrfToken: "local",
      bootId: "boot",
      experimentalEnabled: true,
      device: {
        id: "local",
        name: "Desktop",
        accessMode: "full",
        send: true,
        approve: true,
        advancedControl: true,
        manage: true,
      },
    };
    const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
    const bridge: DesktopConversationBridge = {
      request: vi.fn(async (path, body) => {
        const operation = path.split("?")[0];
        if (operation === "access") return { status: 200, body: access };
        if (operation === "catalog")
          return {
            status: 200,
            body: {
              indexEnabled: true,
              workspaces: [{ id: "workspace", name: "Project", path: "/isolated/project" }],
              sessions: [
                {
                  id: "claude-session",
                  workspace_id: "workspace",
                  agent: "claude-code",
                  title: "Native Claude conversation",
                  availability: "readable",
                  archived: false,
                  sidechain: false,
                },
              ],
            },
          };
        if (operation === "events")
          return {
            status: 200,
            body: {
              events: [
                {
                  id: "history",
                  kind: "agent-message",
                  content: "Existing Claude history",
                  attachment_count: 0,
                  truncated: false,
                },
              ],
              warnings: [],
            },
          };
        if (operation === "live") return { status: 200, body: state.live };
        if (operation === "managed/capabilities")
          return {
            status: 200,
            body: {
              sessionId: "claude-session",
              executionMode: state.live.executionMode,
              status: "idle",
              features: {
                send: { available: state.live.sendEnabled },
                adopt: { available: !state.owned },
                inspect: { available: true },
              },
            },
          };
        if (operation === "managed/options")
          return {
            status: 200,
            body: {
              available: true,
              workspaces: [{ id: "workspace", name: "Project" }],
              models: [],
            },
          };
        if (operation === "managed/inspect")
          return {
            status: 200,
            body: { sessionId: "claude-session", handoffFingerprint: "verified-history" },
          };
        if (operation === "send") {
          state.owned = true;
          state.live = {
            ...state.live,
            revision: state.live.revision + 1,
            executionMode: "claude-managed",
            executionLocation: "agentkib",
            reason: undefined,
            sendEnabled: true,
          };
          return {
            status: 200,
            body: {
              accepted: true,
              sessionId: "claude-session",
              requestId:
                body && typeof body === "object" && "requestId" in body ? body.requestId : "",
            },
          };
        }
        return { status: 200, body: {} };
      }),
      upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
      subscribe: vi.fn(async (sessionId): Promise<ConversationSubscription<Live>> => ({
        subscriptionId: "claude-subscription",
        events: [
          {
            protocolVersion: 2,
            sessionId,
            subscriptionId: "claude-subscription",
            runtimeBootId: "runtime",
            epoch: "epoch",
            seq: 0,
            cursor: "cursor-0",
            type: "snapshot",
            payload: { live: { ...state.live, sessionId } },
          },
        ],
        cursor: "cursor-0",
      })),
      acknowledge: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onUnavailable: () => () => {},
      onControlChanged: () => () => {},
    };
    const mutations = () =>
      vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined);
    const client = new WebClient(
      undefined,
      { type: "same-origin" },
      createDesktopConversationAdapter(() => bridge),
    );
    render(
      <EmbeddedConversation
        client={client}
        sessionId="claude-session"
        locale="zh-CN"
        onSessionChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("Existing Claude history")).toBeVisible();
    const draft = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(draft, { target: { value: "保留桌面草稿" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /我已结束当前轮次/ })).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
    function emitLive(seq: number) {
      for (const listener of listeners)
        listener({
          protocolVersion: 2,
          sessionId: "claude-session",
          subscriptionId: "claude-subscription",
          runtimeBootId: "runtime",
          epoch: "epoch",
          seq,
          cursor: `cursor-${seq}`,
          type: "snapshot",
          payload: { live: { ...state.live } },
        });
    }
    state.live = {
      ...state.live,
      revision: 2,
      status: "outcome-unknown",
      sendEnabled: false,
      reason: "control-outcome-unconfirmed",
    };
    act(() => emitLive(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(mutations()).toEqual([]);
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("保留桌面草稿");
    expect(screen.getByText(claudeConnectionCopy["zh-CN"].managedUnconfirmed)).toBeVisible();
    expect(screen.queryByText(claudeConnectionCopy["zh-CN"].connectionUnconfirmed)).toBeNull();
    state.live = {
      ...state.live,
      revision: 3,
      status: "idle",
      sendEnabled: true,
      reason: undefined,
    };
    act(() => emitLive(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("保留桌面草稿");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]).toEqual([
      "send",
      expect.objectContaining({
        sessionId: "claude-session",
        text: "保留桌面草稿",
        requestId: expect.any(String),
      }),
    ]);
    expect(mutations()[0][1]).not.toHaveProperty("handoffConfirmed");
    expect(mutations()[0][1]).not.toHaveProperty("handoffFingerprint");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(""));
    const running = await screen.findByText(sessionContinuationCopy("zh-CN").running);
    expect(running).toBeVisible();
    expect(running.closest("[data-session-window-status-slot]")).not.toBeNull();
    expect(vi.mocked(bridge.request).mock.calls.some(([path]) => path === "managed/adopt")).toBe(
      false,
    );
    expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
  });

  it("uses the trusted bridge for history, streaming and sends without pairing or a second application shell", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const live: Live = {
      sessionId: "session",
      status: "idle",
      revision: 1,
      sendEnabled: true,
      approvals: [],
      executionMode: "codex-managed",
    };
    const access: Access = {
      protocolVersion: 2,
      status: "approved",
      csrfToken: "local",
      bootId: "boot",
      experimentalEnabled: true,
      device: {
        id: "local",
        name: "Desktop",
        accessMode: "full",
        send: true,
        approve: true,
        advancedControl: true,
        manage: true,
      },
    };
    const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
    const subscriptions = new Map<string, string>();
    const bridge: DesktopConversationBridge = {
      request: vi.fn(async (path, body) => {
        const operation = path.split("?")[0];
        if (operation === "access") return { status: 200, body: access };
        if (operation === "catalog")
          return {
            status: 200,
            body: {
              indexEnabled: true,
              workspaces: [{ id: "workspace", name: "Project", path: "/isolated/project" }],
              sessions: [
                {
                  id: "session",
                  workspace_id: "workspace",
                  agent: "codex",
                  title: "Native conversation",
                  availability: "readable",
                  archived: false,
                  sidechain: false,
                },
              ],
            },
          };
        if (operation === "events")
          return {
            status: 200,
            body: {
              events: [
                {
                  id: "history",
                  kind: "agent-message",
                  content: "Existing history",
                  attachment_count: 0,
                  truncated: false,
                },
              ],
              warnings: [],
            },
          };
        if (operation === "live") return { status: 200, body: live };
        if (operation === "codex/capabilities")
          return {
            status: 200,
            body: {
              sessionId: "session",
              executionMode: "codex-managed",
              status: "idle",
              features: { send: { available: true } },
            },
          };
        if (operation === "codex/session-settings")
          return {
            status: 200,
            body: {
              sessionId: "session",
              available: false,
              revision: 1,
              current: {},
              defaults: {},
              writable: {
                model: { available: false },
                effort: { available: false },
                mode: { available: false },
                policy: { available: false },
                serviceTier: { available: false },
              },
              options: { models: [], policies: [], serviceTiers: [] },
            },
          };
        if (operation === "codex/goals")
          return {
            status: 200,
            body: { sessionId: "session", available: false, revision: 1, actions: {} },
          };
        if (operation === "codex/context-options")
          return { status: 200, body: { sessionId: "session", available: false, resources: [] } };
        if (operation === "send")
          return {
            status: 200,
            body: {
              accepted: true,
              requestId:
                typeof body === "object" && body && "requestId" in body ? body.requestId : "",
              sessionId: "session",
              turnId: "new-turn",
            },
          };
        return { status: 200, body: {} };
      }),
      upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
      subscribe: vi.fn(async (sessionId: string): Promise<ConversationSubscription<Live>> => {
        const subscriptionId = `sub-${subscriptions.size}`;
        subscriptions.set(sessionId, subscriptionId);
        return {
          subscriptionId,
          events: [
            {
              protocolVersion: 2,
              sessionId,
              subscriptionId,
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor-0",
              type: "snapshot",
              payload: { live: { ...live, sessionId } },
            },
          ],
          cursor: "cursor-0",
        };
      }),
      acknowledge: vi.fn(async () => {}),
      unsubscribe: vi.fn(async () => {}),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      onUnavailable: () => () => {},
      onControlChanged: () => () => {},
    };
    const client = new WebClient(
      undefined,
      { type: "same-origin" },
      createDesktopConversationAdapter(() => bridge),
    );
    render(
      <EmbeddedConversation
        client={client}
        sessionId="session"
        locale="en-US"
        onSessionChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("Existing history")).toBeVisible();
    expect(screen.queryByText(/pairing code/i)).toBeNull();
    await waitFor(() => expect(subscriptions.has("session")).toBe(true));
    act(() => {
      const event: SessionStreamEvent<Live> = {
        protocolVersion: 2,
        subscriptionId: subscriptions.get("session")!,
        sessionId: "session",
        runtimeBootId: "runtime",
        epoch: "epoch",
        seq: 1,
        cursor: "cursor-1",
        type: "item-upsert",
        payload: {
          id: "live-reply",
          turn_id: "turn",
          kind: "agent-message",
          content: "Live reply in desktop",
          attachment_count: 0,
          truncated: false,
        },
      };
      for (const listener of listeners) listener(event);
    });
    expect(await screen.findByText("Live reply in desktop")).toBeVisible();
    const durations: number[] = [];
    let reply = "Live reply in desktop";
    // Measure the actual shared reader DOM, including the IPC adapter, store and
    // React commit. Native generation and OS IPC latency are outside this fixture.
    for (let batch = 0; batch < 40; batch++) {
      const text = ` · ${batch}🙂`;
      const event: SessionStreamEvent<Live> = {
        protocolVersion: 2,
        subscriptionId: subscriptions.get("session")!,
        sessionId: "session",
        runtimeBootId: "runtime",
        epoch: "epoch",
        seq: batch + 2,
        cursor: `cursor-${batch + 2}`,
        type: "text-delta",
        payload: { itemId: "live-reply", turnId: "turn", text, offset: reply.length },
      };
      reply += text;
      const started = performance.now();
      await act(async () => {
        for (const listener of listeners) listener(event);
      });
      expect(document.querySelector('[data-event-id="live-reply"]')).toHaveTextContent(reply);
      durations.push(performance.now() - started);
    }
    const p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
    console.info(
      `Desktop Embedded event→DOM P95: ${p95.toFixed(2)}ms (${durations.length} batches; ${process.platform}/${process.arch}, Node ${process.version}, jsdom, real React reader)`,
    );
    expect(p95).toBeLessThanOrEqual(150);
    expect(document.querySelectorAll('[data-event-id="live-reply"]')).toHaveLength(1);
    expect(screen.getByText("Existing history")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Continue this conversation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({ sessionId: "session", text: "Continue this conversation" }),
      ),
    );
    expect(vi.mocked(bridge.request).mock.calls.filter(([path]) => path === "send")).toHaveLength(
      1,
    );
  });

  describe("Claude permission mode notice", () => {
    // Hand-built bridge for a managed Claude session; no real session data is involved.
    function claudeBridge(initial: Live, adoptAvailable = false) {
      if (initial.executionMode === "claude-follower" && initial.executionLocation === undefined)
        initial = { ...initial, executionLocation: "terminal" };
      // Terminal cases model the experimental plugin that accepts messages unless told otherwise.
      if (initial.executionMode === "claude-follower" && initial.terminalSend === undefined)
        initial = { ...initial, terminalSend: true };
      const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
      const access: Access = {
        protocolVersion: 2,
        status: "approved",
        csrfToken: "local",
        bootId: "boot",
        experimentalEnabled: true,
        device: {
          id: "local",
          name: "Desktop",
          accessMode: "full",
          send: true,
          approve: true,
          advancedControl: true,
          manage: true,
        },
      };
      const bridge: DesktopConversationBridge = {
        request: vi.fn(async (path) => {
          const operation = path.split("?")[0];
          if (operation === "access") return { status: 200, body: access };
          if (operation === "catalog")
            return {
              status: 200,
              body: {
                indexEnabled: true,
                workspaces: [{ id: "workspace", name: "Project", path: "/isolated/project" }],
                sessions: [
                  {
                    id: "claude-session",
                    workspace_id: "workspace",
                    agent: "claude-code",
                    title: "Native Claude conversation",
                    availability: "readable",
                    archived: false,
                    sidechain: false,
                  },
                ],
              },
            };
          if (operation === "events")
            return {
              status: 200,
              body: {
                events: [
                  {
                    id: "history",
                    kind: "agent-message",
                    content: "Existing Claude history",
                    attachment_count: 0,
                    truncated: false,
                  },
                ],
                warnings: [],
              },
            };
          if (operation === "live") return { status: 200, body: initial };
          if (operation === "managed/capabilities")
            return {
              status: 200,
              body: {
                sessionId: "claude-session",
                executionMode: initial.executionMode,
                status: "idle",
                features: {
                  send: { available: initial.sendEnabled },
                  adopt: { available: adoptAvailable },
                },
              },
            };
          return { status: 200, body: {} };
        }),
        upload: vi.fn(async () => ({ status: 400, body: { error: "not-used" } })),
        subscribe: vi.fn(async (sessionId): Promise<ConversationSubscription<Live>> => ({
          subscriptionId: "claude-subscription",
          events: [
            {
              protocolVersion: 2,
              sessionId,
              subscriptionId: "claude-subscription",
              runtimeBootId: "runtime",
              epoch: "epoch",
              seq: 0,
              cursor: "cursor-0",
              type: "snapshot",
              payload: { live: { ...initial, sessionId } },
            },
          ],
          cursor: "cursor-0",
        })),
        acknowledge: vi.fn(async () => {}),
        unsubscribe: vi.fn(async () => {}),
        onEvent: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        onUnavailable: () => () => {},
        onControlChanged: () => () => {},
      };
      let seq = 0;
      const patch = (payload: Partial<Live>) =>
        act(() => {
          seq += 1;
          const event: SessionStreamEvent<Live> = {
            protocolVersion: 2,
            sessionId: "claude-session",
            subscriptionId: "claude-subscription",
            runtimeBootId: "runtime",
            epoch: "epoch",
            seq,
            cursor: `cursor-${seq}`,
            type: "state",
            payload,
          };
          for (const listener of listeners) listener(event);
        });
      return { bridge, patch };
    }
    const live = (permission?: Live["permission"]): Live => ({
      sessionId: "claude-session",
      status: "idle",
      revision: 1,
      sendEnabled: true,
      approvals: [],
      questions: [],
      executionMode: "claude-managed",
      cliVersion: "2.1.296 (Claude Code)",
      ...(permission ? { permission } : {}),
    });
    const shown = (text: string) =>
      screen.queryAllByRole("status").some((element) => element.textContent?.includes(text));
    async function open(
      initial: Live,
      locale: "zh-CN" | "en-US" | "zh-TW" | "ja-JP" = "zh-CN",
      adoptAvailable = false,
    ) {
      vi.spyOn(window, "scrollTo").mockImplementation(() => {});
      sessionStorage.clear();
      const fixture = claudeBridge(initial, adoptAvailable);
      render(
        <EmbeddedConversation
          client={
            new WebClient(
              undefined,
              { type: "same-origin" },
              createDesktopConversationAdapter(() => fixture.bridge),
            )
          }
          sessionId="claude-session"
          locale={locale}
          onSessionChange={vi.fn()}
        />,
      );
      expect(await screen.findByText("Existing Claude history")).toBeVisible();
      return fixture;
    }

    it.each([false, true])(
      "opens a requested terminal wizard only after matching ready state (leave before ready: %s)",
      async (leaveBeforeReady) => {
        const previousPlatform = document.documentElement.dataset.platform;
        document.documentElement.dataset.platform = "macos";
        try {
          vi.spyOn(window, "scrollTo").mockImplementation(() => {});
          sessionStorage.clear();
          const initial = live();
          const { bridge, patch } = claudeBridge(initial);
          const original = vi.mocked(bridge.request).getMockImplementation()!;
          let releaseLive!: () => void;
          const pendingLive = new Promise<void>((resolve) => {
            releaseLive = resolve;
          });
          const originalSubscribe = vi.mocked(bridge.subscribe).getMockImplementation()!;
          vi.mocked(bridge.subscribe).mockImplementation(async (id, after) => {
            if (id === "claude-session") await pendingLive;
            return originalSubscribe(id, after);
          });
          vi.mocked(bridge.request).mockImplementation(async (path, body) => {
            const url = new URL(path, "http://local/");
            const operation = url.pathname.slice(1);
            const id = url.searchParams.get("sessionId");
            if (operation === "live" && id === "claude-session") await pendingLive;
            if (operation === "live" && id === "second-session")
              return { status: 200, body: { ...initial, sessionId: id } };
            if (operation === "managed/capabilities" && id === "second-session")
              return {
                status: 200,
                body: {
                  sessionId: id,
                  status: "idle",
                  executionMode: "claude-managed",
                  features: { send: { available: true } },
                },
              };
            const result = await original(path, body);
            if (operation === "catalog") {
              const catalog = result.body as { sessions: object[] };
              return {
                ...result,
                body: {
                  ...catalog,
                  sessions: [
                    ...catalog.sessions,
                    { ...catalog.sessions[0], id: "second-session", title: "Second session" },
                  ],
                },
              };
            }
            return result;
          });
          const consumed = vi.fn();
          const client = new WebClient(
            undefined,
            { type: "same-origin" },
            createDesktopConversationAdapter(() => bridge),
          );
          const props = {
            client,
            locale: "zh-CN" as const,
            onSessionChange: vi.fn(),
            onInitialPanelConsumed: consumed,
          };
          const view = render(
            <EmbeddedConversation {...props} sessionId="claude-session" initialPanel="terminal" />,
          );
          await waitFor(() =>
            expect(
              vi.mocked(bridge.request).mock.calls.some(([path]) => path.startsWith("live?")),
            ).toBe(true),
          );
          expect(screen.queryByRole("dialog", { name: "连接终端" })).toBeNull();
          expect(consumed).not.toHaveBeenCalled();
          if (leaveBeforeReady) {
            view.rerender(<EmbeddedConversation {...props} sessionId="second-session" />);
            await screen.findByText("Existing Claude history");
          }
          await act(async () => {
            releaseLive();
            await pendingLive;
          });
          if (leaveBeforeReady) {
            await waitFor(() =>
              expect(
                vi
                  .mocked(bridge.request)
                  .mock.calls.some(([path]) => path.includes("second-session")),
              ).toBe(true),
            );
            expect(screen.queryByRole("dialog", { name: "连接终端" })).toBeNull();
            expect(consumed).not.toHaveBeenCalled();
          } else {
            expect(await screen.findByRole("dialog", { name: "连接终端" })).toBeVisible();
            expect(consumed).toHaveBeenCalledTimes(1);
            fireEvent.click(screen.getByRole("button", { name: "关闭" }));
            patch({
              revision: 2,
              status: "running",
              executionLocation: "agentkib",
              sendEnabled: false,
            });
            await waitFor(() =>
              expect(screen.queryByRole("dialog", { name: "连接终端" })).toBeNull(),
            );
            expect(consumed).toHaveBeenCalledTimes(1);
          }
        } finally {
          if (previousPlatform === undefined) delete document.documentElement.dataset.platform;
          else document.documentElement.dataset.platform = previousPlatform;
        }
      },
    );

    it("does not consume a requested terminal wizard while the native outcome remains unknown", async () => {
      const previousPlatform = document.documentElement.dataset.platform;
      document.documentElement.dataset.platform = "macos";
      try {
        vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        sessionStorage.clear();
        const { bridge, patch } = claudeBridge({
          ...live(),
          status: "outcome-unknown",
          sendEnabled: false,
          reason: "control-outcome-unconfirmed",
        });
        const consumed = vi.fn();
        render(
          <EmbeddedConversation
            client={
              new WebClient(
                undefined,
                { type: "same-origin" },
                createDesktopConversationAdapter(() => bridge),
              )
            }
            sessionId="claude-session"
            initialPanel="terminal"
            onInitialPanelConsumed={consumed}
            locale="zh-CN"
            onSessionChange={vi.fn()}
          />,
        );
        expect(
          await screen.findByText(claudeConnectionCopy["zh-CN"].managedUnconfirmed),
        ).toBeVisible();
        expect(screen.queryByText(claudeConnectionCopy["zh-CN"].connectionUnconfirmed)).toBeNull();
        expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
        expect(
          vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined),
        ).toEqual([]);
        expect(screen.queryByRole("dialog", { name: "连接终端" })).toBeNull();
        expect(consumed).not.toHaveBeenCalled();
        patch({ revision: 2, status: "idle", sendEnabled: true, reason: "" });
        expect(await screen.findByRole("dialog", { name: "连接终端" })).toBeVisible();
        expect(consumed).toHaveBeenCalledTimes(1);
      } finally {
        if (previousPlatform === undefined) delete document.documentElement.dataset.platform;
        else document.documentElement.dataset.platform = previousPlatform;
      }
    });

    it("keeps an original-terminal connection outside managed handoff with stale adoption capabilities", async () => {
      const { bridge } = await open(
        {
          ...live(),
          executionMode: "claude-follower",
          sendEnabled: false,
          reason: "handoff-required",
        },
        "zh-CN",
        true,
      );
      const draft = screen.getByRole("textbox", { name: "发送消息" });
      fireEvent.change(draft, { target: { value: "Keep original terminal draft" } });
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(draft).toHaveValue("Keep original terminal draft");
      expect(vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined)).toEqual(
        [],
      );
    });

    it("connects the original Claude session without handoff and retains the draft after disconnect", async () => {
      const { bridge, patch } = await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
      });
      expect(
        await screen.findByText(sessionContinuationCopy("zh-CN").terminalConnected),
      ).toBeVisible();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      const draft = screen.getByRole("textbox", { name: "发送消息" });
      fireEvent.change(draft, { target: { value: "保留原终端草稿" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
      patch({
        revision: 2,
        status: "unsupported",
        sendEnabled: false,
        stopEnabled: false,
        reason: "claude-bridge-disconnected",
        executionLocation: null,
        connectionGeneration: "revoked-a",
        approvals: [],
        questions: [],
        streamText: "",
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "发送" })).not.toBeInTheDocument(),
      );
      expect(
        screen.getByText(claudeConnectionCopy["zh-CN"].lostTitle, { selector: "aside strong" }),
      ).toBeVisible();
      patch({
        revision: 3,
        status: "idle",
        executionMode: "claude-managed",
        executionLocation: null,
        reason: "",
        sendEnabled: true,
      });
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("保留原终端草稿"),
      );
      expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(
        vi
          .mocked(bridge.request)
          .mock.calls.filter(
            ([path, body]) =>
              body !== undefined && ["send", "managed/adopt", "managed/create"].includes(path),
          ),
      ).toEqual([]);
    });

    it("follows a terminal that cannot take messages without a dead input or handoff", async () => {
      const { bridge } = await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
        sendEnabled: false,
        terminalSend: false,
        reason: "claude-follower-send-unverified",
      });
      expect(await screen.findByText(sessionContinuationCopy("zh-CN").terminalWatch)).toBeVisible();
      // Said once: the bar replaces both the banner and the disabled composer.
      expect(screen.queryByText(claudeConnectionCopy["zh-CN"].sendUnverified)).toBeNull();
      expect(screen.queryByRole("textbox", { name: "发送消息" })).toBeNull();
      expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
      expect(vi.mocked(bridge.request).mock.calls.filter(([path]) => path === "send")).toHaveLength(
        0,
      );
    });

    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "renders authenticated reconnect failures in %s and clears them without enabling terminal controls",
      async (locale) => {
        const reason = "bridge-cli-too-old";
        const { bridge, patch } = await open(
          {
            ...live(),
            executionMode: "claude-follower",
            executionLocation: null,
            status: "unsupported",
            sendEnabled: false,
            stopEnabled: false,
            terminalSend: false,
            reason,
            bridgeConnectionFailure: { reason, cliVersion: "2.1.300" },
          },
          locale,
        );
        for (const failureReason of [
          reason,
          "bridge-cli-unsupported",
          "bridge-capabilities-missing",
          "bridge-plugin-update-required",
        ]) {
          const failure = { reason: failureReason, cliVersion: "2.1.300" };
          patch({ reason: failureReason, bridgeConnectionFailure: failure });
          const text = claudeConnectionReason(locale, failureReason, "desktop", failure)!;
          await waitFor(() => expect(screen.getAllByText(text)[0]).toBeVisible());
          expect(screen.queryByRole("textbox")).toBeNull();
          patch({ bridgeConnectionFailure: null });
          await waitFor(() => expect(screen.queryByText(text)).toBeNull());
          patch({ reason: "claude-bridge-disconnected" });
        }
        expect(
          vi.mocked(bridge.request).mock.calls.filter(([path]) => ["send", "stop"].includes(path)),
        ).toHaveLength(0);
      },
    );

    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "shows an unverified native version in %s without enabling terminal controls",
      async (locale) => {
        const { bridge, patch } = await open(
          {
            ...live(),
            executionMode: "claude-follower",
            connectionGeneration: "lease-a",
            sendEnabled: false,
            terminalSend: false,
            reason: "claude-follower-send-unverified",
            bridgeCompatibility: { cliVersion: "2.1.307", status: "unverified" },
          },
          locale,
        );
        const text = claudeConnectionCopy[locale].unverifiedVersion.replace("{version}", "2.1.307");
        expect(await screen.findByText(text)).toHaveClass("text-muted-foreground");
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(
          vi.mocked(bridge.request).mock.calls.filter(([path]) => path === "send"),
        ).toHaveLength(0);
        patch({ bridgeCompatibility: null });
        await waitFor(() => expect(screen.queryByText(text)).toBeNull());
        patch({ bridgeCompatibility: { cliVersion: "2.1.301", status: "verified" } });
        await waitFor(() => expect(screen.queryByText(text)).toBeNull());
        patch({
          executionMode: "claude-managed",
          bridgeCompatibility: { cliVersion: "2.1.307", status: "unverified" },
        });
        expect(screen.queryByText(text)).toBeNull();
      },
    );

    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "shows unconfirmed native turn state in %s without handoff",
      async (locale) => {
        const { bridge } = await open(
          {
            ...live(),
            executionMode: "claude-follower",
            status: "running",
            sendEnabled: false,
            stopEnabled: false,
            reason: "claude-follower-turn-unconfirmed",
          },
          locale,
        );
        expect(await screen.findByText(claudeConnectionCopy[locale].turnUnconfirmed)).toBeVisible();
        expect(
          vi
            .mocked(bridge.request)
            .mock.calls.filter(([path]) => ["send", "stop", "managed/adopt"].includes(path)),
        ).toHaveLength(0);
      },
    );

    it("explains follower approvals in the original terminal without offering a local decision", async () => {
      await open({
        ...live(),
        executionMode: "claude-follower",
        connectionGeneration: "lease-a",
        status: "awaiting-approval",
        sendEnabled: false,
        reason: "claude-terminal-approval",
      });
      expect(await screen.findByText(sessionContinuationCopy("zh-CN").terminalHint)).toBeVisible();
      expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "交给 AgentKib" })).not.toBeInTheDocument();
    });

    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "places the automatic background end notice below the transcript in %s",
      async (locale) => {
        const copy = sessionContinuationCopy(locale);
        const { bridge, patch } = await open({ ...live(), executionLocation: "agentkib" }, locale);
        expect(await screen.findByText(copy.running)).toBeVisible();
        patch({ revision: 2, executionLocation: null, continuationNotice: "background-ended" });
        const ended = await screen.findByText(copy.backgroundEnded);
        expect(ended).toHaveAttribute("role", "status");
        expect(ended.closest("aside")).toBeNull();
        expect(screen.queryByText(copy.running)).toBeNull();
        expect(screen.getByPlaceholderText(copy.placeholder)).toBeEnabled();
        expect(
          vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined),
        ).toEqual([]);
      },
    );
    it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
      "shows one conflict notice and restores the preserved draft when its owner leaves in %s",
      async (locale) => {
        const copy = sessionContinuationCopy(locale);
        const { bridge, patch } = await open({ ...live(), executionLocation: "agentkib" }, locale);
        fireEvent.change(screen.getByPlaceholderText(copy.placeholder), {
          target: { value: "Keep conflict draft" },
        });
        patch({
          revision: 2,
          sendEnabled: false,
          executionLocation: "external",
          ownershipReason: "owner-opened-elsewhere",
          reason: "owner-opened-elsewhere",
          continuationNotice: "owner-opened-elsewhere",
        });
        expect(
          await screen.findByRole("group", { name: copy.choice("Claude Code") }),
        ).toBeVisible();
        expect(screen.getAllByText(copy.ownerOpenedElsewhere)).toHaveLength(1);
        expect(screen.queryByPlaceholderText(copy.placeholder)).toBeNull();
        patch({
          revision: 3,
          sendEnabled: true,
          executionLocation: null,
          ownershipReason: null,
          reason: "",
        });
        expect(await screen.findByPlaceholderText(copy.placeholder)).toHaveValue(
          "Keep conflict draft",
        );
        expect(screen.queryByRole("group", { name: copy.choice("Claude Code") })).toBeNull();
        expect(
          vi.mocked(bridge.request).mock.calls.filter(([, body]) => body !== undefined),
        ).toEqual([]);
      },
    );

    it.each([
      ["zh-CN", "auto", { mode: "auto" }],
      ["en-US", "dontAsk", { mode: "dontAsk" }],
      ["zh-TW", "bypassPermissions", { mode: "bypassPermissions" }],
      ["ja-JP", "possiblyAuto", { mode: null, possiblyAuto: true }],
    ] as const)(
      "shows the %s %s notice in the desktop composer",
      async (locale, key, permission) => {
        await open(live(permission), locale);
        const copy = permissionModeCopy[locale];
        const trigger = await screen.findByRole("button", {
          name: permissionModeSummaryCopy[locale][key],
        });
        expect(trigger).toHaveAttribute("aria-expanded", "false");
        expect(screen.getByText(copy[key])).not.toBeVisible();
        fireEvent.click(trigger);
        await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
        await waitFor(() => expect(shown(copy[key])).toBe(true));
        expect(screen.getByText(copy[key])).toBeVisible();
        for (const other of [
          "auto",
          "dontAsk",
          "bypassPermissions",
          "possiblyAuto",
          "previous",
        ] as const)
          if (other !== key) expect(shown(copy[other])).toBe(false);
        fireEvent.click(trigger);
        await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
        expect(screen.getByText(copy[key])).not.toBeVisible();
      },
    );

    it.each([
      ["default", { mode: "default" }],
      ["an unknown mode without a hint", { mode: null }],
      ["no permission field", undefined],
    ] as const)("shows no notice for %s", async (_name, permission) => {
      await open(live(permission));
      const copy = permissionModeCopy["zh-CN"];
      for (const key of [
        "auto",
        "dontAsk",
        "bypassPermissions",
        "possiblyAuto",
        "previous",
      ] as const)
        expect(shown(copy[key])).toBe(false);
    });

    it("updates from native patches and shows the previous-mode suffix", async () => {
      const fixture = await open(live({ mode: null, possiblyAuto: true }), "en-US");
      const copy = permissionModeCopy["en-US"];
      const summary = permissionModeSummaryCopy["en-US"];
      const trigger = await screen.findByRole("button", { name: summary.possiblyAuto });
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));
      await waitFor(() => expect(shown(copy.possiblyAuto)).toBe(true));
      fixture.patch({ revision: 2, permission: { mode: "auto" } });
      await waitFor(() => expect(shown(copy.auto)).toBe(true));
      expect(screen.getByRole("button", { name: summary.auto })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(screen.getByText(copy.auto)).toBeVisible();
      expect(shown(copy.possiblyAuto)).toBe(false);
      fixture.patch({ revision: 3, permission: { mode: "auto", previous: true } });
      await waitFor(() => expect(shown(copy.previous)).toBe(true));
      expect(
        screen.getByRole("button", { name: `${summary.auto} · ${summary.previous}` }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText(copy.previous)).toBeVisible();
      fixture.patch({ revision: 4, permission: { mode: null } });
      await waitFor(() => expect(shown(copy.auto)).toBe(false));
      expect(shown(copy.previous)).toBe(false);
    });
  });
});
