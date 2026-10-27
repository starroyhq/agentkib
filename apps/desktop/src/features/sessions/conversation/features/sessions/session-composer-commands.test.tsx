// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCommandEntry } from "@agentkib/web-client";
import { SessionComposer } from "./session-composer";
import { codexReason } from "./codex-copy";
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

  it("offers the person at this computer every command but background and internal ones", () => {
    renderComposer("/");
    expect(
      within(screen.getByRole("listbox", { name: "Claude Code commands" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "/clearFor an empty context, start a new session; this one is kept",
      "/configkey=value",
      "/heapdumpDump the JS heap",
      "/output-style[style]",
    ]);
  });

  it("sends a settings command, as the terminal would", async () => {
    const { form } = renderComposer("/config autoScroll=false");
    fireEvent.submit(form);
    await waitFor(() => expect(doubles.control).toHaveBeenCalledOnce());
    expect(doubles.codexAction).not.toHaveBeenCalled();
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
