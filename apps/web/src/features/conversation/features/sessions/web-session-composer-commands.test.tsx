// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionProviderDeclaration, type ClaudeCommandEntry } from "@agentkib/web-client";
import { commandPrompt, slashCommandCopy } from "@agentkib/session-ui";
import { SessionComposer } from "@/features/conversation/web-session-composer";
import { sessionCopy, sessionReason } from "../../session-copy";
import type { ComposerControlsHandle, ComposerPlanState } from "@agentkib/session-ui";
import type { SessionPanels } from "@agentkib/session-ui";
import type { SessionController } from "../../web-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  runSessionAction: vi.fn(),
  panels: null as SessionPanels | null,
  open: vi.fn<ComposerControlsHandle["open"]>(),
  // Turns plan mode on; the controls report whether it is on and can be switched.
  plan: vi.fn<() => boolean>(),
  planState: { on: false, available: false } as ComposerPlanState,
}));
vi.mock("../../web-session-navigation", () => ({ useSessionNavigate: () => vi.fn() }));
vi.mock("../../web-session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("@agentkib/session-ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentkib/session-ui")>()),
  useSessionPanels: () => doubles.panels,
  SessionContextUsageGauge: () => null,
  SessionComposerControls: ({
    action,
    controlsRef,
    onPlan,
  }: {
    action: ReactNode;
    controlsRef?: Ref<ComposerControlsHandle>;
    onPlan?: (state: ComposerPlanState) => void;
  }) => {
    useImperativeHandle(controlsRef, () => ({ open: doubles.open, plan: doubles.plan }));
    useEffect(() => onPlan?.(doubles.planState), [onPlan]);
    return <>{action}</>;
  },
}));

// Entries as CLI 2.1.311 reported them (descriptions shortened); probe-skill is synthetic.
const catalog: ClaudeCommandEntry[] = [
  { name: "probe-skill", description: "A probe skill (project)" },
  { name: "code-review", builtin: true, aliases: ["review"], description: "Review the diff" },
  { name: "loop", builtin: true, aliases: ["proactive"], description: "Run on an interval" },
  { name: "clear", builtin: true, aliases: ["reset", "new"], description: "New session" },
  { name: "compact", builtin: true, description: "Free up context" },
  { name: "config", builtin: true, aliases: ["settings"], argumentHint: "key=value" },
  { name: "output-style", builtin: true, argumentHint: "[style]" },
  { name: "heapdump", builtin: true },
  { name: "model", builtin: true, argumentHint: "<model>", description: "Set the AI model" },
  { name: "rename", builtin: true, aliases: ["name"] },
  { name: "usage", builtin: true, aliases: ["cost", "stats"], description: "Show usage" },
  { name: "goal", builtin: true },
];

function renderComposer(message: string) {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: message } });
  return { ...view, input, form: input.closest("form")! };
}
const options = () =>
  within(screen.getByRole("listbox", { name: "Claude Code commands" }))
    .getAllByRole("option")
    .map((option) => option.textContent);
const reason = (code: string) => sessionReason("en-US", code, "web").text;
// With full access the composer renders its settings and goal controls.
const fullDevice = {
  id: "device",
  name: "Test device",
  send: true,
  approve: false,
  accessMode: "full",
} satisfies NonNullable<SessionController["access"]>["device"];

