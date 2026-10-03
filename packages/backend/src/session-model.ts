import { z } from "zod";
import { agentSchema, unsigned, optionalString } from "./rpc";
import { timestamp } from "./timestamps";
export const dateTime = z
  .string()
  .refine((value) => timestamp(value) !== null, "Invalid UTC timestamp");
const optionalTime = dateTime.nullable().optional();
export const sessionRole = z.enum(["user", "assistant", "tool"]);
export const sessionBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    call_id: z.string(),
    name: z.string(),
    input: z.string(),
  }),
  z.object({
    type: z.literal("tool-result"),
    call_id: z.string(),
    output: z.string(),
    is_error: z.boolean(),
  }),
  z.object({
    type: z.literal("attachment"),
    kind: z.enum(["image", "document"]).default("image"),
    media_type: z.string(),
    filename: optionalString,
    inline_base64: optionalString,
  }),
]);
export const sessionTurn = z.object({
  id: z.string(),
  role: sessionRole,
  timestamp: optionalTime,
  blocks: z.array(sessionBlock),
});
export const sessionLoss = z.object({
  code: z.enum([
    "damaged-record",
    "orphan-tool-result",
    "unsupported-attachment",
    "external-attachment",
    "reasoning-excluded",
    "source-content-truncated",
    "target-tool-summary",
    "target-attachment-omitted",
  ]),
  count: unsigned,
});
export const sessionDocument = z.object({
  schema_version: unsigned.max(4294967295),
  source: z.object({
    agent: agentSchema,
    workspace_id: z.string(),
    title: optionalString,
    created_at: optionalTime,
    updated_at: optionalTime,
    git_branch: optionalString,
  }),
  turns: z.array(sessionTurn),
  losses: z.array(sessionLoss),
  redaction_count: unsigned,
});
export const archiveManifest = z.object({
  schema_version: unsigned.max(4294967295),
  archive_id: z.string(),
  workspace_id: z.string(),
  source_fingerprint: z.string(),
  document_sha256: z.string(),
  chunks_sha256: z.string(),
  chunk_count: unsigned,
  created_at: dateTime,
});
export const archiveChunk = z.object({
  chunk_id: z.string(),
  block_id: z.string().default(""),
  turn_id: z.string(),
  role: sessionRole,
  timestamp: optionalTime,
  block_type: z.string(),
  part: unsigned,
  parts: unsigned,
  content: z.string(),
});
export type SessionDocument = z.infer<typeof sessionDocument>;
