import { REMOTE_ERROR_CONTRACT, type RuntimeRpcError } from "@agentkib/runtime-protocol";
import { z } from "zod";
import { TaskAdmissionError } from "./task-executor";

export interface RpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: RuntimeRpcError;
}

export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export function rpcFailure(id: unknown, error: unknown) {
  const fault =
    error instanceof RpcFault
      ? error
      : new RpcFault(
          REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode,
          "AgentKib command failed",
          {
            detail: error instanceof Error ? error.message : "Backend operation failed",
            ...(error instanceof TaskAdmissionError && { stage: "not-dispatched" }),
          },
        );
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code: fault.code,
      message: fault.message,
      ...(fault.data === undefined ? {} : { data: fault.data }),
    },
  };
}

export function parameters<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new RpcFault(
      REMOTE_ERROR_CONTRACT.rpcInvalidParams.ipc.rpcCode,
      "Invalid method parameters",
      { detail: parsed.error.message },
    );
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
  "devin",
] as const;
export const agentSchema = z.enum(AGENTS);
