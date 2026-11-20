import {
  formatHistoryReferences,
  HISTORY_REFERENCE_BYTES,
  HISTORY_REFERENCE_LIMIT,
  type ResolvedHistoryReference,
  type HistoryReference,
} from "@agentkib/web-client";
import { isValidMessage } from "@agentkib/conversation-state";
export const historyReferenceKey = (reference: HistoryReference) => JSON.stringify(reference);
export function historyMessageText(
  message: string,
  references: readonly ResolvedHistoryReference[],
): string {
  return [message.trim(), formatHistoryReferences(references)].filter(Boolean).join("\n\n");
}
export function referencesWithinBudget(references: readonly ResolvedHistoryReference[]): boolean {
  return (
    references.length <= HISTORY_REFERENCE_LIMIT &&
    new TextEncoder().encode(references.map((item) => item.content).join("")).byteLength <=
      HISTORY_REFERENCE_BYTES
  );
}
export function validHistoryMessage(
  message: string,
  references: readonly ResolvedHistoryReference[],
  attachments = false,
): boolean {
  return (
    referencesWithinBudget(references) &&
    isValidMessage(historyMessageText(message, references), attachments)
  );
}
