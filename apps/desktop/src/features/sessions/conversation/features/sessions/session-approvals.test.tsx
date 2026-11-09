// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@agentkib/web-client";
import { fillCopy, interactionCardCopy, type InteractionLocale } from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";
import { SessionReader } from "./session-reader";
import { useSession } from "./session-context";
import { codexReason } from "./codex-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("./session-operations", () => ({ SessionOperations: () => null }));
vi.mock("./artifact-browser", () => ({ ArtifactBrowser: () => null }));

type Session = ReturnType<typeof useSession>;
let state: Session;
const locales = ["zh-CN", "zh-TW", "en-US", "ja-JP"] as const;
function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    requestId: "request",
    turnId: "turn",
    method: "claude/can_use_tool",
    toolName: "Bash",
    input: { command: "example" },
    availableDecisions: ["allow", "deny"],
    supported: true,
    ...overrides,
  };
}
beforeEach(() => {
  state = {
    selected: "session",
    current: { id: "session", agent: "codex" },
    locale: "en-US",
    t: conversationWords("en-US"),
    access: { protocolVersion: 2, experimentalEnabled: false },
    page: { events: [], warnings: [] },
    live: { sessionId: "session", status: "idle", revision: 1, sendEnabled: true, approvals: [] },
    online: true,
    controlReady: true,
    busy: false,
    canSend: false,
    canStop: false,
    message: "Saved draft",
    setMessage: vi.fn((message: string) => {
      state = { ...state, message };
    }),
    scroll: { current: null },
    setModal: vi.fn(),
    control: vi.fn(),
  } as unknown as Session;
  vi.mocked(useSession).mockImplementation(() => state);
});
afterEach(cleanup);

function card() {
  return screen.getByRole("region", {
    name: interactionCardCopy(state.locale as InteractionLocale).waitingApproval,
  });
}

