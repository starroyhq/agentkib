import type { ComponentType, ReactNode } from "react";
import type { Approval, ConversationEvent, UserQuestionRequest } from "@agentkib/web-client";
import { ToolDetailBody } from "./tool-details";
import { toolStatusLabel } from "./tool-status";

export function SessionDetailDialogs({
  modal,
  locale,
  labels,
  onClose,
  preferences,
  metadata,
  Dialog,
}: {
  modal?: "preferences" | "metadata" | ConversationEvent | Approval | UserQuestionRequest;
  locale: string;
  labels: {
    close: string;
    tool: string;
    unknownTool: string;
    toolSummaryUnavailable: string;
    truncated: string;
  };
  onClose: () => void;
  preferences: ReactNode;
  metadata: ReactNode;
  Dialog: ComponentType<{
    title: string;
    closeLabel: string;
    onClose: () => void;
    children: ReactNode;
  }>;
}) {
  if (modal === "preferences") return preferences;
  if (modal === "metadata") return metadata;
  // Approvals and questions remain in the interaction dock above the composer.
  if (!modal || !("kind" in modal)) return null;
  return (
    <Dialog closeLabel={labels.close} title={labels.tool} onClose={onClose}>
      <h3>{modal.tool_name || labels.unknownTool}</h3>
      <p>{toolStatusLabel(modal.tool_status, locale)}</p>
      {modal.timestamp && <time>{new Date(modal.timestamp).toLocaleString(locale)}</time>}
      {modal.tool ? (
        <ToolDetailBody tool={modal.tool} locale={locale} />
      ) : (
        <pre>{modal.content?.trim() ? modal.content : labels.toolSummaryUnavailable}</pre>
      )}
      {modal.truncated && <p>{labels.truncated}</p>}
    </Dialog>
  );
}
