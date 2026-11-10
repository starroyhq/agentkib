import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  answerProblem,
  interactionCardCopy,
  MAX_ANSWER_LENGTH,
  ownValue,
  supportedQuestionRequest,
  type AnswerContext,
  type ApprovalCardModel,
  type ApprovalChoice,
  type InteractionCardCopy,
  type InteractionIcon,
  type InteractionLocale,
  type InteractionQuestionRequest,
} from "./interaction-model";

export type InteractionNoticeTone = "neutral" | "pending" | "done" | "lock" | "terminal" | "danger";
export interface InteractionNotice {
  tone: InteractionNoticeTone;
  text: string;
}

export interface ApprovalDockItem {
  kind: "approval";
  key: string;
  model: ApprovalCardModel;
  /** Whether this device may answer it now; a notice says why not when it matters. */
  enabled: boolean;
  notice?: InteractionNotice;
}
export interface QuestionDockItem {
  kind: "question";
  key: string;
  request: InteractionQuestionRequest;
  enabled: boolean;
  notice?: InteractionNotice;
  answerContext?: AnswerContext;
}
export type InteractionDockItem = ApprovalDockItem | QuestionDockItem;

export interface InteractionDockProps {
  locale: InteractionLocale;
  /** Requests waiting in this session, in the order they arrived. */
  items: InteractionDockItem[];
  busy: boolean;
  /** Why the host refused the last decision sent from a card; shown on that card. */
  failure?: string;
  /**
   * Said for a few seconds on a card whose request went away without this card answering it,
   * such as one answered in the agent's own client.
   */
  vanished?: InteractionNotice;
  /** A request to bring forward and expand, such as one picked in the pending list. */
  focusKey?: string;
  onFocused?: () => void;
  /** Resolves to `true` once the host accepted the decision. */
  onChoose: (item: ApprovalDockItem, choice: ApprovalChoice) => unknown;
  onAnswer: (item: QuestionDockItem, answers: Record<string, string[]>) => unknown;
}

type IconName =
  | InteractionIcon
  | "question"
  | "x"
  | "left"
  | "right"
  | "up"
  | "arrow"
  | "check"
  | "info"
  | "lock"
  | "terminal"
  | "alert"
  | "pencil"
  | "eye"
  | "eye-off"
  | "box"
  | "box-check";

