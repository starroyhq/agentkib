import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, Square } from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import type { InteractionReply, Live } from "@agentkib/web-client";
import {
  CompactApprovalCard,
  homeSessionCopy,
  interactionCardCopy,
  readStateCopy,
  sessionInteractionItems,
  type ApprovalDockItem,
  type HomeListGroups,
  type HomeListNeed,
  type HomeListPlace,
  type HomeListResult,
} from "@agentkib/session-ui";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import type { HomeReplies } from "@/features/home/home-replies";
import { codexReason } from "@/features/sessions/conversation/features/sessions/codex-copy";

type Session = ConversationSessionSummary;
type Tone = "waiting" | "running" | "success" | "failed" | "neutral";

const TONES: Record<Tone, string> = {
  waiting: "text-amber-700 dark:text-amber-300",
  running: "text-primary-text",
  success: "text-emerald-700 dark:text-emerald-300",
  failed: "text-destructive-text",
  neutral: "text-muted-foreground",
};
const RESULT_TONES: Record<HomeListResult, Tone> = {
  completed: "success",
  failed: "failed",
  cancelled: "neutral",
  ended: "neutral",
  unread: "running",
};
const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

export interface MenuBarRowText {
  title: string;
  workspace?: string;
  /** When the session last changed, such as "12 minutes ago". */
  time?: string;
}

