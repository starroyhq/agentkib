// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";
import { SessionTranscript } from "@agentkib/session-ui";

const props = {
  labels: {
    process: "Process",
    tools: "tools",
    failed: "failed",
    attachments: "attachments",
    truncated: "truncated",
    unknownTool: "Tool",
  },
  locale: "en-US",
  earlierLabel: "Earlier",
};

const questionEvent: ConversationEvent = {
  id: "toolu_question",
  turn_id: "turn",
  kind: "tool-summary",
  tool_name: "AskUserQuestion",
  attachment_count: 0,
  truncated: false,
  questionnaire: {
    status: "pending",
    questions: [
      {
        id: "layout",
        header: "Layout",
        question: "Which layout?",
        multiSelect: false,
        options: [
          { label: "Compact", description: "Less spacing", preview: "Preview from option" },
          { label: "Spacious", description: "More spacing" },
        ],
      },
      {
        id: "features",
        question: "Which features?",
        multiSelect: true,
        options: [
          { label: "Search" },
          { label: "Sync", preview: "Sync option preview" },
          { label: "Export" },
        ],
      },
      {
        id: "notes",
        question: "Any notes?",
        multiSelect: false,
        options: [{ label: "None" }],
      },
    ],
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows pending history questions and disables every option without adding answer controls", () => {
  render(<SessionTranscript {...props} events={[questionEvent]} />);
  const card = screen.getByRole("region", { name: "Question waiting" });
  expect(within(card).getByRole("heading", { name: "Layout · Which layout?" })).toBeVisible();
  expect(within(card).getByRole("heading", { name: "Which features?" })).toBeVisible();
  expect(within(card).getByRole("heading", { name: "Any notes?" })).toBeVisible();
  expect(within(card).getByText("Less spacing")).toBeVisible();
  expect(within(card).getByRole("button", { name: "Compact" })).toBeDisabled();
  expect(within(card).getByRole("checkbox", { name: "Search" })).toBeDisabled();
  expect(within(card).queryByRole("textbox")).toBeNull();
  expect(within(card).queryByRole("button", { name: "Send" })).toBeNull();
  expect(screen.queryByRole("button", { name: /process/i })).toBeNull();
});

it("leaves only the latest matching pending prompt to the live dock when history has no turn ID", () => {
  const events = [
    { ...questionEvent, turn_id: undefined, id: "earlier-question" },
    { ...questionEvent, turn_id: undefined },
  ];
  const { container, rerender } = render(
    <SessionTranscript
      {...props}
      events={events}
      liveQuestions={[
        {
          requestId: "active-request",
          turnId: "managed-turn",
          supported: true,
          questions: questionEvent.questionnaire!.questions.map((question) => ({
            ...question,
            allowCustom: true,
          })),
        },
      ]}
    />,
  );
  expect(container.querySelector('[data-event-id="earlier-question"]')).toBeInTheDocument();
  expect(container.querySelector('[data-event-id="toolu_question"]')).toBeNull();
  rerender(<SessionTranscript {...props} events={events} />);
  expect(container.querySelector('[data-event-id="toolu_question"]')).toBeInTheDocument();
});

it("shows selections and preview and puts the image in the custom answer of a completed turn", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:question-image");
      static revokeObjectURL = vi.fn();
    },
  );
  const imageLoader = vi.fn().mockResolvedValue({ mimeType: "image/png", base64: "iVBORw0KGgo=" });
  const [layout, features, notes] = questionEvent.questionnaire!.questions;
  render(
    <SessionTranscript
      {...props}
      events={[
        { ...questionEvent, id: "other-tool", tool_name: "Read", questionnaire: undefined },
        {
          ...questionEvent,
          attachment_count: 1,
          images: [{ id: "question-image", name: "reference.png" }],
          questionnaire: {
            status: "answered",
            questions: [
              { ...layout, answer: { selected: ["Compact"], preview: "Selected layout preview" } },
              { ...features, answer: { selected: ["Search", "Sync"] } },
              {
                ...notes,
                answer: { selected: [], custom: "Keep this exact text (Image attached)" },
              },
            ],
            imageQuestionId: "notes",
          },
        },
        {
          id: "reply",
          turn_id: "turn",
          kind: "agent-message",
          content: "Thanks",
          message_phase: "final_answer",
          attachment_count: 0,
          truncated: false,
          turn_meta: { outcome: "completed" },
        },
      ]}
      imageLoader={imageLoader}
    />,
  );
  const card = screen.getByRole("region", { name: "Question answered" });
  const compact = within(card).getByRole("button", { name: "Compact" });
  expect(compact).toBeDisabled();
  expect(compact).toHaveAttribute("aria-pressed", "true");
  expect(within(card).getByRole("checkbox", { name: "Search" })).toBeChecked();
  expect(within(card).getByRole("checkbox", { name: "Sync" })).toBeChecked();
  expect(within(card).getByRole("checkbox", { name: "Export" })).not.toBeChecked();
  expect(within(card).getByText("Selected layout preview")).toBeVisible();
  expect(within(card).getByText("Sync option preview")).toBeVisible();
  expect(within(card).queryByText("Preview from option")).toBeNull();
  const remarks = within(card).getByRole("region", { name: "Any notes?" });
  expect(within(remarks).getByText("Keep this exact text (Image attached)")).toBeVisible();
  expect(await within(remarks).findByRole("img", { name: "reference.png" })).toBeVisible();
  expect(imageLoader).toHaveBeenCalledWith("question-image", expect.any(AbortSignal));
  expect(screen.queryByText("AskUserQuestion")).toBeNull();
  expect(screen.getByText("Thanks")).toBeVisible();
});