// Lucide outlines, inlined because this package carries no icon dependency.
const ICONS: Record<IconName, ReactNode> = {
  command: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  files: (
    <>
      <path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  permissions: (
    <>
      <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </>
  ),
  tool: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  question: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  left: <path d="m15 18-6-6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  up: <path d="m18 15-6-6-6 6" />,
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  terminal: (
    <>
      <path d="m4 17 6-6-6-6" />
      <path d="M12 19h8" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  pencil: (
    <>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </>
  ),
  eye: (
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </>
  ),
  box: <rect width="18" height="18" x="3" y="3" rx="2" />,
  "box-check": (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
};

function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {ICONS[name]}
    </svg>
  );
}

const spinner =
  "size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none";
const ghostIcon =
  "inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";
const optionRow =
  "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:hover:bg-transparent";

function NoticeLine({ notice }: { notice: InteractionNotice }) {
  const danger = notice.tone === "danger";
  return (
    <p
      role={danger ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs leading-5 ${danger ? "bg-destructive/10 text-destructive-text" : "bg-muted/60 text-muted-foreground"}`}
    >
      {notice.tone === "pending" ? (
        <span aria-hidden="true" className={`${spinner} mt-0.5`} />
      ) : (
        <Icon
          className="mt-0.5 size-3.5"
          name={
            notice.tone === "done"
              ? "check"
              : notice.tone === "lock"
                ? "lock"
                : notice.tone === "terminal"
                  ? "terminal"
                  : danger
                    ? "alert"
                    : "info"
          }
        />
      )}
      <span className="min-w-0 break-words">{notice.text}</span>
    </p>
  );
}

interface FrameProps {
  t: InteractionCardCopy;
  icon: IconName;
  label: string;
  heading: ReactNode;
  headingTone?: "title" | "kind";
  pager?: { index: number; count: number; go: (index: number) => void };
  onCollapse: () => void;
  hidden: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}

function Frame({
  t,
  icon,
  label,
  heading,
  headingTone = "title",
  pager,
  onCollapse,
  hidden,
  onKeyDown,
  children,
}: FrameProps) {
  return (
    <section
      role="region"
      aria-label={label}
      hidden={hidden}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCollapse();
          return;
        }
        onKeyDown?.(event);
      }}
      className="w-full max-w-3xl shrink-0 self-center space-y-3 rounded-2xl border bg-background px-4 pb-3 pt-3 shadow-sm focus-visible:outline-none"
    >
      <header className="flex items-start gap-2">
        <span
          className={
            headingTone === "kind" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
          }
        >
          <Icon name={icon} className="mt-0.5 size-4" />
        </span>
        <div
          className={`min-w-0 flex-1 break-words ${headingTone === "kind" ? "text-sm text-muted-foreground" : "text-[15px] font-medium leading-6"}`}
        >
          {heading}
        </div>
        {pager && pager.count > 1 && (
          <div className="flex shrink-0 items-center text-xs tabular-nums text-muted-foreground">
            <button
              type="button"
              className={ghostIcon}
              aria-label={t.previous}
              disabled={pager.index === 0}
              onClick={() => pager.go(pager.index - 1)}
            >
              <Icon name="left" />
            </button>
            <span>
              {pager.index + 1}/{pager.count}
            </span>
            <button
              type="button"
              className={ghostIcon}
              aria-label={t.next}
              disabled={pager.index === pager.count - 1}
              onClick={() => pager.go(pager.index + 1)}
            >
              <Icon name="right" />
            </button>
          </div>
        )}
        <button type="button" className={ghostIcon} aria-label={t.collapse} onClick={onCollapse}>
          <Icon name="x" />
        </button>
      </header>
      {children}
    </section>
  );
}

function Details({ t, value }: { t: InteractionCardCopy; value: string }) {
  return (
    <details className="group text-xs">
      <summary className="ml-auto flex w-fit cursor-pointer list-none items-center gap-0.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {t.details}
        <Icon name="right" className="size-3 transition-transform group-open:rotate-90" />
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-2.5 font-mono text-[11px] leading-5">
        {value}
      </pre>
    </details>
  );
}

function ApprovalCard({
  item,
  t,
  hidden,
  busy,
  pending,
  failure,
  pager,
  onCollapse,
  onChoose,
}: {
  item: ApprovalDockItem;
  t: InteractionCardCopy;
  hidden: boolean;
  busy: boolean;
  pending?: string;
  failure?: string;
  pager: FrameProps["pager"];
  onCollapse: () => void;
  onChoose: (choice: ApprovalChoice) => void;
}) {
  const { model } = item;
  const [active, setActive] = useState(0);
  const idPrefix = useId();
  const sending = pending !== undefined;
  const locked = !item.enabled || busy || sending;
  const choices = model.choices;
  const choose = (choice: ApprovalChoice | undefined) => {
    if (choice && !choice.disabled && !locked) onChoose(choice);
  };
  return (
    <Frame
      t={t}
      icon={model.icon}
      label={t.waitingApproval}
      heading={<h3>{model.title}</h3>}
      pager={pager}
      onCollapse={onCollapse}
      hidden={hidden}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, summary, pre")) return;
        if (/^[1-9]$/.test(event.key) && choices[Number(event.key) - 1]) {
          event.preventDefault();
          choose(choices[Number(event.key) - 1]);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = Math.min(
            choices.length - 1,
            Math.max(0, active + (event.key === "ArrowDown" ? 1 : -1)),
          );
          setActive(next);
          document.getElementById(`${idPrefix}-choice-${next}`)?.focus();
        } else if (event.key === "Enter" && target === event.currentTarget) {
          event.preventDefault();
          choose(choices[active]);
        }
      }}
    >
      {model.block && (
        <div className="space-y-1 rounded-lg border bg-muted/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">{model.block.label}</p>
          {model.block.lines.map((line, index) => (
            <p
              key={index}
              className="whitespace-pre-wrap break-all font-mono text-[13px] leading-5"
            >
              {line}
            </p>
          ))}
        </div>
      )}
      {model.message && <p className="whitespace-pre-wrap break-words text-sm">{model.message}</p>}
      {(model.reason || model.needs || model.location) && (
        <div className="space-y-1 text-xs leading-5">
          {model.reason && (
            <p className="break-words">
              <span className="text-muted-foreground">{model.reason.label}</span>
              {model.reason.text}
            </p>
          )}
          {model.needs && (
            <p className="break-words">
              <span className="text-muted-foreground">{model.needs.label}</span>
              {model.needs.text}
            </p>
          )}
          {model.location && <p className="break-all text-muted-foreground">{model.location}</p>}
        </div>
      )}
      {item.notice ? (
        <NoticeLine notice={item.notice} />
      ) : (
        choices.length > 0 && (
          <div role="group" aria-label={t.waitingApproval} className="-mx-1 space-y-0.5">
            {choices.map((choice, index) => {
              const id = `${idPrefix}-choice-${index}`;
              const isPending = pending === choice.key;
              return (
                <button
                  key={choice.key}
                  id={id}
                  type="button"
                  className={`${optionRow} ${index === active && !locked ? "bg-muted" : ""} ${sending && !isPending ? "opacity-40" : ""}`}
                  aria-label={choice.label}
                  aria-describedby={choice.detail ? `${id}-detail` : undefined}
                  aria-busy={isPending || undefined}
                  disabled={locked || choice.disabled}
                  onFocus={() => setActive(index)}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(choice)}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-5 shrink-0 place-items-center rounded-md border bg-background text-[11px] tabular-nums text-muted-foreground"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{choice.label}</span>
                    {choice.detail && (
                      <span
                        id={`${id}-detail`}
                        className="block break-words text-xs text-muted-foreground"
                      >
                        {choice.detail}
                      </span>
                    )}
                  </span>
                  {isPending ? (
                    <span
                      role="status"
                      aria-label={t.sending}
                      className={`${spinner} text-primary-text`}
                    />
                  ) : (
                    index === active &&
                    !locked && <Icon name="arrow" className="size-4 text-muted-foreground" />
                  )}
                </button>
              );
            })}
          </div>
        )
      )}
      {!item.notice && model.declineOnly && (
        <NoticeLine notice={{ tone: "neutral", text: model.declineOnly }} />
      )}
      {failure && <NoticeLine notice={{ tone: "danger", text: failure }} />}
      <Details t={t} value={model.details} />
    </Frame>
  );
}

type Question = InteractionQuestionRequest["questions"][number];

function answersFor(
  questions: Question[],
  choices: Record<string, string[]>,
  custom: Record<string, string>,
): Record<string, string[]> {
  return Object.fromEntries(
    questions.map((q) => {
      const typed = ownValue(custom, q.id) ?? "";
      const own = ownValue(choices, q.id) ?? [];
      const written = typed.trim() ? (q.isSecret || q.secret ? typed : typed.trim()) : undefined;
      return [
        q.id,
        q.multiSelect
          ? [...own, ...(written !== undefined ? [written] : [])]
          : written !== undefined
            ? [written]
            : own.slice(0, 1),
      ];
    }),
  );
}

function QuestionCard({
  item,
  t,
  locale,
  hidden,
  busy,
  sending,
  failure,
  pager,
  onCollapse,
  onAnswer,
}: {
  item: QuestionDockItem;
  t: InteractionCardCopy;
  locale: InteractionLocale;
  hidden: boolean;
  busy: boolean;
  sending: boolean;
  failure?: string;
  pager: FrameProps["pager"];
  onCollapse: () => void;
  onAnswer: (answers: Record<string, string[]>) => void;
}) {
  const request = item.request;
  const supported = supportedQuestionRequest(request);
  const questions = supported ? request.questions : [];
  const [index, setIndex] = useState(0);
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const inputId = useId();
  const locked = !item.enabled || busy || sending;
  const q = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const answers = answersFor(questions, choices, custom);
  const problem = supported
    ? answerProblem(request, answers, item.answerContext, locale)
    : undefined;
  const answered = (question: Question) => (answers[question.id] ?? []).length > 0;
  const complete =
    questions.length > 0 &&
    questions.every(
      (question) =>
        answered(question) && (question.multiSelect || answers[question.id].length === 1),
    );
  const last = index >= questions.length - 1;
  const submit = (nextAnswers: Record<string, string[]>) => {
    if (locked) return;
    onAnswer(nextAnswers);
    // A secret answer must not linger in the page once it has left.
    if (questions.some((question) => question.isSecret || question.secret)) {
      setCustom({});
      setChoices({});
    }
  };
  const advance = (nextChoices: Record<string, string[]>, nextCustom: Record<string, string>) => {
    const nextAnswers = answersFor(questions, nextChoices, nextCustom);
    if (!last) {
      setIndex(index + 1);
      return;
    }
    const missing = questions.findIndex((question) => !(nextAnswers[question.id] ?? []).length);
    if (missing >= 0) setIndex(missing);
    else if (!answerProblem(request, nextAnswers, item.answerContext, locale)) submit(nextAnswers);
  };
  const pick = (label: string) => {
    if (locked || !q) return;
    if (q.multiSelect) {
      const current = ownValue(choices, q.id) ?? [];
      setChoices({
        ...choices,
        [q.id]: current.includes(label)
          ? current.filter((value) => value !== label)
          : [...current, label],
      });
      return;
    }
    const nextChoices = { ...choices, [q.id]: [label] };
    const nextCustom = { ...custom, [q.id]: "" };
    setChoices(nextChoices);
    setCustom(nextCustom);
    advance(nextChoices, nextCustom);
  };
  const secret = !!q && (q.isSecret || q.secret);
  const typed = q ? (ownValue(custom, q.id) ?? "") : "";
  const canContinue = !!q && answered(q) && !problem && (last ? complete : true);
  const heading = (
    <span>
      {t.question}
      {questions.length > 1 && (
        <span className="tabular-nums">
          {" · "}
          {Math.min(index, questions.length - 1) + 1}/{questions.length}
        </span>
      )}
    </span>
  );
  const textInput = q && (q.allowCustom || !q.options.length) && (
    <input
      id={inputId}
      type={secret && !reveal ? "password" : "text"}
      autoComplete={secret ? "new-password" : "off"}
      spellCheck={secret ? false : undefined}
      maxLength={MAX_ANSWER_LENGTH}
      disabled={locked}
      aria-label={`${q.question} · ${q.options.length ? t.otherPlaceholder : t.replyPlaceholder}`}
      placeholder={q.options.length ? t.otherPlaceholder : t.replyPlaceholder}
      value={typed}
      onChange={(event) => {
        const value = event.target.value;
        setCustom({ ...custom, [q.id]: value });
        if (!q.multiSelect && value.trim()) setChoices({ ...choices, [q.id]: [] });
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (canContinue) advance(choices, custom);
      }}
      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
    />
  );
  return (
    <Frame
      t={t}
      icon="question"
      label={t.waitingAnswer}
      heading={heading}
      headingTone="kind"
      pager={pager}
      onCollapse={onCollapse}
      hidden={hidden}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (!q || target.closest("input, textarea")) return;
        if (/^[1-9]$/.test(event.key) && q.options[Number(event.key) - 1]) {
          event.preventDefault();
          pick(q.options[Number(event.key) - 1].label);
        }
      }}
    >
      {!supported || !q ? (
        <NoticeLine notice={item.notice ?? { tone: "neutral", text: t.unavailableQuestion }} />
      ) : (
        <>
          <h3 className="break-words text-[15px] font-medium leading-6">
            {q.header && <span className="text-muted-foreground">{q.header} · </span>}
            {q.question}
          </h3>
          {item.notice && <NoticeLine notice={item.notice} />}
          {q.options.length > 0 && (
            <div role="group" aria-label={q.question} className="-mx-1 space-y-0.5">
              {q.options.map((option, optionIndex) => {
                const selected = (ownValue(choices, q.id) ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={q.multiSelect ? "checkbox" : undefined}
                    aria-checked={q.multiSelect ? selected : undefined}
                    aria-pressed={q.multiSelect ? undefined : selected}
                    aria-label={option.label}
                    disabled={locked}
                    className={`${optionRow} group ${selected ? "bg-primary/10" : ""}`}
                    onClick={() => pick(option.label)}
                  >
                    {q.multiSelect ? (
                      <Icon
                        name={selected ? "box-check" : "box"}
                        className={`size-[18px] ${selected ? "text-primary-text" : "text-muted-foreground"}`}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="grid size-5 shrink-0 place-items-center rounded-md border bg-background text-[11px] tabular-nums text-muted-foreground"
                      >
                        {optionIndex + 1}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${selected ? "text-primary-text" : ""}`}>
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="block break-words text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {selected && !q.multiSelect ? (
                      <Icon name="check" className="size-4 text-primary-text" />
                    ) : (
                      !q.multiSelect && (
                        <Icon
                          name="arrow"
                          className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        />
                      )
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {textInput && (
              <div
                className={`flex min-w-0 flex-1 basis-56 items-center gap-2 ${q.options.length ? "px-2.5" : "rounded-xl border px-3 py-2.5"}`}
              >
                {q.options.length > 0 && (
                  <Icon name="pencil" className="size-3.5 text-muted-foreground" />
                )}
                {textInput}
                {secret && (
                  <button
                    type="button"
                    className={ghostIcon}
                    aria-label={reveal ? t.hideSecret : t.showSecret}
                    onClick={() => setReveal(!reveal)}
                  >
                    <Icon name={reveal ? "eye-off" : "eye"} />
                  </button>
                )}
              </div>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {index > 0 && (
                <button
                  type="button"
                  className="h-8 rounded-full border bg-background px-3.5 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-40"
                  disabled={locked}
                  onClick={() => setIndex(index - 1)}
                >
                  {t.back}
                </button>
              )}
              {(q.multiSelect || typed.trim() || last || answered(q)) && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground"
                  disabled={locked || !canContinue}
                  onClick={() => advance(choices, custom)}
                >
                  {sending && <span aria-hidden="true" className={spinner} />}
                  {last ? t.send : t.nextQuestion}
                </button>
              )}
            </div>
          </div>
          {problem && (
            <p role="alert" className="text-xs text-destructive-text">
              {problem}
            </p>
          )}
          {failure && <NoticeLine notice={{ tone: "danger", text: failure }} />}
        </>
      )}
    </Frame>
  );
}

