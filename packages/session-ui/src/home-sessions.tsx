import { useId, type ReactNode } from "react";
import { interactionCardCopy, type InteractionLocale } from "./interaction-model";
import { readStateCopy } from "./read-state";
import { sessionContinuationCopy } from "./session-continuation";

/**
 * The home's session groups as desktop, Web and the menu bar draw them. The groups come from
 * `homeSessionGroups` in session-catalog; these types match its result structurally.
 */
export type HomeListNeed = "approval" | "question" | "verify";
export type HomeListResult = "completed" | "failed" | "cancelled" | "ended" | "unread";
export type HomeListPlace = "agentkib" | "terminal" | "external";
export interface HomeListGroups<S> {
  needsYou: { session: S; need: HomeListNeed }[];
  review: { session: S; result: HomeListResult }[];
  running: { session: S; place: HomeListPlace; startedAt?: string }[];
  recent: S[];
}

/** What a row says about its session, in the host's words. */
export interface HomeRowText {
  title: string;
  /** The Agent's display name, such as "Codex". */
  agent: string;
  /** The workspace or group the session belongs to. */
  workspace?: string;
  /** When it last changed, such as "12 minutes ago". */
  time?: string;
}

const copy = {
  "zh-CN": {
    home: "首页",
    needsYou: "需要你处理",
    inProgress: "进行中",
    verifyResult: "结果待核对",
    runningFor: "已运行 {duration}",
    allClear: "一切就绪",
    allClearHint: "这台电脑上需要你审批或回答的事项会出现在这里",
    recentSessions: "最近会话",
    viewAll: "查看全部",
    allSessions: "全部会话",
    openSession: "打开会话",
    loadingRequest: "正在读取请求…",
    requestGone: "这个请求已经不在等待，可能已在别处处理。",
    readFailed: "没能读到这个请求，打开会话查看。",
    disconnected: "已断线，连上后才能作答。",
  },
  "zh-TW": {
    home: "首頁",
    needsYou: "需要你處理",
    inProgress: "進行中",
    verifyResult: "結果待核對",
    runningFor: "已執行 {duration}",
    allClear: "一切就緒",
    allClearHint: "這台電腦上需要你審批或回答的事項會出現在這裡",
    recentSessions: "最近對話",
    viewAll: "查看全部",
    allSessions: "全部對話",
    openSession: "開啟對話",
    loadingRequest: "正在讀取請求…",
    requestGone: "這個請求已經不在等待，可能已在別處處理。",
    readFailed: "沒能讀到這個請求，開啟對話查看。",
    disconnected: "已斷線，連上後才能作答。",
  },
  "en-US": {
    home: "Home",
    needsYou: "Needs you",
    inProgress: "In progress",
    verifyResult: "Result to verify",
    runningFor: "Running for {duration}",
    allClear: "All caught up",
    allClearHint: "Approvals and questions from this computer will appear here",
    recentSessions: "Recent sessions",
    viewAll: "View all",
    allSessions: "All sessions",
    openSession: "Open session",
    loadingRequest: "Loading the request…",
    requestGone: "This request is no longer waiting; it may have been handled elsewhere.",
    readFailed: "Couldn't load this request. Open the session to see it.",
    disconnected: "Disconnected. You can answer once reconnected.",
  },
  "ja-JP": {
    home: "ホーム",
    needsYou: "対応が必要",
    inProgress: "実行中",
    verifyResult: "結果の確認が必要",
    runningFor: "{duration} 実行中",
    allClear: "すべて対応済み",
    allClearHint: "このコンピュータで承認や回答が必要なものがここに表示されます",
    recentSessions: "最近の会話",
    viewAll: "すべて表示",
    allSessions: "すべての会話",
    openSession: "会話を開く",
    loadingRequest: "リクエストを読み込んでいます…",
    requestGone: "このリクエストはもう待機していません。別の場所で処理された可能性があります。",
    readFailed: "このリクエストを読み込めませんでした。会話を開いて確認してください。",
    disconnected: "接続が切れています。再接続すると回答できます。",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;
export type HomeSessionCopy = (typeof copy)["zh-CN"];

export function homeSessionCopy(locale: InteractionLocale): HomeSessionCopy {
  return copy[locale] ?? copy["en-US"];
}

/** How long a turn has run, in whole minutes or hours, for the start of its row's detail line. */
export function formatRunningTime(startedAt: string, locale: string, now = Date.now()) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return undefined;
  const minutes = Math.max(1, Math.round((now - started) / 60_000));
  const [value, unit] = minutes < 60 ? [minutes, "minute"] : [Math.round(minutes / 60), "hour"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/** "3 minutes ago", "yesterday": the time a row's session last changed. */
export function formatSessionTime(value: string, locale: string, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

type Tone = "waiting" | "success" | "failed" | "running" | "neutral";
type IconName =
  | "approval"
  | "question"
  | "verify"
  | "check"
  | "x"
  | "x-circle"
  | "ban"
  | "stop"
  | "dot"
  | "loader"
  | "play"
  | "terminal"
  | "window"
  | "chevron"
  | "arrow";

const TONES: Record<Tone, string> = {
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive-text",
  running: "bg-primary/8 text-primary-text",
  neutral: "bg-muted text-muted-foreground",
};
const TEXT_TONES: Record<Tone, string> = {
  waiting: "text-amber-700 dark:text-amber-300",
  success: "text-emerald-700 dark:text-emerald-300",
  failed: "text-destructive-text",
  running: "text-primary-text",
  neutral: "text-muted-foreground",
};
const NEED_ICONS: Record<HomeListNeed, IconName> = {
  approval: "approval",
  question: "question",
  verify: "verify",
};
const RESULTS: Record<HomeListResult, { icon: IconName; tag: IconName; tone: Tone }> = {
  completed: { icon: "check", tag: "check", tone: "success" },
  failed: { icon: "x", tag: "x-circle", tone: "failed" },
  cancelled: { icon: "ban", tag: "ban", tone: "neutral" },
  ended: { icon: "stop", tag: "stop", tone: "neutral" },
  unread: { icon: "dot", tag: "dot", tone: "running" },
};
const PLACE_ICONS: Record<HomeListPlace, IconName> = {
  agentkib: "play",
  terminal: "terminal",
  external: "window",
};

// Lucide outlines, inlined because this package carries no icon dependency.
const ICONS: Record<IconName, ReactNode> = {
  approval: (
    <>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  question: <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />,
  verify: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </>
  ),
  stop: (
    <>
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </>
  ),
  dot: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  loader: <path d="M21 12a9 9 0 1 1-6.219-8.56" />,
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  terminal: (
    <>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    </>
  ),
  window: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 4v4" />
      <path d="M2 8h20" />
      <path d="M6 4v4" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  arrow: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {ICONS[name]}
    </svg>
  );
}

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-0";

export interface HomeSessionListProps<S extends { id: string }> {
  locale: InteractionLocale;
  /** "wide" puts each status in a tag at the row's end; "compact" starts the second line with it. */
  layout: "wide" | "compact";
  groups: HomeListGroups<S>;
  describe: (session: S) => HomeRowText;
  /** The Agent's mark for recent rows. */
  agentMark?: (session: S) => ReactNode;
  /** Recent sessions below the groups and the link to all of them; left out when absent. */
  recent?: { limit: number; label: "viewAll" | "allSessions"; onShowAll: () => void };
  /** The session whose waiting request is open in its row. */
  expanded?: string;
  /** Makes approval and question rows open their card in place instead of opening the session. */
  onToggle?: (session: S) => void;
  /** The approval or question card shown in an open row. */
  renderCard?: (session: S, need: "approval" | "question") => ReactNode;
  onOpen: (session: S) => void;
}

/**
 * What waits for the person, unread results and running turns, each group hidden when empty, then
 * the most recent other sessions. "All clear" stands in for the first three groups. An approval
 * or a question can open its card in its row and be answered there; other rows open the session.
 */
export function HomeSessionList<S extends { id: string }>({
  locale,
  layout,
  groups,
  describe,
  agentMark,
  recent,
  expanded,
  onToggle,
  renderCard,
  onOpen,
}: HomeSessionListProps<S>) {
  const t = homeSessionCopy(locale);
  const read = readStateCopy(locale);
  const card = interactionCardCopy(locale);
  const continuation = sessionContinuationCopy(locale);
  const recentId = useId();
  const needLabels: Record<HomeListNeed, string> = {
    approval: card.waitingApproval,
    question: card.waitingAnswer,
    verify: t.verifyResult,
  };
  const resultLabels: Record<HomeListResult, string> = {
    completed: read.completed,
    failed: read.failed,
    cancelled: read.cancelled,
    ended: read.ended,
    unread: read.manualUnread,
  };
  const placeLabel = (place: HomeListPlace, agent: string) =>
    place === "terminal"
      ? continuation.terminalRunning
      : place === "external"
        ? continuation.runningIn(agent)
        : continuation.running;
  const join = (parts: (string | undefined)[]) => parts.filter(Boolean).join(" · ");
  const wide = layout === "wide";
  const attention = groups.needsYou.length + groups.review.length + groups.running.length;
  const recentRows = recent ? groups.recent.slice(0, recent.limit) : [];

  return (
    <div className={wide ? "grid gap-5" : "grid gap-3"}>
      {attention ? (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          <Group title={t.needsYou} count={groups.needsYou.length}>
            {groups.needsYou.map(({ session, need }) => {
              const text = describe(session);
              const inline = need !== "verify" && !!onToggle && !!renderCard;
              const open = inline && expanded === session.id;
              return (
                <Row
                  key={session.id}
                  layout={layout}
                  icon={NEED_ICONS[need]}
                  tone="waiting"
                  title={text.title}
                  status={needLabels[need]}
                  statusIcon={NEED_ICONS[need]}
                  meta={
                    wide
                      ? join([text.agent, text.workspace, text.time])
                      : join([text.agent, text.workspace])
                  }
                  expanded={inline ? open : undefined}
                  onClick={() => (inline ? onToggle(session) : onOpen(session))}
                >
                  {open && (
                    <div className="grid max-w-3xl gap-2 px-3 pb-3 sm:px-5">
                      {renderCard(session, need)}
                      <button
                        type="button"
                        className={`justify-self-end rounded-md px-1 text-xs font-medium text-primary-text underline-offset-4 hover:underline ${focusRing}`}
                        onClick={() => onOpen(session)}
                      >
                        {t.openSession}
                      </button>
                    </div>
                  )}
                </Row>
              );
            })}
          </Group>
          <Group title={read.pending} count={groups.review.length}>
            {groups.review.map(({ session, result }) => {
              const text = describe(session);
              return (
                <Row
                  key={session.id}
                  layout={layout}
                  icon={RESULTS[result].icon}
                  tone={RESULTS[result].tone}
                  title={text.title}
                  status={resultLabels[result]}
                  statusIcon={RESULTS[result].tag}
                  meta={
                    wide
                      ? join([text.agent, text.workspace, text.time])
                      : join([text.agent, text.time])
                  }
                  onClick={() => onOpen(session)}
                />
              );
            })}
          </Group>
          <Group title={t.inProgress} count={groups.running.length}>
            {groups.running.map(({ session, place, startedAt }) => {
              const text = describe(session);
              const duration = startedAt ? formatRunningTime(startedAt, locale) : undefined;
              const time = duration ? t.runningFor.replace("{duration}", duration) : text.time;
              return (
                <Row
                  key={session.id}
                  layout={layout}
                  icon="loader"
                  spin
                  tone="running"
                  title={text.title}
                  status={placeLabel(place, text.agent)}
                  statusIcon={PLACE_ICONS[place]}
                  meta={wide ? join([text.agent, text.workspace, time]) : join([time])}
                  onClick={() => onOpen(session)}
                />
              );
            })}
          </Group>
        </div>
      ) : (
        <div className="grid justify-items-center gap-2 rounded-xl border border-border bg-card px-6 py-9 text-center">
          <span className="mb-1 grid size-10 place-items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <Icon name="check" className="size-5" />
          </span>
          <h2 className="text-sm font-semibold">{t.allClear}</h2>
          <p className="text-xs text-muted-foreground">{t.allClearHint}</p>
        </div>
      )}
      {recent && recentRows.length > 0 && (
        <section
          aria-labelledby={recentId}
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-3.5">
            <h2 id={recentId} className="text-sm font-semibold">
              {t.recentSessions}
            </h2>
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary-text underline-offset-4 hover:underline ${focusRing}`}
              onClick={recent.onShowAll}
            >
              {t[recent.label]}
              <Icon name={recent.label === "viewAll" ? "arrow" : "chevron"} className="size-3.5" />
            </button>
          </div>
          <ul className="divide-y divide-border">
            {recentRows.map((session) => {
              const text = describe(session);
              const unread =
                (session as { readState?: { status?: string } }).readState?.status === "unread";
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`grid w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40 sm:px-5 ${focusRing} ${
                      wide
                        ? "grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto]"
                        : "grid-cols-[auto_minmax(0,1fr)_auto]"
                    }`}
                    onClick={() => onOpen(session)}
                  >
                    {agentMark?.(session) ?? <span />}
                    <span className="truncate text-sm">{text.title}</span>
                    {wide ? (
                      <>
                        <span className="truncate text-xs text-muted-foreground">
                          {join([text.agent, text.workspace, text.time])}
                        </span>
                        {unread ? (
                          <span className="size-1.5 rounded-full bg-primary">
                            <span className="sr-only">{read.unread}</span>
                          </span>
                        ) : (
                          <span className="size-1.5" />
                        )}
                      </>
                    ) : (
                      <span className="whitespace-nowrap text-xs text-muted-foreground">
                        {text.time}
                        {unread && <span className="sr-only"> · {read.unread}</span>}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section aria-label={title} className="py-2">
      <h2 className="px-4 pb-1 pt-2 text-sm font-semibold sm:px-5">
        {title}
        <span className="ml-2 font-normal text-muted-foreground">{count}</span>
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

function Row({
  layout,
  icon,
  spin = false,
  tone,
  title,
  status,
  statusIcon,
  meta,
  expanded,
  onClick,
  children,
}: {
  layout: "wide" | "compact";
  icon: IconName;
  spin?: boolean;
  tone: Tone;
  title: string;
  status: string;
  statusIcon: IconName;
  meta: string;
  /** Set on rows that open a card in place: whether it is open now. */
  expanded?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  const panel = useId();
  const wide = layout === "wide";
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panel : undefined}
        className={`grid w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40 sm:px-5 ${focusRing} ${
          wide ? "grid-cols-[auto_minmax(0,1fr)_auto_auto]" : "grid-cols-[auto_minmax(0,1fr)_auto]"
        }`}
        onClick={onClick}
      >
        <span className={`grid size-8 place-items-center rounded-full ${TONES[tone]}`}>
          <Icon
            name={icon}
            className={spin ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"}
          />
        </span>
        <span className="grid min-w-0">
          <strong className="truncate text-sm font-medium">{title}</strong>
          {wide ? (
            <span className="truncate text-xs text-muted-foreground">{meta}</span>
          ) : (
            <span className="truncate text-xs text-muted-foreground">
              <span className={`font-medium ${TEXT_TONES[tone]}`}>{status}</span>
              {meta && ` · ${meta}`}
            </span>
          )}
        </span>
        {wide && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
          >
            <Icon name={statusIcon} className="size-3" />
            {status}
          </span>
        )}
        <Icon
          name="chevron"
          className={`size-4 text-muted-foreground ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div id={panel} role="group" aria-label={title}>
          {children}
        </div>
      )}
    </li>
  );
}
