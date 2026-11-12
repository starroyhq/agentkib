// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationEvent } from "@/core/types";
import { ConversationEventRow } from "./ConversationEventRow";
import { ConversationTranscript } from "./ConversationTranscript";

function event(
  id: string,
  kind: ConversationEvent["kind"],
  metadata: Partial<{ turn_id: string | null; message_phase: "commentary" | "final_answer" }> = {},
  extra: Partial<ConversationEvent> = {},
): ConversationEvent {
  return {
    id,
    kind,
    content: id,
    attachment_count: 0,
    truncated: false,
    ...metadata,
    ...extra,
  } as ConversationEvent;
}

describe("ConversationTranscript", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("folds complete process segments, keeps final visible, and removes hub role duplication", () => {
    const timestamp = "2026-09-07T03:04:05Z";
    const events = [
      event("user", "user-message", { turn_id: "turn-1" }, { timestamp }),
      event("commentary", "agent-message", { turn_id: "turn-1", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-1" }, { tool_status: "completed" }),
      event(
        "final",
        "agent-message",
        { turn_id: "turn-1", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed", duration_ms: 129_000 } },
      ),
    ];

    const { container } = render(<ConversationTranscript events={events} sessionKey="session-1" />);
    const process = container.querySelector('[data-slot="collapsible"]');
    expect(process).not.toBeNull();
    const trigger = process!.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("user")).toBeVisible();
    expect(screen.getByText("final")).toBeVisible();
    expect(screen.queryByText("commentary")).toBeNull();
    expect(screen.queryByText(tr("conversations.agent"))).toBeNull();
    expect(screen.queryByText(tr("conversations.you"))).toBeNull();

    const user = screen.getByText("user").closest("article")!;
    const time = user.querySelector("time")!;
    const body = user.querySelector("[data-message-body]")!;
    expect(time).toHaveAttribute("datetime", timestamp);
    expect(body.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body).toHaveClass("select-text");

    fireEvent.click(screen.getByRole("button", { name: "Worked 2m 9s" }));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("commentary")).toBeVisible();
    expect(screen.queryByText(tr("sessions.partialTurn"))).not.toBeInTheDocument();
    expect(container.querySelector('[data-event-id="tool"]')).toBeTruthy();
  });

  it("retains an opened process when earlier pagination extends its turn", () => {
    const initial = [
      event("commentary", "agent-message", { turn_id: "turn-page", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-page" }),
      event(
        "final",
        "agent-message",
        { turn_id: "turn-page", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed" } },
      ),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={initial} sessionKey="session-page" />,
    );
    const process = container.querySelector('[data-slot="collapsible"]')!;
    const trigger = process.querySelector('[data-slot="collapsible-trigger"]')!;
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(
      <ConversationTranscript
        events={[
          event("user", "user-message", { turn_id: "turn-page" }),
          event("older", "agent-message", {
            turn_id: "turn-page",
            message_phase: "commentary",
          }),
          ...initial,
        ]}
        sessionKey="session-page"
      />,
    );
    expect(
      container
        .querySelector('[data-segment-key$=":segment:tool"]')
        ?.querySelector('[data-slot="collapsible-trigger"]'),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("older")).toBeVisible();
  });

  it("keeps read-only file summaries scoped by turn as earlier history loads", () => {
    const edit = (id: string, turn_id: string, added: number) =>
      event(
        id,
        "tool-summary",
        { turn_id },
        {
          tool_status: "completed",
          tool: {
            kind: "edit",
            content: [{ type: "diff", path: "src/app.ts", change: "update", added, removed: 0 }],
          },
        },
      );
    const current = [
      edit("first-edit", "first", 2),
      event(
        "first-reply",
        "agent-message",
        { turn_id: "first", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed" } },
      ),
      event("second-user", "user-message", { turn_id: "second" }),
      edit("second-edit", "second", 7),
      event(
        "codex-turn-end:second",
        "agent-message",
        { turn_id: "second" },
        { content: undefined, turn_meta: { outcome: "aborted" } },
      ),
    ];
    const view = render(<ConversationTranscript events={current} sessionKey="changes" />);
    const cards = () => view.container.querySelectorAll("[data-turn-file-changes]");
    expect(cards()).toHaveLength(2);
    const [firstCard, secondCard] = cards();
    expect(firstCard).toHaveTextContent("Partial history");
    expect(firstCard).toHaveTextContent("+2");
    expect(firstCard.nextElementSibling).toHaveAttribute("data-message-actions");
    expect(secondCard).toHaveTextContent("+7");
    expect(screen.getByRole("button", { name: "Interrupted" })).toBeVisible();

    view.rerender(
      <ConversationTranscript
        events={[
          event("first-user", "user-message", { turn_id: "first" }),
          edit("earlier-edit", "first", 3),
          ...current,
        ]}
        sessionKey="changes"
      />,
    );
    expect(cards()).toHaveLength(2);
    expect(cards()[0]).toBe(firstCard);
    expect(firstCard).not.toHaveTextContent("Partial history");
    expect(firstCard).toHaveTextContent("+5");
    expect(cards()[1]).toBe(secondCard);
    expect(secondCard).toHaveTextContent("+7");
  });

  it("resets disclosure state when the externally-owned session key changes", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-reset" }),
      event("commentary", "agent-message", { turn_id: "turn-reset", message_phase: "commentary" }),
      event(
        "final",
        "agent-message",
        { turn_id: "turn-reset", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed" } },
      ),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={events} sessionKey="session-a" />,
    );
    const process = container.querySelector('[data-slot="collapsible"]')!;
    const trigger = process.querySelector('[data-slot="collapsible-trigger"]')!;
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    rerender(<ConversationTranscript events={events} sessionKey="session-b" />);
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("commentary")).toBeNull();
  });

  it("folds failed tools and keeps incomplete commentary visible", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-failed" }),
      event("commentary", "agent-message", {
        turn_id: "turn-failed",
        message_phase: "commentary",
      }),
      event("failed-tool", "tool-summary", { turn_id: "turn-failed" }, { tool_status: "failed" }),
    ];
    const { container } = render(
      <ConversationTranscript events={events} sessionKey="session-failed" incomplete />,
    );
    const process = container.querySelector('[data-slot="collapsible"]');
    expect(process?.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByText("commentary")).toBeVisible();
    expect(container.querySelector('[data-event-id="failed-tool"]')).toBeNull();
    fireEvent.click(process!.querySelector('[data-slot="collapsible-trigger"]')!);
    expect(container.querySelector('[data-event-id="failed-tool"]')).toBeVisible();
    expect(screen.getByText(tr("sessions.processFailed", { count: 1 }))).toBeVisible();
  });

  it("keeps the default disclosure closed when pagination reveals a failed tool", () => {
    const initial = [
      event("user", "user-message", { turn_id: "turn-late-failure" }),
      event("tool", "tool-summary", { turn_id: "turn-late-failure" }, { tool_status: "completed" }),
    ];
    const { container, rerender } = render(
      <ConversationTranscript events={initial} sessionKey="session-late-failure" />,
    );
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    rerender(
      <ConversationTranscript
        events={[
          event("user", "user-message", { turn_id: "turn-late-failure" }),
          event(
            "tool",
            "tool-summary",
            { turn_id: "turn-late-failure" },
            { tool_status: "failed" },
          ),
        ]}
        sessionKey="session-late-failure"
      />,
    );
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps workspace row framing and metadata while hub rows stay compact", () => {
    const timestamp = "2026-09-07T03:04:05Z";
    const { container } = render(
      <>
        <ConversationEventRow
          event={event("hub-agent", "agent-message", {}, { timestamp })}
          variant="hub"
        />
        <ConversationEventRow
          event={event("hub-user", "user-message", {}, { timestamp })}
          variant="hub"
        />
        <ConversationEventRow
          event={event("workspace-agent", "agent-message", {}, { timestamp })}
        />
        <ConversationEventRow
          event={event("hub-tool", "tool-summary", {}, { timestamp, tool_status: "completed" })}
          variant="hub"
        />
      </>,
    );

    expect(container.querySelector('[data-event-id="hub-agent"] header')).toBeNull();
    expect(container.querySelector('[data-event-id="hub-user"] header')).toBeNull();
    expect(container.querySelector('[data-event-id="hub-tool"] time')).toBeNull();
    expect(container.querySelector('[data-event-id="workspace-agent"] header')).toHaveTextContent(
      tr("conversations.agent"),
    );
    expect(container.querySelector('[data-event-id="workspace-agent"] header time')).toBeNull();
    const workspace = container.querySelector<HTMLElement>('[data-event-id="workspace-agent"]')!;
    const copy = within(workspace).getByRole("button", { name: /copy/i });
    const time = workspace.querySelector("time")!;
    expect(time).toHaveAttribute("datetime", timestamp);
    expect(copy.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("copies the visible user text and the complete final reply without process output", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const turn_id = "reply-turn";
    const timestamp = "2026-09-07T03:04:05Z";
    const events = [
      event(
        "user",
        "user-message",
        { turn_id },
        {
          content:
            '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\n\nRead this.',
          timestamp,
        },
      ),
      event("commentary", "agent-message", { turn_id, message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id }),
      event(
        "reply-1",
        "agent-message",
        { turn_id, message_phase: "final_answer" },
        {
          content: "**First**",
        },
      ),
      event(
        "reply-2",
        "agent-message",
        { turn_id, message_phase: "final_answer" },
        {
          content: "\x60\x60\x60sh\nprintf x\n\x60\x60\x60",
          timestamp,
          turn_meta: { outcome: "completed" },
        },
      ),
    ];
    render(<ConversationTranscript events={events} sessionKey="session-copy" />);
    const user = screen.getByText("Read this.").closest("article")!;
    const copyUser = within(user).getByRole("button", { name: /copy/i });
    const userTime = user.querySelector("time")!;
    expect(
      userTime.compareDocumentPosition(copyUser) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(copyUser);
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("Read this."));
    const answer = screen
      .getByText("First")
      .closest(".session-hub-transcript-event") as HTMLElement;
    const copyAnswer = within(answer).getByRole("button", { name: /copy/i });
    const answerTime = answer.querySelector("time")!;
    expect(answerTime).toHaveAttribute("datetime", timestamp);
    expect(
      copyAnswer.compareDocumentPosition(answerTime) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(copyAnswer);
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        "**First**\n\n\x60\x60\x60sh\nprintf x\n\x60\x60\x60",
      ),
    );
    expect(screen.queryByText("commentary")).toBeNull();
  });

  it("keeps the timestamp available for an attachment-only message without a copy action", () => {
    const timestamp = "2026-09-07T03:04:05Z";
    const { container } = render(
      <ConversationEventRow
        event={event(
          "attachment",
          "user-message",
          {},
          { content: "", attachment_count: 1, timestamp },
        )}
        variant="hub"
      />,
    );
    expect(container.querySelector("time")).toHaveAttribute("datetime", timestamp);
    expect(container.querySelector("[data-message-body]")).toBeNull();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("keeps the line breaks and placeholders of text Claude Code wrote itself", () => {
    // Replies CLI 2.1.311 wrote for bare /usage and /model, run offline against a local API
    // stub; shortened.
    const usage =
      "Total cost:            $0.0000\nTotal duration (API):  0s\nTotal duration (wall): 0s";
    const model =
      "Current model: `Haiku 5.5`\nUsage: /model <name>. Available: sonnet, opus, or a full model ID.";
    const { container } = render(
      <>
        <ConversationEventRow
          event={event("usage", "agent-message", {}, { content: usage, cli_output: true })}
        />
        <ConversationEventRow
          event={event("model", "agent-message", {}, { content: model, cli_output: true })}
        />
        <ConversationEventRow
          event={event(
            "nested",
            "agent-message",
            {},
            { content: "**two\nlines**", cli_output: true },
          )}
        />
        <ConversationEventRow event={event("reply", "agent-message", {}, { content: usage })} />
      </>,
    );
    const body = (id: string) =>
      container.querySelector(`[data-event-id="${id}"] .markdown-content`)!;
    expect(body("usage").querySelectorAll("br")).toHaveLength(2);
    expect(body("model").querySelectorAll("br")).toHaveLength(1);
    expect(body("model").querySelector("code")).toHaveTextContent("Haiku 5.5");
    expect(body("model")).toHaveTextContent("Usage: /model <name>. Available:");
    // Inside emphasis too.
    expect(body("nested").querySelectorAll("strong > br")).toHaveLength(1);
    // A model's reply is Markdown as before.
    expect(body("reply").querySelectorAll("br")).toHaveLength(0);
  });
});
