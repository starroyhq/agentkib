import { z } from "zod";
import type { RemoteCatalog } from "@/core/remote-types";
import type { ConversationEventPage } from "@/core/types";

const id = z.string().min(1).max(4096);
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined);
// Rust emits RFC 3339 timestamps. Reject malformed dates at the remote boundary
// before any view passes them to Intl.DateTimeFormat.
const optionalTimestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)))
  .nullish()
  .transform((value) => value ?? undefined);
const count = z.number().int().nonnegative();
const relationshipId = id.nullish().transform((value) => value ?? undefined);
const origin = z
  .string()
  .nullish()
  .transform((value) =>
    value === "interactive" || value === "auxiliary" || value === "execution" ? value : "unknown",
  );
// Checkout facts only group and label rows; an invalid value drops the fact, not the record.
const checkoutText = z.string().min(1).max(4096);
const checkoutStatus = z.enum(["present", "deleted", "unknown"]);
const checkout = z
  .object({
    repository_group_id: checkoutText,
    kind: z.enum(["primary", "worktree"]),
    primary_path: checkoutText.nullable(),
    name: checkoutText.nullable(),
    branch: checkoutText.nullable(),
    status: checkoutStatus,
  })
  .optional()
  .catch(undefined);
const worktree = z
  .object({
    repository_group_id: checkoutText.nullable(),
    name: checkoutText,
    path: checkoutText,
    branch: checkoutText.nullable(),
    status: checkoutStatus,
  })
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const catalog = z.object({
  workspaces: z
    .array(
      z.object({
        id,
        name: z.string(),
        path: z.string(),
        status: z.enum(["healthy", "attention"]).default("healthy"),
        asset_count: count.default(0),
        warning_count: count.default(0),
        last_active_at: optionalTimestamp,
        last_scanned_at: optionalTimestamp,
        checkout,
      }),
    )
    .max(20_000),
  sessions: z
    .array(
      z.object({
        id,
        workspace_id: id,
        agent: z.enum([
          "codex",
          "claude-code",
          "antigravity",
          "opencode",
          "open-claw",
          "hermes",
          "grok-build",
        ]),
        title: optionalText,
        created_at: optionalTimestamp,
        updated_at: optionalTimestamp,
        git_branch: optionalText,
        message_count: count.nullish(),
        archived: z.boolean(),
        sidechain: z.boolean(),
        origin,
        spawned_by_session_id: relationshipId,
        forked_from_session_id: relationshipId,
        availability: z.enum(["readable", "metadata-only"]),
        worktree,
      }),
    )
    .max(20_000),
});
const events = z.object({
  events: z
    .array(
      z.object({
        id,
        kind: z.enum(["user-message", "agent-message", "tool-summary"]),
        timestamp: optionalTimestamp,
        content: optionalText,
        turn_id: z
          .string()
          .trim()
          .min(1)
          .max(256)
          .nullish()
          .transform((value) => value ?? undefined),
        message_phase: z
          .unknown()
          .optional()
          .transform((value) =>
            value === "commentary" || value === "final_answer" ? value : undefined,
          ),
        tool_name: optionalText,
        tool_status: optionalText,
        duration_ms: z.number().nonnegative().nullish(),
        attachment_count: count,
        truncated: z.boolean(),
      }),
    )
    .max(100),
  next_cursor: optionalText,
  warnings: z.array(z.string()).max(1000),
});

// A paired host is authorized, not a trusted producer of renderer object shapes.
// Strip extra fields (including forged local provenance); never expose raw payload errors.
export function parseRemoteCatalog(input: unknown): RemoteCatalog {
  const result = catalog.safeParse(input);
  if (!result.success) throw new Error("REMOTE_INVALID_RESPONSE");
  const data = result.data;
  const workspaces = new Set(data.workspaces.map((item) => item.id));
  if (
    workspaces.size !== data.workspaces.length ||
    new Set(data.sessions.map((item) => item.id)).size !== data.sessions.length ||
    data.sessions.some((item) => !workspaces.has(item.workspace_id))
  )
    throw new Error("REMOTE_INVALID_RESPONSE");
  return {
    ...data,
    workspaces: data.workspaces.map((item) => ({ ...item, sources: [] })),
    sessions: data.sessions.map((item) => ({
      ...item,
      spawned_by_session_id:
        item.spawned_by_session_id === item.id ? undefined : item.spawned_by_session_id,
      forked_from_session_id:
        item.forked_from_session_id === item.id ? undefined : item.forked_from_session_id,
    })),
  };
}

export function parseRemoteEvents(input: unknown): ConversationEventPage {
  const result = events.safeParse(input);
  if (
    !result.success ||
    new Set(result.data.events.map((item) => item.id)).size !== result.data.events.length
  )
    throw new Error("REMOTE_INVALID_RESPONSE");
  return result.data;
}
