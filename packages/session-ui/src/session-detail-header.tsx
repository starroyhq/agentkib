import type { ConversationSessionSummary, Live } from "@agentkib/web-client";
import type { ComposerModelLocale } from "./composer-model-copy";
import { catalogCopy } from "./catalog-copy";
import { OrchestrationNote } from "./orchestration-note";
import { WorktreeNote } from "./worktree-note";

export function SessionDetailHeader({
  session,
  locale,
  forkTitle,
  sourceTitle,
  banner,
  executionMode,
}: {
  session?: ConversationSessionSummary;
  locale: ComposerModelLocale;
  forkTitle: string;
  sourceTitle: (id: string) => string;
  banner?: { title: string; body: string };
  executionMode?: Live["executionMode"];
}) {
  const orchestration = session?.orchestration;
  const leadTitle = orchestration?.role === "worker" ? sourceTitle(orchestration.leadId) : null;
  return (
    <>
      {banner && (
        <aside className="info mx-auto mb-5 max-w-3xl" data-execution-mode={executionMode}>
          {banner.title && <strong className="mb-1 block">{banner.title}</strong>}
          {banner.body}
        </aside>
      )}
      {session?.forked_from_session_id && (
        <p className="mx-auto mb-4 w-full max-w-3xl text-xs text-muted-foreground">
          {catalogCopy[locale].fork} {forkTitle}
        </p>
      )}
      {orchestration && (
        <OrchestrationNote
          orchestration={orchestration}
          leadTitle={
            orchestration.role === "worker" && leadTitle !== orchestration.leadId ? leadTitle : null
          }
          locale={locale}
        />
      )}
      {session?.worktree && <WorktreeNote worktree={session.worktree} locale={locale} />}
    </>
  );
}
