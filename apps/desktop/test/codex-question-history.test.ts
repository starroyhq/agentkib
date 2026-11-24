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

const questions = [
  {
    id: "layout",
    header: "Layout",
    question: "Which layout should this use?",
    options: [
      { label: "Compact", description: "Tight spacing" },
      { label: "Wide", description: "More room" },
    ],
  },
  {
    id: "theme",
    header: "Theme",
    question: "Which theme should this use?",
    options: [
      { label: "Light", description: "Light background" },
      { label: "Dark", description: "Dark background" },
    ],
  },
  { id: "password", header: "Password", question: "What is the password?", isSecret: true },
  { id: "constructor", header: "Note", question: "Any other notes?", options: [] },
];

function item(payload: unknown) {
  return { type: "response_item", payload };
}

// OpenAI Codex stores the function's arguments and output as separate JSON strings,
// associated by call_id in the rollout. Answer keys are the native question IDs.
function questionCall(callId: string, fields = {}) {
  return item({
    type: "function_call",
    call_id: callId,
    name: "request_user_input",
    arguments: JSON.stringify({ questions }),
    ...fields,
  });
}

function questionResult(callId: string, output: string) {
  return item({ type: "function_call_output", call_id: callId, output });
}

const validResult = JSON.stringify({
  answers: {
    theme: { answers: ["Match the system"] },
    password: { answers: ["fixture-only-password"] },
    layout: { answers: ["Wide"] },
  },
});

const answer = {
  status: "answered",
  questions: [
    { ...questions[0], answer: { selected: ["Wide"] } },
    { ...questions[1], answer: { selected: [], custom: "Match the system" } },
    { id: "password", options: [] },
    questions[3],
  ],
};

function setup(...rows: unknown[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "agentkib-codex-questions-"));
  directories.push(dir);
  const file = path.join(dir, "rollout.jsonl");
  writeFileSync(file, "");
  const append = (...values: unknown[]) =>
    appendFileSync(file, values.map((value) => JSON.stringify(value) + "\n").join(""));
  append(...rows);
  const paging = new SessionPaging();
  return {
    read: (cursor: string | null = null, limit = 50) => paging.read(file, cursor, limit, "codex"),
    append,
  };
}

it("updates a Codex questionnaire with selections and custom text without exposing secret answers", () => {
  const session = setup(questionCall("call-question"));
  const pending = session.read().events[0]!;
  expect(pending.questionnaire).toMatchObject({
    status: "pending",
    questions: [questions[0], questions[1], { id: "password", options: [] }, questions[3]],
  });

  session.append(questionResult("call-question", validResult));
  const page = session.read();
  expect(page.events).toHaveLength(1);
  expect(page.events[0]).toMatchObject({ id: pending.id, questionnaire: answer });
  expect(page.events[0]?.questionnaire?.questions[2]?.answer).toBeUndefined();
  expect(JSON.stringify(page)).not.toContain("fixture-only-password");
});

it("joins only the matching native call across transcript pages", () => {
  const session = setup(
    questionCall("call-question"),
    item({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Waiting" }],
    }),
    questionResult("call-question", validResult),
    questionResult("other-call", JSON.stringify({ answers: { layout: { answers: ["Compact"] } } })),
  );
  const first = session.read(null, 1);
  expect(first.events.map((event) => event.content)).toEqual(["Waiting"]);
  expect(first.next_cursor).toBeTruthy();
  const older = session.read(first.next_cursor, 1);
  expect(older.events[0]?.questionnaire).toMatchObject(answer);
  expect(older.events[0]?.questionnaire?.questions[3]?.answer).toBeUndefined();
});

it("keeps cancelled questions read-only and leaves namespaced tools as normal tools", () => {
  const session = setup(
    questionCall("cancelled"),
    questionResult("cancelled", "request_user_input was cancelled before receiving a response"),
    questionCall("external", { namespace: "third-party" }),
    questionResult("external", validResult),
  );
  const [cancelled, external] = session.read().events;
  expect(cancelled?.questionnaire).toMatchObject({ status: "closed" });
  expect(cancelled?.questionnaire?.questions[0]?.answer).toBeUndefined();
  expect(external).toMatchObject({ kind: "tool-summary", tool_name: "request_user_input" });
  expect(external?.questionnaire).toBeUndefined();
});
