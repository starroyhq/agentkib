import { z } from "zod";
import {
  claudeBridgeCompatibility,
  claudeBridgePluginCompatibility,
  missingClaudeBridgeCapabilities,
} from "@agentkib/runtime-protocol";
import { safeTerminalSubagentTitle } from "../../../../claude-bridge-plugin/hooks/terminal-subagents.js";
import { sanitizeHandoffExport, sanitizeSessionText } from "../../session-handoff";

// What the terminal plugin sends. A plugin of another AgentKib release connects too, so a field
// this Runtime does not know is dropped rather than failing the message; values it reads stay exact.
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
  pluginVersion: z
    .string()
    .max(64)
    .refine((version) => claudeBridgePluginCompatibility(version) === "supported"),
  nativeCapabilities: z
    .object({ version: z.literal(1), available: z.array(z.string().min(1).max(64)).max(32) })
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
export const bridgeToolSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  input: text,
  output: text.optional(),
  status: z.enum(["running", "completed", "failed"]),
});
export const bridgeOutboxItemSchema = z.object({
  id,
  kind: z.enum(["steer", "queue"]),
  text: z.string().max(8 * 1024),
  status: z.enum(["pending", "dispatching", "unknown"]),
  createdAt: z.number().int().min(0).max(8_640_000_000_000_000),
});
export const bridgeSnapshotSchema = bridgeIdentitySchema.extend({
  revision,
  currentTurnId: id.nullable(),
  status: z.enum(["idle", "running", "waiting", "disconnected"]),
  waiting: z.enum(["permission", "question", "unknown"]).nullable(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text })).max(4096),
  toolItems: z.array(bridgeToolSchema).max(256),
  streamText: text,
  model: z.string().min(1).max(128).nullable().optional(),
  terminalModelAtExit: z.literal(true).optional(),
  modelPickerOpen: z.boolean().optional(),
  compacting: z.boolean().optional(),
  compactStartedAt: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
  terminalSubagents: z
    .array(
      z.object({
        id,
        title: z.string().max(120).transform(safeTerminalSubagentTitle),
        status: z.enum(["starting", "running", "completed", "failed", "stopped", "unknown"]),
      }),
    )
    .max(16)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length)
    .optional(),
  terminalWorkerActivity: z
    .object({
      revision,
      commands: z
        .array(
          z.object({ id, startedAt: z.number().int().nonnegative().max(8_640_000_000_000_000) }),
        )
        .max(64),
    })
    .optional(),
  pendingApprovalDetails: z
    .object({
      toolUseId: z.string().min(1).max(256),
      turnId: id,
      toolName: z.string().min(1).max(256),
      input: z.record(z.string(), z.unknown()),
    })
    .refine(({ input }) => Buffer.byteLength(JSON.stringify(input)) <= 16 * 1024)
    .optional()
    .catch(undefined)
    .transform((details) => {
      if (!details) return;
      try {
        const input = JSON.parse(
          sanitizeHandoffExport(JSON.stringify(details.input), "json"),
        ) as Record<string, unknown>;
        return {
          ...details,
          toolName: sanitizeSessionText(details.toolName, { value: 0 }),
          input,
        };
      } catch {
        // A malformed optional preview must not interrupt the native permission prompt.
      }
    }),
  pendingQuestionSummary: z
    .string()
    .max(256)
    .optional()
    .catch(undefined)
    .transform((value) => value && sanitizeSessionText(value, { value: 0 })),
  usage: z
    .object({
      tokens: revision.nullable(),
      window: revision.nullable(),
      percent: z.number().min(0).max(100).nullable(),
      observedAt: z.number().int().min(0).max(8_640_000_000_000_000),
    })
    .nullable(),
  outbox: z.array(bridgeOutboxItemSchema).max(32),
  capabilities: z.object({
    read: z.boolean(),
    send: z.boolean(),
    steer: z.boolean(),
    queue: z.boolean(),
    stop: z.boolean(),
    modelPicker: z.boolean().optional(),
    attachments: z.literal(true).optional(),
    handover: z.literal(true).optional(),
    approve: z.literal(false),
    answer: z.literal(false),
  }),
});
export const bridgeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gap"), revision }),
  z.object({ type: z.literal("snapshot"), snapshot: bridgeSnapshotSchema }),
  z.object({
    type: z.literal("turn-start"),
    turnId: id,
    revision,
    /** Feature `lead-tools`: who started the turn; absent from plugins without it. */
    origin: z.enum(["terminal", "agentkib"]).optional(),
  }),
  z.object({ type: z.literal("text"), turnId: id, text, revision }),
  z.object({
    type: z.literal("turn-complete"),
    turnId: id,
    text,
    aborted: z.boolean(),
    revision,
    occurredAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
    startedAt: z.number().int().positive().max(8_640_000_000_000_000).optional(),
  }),
  z.object({
    type: z.enum(["tool-start", "tool-complete"]),
    turnId: id.optional(),
    tool: bridgeToolSchema,
    revision,
  }),
  z.object({ type: z.literal("invalidated"), reason: z.string().max(256), revision }),
]);
export const bridgeEventsSchema = bridgeLeaseSchema.extend({
  events: z.array(z.object({ seq: revision, event: bridgeEventSchema })).max(512),
});
export const bridgePollSchema = bridgeLeaseSchema.extend({
  afterCommandId: id.nullable(),
  waitMs: z.number().int().min(0).max(20_000),
  /** Feature `lead-tools`: whether this plugin can add a Project Agent's tools now. */
  leadTools: z.boolean().optional(),
  leadWorkerSettings: z.literal(true).optional(),
  /** Feature `lead-rate-limit-pause`: the terminal is holding Project Agent reports. */
  leadReportsPaused: z.boolean().optional(),
  /** Feature `lead-tools`: reports it has put in its outbox since the last poll. */
  takenReports: z.array(id).max(32).optional(),
  /** Feature `lead-report-acks`: IDs with confirmed native submission. Empty enables the mode. */
  reportAckIds: z.array(id).max(32).optional(),
  /** Native message evidence for confirmed reports in the same poll. */
  reportAckMessages: z
    .array(z.object({ reportId: id, messageId: id }))
    .max(32)
    .optional(),
});
/** A Project Agent's tool call from its terminal (feature `lead-tools`). */
export const bridgeLeadCallSchema = bridgeLeaseSchema.extend({
  name: z.string().regex(/^worker_[a-z]{1,32}$/),
  input: z.record(z.string(), z.unknown()),
});
export const bridgeResultSchema = bridgeLeaseSchema.extend({
  commandId: id,
  status: z.enum(["accepted", "rejected", "unknown", "exit-initiated"]),
  reason: z.string().max(256).optional(),
  revision,
  turnId: id.optional(),
});
