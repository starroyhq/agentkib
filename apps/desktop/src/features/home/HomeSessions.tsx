import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  AppWindow,
  ArrowRight,
  Ban,
  Check,
  ChevronRight,
  CircleDot,
  CircleHelp,
  CircleStop,
  CircleX,
  Database,
  LoaderCircle,
  MessageCircle,
  Play,
  ShieldAlert,
  SquareTerminal,
  X,
} from "lucide-react";
import { interactionCardCopy, readStateCopy, sessionContinuationCopy } from "@agentkib/session-ui";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AGENT_LABELS } from "@/core/agents";
import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { sessionGroupLabels } from "@/features/sessions/session-catalog";
import { displaySessionTitle } from "@/features/workspace/session-title";
import {
  formatRunningTime,
  homeSessionGroups,
  type HomeNeed,
  type HomePlace,
  type HomeResult,
} from "./home-sessions";

export type HomeSessionsState = "ready" | "loading" | "disabled" | "error";
type Tone = "waiting" | "success" | "failed" | "running" | "neutral";
type Icon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const TONES: Record<Tone, string> = {
  waiting: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/10 text-destructive-text",
  running: "bg-primary/8 text-primary-text",
  neutral: "bg-muted text-muted-foreground",
};
const NEED_ICONS: Record<HomeNeed, Icon> = {
  approval: ShieldAlert,
  question: MessageCircle,
  verify: CircleHelp,
};
const RESULTS: Record<HomeResult, { icon: Icon; tag: Icon; tone: Tone }> = {
  completed: { icon: Check, tag: Check, tone: "success" },
  failed: { icon: X, tag: CircleX, tone: "failed" },
  cancelled: { icon: Ban, tag: Ban, tone: "neutral" },
  ended: { icon: CircleStop, tag: CircleStop, tone: "neutral" },
  unread: { icon: CircleDot, tag: CircleDot, tone: "running" },
};
const PLACE_ICONS: Record<HomePlace, Icon> = {
  agentkib: Play,
  terminal: SquareTerminal,
  external: AppWindow,
};

/**
 * The home's session groups: what waits for the person, unread results, running turns and the
 * most recent other sessions. Each group hides when it is empty; "all clear" stands in for the
 * first three. Rows open their session.
 */
