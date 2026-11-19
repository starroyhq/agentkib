import { SessionTranscript } from "@agentkib/session-ui";
import type { ConversationEvent } from "@/core/types";
import { useI18n } from "@/core/useI18n";

export interface ConversationTranscriptProps {
  events: ConversationEvent[];
  sessionKey: string;
  incomplete?: boolean;
  hasEarlier?: boolean;
  historyDetailTurnId?: string;
  loadingEarlier?: boolean;
  loadEarlier?: (turnId?: string) => void;
}

export function ConversationTranscript({
  events,
  sessionKey,
  incomplete,
  hasEarlier,
  historyDetailTurnId,
  loadingEarlier,
  loadEarlier,
}: ConversationTranscriptProps) {
  const { tr, locale } = useI18n();
  return (
    <SessionTranscript
      key={sessionKey}
      events={events}
      locale={locale}
      incomplete={incomplete}
      hasEarlier={hasEarlier}
      historyDetailTurnId={historyDetailTurnId}
      loadingEarlier={loadingEarlier}
      earlierLabel={tr(loadingEarlier ? "sessions.loadingHistory" : "sessions.loadEarlier")}
      onLoadEarlier={loadEarlier}
      labels={{
        process: tr("sessions.process"),
        tools: tr("conversation.tools"),
        failed: tr("conversation.failed"),
        attachments: tr("conversation.attachments"),
        truncated: tr("conversations.contentTruncated"),
        unknownTool: tr("conversations.tool"),
        partialTurn: tr("sessions.partialTurn"),
        timestamp: tr("sessions.recordTime"),
      }}
    />
  );
}
