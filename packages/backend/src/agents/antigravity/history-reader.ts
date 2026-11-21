import type {
  SessionHistoryContext,
  SessionHistoryProvider,
} from "../../sessions/history-provider";

export function createAntigravityHistoryReader({
  antigravity,
}: SessionHistoryContext): SessionHistoryProvider {
  return {
    list: (workspace) => antigravity.list(workspace),
    events: ({ native, workspace, offset, count }) =>
      antigravity.readEvents(native.native_ref, offset, count, workspace),
    document: ({ native, summary }) =>
      antigravity.readDocument(native.native_ref, { ...summary, agent: native.agent }),
  };
}
