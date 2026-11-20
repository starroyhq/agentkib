import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import { useSession } from "../sessions/session-context";
import { useSessionNavigate } from "../sessions/session-navigation";
import { historyCopy } from "./history-copy";
import { HistorySearchDialog, historyAccessScope } from "./history-search";
import { historyMessageText, historyReferenceKey, validHistoryMessage } from "@agentkib/session-ui";
export function HistorySearchTrigger() {
  const session = useSession();
  if (!historyAccessScope(session.access)) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="min-h-11"
      onClick={() => session.setHistorySearchOpen(true)}
    >
      <Search size={16} />
      {historyCopy[session.locale].title}
    </Button>
  );
}
export function HistorySearchControls() {
  const session = useSession();
  const navigate = useSessionNavigate();
  const scope = historyAccessScope(session.access);
  if (!scope || !session.historySearchOpen || session.modal) return null;
  const targetId = session.selected;
  const canQuote =
    !session.busy &&
    session.notice !== "uncertain" &&
    !!targetId &&
    !!session.access?.device?.send &&
    ["codex", "claude-code", "antigravity"].includes(session.current?.agent ?? "");
  return (
    <HistorySearchDialog
      key={`${scope}:${targetId}`}
      client={session.client}
      locale={session.locale}
      scope={scope}
      currentSessionId={targetId}
      navigationContext={JSON.stringify([targetId, session.message, session.historyReferences])}
      openDisabled={session.busy || session.notice === "uncertain"}
      onOpenSession={async (source) => {
        await navigate({ to: "/sessions/$sessionId", params: { sessionId: source.id } });
        session.setHistorySearchOpen(false);
      }}
      onClose={() => session.setHistorySearchOpen(false)}
      onScopeEnded={() => {
        session.setHistorySearchOpen(false);
        session.setHistoryReferences([]);
      }}
      onReference={
        canQuote ? (reference) => session.addHistoryReference(reference, targetId) : undefined
      }
    />
  );
}
export function HistoryReferenceChips() {
  const session = useSession();
  const references = session.historyReferences ?? [];
  if (!historyAccessScope(session.access) || !session.access?.device?.send || !references.length)
    return null;
  const c = historyCopy[session.locale];
  return (
    <section aria-label={c.references} className="space-y-2 px-2 text-xs">
      {references.map((item) => (
        <div
          className="flex items-start gap-2 rounded border bg-muted/30 p-2"
          key={historyReferenceKey(item.reference)}
        >
          <Disclosure className="min-w-0 flex-1">
            <DisclosureSummary className="cursor-pointer truncate">
              {item.title || item.agent} · {c[item.kind]}
            </DisclosureSummary>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words pt-2">
              {item.content}
            </pre>
          </Disclosure>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${c.remove}: ${item.title || item.agent}`}
            disabled={session.busy || session.notice === "uncertain"}
            onClick={() =>
              session.setHistoryReferences(references.filter((entry) => entry !== item))
            }
          >
            <X size={14} />
          </Button>
        </div>
      ))}
      <Disclosure open className="rounded border bg-muted/30 p-2">
        <DisclosureSummary className="cursor-pointer">{c.messagePreview}</DisclosureSummary>
        <pre
          aria-label={c.messagePreview}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words pt-2"
        >
          {historyMessageText(session.message, references)}
        </pre>
      </Disclosure>
      {!validHistoryMessage(session.message, references) && (
        <p role="alert" className="text-destructive-text">
          {c.messageLimit}
        </p>
      )}
    </section>
  );
}
