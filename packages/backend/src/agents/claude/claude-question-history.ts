import type { ConversationQuestionnaire } from "@agentkib/runtime-protocol";
import { truncateUtf8 } from "../../session-event-values";
import type { ConversationImage } from "../../session-events";
import { sanitizeSessionText } from "../../session-handoff";

type Question = ConversationQuestionnaire["questions"][number];
const MAX_QUESTIONS = 4;
const ANSWER_PREFIX = "The user answered: ";
const ANSWER_CONTINUATION =
  ". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function display(value: string, limit = 8192): string {
  const { content, truncated } = truncateUtf8(sanitizeSessionText(value, { value: 0 }), limit);
  return truncated ? `${content}…` : content;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? display(value) : undefined;
}

/** Labels can contain the same comma-space separator that Claude uses to join selections. */
function selectedLabels(answer: string, labels: string[], multiple: boolean): string[] {
  if (labels.includes(answer)) return [answer];
  if (!multiple) return [];
  const match = (remaining: string, available: string[]): string[] | undefined => {
    if (available.includes(remaining)) return [remaining];
    for (const label of available) {
      const prefix = `${label}, `;
      if (!remaining.startsWith(prefix)) continue;
      const tail = match(
        remaining.slice(prefix.length),
        available.filter((value) => value !== label),
      );
      if (tail) return [label, ...tail];
    }
  };
  return match(answer, labels) ?? [];
}

/** Project the tool input or its structured result without copying the native envelope. */
export function claudeQuestionnaire(
  source: unknown,
  status: ConversationQuestionnaire["status"],
  hasImages = false,
): ConversationQuestionnaire | undefined {
  if (
    !record(source) ||
    !Array.isArray(source.questions) ||
    source.questions.length === 0 ||
    source.questions.length > MAX_QUESTIONS ||
    (status === "answered" && !record(source.answers))
  )
    return;
  const answers = status === "answered" && record(source.answers) ? source.answers : {};
  const annotations = record(source.annotations) ? source.annotations : {};
  const questions: Question[] = [];
  const withImages: string[] = [];
  for (const value of source.questions) {
    if (
      !record(value) ||
      typeof value.question !== "string" ||
      !value.question.trim() ||
      !Array.isArray(value.options) ||
      value.options.length === 0 ||
      value.options.length > 4
    )
      return;
    const options: Question["options"] = [];
    const labels: string[] = [];
    for (const option of value.options) {
      if (!record(option) || typeof option.label !== "string" || !option.label.trim()) return;
      labels.push(option.label);
      options.push({
        label: display(option.label, 1024),
        description: optionalText(option.description),
        preview: optionalText(option.preview),
      });
    }
    const question: Question = {
      id: String(questions.length + 1),
      question: display(value.question, 4096),
      header: optionalText(value.header),
      multiSelect: value.multiSelect === true,
      options,
    };
    const raw = Object.hasOwn(answers, value.question) ? answers[value.question] : undefined;
    if (typeof raw === "string") {
      const selected = selectedLabels(raw, labels, question.multiSelect);
      const annotation = Object.hasOwn(annotations, value.question)
        ? annotations[value.question]
        : undefined;
      question.answer = {
        selected: selected.map((label) => display(label, 1024)),
        ...(!selected.length ? { custom: display(raw) } : {}),
        preview: record(annotation) ? optionalText(annotation.preview) : undefined,
      };
      if (hasImages && !selected.length && raw.includes("(Image attached)"))
        withImages.push(question.id);
    }
    questions.push(question);
  }
  const answered = questions.filter((question) => question.answer);
  if (status === "answered" && !answered.length) return;
  const imageQuestionId =
    withImages.length === 1
      ? withImages[0]
      : hasImages && answered.length === 1
        ? answered[0]!.id
        : undefined;
  return { status, questions, ...(imageQuestionId ? { imageQuestionId } : {}) };
}

interface ClaudeQuestionResult {
  value?: ConversationQuestionnaire;
  answerDetails?: {
    answers: Record<string, string>;
    annotations: Record<string, { preview: string }>;
  };
  images: ConversationImage[];
}

/** Read the native quoted pairs only when the entire bounded result matches the format. */
function nativeAnswerFallback(content: unknown): [string, string][] {
  if (typeof content !== "string" || !content.startsWith(ANSWER_PREFIX) || content.length > 32_768)
    return [];
  const pairs: [string, string][] = [];
  const pair = /("(?:[^"\\]|\\.)*")=("(?:[^"\\]|\\.)*")/sy;
  let offset = ANSWER_PREFIX.length;
  while (pairs.length < MAX_QUESTIONS) {
    pair.lastIndex = offset;
    const match = pair.exec(content);
    if (!match) return [];
    try {
      const question = JSON.parse(match[1]!) as string;
      const answer = JSON.parse(match[2]!) as string;
      if (!question || pairs.some(([previous]) => previous === question)) return [];
      pairs.push([question, answer]);
    } catch {
      return [];
    }
    if (pair.lastIndex === content.length || content.slice(pair.lastIndex) === ANSWER_CONTINUATION)
      return pairs;
    if (!content.startsWith(", ", pair.lastIndex)) return [];
    offset = pair.lastIndex + 2;
  }
  return [];
}

export function claudeQuestionHistoryResult(
  structured: unknown,
  content: unknown,
  rowImages: ConversationImage[],
): ClaudeQuestionResult | undefined {
  const images = typeof content === "string" && content.startsWith(ANSWER_PREFIX) ? rowImages : [];
  const value = claudeQuestionnaire(structured, "answered", images.length > 0);
  if (value) return { value, images };

  // Some result rows do not repeat the questions. Resolve their answers only
  // once the original tool use with exactly the same ID is available.
  const answers: Record<string, string> = Object.assign(
    Object.create(null),
    Object.fromEntries(nativeAnswerFallback(content)),
  );
  const annotations: Record<string, { preview: string }> = Object.create(null);
  const result = record(structured) ? structured : undefined;
  if (record(result?.answers)) {
    for (const [key, answer] of Object.entries(result.answers).slice(0, MAX_QUESTIONS)) {
      if (key.length <= 8192 && typeof answer === "string" && answer.length <= 16384)
        answers[key] = answer;
    }
  }
  if (!Object.keys(answers).length) return;
  if (record(result?.annotations)) {
    for (const key of Object.keys(answers)) {
      if (!Object.hasOwn(result.annotations, key)) continue;
      const entry = result.annotations[key];
      if (record(entry) && typeof entry.preview === "string" && entry.preview.length <= 16384)
        annotations[key] = { preview: entry.preview };
    }
  }
  return { answerDetails: { answers, annotations }, images };
}

export function claudeQuestionHistory(
  name: string,
  input: unknown,
  completed: boolean,
  answer: ClaudeQuestionResult | undefined,
) {
  if (name !== "AskUserQuestion") return;
  if (answer?.value) return { value: answer.value, images: answer.images };
  if (answer?.answerDetails && record(input)) {
    const value = claudeQuestionnaire(
      { questions: input.questions, ...answer.answerDetails },
      "answered",
      answer.images.length > 0,
    );
    if (value) return { value, images: answer.images };
  }
  const value = claudeQuestionnaire(input, completed ? "closed" : "pending");
  return value && { value };
}
