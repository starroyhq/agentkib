// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { createContext, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Approval, type UserQuestionRequest } from "@agentkib/web-client";
import { fillCopy, interactionCardCopy, type InteractionLocale } from "@agentkib/session-ui";
import { conversationWords } from "@/core/i18n";
import { SessionReader } from "./desktop-session-reader";
import { useSession } from "../../desktop-session-context";
import { sessionReason } from "../../session-copy";

vi.mock("../../desktop-session-context", () => ({ useSession: vi.fn() }));
vi.mock("./desktop-session-operations", () => ({ DesktopSessionOperations: () => null }));

type Session = ReturnType<typeof useSession>;
const TestSession = createContext<Session | null>(null);
let state: Session;
function useTestSession() {
  return useContext(TestSession) ?? state;
}
const locales = ["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const;
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
  vi.mocked(useSession).mockImplementation(useTestSession);
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
    for (const name of [t.allow, t.deny]) {
      const choice = within(card()).getByRole("button", { name });
      expect(choice).toBeVisible();
      expect(choice).toBeDisabled();
      expect(choice).toHaveAttribute("title", t.noApprovePermission);
      fireEvent.click(choice);
    }
    expect(within(card()).queryByText(t.noApprovePermission)).not.toBeInTheDocument();
    fireEvent.keyDown(card(), { key: "1" });
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
    const view = render(
      <TestSession value={state}>
        <SessionReader />
      </TestSession>,
    );
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
    view.rerender(
      <TestSession value={state}>
        <SessionReader />
      </TestSession>,
    );
    expect(
      within(card()).getByRole("heading", { name: "允许 Codex 编辑以下文件吗？" }),
    ).toBeVisible();
    expect(within(card()).getByText("1/2")).toBeVisible();
    state = { ...state, live: { ...state.live!, approvals: [next] } };
    view.rerender(
      <TestSession value={state}>
        <SessionReader />
      </TestSession>,
    );
    expect(screen.queryByText("1/2")).not.toBeInTheDocument();
    expect(within(card()).getByText("notes.md")).toBeVisible();
    expect(state.control).not.toHaveBeenCalled();
  });
});

