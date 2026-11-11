import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Database } from "lucide-react";
import { HomeSessionList } from "@agentkib/session-ui";
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
import { HomeInteraction } from "./HomeInteraction";
import type { HomeReplies } from "./home-replies";
import { homeSessionGroups } from "./home-sessions";

export type HomeSessionsState = "ready" | "loading" | "disabled" | "error";
type Icon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

/**
 * The home's session groups: what waits for the person, unread results, running turns and the
 * most recent other sessions. Each group hides when it is empty; "all clear" stands in for the
 * first three. With `replies`, an approval or a question opens its card in its row and is answered
 * there; other rows open their session.
 */
export function HomeSessions({
  state,
  sessions,
  workspaces,
  error,
  unavailableAgents = [],
  replies,
  onOpen,
  onShowAll,
  onEnableIndex,
  onRetry,
  onRetrySources,
}: {
  state: HomeSessionsState;
  sessions: ConversationSessionSummary[];
  workspaces: WorkspaceSummary[];
  error?: string;
  /** Installed Agents whose sessions could not be read this time. */
  unavailableAgents?: AgentKind[];
  /** Answers approvals and questions in their rows; without it every row opens its session. */
  replies?: HomeReplies;
  onOpen: (session: ConversationSessionSummary) => void;
  onShowAll: () => void;
  onEnableIndex: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRetrySources: () => Promise<void>;
}) {
  const { locale, tr, formatRelativeTime } = useI18n();
  const [expanded, setExpanded] = useState<string>();
  const groups = useMemo(() => {
    const value = homeSessionGroups(sessions, { unconfirmed: replies?.unconfirmed });
    // An answered request stays off the list until the catalog reports the session again.
    return replies?.answered.size
      ? {
          ...value,
          needsYou: value.needsYou.filter(
            ({ session, need }) => need === "verify" || !replies.answered.has(session.id),
          ),
        }
      : value;
  }, [sessions, replies?.unconfirmed, replies?.answered]);
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

  const describe = (session: ConversationSessionSummary) => ({
    title: displaySessionTitle(session.title, tr),
    agent: AGENT_LABELS[session.agent],
    workspace:
      labels.get(session.id) ?? workspaces.find(({ id }) => id === session.workspace_id)?.name,
    time: session.updated_at
      ? formatRelativeTime(session.updated_at)
      : tr("conversations.unknownTime"),
  });
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
        <Notice text={tr("home.firstSession")} />
      </div>
    );
  return (
    <div className="grid gap-5">
      {sources}
      <HomeSessionList
        locale={locale}
        layout="wide"
        groups={groups}
        describe={describe}
        agentMark={(session) => <AgentIcon agent={session.agent} compact />}
        recent={{ limit: 8, label: "viewAll", onShowAll }}
        expanded={expanded}
        onToggle={
          replies
            ? (session) =>
                setExpanded((current) => (current === session.id ? undefined : session.id))
            : undefined
        }
        renderCard={
          replies
            ? (session) => (
                <HomeInteraction
                  session={session}
                  workspacePath={workspaces.find(({ id }) => id === session.workspace_id)?.path}
                  replies={replies}
                  onClose={() => setExpanded(undefined)}
                />
              )
            : undefined
        }
        onOpen={onOpen}
      />
    </div>
  );
}

function Notice({
  icon: Icon,
  text,
  children,
}: {
  icon?: Icon;
  text: string;
  children?: ReactNode;
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
