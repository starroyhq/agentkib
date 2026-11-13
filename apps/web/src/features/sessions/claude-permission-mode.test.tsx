import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Access, Live, LivePermission } from "@agentkib/web-client";
import { WebApplication } from "@/router";
import { PermissionModeNotice } from "../conversation/features/sessions/permission-mode-notice";
import {
  permissionModeCopy,
  permissionModeSummaryCopy,
} from "../conversation/features/sessions/permission-mode-copy";
import type { Locale } from "../conversation/i18n";

const locales: Locale[] = ["zh-CN", "zh-Hant", "en-US", "ja-JP"];
const noticeKeys = ["auto", "dontAsk", "bypassPermissions", "possiblyAuto", "previous"] as const;
const copy = permissionModeCopy["zh-CN"];

// Live fixtures are hand-built: they mimic the projected shape and contain no real session data.
type ModeCase = { name: string; permission?: LivePermission; text?: string; follow?: string };
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
    follow: copy.previous,
  },
];

describe("permission mode notice", () => {
  afterEach(cleanup);

  it.each(locales)(
    "keeps compact risk labels and expandable complete explanations in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions", null] as const) {
        const view = render(
          <PermissionModeNotice
            locale={locale}
            permission={{ mode, possiblyAuto: true, ...(mode !== null ? { previous: true } : {}) }}
            compact
          />,
        );
        const key = mode ?? "possiblyAuto";
        const summary = view.container.querySelector("summary")!;
        expect(summary).toHaveTextContent(permissionModeSummaryCopy[locale][key]);
        expect(summary).toHaveClass("min-h-11");
        const details = summary.parentElement!;
        expect(details).not.toHaveAttribute("open");
        const explanation = screen.getByText(permissionModeCopy[locale][key], { exact: false });
        expect(explanation).not.toBeVisible();
        fireEvent.click(summary);
        expect(details).toHaveAttribute("open");
        expect(explanation).toBeVisible();
        if (mode !== null) {
          const previous = screen.getByText(permissionModeCopy[locale].previous);
          expect(previous).toBeVisible();
          expect(previous.className).not.toMatch(/\bopacity-\d+/);
        }
        view.unmount();
      }
    },
  );

  it.each(locales)(
    "keeps the previous-mode explanation fully readable without compact disclosure in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions"] as const) {
        const view = render(
          <PermissionModeNotice permission={{ mode, previous: true }} locale={locale} />,
        );
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(permissionModeCopy[locale][mode]);
        const previous = screen.getByText(permissionModeCopy[locale].previous);
        expect(previous).toBeVisible();
        expect(previous.className).not.toMatch(/\bopacity-\d+/);
        expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        expect(screen.queryByRole("button")).toBeNull();
        view.unmount();
      }
    },
  );

  it.each(locales)("has complete, distinct copy for %s", (locale) => {
    const own = permissionModeCopy[locale];
    expect(Object.keys(own).sort()).toEqual([...noticeKeys].sort());
    for (const key of noticeKeys) expect(own[key].trim().length).toBeGreaterThan(10);
    expect(new Set(noticeKeys.map((key) => own[key])).size).toBe(noticeKeys.length);
    // The wording names the mode it describes, and the hint names the version that introduced it.
    expect(own.auto).toContain("auto");
    expect(own.dontAsk).toMatch(/dontAsk|don't-ask/);
    expect(own.possiblyAuto).toContain("2.1.285");
    expect(own.possiblyAuto).toContain("auto");
    if (locale !== "zh-CN") expect(own.auto).not.toBe(permissionModeCopy["zh-CN"].auto);
  });

  it.each(locales)(
    "renders every restrictive mode in %s as accessible text, not color alone",
    (locale) => {
      const own = permissionModeCopy[locale];
      for (const [mode, text] of [
        ["auto", own.auto],
        ["dontAsk", own.dontAsk],
        ["bypassPermissions", own.bypassPermissions],
      ] as const) {
        const view = render(<PermissionModeNotice permission={{ mode }} locale={locale} />);
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(text);
        expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        view.unmount();
      }
    },
  );

  it.each(locales)("renders the unknown-mode hint and the previous suffix in %s", (locale) => {
    const own = permissionModeCopy[locale];
    const hint = render(
      <PermissionModeNotice permission={{ mode: null, possiblyAuto: true }} locale={locale} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(own.possiblyAuto);
    hint.unmount();
    render(<PermissionModeNotice permission={{ mode: "auto", previous: true }} locale={locale} />);
    expect(screen.getByRole("status")).toHaveTextContent(own.auto);
    expect(screen.getByRole("status")).toHaveTextContent(own.previous);
  });

  it.each(cases.filter((item) => !item.text))("renders nothing for $name", ({ permission }) => {
    const { container } = render(<PermissionModeNotice permission={permission} locale="zh-CN" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not turn a missing mode into a possibly-auto guess without the backend hint", () => {
    const { container } = render(
      <PermissionModeNotice permission={{ mode: null }} locale="en-US" />,
    );
    expect(container).toBeEmptyDOMElement();
    // The hint only applies to an unknown mode; a known mode wins.
    const known = render(
      <PermissionModeNotice permission={{ mode: "default", possiblyAuto: true }} locale="en-US" />,
    );
    expect(known.container).toBeEmptyDOMElement();
  });

  it("marks the bypass mode more strongly than the other restrictive modes", () => {
    const strong = render(
      <PermissionModeNotice permission={{ mode: "bypassPermissions" }} locale="en-US" />,
    );
    const bypassClass = screen.getByRole("status").className;
    strong.unmount();
    render(<PermissionModeNotice permission={{ mode: "auto" }} locale="en-US" />);
    expect(screen.getByRole("status").className).not.toBe(bypassClass);
  });
});

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
// The compact composer keeps the risk visible and lets users open its full status explanation.
function expandExplanation(text: string) {
  const status = screen
    .queryAllByRole("status", { hidden: true })
    .find((element) => element.textContent?.includes(text));
  const details = status?.closest("details");
  if (details && !details.hasAttribute("open")) fireEvent.click(details.querySelector("summary")!);
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(cases)("shows the right notice for $name", async ({ permission, text, follow }) => {
    createHost(permission);
    await openSession();
    if (text)
      await waitFor(() => {
        expandExplanation(text);
        expect(shown(text)).toBe(true);
      });
    else await act(async () => {});
    if (follow) expect(shown(follow)).toBe(true);
    // Only the notice that matches the reported state may be on screen.
    for (const key of noticeKeys) {
      if (copy[key] === text || copy[key] === follow) continue;
      expect(shown(copy[key])).toBe(false);
    }
  });

  it("follows the CLI report from the live stream and drops the notice when it is cleared", async () => {
    createHost({ mode: null, possiblyAuto: true });
    await openSession();
    const stream = [...ClaudeEventSource.instances][0]!;
    await waitFor(() => {
      expandExplanation(copy.possiblyAuto);
      expect(shown(copy.possiblyAuto)).toBe(true);
    });

    act(() => stream.emit("state", { revision: 2, permission: { mode: "auto" } }));
    await waitFor(() => {
      expandExplanation(copy.auto);
      expect(shown(copy.auto)).toBe(true);
    });
    expect(shown(copy.possiblyAuto)).toBe(false);

    act(() => stream.emit("state", { revision: 3, permission: { mode: "bypassPermissions" } }));
    await waitFor(() => {
      expandExplanation(copy.bypassPermissions);
      expect(shown(copy.bypassPermissions)).toBe(true);
    });
    expect(shown(copy.auto)).toBe(false);

    act(() => stream.emit("state", { revision: 4, permission: { mode: "default" } }));
    await waitFor(() => expect(shown(copy.bypassPermissions)).toBe(false));

    act(() =>
      stream.emit("state", { revision: 5, permission: { mode: "dontAsk", previous: true } }),
    );
    await waitFor(() => {
      expandExplanation(copy.dontAsk);
      expect(shown(copy.dontAsk)).toBe(true);
    });
    expect(shown(copy.previous)).toBe(true);

    // A release or an unknown state sends an explicit clear; the old notice must not linger.
    act(() => stream.emit("state", { revision: 6, permission: { mode: null } }));
    await waitFor(() => expect(shown(copy.dontAsk)).toBe(false));
    expect(shown(copy.previous)).toBe(false);
  });
});
