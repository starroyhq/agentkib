import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Access, Live, LivePermission } from "@agentkib/web-client";
import { WebApplication } from "@/router";

// Live fixtures are hand-built: they mimic the projected shape and contain no real session data.
type ModeCase = { name: string; permission?: LivePermission };
const cases: ModeCase[] = [
  { name: "default", permission: { mode: "default" } },
  { name: "plan", permission: { mode: "plan" } },
  { name: "acceptEdits", permission: { mode: "acceptEdits" } },
  { name: "auto", permission: { mode: "auto" } },
  { name: "dontAsk", permission: { mode: "dontAsk" } },
  { name: "bypassPermissions", permission: { mode: "bypassPermissions" } },
  { name: "unknown", permission: { mode: null } },
  { name: "unknown with the version hint", permission: { mode: null, possiblyAuto: true } },
  { name: "no permission field" },
  { name: "a previously observed auto mode", permission: { mode: "auto", previous: true } },
];

const FORBIDDEN_NOTICE_TEXT =
  /auto[:：]|dontAsk[:：]|don't-ask|分类器审批|分類器審批|classifier approves|不弹出审批|不彈出審批|no approval prompts|权限模式未确认|權限模式未確認|Mode unconfirmed|権限モード未確認|権限チェックを省略/i;

class ClaudeEventSource {
  static live: () => Live;
  static instances = new Set<ClaudeEventSource>();
  seq = 0;
  listeners: Record<string, (event: MessageEvent) => void> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
    ClaudeEventSource.instances.delete(this);
  }
  constructor(path: string) {
    if (!new URL(path, "http://localhost").searchParams.has("sessionId")) return;
    ClaudeEventSource.instances.add(this);
    queueMicrotask(() => {
      if (!this.closed) this.emit("snapshot", { live: ClaudeEventSource.live() });
    });
  }
  emit(type: string, payload: unknown) {
    this.seq++;
    this.listeners["session-event"]?.(
      new MessageEvent("session-event", {
        data: JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "claude-stream",
          sessionId: "session",
          runtimeBootId: "runtime",
          epoch: "claude",
          seq: this.seq,
          cursor: `claude-${this.seq}`,
          type,
          payload,
        }),
      }),
    );
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners[name] = listener;
  }
}

function createHost(permission?: LivePermission) {
  const access: Access = {
    status: "approved",
    protocolVersion: 2,
    csrfToken: "csrf",
    bootId: "boot",
    experimentalEnabled: true,
    device: {
      id: "browser",
      name: "Phone",
      accessMode: "full",
      send: true,
      approve: true,
      manage: true,
      advancedControl: true,
      organize: true,
      settings: true,
      files: true,
      attachments: true,
    },
  };
  const live = {
    sessionId: "session",
    status: "idle",
    revision: 1,
    executionMode: "claude-managed",
    cliVersion: "2.1.296 (Claude Code)",
    sendEnabled: true,
    approvals: [],
    questions: [],
    ...(permission ? { permission } : {}),
  } as Live;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/web/v1/", "");
    if (path === "access") return Response.json(access);
    if (path === "catalog")
      return Response.json({
        indexEnabled: true,
        workspaces: [{ id: "workspace", name: "Project", path: "/project" }],
        sessions: [
          {
            id: "session",
            workspace_id: "workspace",
            agent: "claude-code",
            title: "Claude permission session",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      });
    if (path === "events")
      return Response.json({
        events: [
          {
            id: "reply",
            kind: "agent-message",
            content: "Claude history",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    if (path === "live") return Response.json(live);
    if (path === "managed/capabilities")
      return Response.json({ sessionId: "session", features: { send: { available: true } } });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("EventSource", ClaudeEventSource);
  ClaudeEventSource.live = () => live;
  return { live, fetcher };
}

async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Claude permission session/ }));
  await screen.findByText("Claude history");
}

function expectNoPermissionNoticeBanner() {
  for (const status of screen.queryAllByRole("status")) {
    expect(status.textContent ?? "").not.toMatch(FORBIDDEN_NOTICE_TEXT);
    expect(status.textContent ?? "").not.toContain("跳过权限检查");
  }
  expect(screen.queryByText(FORBIDDEN_NOTICE_TEXT)).toBeNull();
}

describe("Web Claude session composer permission modes", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("scrollTo", vi.fn());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(cases)(
    "renders no permission notice bar above the composer for $name",
    async ({ permission }) => {
      createHost(permission);
      await openSession();
      await act(async () => {});
      expectNoPermissionNoticeBanner();
    },
  );

  it("never shows a permission notice bar across live permission mode transitions", async () => {
    createHost({ mode: null, possiblyAuto: true });
    await openSession();
    const stream = [...ClaudeEventSource.instances][0]!;
    await act(async () => {});
    expectNoPermissionNoticeBanner();

    const patches: LivePermission[] = [
      { mode: "auto" },
      { mode: "bypassPermissions" },
      { mode: "default" },
      { mode: "dontAsk", previous: true },
      { mode: null },
    ];
    for (const [index, permission] of patches.entries()) {
      act(() => stream.emit("state", { revision: index + 2, permission }));
      await act(async () => {});
      expectNoPermissionNoticeBanner();
    }
  });
});
