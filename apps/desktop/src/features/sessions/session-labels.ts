import type { ConversationSessionSummary } from "@/core/types";
import { tr as defaultTranslate } from "@/core/i18n";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { AGENT_LABELS } from "@/core/agents";

export const sessionAgentNames = AGENT_LABELS;

export function sessionRecordLabel(session: ConversationSessionSummary, tr = defaultTranslate) {
  return [
    tr(
      session.availability === "metadata-only"
        ? "conversations.filter.metadata"
        : "sessions.readable",
    ),
    session.archived ? tr("conversations.filter.archived") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export type SessionSourceKind = "spawned" | "forked";

export interface SessionSourceDetail {
  kind: SessionSourceKind;
  id: string;
  session?: ConversationSessionSummary;
  label: string;
}

export function sessionSourceDetails(
  session: ConversationSessionSummary,
  sessions: ConversationSessionSummary[],
  tr = defaultTranslate,
  formatDateTime: (value: string | Date) => string = (value) => new Date(value).toLocaleString(),
): SessionSourceDetail[] {
  const relations: Array<{ kind: SessionSourceKind; id?: string }> = [
    { kind: "spawned", id: session.spawned_by_session_id },
    { kind: "forked", id: session.forked_from_session_id },
  ];
  return relations.flatMap(({ kind, id }) => {
    if (!id) return [];
    const source = sessions.find((candidate) => candidate.id === id);
    const sourceTitle = source ? displaySessionTitle(source.title, tr) : id;
    const sourceDate =
      session.created_at ?? session.updated_at ?? source?.created_at ?? source?.updated_at;
    return [
      {
        kind,
        id,
        session: source,
        label: tr(
          kind === "spawned" ? "conversations.spawnedByDetail" : "conversations.forkedFromDetail",
          {
            source: sourceTitle,
            date: sourceDate ? formatDateTime(sourceDate) : tr("conversations.unknownTime"),
          },
        ),
      },
    ];
  });
}

export function sessionSourceLabel(
  session: ConversationSessionSummary,
  sessions: ConversationSessionSummary[],
  tr = defaultTranslate,
  formatDateTime: (value: string | Date) => string = (value) => new Date(value).toLocaleString(),
) {
  const details = sessionSourceDetails(session, sessions, tr, formatDateTime);
  if (!details.length) return session.origin === "auxiliary" ? tr("conversations.auxiliary") : "";
  return details.map(({ label }) => label).join(" · ");
}

export function isInteractiveFork(session: ConversationSessionSummary) {
  return session.origin === "interactive" && Boolean(session.forked_from_session_id);
}
