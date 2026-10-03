import { agentName } from "@agentkib/agent-identity";
import type { AgentKind } from "./types";

// Record 强制覆盖每个 AgentKind：新增 agent 时漏写这里会直接编译失败。
// 键的顺序就是界面里的默认展示顺序。
const AGENT_ORDER: Record<AgentKind, true> = {
  codex: true,
  "claude-code": true,
  antigravity: true,
  cursor: true,
  opencode: true,
  "open-claw": true,
  hermes: true,
  "grok-build": true,
  "deepseek-harness": true,
};

export const AGENT_KINDS = Object.keys(AGENT_ORDER) as AgentKind[];

/** 显示名称统一来自 @agentkib/agent-identity，桌面端和 Web 端保持一致。 */
export const AGENT_LABELS = Object.fromEntries(
  AGENT_KINDS.map((agent) => [agent, agentName(agent)]),
) as Record<AgentKind, string>;
