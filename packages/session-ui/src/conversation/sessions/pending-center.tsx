import { Bell, ListTodo } from "lucide-react";
import { useState } from "react";
import type {
  Access,
  Approval,
  ConversationSessionSummary,
  Live,
  UserQuestionRequest,
} from "@agentkib/web-client";
import type { HomeListNeed } from "../../home-sessions";
import { interactionCardCopy, type InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { interactionCopy } from "../interactions/interaction-copy";
import { approvalSummary } from "./approval-summary";

export type PendingCenterCopy = Record<"pending" | "close" | "pendingEmpty", string>;

type PendingCenterSession = {
  access: Access | null | undefined;
  sessions: readonly ConversationSessionSummary[];
  excludedSessionIds?: ReadonlySet<string>;
  selected: string;
  live: Live | undefined;
  pendingSessions: Readonly<Record<string, boolean>>;
  locale: InteractionLocale;
  t: { untitled: string; approval: string; unknownTool: string };
  setModal(request: Approval | UserQuestionRequest): void;
};

/** When supplied, the home's group controls which sessions the center counts and lists. */
export function PendingCenter({
  session,
  copy,
  onNavigate,
  compact = false,
  needsYou,
}: {
  session: PendingCenterSession;
  copy: PendingCenterCopy;
  onNavigate(sessionId: string): void;
  compact?: boolean;
  needsYou?: readonly { session: { id: string }; need: HomeListNeed }[];
}) {
  const {
    components: { Button, SessionDialog },
    notifications: {
      pendingCenter: { compactClassName, showTriggerTitle, TriggerSlot },
    },
  } = useSessionPlatform();
  const {
    access,
    sessions,
    excludedSessionIds,
    selected,
    live,
    pendingSessions,
    locale,
    t,
    setModal,
  } = session;
  const [open, setOpen] = useState(false);
  const approved = access?.status === "approved";
  const readable = new Map(
    sessions
      .filter(({ id, availability }) => availability === "readable" && !excludedSessionIds?.has(id))
      .map((item) => [item.id, item]),
  );
  const interactions =
    live?.sessionId === selected && readable.has(selected)
      ? [...(live.approvals ?? []), ...(live.questions ?? [])]
      : [];
  const needs = new Map(
    needsYou
      ?.filter(({ need }) => need === "approval" || need === "question")
      .map(({ session, need }) => [session.id, need]),
  );
  const candidateIds = needsYou
    ? [...needs.keys()]
    : Object.keys(pendingSessions).filter((id) => pendingSessions[id]);
  const pendingIds = new Set(candidateIds.filter((id) => readable.has(id)));
  if (!needsYou && interactions.length) pendingIds.add(selected);
  const showTrigger = approved && (open || pendingIds.size > 0);
  const card = interactionCardCopy(locale);
  const needLabel = (id: string) => {
    const need = needs.get(id);
    return need === "approval"
      ? card.waitingApproval
      : need === "question"
        ? card.waitingAnswer
        : undefined;
  };
  const trigger = (inWindow: boolean) =>
    showTrigger && (
      <Button
        data-conversation-pending-trigger
        variant="ghost"
        className={compact ? compactClassName : "min-h-11"}
        aria-label={`${copy.pending}${pendingIds.size ? ` (${pendingIds.size})` : ""}`}
        title={showTriggerTitle ? copy.pending : undefined}
        onClick={() => setOpen(true)}
      >
        {compact ? inWindow ? <ListTodo size={18} /> : <Bell size={18} /> : copy.pending}
        {pendingIds.size > 0 && (
          <span
            aria-hidden="true"
            className={
              compact
                ? "absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-background bg-primary px-0.5 text-[10px] leading-none font-semibold tabular-nums text-primary-foreground shadow-sm"
                : ""
            }
          >
            {pendingIds.size}
          </span>
        )}
      </Button>
    );
  return (
    <>
      {compact && TriggerSlot ? <TriggerSlot>{trigger}</TriggerSlot> : trigger(false)}
      {approved && open && (
        <SessionDialog
          panel
          title={copy.pending}
          closeLabel={copy.close}
          onClose={() => setOpen(false)}
        >
          {!pendingIds.size && <p>{copy.pendingEmpty}</p>}
          {Array.from(pendingIds).map((id) => (
            <section key={id} className="space-y-2 rounded border p-3">
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  onNavigate(id);
                }}
              >
                {readable.get(id)?.title || t.untitled}
              </Button>
              {needLabel(id) && <p className="text-xs text-muted-foreground">{needLabel(id)}</p>}
              {id === selected &&
                interactions.map((request) => (
                  <Button
                    variant="outline"
                    size="sm"
                    key={`${"questions" in request ? "q" : "a"}:${request.requestId}`}
                    onClick={() => {
                      setOpen(false);
                      setModal(request);
                    }}
                  >
                    {"questions" in request
                      ? `${interactionCopy[locale].title} · ${request.questions?.[0]?.question ?? ""}`
                      : `${t.approval} · ${approvalSummary(request, locale, t.unknownTool)}`}
                  </Button>
                ))}
            </section>
          ))}
        </SessionDialog>
      )}
    </>
  );
}
