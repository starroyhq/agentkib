import type { SessionInteractionQuestion } from "@agentkib/runtime-protocol";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class UnsupportedClaudeQuestionError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(detail);
  }
}

function checkFields(value: JsonObject, allowed: string[], detail: string): void {
  const field = Object.keys(value).find((key) => !allowed.includes(key));
  if (field !== undefined) throw new UnsupportedClaudeQuestionError(field, detail);
}

export function claudeManagedQuestions(input: unknown): SessionInteractionQuestion[] {
  if (!object(input)) throw new UnsupportedClaudeQuestionError("input", "invalid tool input");
  checkFields(input, ["questions", "metadata"], "unsupported question input");
  if (input.metadata !== undefined) {
    if (!object(input.metadata))
      throw new UnsupportedClaudeQuestionError("metadata", "invalid question metadata");
    checkFields(input.metadata, ["source"], "unsupported question metadata fields");
    if (input.metadata.source !== undefined && typeof input.metadata.source !== "string")
      throw new UnsupportedClaudeQuestionError("source", "invalid question metadata source");
  }
  const rows = input.questions;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4)
    throw new UnsupportedClaudeQuestionError("questions", "unsupported question count");
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (!object(row)) throw new UnsupportedClaudeQuestionError("questions", "invalid question");
    checkFields(
      row,
      ["question", "header", "options", "multiSelect"],
      "unsupported question fields",
    );
    if (typeof row.question !== "string" || !row.question.trim() || ids.has(row.question))
      throw new UnsupportedClaudeQuestionError("question", "invalid or duplicate Claude question");
    ids.add(row.question);
    if (row.header !== undefined && typeof row.header !== "string")
      throw new UnsupportedClaudeQuestionError("header", "invalid question header");
    if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 4)
      throw new UnsupportedClaudeQuestionError("options", "unsupported choices");
    const labels = new Set<string>();
    for (const option of row.options) {
      if (!object(option)) throw new UnsupportedClaudeQuestionError("options", "invalid choice");
      checkFields(option, ["label", "description", "preview"], "unsupported choice fields");
      if (typeof option.label !== "string" || !option.label.trim() || labels.has(option.label))
        throw new UnsupportedClaudeQuestionError("label", "invalid or duplicate Claude choice");
      if (option.description !== undefined && typeof option.description !== "string")
        throw new UnsupportedClaudeQuestionError(
          "description",
          "invalid Claude choice description",
        );
      if (option.preview !== undefined && typeof option.preview !== "string")
        throw new UnsupportedClaudeQuestionError("preview", "invalid Claude choice preview");
      labels.add(option.label);
    }
    if (row.multiSelect !== undefined && typeof row.multiSelect !== "boolean")
      throw new UnsupportedClaudeQuestionError("multiSelect", "invalid multiSelect");
    return {
      id: row.question,
      header: row.header,
      question: row.question,
      options: row.options,
      multiSelect: row.multiSelect ?? false,
      allowCustom: true,
    };
  });
}

export function claudeManagedQuestionAnswer(
  input: JsonObject,
  rows: SessionInteractionQuestion[],
  answers: unknown,
  answerNotes: unknown,
): JsonObject {
  if (!object(answers)) throw new Error("invalid answers");
  if (rows.length !== Object.keys(answers).length) throw new Error("answer keys mismatch");
  if (
    answerNotes !== undefined &&
    (!object(answerNotes) ||
      Object.entries(answerNotes).some(
        ([key, note]) =>
          !rows.some((row) => row.id === key) ||
          typeof note !== "string" ||
          !note.trim() ||
          Buffer.byteLength(note) > 8192,
      ))
  )
    throw new Error("invalid answer notes");
  const native: Record<string, string> = Object.create(null);
  const annotations: Record<string, { preview: string; notes?: string }> = Object.create(null);
  for (const row of rows) {
    const values = Object.hasOwn(answers, row.id) ? answers[row.id] : undefined;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 16 ||
      (!row.multiSelect && values.length !== 1)
    )
      throw new Error("invalid answer cardinality");
    const unique = new Set<string>();
    for (const value of values) {
      if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 8192)
        throw new Error("invalid answer text");
      if (unique.has(value)) throw new Error("duplicate answer");
      unique.add(value);
    }
    native[row.id] = values.join(", ");
    // Claude's native preview and its per-question annotation are for single-select questions.
    const preview = row.multiSelect
      ? undefined
      : row.options.find((option) => option.label === values[0])?.preview;
    const notes =
      answerNotes && Object.hasOwn(answerNotes, row.id) ? answerNotes[row.id] : undefined;
    if (notes !== undefined && !preview)
      throw new Error("answer note requires a selected single-choice preview");
    if (preview) annotations[row.id] = { preview, ...(typeof notes === "string" ? { notes } : {}) };
  }
  return {
    ...input,
    answers: native,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  };
}
