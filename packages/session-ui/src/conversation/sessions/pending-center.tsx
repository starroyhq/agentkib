import { Bell, ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  Access,
  Approval,
  ConversationSessionSummary,
  Live,
  UserQuestionRequest,
} from "@agentkib/web-client";
import { catalogCopy } from "../../catalog-copy";
import { homeSessionCopy, type HomeListNeed } from "../../home-sessions";
import { interactionCardCopy, type InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { interactionCopy } from "../interactions/interaction-copy";
import { approvalSummary } from "./approval-summary";
import {
  pendingScope,
  readPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";

export type PendingCenterCopy = Record<
  "pending" | "close" | "pendingInfo" | "error" | "pendingEmpty" | "unknown" | "refresh",
  string
>;

type PendingCenterSession = {
  access: Access | null | undefined;
  origin: string;
  sessions: readonly ConversationSessionSummary[];
  excludedSessionIds?: ReadonlySet<string>;
  selected: string;
  live: Live | undefined;
  pendingSessions: Readonly<Record<string, boolean>>;
  locale: InteractionLocale;
  t: { untitled: string; approval: string; unknownTool: string };
  setModal(request: Approval | UserQuestionRequest): void;
  refresh(manual: boolean): Promise<unknown>;
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
    origin,
    sessions,
    excludedSessionIds,
    selected,
    live,
    pendingSessions,
    locale,
    t,
    setModal,
    refresh,
  } = session;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<PendingControl[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (access?.status !== "approved" || !access.device?.id) {
      setSaved([]);
      return;
    }
    const scope = pendingScope(origin, access.device.id);
    const read = () => {
      try {
        setSaved(readPending(scope));
        setFailed(false);
      } catch {
        setFailed(true);
      }
    };
    read();
    return subscribePending(read);
  }, [origin, access?.status, access?.device?.id, open, live?.revision]);
  const approved = access?.status === "approved";
  const pendingIds = new Set(
    needsYou
      ? needsYou.map(({ session }) => session.id)
      : [
          ...Object.keys(pendingSessions).filter((id) => pendingSessions[id]),
          ...saved.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
        ],
  );
  const interactions = sessions.some(
    (session) => session.id === selected && session.availability === "readable",
  )
    ? [...(live?.approvals ?? []), ...(live?.questions ?? [])]
    : [];
  if (!needsYou && interactions.length && selected) pendingIds.add(selected);
  const unlinkedSaved = saved.filter((item) => !item.sessionId);
  const showTrigger =
    approved && (open || failed || pendingIds.size > 0 || unlinkedSaved.length > 0);
  const card = interactionCardCopy(locale);
  const needLabel = (id: string) => {
    const need = needsYou?.find(({ session }) => session.id === id)?.need;
    return need === "approval"
      ? card.waitingApproval
      : need === "question"
        ? card.waitingAnswer
        : need === "verify"
          ? homeSessionCopy(locale).verifyResult
          : need === "delegation"
            ? homeSessionCopy(locale).delegationPaused
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
          <p className="text-xs text-muted-foreground">{copy.pendingInfo}</p>
          {failed && <p role="alert">{copy.error}</p>}
          {!pendingIds.size && !unlinkedSaved.length && <p>{copy.pendingEmpty}</p>}
          {Array.from(pendingIds).map((id) => (
            <section key={id} className="space-y-2 rounded border p-3">
              {excludedSessionIds?.has(id) ? (
                <p className="text-xs text-muted-foreground">
                  {catalogCopy[locale].excludedPending}
                </p>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    onNavigate(id);
                  }}
                >
                  {sessions.find((item) => item.id === id)?.title || t.untitled}
                </Button>
              )}
              {needLabel(id) ? (
                <p className="text-xs text-muted-foreground">{needLabel(id)}</p>
              ) : (
                saved.some((item) => item.sessionId === id) && (
                  <p className="text-xs text-muted-foreground">{copy.unknown}</p>
                )
              )}
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
          {unlinkedSaved.map((item) => (
            <p key={item.requestId} className="text-xs text-muted-foreground">
              {copy.unknown} · {item.kind}
            </p>
          ))}
          <Button variant="outline" onClick={() => void refresh(true)}>
            {copy.refresh}
          </Button>
        </SessionDialog>
      )}
    </>
  );
}
