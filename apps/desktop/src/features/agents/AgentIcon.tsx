import claudeCodeIcon from "@/assets/agent-icons/claude-code.svg";
import codexIcon from "@/assets/agent-icons/codex.svg";
import cursorIcon from "@/assets/agent-icons/cursor.svg";
import openCodeIcon from "@/assets/agent-icons/opencode.svg";
import hermesIcon from "@/assets/agent-icons/hermes.svg";
import grokBuildIcon from "@/assets/agent-icons/grok-build.svg";
import openClawIcon from "@/assets/agent-icons/open-claw.svg";
import deepSeekHarnessIcon from "@/assets/agent-icons/deepseek-harness.svg";
import type { AgentKind } from "@/core/types";
import { cn } from "@/lib/utils";

const agentIcons: Record<AgentKind, string> = {
  codex: codexIcon,
  "claude-code": claudeCodeIcon,
  cursor: cursorIcon,
  opencode: openCodeIcon,
  "open-claw": openClawIcon,
  hermes: hermesIcon,
  "grok-build": grokBuildIcon,
  "deepseek-harness": deepSeekHarnessIcon,
};

export function AgentIcon({ agent, compact = false }: { agent: AgentKind; compact?: boolean }) {
  return (
    <div
      className={cn("grid place-items-center overflow-hidden", compact ? "size-5" : "size-9")}
      aria-hidden="true"
    >
      <img
        className={cn(
          "block object-contain",
          compact ? "size-4" : "size-8",
          agent === "cursor" && "rounded-md bg-[#1d1d1f] p-1",
          agent === "opencode" && "dark:invert",
          agent === "hermes" && "opacity-[0.92] dark:invert",
          agent === "grok-build" && "opacity-[0.92] dark:invert",
        )}
        src={agentIcons[agent]}
        alt=""
      />
    </div>
  );
}
