import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Access, Live, LivePermission } from "@agentkib/web-client";
import { WebApplication } from "@/router";
import { render as renderWithPlatform } from "../conversation/web-reader-test-utils";
import { PermissionModeNotice, permissionModeSummaryCopy } from "@agentkib/session-ui";
import type { Locale } from "../conversation/i18n";
import { TestSseConnection } from "@/sse-test-fixture";

const locales: Locale[] = ["zh-CN", "zh-Hant", "en-US", "ja-JP"];
const noticeKeys = ["auto", "dontAsk", "bypassPermissions", "possiblyAuto"] as const;
const copy = permissionModeSummaryCopy["zh-CN"];

// Live fixtures are hand-built: they mimic the projected shape and contain no real session data.
type ModeCase = { name: string; permission?: LivePermission; text?: string };
const cases: ModeCase[] = [
  { name: "default", permission: { mode: "default" } },
  { name: "plan", permission: { mode: "plan" } },
  { name: "acceptEdits", permission: { mode: "acceptEdits" } },
  { name: "auto", permission: { mode: "auto" }, text: copy.auto },
  { name: "dontAsk", permission: { mode: "dontAsk" }, text: copy.dontAsk },
  {
    name: "bypassPermissions",
    permission: { mode: "bypassPermissions" },
    text: copy.bypassPermissions,
  },
  { name: "unknown", permission: { mode: null } },
  {
    name: "unknown with the version hint",
    permission: { mode: null, possiblyAuto: true },
    text: copy.possiblyAuto,
  },
  { name: "no permission field" },
  {
    name: "a previously observed auto mode",
    permission: { mode: "auto", previous: true },
    text: copy.auto,
  },
];

