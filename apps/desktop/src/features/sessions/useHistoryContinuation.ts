import { useNavigate } from "@tanstack/react-router";
import { sessionCollection } from "@agentkib/runtime-protocol";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { useSessionSourceCapability } from "./useSessionSourceCapability";

export function useHistoryContinuation(
  selected?: ConversationSessionSummary,
  workspace?: WorkspaceSummary,
  revision = 0,
) {
  const navigate = useNavigate();
  const historyId = selected?.indexedSessionIds ? selected.indexedSessionIds[0] : selected?.id;
  const blockedReason = !selected
    ? undefined
    : selected.remote
      ? "sessions.continuation.remote"
      : selected.availability !== "readable"
        ? "sessions.continuation.metadata"
        : !historyId
          ? "sessions.continuation.unindexed"
          : !workspace
            ? "sessions.continuation.noWorkspace"
            : sessionCollection(workspace.id)
              ? "sessions.continuation.collection"
              : undefined;
  const capability = useSessionSourceCapability(
    selected && !blockedReason ? historyId : undefined,
    revision,
  );
  const canContinue = !!selected && !blockedReason && canContinueFromHistory(capability);
  const reasonKey =
    blockedReason ??
    (canContinue
      ? undefined
      : !capability
        ? "sessions.continuation.checking"
        : capability.status === "unsupported"
          ? "sessions.continuation.unsupported"
          : "sessions.continuation.unavailable");

  const continueSession = () => {
    if (!canContinue || !workspace || !historyId) return;
    void navigate({
      to: "/workspace/$workspaceId/sessions",
      params: { workspaceId: workspace.id },
      search: { handoffSession: historyId },
    });
  };
  return { canContinue, continueSession, reasonKey };
}
