import { z } from "zod";
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export function parameters<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new RpcFault(-32602, "Invalid method parameters", { detail: parsed.error.message });
  return parsed.data;
}
export const optionalString = z.string().nullable().optional();
export const unsigned = z.number().int().nonnegative();
export const AGENTS = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
] as const;
export const agentSchema = z.enum(AGENTS);