describe("slash commands in the Web composer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.runSessionAction.mockResolvedValue({ accepted: true });
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "claude-code" } as SessionController["current"],
      locale: "en-US",
      t: { message: "Message", send: "Send", stop: "Stop" } as SessionController["t"],
      online: true,
      busy: false,
      controlReady: true,
      canSend: true,
      canStop: false,
      live: {
        sessionId: "session",
        revision: 1,
        sendEnabled: true,
        status: "idle",
        executionMode: "claude-managed",
        approvals: [],
        questions: [],
      } as SessionController["live"],
      access: {
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { send: true },
      } as SessionController["access"],
      capabilities: {
        sessionId: "session",
        executionMode: "claude-managed",
        status: "idle",
        commands: catalog,
        features: {
          settings: { available: true },
          rename: { available: true },
          "goal-set": { available: true },
        },
      } as SessionController["capabilities"],
      control: doubles.control,
      runSessionAction: doubles.runSessionAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

  it("lists only what a paired browser may run, and points the textarea at the active one", () => {
    const { input } = renderComposer("/");
    // No /config, /heapdump or /loop, and no /clear: AgentKib starts a new session instead.
    // Local model and goal controls require their capabilities; rename remains reported.
    expect(options()).toEqual([
      "/probe-skillA probe skill (project)",
      "/code-reviewReview the diff",
      "/compactFree up context",
      "/output-style",
      "/rename[name]Rename the session in AgentKib",
      "/usageShow usage",
    ]);
    const listbox = screen.getByRole("listbox");
    const [first, second] = within(listbox).getAllByRole("option");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-activedescendant", first!.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", second!.id);
    expect(second).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    // Wraps to the last option.
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      within(listbox).getAllByRole("option").at(-1)!.id,
    );
  });

  it("uses the current session's typed directory in preference to legacy commands", () => {
    const approvedAccess = { ...doubles.session.access!, status: "approved" as const };
    doubles.session.access = approvedAccess;
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      commands: [{ name: "compact", description: "Legacy command description" }],
      commandMenu: {
        state: "ready",
        entries: [
          {
            name: "compact",
            description: "Current command description",
            run: { kind: "native" },
          },
        ],
      },
    };
    const currentCapabilities = doubles.session.capabilities;
    const currentLive = doubles.session.live!;
    const { input, form, rerender } = renderComposer("/");
    expect(screen.getByRole("option", { name: /Current command description/ })).toBeVisible();
    expect(screen.queryByText("Legacy command description")).not.toBeInTheDocument();

    doubles.session.canSend = false;
    doubles.session.live = {
      ...currentLive,
      status: "running",
      sendEnabled: false,
      executionLocation: "agentkib",
    };
    doubles.session.capabilities = {
      ...currentCapabilities,
      features: { send: { available: false, reason: "session-busy" } },
    };
    rerender(<SessionComposer />);
    const disabledOption = screen.getByRole("option", { name: /Current command description/ });
    expect(disabledOption).toHaveAttribute("aria-disabled", "true");
    expect(disabledOption).toHaveAttribute("title", reason("session-busy"));
    fireEvent.click(disabledOption);
    expect(input).toHaveValue("/");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(form);
    expect(input).toHaveValue("/compact");
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();

    doubles.session.access = {
      ...approvedAccess,
      device: { ...approvedAccess.device!, send: false },
    };
    rerender(<SessionComposer />);
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    doubles.session.canSend = true;
    doubles.session.live = currentLive;
    doubles.session.access = approvedAccess;
    doubles.session.capabilities = { ...currentCapabilities, sessionId: "previous" };
    rerender(<SessionComposer />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(slashCommandCopy("en-US").empty)).not.toBeInTheDocument();

    doubles.session.capabilities = {
      ...doubles.session.capabilities,
      sessionId: "session",
      commandMenu: { state: "ready", entries: [] },
    };
    rerender(<SessionComposer />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(slashCommandCopy("en-US").empty)).not.toBeInTheDocument();

    doubles.session.capabilities = {
      ...doubles.session.capabilities,
      commandMenu: { state: "unverified" },
    };
    rerender(<SessionComposer />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText(slashCommandCopy("en-US").empty)).toBeVisible();
  });

  it("does not offer a reported directory when the selected provider declares no commands", () => {
    doubles.session.current = { ...doubles.session.current!, agent: "devin" };
    doubles.session.live = { ...doubles.session.live!, executionMode: "devin-print" };
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      executionMode: "devin-print",
      provider: sessionProviderDeclaration("claude-code"),
      commands: [{ name: "compact" }],
      commandMenu: {
        state: "ready",
        entries: [{ name: "compact", run: { kind: "client", command: "compact" } }],
      },
    };

    renderComposer("/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("keeps a reported owner-only command and its alias from a full-access paired browser", () => {
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      commands: [
        { name: "compact" },
        { name: "future-admin", aliases: ["future-alias"], builtin: true },
      ],
      commandMenu: {
        state: "ready",
        entries: [
          { name: "compact", run: { kind: "native" } },
          { name: "future-admin", aliases: ["future-alias"], run: { kind: "native" } },
          { name: "future-alias", run: { kind: "native" } },
        ],
      },
    };

    const { input, form, rerender } = renderComposer("/");
    expect(screen.getByRole("option", { name: /\/compact/ })).toBeVisible();
    expect(screen.queryAllByRole("option", { name: /\/future-(admin|alias)/ })).toHaveLength(0);
    fireEvent.change(input, { target: { value: "/future-alias on" } });
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-owner-only"))).toBeVisible();
    expect(input).toHaveValue("/future-alias on");
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();

    doubles.session.capabilities = {
      ...doubles.session.capabilities,
      commandMenu: { state: "unverified" },
    };
    rerender(<SessionComposer />);
    fireEvent.change(input, { target: { value: "/future-alias off" } });
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-owner-only"))).toBeVisible();
    expect(input).toHaveValue("/future-alias off");
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("matches names, then aliases, then names that contain what was typed", () => {
    const { input } = renderComposer("/co");
    expect(options().map((text) => text?.split(/[A-Z<\[]/)[0])).toEqual([
      "/code-review",
      "/compact",
      "/usage",
    ]);
    fireEvent.change(input, { target: { value: "/view" } });
    expect(options()).toEqual(["/code-reviewReview the diff"]);
    fireEvent.change(input, { target: { value: "/zzz" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("completes the name with Tab or Enter, and sends a complete name with Enter", async () => {
    const { input } = renderComposer("/comp");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/compact ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/us" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    expect(input).toHaveValue("/usage ");
    expect(doubles.control).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control.mock.lastCall?.[0]).toBe("send");
  });

  it("chooses with the pointer without moving focus", () => {
    const { input } = renderComposer("/");
    input.focus();
    const option = screen.getByRole("option", { name: /\/compact/ });
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(input).toHaveValue("/compact ");
    expect(input).toHaveFocus();
  });

  it("closes with Escape until the draft changes", () => {
    const { input } = renderComposer("/");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/c" } });
    expect(screen.getByRole("listbox")).toBeVisible();
  });

  it("leaves IME composition, modifier keys and Shift+Enter to the textarea", () => {
    const { input } = renderComposer("/co");
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(true);
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: "ArrowDown" })).toBe(true);
    fireEvent.compositionEnd(input);
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(true);
    expect(input).toHaveValue("/co");
  });

  it("says why the menu is empty before Claude Code has run in the session", async () => {
    doubles.session.capabilities = { ...doubles.session.capabilities!, commands: [] };
    const { input } = renderComposer("/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText(slashCommandCopy("en-US").empty)).toBeVisible();
    expect(input).not.toHaveAttribute("aria-controls");
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
  });

  it.each([
    ["/config permissionMode=auto", "claude-command-owner-only"],
    ["/heapdump", "claude-command-owner-only"],
    ["/output-style Concise", "claude-command-owner-only"],
    ["/clear", "claude-command-clear"],
    ["/reset", "claude-command-clear"],
    ["/loop 5m check", "claude-command-background"],
    ["/goal", "claude-command-goal"],
    ["/rename", "claude-command-rename"],
    // Next-turn settings take low to max; the CLI's auto and ultracode are explained by those.
    ["/effort turbo", "claude-effort-unsupported"],
    ["/effort auto", "claude-effort-unsupported"],
    ["/effort ultracode on", "claude-effort-unsupported"],
  ])("explains %s instead of sending it, and keeps the draft", (text, code) => {
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(screen.getByText(reason(code))).toBeVisible();
    expect(input).toHaveValue(text);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    // The explanation goes with the draft it was about.
    fireEvent.change(input, { target: { value: `${text} ` } });
    expect(screen.queryByText(reason(code))).not.toBeInTheDocument();
  });

  it.each([
    ["/model opus", "settings", { model: "opus" }],
    ["/effort HIGH", "settings", { effort: "high" }],
    ["/rename Probe title", "rename", { name: "Probe title" }],
    ["/name Probe title", "rename", { name: "Probe title" }],
    ["/goal tests pass", "goal-set", { objective: "tests pass", intent: "start" }],
  ])("runs AgentKib's action for %s", async (text, action, fields) => {
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith(action, fields);
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("does not run AgentKib's action for a message with attachments, which would drop them", async () => {
    doubles.session.access = {
      ...doubles.session.access!,
      device: { send: true, attachments: true },
    } as SessionController["access"];
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { ...doubles.session.capabilities!.features, attachments: { available: true } },
    };
    const upload = vi.fn().mockResolvedValue({
      id: "attachment",
      name: "note.txt",
      mime: "text/plain",
      size: 3,
      version: "1",
    });
    doubles.session.client = {
      request: vi.fn(),
      uploadAttachment: upload,
    } as unknown as SessionController["client"];
    const { input, form } = renderComposer("/rename Probe title");
    fireEvent.change(
      screen.getByLabelText(sessionCopy["en-US"].attachment, { selector: "input" }),
      {
        target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
      },
    );
    const attachmentRow = (await screen.findByText("note.txt")).closest("li");
    expect(attachmentRow).not.toBeNull();
    await waitFor(() => expect(attachmentRow).not.toHaveAttribute("aria-busy"));
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-rename"))).toBeVisible();
    expect(input).toHaveValue("/rename Probe title");
    expect(screen.getByText("note.txt")).toBeVisible();
    await act(async () => {});
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("explains a mapped command when this device cannot run AgentKib's action now", async () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { rename: { available: false, reason: "session-busy" } },
    };
    const { input, form } = renderComposer("/rename Probe title");
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-rename"))).toBeVisible();
    expect(input).toHaveValue("/rename Probe title");
    await act(async () => {});
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("explains /effort with a level it takes as a settings command when settings are unavailable", async () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { settings: { available: false, reason: "session-busy" } },
    };
    const { input, form } = renderComposer("/effort high");
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-settings"))).toBeVisible();
    expect(input).toHaveValue("/effort high");
    await act(async () => {});
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it.each(["/rename", "/NAME  "])("opens the session actions, where rename is, for %j", (text) => {
    const setActionsOpen = vi.fn();
    doubles.panels = {
      filesOpen: false,
      setFilesOpen: vi.fn(),
      actionsOpen: false,
      setActionsOpen,
    };
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(setActionsOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(input).toHaveValue("");
    expect(screen.queryByText(reason("claude-command-rename"))).not.toBeInTheDocument();
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it.each([
    ["/goal", "goal"],
    ["/model", "models"],
    ["/effort", "effort"],
  ] as const)("opens AgentKib's control for %s without an argument", (text, dialog) => {
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.open.mockReturnValue(true);
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(doubles.open).toHaveBeenCalledExactlyOnceWith(dialog);
    expect(input).toHaveValue("");
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("falls back when AgentKib's control cannot open here", async () => {
    // Without full access there is no model picker; Claude Code reports the model instead.
    const first = renderComposer("/model");
    fireEvent.submit(first.form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control.mock.lastCall?.[0]).toBe("send");
    first.unmount();
    // The dialog can decline, for example while this device cannot read the goal.
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.open.mockReturnValue(false);
    const { input, form } = renderComposer("/goal");
    fireEvent.submit(form);
    expect(doubles.open).toHaveBeenCalledExactlyOnceWith("goal");
    expect(screen.getByText(reason("claude-command-goal"))).toBeVisible();
    expect(input).toHaveValue("/goal");
    // With an argument the command runs AgentKib's action instead of opening the dialog.
    fireEvent.change(input, { target: { value: "/model opus" } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith("settings", {
        model: "opus",
      }),
    );
    expect(doubles.open).toHaveBeenCalledOnce();
  });

  it("sends skills, allowed commands and plain text as messages", async () => {
    for (const text of ["/probe-skill go", "/compact keep tests", "/private/tmp is a path"]) {
      doubles.control.mockClear();
      const { form, unmount } = renderComposer(text);
      fireEvent.submit(form);
      await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
      unmount();
    }
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });
});

// Codex's own commands work only in its terminal UI (`SlashCommand`, Codex 0.163.0).
describe("Codex slash commands in the composer", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.runSessionAction.mockResolvedValue({ accepted: true });
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "codex" } as SessionController["current"],
      locale: "en-US",
      t: { message: "Message", send: "Send", stop: "Stop" } as SessionController["t"],
      online: true,
      busy: false,
      controlReady: true,
      canSend: true,
      canStop: false,
      live: {
        sessionId: "session",
        revision: 1,
        sendEnabled: true,
        status: "idle",
        executionMode: "codex-managed",
        approvals: [],
        questions: [],
      } as SessionController["live"],
      access: {
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { send: true },
      } as SessionController["access"],
      control: doubles.control,
      runSessionAction: doubles.runSessionAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
    doubles.session.capabilities = {
      sessionId: "session",
      executionMode: "codex-managed",
      status: "idle",
      features: {
        send: { available: true },
        compact: { available: true },
        settings: { available: true },
        rename: { available: true },
        "goal-set": { available: true },
        fork: { available: true },
      },
    } as SessionController["capabilities"];
  });
  const codexOptions = () =>
    within(screen.getByRole("listbox", { name: slashCommandCopy("en-US").codexLabel }))
      .getAllByRole("option")
      .map((option) => option.textContent);

  it("keeps an unavailable command visible and prevents it from dispatching", () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { compact: { available: false, reason: "session-busy" } },
      commandMenu: {
        state: "ready",
        entries: [{ name: "compact", run: { kind: "client", command: "compact" } }],
      },
    };

    const { input, form } = renderComposer("/");
    const option = screen.getByRole("option", { name: /\/compact/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveAttribute("title", reason("session-busy"));
    fireEvent.click(option);
    expect(input).toHaveValue("/");
    fireEvent.change(input, { target: { value: "/compact" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
    fireEvent.submit(form);
    expect(input).toHaveValue("/compact");
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("lists what AgentKib runs or opens for Codex", () => {
    renderComposer("/");
    expect(codexOptions()).toEqual([
      "/compactCompact the context",
      "/review[branch]Review uncommitted changes, or against a branch",
      "/plan[message]Use Plan mode for the next turn",
      "/model[model]Change the next-turn model",
      "/permissionsChange the execution policy",
      "/statusShow next-turn settings",
      "/rename[name]Rename the session in AgentKib",
      "/goal[objective]Set a persistent goal",
      "/forkFork the session",
      "/stopStop background terminals",
      "/archiveArchive the session",
      "/diffShow files and diffs",
      "/initWrite an AGENTS.md for this directory",
    ]);
  });

  it.each([
    ["/review", { kind: "review", base: null }, "en-US"],
    ["/review main", { kind: "review", base: "main" }, "en-US"],
    ["/init", { kind: "init" }, "en-US"],
    // Worded in the reader's language.
    ["/review main", { kind: "review", base: "main" }, "zh-CN"],
  ] as const)("sends AgentKib's message for %s (%j) in %s", async (text, prompt, locale) => {
    doubles.session.locale = locale;
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control).toHaveBeenCalledExactlyOnceWith(
      "send",
      undefined,
      undefined,
      undefined,
      undefined,
      { prompt: commandPrompt(locale, prompt) },
    );
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("keeps /review while the session cannot send", async () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { send: { available: false, reason: "session-busy" } },
    };
    const { input, form } = renderComposer("/review main");
    fireEvent.submit(form);
    expect(screen.getByText(reason("codex-command-agentkib"))).toBeVisible();
    expect(input).toHaveValue("/review main");
    await act(async () => {});
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it.each([
    ["/compact", "compact", undefined, ""],
    ["/fork", "fork", undefined, ""],
    ["/model gpt-6.1-sol", "settings", { model: "gpt-6.1-sol" }, ""],
    ["/rename Release prep", "rename", { name: "Release prep" }, ""],
    ["/goal tests pass", "goal-set", { objective: "tests pass", intent: "start" }, ""],
    ["/plan", "settings", { mode: "plan" }, ""],
    // The message waits in the composer for the turn that runs in Plan mode.
    ["/plan sketch the migration", "settings", { mode: "plan" }, "sketch the migration"],
  ])("runs AgentKib's action for %s", async (text, action, fields, kept) => {
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.runSessionAction).toHaveBeenCalledOnce());
    expect(doubles.runSessionAction).toHaveBeenCalledExactlyOnceWith(action, fields);
    await waitFor(() => expect(input).toHaveValue(kept));
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("opens the corresponding controls for bare Codex commands", () => {
    const setFilesOpen = vi.fn();
    const setActionsOpen = vi.fn();
    doubles.panels = { filesOpen: false, setFilesOpen, actionsOpen: false, setActionsOpen };
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.open.mockReturnValue(true);
    for (const text of ["/diff", "/permissions", "/status", "/model", "/archive"]) {
      const { input, form, unmount } = renderComposer(text);
      fireEvent.submit(form);
      expect(input).toHaveValue("");
      unmount();
    }
    expect(setFilesOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(doubles.open.mock.calls).toEqual([["permissions"], ["usage"], ["models"]]);
    expect(setActionsOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("opens an authorized bare model shortcut while a settings write still blocks dispatch", () => {
    doubles.session.access = {
      ...doubles.session.access!,
      status: "approved",
      device: { ...fullDevice, advancedControl: true },
    };
    doubles.session.canSend = false;
    doubles.session.settingsOnlyBlocked = true;
    doubles.open.mockReturnValue(true);
    const { input, form } = renderComposer("/model");

    fireEvent.submit(form);
    expect(doubles.open).toHaveBeenCalledExactlyOnceWith("models");
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "Edited during settings write" } });
    expect(input).toHaveValue("Edited during settings write");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(form);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it.each([
    ["/quit", "codex-command-terminal"],
    ["/mcp", "codex-command-terminal"],
    ["/new", "codex-command-new"],
    ["/review focus on auth", "codex-command-review"],
    ["/init now", "codex-command-arguments"],
    ["/compact now", "codex-command-arguments"],
  ])("explains %s instead of sending it, and keeps the draft", async (text, code) => {
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(screen.getByText(reason(code))).toBeVisible();
    expect(input).toHaveValue(text);
    await act(async () => {});
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it("explains a command whose AgentKib action is unavailable now", async () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { compact: { available: false, reason: "session-busy" } },
    };
    const { input, form } = renderComposer("/compact");
    fireEvent.submit(form);
    expect(screen.getByText(reason("codex-command-agentkib"))).toBeVisible();
    expect(input).toHaveValue("/compact");
    await act(async () => {});
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  it.each(["steer", "queue-add"] as const)(
    "does not %s a Codex command into the running turn",
    async (action) => {
      doubles.session.access = {
        ...doubles.session.access,
        status: "approved",
        device: { send: true, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.canStop = true;
      doubles.session.live = {
        ...doubles.session.live,
        sendEnabled: false,
        status: "running",
        executionLocation: "agentkib",
        turnId: "turn",
      } as SessionController["live"];
      doubles.session.capabilities = {
        ...doubles.session.capabilities!,
        features: {
          steer: { available: true },
          "queue-add": { available: true },
          "terminals-clean": { available: true },
        },
      };
      const { input } = renderComposer("/stop");
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: action === "queue-add" });
      expect(await screen.findByText(reason("codex-command-agentkib"))).toBeVisible();
      expect(input).toHaveValue("/stop");
      await act(async () => {});
      expect(doubles.runSessionAction).not.toHaveBeenCalled();
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );
  it("sends other text as written", async () => {
    for (const text of ["/effort high", "/private/tmp is a path", "fix /compact docs"]) {
      doubles.control.mockClear();
      const { form, unmount } = renderComposer(text);
      fireEvent.submit(form);
      await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
      expect(doubles.control.mock.lastCall?.[0]).toBe("send");
      unmount();
    }
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
  });

  describe("plan mode, as on the desktop", () => {
    beforeEach(() => {
      doubles.session.access = {
        ...doubles.session.access,
        device: fullDevice,
      } as SessionController["access"];
    });
    afterEach(() => {
      doubles.planState = { on: false, available: false };
    });

    it("turns on for /plan typed after a space, and leaves it out of the draft", () => {
      doubles.planState = { on: false, available: true };
      doubles.plan.mockReturnValue(true);
      const { input } = renderComposer("Fix the flaky test /pl");
      expect(codexOptions()).toEqual(["/planTurn on Plan mode"]);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(doubles.plan).toHaveBeenCalledOnce();
      expect(input).toHaveValue("Fix the flaky test");
      expect(doubles.control).not.toHaveBeenCalled();
    });

    it("is not offered after a space where the session cannot switch it", () => {
      renderComposer("Fix the flaky test /pl");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("asks for the task to plan while it is on", () => {
      doubles.planState = { on: true, available: true };
      const { input } = renderComposer("");
      expect(input).toHaveAttribute("placeholder", sessionCopy["en-US"].planPlaceholder);
    });
  });
});

describe("DeepSeek Harness commands in the Web composer", () => {
  // As a running DSH 0.2.1-rc.5 reports them (descriptions shortened).
  const dshCatalog = [
    { name: "compact", description: "Compact older conversation history" },
    { name: "export", description: "Download this Session log as a ZIP archive" },
    { name: "goal", description: "Set or view the goal", argumentHint: "[objective|clear]" },
    { name: "permission", description: "Switch the permission preset", argumentHint: "<preset>" },
    { name: "plan", description: "Enter or leave plan mode", argumentHint: "[off|message]" },
  ];
  const dshOptions = () =>
    within(screen.getByRole("listbox", { name: "DeepSeek Harness commands" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.session = {
      selected: "session",
      current: { id: "session", agent: "deepseek-harness" } as SessionController["current"],
      locale: "en-US",
      t: { message: "Message", send: "Send", stop: "Stop" } as SessionController["t"],
      online: true,
      busy: false,
      controlReady: true,
      canSend: true,
      canStop: false,
      live: {
        sessionId: "session",
        revision: 1,
        sendEnabled: true,
        status: "idle",
        executionMode: "dsh-follower",
        approvals: [],
        questions: [],
      } as SessionController["live"],
      access: {
        protocolVersion: 2,
        experimentalEnabled: true,
        device: { send: true },
      } as SessionController["access"],
      capabilities: {
        sessionId: "session",
        executionMode: "dsh-follower",
        status: "idle",
        commands: dshCatalog,
        features: { send: { available: true } },
      } as SessionController["capabilities"],
      control: doubles.control,
      runSessionAction: doubles.runSessionAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

  it("lists DSH's own commands, only those this device may run", () => {
    renderComposer("/");
    // `/goal` and `/permission` need full access; `/export` runs only in DSH's window.
    expect(dshOptions()).toEqual([
      "/compactCompact older conversation history",
      "/plan[off|message]Enter or leave plan mode",
    ]);
    cleanup();
    doubles.session.access = {
      ...doubles.session.access!,
      device: fullDevice,
    };
    renderComposer("/");
    expect(dshOptions()).toEqual([
      "/compactCompact older conversation history",
      "/goal[objective|clear]Set or view the goal",
      "/permission<preset>Switch the permission preset",
      "/plan[off|message]Enter or leave plan mode",
    ]);
  });

  it("sends a command line for DSH to run, and explains a command DSH did not run", async () => {
    const { form, input } = renderComposer("/plan");
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.control.mock.lastCall?.[0]).toBe("send");
    expect(doubles.runSessionAction).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();
    expect(reason("dsh-command-window-only")).toBe(
      "This command only works in DeepSeek Harness's own window, so the message was not sent.",
    );
    expect(reason("dsh-command-full-access")).toBe(
      "This command needs full access, so the message was not sent. Reconnect with a new full-access code to use it.",
    );
  });

  it("offers no menu while DSH reports no commands", () => {
    doubles.session.capabilities = { ...doubles.session.capabilities!, commands: undefined };
    renderComposer("/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
