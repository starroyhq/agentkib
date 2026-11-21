import type { LiveSessionAgent } from "@agentkib/runtime-protocol";
import { z } from "zod";
import { validateAntigravityControl } from "./antigravity";
import { validateClaudeControl } from "./claude-code";
import { validateCodexControl } from "./codex";
import { validateDeepSeekHarnessControl } from "./deepseek-harness";
import { validateDevinControl } from "./devin";
import { ControlValidationError } from "./error";
import type {
  HostControlValidationCall,
  HostControlValidationResult,
  ProviderControlValidator,
} from "./types";

export type {
  HostControlValidationCall,
  HostControlValidationResult,
  ProviderValidation,
} from "./types";
export { serialQueueMode as isSerialQueueMode, serialQueueRequiresSend } from "./serial-queue";

export const hostControlValidationSchema = z.strictObject({
  sessionId: z.string().min(1).max(256),
  request: z.strictObject({
    operation: z.string().min(1).max(64),
    legacyCodex: z.boolean(),
    settings: z
      .strictObject({
        body: z.record(z.string(), z.unknown()),
        state: z.unknown(),
      })
      .optional(),
  }),
  executionMode: z.string().max(64).optional(),
  verified: z.partialRecord(
    z.enum(["codex", "claude-code", "deepseek-harness", "devin", "antigravity"]),
    z.boolean(),
  ),
  fullAccess: z.boolean(),
});

const agentByMode = new Map<string, LiveSessionAgent>([
  ["codex-managed", "codex"],
  ["codex-follower", "codex"],
  ["claude-managed", "claude-code"],
  ["claude-follower", "claude-code"],
  ["dsh-follower", "deepseek-harness"],
  ["devin-print", "devin"],
  ["acp-managed", "antigravity"],
]);

const validators: Record<LiveSessionAgent, ProviderControlValidator> = {
  codex: validateCodexControl,
  "claude-code": validateClaudeControl,
  "deepseek-harness": validateDeepSeekHarnessControl,
  devin: validateDevinControl,
  antigravity: validateAntigravityControl,
};

/** For hosts connected to an embedded runtime, select the same validator using its observed mode. */
export function validateEmbeddedControl(
  call: HostControlValidationCall,
): HostControlValidationResult {
  const agent = call.executionMode && agentByMode.get(call.executionMode);
  return agent
    ? runProviderValidation(call, agent, validators[agent])
    : { result: { available: false } };
}

export function runProviderValidation(
  call: HostControlValidationCall,
  agent: unknown,
  validate: ProviderControlValidator | undefined,
): HostControlValidationResult {
  if (!validate || !call.executionMode || agentByMode.get(call.executionMode) !== agent)
    return { result: { available: false } };
  try {
    let requiresFullAccess = false;
    const result = validate(call.request, {
      executionMode: call.executionMode,
      verifiedClaudeManaged: call.verified["claude-code"] === true,
      verifiedSerialQueue: call.verified[agent as LiveSessionAgent] === true,
      requireFullAccess: () => {
        if (!call.fullAccess) throw new ControlValidationError(403, "permission_denied");
        requiresFullAccess = true;
      },
    });
    return { result: requiresFullAccess ? { ...result, requiresFullAccess } : result };
  } catch (error) {
    if (error instanceof ControlValidationError)
      return { error: error.message, status: error.status };
    throw error;
  }
}
