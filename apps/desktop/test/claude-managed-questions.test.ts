import { describe, expect, it } from "vitest";
import {
  claudeManagedQuestionAnswer,
  claudeManagedQuestions,
} from "../../../packages/backend/src/agents/claude/claude-managed-questions";

describe("managed Claude question answers", () => {
  const input = {
    questions: [
      {
        question: "Which layout?",
        header: "Layout",
        options: [
          { label: "Grid", description: "Two columns", preview: "  A | B\n" },
          { label: "List", description: "One column" },
        ],
        multiSelect: false,
      },
      {
        question: "Which extras?",
        options: [{ label: "Logs, detailed" }, { label: "Metrics" }],
        multiSelect: true,
      },
      {
        question: "What name?",
        options: [{ label: "First" }, { label: "Second" }],
      },
    ],
    metadata: { source: "fixture" },
  };
  const answers = {
    "Which layout?": ["Grid"],
    "Which extras?": ["Logs, detailed", "Metrics"],
    "What name?": ["A custom name"],
  };

  it("preserves preview text and the legacy choice and custom answer format", () => {
    const questions = claudeManagedQuestions(input);
    expect(questions[0]).toMatchObject({ allowCustom: true, options: input.questions[0]!.options });
    expect(claudeManagedQuestionAnswer(input, questions, answers, undefined)).toEqual({
      ...input,
      answers: {
        "Which layout?": "Grid",
        "Which extras?": "Logs, detailed, Metrics",
        "What name?": "A custom name",
      },
      annotations: { "Which layout?": { preview: "  A | B\n" } },
    });
    expect(
      claudeManagedQuestionAnswer(input, questions, answers, { "Which layout?": "Keep B" }),
    ).toMatchObject({
      annotations: { "Which layout?": { preview: "  A | B\n", notes: "Keep B" } },
    });
  });

  it("requires a valid question and the selected single-choice preview for each note", () => {
    const questions = claudeManagedQuestions(input);
    const answer = (notes: unknown) =>
      claudeManagedQuestionAnswer(input, questions, answers, notes);
    expect(() => answer({ Another: "Keep B" })).toThrow("invalid answer notes");
    expect(() => answer({ "Which layout?": { preview: "Caller-provided preview" } })).toThrow(
      "invalid answer notes",
    );
    expect(() => answer({ "Which layout?": "礼".repeat(2731) })).toThrow("invalid answer notes");
    expect(() => answer({ "What name?": "Keep B" })).toThrow(
      "answer note requires a selected single-choice preview",
    );

    const multiple = {
      questions: [
        {
          question: "Which layouts?",
          options: [
            { label: "Grid", preview: "Grid preview" },
            { label: "List", preview: "List preview" },
          ],
          multiSelect: true,
        },
      ],
    };
    const rows = claudeManagedQuestions(multiple);
    const selected = { "Which layouts?": ["Grid", "List"] };
    expect(claudeManagedQuestionAnswer(multiple, rows, selected, undefined)).not.toHaveProperty(
      "annotations",
    );
    expect(() =>
      claudeManagedQuestionAnswer(multiple, rows, selected, { "Which layouts?": "Note" }),
    ).toThrow("answer note requires a selected single-choice preview");
  });

  it("keeps rejecting unrecognized question and choice fields and non-text previews", () => {
    const question = input.questions[0]!;
    expect(() => claudeManagedQuestions({ questions: [{ ...question, kind: "number" }] })).toThrow(
      "unsupported question fields",
    );
    expect(() =>
      claudeManagedQuestions({
        questions: [
          {
            ...question,
            options: [{ label: "Grid", action: "new" }, { label: "List" }],
          },
        ],
      }),
    ).toThrow("unsupported choice fields");
    expect(() =>
      claudeManagedQuestions({
        questions: [
          {
            ...question,
            options: [{ label: "Grid", preview: { text: "new" } }, { label: "List" }],
          },
        ],
      }),
    ).toThrow("invalid Claude choice preview");
  });
});