export function HomeSessions({
  state,
  sessions,
  workspaces,
  error,
  unavailableAgents = [],
  onOpen,
  onShowAll,
  onEnableIndex,
  onRetry,
  onRetrySources,
  onNewSession,
}: {
  state: HomeSessionsState;
  sessions: ConversationSessionSummary[];
  workspaces: WorkspaceSummary[];
  error?: string;
  /** Installed Agents whose sessions could not be read this time. */
  unavailableAgents?: AgentKind[];
  onOpen: (session: ConversationSessionSummary) => void;
  onShowAll: () => void;
  onEnableIndex: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetrySources: () => Promise<void>;
  onNewSession: () => void;
}) {
  const { locale, tr, formatRelativeTime } = useI18n();
  const groups = useMemo(() => homeSessionGroups(sessions), [sessions]);
  const labels = useMemo(
    () =>
      sessionGroupLabels(sessions, [
        ...workspaces,
        ...Object.entries(SESSION_COLLECTIONS).map(([kind, id]) => ({
          id,
          name: tr(kind === "projectless" ? "sessions.projectless" : "sessions.unclassified"),
          path: "",
        })),
      ]),
    [sessions, workspaces, tr],
  );
  if (state === "disabled")
    return (
      <Notice icon={Database} text={tr("conversations.indexDisabled")}>
        <BusyButton label={tr("home.enableIndex")} onClick={onEnableIndex} />
      </Notice>
    );
  if (state === "error")
    return (
      <Notice text={error || tr("home.continuationsError")}>
        <BusyButton label={tr("sessions.retry")} onClick={onRetry} />
      </Notice>
    );
  if (state === "loading") return <Placeholder label={tr("home.continuationsScanning")} />;

  const copy = sessionContinuationCopy(locale);
  const read = readStateCopy(locale);
  const card = interactionCardCopy(locale);
  const needLabels: Record<HomeNeed, string> = {
    approval: card.waitingApproval,
    question: card.waitingAnswer,
    verify: tr("home.verifyResult"),
  };
  const resultLabels: Record<HomeResult, string> = {
    completed: read.completed,
    failed: read.failed,
    cancelled: read.cancelled,
    ended: read.ended,
    unread: read.manualUnread,
  };
  const placeLabel = (place: HomePlace, agent: AgentKind) =>
    place === "terminal"
      ? copy.terminalRunning
      : place === "external"
        ? copy.runningIn(AGENT_LABELS[agent])
        : copy.running;
  const meta = (session: ConversationSessionSummary, time?: string) =>
    [
      AGENT_LABELS[session.agent],
      labels.get(session.id) ?? workspaces.find(({ id }) => id === session.workspace_id)?.name,
      time ??
        (session.updated_at
          ? formatRelativeTime(session.updated_at)
          : tr("conversations.unknownTime")),
    ]
      .filter(Boolean)
      .join(" · ");
  const sources = unavailableAgents.length ? (
    <p role="status" className="text-xs leading-relaxed text-muted-foreground">
      {tr("sessions.sourceUnavailable", {
        agent: unavailableAgents
          .map((agent) => AGENT_LABELS[agent])
          .join(locale === "en-US" ? ", " : "、"),
      })}{" "}
      <span aria-hidden="true">·</span>{" "}
      <BusyButton label={tr("sessions.retry")} onClick={onRetrySources} link />
    </p>
  ) : null;

  const attention = groups.needsYou.length + groups.review.length + groups.running.length;
  if (!attention && !groups.recent.length)
    return (
      <div className="grid gap-3">
        {sources}
        <Notice text={tr("home.firstSession")}>
          <Button variant="outline" size="sm" onClick={onNewSession}>
            {tr("sessions.newConversation")}
          </Button>
        </Notice>
      </div>
    );
  return (
    <div className="grid gap-5">
      {sources}
      {attention ? (
        <Card className="gap-0 divide-y divide-border overflow-hidden rounded-xl border-border bg-card py-0 shadow-none">
          <Group title={tr("home.needsYou")} count={groups.needsYou.length}>
            {groups.needsYou.map(({ session, need }) => (
              <SessionRow
                key={session.id}
                icon={NEED_ICONS[need]}
                tone="waiting"
                title={displaySessionTitle(session.title, tr)}
                meta={meta(session)}
                tag={needLabels[need]}
                tagIcon={NEED_ICONS[need]}
                onClick={() => onOpen(session)}
              />
            ))}
          </Group>
          <Group title={read.pending} count={groups.review.length}>
            {groups.review.map(({ session, result }) => (
              <SessionRow
                key={session.id}
                icon={RESULTS[result].icon}
                tone={RESULTS[result].tone}
                title={displaySessionTitle(session.title, tr)}
                meta={meta(session)}
                tag={resultLabels[result]}
                tagIcon={RESULTS[result].tag}
                onClick={() => onOpen(session)}
              />
            ))}
          </Group>
          <Group title={tr("home.inProgress")} count={groups.running.length}>
            {groups.running.map(({ session, place, startedAt }) => {
              const running = startedAt ? formatRunningTime(startedAt, locale) : undefined;
              return (
                <SessionRow
                  key={session.id}
                  icon={LoaderCircle}
                  spin
                  tone="running"
                  title={displaySessionTitle(session.title, tr)}
                  meta={meta(
                    session,
                    running ? tr("home.runningFor", { duration: running }) : undefined,
                  )}
                  tag={placeLabel(place, session.agent)}
                  tagIcon={PLACE_ICONS[place]}
                  onClick={() => onOpen(session)}
                />
              );
            })}
          </Group>
        </Card>
      ) : (
        <Card className="grid justify-items-center gap-2 rounded-xl border-border bg-card px-6 py-9 text-center shadow-none">
          <span className="mb-1 grid size-10 place-items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
            <Check size={20} aria-hidden />
          </span>
          <h2 className="text-sm font-semibold">{tr("home.allClear")}</h2>
          <p className="text-xs text-muted-foreground">{tr("home.allClearHint")}</p>
        </Card>
      )}
      {groups.recent.length > 0 && (
        <Card className="gap-0 overflow-hidden rounded-xl border-border bg-card py-0 shadow-none">
          <section aria-labelledby="home-recent-sessions">
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
              <h2 id="home-recent-sessions" className="text-sm font-semibold">
                {tr("home.recentSessions")}
              </h2>
              <Button variant="link" className="h-auto gap-1 p-0 text-xs" onClick={onShowAll}>
                {tr("home.viewAll")}
                <ArrowRight size={14} aria-hidden />
              </Button>
            </div>
            <ul className="divide-y divide-border">
              {groups.recent.map((session) => (
                <li key={session.id}>
                  <Button
                    variant="bare"
                    size="content"
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] items-center gap-3 px-5 py-2.5 text-left hover:bg-muted/40"
                    onClick={() => onOpen(session)}
                  >
                    <AgentIcon agent={session.agent} compact />
                    <span className="truncate text-sm">
                      {displaySessionTitle(session.title, tr)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{meta(session)}</span>
                    {session.readState?.status === "unread" ? (
                      <span className="size-1.5 rounded-full bg-primary">
                        <span className="sr-only">{read.unread}</span>
                      </span>
                    ) : (
                      <span className="size-1.5" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </Card>
      )}
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section aria-label={title} className="py-2">
      <h2 className="px-5 pb-1 pt-2 text-sm font-semibold">
        {title}
        <span className="ml-2 font-normal text-muted-foreground">{count}</span>
      </h2>
      <ul>{children}</ul>
    </section>
  );
}

function SessionRow({
  icon: Icon,
  spin = false,
  tone,
  title,
  meta,
  tag,
  tagIcon: TagIcon,
  onClick,
}: {
  icon: Icon;
  spin?: boolean;
  tone: Tone;
  title: string;
  meta: string;
  tag: string;
  tagIcon: Icon;
  onClick: () => void;
}) {
  return (
    <li>
      <Button
        variant="bare"
        size="content"
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 px-5 py-2.5 text-left hover:bg-muted/40"
        onClick={onClick}
      >
        <span className={`grid size-8 place-items-center rounded-full ${TONES[tone]}`}>
          <Icon
            size={16}
            aria-hidden
            className={spin ? "animate-spin motion-reduce:animate-none" : undefined}
          />
        </span>
        <span className="grid min-w-0">
          <strong className="truncate text-sm font-medium">{title}</strong>
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        <span
          className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
        >
          <TagIcon size={12} aria-hidden />
          {tag}
        </span>
        <ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
      </Button>
    </li>
  );
}

function Notice({
  icon: Icon,
  text,
  children,
}: {
  icon?: Icon;
  text: string;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-row items-center gap-3 rounded-xl border-border bg-card px-5 py-3.5 shadow-none">
      {Icon && <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />}
      <p className="min-w-0 flex-1 text-sm">{text}</p>
      {children}
    </Card>
  );
}

function BusyButton({
  label,
  onClick,
  link = false,
}: {
  label: string;
  onClick: () => Promise<void>;
  link?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={link ? "link" : "outline"}
      size={link ? "content" : "sm"}
      className={link ? "text-xs" : undefined}
      disabled={busy}
      aria-busy={busy}
      onClick={() => {
        setBusy(true);
        void onClick().finally(() => setBusy(false));
      }}
    >
      {label}
    </Button>
  );
}

/** Placeholder rows while the first catalog read has nothing to show yet; never a "loading" card. */
function Placeholder({ label }: { label: string }) {
  return (
    <Card aria-busy="true" className="gap-0 rounded-xl border-border bg-card px-5 py-4 shadow-none">
      <span role="status" className="sr-only">
        {label}
      </span>
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3 py-2.5">
          <Skeleton className="size-8 rounded-full" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
      ))}
    </Card>
  );
}
