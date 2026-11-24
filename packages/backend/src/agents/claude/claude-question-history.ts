import type { ConversationQuestionnaire } from "@agentkib/runtime-protocol";
import { truncateUtf8 } from "../../session-event-values";
import { sanitizeSessionText } from "../../session-handoff";

type Question = ConversationQuestionnaire["questions"][number];
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
    source.questions.length > 4 ||
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
