import { isClaudePermissionMode } from "@agentkib/runtime-protocol";
import type { ClaudeSettings } from "./claude-host-state";

export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type QuitEvidence = {
  turnId: string;
  nativeId: string;
  workspaceId: string;
  createdAt: string;
  fingerprint: string;
  settingsKey: string;
  resumeQueue: boolean;
  launch: ClaudeSettings & {
    model: string;
    permissionMode: NonNullable<ClaudeSettings["permissionMode"]>;
  };
};

export function quitEvidence(value: Record<string, unknown>): QuitEvidence | undefined {
  const {
    turnId,
    nativeId,
    workspaceId,
    createdAt,
    fingerprint,
    settingsKey,
    resumeQueue,
    launch: rawLaunch,
  } = value;
  const launch =
    rawLaunch && typeof rawLaunch === "object" && !Array.isArray(rawLaunch)
      ? (rawLaunch as Record<string, unknown>)
      : undefined;
  const effort = (["low", "medium", "high", "xhigh", "max"] as const).find(
    (item) => item === launch?.effort,
  );
  if (
    typeof turnId !== "string" ||
    !uuidPattern.test(turnId) ||
    typeof nativeId !== "string" ||
    !uuidPattern.test(nativeId) ||
    typeof workspaceId !== "string" ||
    typeof createdAt !== "string" ||
    typeof fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(fingerprint) ||
    typeof settingsKey !== "string" ||
    typeof resumeQueue !== "boolean" ||
    !launch ||
    typeof launch.model !== "string" ||
    !launch.model ||
    Buffer.byteLength(launch.model) > 256 ||
    !isClaudePermissionMode(launch.permissionMode) ||
    (launch.effort !== undefined && !effort)
  )
    return;
  return {
    turnId,
    nativeId,
    workspaceId,
    createdAt,
    fingerprint,
    settingsKey,
    resumeQueue,
    launch: {
      model: launch.model,
      permissionMode: launch.permissionMode,
      ...(effort ? { effort } : {}),
    },
  };
}
