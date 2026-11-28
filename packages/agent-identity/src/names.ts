const agentNames = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
  "open-claw": "OpenClaw",
  hermes: "Hermes",
  "grok-build": "Grok Build",
  "deepseek-harness": "DeepSeek Harness",
  devin: "Devin",
} as const;

export function knownAgentName(agent: string | undefined): string | undefined {
  return agent && Object.hasOwn(agentNames, agent)
    ? agentNames[agent as keyof typeof agentNames]
    : undefined;
}
