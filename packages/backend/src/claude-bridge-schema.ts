import { z } from "zod";
import {
  CLAUDE_BRIDGE_PLUGIN_VERSION,
  claudeBridgeCompatibility,
  missingClaudeBridgeCapabilities,
} from "@agentkib/runtime-protocol";

const id = z.string().uuid();
const revision = z.number().safe().int().nonnegative();
const text = z.string().max(128 * 1024);
const cwd = z.string().min(1).max(4096);
export const bridgeIdentitySchema = z.object({
  protocol: z.literal(1),
  nativeId: id,
  cwd,
  cliVersion: z
    .string()
    .max(64)
    .refine((version) => ["verified", "unverified"].includes(claudeBridgeCompatibility(version))),
  pluginVersion: z.literal(CLAUDE_BRIDGE_PLUGIN_VERSION),
  nativeCapabilities: z
    .object({ version: z.literal(1), available: z.array(z.string().min(1).max(64)).max(32) })
    .strict()
    .refine((report) => missingClaudeBridgeCapabilities(report).length === 0),
  instanceId: id,
});
export const bridgeLeaseSchema = z.object({
  bindingId: id,
  leaseId: id,
  nativeId: id,
  cwd,
  instanceId: id,
});
export const bridgeToolSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    input: text,
    output: text.optional(),
    status: z.enum(["running", "completed", "failed"]),
  })
  .strict();
export const bridgeOutboxItemSchema = z
  .object({
    id,
    kind: z.enum(["steer", "queue"]),
    text: z.string().max(8 * 1024),
    status: z.enum(["pending", "dispatching", "unknown"]),
    createdAt: z.number().int().min(0).max(8_640_000_000_000_000),
  })
  .strict();
export const bridgeSnapshotSchema = bridgeIdentitySchema
  .extend({
    revision,
    currentTurnId: id.nullable(),
    status: z.enum(["idle", "running", "waiting", "disconnected"]),
    waiting: z.enum(["permission", "question", "unknown"]).nullable(),
    messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text }).strict()).max(4096),
    toolItems: z.array(bridgeToolSchema).max(256),
    streamText: text,
    usage: z
      .object({
        tokens: revision.nullable(),
        window: revision.nullable(),
        percent: z.number().min(0).max(100).nullable(),
        observedAt: z.number().int().min(0).max(8_640_000_000_000_000),
      })
      .strict()
      .nullable(),
    outbox: z.array(bridgeOutboxItemSchema).max(32),
    capabilities: z
      .object({
        read: z.boolean(),
        send: z.boolean(),
        steer: z.boolean(),
        queue: z.boolean(),
        stop: z.boolean(),
        approve: z.literal(false),
        answer: z.literal(false),
      })
      .strict(),
  })
  .strict();
export const bridgeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gap"), revision }).strict(),
  z.object({ type: z.literal("snapshot"), snapshot: bridgeSnapshotSchema }).strict(),
  z.object({ type: z.literal("turn-start"), turnId: id, revision }).strict(),
  z.object({ type: z.literal("text"), turnId: id, text, revision }).strict(),
  z
    .object({ type: z.literal("turn-complete"), turnId: id, text, aborted: z.boolean(), revision })
    .strict(),
  z
    .object({ type: z.enum(["tool-start", "tool-complete"]), tool: bridgeToolSchema, revision })
    .strict(),
  z.object({ type: z.literal("invalidated"), reason: z.string().max(256), revision }).strict(),
]);
export const bridgeEventsSchema = bridgeLeaseSchema
  .extend({
    events: z.array(z.object({ seq: revision, event: bridgeEventSchema }).strict()).max(512),
  })
  .strict();
export const bridgePollSchema = bridgeLeaseSchema
  .extend({
    afterCommandId: id.nullable(),
    waitMs: z.number().int().min(0).max(20_000),
  })
  .strict();
export const bridgeResultSchema = bridgeLeaseSchema
  .extend({
    commandId: id,
    status: z.enum(["accepted", "rejected", "unknown"]),
    reason: z.string().max(256).optional(),
    revision,
    turnId: id.optional(),
  })
  .strict();
