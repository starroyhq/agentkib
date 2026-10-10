import type { AgentKind } from "@/core/types";

export type HeatmapMetric =
  | "tokens"
  | "my_commits"
  | "all_commits"
  | "attributed_commits"
  | "sessions";
export type InsightsSection = "overview" | "tokens" | "commits" | "milestones" | "sources";
export type InsightsAgentFilter = "all" | AgentKind;
