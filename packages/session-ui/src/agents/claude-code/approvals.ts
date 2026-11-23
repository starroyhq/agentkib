import type { Live } from "@agentkib/web-client";
import type {
  ApprovalChoice,
  InteractionApproval,
  InteractionCardCopy,
} from "../../interaction-model";
import type { SessionSurface } from "../../session-surface-copy";
import { claudeConnectionCopyForSurface } from "./connection-copy";
import type { ApprovalRuntime, LegacyApprovals } from "../session-approvals";

function toolChoices(approval: InteractionApproval, t: InteractionCardCopy): ApprovalChoice[] {
  return approval.availableDecisions
    .filter((decision) => decision === "allow" || decision === "deny")
    .map((decision) => ({
      key: decision,
      label: decision === "allow" ? t.allow : t.deny,
      decision,
      quick: decision === "allow" ? "allow" : "deny",
    }));
}

export const terminalApprovalMethods: LegacyApprovals = {
  "claude/can_use_tool": { kind: "tool", nativeToolCall: false, choices: toolChoices },
};

export function claudeTerminalInteraction(live: Live | null | undefined, sessionId: string) {
  if (live?.sessionId !== sessionId) return;
  const owner = live.execution?.owner;
  if (owner ? owner !== "terminal" : live.executionMode !== terminalApprovalRuntime.legacyMode)
    return;
  if (live.reason === "claude-terminal-approval" && live.status === "awaiting-approval")
    return "approval";
  if (live.reason === "claude-terminal-question" && live.status === "waiting-input")
    return "question";
}

export const terminalApprovalRuntime: ApprovalRuntime = {
  owner: "terminal",
  legacyMode: "claude-follower",
  observedText: (live, sessionId, locale, surface: SessionSurface) => {
    const kind = claudeTerminalInteraction(live, sessionId);
    return kind ? claudeConnectionCopyForSurface(locale, surface)[kind] : undefined;
  },
};