describe("waiting approvals above the composer", () => {
  it.each(locales)("pages same-tool requests in %s without deciding anything", (locale) => {
    const requests = [
      approval({ requestId: 0 }),
      approval({ requestId: "second" }),
      approval({ requestId: "third", toolName: "Read" }),
    ];
    state = {
      ...state,
      locale,
      t: conversationWords(locale),
      live: { ...state.live!, approvals: requests },
    };
    render(<SessionReader />);
    const t = interactionCardCopy(locale);
    expect(
      within(card()).getByRole("heading", { name: fillCopy(t.commandTitle, { agent: "Codex" }) }),
    ).toBeVisible();
    expect(within(card()).getByText("1/3")).toBeVisible();
    fireEvent.click(within(card()).getByRole("button", { name: t.next }));
    fireEvent.click(within(card()).getByRole("button", { name: t.next }));
    expect(within(card()).getByText("3/3")).toBeVisible();
    // This access cannot approve, so the card says so instead of offering decisions.
    expect(within(card()).getByText(t.noApprovePermission)).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
    expect(state.setMessage).not.toHaveBeenCalled();
  });

  it.each(locales)("names the Codex operation when no tool name is given in %s", (locale) => {
    const requests = ["commandExecution", "fileChange", "permissions"].map((kind) =>
      approval({
        requestId: kind,
        toolName: undefined,
        input: undefined,
        method: `item/${kind}/requestApproval`,
      }),
    );
    state = {
      ...state,
      locale,
      t: conversationWords(locale),
      live: { ...state.live!, approvals: requests },
    };
    render(<SessionReader />);
    const t = interactionCardCopy(locale);
    for (const [index, title] of [t.commandTitle, t.filesTitle, t.permissionsTitle].entries()) {
      expect(
        within(card()).getByRole("heading", { name: fillCopy(title, { agent: "Codex" }) }),
      ).toBeVisible();
      if (index < 2) fireEvent.click(within(card()).getByRole("button", { name: t.next }));
    }
    expect(state.control).not.toHaveBeenCalled();
  });

  it.each([
    ["ACP title", { title: " Read files " }, "Read files"],
    ["missing title", {}, undefined],
    ["whitespace title", { title: " \t " }, undefined],
    ["non-string title", { title: { value: "unsafe" } }, undefined],
    ["array toolCall", [{ title: "unsafe" }], undefined],
    ["null toolCall", null, undefined],
  ])("handles %s without showing raw protocol or object data", (_label, toolCall, expected) => {
    const request = approval({ toolName: " ", method: "session/request_permission", toolCall });
    state.live = { ...state.live!, approvals: [request] };
    render(<SessionReader />);
    const t = interactionCardCopy("en-US");
    expect(
      within(card()).getByRole("heading", {
        name: fillCopy(t.toolTitle, { agent: "Codex", tool: expected ?? t.unknownTool }),
      }),
    ).toBeVisible();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
  });

  it("renders tool text literally", () => {
    const request = approval({
      toolName: "<img src=x onerror=alert(1)>",
      input: { url: "https://example.test" },
    });
    state.live = { ...state.live!, approvals: [request] };
    const view = render(<SessionReader />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(
      within(card()).getByRole("heading", {
        name: "Allow Codex to use <img src=x onerror=alert(1)>?",
      }),
    ).toBeVisible();
    expect(request.input).toEqual({ url: "https://example.test" });
  });

  it("follows changing requests and language without deciding anything", () => {
    const original = approval({
      requestId: "old",
      toolName: undefined,
      input: undefined,
      method: "item/fileChange/requestApproval",
    });
    state.live = { ...state.live!, approvals: [original] };
    const view = render(<SessionReader />);
    expect(
      within(card()).getByRole("heading", { name: "Allow Codex to edit the following files?" }),
    ).toBeVisible();
    const next = approval({
      requestId: "new",
      toolName: "Write",
      input: { file_path: "notes.md" },
    });
    state = {
      ...state,
      locale: "zh-CN",
      t: conversationWords("zh-CN"),
      live: { ...state.live!, approvals: [original, next] },
    };
    view.rerender(<SessionReader />);
    expect(
      within(card()).getByRole("heading", { name: "允许 Codex 编辑以下文件吗？" }),
    ).toBeVisible();
    expect(within(card()).getByText("1/2")).toBeVisible();
    state.live = { ...state.live!, approvals: [next] };
    view.rerender(<SessionReader />);
    expect(screen.queryByText("1/2")).not.toBeInTheDocument();
    expect(within(card()).getByText("notes.md")).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
  });
});

function acp() {
  state = {
    ...state,
    current: { ...state.current!, agent: "antigravity" },
    access: {
      ...state.access!,
      experimentalEnabled: true,
      device: {
        id: "device",
        name: "Browser",
        approve: false,
        send: true,
        accessMode: "full",
        advancedControl: true,
      },
    },
  };
}
describe("ACP disconnected draft", () => {
  it.each(locales)(
    "keeps editing and focus while offline, with no send or automatic replay in %s",
    (locale) => {
      acp();
      state = { ...state, locale, t: conversationWords(locale), canSend: true };
      const view = render(<SessionReader />);
      const input = screen.getByRole("textbox", { name: state.t.message });
      input.focus();
      // Even a stale canSend cannot turn a disconnected form submission into a dispatch.
      state = { ...state, online: false, controlReady: false };
      view.rerender(<SessionReader />);
      expect(screen.getByRole("textbox", { name: state.t.message })).toBe(input);
      expect(input).toBeEnabled();
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: "Edited offline" } });
      view.rerender(<SessionReader />);
      expect(input).toHaveValue("Edited offline");
      expect(screen.getByRole("button", { name: state.t.send })).toBeDisabled();
      fireEvent.submit(input.closest("form")!);
      expect(state.control).not.toHaveBeenCalled();
      state = { ...state, online: true, controlReady: true };
      view.rerender(<SessionReader />);
      expect(input).toHaveValue("Edited offline");
      expect(state.control).not.toHaveBeenCalled();
      fireEvent.submit(input.closest("form")!);
      expect(state.control).toHaveBeenCalledExactlyOnceWith("send");
    },
  );

  it("keeps the existing busy and compacting restrictions", () => {
    acp();
    state = { ...state, online: false, busy: true, canSend: false };
    const view = render(<SessionReader />);
    const input = screen.getByRole("textbox", { name: state.t.message });
    expect(input).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(state.control).not.toHaveBeenCalled();
    state = {
      ...state,
      online: true,
      busy: false,
      canSend: true,
      live: { ...state.live!, activity: "compacting" },
    };
    view.rerender(<SessionReader />);
    expect(input).toBeEnabled();
    expect(screen.getByRole("button", { name: state.t.send })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(state.control).not.toHaveBeenCalled();
  });

  it("does not expose an editor without existing send permission", () => {
    acp();
    state = {
      ...state,
      online: false,
      access: { ...state.access!, device: { ...state.access!.device!, send: false } },
    };
    render(<SessionReader />);
    expect(screen.queryByRole("textbox", { name: state.t.message })).not.toBeInTheDocument();
    expect(state.control).not.toHaveBeenCalled();
  });
});

describe("a Claude settings change Claude Code refuses", () => {
  it.each(["claude-model-unsupported", "claude-effort-unsupported"] as const)(
    "leaves %s to the composer's controls on a full-access device and explains it otherwise",
    (reason) => {
      const text = codexReason("en-US", reason).text;
      state = {
        ...state,
        current: { ...state.current!, agent: "claude-code" },
        notice: "notDispatched",
        noticeReason: reason,
        access: { ...state.access!, device: { id: "device", accessMode: "full" } },
      } as unknown as typeof state;
      const view = render(<SessionReader />);
      expect(screen.queryByText(text)).not.toBeInTheDocument();
      expect(screen.queryByText(state.t.notDispatched)).not.toBeInTheDocument();
      // A device without full access has no composer controls to show it.
      state = {
        ...state,
        access: { ...state.access!, device: { id: "device" } },
      } as unknown as typeof state;
      view.rerender(<SessionReader />);
      expect(screen.getByText(text)).toBeVisible();
      expect(screen.queryByText(state.t.notDispatched)).not.toBeInTheDocument();
    },
  );
});
