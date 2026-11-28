import codex from "./assets/codex.svg";
import claude from "./assets/claude-code.svg";
import antigravity from "./assets/antigravity.svg";
import cursor from "./assets/cursor.svg";
import opencode from "./assets/opencode.svg";
import openClaw from "./assets/open-claw.svg";
import hermes from "./assets/hermes.svg";
import grok from "./assets/grok-build.svg";
import deepseek from "./assets/deepseek-harness.svg";
import devin from "./assets/devin.svg";
import "./style.css";
import { Bot } from "lucide-react";
import { knownAgentName } from "./names";

const identities: Record<string, { src: string; invert?: boolean; dim?: boolean }> = {
  codex: { src: codex },
  "claude-code": { src: claude },
  antigravity: { src: antigravity },
  cursor: { src: cursor },
  opencode: { src: opencode, invert: true },
  "open-claw": { src: openClaw },
  hermes: { src: hermes, invert: true, dim: true },
  "grok-build": { src: grok, invert: true, dim: true },
  "deepseek-harness": { src: deepseek },
  devin: { src: devin },
};

function identity(agent?: string) {
  return agent && Object.hasOwn(identities, agent) ? identities[agent] : undefined;
}

export function agentName(agent?: string): string {
  return knownAgentName(agent) ?? (agent?.trim() || "Agent");
}

export function AgentMark({ agent, size = 16 }: { agent?: string; size?: number }) {
  const item = identity(agent);
  return (
    <span
      className="ak-agent-mark"
      title={agentName(agent)}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {item ? (
        <img
          src={item.src}
          alt=""
          className={[
            "ak-agent-image",
            item.invert ? "ak-agent-invert" : "",
            item.dim ? "ak-agent-dim" : "",
            agent === "cursor" ? "ak-agent-cursor" : "",
          ].join(" ")}
        />
      ) : (
        <Bot size={size} />
      )}
    </span>
  );
}