function collapsedText(item: InteractionDockItem, t: InteractionCardCopy) {
  if (item.kind === "approval") return `${t.waitingApproval} · ${item.model.summary}`;
  const first = Array.isArray(item.request.questions) ? item.request.questions[0] : undefined;
  return first && typeof first.question === "string"
    ? `${t.waitingAnswer} · ${first.question}`
    : t.waitingAnswer;
}

/**
 * Approvals and questions waiting in a session, shown above the composer as one card at a time.
 * The same card serves every agent; hosts build the items and send the decisions.
 */
export function InteractionDock({
  locale,
  items,
  busy,
  failure,
  vanished,
  focusKey,
  onFocused,
  onChoose,
  onAnswer,
}: InteractionDockProps) {
  const t = interactionCardCopy(locale);
  const [currentKey, setCurrentKey] = useState<string>();
  // The requests waiting when the card was collapsed; a new one brings the card back up.
  const [collapsedWith, setCollapsedWith] = useState<string[]>();
  const [handledFocus, setHandledFocus] = useState<string>();
  const [pending, setPending] = useState<{ itemKey: string; choiceKey?: string }>();
  const [failedKey, setFailedKey] = useState<string>();
  const [ghosts, setGhosts] = useState<InteractionDockItem[]>([]);
  const attempting = useRef(false);
  const previous = useRef<InteractionDockItem[]>([]);
  const answered = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const present = new Set(items.map((item) => item.key));
    const gone = previous.current.filter(
      (item) => !present.has(item.key) && !answered.current.has(item.key),
    );
    previous.current = items;
    if (!vanished || !gone.length) return;
    const goneKeys = new Set(gone.map((item) => item.key));
    setGhosts((list) => [
      ...list.filter((ghost) => !goneKeys.has(ghost.key)),
      ...gone.map((item) => ({ ...item, enabled: false, notice: vanished })),
    ]);
    for (const key of goneKeys) {
      clearTimeout(timers.current.get(key));
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setGhosts((list) => list.filter((ghost) => ghost.key !== key));
        }, 5000),
      );
    }
  }, [items, vanished]);
  useEffect(() => {
    const pendingTimers = timers.current;
    return () => pendingTimers.forEach((timer) => clearTimeout(timer));
  }, []);
  const keys = items.map((item) => item.key);
  const collapsed = !!collapsedWith && keys.every((key) => collapsedWith.includes(key));
  if (focusKey !== handledFocus) {
    // Adjusting state while rendering: the requested card comes forward, expanded, once.
    setHandledFocus(focusKey);
    if (focusKey) {
      setCurrentKey(focusKey);
      setCollapsedWith(undefined);
    }
  }
  useEffect(() => {
    if (focusKey) onFocused?.();
  }, [focusKey, onFocused]);
  useEffect(() => {
    // Another control action started, so an earlier refusal no longer describes this card.
    if (busy && !attempting.current) setFailedKey(undefined);
  }, [busy]);
  const shown = [
    ...items,
    ...ghosts.filter((ghost) => !items.some((item) => item.key === ghost.key)),
  ];
  if (!shown.length) return null;
  const found = shown.findIndex((item) => item.key === currentKey);
  const index = found < 0 ? 0 : found;
  const current = shown[index];
  const pager = {
    index,
    count: shown.length,
    go: (next: number) => setCurrentKey(shown[next]?.key),
  };
  const run = async (itemKey: string, choiceKey: string | undefined, action: () => unknown) => {
    if (pending) return;
    answered.current.add(itemKey);
    attempting.current = true;
    setFailedKey(undefined);
    setPending({ itemKey, choiceKey });
    try {
      if ((await action()) !== true) setFailedKey(itemKey);
    } finally {
      attempting.current = false;
      setPending(undefined);
    }
  };
  if (collapsed)
    return (
      <button
        type="button"
        aria-expanded={false}
        aria-label={`${t.expand} · ${collapsedText(current, t)}`}
        className="flex w-full max-w-3xl shrink-0 items-center gap-2 self-center rounded-xl border bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-muted"
        onClick={() => setCollapsedWith(undefined)}
      >
        <span
          className={
            current.kind === "approval"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          <Icon name={current.kind === "approval" ? current.model.icon : "question"} />
        </span>
        <span className="min-w-0 flex-1 truncate">{collapsedText(current, t)}</span>
        {shown.length > 1 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {index + 1}/{shown.length}
          </span>
        )}
        <Icon name="up" className="size-4 text-muted-foreground" />
      </button>
    );
  return (
    <>
      {shown.map((item) =>
        item.kind === "approval" ? (
          <ApprovalCard
            key={item.key}
            item={item}
            t={t}
            hidden={item !== current}
            busy={busy}
            pending={pending?.itemKey === item.key ? (pending.choiceKey ?? "") : undefined}
            failure={failedKey === item.key ? failure : undefined}
            pager={pager}
            onCollapse={() => setCollapsedWith(keys)}
            onChoose={(choice) => void run(item.key, choice.key, () => onChoose(item, choice))}
          />
        ) : (
          <QuestionCard
            key={item.key}
            item={item}
            t={t}
            locale={locale}
            hidden={item !== current}
            busy={busy}
            sending={pending?.itemKey === item.key}
            failure={failedKey === item.key ? failure : undefined}
            pager={pager}
            onCollapse={() => setCollapsedWith(keys)}
            onAnswer={(answers) => void run(item.key, undefined, () => onAnswer(item, answers))}
          />
        ),
      )}
    </>
  );
}
