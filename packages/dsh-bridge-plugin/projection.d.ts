/** One image DSH stored for a message. `attachmentId` is `sha256:` and the digest of its bytes. */
export interface DshBridgeImage {
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string | null;
}

/** Displayable history records; everything else in the DSH log stays in DSH. */
export type DshBridgeHistoryRecord = { seq: number; time: number | null } & (
  | { kind: "turn-start"; turn: number }
  | { kind: "turn-end"; turn: number; reason: string | null }
  | {
      kind: "user";
      id: string | null;
      text: string;
      truncated: boolean;
      images: DshBridgeImage[];
      files: number;
      rpcId: string | null;
    }
  | { kind: "assistant"; turn: number; text: string; truncated: boolean; interrupted: boolean }
  | { kind: "tool-call"; turn: number; callId: string; name: string }
  | {
      kind: "tool-result";
      turn: number;
      callId: string;
      isError: boolean;
      preview: string;
      truncated: boolean;
    }
  /** A slash command DSH ran itself, and its answer; `args` is what followed the name. */
  | { kind: "command"; commandId: string; name: string; args: string | null }
  | { kind: "command-result"; commandId: string; ok: boolean; text: string | null }
);

export function historyRecord(event: unknown): DshBridgeHistoryRecord | null;