describe("managed Claude interactions", () => {
  beforeEach(() => {
    state = {
      ...state,
      client: new WebClient(vi.fn()),
      current: { ...state.current!, agent: "claude-code" },
      access: {
        ...state.access!,
        status: "approved",
        experimentalEnabled: true,
        bootId: "fixture-boot",
        device: {
          id: "device",
          name: "Desktop",
          send: true,
          approve: true,
          accessMode: "full",
          advancedControl: true,
        },
      },
      live: { ...state.live!, executionMode: "claude-managed" },
    };
  });

  it("shows a native approval and submits the selected choice", () => {
    const request = approval({ toolName: "Read", input: { file_path: "notes.txt" } });
    state.live = { ...state.live!, status: "waiting-approval", approvals: [request] };
    render(<SessionReader />);
    const deny = within(card()).getByRole("button", { name: interactionCardCopy("en-US").deny });
    expect(deny).toBeEnabled();
    fireEvent.click(deny);
    expect(state.control).toHaveBeenCalledExactlyOnceWith("approve", request, "deny");
  });

  it("shows the live AskUserQuestion options and submits their original labels", () => {
    const request: UserQuestionRequest = {
      requestId: "question",
      turnId: "turn",
      supported: true,
      questions: [
        {
          id: "Pick a format",
          question: "Pick a format",
          options: [{ label: "Markdown" }, { label: "Plain text" }],
          multiSelect: false,
          allowCustom: true,
        },
      ],
    };
    state.live = { ...state.live!, status: "waiting-input", questions: [request] };
    render(<SessionReader />);
    expect(screen.getByRole("heading", { name: "Pick a format" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(state.control).toHaveBeenCalledExactlyOnceWith("answer", undefined, undefined, request, {
      "Pick a format": ["Markdown"],
    });
  });
});

it("shows the reported Claude tool permission even when no choices are available", async () => {
  const client = new WebClient(vi.fn());
  vi.spyOn(client, "sessionSettings").mockResolvedValue({
    sessionId: "session",
    revision: 1,
    available: true,
    current: { permissionMode: "default" },
    defaults: {},
    writable: {
      model: { available: false },
      effort: { available: false },
      mode: { available: false },
      policy: { available: false },
      serviceTier: { available: false },
      restoreDefaults: { available: false },
      permissionMode: { available: false },
    },
    options: { models: [], policies: [], serviceTiers: [], permissionModes: [] },
  });
  state = {
    ...state,
    access: {
      ...state.access!,
      status: "approved",
      experimentalEnabled: true,
      device: {
        id: "device",
        name: "Desktop",
        send: true,
        approve: false,
        accessMode: "full",
        advancedControl: true,
      },
    },
    client,
    current: { ...state.current!, agent: "claude-code" },
    live: { ...state.live!, executionMode: "claude-managed" },
    capabilities: {
      sessionId: "session",
      executionMode: "claude-managed",
      status: "idle",
      features: { "settings-state": { available: true }, settings: { available: false } },
    },
  };
  render(<SessionReader />);
  const trigger = await screen.findByRole("button", { name: "Tool permissions: Manual approval" });
  expect(within(trigger).getByText("Manual approval")).toBeVisible();
  expect(trigger).toBeDisabled();
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu", { name: "Tool permissions" })).not.toBeInTheDocument();
  expect(state.control).not.toHaveBeenCalled();
});

function acp() {
  state = {
    ...state,
    // Antigravity has the managed composer, whose settings controls follow the session's client.
    client: {} as never,
    current: { ...state.current!, agent: "antigravity" },
    access: {
      ...state.access!,
      status: "approved",
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
  it("retains Antigravity approval choices and settings controls while disabling them", () => {
    acp();
    const request = approval({
      method: "session/request_permission",
      availableDecisions: ["allow", "deny"],
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });
    state = {
      ...state,
      access: {
        ...state.access!,
        disabledSessionProviders: { antigravity: "antigravity-acp-disabled" },
        device: { ...state.access!.device!, approve: true },
      },
      live: {
        ...state.live!,
        executionMode: "acp-managed",
        reason: "antigravity-acp-disabled",
        approvals: [request],
      },
    };
    render(<SessionReader />);
    for (const name of ["Allow once", "Reject"]) {
      const choice = within(card()).getByRole("button", { name });
      expect(choice).toBeVisible();
      expect(choice).toBeDisabled();
      expect(within(card()).queryByText(choice.title)).toBeNull();
      fireEvent.click(choice);
    }
    expect(screen.getByRole("button", { name: "Select model: Default" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Tool permissions" })).toBeDisabled();
    expect(state.control).not.toHaveBeenCalled();
  });

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
      expect(state.control).toHaveBeenCalledOnce();
      expect(vi.mocked(state.control).mock.calls[0]?.[0]).toBe("send");
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

  it("never sends from a device without send permission", () => {
    acp();
    state = {
      ...state,
      online: false,
      access: { ...state.access!, device: { ...state.access!.device!, send: false } },
    };
    render(<SessionReader />);
    // Antigravity has the managed composer: a local draft stays possible, sending does not.
    const input = screen.getByRole("textbox", { name: state.t.message });
    fireEvent.change(input, { target: { value: "Local draft" } });
    fireEvent.submit(input.closest("form")!);
    const send = screen.queryByRole("button", { name: state.t.send });
    if (send) expect(send).toBeDisabled();
    expect(state.control).not.toHaveBeenCalled();
  });
});

describe("a Claude settings change Claude Code refuses", () => {
  it.each(["claude-model-unsupported", "claude-effort-unsupported"] as const)(
    "leaves %s to the composer's controls on a full-access device and explains it otherwise",
    (reason) => {
      const text = sessionReason("en-US", reason).text;
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

describe("terminal-occupied interactions offer handover inside the card", () => {
  it("shows the terminal handover action and confirmation modal for a terminal-owned Claude approval", () => {
    const runSessionAction = vi.fn().mockResolvedValue({ accepted: true });
    state = {
      ...state,
      locale: "zh-CN",
      t: conversationWords("zh-CN"),
      current: { id: "session", agent: "claude-code" },
      access: {
        protocolVersion: 2,
        experimentalEnabled: false,
        bootId: "boot-1",
        device: { id: "device", approve: true, send: true },
      },
      capabilities: {
        sessionId: "session",
        features: {
          "handover-terminal": { available: true },
        },
      },
      live: {
        sessionId: "session",
        status: "running",
        revision: 4,
        turnId: "turn-terminal",
        sendEnabled: false,
        executionMode: "claude-follower",
        execution: { owner: "terminal", observed: true, confidence: "live" },
        terminalHandover: { available: false, remoteAvailable: true },
        approvals: [approval({ requestId: "req-term", turnId: "turn-terminal" })],
        questions: [],
      },
      runSessionAction,
    } as unknown as Session;
    render(<SessionReader />);
    const region = card();
    expect(
      within(region).getByText(interactionCardCopy("zh-CN").terminalApprovalNotice),
    ).toBeVisible();
    const handoverButton = within(region).getByRole("button", { name: "结束终端并接管" });
    expect(handoverButton).toBeEnabled();
    fireEvent.click(handoverButton);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/结束当前 Claude Code 终端会话/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "结束终端并接管" }));
    expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("handover-terminal", {
      handoffConfirmed: true,
      turnId: "turn-terminal",
    });
  });

  it("shows the terminal handover action inside a read-only observed terminal question card", () => {
    const runSessionAction = vi.fn().mockResolvedValue({ accepted: true });
    const question: UserQuestionRequest = {
      requestId: "q-term",
      turnId: "turn-q",
      supported: false,
      questions: [
        {
          id: "choice",
          header: "Strategy",
          question: "Pick a rollout mode",
          multiSelect: false,
          allowCustom: false,
          options: [{ label: "Canary", description: "Gradual release" }],
        },
      ],
    };
    state = {
      ...state,
      locale: "zh-CN",
      t: conversationWords("zh-CN"),
      current: { id: "session", agent: "claude-code" },
      access: {
        protocolVersion: 2,
        experimentalEnabled: false,
        bootId: "boot-1",
        device: { id: "device", approve: true, send: true },
      },
      capabilities: {
        sessionId: "session",
        features: {
          "handover-terminal": { available: true },
        },
      },
      live: {
        sessionId: "session",
        status: "running",
        revision: 5,
        turnId: "turn-q",
        sendEnabled: false,
        executionMode: "claude-follower",
        execution: { owner: "terminal", observed: true, confidence: "live" },
        terminalHandover: { available: false, remoteAvailable: true },
        approvals: [],
        questions: [question],
      },
      runSessionAction,
    } as unknown as Session;
    render(<SessionReader />);
    const questionCard = screen.getByRole("region", {
      name: interactionCardCopy("zh-CN").waitingAnswer,
    });
    expect(
      within(questionCard).getByText(interactionCardCopy("zh-CN").terminalQuestionNotice),
    ).toBeVisible();
    expect(within(questionCard).getByRole("button", { name: "Canary" })).toBeDisabled();
    const handoverButton = within(questionCard).getByRole("button", { name: "结束终端并接管" });
    expect(handoverButton).toBeEnabled();
    fireEvent.click(handoverButton);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "结束终端并接管" }));
    expect(runSessionAction).toHaveBeenCalledExactlyOnceWith("handover-terminal", {
      handoffConfirmed: true,
      turnId: "turn-q",
    });
  });
});
