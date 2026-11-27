import type {
  WorkerReportPart,
  WorkerReportView,
  WorkerReportWaitingItem,
} from "@agentkib/web-client";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  FileCode2,
  HelpCircle,
  Terminal,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { SafeMarkdown } from "./safe-markdown";
import {
  formatWorkerReportClock,
  formatWorkerReportDuration,
  isKnownWorkerReportKind,
  workerReportBadgeAndTone,
  workerReportCopy,
  workerReportSummaryText,
  type WorkerReportTone,
} from "./worker-report-copy";

export const WORKER_REPLY_COLLAPSE_LINES = 6;
export const WORKER_REPLY_COLLAPSE_CHARS = 320;

export interface WorkerReportEntry {
  key: string;
  eventId: string;
  reportId: string;
  part: WorkerReportPart;
}

const badgeStyles: Record<WorkerReportTone, string> = {
  success: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  danger: "border-destructive/25 bg-destructive/10 text-destructive-text",
  warning: "border-amber-500/35 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  info: "border-ring/30 bg-[var(--primary-selected-bg,var(--accent))] text-accent-foreground",
  neutral: "border-border/70 bg-foreground/[0.05] text-muted-foreground",
};

const leftAccentStyles: Record<WorkerReportTone, string> = {
  success: "border-l-emerald-500/75",
  danger: "border-l-destructive/80",
  warning: "border-l-amber-500/85",
  info: "border-l-ring/80",
  neutral: "border-l-border",
};

const cardSurfaceStyles: Record<WorkerReportTone, string> = {
  success: "border-border/80 bg-card",
  danger: "border-destructive/30 bg-destructive/[0.035]",
  warning: "border-amber-500/35 bg-amber-500/[0.045]",
  info: "border-border/80 bg-card",
  neutral: "border-border/75 bg-foreground/[0.02]",
};

function agentInitial(agent: string): string {
  const trimmed = agent.trim();
  if (!trimmed) return "W";
  return trimmed.slice(0, 1).toUpperCase();
}

function replyMetrics(reply: string): { lines: number; chars: number; shouldCollapse: boolean } {
  const normalized = reply.trim();
  const lines = normalized ? normalized.split(/\r?\n/).length : 0;
  const chars = [...normalized].length;
  return {
    lines,
    chars,
    shouldCollapse: lines > WORKER_REPLY_COLLAPSE_LINES || chars > WORKER_REPLY_COLLAPSE_CHARS,
  };
}

function firstLinePreview(part: WorkerReportPart, locale: string): string {
  if (part.waitingItems?.length) {
    const first = part.waitingItems[0];
    return first.summary.trim();
  }
  if (part.reply?.trim()) {
    const firstLine = part.reply
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s#>*`\-+]+/, "").trim())
      .find(Boolean);
    if (firstLine) return firstLine;
  }
  return workerReportSummaryText(part, locale) ?? "";
}

function isCompactInlineKind(part: WorkerReportPart): boolean {
  if (part.requiresUser) return false;
  if (part.reply?.trim() || part.waitingItems?.length) return false;
  return (
    part.kind === "turn-ended" ||
    part.kind === "stalled" ||
    part.kind === "long-command" ||
    part.kind === "recovered" ||
    part.kind === "user-intervention" ||
    (part.kind === "offline" && !part.requiresUser) ||
    (part.kind === "restart-result" && !part.requiresUser) ||
    (part.kind === "interrupted-by-quit" && !part.requiresUser)
  );
}

