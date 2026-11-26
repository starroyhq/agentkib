import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { handoffActive, handoffCheckpoint } from "../../handoff-work";
import type {
  SessionHistoryContext,
  SessionHistoryProvider,
} from "../../sessions/history-provider";

export function createDshHistoryReader({
  dsh,
  resolveSession,
  store,
}: SessionHistoryContext): SessionHistoryProvider {
  return {
    // Workers without a bridge list nothing rather than a stale or partial set.
    list: (workspace) => (dsh ? dsh.list(workspace) : { sessions: [], incomplete: false }),
    events: ({ native, offset, count }) => {
      if (!dsh) throw new Error("Conversation provider is unavailable");
      return dsh.events(native.native_ref, offset, count);
    },
    image: ({ native, imageId }) => {
      if (!dsh) throw new Error(REMOTE_ERROR_CODES.sessionImageUnavailable);
      return dsh.image(native.native_ref, imageId);
    },
    async hostDocument(sessionId, summary, options) {
      if (!dsh) throw new Error("Conversation provider is unavailable");
      const { native } = await resolveSession(sessionId);
      const document = await dsh.document(
        native.native_ref,
        {
          agent: "deepseek-harness",
          workspace_id: summary.workspace_id,
          title: summary.title,
          created_at: summary.created_at,
          updated_at: summary.updated_at,
          git_branch: summary.git_branch,
        },
        options,
      );
      if (handoffActive()) {
        handoffCheckpoint();
        if (JSON.stringify(store.get(sessionId)) !== JSON.stringify(summary))
          throw new Error("Conversation ownership changed while reading history");
      }
      return document;
    },
  };
}