/** How long a turn has run, to the second: "4 min 12 s". */
export function formatElapsed(milliseconds: number, tr: ReturnType<typeof useI18n>["tr"]): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return tr("menubar.durationSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return tr("menubar.durationMinutes", { minutes, seconds: seconds % 60 });
  return tr("menubar.durationHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * The popover's sessions: what waits for the person, running turns, then unread results. The
 * first approval opens as the compact card and is answered in one click; a question or any other
 * option opens the session in the main window. A running turn can be stopped from its row.
 */
export function MenuBarSessions({
  groups,
  describe,
  replies,
  workspacePath,
  now,
  expanded,
  onExpand,
  onOpen,
}: {
  groups: HomeListGroups<Session>;
  describe: (session: Session) => MenuBarRowText;
  /** Answers and stops from the popover; without it every row opens its session. */
  replies?: HomeReplies;
  workspacePath: (session: Session) => string | undefined;
  now: number;
  /** The approval row open as a card. */
  expanded?: string;
  onExpand: (sessionId: string | undefined) => void;
  onOpen: (session: Session) => void;
}) {
  const { locale, tr, formatRelativeTime } = useI18n();
  const t = homeSessionCopy(locale);
  const read = readStateCopy(locale);
  const card = interactionCardCopy(locale);
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
  const placeLabel = (place: HomeListPlace, session: Session) =>
    place === "terminal"
      ? tr("menubar.placeTerminal")
      : place === "external"
        ? agentName(session.agent)
        : "AgentKib";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 pb-2">
      <Group title={t.needsYou} count={groups.needsYou.length}>
        {groups.needsYou.map(({ session, need }) => {
          const text = describe(session);
          const open = need === "approval" && !!replies && expanded === session.id;
          const row = (
            <Row
              session={session}
              title={text.title}
              meta={text.workspace}
              status={needLabels[need]}
              tone="waiting"
              trailing={<Chevron open={open} />}
              expanded={need === "approval" && replies ? open : undefined}
              onClick={() =>
                need === "approval" && replies
                  ? onExpand(open ? undefined : session.id)
                  : onOpen(session)
              }
            />
          );
          if (!open || !replies) return <li key={session.id}>{row}</li>;
          return (
            <li key={session.id}>
              <div className="rounded-xl border border-border bg-card shadow-xs">
                {row}
                <div className="px-3 pb-3">
                  <MenuBarApproval
                    session={session}
                    workspacePath={workspacePath(session)}
                    replies={replies}
                    onMore={() => onOpen(session)}
                    onClose={() => onExpand(undefined)}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </Group>
      <Group title={t.inProgress} count={groups.running.length}>
        {groups.running.map(({ session, place, startedAt }) => {
          const text = describe(session);
          const started = startedAt ? Date.parse(startedAt) : NaN;
          const time = Number.isFinite(started) ? formatElapsed(now - started, tr) : text.time;
          return (
            <li key={session.id}>
              <RunningRow
                session={session}
                text={text}
                status={placeLabel(place, session)}
                time={time}
                stoppable={!!replies && place !== "external"}
                replies={replies}
                onOpen={onOpen}
              />
            </li>
          );
        })}
      </Group>
      <Group title={read.pending} count={groups.review.length}>
        {groups.review.map(({ session, result }) => {
          const text = describe(session);
          return (
            <li key={session.id}>
              <Row
                session={session}
                title={text.title}
                meta={text.workspace}
                status={resultLabels[result]}
                tone={RESULT_TONES[result]}
                after={session.updated_at ? formatRelativeTime(session.updated_at) : undefined}
                trailing={<Chevron />}
                onClick={() => onOpen(session)}
              />
            </li>
          );
        })}
      </Group>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section aria-label={title} className="px-2">
      <h2 className="px-2 pb-1 pt-2.5 text-xs font-medium text-muted-foreground">
        {title}
        <span className="ml-1.5 tabular-nums">{count}</span>
      </h2>
      <ul className="grid gap-0.5">{children}</ul>
    </section>
  );
}

function Chevron({ open = false }: { open?: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn("size-4 shrink-0 text-muted-foreground", open && "-rotate-90")}
    />
  );
}

function Row({
  session,
  title,
  meta,
  status,
  tone,
  after,
  trailing,
  expanded,
  onClick,
}: {
  session: Session;
  title: string;
  meta?: string;
  status: string;
  tone: Tone;
  /** Said after the status, such as the time. */
  after?: string;
  trailing?: ReactNode;
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="bare"
      size="content"
      aria-expanded={expanded}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-muted/60",
        focusRing,
      )}
      onClick={onClick}
    >
      <AgentTile agent={session.agent} />
      <span className="grid min-w-0 gap-0.5">
        <strong className="truncate text-sm font-medium">{title}</strong>
        <span className="truncate text-xs text-muted-foreground">
          {meta && `${meta} · `}
          <span className={TONES[tone]}>
            {status}
            {after && ` · ${after}`}
          </span>
        </span>
      </span>
      {trailing}
    </Button>
  );
}

function AgentTile({ agent }: { agent: Session["agent"] }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 place-items-center rounded-[10px] border border-border/70 bg-card"
    >
      <AgentMark agent={agent} size={20} />
    </span>
  );
}

/** A running turn; "Stop" shows when the row is hovered or focused. */
function RunningRow({
  session,
  text,
  status,
  time,
  stoppable,
  replies,
  onOpen,
}: {
  session: Session;
  text: MenuBarRowText;
  status: string;
  time?: string;
  stoppable: boolean;
  replies?: HomeReplies;
  onOpen: (session: Session) => void;
}) {
  const { locale, tr } = useI18n();
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string>();
  const stop = async () => {
    if (!replies || stopping) return;
    setStopping(true);
    setFailure(undefined);
    try {
      const result = await replies.stop(session);
      if (result.status === "accepted" || result.status === "unknown") return;
      if (result.status === "not-dispatched") {
        const reason = codexReason(locale, result.reason.replaceAll("_", "-"));
        setFailure(reason.technical ? tr("menubar.stopFailed") : reason.text);
      } else
        setFailure(
          result.status === "gone" ? tr("menubar.stopElsewhere") : tr("menubar.stopFailed"),
        );
      setStopping(false);
    } catch {
      setFailure(tr("menubar.stopFailed"));
      setStopping(false);
    }
  };
  return (
    <div className="group relative">
      <Row
        session={session}
        title={text.title}
        meta={text.workspace}
        status={status}
        tone="running"
        after={time}
        // Room for "Stop" only while it shows, so the time is not cut short otherwise.
        trailing={
          stoppable ? (
            <span className="w-0 group-focus-within:w-[4.5rem] group-hover:w-[4.5rem]" />
          ) : (
            <span />
          )
        }
        onClick={() => onOpen(session)}
      />
      {stoppable && (
        <Button
          variant="bare"
          size="content"
          disabled={stopping}
          className={cn(
            "absolute right-2 top-1/2 inline-flex h-7 -translate-y-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 font-medium opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-100",
            focusRing,
          )}
          onClick={() => void stop()}
        >
          {stopping ? (
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <Square aria-hidden="true" className="size-2.5" />
          )}
          <span className="text-xs">{tr("menubar.stop")}</span>
        </Button>
      )}
      {failure && (
        <p role="alert" className="px-2 pb-1 pl-14 text-xs text-destructive-text">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The first waiting approval of a session as the compact card, read fresh and answered through
 * the same checks as the session view. Once nothing waits the card folds; an unknown outcome
 * folds it too, and the row then asks the person to verify the result.
 */
function MenuBarApproval({
  session,
  workspacePath,
  replies,
  onMore,
  onClose,
}: {
  session: Session;
  workspacePath?: string;
  replies: HomeReplies;
  onMore: () => void;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const copy = homeSessionCopy(locale);
  const card = interactionCardCopy(locale);
  const [live, setLive] = useState<Live>();
  const [state, setState] = useState<"loading" | "ready" | "gone" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { client, access } = replies;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await client.live(session.id, signal);
        if (signal?.aborted) return undefined;
        setLive(value);
        setState(value.approvals.length ? "ready" : "gone");
        return value;
      } catch {
        if (!signal?.aborted) setState("failed");
        return undefined;
      }
    },
    [client, session.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state === "loading" || (state === "ready" && !access))
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {copy.loadingRequest}
      </p>
    );
  if (state !== "ready" || !live || !access)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {state === "failed" ? copy.readFailed : copy.requestGone}
      </p>
    );
  const { items, approvals } = sessionInteractionItems(live, access, {
    locale,
    sessionId: session.id,
    agent: agentName(session.agent),
    workspacePath,
    canStop: false,
    ready: !busy,
    uncertain: false,
  });
  const item = items.find((entry): entry is ApprovalDockItem => entry.kind === "approval");
  if (!item) return null;
  const send = async (reply: InteractionReply) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await replies.reply(session, reply);
      if (result.status === "accepted") {
        const next = await load();
        if (!next?.approvals.length) {
          replies.markAnswered(session.id);
          onClose();
        }
        return true;
      }
      if (result.status === "unknown") {
        onClose();
        return false;
      }
      if (result.status === "gone") {
        await load();
        setFailure(copy.requestGone);
        return false;
      }
      const reason =
        result.status === "not-dispatched"
          ? codexReason(locale, result.reason.replaceAll("_", "-"))
          : undefined;
      setFailure(reason && !reason.technical ? reason.text : card.sendFailed);
      return false;
    } catch {
      setFailure(card.sendFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <CompactApprovalCard
      locale={locale}
      item={item}
      busy={busy}
      failure={failure}
      onMore={onMore}
      onChoose={(choice) => {
        const approval = approvals.get(item.key);
        if (!approval) return false;
        if (choice.nativeDecision !== undefined)
          return send({ kind: "approve", approval, nativeDecision: choice.nativeDecision });
        return choice.decision === undefined
          ? false
          : send({ kind: "approve", approval, decision: choice.decision });
      }}
    />
  );
}
