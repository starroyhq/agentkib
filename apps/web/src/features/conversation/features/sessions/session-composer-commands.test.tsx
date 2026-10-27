// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCommandEntry } from "@agentkib/web-client";
import { slashCommandCopy } from "@agentkib/session-ui";
import { SessionComposer } from "./session-composer";
import { codexCopy, codexReason } from "./codex-copy";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
}));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => vi.fn() }));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => null }));
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

describe("slash commands in the Web composer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    // No /config, /heapdump or /loop. /clear, /goal and /rename run AgentKib's own action.
    expect(options()).toEqual([
      "/probe-skillA probe skill (project)",
      "/code-reviewReview the diff",
      "/clearFor an empty context, start a new session; this one is kept",
      "/compactFree up context",
      "/output-style",
      "/model<model>Change the next-turn model",
      "/rename<name>Rename the session in AgentKib",
      "/usageShow usage",
      "/goal<objective>Set a persistent goal",
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

  it("has no menu for Codex", () => {
    doubles.session.current = { id: "session", agent: "codex" } as SessionController["current"];
    renderComposer("/");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText(slashCommandCopy("en-US").empty)).not.toBeInTheDocument();
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
    ["/effort turbo", "claude-command-settings"],
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
