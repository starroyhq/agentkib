import {
  isConversationReadStateMark,
  REMOTE_READ_STATE_UPDATE_CONTRACT,
  type ConversationReadStateMark,
} from "@agentkib/runtime-protocol";

export function isReadStateUpdateBody(body: Record<string, unknown>): body is Record<
  string,
  unknown
> & {
  seenResultId: string | null;
  mark?: ConversationReadStateMark;
} {
  return (
    Object.keys(body).every((key) =>
      Object.hasOwn(REMOTE_READ_STATE_UPDATE_CONTRACT.properties, key),
    ) &&
    (body.seenResultId === null || typeof body.seenResultId === "string") &&
    (body.mark === undefined || isConversationReadStateMark(body.mark))
  );
}
