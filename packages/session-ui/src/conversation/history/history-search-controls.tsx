import { Search, X } from "lucide-react";
import type {
  Access,
  ConversationSessionSummary,
  ResolvedHistoryReference,
  WebClient,
} from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { IconAction } from "../../icon-action";
import { sessionHistoryEntry } from "../../agents/session-history";
import { useSessionPlatform } from "../../session-platform";
import { historyCopy } from "./history-copy";
import {
  historyMessageText,
  historyReferenceKey,
  validHistoryMessage,
} from "./history-reference-model";
import { HistorySearchDialog, historyAccessScope } from "./history-search";

export function HistorySearchTrigger({
  access,
  locale,
  onOpen,
}: {
  access: Access | null | undefined;
  locale: Locale;
  onOpen: () => void;
}) {
  if (!historyAccessScope(access)) return null;
  return <SearchTrigger locale={locale} onOpen={onOpen} />;
}
function SearchTrigger({ locale, onOpen }: { locale: Locale; onOpen: () => void }) {
  const {
    components: { Button },
  } = useSessionPlatform();
  return (
    <IconAction
      label={historyCopy[locale].title}
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 p-0"
          onClick={onOpen}
        />
      }
    >
      <Search size={16} aria-hidden="true" />
    </IconAction>
  );
}
type HistorySearchSession = {
  access: Access | null | undefined;
  historySearchOpen: boolean;
  modal: unknown;
  selected: string;
  busy: boolean;
  notice: unknown;
  current?: Pick<ConversationSessionSummary, "id" | "agent"> | null;
  client: WebClient;
  locale: Locale;
  message: string;
  historyReferences: ResolvedHistoryReference[];
  setHistorySearchOpen(open: boolean): void;
  setHistoryReferences(references: ResolvedHistoryReference[]): void;
  addHistoryReference(reference: ResolvedHistoryReference, targetId: string): void;
};

export function HistorySearchControls({
  session,
  onOpenSession,
}: {
  session: HistorySearchSession;
  onOpenSession: (source: ConversationSessionSummary) => void | Promise<void>;
}) {
  const scope = historyAccessScope(session.access);
  if (!scope || !session.historySearchOpen || session.modal) return null;
  const targetId = session.selected;
  const references =
    !!targetId &&
    session.current?.id === targetId &&
    sessionHistoryEntry(session.current.agent)?.references;
  const c = historyCopy[session.locale];
  const referenceDisabledReason = !session.access?.device?.send
    ? c.referenceSendPermission
    : session.notice === "uncertain"
      ? c.referenceUncertain
      : session.busy
        ? c.referenceBusy
        : undefined;
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
        await onOpenSession(source);
        session.setHistorySearchOpen(false);
      }}
      onClose={() => session.setHistorySearchOpen(false)}
      onScopeEnded={() => {
        session.setHistorySearchOpen(false);
        session.setHistoryReferences([]);
      }}
      onReference={
        references ? (reference) => session.addHistoryReference(reference, targetId) : undefined
      }
      referenceDisabledReason={referenceDisabledReason}
    />
  );
}
type HistoryReferenceChipsProps = {
  access: Access | null | undefined;
  locale: Locale;
  references?: readonly ResolvedHistoryReference[];
  message: string;
  disabled: boolean;
  onRemove(reference: ResolvedHistoryReference): void;
};

export function HistoryReferenceChips({
  access,
  references,
  ...props
}: HistoryReferenceChipsProps) {
  if (!historyAccessScope(access) || !access?.device?.send || !references?.length) return null;
  return <ReferenceChips {...props} references={references} />;
}

function ReferenceChips({
  locale,
  references,
  message,
  disabled,
  onRemove,
}: Omit<HistoryReferenceChipsProps, "access" | "references"> & {
  references: readonly ResolvedHistoryReference[];
}) {
  const {
    components: { Button, Disclosure, DisclosureSummary },
  } = useSessionPlatform();
  const c = historyCopy[locale];
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
            disabled={disabled}
            onClick={() => onRemove(item)}
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
          {historyMessageText(message, references)}
        </pre>
      </Disclosure>
      {!validHistoryMessage(message, references) && (
        <p role="alert" className="text-destructive-text">
          {c.messageLimit}
        </p>
      )}
    </section>
  );
}
