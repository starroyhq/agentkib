// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCommandEntry } from "@agentkib/web-client";
import { slashCommandCopy } from "@agentkib/session-ui";
import { SessionComposer } from "./session-composer";
import { codexCopy, codexReason } from "./codex-copy";
import type { SessionPanels } from "./session-panels";
import type { SessionController } from "./use-session-controller";

const doubles = vi.hoisted(() => ({
  session: {} as Partial<SessionController>,
  control: vi.fn(),
  codexAction: vi.fn(),
  panels: null as SessionPanels | null,
}));
vi.mock("./session-navigation", () => ({ useSessionNavigate: () => vi.fn() }));
vi.mock("./session-context", () => ({
  useSession: () => {
    const [message, setMessage] = useState("");
    return { ...doubles.session, message, setMessage } as SessionController;
  },
}));
vi.mock("./session-panels", () => ({ useSessionPanels: () => doubles.panels }));
vi.mock("./context-usage", () => ({ ContextUsageGauge: () => null }));
vi.mock("../history/history-search-controls", () => ({ HistoryReferenceChips: () => null }));

const catalog: ClaudeCommandEntry[] = [
  { name: "loop", builtin: true, aliases: ["proactive"] },
  { name: "clear", builtin: true, aliases: ["reset", "new"] },
  { name: "config", builtin: true, aliases: ["settings"], argumentHint: "key=value" },
  { name: "heapdump", builtin: true, description: "Dump the JS heap" },
  { name: "workflow-launch-exec", builtin: true },
  { name: "__remote-workflow", builtin: true },
  { name: "output-style", builtin: true, argumentHint: "[style]" },
];

function renderComposer(message: string) {
  const view = render(<SessionComposer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: message } });
  return { ...view, input, form: input.closest("form")! };
}

describe("slash commands in the desktop composer", () => {
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
        features: {},
      } as SessionController["capabilities"],
      control: doubles.control,
      codexAction: doubles.codexAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

  it("offers the person at this computer every command but background, /clear and internal ones", () => {
    renderComposer("/");
    expect(
      within(screen.getByRole("listbox", { name: "Claude Code commands" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["/configkey=value", "/heapdumpDump the JS heap", "/output-style[style]"]);
  });

  it("sends a settings command, as the terminal would", async () => {
    const { form } = renderComposer("/config autoScroll=false");
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.codexAction).not.toHaveBeenCalled();
  });

  it("does not run AgentKib's action for a message with attachments, which would drop them", async () => {
    doubles.session.access = {
      ...doubles.session.access!,
      device: { send: true, attachments: true },
    } as SessionController["access"];
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { rename: { available: true }, attachments: { available: true } },
    } as SessionController["capabilities"];
    doubles.session.client = {
      request: vi.fn(),
      uploadAttachment: vi.fn().mockResolvedValue({
        id: "attachment",
        name: "note.txt",
        mime: "text/plain",
        size: 3,
        version: "1",
      }),
    } as unknown as SessionController["client"];
    const { input, form } = renderComposer("/rename Probe title");
    fireEvent.change(screen.getByLabelText(codexCopy["en-US"].attachment, { selector: "input" }), {
      target: { files: [new File(["abc"], "note.txt", { type: "text/plain" })] },
    });
    await screen.findByText("100%");
    fireEvent.submit(form);
    expect(screen.getByText(codexReason("en-US", "claude-command-rename").text)).toBeVisible();
    expect(input).toHaveValue("/rename Probe title");
    expect(doubles.codexAction).not.toHaveBeenCalled();
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("opens the session actions for /rename without an argument", () => {
    const setActionsOpen = vi.fn();
    doubles.panels = {
      filesOpen: false,
      setFilesOpen: vi.fn(),
      actionsOpen: false,
      setActionsOpen,
    };
    const { input, form } = renderComposer("/rename");
    fireEvent.submit(form);
    expect(setActionsOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(input).toHaveValue("");
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("runs /effort with a level next-turn settings take and explains the others", async () => {
    doubles.session.capabilities = {
      ...doubles.session.capabilities!,
      features: { settings: { available: true } },
    } as SessionController["capabilities"];
    // CLI 2.1.311 also takes auto and ultracode [on|off]; next-turn settings take low to max.
    for (const text of ["/effort auto", "/effort ultracode on"]) {
      const { form, input, unmount } = renderComposer(text);
      fireEvent.submit(form);
      expect(
        screen.getByText(codexReason("en-US", "claude-effort-unsupported").text),
      ).toBeVisible();
      expect(input).toHaveValue(text);
      unmount();
    }
    expect(doubles.codexAction).not.toHaveBeenCalled();
    const { form, input } = renderComposer("/effort Max");
    fireEvent.submit(form);
    await waitFor(() => expect(input).toHaveValue(""));
    expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("settings", { effort: "max" });
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("still explains /clear and /loop", () => {
    for (const [text, code] of [
      ["/new", "claude-command-clear"],
      ["/proactive", "claude-command-background"],
    ]) {
      const { form, input, unmount } = renderComposer(text);
      fireEvent.submit(form);
      expect(screen.getByText(codexReason("en-US", code).text)).toBeVisible();
      expect(input).toHaveValue(text);
      unmount();
    }
    expect(doubles.control).not.toHaveBeenCalled();
  });
});

describe("Codex slash commands in the desktop composer", () => {
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
      capabilities: {
        sessionId: "session",
        executionMode: "codex-managed",
        status: "idle",
        features: { compact: { available: true } },
      } as SessionController["capabilities"],
      control: doubles.control,
      codexAction: doubles.codexAction,
      client: { request: vi.fn() } as unknown as SessionController["client"],
    };
  });
  afterEach(cleanup);

  it("offers AgentKib's Codex commands and runs /compact", async () => {
    const { input, form } = renderComposer("/co");
    expect(
      within(screen.getByRole("listbox", { name: slashCommandCopy("en-US").codexLabel }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["/compactCompact the context"]);
    fireEvent.change(input, { target: { value: "/compact" } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(doubles.codexAction).toHaveBeenCalledExactlyOnceWith("compact", undefined),
    );
    expect(doubles.control).not.toHaveBeenCalled();
  });

  it("explains a terminal-only command and keeps the draft", () => {
    const { input, form } = renderComposer("/quit");
    fireEvent.submit(form);
    expect(screen.getByText(codexReason("en-US", "codex-command-terminal").text)).toBeVisible();
    expect(input).toHaveValue("/quit");
    expect(doubles.control).not.toHaveBeenCalled();
  });
  it.each(["steer", "queue-add"] as const)(
    "does not %s a Codex command into the running turn",
    async (action) => {
      doubles.session.access = {
        ...doubles.session.access,
        device: { send: true, advancedControl: true },
      } as SessionController["access"];
      doubles.session.canSend = false;
      doubles.session.canStop = true;
      doubles.session.live = {
        ...doubles.session.live,
        sendEnabled: false,
        status: "running",
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
      fireEvent.click(screen.getByRole("button", { name: codexCopy["en-US"].advanced }));
      fireEvent.click(
        await screen.findByRole("menuitem", {
          name: action === "steer" ? codexCopy["en-US"].steer : codexCopy["en-US"].queueAdd,
        }),
      );
      expect(
        await screen.findByText(codexReason("en-US", "codex-command-agentkib").text),
      ).toBeVisible();
      expect(input).toHaveValue("/stop");
      expect(doubles.codexAction).not.toHaveBeenCalled();
      expect(doubles.control).not.toHaveBeenCalled();
    },
  );
});
