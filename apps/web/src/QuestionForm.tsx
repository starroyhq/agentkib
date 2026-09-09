import { useState } from "react";
import type { UserQuestionRequest } from "@agentkib/web-client";
import type { Locale } from "./i18n";

export const MAX_ANSWER_LENGTH = 4096;
export const MAX_ANSWER_BYTES = 8192;
type AnswerContext = { sessionId: string; bootId: string; expectedRevision: number };
export function answerRequestBody(
  request: UserQuestionRequest,
  answers: Record<string, string[]>,
  context: AnswerContext,
  requestId: string,
) {
  return { ...context, requestId, turnId: request.turnId, questionId: request.requestId, answers };
}

function own<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** Native requests outside the supported contract remain readable, not executable forms. */
function hasSupportedQuestions(request: UserQuestionRequest): boolean {
  if (!request.supported || !Array.isArray(request.questions) || !request.questions.length)
    return false;
  const ids = new Set<string>();
  return request.questions.every((q) => {
    if (
      !q ||
      typeof q.id !== "string" ||
      !q.id ||
      ids.has(q.id) ||
      typeof q.question !== "string" ||
      !q.question ||
      (q.header != null && typeof q.header !== "string") ||
      typeof q.multiSelect !== "boolean" ||
      typeof q.allowCustom !== "boolean" ||
      !Array.isArray(q.options) ||
      (!q.options.length && !q.allowCustom)
    )
      return false;
    ids.add(q.id);
    const labels = new Set<string>();
    return q.options.every((option) => {
      if (
        !option ||
        typeof option.label !== "string" ||
        !option.label ||
        labels.has(option.label) ||
        (option.description != null && typeof option.description !== "string")
      )
        return false;
      labels.add(option.label);
      return true;
    });
  });
}

export const interactionCopy = {
  "zh-CN": {
    title: "需要你的回答",
    pending: "等待处理",
    submit: "提交回答",
    other: "自定义回答",
    unavailable: "此问题已失效或暂时无法回答，请同步状态后重试。",
    multiple: "可选择多项",
    tooLong: "每条回答最多 4096 个字符且不超过 8192 个 UTF-8 字节，请缩短回答。",
    duplicate: "自定义回答与已选选项重复，请修改或取消重复项。",
    tooLarge: "回答总量超过请求上限，请减少选项或缩短回答。",
  },
  "zh-TW": {
    title: "需要你的回答",
    pending: "等待處理",
    submit: "提交回答",
    other: "自訂回答",
    unavailable: "此問題已失效或暫時無法回答，請同步狀態後重試。",
    multiple: "可選擇多項",
    tooLong: "每條回答最多 4096 個字元且不超過 8192 個 UTF-8 位元組，請縮短回答。",
    duplicate: "自訂回答與已選選項重複，請修改或取消重複項。",
    tooLarge: "回答總量超過請求上限，請減少選項或縮短回答。",
  },
  "en-US": {
    title: "Your answer is needed",
    pending: "Action required",
    submit: "Submit answers",
    other: "Custom answer",
    unavailable:
      "This question is no longer available or cannot be answered now. Refresh its status first.",
    multiple: "Select multiple options",
    tooLong:
      "Each answer must fit within 4096 characters and 8192 UTF-8 bytes. Shorten your answer.",
    duplicate: "The custom answer duplicates a selected option. Change or deselect it.",
    tooLarge: "The answers exceed the request limit. Select fewer options or shorten your answers.",
  },
  "ja-JP": {
    title: "回答が必要です",
    pending: "対応が必要です",
    submit: "回答を送信",
    other: "自由回答",
    unavailable: "この質問は無効か、現在回答できません。状態を更新してください。",
    multiple: "複数選択可能",
    tooLong: "各回答は4096文字以内かつUTF-8で8192バイト以内にしてください。",
    duplicate: "自由回答が選択済みの項目と重複しています。変更または選択解除してください。",
    tooLarge: "回答の合計が上限を超えています。選択数を減らすか回答を短くしてください。",
  },
};

