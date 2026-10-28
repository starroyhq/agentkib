// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCommandEntry } from "@agentkib/web-client";
import { slashCommandCopy } from "@agentkib/session-ui";
import { SessionComposer } from "./session-composer";
import { codexCopy, codexReason } from "./codex-copy";
import type { ComposerControlsHandle } from "./codex-session-controls";
import type { SessionPanels } from "./session-panels";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
  panels: null as SessionPanels | null,
  // Opens the composer's settings or goal dialog; rendered only with full access.
  open: vi.fn<(dialog: "settings" | "goal") => boolean>(),
}));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => vi.fn() }));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => doubles.panels }));
vi.mock("./codex-session-controls", () => ({
  CodexComposerControls: ({
    action,
    controlsRef,
  }: {
    action: ReactNode;
    controlsRef?: Ref<ComposerControlsHandle>;
  }) => {
    useImperativeHandle(controlsRef, () => ({ open: doubles.open }));
    return <>{action}</>;
  },
}));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
vi.mock("../history/history-search-controls", () => ({ HistoryReferenceChips: () => null }));

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
const reason = (code: string) => codexReason("en-US", code, "web").text;
// With full access the composer renders its settings and goal controls.
const fullDevice = { send: true, accessMode: "full" } as NonNullable<
  SessionController["access"]
>["device"];

describe("slash commands in the Web composer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.codexAction.mockResolvedValue({ accepted: true });
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
      codexAction: doubles.codexAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

  it("lists only what a paired browser may run, and points the textarea at the active one", () => {
    const { input } = renderComposer("/");
    // No /config, /heapdump or /loop, and no /clear: AgentKib starts a new session instead.
    // /model, /goal and /rename run or open AgentKib's own control.
    expect(options()).toEqual([
      "/probe-skillA probe skill (project)",
      "/code-reviewReview the diff",
      "/compactFree up context",
      "/output-style",
      "/model[model]Change the next-turn model",
      "/rename[name]Rename the session in AgentKib",
      "/usageShow usage",
      "/goal[objective]Set a persistent goal",
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
    expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith(action, fields);
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
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment, { selector: "input" }), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    await screen.findByText("100%");
    fireEvent.submit(form);
    expect(screen.getByText(reason("claude-command-rename"))).toBeVisible();
    expect(input).toHaveValue("/rename Probe title");
    expect(screen.getByText("note.txt")).toBeVisible();
    await act(async () => {});
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });

  it.each([
    ["/goal", "goal"],
    ["/model", "settings"],
    ["/effort", "settings"],
  ] as const)("opens AgentKib's control for %s without an argument", (text, dialog) => {
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.open.mockReturnValue(true);
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(doubles.open).toHaveBeenCalledExactlyOnceWith(dialog);
    expect(input).toHaveValue("");
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });

  it("falls back when AgentKib's control cannot open here", async () => {
    // Without full access there is no settings dialog; Claude Code reports the model instead.
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
      expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { model: "opus" }),
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });
});

// Codex's own commands work only in its terminal UI (`SlashCommand`, Codex 0.163.0).
describe("Codex slash commands in the composer", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.panels = null;
    doubles.control.mockResolvedValue(true);
    doubles.codexAction.mockResolvedValue({ accepted: true });
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
      codexAction: doubles.codexAction,
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

  it("lists what AgentKib runs or opens for Codex", () => {
    renderComposer("/");
    expect(codexOptions()).toEqual([
      "/compactCompact the context",
      "/plan[message]Use Plan mode for the next turn",
      "/model[model]Change the next-turn model",
      "/permissionsChange the execution policy",
      "/statusShow next-turn settings",
      "/rename[name]Rename the session in AgentKib",
      "/goal[objective]Set a persistent goal",
      "/forkFork the session",
      "/archiveArchive the session",
      "/diffShow files and diffs",
    ]);
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
    await waitFor(() => expect(doubles.codexAction).toHaveBeenCalledOnce());
    expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith(action, fields);
    await waitFor(() => expect(input).toHaveValue(kept));
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("opens files and diffs, settings, or the session actions without an argument", () => {
    const setFilesOpen = vi.fn();
    const setActionsOpen = vi.fn();
    doubles.panels = { filesOpen: false, setFilesOpen, actionsOpen: false, setActionsOpen };
    doubles.session.access = { ...doubles.session.access!, device: fullDevice };
    doubles.open.mockReturnValue(true);
    for (const text of ["/diff", "/permissions", "/archive"]) {
      const { input, form, unmount } = renderComposer(text);
      fireEvent.submit(form);
      expect(input).toHaveValue("");
      unmount();
    }
    expect(setFilesOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(doubles.open).toHaveBeenCalledExactlyOnceWith("settings");
    expect(setActionsOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });

  it.each([
    ["/quit", "codex-command-terminal"],
    ["/mcp", "codex-command-terminal"],
    ["/new", "codex-command-new"],
    ["/review", "codex-command-review"],
    ["/init", "codex-command-init"],
    ["/compact now", "codex-command-arguments"],
  ])("explains %s instead of sending it, and keeps the draft", async (text, code) => {
    const { input, form } = renderComposer(text);
    fireEvent.submit(form);
    expect(screen.getByText(reason(code))).toBeVisible();
    expect(input).toHaveValue(text);
    await act(async () => {});
    expect(doubles.control).not.toHaveBeenCalled();
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });

  it("sends other text, and steering, as written", async () => {
    for (const text of ["/effort high", "/private/tmp is a path", "fix /compact docs"]) {
      doubles.control.mockClear();
      const { form, unmount } = renderComposer(text);
      fireEvent.submit(form);
      await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
      expect(doubles.control.mock.lastCall?.[0]).toBe("send");
      unmount();
    }
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });
});
