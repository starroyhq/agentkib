import codex from "./assets/codex.svg";
import claude from "./assets/claude-code.svg";
import cursor from "./assets/cursor.svg";
import opencode from "./assets/opencode.svg";
import openClaw from "./assets/open-claw.svg";
import hermes from "./assets/hermes.svg";
import grok from "./assets/grok-build.svg";
import deepseek from "./assets/deepseek-harness.svg";
import "./style.css";
import { Bot } from "lucide-react";

const identities: Record<string, { name: string; src: string; invert?: boolean; dim?: boolean }> = {
  codex: { name: "Codex", src: codex },
  "claude-code": { name: "Claude Code", src: claude },
  cursor: { name: "Cursor", src: cursor },
  opencode: { name: "OpenCode", src: opencode, invert: true },
  "open-claw": { name: "OpenClaw", src: openClaw },
  hermes: { name: "Hermes", src: hermes, invert: true, dim: true },
  "grok-build": { name: "Grok Build", src: grok, invert: true, dim: true },
  "deepseek-harness": { name: "DeepSeek Harness", src: deepseek },
};

function identity(agent?: string) {
  return agent && Object.hasOwn(identities, agent) ? identities[agent] : undefined;
}

export function agentName(agent?: string): string {
  return identity(agent)?.name ?? (agent?.trim() || "Agent");
}

export function AgentMark({ agent, size = 16 }: { agent?: string; size?: number }) {
  const item = identity(agent);
  return (
    <span className="ak-agent-mark" title={agentName(agent)} aria-hidden="true" style={{ width: size, height: size }}>
      {item ? (
        <img src={item.src} alt="" className={[
          "ak-agent-image",
          item.invert ? "ak-agent-invert" : "",
          item.dim ? "ak-agent-dim" : "",
          agent === "cursor" ? "ak-agent-cursor" : "",
        ].join(" ")} />
      ) : <Bot size={size} />}
    </span>
  );
}
