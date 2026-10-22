import { z } from "zod";
import type { AgentKind } from "@/core/types";
import { AGENT_KINDS } from "@/core/agents";
import type { InsightsSection } from "@/features/insights/InsightsPage";
import { settingsTargets, type SettingsSection } from "@/features/settings/SettingsSidebar";

const quotaWindowSchema = z.object({
  provider_id: z.string(),
  account_id: z.string().optional(),
  kind: z.string(),
  label: z.string(),
});

const gitSubviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), oid: z.string() }),
  z.object({
    kind: z.literal("worktree"),
    path: z.string(),
    diffKind: z.enum(["commit", "worktree", "staged"]),
  }),
]);

export const appSearchSchema = z.object({
  assetSection: z
    .enum(["instructions", "skills", "mcp", "memory", "other"])
    .optional()
    .catch(undefined),
  catalogTarget: z.literal("mcp-network").optional().catch(undefined),
  skillSection: z.enum(["library", "workspace", "discover"]).optional().catch(undefined),
  workspaceAssetSection: z
    .enum(["instructions", "skills", "mcp", "native"])
    .optional()
    .catch(undefined),
  workspaceView: z.enum(["list", "storage"]).optional().catch(undefined),
  settingsSection: z
    .enum([
      "general",
      "appearance",
      "shortcuts",
      "discovery",
      "tools",
      "remote",
      "integrations",
      "privacy",
      "diagnostics",
    ] satisfies SettingsSection[])
    .optional()
    .catch(undefined),
  settingsTarget: z.enum(settingsTargets).optional().catch(undefined),
  settingsAgent: z.enum(AGENT_KINDS).optional().catch(undefined),
  settingsAgentFilter: z.enum(["all", "enabled", "available"]).optional().catch(undefined),
  insightsSection: z
    .enum(["overview", "tokens", "commits", "milestones", "sources"] satisfies InsightsSection[])
    .optional()
    .catch(undefined),
  quotaProvider: z.string().optional().catch(undefined),
  quotaWindow: quotaWindowSchema.optional().catch(undefined),
  gitSubview: gitSubviewSchema.optional().catch(undefined),
  agent: z.custom<AgentKind>().optional().catch(undefined),
  agentFilter: z.enum(["all", "enabled", "available"]).optional().catch(undefined),
  configure: z.boolean().optional().catch(undefined),
  doctorVerification: z.enum(["applied"]).optional().catch(undefined),
  sessionId: z.string().optional().catch(undefined),
  handoffSession: z.string().optional().catch(undefined),
  handoffTarget: z.custom<AgentKind>().optional().catch(undefined),
  handoffBudget: z
    .union([z.literal(64_000), z.literal(120_000), z.literal(180_000)])
    .optional()
    .catch(undefined),
  handoffFormat: z.enum(["markdown", "json"]).optional().catch(undefined),
  handoffSurface: z.literal("cursor-ide").optional().catch(undefined),
  handoffBinding: z.string().max(128).optional().catch(undefined),
  handoffPreCompaction: z.literal(true).optional().catch(undefined),
  handoffResume: z.enum(["return", "recheck"]).optional().catch(undefined),
});
