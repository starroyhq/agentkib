import { useI18n } from "@/core/useI18n";
import type { ConversationEvent } from "@/core/types";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { turnFileActivity } from "@agentkib/conversation-state";
import {
  isHiddenWrapperTool,
  MessageActions,
  messageActionGroups,
  transcriptProcessCopy,
  transcriptProcessLabel,
  turnDurationOf,
  TurnFileChanges,
} from "@agentkib/session-ui";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ConversationEventRow } from "./ConversationEventRow";
import { groupConversationEvents } from "./conversation-groups";

export interface ConversationTranscriptProps {
  events: ConversationEvent[];
  sessionKey: string;
  incomplete?: boolean;
  historyDetailTurnId?: string;
  loadingEarlier?: boolean;
  loadEarlierDetails?: (turnId: string) => void;
}

function historyGroups(
  events: ConversationEvent[],
  incomplete: boolean,
  previous: ReturnType<typeof groupConversationEvents<ConversationEvent>>,
  explicit: ReadonlyMap<string, boolean>,
) {
  const groupKeys = new Map<string, string>();
  const processKeys = new Map<string, string>();
  const emptyStatuses = new Map<string, { group: string; process: string }>();
  const usedGroups = new Set<string>();
  const usedProcesses = new Set<string>();
  for (const group of previous) {
    for (const event of group.events) groupKeys.set(event.id, group.key);
    for (const segment of group.segments)
      if (segment.kind === "process") {
        for (const event of segment.events) processKeys.set(event.id, segment.key);
        if (group.terminalMarkerId && !segment.events.length)
          emptyStatuses.set(group.terminalMarkerId, { group: group.key, process: segment.key });
      }
  }
  return groupConversationEvents(events, { incomplete, isHidden: isHiddenWrapperTool }).map(
    (group) => {
      const status = group.terminalMarkerId ? emptyStatuses.get(group.terminalMarkerId) : undefined;
      const groupKey =
        group.events
          .map((event) => groupKeys.get(event.id))
          .find((key) => key && !usedGroups.has(key)) ??
        (status && !usedGroups.has(status.group) ? status.group : undefined);
      if (groupKey) usedGroups.add(groupKey);
      return {
        ...group,
        key: groupKey ?? group.key,
        segments: group.segments.map((segment) => {
          if (segment.kind !== "process") return segment;
          const keys = segment.events
            .map((event) => processKeys.get(event.id))
            .filter((key): key is string => !!key && !usedProcesses.has(key));
          const key =
            keys.find((key) => explicit.get(key) === true) ??
            keys.find((key) => explicit.has(key)) ??
            keys[0] ??
            (status && segment.outcome && !usedProcesses.has(status.process)
              ? status.process
              : undefined);
          if (key) usedProcesses.add(key);
          return key ? { ...segment, key } : segment;
        }),
      };
    },
  );
}

export function ConversationTranscript(props: ConversationTranscriptProps) {
  return <ConversationTranscriptForSession {...props} key={props.sessionKey} />;
}