function WaitingItemsPreview({
  items,
  locale,
  urgent,
}: {
  items: readonly WorkerReportWaitingItem[];
  locale: string;
  urgent: boolean;
}) {
  const copy = workerReportCopy(locale);
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => {
        const icon =
          item.kind === "command" ? (
            <Terminal aria-hidden="true" className="size-3.5 shrink-0" />
          ) : item.kind === "file-change" ? (
            <FileCode2 aria-hidden="true" className="size-3.5 shrink-0" />
          ) : (
            <HelpCircle aria-hidden="true" className="size-3.5 shrink-0" />
          );
        const heading =
          item.kind === "command"
            ? copy.commandPreview
            : item.kind === "file-change"
              ? copy.fileChanges
              : item.kind === "question"
                ? copy.questionPreview
                : copy.requestDetails;
        return (
          <div
            key={`${item.kind}:${index}:${item.summary}`}
            className={`rounded-xl border px-3 py-2 text-xs ${
              urgent
                ? "border-amber-500/30 bg-background/85"
                : "border-border/70 bg-foreground/[0.03]"
            }`}
          >
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {icon}
              <span>{heading}</span>
            </div>
            {item.kind === "command" ? (
              <pre className="m-0 overflow-x-auto font-mono text-[12px] leading-5 text-foreground whitespace-pre-wrap break-words">
                {item.summary}
              </pre>
            ) : (
              <p className="m-0 text-[13px] leading-5 text-foreground break-words">
                {item.summary}
              </p>
            )}
            {item.detail && (
              <pre className="mt-1.5 mb-0 max-h-36 overflow-auto rounded-lg border border-border/60 bg-foreground/[0.025] px-2.5 py-1.5 font-mono text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap break-words">
                {item.detail}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WorkerReplyBody({
  reply,
  truncated,
  locale,
  expanded,
  onToggleExpand,
}: {
  reply: string;
  truncated?: boolean;
  locale: string;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const copy = workerReportCopy(locale);
  const metrics = useMemo(() => replyMetrics(reply), [reply]);
  const collapsed = metrics.shouldCollapse && !expanded;
  return (
    <div className="min-w-0">
      <div
        data-worker-report-reply={collapsed ? "collapsed" : "expanded"}
        className={
          collapsed
            ? "aui-markdown relative max-h-[6.75rem] overflow-hidden text-[13.5px] leading-6 text-foreground"
            : "aui-markdown text-[13.5px] leading-6 text-foreground"
        }
      >
        <div className="select-text">
          <SafeMarkdown text={reply} locale={locale} />
        </div>
        {collapsed && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card via-card/85 to-transparent"
          />
        )}
      </div>
      {(metrics.shouldCollapse || truncated) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          <span>
            {[copy.replyLines(metrics.lines), truncated ? copy.replyTruncated : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {metrics.shouldCollapse && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-accent-foreground transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onToggleExpand}
            >
              <span>{expanded ? copy.collapseReply : copy.expandReply}</span>
              <ChevronDown
                aria-hidden="true"
                className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WorkerActionButton({
  actionKind,
  sessionId,
  locale,
  onOpenSession,
}: {
  actionKind: "handle" | "verify" | "open";
  sessionId: string;
  locale: string;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
}) {
  if (!onOpenSession || !sessionId) return null;
  const copy = workerReportCopy(locale);
  const label =
    actionKind === "handle"
      ? copy.handleNow
      : actionKind === "verify"
        ? copy.verifyNow
        : copy.openSession;
  const urgent = actionKind === "handle" || actionKind === "verify";
  return (
    <button
      type="button"
      onClick={() => void onOpenSession(sessionId)}
      className={
        urgent
          ? "inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-500/45 bg-background px-2.5 py-1 text-xs font-medium text-amber-900 shadow-xs transition-colors hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-200"
          : "inline-flex shrink-0 items-center gap-1 rounded-lg border border-border/80 bg-background px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      }
    >
      <span>{label}</span>
      {urgent ? (
        <ArrowRight aria-hidden="true" className="size-3.5" />
      ) : (
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

function WorkerAgentBadge({
  agent,
  agentMark,
}: {
  agent: string;
  agentMark?: (agent: string) => ReactNode;
}) {
  const rendered = agentMark?.(agent);
  if (rendered) {
    return (
      <span
        aria-hidden="true"
        className="inline-grid size-5 shrink-0 place-items-center overflow-hidden"
        title={agent}
      >
        {rendered}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-grid size-5 shrink-0 place-items-center rounded-md border border-border/70 bg-foreground/[0.04] text-[10px] font-semibold text-muted-foreground"
      title={agent}
    >
      {agentInitial(agent)}
    </span>
  );
}

function WorkerIdentity({
  part,
  badge,
  tone,
  locale,
  agentMark,
}: {
  part: WorkerReportPart;
  badge: string;
  tone: WorkerReportTone;
  locale: string;
  agentMark?: (agent: string) => ReactNode;
}) {
  const copy = workerReportCopy(locale);
  const duration =
    part.kind === "turn-ended" ? formatWorkerReportDuration(part.durationMs, locale) : undefined;
  const clock = formatWorkerReportClock(part.occurredAt, locale);
  const metaText = [duration ? copy.durationPrefix(duration) : undefined, clock]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <WorkerAgentBadge agent={part.agent} agentMark={agentMark} />
      <span className="max-w-full truncate text-[13px] font-semibold text-foreground">
        {part.workerName}
      </span>
      <span
        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${badgeStyles[tone]}`}
      >
        {badge}
      </span>
      {metaText && (
        <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
          {metaText}
        </span>
      )}
    </div>
  );
}

export function WorkerReportCard({
  entry,
  omittedDetails = false,
  locale,
  agentMark,
  onOpenSession,
}: {
  entry: WorkerReportEntry;
  omittedDetails?: boolean;
  locale: string;
  agentMark?: (agent: string) => ReactNode;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
}) {
  const { part } = entry;
  const copy = workerReportCopy(locale);
  const { badge, tone, actionKind } = workerReportBadgeAndTone(part, locale);
  const summary = workerReportSummaryText(part, locale);
  const compact = isCompactInlineKind(part);
  const [replyExpanded, setReplyExpanded] = useState(false);
  const surfaceTone: WorkerReportTone = part.requiresUser
    ? tone
    : part.kind === "turn-ended" && part.outcome === "failed"
      ? "danger"
      : "neutral";

  if (compact) {
    return (
      <section
        role="region"
        aria-label={copy.regionSingle(part.workerName)}
        data-event-id={entry.eventId}
        data-worker-report={entry.reportId}
        data-worker-report-kind={part.kind}
        className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-l-[3px] px-3.5 py-2.5 text-xs ${leftAccentStyles[tone]} ${cardSurfaceStyles[surfaceTone]}`}
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <WorkerIdentity
            part={part}
            badge={badge}
            tone={tone}
            locale={locale}
            agentMark={agentMark}
          />
          {summary && (
            <span className="min-w-0 text-xs leading-5 text-muted-foreground">{summary}</span>
          )}
        </div>
        <WorkerActionButton
          actionKind={actionKind}
          sessionId={part.workerSessionId}
          locale={locale}
          onOpenSession={onOpenSession}
        />
      </section>
    );
  }

  return (
    <section
      role="region"
      aria-label={copy.regionSingle(part.workerName)}
      data-event-id={entry.eventId}
      data-worker-report={entry.reportId}
      data-worker-report-kind={part.kind}
      className={`w-full overflow-hidden rounded-2xl border border-l-[3px] shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${leftAccentStyles[tone]} ${cardSurfaceStyles[surfaceTone]}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/55 bg-foreground/[0.02] px-3.5 py-2.5">
        <WorkerIdentity
          part={part}
          badge={badge}
          tone={tone}
          locale={locale}
          agentMark={agentMark}
        />
        <WorkerActionButton
          actionKind={actionKind}
          sessionId={part.workerSessionId}
          locale={locale}
          onOpenSession={onOpenSession}
        />
      </header>
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        {summary && <p className="m-0 text-[13px] leading-5 text-foreground/90">{summary}</p>}
        {part.waitingItems && part.waitingItems.length > 0 && (
          <WaitingItemsPreview
            items={part.waitingItems}
            locale={locale}
            urgent={part.requiresUser}
          />
        )}
        {part.reply?.trim() && (
          <WorkerReplyBody
            reply={part.reply}
            truncated={part.replyTruncated}
            locale={locale}
            expanded={replyExpanded}
            onToggleExpand={() => setReplyExpanded((open) => !open)}
          />
        )}
        {omittedDetails && (
          <p className="m-0 border-t border-border/50 pt-2 text-[11.5px] leading-5 text-muted-foreground">
            {copy.omittedDetails}
          </p>
        )}
      </div>
    </section>
  );
}

export function sortWorkerReportEntries(
  entries: readonly WorkerReportEntry[],
): WorkerReportEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.part.requiresUser !== b.entry.part.requiresUser)
        return a.entry.part.requiresUser ? -1 : 1;
      const ta = Date.parse(a.entry.part.occurredAt);
      const tb = Date.parse(b.entry.part.occurredAt);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

export function WorkerReportGroup({
  entries,
  omittedDetails = false,
  locale,
  agentMark,
  onOpenSession,
}: {
  entries: readonly WorkerReportEntry[];
  omittedDetails?: boolean;
  locale: string;
  agentMark?: (agent: string) => ReactNode;
  onOpenSession?: (sessionId: string) => void | Promise<void>;
}) {
  const copy = workerReportCopy(locale);
  const sorted = useMemo(() => sortWorkerReportEntries(entries), [entries]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});

  if (sorted.length === 1) {
    return (
      <WorkerReportCard
        entry={sorted[0]}
        omittedDetails={omittedDetails}
        locale={locale}
        agentMark={agentMark}
        onOpenSession={onOpenSession}
      />
    );
  }

  const counts = sorted.reduce(
    (acc, { part }) => {
      if (part.requiresUser) acc.requiresUser += 1;
      else if (part.kind === "turn-ended" && part.outcome === "failed") acc.failed += 1;
      else if (part.kind === "turn-ended" && part.outcome === "completed") acc.completed += 1;
      else acc.other += 1;
      return acc;
    },
    { requiresUser: 0, failed: 0, completed: 0, other: 0 },
  );

  const isRowOpen = (entry: WorkerReportEntry) =>
    expandedRows[entry.key] ?? entry.part.requiresUser;
  const allOpen = sorted.every(isRowOpen);
  const toggleAll = () => {
    const next = !allOpen;
    setExpandedRows(Object.fromEntries(sorted.map((entry) => [entry.key, next])));
  };

  const eventIds = [...new Set(sorted.map((entry) => entry.eventId))];

  return (
    <section
      role="region"
      aria-label={copy.regionGroup(sorted.length)}
      data-worker-report-group=""
      data-event-id={eventIds[0]}
      className="w-full overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-foreground/[0.025] px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">
            {copy.groupTitle(sorted.length)}
          </span>
          {counts.requiresUser > 0 && (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeStyles.warning}`}
            >
              {copy.countRequiresUser(counts.requiresUser)}
            </span>
          )}
          {counts.failed > 0 && (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeStyles.danger}`}
            >
              {copy.countFailed(counts.failed)}
            </span>
          )}
          {counts.completed > 0 && (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeStyles.success}`}
            >
              {copy.countCompleted(counts.completed)}
            </span>
          )}
          {counts.other > 0 && (
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${badgeStyles.neutral}`}
            >
              {copy.countOther(counts.other)}
            </span>
          )}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={toggleAll}
        >
          {allOpen ? copy.collapseAll : copy.expandAll}
        </button>
      </header>

      <div className="divide-y divide-border/55">
        {sorted.map((entry) => {
          const { part } = entry;
          const open = isRowOpen(entry);
          const { badge, tone, actionKind } = workerReportBadgeAndTone(part, locale);
          const summary = workerReportSummaryText(part, locale);
          const preview = firstLinePreview(part, locale);
          const duration = formatWorkerReportDuration(part.durationMs, locale);
          const clock = formatWorkerReportClock(part.occurredAt, locale);
          const trailingMeta = duration ?? clock;
          const rowHighlight = part.requiresUser ? "bg-amber-500/[0.045]" : "";
          return (
            <div
              key={entry.key}
              data-event-id={entry.eventId}
              data-worker-report={entry.reportId}
              data-worker-report-item={part.kind}
              className={`border-l-[3px] ${leftAccentStyles[tone]} ${rowHighlight}`}
            >
              <div className="flex items-center gap-2 px-3.5 py-2.5">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpandedRows((current) => ({ ...current, [entry.key]: !open }))}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                >
                  <WorkerAgentBadge agent={part.agent} agentMark={agentMark} />
                  <span className="shrink-0 text-[13px] font-semibold text-foreground">
                    {part.workerName}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${badgeStyles[tone]}`}
                  >
                    {badge}
                  </span>
                  {!open && preview && (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {preview}
                    </span>
                  )}
                  {trailingMeta && (
                    <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
                      {trailingMeta}
                    </span>
                  )}
                  <ChevronRight
                    aria-hidden="true"
                    className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
                  />
                </button>
                {(part.requiresUser || open) && (
                  <WorkerActionButton
                    actionKind={actionKind}
                    sessionId={part.workerSessionId}
                    locale={locale}
                    onOpenSession={onOpenSession}
                  />
                )}
              </div>
              {open && (
                <div className="flex flex-col gap-2.5 px-3.5 pb-3 pt-0.5 pl-10">
                  {summary && (
                    <p className="m-0 text-[13px] leading-5 text-foreground/90">{summary}</p>
                  )}
                  {part.waitingItems && part.waitingItems.length > 0 && (
                    <WaitingItemsPreview
                      items={part.waitingItems}
                      locale={locale}
                      urgent={part.requiresUser}
                    />
                  )}
                  {part.reply?.trim() && (
                    <WorkerReplyBody
                      reply={part.reply}
                      truncated={part.replyTruncated}
                      locale={locale}
                      expanded={expandedReplies[entry.key] === true}
                      onToggleExpand={() =>
                        setExpandedReplies((current) => ({
                          ...current,
                          [entry.key]: !current[entry.key],
                        }))
                      }
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {omittedDetails && (
        <footer className="border-t border-border/55 bg-foreground/[0.02] px-3.5 py-2 text-[11.5px] text-muted-foreground">
          {copy.omittedDetails}
        </footer>
      )}
    </section>
  );
}

export function workerReportEntriesOf(
  events: readonly { id: string; worker_reports?: WorkerReportView }[],
): { entries: WorkerReportEntry[]; omittedDetails: boolean } {
  const entries: WorkerReportEntry[] = [];
  let omittedDetails = false;
  for (const event of events) {
    const view = event.worker_reports;
    if (!view?.parts.length) continue;
    if (!view.parts.every((part) => isKnownWorkerReportKind(part.kind))) continue;
    if (view.omittedDetails) omittedDetails = true;
    view.parts.forEach((part, index) => {
      entries.push({
        key: `${view.reportId}:${index}`,
        eventId: event.id,
        reportId: view.reportId,
        part,
      });
    });
  }
  return { entries, omittedDetails };
}