describe("permission mode notice", () => {
  afterEach(cleanup);

  it.each(locales)(
    "keeps compact risk labels without expandable explanatory prose in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions", null] as const) {
        const view = renderWithPlatform(
          <PermissionModeNotice
            locale={locale}
            permission={{ mode, possiblyAuto: true, ...(mode !== null ? { previous: true } : {}) }}
            compact
          />,
        );
        const key = mode ?? "possiblyAuto";
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(permissionModeSummaryCopy[locale][key]);
        expect(notice).not.toHaveTextContent(
          /由分类器审核操作|Shift\+Tab|auto mode is active|change it in the original/i,
        );
        expect(view.container.querySelector("details")).toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
        view.unmount();
      }
    },
  );

  it.each(locales)("renders the same concise status label without compact mode in %s", (locale) => {
    for (const mode of ["auto", "dontAsk", "bypassPermissions"] as const) {
      const view = renderWithPlatform(
        <PermissionModeNotice permission={{ mode, previous: true }} locale={locale} />,
      );
      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(permissionModeSummaryCopy[locale][mode]);
      expect(notice).not.toHaveTextContent(
        /由分类器审核操作|Shift\+Tab|auto mode is active|change it in the original/i,
      );
      expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("button")).toBeNull();
      view.unmount();
    }
  });

  it.each(locales)("has complete, distinct summary copy for %s", (locale) => {
    const own = permissionModeSummaryCopy[locale];
    for (const key of noticeKeys) expect(own[key].trim().length).toBeGreaterThan(2);
    expect(new Set(noticeKeys.map((key) => own[key])).size).toBe(noticeKeys.length);
    if (locale !== "zh-CN") expect(own.auto).not.toBe(permissionModeSummaryCopy["zh-CN"].auto);
  });

  it.each(locales)(
    "renders every restrictive mode in %s as accessible text, not color alone",
    (locale) => {
      const own = permissionModeSummaryCopy[locale];
      for (const [mode, text] of [
        ["auto", own.auto],
        ["dontAsk", own.dontAsk],
        ["bypassPermissions", own.bypassPermissions],
      ] as const) {
        const view = renderWithPlatform(
          <PermissionModeNotice permission={{ mode }} locale={locale} />,
        );
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(text);
        expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        view.unmount();
      }
    },
  );

  it.each(locales)("renders the unknown-mode label in %s", (locale) => {
    const own = permissionModeSummaryCopy[locale];
    const hint = renderWithPlatform(
      <PermissionModeNotice permission={{ mode: null, possiblyAuto: true }} locale={locale} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(own.possiblyAuto);
    hint.unmount();
    renderWithPlatform(
      <PermissionModeNotice permission={{ mode: "auto", previous: true }} locale={locale} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(own.auto);
  });

  it.each(cases.filter((item) => !item.text))("renders nothing for $name", ({ permission }) => {
    const { container } = renderWithPlatform(
      <PermissionModeNotice permission={permission} locale="zh-CN" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("does not turn a missing mode into a possibly-auto guess without the backend hint", () => {
    const { container } = renderWithPlatform(
      <PermissionModeNotice permission={{ mode: null }} locale="en-US" />,
    );
    expect(container).toBeEmptyDOMElement();
    // The hint only applies to an unknown mode; a known mode wins.
    const known = renderWithPlatform(
      <PermissionModeNotice permission={{ mode: "default", possiblyAuto: true }} locale="en-US" />,
    );
    expect(known.container).toBeEmptyDOMElement();
  });

  it("marks the bypass mode more strongly than the other restrictive modes", () => {
    const strong = renderWithPlatform(
      <PermissionModeNotice permission={{ mode: "bypassPermissions" }} locale="en-US" />,
    );
    const bypassClass = screen.getByRole("status").className;
    strong.unmount();
    renderWithPlatform(<PermissionModeNotice permission={{ mode: "auto" }} locale="en-US" />);
    expect(screen.getByRole("status").className).not.toBe(bypassClass);
  });
});

class ClaudeConnection extends TestSseConnection {
  static instances: ClaudeConnection[] = [];
  private seq = 0;

  constructor(signal: AbortSignal | null | undefined, initial: () => Live) {
    super(signal);
    ClaudeConnection.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed) this.sessionEvent("snapshot", { live: initial() });
    });
  }

  sessionEvent(type: string, payload: unknown) {
    this.seq++;
    this.emit("session-event", {
      protocolVersion: 2,
      subscriptionId: "claude-stream",
      sessionId: "session",
      runtimeBootId: "runtime",
      epoch: "claude",
      seq: this.seq,
      cursor: `claude-${this.seq}`,
      type,
      payload,
    });
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
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/web/v1/", "");
    if (path === "stream")
      return url.searchParams.has("sessionId")
        ? new ClaudeConnection(init?.signal, () => live).response
        : new TestSseConnection(init?.signal).response;
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
  return { live, fetcher };
}
async function openSession() {
  render(<WebApplication />);
  fireEvent.click(await screen.findByRole("button", { name: /Claude permission session/ }));
  await screen.findByText("Claude history");
}
// Other status lines never carry these texts.
const shown = (text: string) =>
  screen.queryAllByRole("status").some((element) => element.textContent?.includes(text));

describe("Web Claude session permission notice", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("scrollTo", vi.fn());
  });
  afterEach(() => {
    cleanup();
    ClaudeConnection.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(cases)("shows the right notice for $name", async ({ permission, text }) => {
    createHost(permission);
    await openSession();
    if (text) await waitFor(() => expect(shown(text)).toBe(true));
    else await act(async () => {});
    // Only the notice that matches the reported state may be on screen.
    for (const key of noticeKeys) {
      if (copy[key] === text) continue;
      expect(shown(copy[key])).toBe(false);
    }
  });

  it("follows the CLI report from the live stream and drops the notice when it is cleared", async () => {
    createHost({ mode: null, possiblyAuto: true });
    await openSession();
    const stream = ClaudeConnection.instances.find((source) => !source.closed)!;
    await waitFor(() => expect(shown(copy.possiblyAuto)).toBe(true));

    act(() => stream.sessionEvent("state", { revision: 2, permission: { mode: "auto" } }));
    await waitFor(() => expect(shown(copy.auto)).toBe(true));
    expect(shown(copy.possiblyAuto)).toBe(false);

    act(() =>
      stream.sessionEvent("state", { revision: 3, permission: { mode: "bypassPermissions" } }),
    );
    await waitFor(() => expect(shown(copy.bypassPermissions)).toBe(true));
    expect(shown(copy.auto)).toBe(false);

    act(() => stream.sessionEvent("state", { revision: 4, permission: { mode: "default" } }));
    await waitFor(() => expect(shown(copy.bypassPermissions)).toBe(false));

    act(() =>
      stream.sessionEvent("state", {
        revision: 5,
        permission: { mode: "dontAsk", previous: true },
      }),
    );
    await waitFor(() => expect(shown(copy.dontAsk)).toBe(true));

    // A release or an unknown state sends an explicit clear; the old notice must not linger.
    act(() => stream.sessionEvent("state", { revision: 6, permission: { mode: null } }));
    await waitFor(() => expect(shown(copy.dontAsk)).toBe(false));
  });
});
