import type {
  ConversationSessionSummary,
  SessionOrchestration,
  SessionWorktree,
} from "@/core/types";
import { tr as defaultTranslate } from "@/core/i18n";
import { isSessionVisible } from "./session-catalog";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { AGENT_LABELS } from "@/core/agents";
import { sessionTurnStatus } from "@agentkib/session-ui";
import type { Live } from "@agentkib/web-client";

export const sessionAgentNames = AGENT_LABELS;

/** Use only the selected session's verified live activity in the directory. */
export function sessionWithObservedActivity(
  session: ConversationSessionSummary,
  live: Live,
): ConversationSessionSummary {
  if (live.sessionId !== session.id || session.remote || session.availability !== "readable")
    return session;
  const turn = sessionTurnStatus(session.id, live, session.externalTurn);
  const externalTurn =
    turn?.kind === "running" && (live.status === "idle" || live.status === "unsupported")
      ? session.externalTurn
      : undefined;
  let status = live.status;
  if (turn && !externalTurn && status !== "outcome-unknown") {
    if (turn.kind === "waiting") status = "waiting-input";
    else status = turn.kind === "compacting" || turn.kind === "cancelling" ? "running" : turn.kind;
  }
  return {
    ...session,
    externalTurn,
    continuation: {
      status,
      executionLocation: live.executionLocation,
      ownershipReason: live.ownershipReason,
      reason: live.reason,
      backgroundTasks: live.backgroundTasks?.length,
    },
  };
}

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
    const source = sessions.find((candidate) => candidate.id === id && isSessionVisible(candidate));
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

/** The list's Project Agent and Worker marks; a Worker names the Project Agent it works for. */
export function orchestrationLabel(
  orchestration: SessionOrchestration,
  sessions: ConversationSessionSummary[],
  tr = defaultTranslate,
) {
  if (orchestration.role === "lead")
    return tr(orchestration.paused ? "sessions.projectAgentPaused" : "sessions.projectAgent");
  const lead = sessions.find((candidate) => candidate.id === orchestration.leadId);
  return tr("sessions.workerOf", {
    name: orchestration.name,
    lead: lead ? displaySessionTitle(lead.title, tr) : tr("sessions.projectAgent"),
  });
}

export function isInteractiveFork(session: ConversationSessionSummary) {
  return session.origin === "interactive" && Boolean(session.forked_from_session_id);
}

/** The session page's worktree chip: "工作树 <名称> · <分支>", or its status once the folder is gone. */
export function worktreeChip(worktree: SessionWorktree, tr = defaultTranslate) {
  const name = worktree.name;
  if (worktree.status === "deleted") return tr("sessions.worktree.chipDeleted", { name });
  if (worktree.status === "unknown") return tr("sessions.worktree.chipUnknown", { name });
  return worktree.branch
    ? tr("sessions.worktree.chip", { name, branch: worktree.branch })
    : tr("sessions.worktree.chipNoBranch", { name });
}

/** The worktree mark's hover text and accessible name; status is spelled out, not colored. */
export function worktreeLabel(worktree: SessionWorktree, tr = defaultTranslate) {
  const { name, branch, path, status } = worktree;
  if (status === "deleted") return tr("sessions.worktree.deleted", { name, path });
  if (status === "unknown") return tr("sessions.worktree.unknown", { name, path });
  return branch
    ? tr("sessions.worktree.present", { name, branch, path })
    : tr("sessions.worktree.presentNoBranch", { name, path });
}
