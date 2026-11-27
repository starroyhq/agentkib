import { z } from "zod";
import type { ContextUsage } from "../../context-usage";
import type { ClaudeTranscriptObservation } from "./claude-context-usage";

const uuid = z.string().uuid();
const contextWindowAnchorSchema = z
  .object({
    usedTokens: z.number().int().min(0),
    updatedAt: z.string().datetime(),
    model: z.string().min(1).max(128).nullable(),
    afterCompaction: z.boolean(),
  })
  .strict();
export const contextWindowEntrySchema = z
  .object({
    bindingId: uuid,
    anchor: contextWindowAnchorSchema,
    window: z.number().int().positive(),
    reportedModel: z.string().min(1).max(128).nullable(),
  })
  .strict()
  .refine((entry) => entry.window >= entry.anchor.usedTokens)
  .refine((entry) =>
    entry.reportedModel === null
      ? entry.anchor.afterCompaction
      : entry.reportedModel === entry.anchor.model,
  );
// Keep optional display observations separate so older runtimes can read the binding registry.
export const contextWindowRegistrySchema = z
  .object({ version: z.literal(1), observations: z.array(contextWindowEntrySchema).max(64) })
  .strict();
export type ContextWindowEntry = z.infer<typeof contextWindowEntrySchema>;

export function transcriptWindowAnchor(observation?: ClaudeTranscriptObservation) {
  const usage = observation?.usage;
  if (!usage?.available || !usage.historical) return undefined;
  const parsed = contextWindowAnchorSchema.safeParse({
    usedTokens: usage.usedTokens,
    updatedAt: usage.updatedAt,
    model: observation?.model ?? null,
    afterCompaction: usage.reason === "claude-post-compaction-usage",
  });
  return parsed.success ? parsed.data : undefined;
}

export function withContextWindow(usage: ContextUsage, entry: ContextWindowEntry): ContextUsage {
  const { reason, ...saved } = usage;
  return {
    ...saved,
    contextWindow: entry.window,
    ...(entry.reportedModel === null
      ? { reason: "claude-post-compaction-current-window" }
      : reason && reason !== "model-context-window-unavailable"
        ? { reason }
        : {}),
  };
}
