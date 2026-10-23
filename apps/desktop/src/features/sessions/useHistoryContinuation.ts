import { sessionCollection } from "@agentkib/runtime-protocol";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { useSessionViewStore } from "./session-view-store";
import { useSessionSourceCapability } from "./useSessionSourceCapability";

export function useHistoryContinuation(
  selected?: ConversationSessionSummary,
  workspace?: WorkspaceSummary,
  revision = 0,
) {
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
    useSessionViewStore.getState().requestHistoryContinuation({
      workspace,
      session: { ...selected, id: historyId },
    });
  };
  return { canContinue, continueSession, reasonKey };
}
