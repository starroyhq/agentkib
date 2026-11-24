import { createHash } from "node:crypto";
import { displaySessionTitle, homeTaskGroups, isSessionVisible } from "@agentkib/session-catalog";
import type {
  ConversationCatalog,
  ConversationSessionSummary,
  ConversationTaskEntry,
  ConversationTaskSummary,
} from "@agentkib/web-client";
import { buildTaskSummaryCoverage } from "./task-summary-coverage";

function taskGroup(
  rows: readonly {
    session: ConversationSessionSummary;
    place?: ConversationTaskEntry["place"];
    startedAt?: string;
    outcome?: ConversationTaskEntry["outcome"];
  }[],
) {
  const entries = rows.map(({ session, place, startedAt, outcome }): ConversationTaskEntry => {
    const time =
      (outcome ? session.readState?.latestResult?.completedAt : startedAt) ??
      session.updated_at ??
      session.created_at ??
      null;
    return {
      sessionId: session.id,
      agent: session.agent,
      workspaceId: session.workspace_id,
      time,
      summary: displaySessionTitle(session.title, "").replace(/\s+/g, " ").slice(0, 160),
      ...(place ? { place } : {}),
      ...(outcome ? { outcome } : {}),
    };
  });
  return {
    count: entries.length,
    // Sort terminal rows by the result's time, even after a rename updates the catalog.
    entries: entries.sort(
      (left, right) =>
        (Date.parse(right.time ?? "") || 0) - (Date.parse(left.time ?? "") || 0) ||
        (left.sessionId < right.sessionId ? -1 : Number(left.sessionId > right.sessionId)),
    ),
  };
}

export function projectTaskSummary(
  source: unknown,
  authorizedWorkspaces: readonly string[],
  allWorkspaces: boolean,
  scope: string,
): ConversationTaskSummary | undefined {
  const catalog = source as ConversationCatalog | null | undefined;
  if (!Array.isArray(catalog?.sessions)) return;
  const workspaces = new Set(authorizedWorkspaces);
  const sessions = catalog.sessions.filter(
    (session) =>
      session &&
      typeof session.id === "string" &&
      typeof session.agent === "string" &&
      workspaces.has(session.workspace_id) &&
      !session.archived &&
      !session.sidechain &&
      isSessionVisible(session),
  );
  const tasks = homeTaskGroups(sessions);
  const groups = {
    pendingApproval: taskGroup(tasks.pendingApproval),
    pendingAnswer: taskGroup(tasks.pendingAnswer),
    running: taskGroup(tasks.running),
    needsReview: taskGroup(tasks.needsReview),
    failed: taskGroup(tasks.failed),
    completed: taskGroup(tasks.completed),
  };
  const coverage = buildTaskSummaryCoverage(source, workspaces, sessions, allWorkspaces);
  const version = createHash("sha256")
    .update(scope)
    .update(JSON.stringify([groups, coverage]));
  return { version: version.digest("base64url"), groups, coverage };
}
