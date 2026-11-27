import { PROJECT_AGENT_MAX_WORKERS } from "@agentkib/runtime-protocol";
import type { ClaudeBridge } from "./agents/claude/claude-bridge";
import type { ClaudeManagedReadOwner } from "./agents/claude/claude-managed-read";

export const PROJECT_AGENT_LOCAL_OWNER = "agentkib-local-owner";

export function projectAgentId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256)
    throw new Error("invalid-lead-request");
  return value;
}

export function authorizedLeadWorkspaces(params: Record<string, unknown>): string[] | undefined {
  const ids = params.authorizedWorkspaceIds;
  if (ids === undefined) return;
  if (
    !Array.isArray(ids) ||
    (params.operation !== "lead-status" && ids.length > PROJECT_AGENT_MAX_WORKERS + 1) ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  )
    throw new Error("invalid-lead-request");
  return ids;
}

export function localProjectSessionIds(deviceId: string, value: unknown, limit: number): string[] {
  if (deviceId !== PROJECT_AGENT_LOCAL_OWNER || !Array.isArray(value) || value.length > limit)
    throw new Error("invalid-lead-request");
  return value.map(projectAgentId);
}

export async function disconnectedTerminalLead(
  sessionId: string,
  bridge: Pick<ClaudeBridge, "blocksManagedResume">,
  managed?: Pick<ClaudeManagedReadOwner, "hasRunningNativeTerminal">,
): Promise<string | undefined> {
  if (!(await managed?.hasRunningNativeTerminal(sessionId))) return;
  try {
    // A live lease or an outstanding bridge command already has its own reason.
    if (!bridge.blocksManagedResume(sessionId)) return "lead-claude-terminal-disconnected";
  } catch {
    // An invalid bridge registry cannot prove that the terminal is disconnected.
  }
}
