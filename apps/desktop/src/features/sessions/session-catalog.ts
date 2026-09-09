import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { filterSessions as sharedFilterSessions } from "@agentkib/session-catalog";
export {
  isAuxiliarySession,
  isSessionVisible,
  sortSessions,
  groupSessions,
} from "@agentkib/session-catalog";
import { tr } from "@/core/i18n";

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

export interface SessionCatalogFilter {
  query: string;
  agent: AgentKind | "all";
  filter: SessionRecordFilter;
  /** Auxiliary records are opt-in; unknown/missing origins remain visible. */
  showAuxiliary?: boolean;
}

export function filterSessions(
  sessions: ConversationSessionSummary[],
  workspaces: WorkspaceSummary[],
  filters: SessionCatalogFilter,
  translate = tr,
) {
  return sharedFilterSessions(sessions, workspaces, filters, translate("conversations.untitled"));
}

export function sessionCatalogStats(sessions: ConversationSessionSummary[]) {
  return {
    total: sessions.length,
    readable: sessions.filter((session) => session.availability === "readable").length,
    archived: sessions.filter((session) => session.archived).length,
    metadata: sessions.filter((session) => session.availability === "metadata-only").length,
  };
}
