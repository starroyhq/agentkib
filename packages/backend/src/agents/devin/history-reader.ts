import type {
  SessionHistoryContext,
  SessionHistoryProvider,
} from "../../sessions/history-provider";

export function createDevinHistoryReader({
  devin,
  nativeHistory,
}: SessionHistoryContext): SessionHistoryProvider {
  const filename = devin.database();
  if (nativeHistory) {
    return {
      list: (workspace) => nativeHistory.read("devin-list", [filename, workspace]),
      events: ({ native, workspace, offset, count }) =>
        nativeHistory.read("devin-events", [filename, native.native_ref, workspace, offset, count]),
      image: ({ native, workspace, imageId }) =>
        nativeHistory.read("devin-image", [filename, native.native_ref, workspace, imageId]),
      document: ({ native, workspace, summary, options }) =>
        nativeHistory.read("devin-document", [
          filename,
          native.native_ref,
          workspace,
          { ...summary, agent: native.agent },
          options,
        ]),
      activitySubagents: ({ native, workspace }, sessionId) =>
        nativeHistory.read("devin-activitySubagents", [
          filename,
          native.native_ref,
          workspace,
          sessionId,
        ]),
      subagents: ({ native, workspace, sessionId, childId, cursor, limit }) =>
        childId
          ? nativeHistory.read("devin-subagentEvents", [
              filename,
              native.native_ref,
              workspace,
              sessionId,
              childId,
              cursor,
              limit,
            ])
          : nativeHistory.read("devin-subagents", [
              filename,
              native.native_ref,
              workspace,
              sessionId,
            ]),
    };
  }
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