function ConversationTranscriptForSession({
  events,
  sessionKey,
  incomplete = false,
  historyDetailTurnId,
  loadingEarlier,
  loadEarlierDetails,
}: ConversationTranscriptProps) {
  const { tr, locale } = useI18n();
  const copy = transcriptProcessCopy(locale);
  const [explicit, setExplicit] = useState(() => new Map<string, boolean>());
  const [projection, setProjection] = useState(() => ({
    events,
    incomplete,
    groups: historyGroups(events, incomplete, [], explicit),
  }));
  const current =
    projection.events === events && projection.incomplete === incomplete
      ? projection
      : {
          events,
          incomplete,
          groups: historyGroups(events, incomplete, projection.groups, explicit),
        };
  if (current !== projection) setProjection(current);

  const setExpanded = (key: string, open: boolean) => {
    setExplicit((current) => new Map(current).set(key, open));
  };
  const oldest = current.groups[0];
  const earlierProcessKey =
    oldest?.turnId === historyDetailTurnId && oldest?.events[0]?.kind !== "user-message"
      ? oldest?.segments.find((segment) => segment.kind === "process" && segment.outcome)?.key
      : undefined;

  return (
    <>
      {current.groups.map((group) => {
        const partial = group.turnId && !group.complete && !group.outcome;
        const showFailure =
          group.outcome === "failed" &&
          !group.segments.some((segment) => segment.outcome === "failed");
        const hasVisibleReply = group.segments.some(
          (segment) => segment.kind === "event" && segment.events[0]?.kind === "agent-message",
        );
        const firstProcess = group.segments.find((segment) => segment.kind === "process");
        const duration = group.durationMs ?? turnDurationOf(group.events);
        const blocks = messageActionGroups(group.segments);
        const activity = turnFileActivity(group);
        const lastReply = activity
          ? [...blocks]
              .reverse()
              .find(
                (block) => block.kind === "message" && block.events[0]?.kind === "agent-message",
              )
          : undefined;
        const fileChanges = activity && <TurnFileChanges {...activity} locale={locale} />;
        return (
          <section
            className="session-hub-turn flex min-w-0 flex-col gap-2 [&+.session-hub-turn]:mt-3"
            data-turn-id={group.turnId}
            data-turn-key={group.key}
            key={group.key}
          >
            {partial && (
              <div className="session-hub-turn-meta px-1 text-right text-[11px] text-muted-foreground">
                <span className="session-hub-partial-turn">{tr("sessions.partialTurn")}</span>
              </div>
            )}
            <div className="session-hub-turn-events flex flex-col gap-5">
              {blocks.map((block) => {
                if (block.kind === "message") {
                  const [first, ...rest] = block.events;
                  if (!first) return null;
                  if (!rest.length) {
                    return (
                      <div className="session-hub-transcript-event" key={first.id}>
                        <ConversationEventRow
                          event={first}
                          variant="hub"
                          beforeActions={block === lastReply ? fileChanges : undefined}
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      className="session-hub-transcript-event group/message space-y-3"
                      key={first.id}
                    >
                      {block.events.map((event) => (
                        <ConversationEventRow
                          key={event.id}
                          event={event}
                          variant="hub"
                          showActions={false}
                        />
                      ))}
                      {block === lastReply && fileChanges}
                      <MessageActions
                        locale={locale}
                        role="assistant"
                        text={block.events
                          .map(({ content }) => content)
                          .filter((text) => text?.trim())
                          .join("\n\n")}
                        timestamp={
                          block.events.at(-1)?.timestamp ??
                          block.events.find(({ timestamp }) => timestamp)?.timestamp
                        }
                        timestampLabel={tr("sessions.recordTime")}
                      />
                    </div>
                  );
                }
                const { segment } = block;
                const label = transcriptProcessLabel(
                  locale,
                  tr("sessions.process"),
                  segment.outcome,
                  segment === firstProcess ? duration : undefined,
                  hasVisibleReply,
                );
                const detailTurn = segment.key === earlierProcessKey ? group.turnId : undefined;
                if (segment.kind === "process" && !segment.events.length && !detailTurn)
                  return (
                    <p
                      key={segment.key}
                      className="text-xs text-muted-foreground"
                      data-history-anchor={segment.key}
                      data-terminal-turn-id={group.turnId}
                      data-terminal-outcome={segment.outcome}
                    >
                      {label}
                    </p>
                  );
                return segment.collapsible || detailTurn ? (
                  <Collapsible
                    className="session-hub-process group overflow-hidden bg-transparent"
                    data-segment-key={segment.key}
                    key={`${sessionKey}:${segment.key}`}
                    open={explicit.get(segment.key) ?? segment.defaultOpen}
                    onOpenChange={(open) => setExpanded(segment.key, open)}
                  >
                    <div className={segment.outcome ? "border-b border-border/70 pb-1" : undefined}>
                      <CollapsibleTrigger
                        data-history-anchor={segment.key}
                        data-terminal-turn-id={segment.outcome && group.turnId}
                        data-terminal-outcome={segment.outcome}
                        className="session-hub-process-summary flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-1.5 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span>{label}</span>
                        {!segment.outcome && segment.toolCount > 0 && (
                          <span>{tr("sessions.toolCalls", { count: segment.toolCount })}</span>
                        )}
                        {segment.failedToolCount > 0 &&
                          (!segment.outcome || segment.outcome === "failed") && (
                            <span className="text-destructive-text">
                              {tr("sessions.processFailed", { count: segment.failedToolCount })}
                            </span>
                          )}
                        <ChevronRight
                          aria-hidden="true"
                          className="size-3.5 shrink-0 transition-transform group-data-open:rotate-90"
                        />
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent className="session-hub-process-events mt-2 flex flex-col gap-2 pb-2">
                      {detailTurn && loadEarlierDetails && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="content"
                          disabled={loadingEarlier}
                          className="w-fit px-1.5 py-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
                          onClick={() => loadEarlierDetails(detailTurn)}
                        >
                          {copy.earlierDetails}
                        </Button>
                      )}
                      {segment.events.map((event) => (
                        <ConversationEventRow key={event.id} event={event} variant="hub" />
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ) : (
                  <div className="session-hub-transcript-event" key={segment.key}>
                    {segment.events.map((event) => (
                      <ConversationEventRow key={event.id} event={event} variant="hub" />
                    ))}
                  </div>
                );
              })}
              {showFailure && (
                <p
                  data-terminal-turn-id={group.turnId}
                  data-terminal-outcome="failed"
                  className="text-xs font-medium text-destructive-text"
                >
                  {copy.failed}
                </p>
              )}
              {!lastReply && fileChanges}
            </div>
          </section>
        );
      })}
    </>
  );
}
