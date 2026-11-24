import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZsAAAAASUVORK5CYII=";
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: png },
};
const questions = [
  {
    question: "Pick a layout",
    header: "Layout",
    multiSelect: false,
    options: [
      { label: "Compact", description: "Tight spacing" },
      { label: "Wide", description: "More room" },
    ],
  },
  {
    question: "Pick features",
    header: "Features",
    multiSelect: true,
    options: [{ label: "Logs, detailed" }, { label: "Metrics" }, { label: "Tracing" }],
  },
  {
    question: "Choose a preview",
    header: "Preview",
    multiSelect: false,
    options: [{ label: "Map", preview: "Option preview" }, { label: "List" }],
  },
  {
    question: "Add a note",
    header: "Note",
    multiSelect: true,
    options: [{ label: "Notes" }, { label: "Nothing" }],
  },
];
const prompt = {
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions } },
    ],
  },
};
const answer = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_question",
        content: 'The user answered: "Pick a layout"="Wide"',
      },
      image,
    ],
  },
  toolUseResult: {
    questions,
    answers: {
      "Pick a layout": "Wide",
      "Pick features": "Logs, detailed, Tracing",
      "Choose a preview": "Map",
      "Add a note": "Notes, custom wording (Image attached)",
    },
    annotations: { "Choose a preview": { preview: "Selected preview" } },
  },
  imagePasteIds: [68],
};

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkib-claude-questions-"));
  directories.push(dir);
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify(prompt) + "\n");
  const paging = new SessionPaging();
  return {
    append: (...rows: unknown[]) =>
      appendFileSync(file, rows.map((row) => JSON.stringify(row) + "\n").join("")),
    read: (cursor: string | null = null, count = 50) =>
      paging.read(file, cursor, count, "claude-code"),
    loadImage: (id: string) => paging.image(file, id),
  };
}

it("updates a pending native question into answered history with its attachment", () => {
  const session = setup();
  const pending = session.read().events[0];
  expect(pending).toMatchObject({
    id: "toolu_question",
    questionnaire: { status: "pending", questions },
  });

  session.append(answer);
  const page = session.read();
  expect(page.events).toHaveLength(1);
  const answered = page.events[0]!;
  expect(answered.id).toBe(pending!.id);
  expect(answered.questionnaire).toMatchObject({
    status: "answered",
    questions: [
      { ...questions[0], answer: { selected: ["Wide"] } },
      { ...questions[1], answer: { selected: ["Logs, detailed", "Tracing"] } },
      { ...questions[2], answer: { selected: ["Map"], preview: "Selected preview" } },
      {
        ...questions[3],
        answer: { selected: [], custom: "Notes, custom wording (Image attached)" },
      },
    ],
  });
  expect(answered.questionnaire?.imageQuestionId).toBe(answered.questionnaire?.questions[3]?.id);
  expect(answered.attachment_count).toBe(1);
  expect(answered.images).toHaveLength(1);
  expect(session.loadImage(answered.images![0]!.id)).toEqual({
    mimeType: "image/png",
    base64: png,
  });
  expect(JSON.stringify(page)).not.toContain(png);
});

it("keeps the answer and attachment associated when reading older pages", () => {
  const session = setup();
  session.append(
    { type: "assistant", message: { role: "assistant", content: "While you choose…" } },
    answer,
  );
  const head = session.read(null, 1);
  expect(head.events.map((event) => event.content)).toEqual(["While you choose…"]);
  expect(head.next_cursor).toBeTruthy();
  const older = session.read(head.next_cursor, 1);
  expect(older.events[0]).toMatchObject({
    id: "toolu_question",
    questionnaire: { status: "answered" },
    attachment_count: 1,
  });
});

it("does not treat a failed tool result as pending or as an answer", () => {
  const session = setup();
  session.append({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_question",
          content: "Cancelled",
          is_error: true,
        },
      ],
    },
  });
  expect(session.read().events[0]?.questionnaire).toMatchObject({ status: "closed", questions });
});

it("keeps user images on results that only resemble a questionnaire", () => {
  const session = setup();
  session.append({
    ...answer,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "other-tool", content: "Tool output" }, image],
    },
  });
  expect(session.read().events).toMatchObject([
    { id: "toolu_question", questionnaire: { status: "pending" } },
    { kind: "user-message", attachment_count: 1, images: [{ mimeType: "image/png" }] },
  ]);
});
