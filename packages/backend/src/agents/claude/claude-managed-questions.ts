import type { SessionInteractionQuestion } from "@agentkib/runtime-protocol";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function claudeManagedQuestions(input: JsonObject): SessionInteractionQuestion[] {
  if (Object.keys(input).some((key) => !["questions", "metadata"].includes(key)))
    throw new Error("unsupported question input");
  const rows = input.questions;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4)
    throw new Error("unsupported question count");
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) => !["question", "header", "options", "multiSelect"].includes(key),
      )
    )
      throw new Error("unsupported question fields");
    if (typeof row.question !== "string" || !row.question || ids.has(row.question))
      throw new Error("invalid or duplicate Claude question");
    ids.add(row.question);
    if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 4)
      throw new Error("unsupported choices");
    const labels = new Set<string>();
    for (const option of row.options) {
      if (
        !object(option) ||
        Object.keys(option).some((key) => !["label", "description", "preview"].includes(key))
      )
        throw new Error("unsupported choice fields");
      if (typeof option.label !== "string" || !option.label || labels.has(option.label))
        throw new Error("invalid or duplicate Claude choice");
      if (option.preview !== undefined && typeof option.preview !== "string")
        throw new Error("invalid Claude choice preview");
      labels.add(option.label);
    }
    if (row.multiSelect !== undefined && typeof row.multiSelect !== "boolean")
      throw new Error("invalid multiSelect");
    return {
      id: row.question,
      header: row.header as string | undefined,
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
