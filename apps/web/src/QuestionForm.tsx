import { useState } from "react";
import type { UserQuestionRequest } from "@agentkib/web-client";
import type { Locale } from "./i18n";

export const interactionCopy = {
  "zh-CN": {
    title: "需要你的回答",
    pending: "等待处理",
    submit: "提交回答",
    other: "自定义回答",
    unavailable: "此问题已失效或暂时无法回答，请同步状态后重试。",
    multiple: "可选择多项",
  },
  "zh-TW": {
    title: "需要你的回答",
    pending: "等待處理",
    submit: "提交回答",
    other: "自訂回答",
    unavailable: "此問題已失效或暫時無法回答，請同步狀態後重試。",
    multiple: "可選擇多項",
  },
  "en-US": {
    title: "Your answer is needed",
    pending: "Action required",
    submit: "Submit answers",
    other: "Custom answer",
    unavailable:
      "This question is no longer available or cannot be answered now. Refresh its status first.",
    multiple: "Select multiple options",
  },
  "ja-JP": {
    title: "回答が必要です",
    pending: "対応が必要です",
    submit: "回答を送信",
    other: "自由回答",
    unavailable: "この質問は無効か、現在回答できません。状態を更新してください。",
    multiple: "複数選択可能",
  },
};

export function QuestionForm({
  request,
  locale,
  enabled,
  busy,
  onSubmit,
}: {
  request: UserQuestionRequest;
  locale: Locale;
  enabled: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, string[]>) => void;
}) {
  const copy = interactionCopy[locale];
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [useCustom, setUseCustom] = useState<Record<string, boolean>>({});
  const answers = Object.fromEntries(
    request.questions.map((q) => [
      q.id,
      [
        ...(choices[q.id] ?? []),
        ...(useCustom[q.id] && custom[q.id]?.trim() ? [custom[q.id].trim()] : []),
      ],
    ]),
  );
  const valid =
    request.questions.length > 0 &&
    request.questions.every(
      (q) =>
        answers[q.id].length > 0 &&
        (q.multiSelect || answers[q.id].length === 1) &&
        (!useCustom[q.id] || !!custom[q.id]?.trim()),
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
                checked={(choices[q.id] ?? []).includes(option.label)}
                onChange={(event) => {
                  setChoices((previous) => ({
                    ...previous,
                    [q.id]: q.multiSelect
                      ? event.target.checked
                        ? [...(previous[q.id] ?? []), option.label]
                        : (previous[q.id] ?? []).filter((v) => v !== option.label)
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
                  checked={!!useCustom[q.id]}
                  onChange={(event) => {
                    setUseCustom((previous) => ({ ...previous, [q.id]: event.target.checked }));
                    if (!q.multiSelect) setChoices((previous) => ({ ...previous, [q.id]: [] }));
                  }}
                />
                {copy.other}
              </label>
              {useCustom[q.id] && (
                <textarea
                  aria-label={`${q.question} · ${copy.other}`}
                  maxLength={16000}
                  value={custom[q.id] ?? ""}
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
      <button className="primary" disabled={!enabled || busy || !valid} type="submit">
        {copy.submit}
      </button>
    </form>
  );
}
