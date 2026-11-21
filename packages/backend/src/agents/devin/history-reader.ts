import type {
  SessionHistoryContext,
  SessionHistoryProvider,
} from "../../sessions/history-provider";

export function createDevinHistoryReader({ devin }: SessionHistoryContext): SessionHistoryProvider {
  return {
    list: (workspace) => devin.list(workspace),
    events: ({ native, workspace, offset, count }) =>
      devin.events(native.native_ref, workspace, offset, count),
    image: ({ native, workspace, imageId }) => devin.image(native.native_ref, workspace, imageId),
    document: ({ native, workspace, summary, options }) =>
      devin.document(native.native_ref, workspace, { ...summary, agent: native.agent }, options),
    activitySubagents: ({ native, workspace }, sessionId) =>
      devin.activitySubagents(native.native_ref, workspace, sessionId),
    subagents: ({ native, workspace, sessionId, childId, cursor, limit }) =>
      childId
        ? devin.subagentEvents(native.native_ref, workspace, sessionId, childId, cursor, limit)
        : devin.subagents(native.native_ref, workspace, sessionId),
  };
}
