import type { ConversationQuestionnaire } from "@agentkib/runtime-protocol";
import { truncateUtf8 } from "../../session-event-values";
import { sanitizeSessionText } from "../../session-handoff";

type Question = ConversationQuestionnaire["questions"][number];
export type CodexQuestionnaireOutput = Record<string, { answers: string[] }>;

const MAX_NATIVE_BYTES = 64 * 1024;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_ANSWERS = MAX_OPTIONS + 1;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function nativeJson(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value.length > MAX_NATIVE_BYTES ||
    !/^\s*\{/.test(value) ||
    Buffer.byteLength(value) > MAX_NATIVE_BYTES
  )
    return;
  try {
    return JSON.parse(value);
  } catch {
    return;
  }
}

function display(value: string, maximum: number): string {
  const { content, truncated } = truncateUtf8(sanitizeSessionText(value, { value: 0 }), maximum);
  return truncated ? `${content}…` : content;
}

export function codexQuestionnaireInput(
  name: string,
  argumentsJson: unknown,
  namespace: unknown,
): unknown {
  if (name === "request_user_input" && namespace == null) return nativeJson(argumentsJson);
}

/** Codex persists the JSON-serialized answer map as a function_call_output string. */
export function codexQuestionnaireOutput(output: unknown): CodexQuestionnaireOutput | undefined {
  const value = nativeJson(output);
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.answers)) return;
  const entries = Object.entries(value.answers);
  if (entries.length > MAX_QUESTIONS) return;
  const answers: CodexQuestionnaireOutput = Object.create(null);
  for (const [id, item] of entries) {
    if (
      !id.trim() ||
      Buffer.byteLength(id) > 256 ||
      !record(item) ||
      Object.keys(item).length !== 1 ||
      !Array.isArray(item.answers) ||
      item.answers.length > MAX_ANSWERS ||
      !item.answers.every((answer) => typeof answer === "string")
    )
      return;
    answers[id] = { answers: item.answers };
  }
  return answers;
}

export function codexQuestionnaire(
  input: unknown,
  output: CodexQuestionnaireOutput | undefined,
  completed: boolean,
): ConversationQuestionnaire | undefined {
  if (
    !record(input) ||
    !Array.isArray(input.questions) ||
    input.questions.length === 0 ||
    input.questions.length > MAX_QUESTIONS
  )
    return;

  const questions: Question[] = [];
  const ids = new Set<string>();
  let answered = false;
  for (const value of input.questions) {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      !value.id.trim() ||
      Buffer.byteLength(value.id) > 256 ||
      ids.has(value.id) ||
      typeof value.question !== "string" ||
      !value.question.trim() ||
      (value.isSecret !== undefined && typeof value.isSecret !== "boolean")
    )
      return;
    ids.add(value.id);
    const nativeOptions = value.options ?? [];
    if (!Array.isArray(nativeOptions) || nativeOptions.length > MAX_OPTIONS) return;
    const options = new Map<string, Question["options"][number]>();
    for (const option of nativeOptions) {
      if (!record(option) || typeof option.label !== "string" || !option.label.trim()) return;
      options.set(option.label, {
        label: display(option.label, 1024),
        description:
          typeof option.description === "string" ? display(option.description, 4096) : undefined,
      });
    }
    const question: Question = {
      id: value.id,
      header: typeof value.header === "string" ? display(value.header, 1024) : undefined,
      question: display(value.question, 4096),
      multiSelect: false,
      options: [...options.values()],
    };
    const answers =
      output && Object.hasOwn(output, value.id)
        ? output[value.id]!.answers.filter((answer) => answer.trim())
        : undefined;
    if (answers?.length) {
      answered = true;
      // The terminal may persist plaintext for password-style questions.
      if (value.isSecret !== true) {
        const selected: string[] = [];
        const custom: string[] = [];
        for (const answer of new Set(answers)) {
          const option = options.get(answer);
          if (option) selected.push(option.label);
          else custom.push(answer);
        }
        question.answer = {
          selected,
          ...(custom.length ? { custom: display(custom.join("\n"), 8192) } : {}),
        };
      }
    }
    questions.push(question);
  }
  return { status: answered ? "answered" : completed ? "closed" : "pending", questions };
}
