import { Bell, ListTodo } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useSessionNavigate } from "./session-navigation";
import { Button } from "@/components/ui/button";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import {
  pendingScope,
  readPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";
import { codexCopy } from "./codex-copy";
import { catalogCopy } from "../catalog/catalog-copy";
import { approvalSummary } from "./approval-summary";
import { interactionCopy } from "../interactions/interaction-copy";

export function PendingCenter({ compact = false }: { compact?: boolean }) {
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
  } = useSession();
  const copy = codexCopy[locale];
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<PendingControl[]>([]);
  const [failed, setFailed] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const navigate = useSessionNavigate();
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
  useEffect(() => {
    const sync = () =>
      setPortalTarget(document.querySelector<HTMLElement>("[data-session-window-pending-slot]"));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  if (access?.status !== "approved") return null;
  const pendingIds = new Set([
    ...Object.keys(pendingSessions).filter((id) => pendingSessions[id]),
    ...saved.flatMap((item) => (item.sessionId ? [item.sessionId] : [])),
  ]);
  const interactions = sessions.some(
    (session) => session.id === selected && session.availability === "readable",
  )
    ? [...(live?.approvals ?? []), ...(live?.questions ?? [])]
    : [];
  if (interactions.length && selected) pendingIds.add(selected);
  // The directory bell filters unread results. Business requests keep their own
  // existing window action, shown when there is something to handle or recover.
  if (compact && portalTarget && !open && !failed && !pendingIds.size && !saved.length) return null;
  const trigger = (
    <Button
      data-conversation-pending-trigger
      variant="ghost"
      className={compact ? "relative !size-9 !min-w-0 !p-0" : "min-h-11"}
      aria-label={`${copy.pending}${pendingIds.size ? ` (${pendingIds.size})` : ""}`}
      title={copy.pending}
      onClick={() => setOpen(true)}
    >
      {compact ? portalTarget ? <ListTodo size={18} /> : <Bell size={18} /> : copy.pending}
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
      {portalTarget && compact ? createPortal(trigger, portalTarget) : trigger}
      {open && (
        <Dialog panel title={copy.pending} closeLabel={copy.close} onClose={() => setOpen(false)}>
          <p className="text-xs text-muted-foreground">{copy.pendingInfo}</p>
          {failed && <p role="alert">{copy.error}</p>}
          {!pendingIds.size && !saved.length && <p>{copy.pendingEmpty}</p>}
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
                    void navigate({ to: "/sessions/$sessionId", params: { sessionId: id } });
                  }}
                >
                  {sessions.find((item) => item.id === id)?.title || t.untitled}
                </Button>
              )}
              {saved.some((item) => item.sessionId === id) && (
                <p className="text-xs text-muted-foreground">{copy.unknown}</p>
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
          {saved
            .filter((item) => !item.sessionId)
            .map((item) => (
              <p key={item.requestId} className="text-xs text-muted-foreground">
                {copy.unknown} · {item.kind}
              </p>
            ))}
          <Button variant="outline" onClick={() => void refresh(true)}>
            {copy.refresh}
          </Button>
        </Dialog>
      )}
    </>
  );
}
