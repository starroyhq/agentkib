import type { AgentKind } from "@/core/types";

export const sessionHandoffTargets: Array<[AgentKind, string]> = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["cursor", "Cursor"],
  ["opencode", "OpenCode"],
  ["open-claw", "OpenClaw"],
  ["hermes", "Hermes"],
  ["grok-build", "Grok Build"],
  ["deepseek-harness", "DeepSeek Harness"],
];