export function QuestionForm({
  request,
  locale,
  enabled,
  busy,
  onSubmit,
  requestContext,
}: {
  request: UserQuestionRequest;
  locale: Locale;
  enabled: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, string[]>) => void;
  requestContext?: AnswerContext;
}) {
  const copy = interactionCopy[locale];
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [useCustom, setUseCustom] = useState<Record<string, boolean>>({});
  if (!hasSupportedQuestions(request))
    return (
      <aside className="info" role="status">
        {copy.unavailable}
      </aside>
    );
  const answers = Object.fromEntries(
    request.questions.map((q) => [
      q.id,
      [
        ...(own(choices, q.id) ?? []),
        ...(own(useCustom, q.id) && own(custom, q.id)?.trim() ? [own(custom, q.id)!.trim()] : []),
      ],
    ]),
  );
  const values = Object.values(answers);
  // Use the complete wire shape, including the 36-character generated UUID,
  // because the HTTP limit counts UTF-8 JSON bytes rather than text characters.
  const body = answerRequestBody(
    request,
    answers,
    requestContext ?? { sessionId: "", bootId: "", expectedRevision: 0 },
    "0".repeat(36),
  );
  const validationError = values.some((items) =>
    items.some(
      (value) =>
        value.length > MAX_ANSWER_LENGTH ||
        new TextEncoder().encode(value).byteLength > MAX_ANSWER_BYTES,
    ),
  )
    ? copy.tooLong
    : values.some((items) => new Set(items).size !== items.length)
      ? copy.duplicate
      : Object.keys(answers).length > 32 ||
          Object.keys(answers).some((id) => id.length > 4096) ||
          values.some((items) => items.length > 64) ||
          new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024
        ? copy.tooLarge
        : undefined;
  const valid =
    !validationError &&
    request.questions.length > 0 &&
    request.questions.every(
      (q) =>
        answers[q.id].length > 0 &&
        (q.multiSelect || answers[q.id].length === 1) &&
        (!own(useCustom, q.id) || !!own(custom, q.id)?.trim()),
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (enabled && !busy && valid) onSubmit(answers);
      }}
    >
      {request.questions.map((q) => (
        <fieldset key={q.id} disabled={!enabled || busy} className="question-fieldset">
          <legend>
            {q.header && <small>{q.header} · </small>}
            {q.question}
          </legend>
          {q.multiSelect && <small>{copy.multiple}</small>}
          {q.options.map((option, index) => (
            <label key={index} className="question-option">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={q.id}
                checked={(own(choices, q.id) ?? []).includes(option.label)}
                onChange={(event) => {
                  setChoices((previous) => ({
                    ...previous,
                    [q.id]: q.multiSelect
                      ? event.target.checked
                        ? [...(own(previous, q.id) ?? []), option.label]
                        : (own(previous, q.id) ?? []).filter((v) => v !== option.label)
                      : [option.label],
                  }));
                  if (!q.multiSelect) setUseCustom((previous) => ({ ...previous, [q.id]: false }));
                }}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {q.allowCustom && (
            <>
              <label className="question-option">
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={q.id}
                  checked={!!own(useCustom, q.id)}
                  onChange={(event) => {
                    setUseCustom((previous) => ({ ...previous, [q.id]: event.target.checked }));
                    if (!q.multiSelect) setChoices((previous) => ({ ...previous, [q.id]: [] }));
                  }}
                />
                {copy.other}
              </label>
              {own(useCustom, q.id) && (
                <textarea
                  aria-label={`${q.question} · ${copy.other}`}
                  maxLength={MAX_ANSWER_LENGTH}
                  value={own(custom, q.id) ?? ""}
                  onChange={(event) =>
                    setCustom((previous) => ({ ...previous, [q.id]: event.target.value }))
                  }
                />
              )}
            </>
          )}
        </fieldset>
      ))}
      {!enabled && <aside className="info">{copy.unavailable}</aside>}
      {validationError && <p role="alert">{validationError}</p>}
      <button className="primary" disabled={!enabled || busy || !valid} type="submit">
        {copy.submit}
      </button>
    </form>
  );
}
