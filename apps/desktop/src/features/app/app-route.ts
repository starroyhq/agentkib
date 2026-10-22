import type { AssetSection } from "@/features/home/GlobalHome";
import type { GitSubview } from "@/features/workspace/WorkspaceGitPage";
import type { SettingsSection, SettingsTarget } from "@/features/settings/SettingsSidebar";
import type { AgentKind } from "@/core/types";
import type { AgentFilter } from "@/components/AppSidebar";
import type { SkillHubSection } from "@/features/skills/SkillHubPage";

export type Page = "overview" | "sessions" | "git" | "assets" | "context" | "doctor" | "changes";
export type GlobalPage =
  | "home"
  | "workspaces"
  | "catalog"
  | "agents"
  | "sessions"
  | "quota"
  | "insights";

export type AppSearch = {
  assetSection?: AssetSection;
  catalogTarget?: "mcp-network";
  skillSection?: SkillHubSection;
  settingsSection?: SettingsSection;
  settingsTarget?: SettingsTarget;
  settingsAgent?: AgentKind;
  settingsAgentFilter?: AgentFilter;
  quotaProvider?: string;
  quotaWindow?: import("@/core/types").QuotaWindowSelector;
  gitSubview?: GitSubview;
  doctorVerification?: "applied";
  sessionId?: string;
  handoffSession?: string;
  handoffTarget?: AgentKind;
  handoffBudget?: 64_000 | 120_000 | 180_000;
  handoffFormat?: "markdown" | "json";
  handoffSurface?: "cursor-ide";
  handoffBinding?: string;
  handoffPreCompaction?: true;
  handoffResume?: "return" | "recheck";
  agent?: AgentKind;
  agentFilter?: AgentFilter;
};

/** Agent's old global query must not be confused with a workspace's selected Agent. */
export function legacyAgentSettingsSearch(search: AppSearch): AppSearch {
  return {
    ...search,
    settingsSection: "integrations",
    settingsTarget: "integrations-agents",
    settingsAgent: search.agent,
    settingsAgentFilter: search.agentFilter,
    agent: undefined,
    agentFilter: undefined,
  };
}

export type ParsedRoute =
  | { kind: "settings" }
  | { kind: "global"; page: GlobalPage }
  | { kind: "workspace"; workspaceId: string; page: Page };

export type AppRouteMetadata =
  | { kind: "settings" }
  | { kind: "global"; page: GlobalPage }
  | { kind: "workspace"; page: Page };

type AppRouteMatch = {
  staticData: { appRoute?: AppRouteMetadata };
  params: object;
};

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    appRoute?: AppRouteMetadata;
  }
}

export function workspaceSearchForPage(current: AppSearch, page: Page): AppSearch {
  const next = page === "git" ? current : { ...current, gitSubview: undefined };
  if (page === "sessions" || page === "changes") return next;
  if (
    page === "git" &&
    !next.handoffSession &&
    !next.handoffTarget &&
    !next.handoffBudget &&
    !next.handoffFormat &&
    !next.handoffSurface &&
    !next.handoffBinding &&
    !next.handoffPreCompaction &&
    !next.handoffResume
  ) {
    return current;
  }
  const {
    handoffSession: _handoffSession,
    handoffTarget: _handoffTarget,
    handoffBudget: _handoffBudget,
    handoffFormat: _handoffFormat,
    handoffSurface: _handoffSurface,
    handoffBinding: _handoffBinding,
    handoffPreCompaction: _handoffPreCompaction,
    handoffResume: _handoffResume,
    ...rest
  } = next;
  return rest;
}

export function routeFromMatches<TMatch extends AppRouteMatch>(
  matches: readonly TMatch[],
): ParsedRoute {
  for (const match of [...matches].reverse()) {
    const metadata = match.staticData.appRoute;
    if (!metadata) continue;
    if (metadata.kind === "workspace") {
      const workspaceId = (match.params as { workspaceId?: unknown }).workspaceId;
      if (typeof workspaceId === "string") return { ...metadata, workspaceId };
      continue;
    }
    return metadata;
  }
  return { kind: "global", page: "home" };
}

export function parseHistoryRoute(pathname: string): ParsedRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] === "settings") return { kind: "settings" };
  if (segments[0] === "workspace" && segments[1]) {
    const page = segments[2];
    const workspacePage: Page =
      page === "sessions" ||
      page === "git" ||
      page === "assets" ||
      page === "context" ||
      page === "doctor" ||
      page === "changes"
        ? page
        : "overview";
    return { kind: "workspace", workspaceId: segments[1], page: workspacePage };
  }
  const page = segments[0];
  const globalPage: GlobalPage =
    page === "workspaces" ||
    page === "catalog" ||
    page === "agents" ||
    page === "sessions" ||
    page === "quota" ||
    page === "insights"
      ? page
      : "home";
  return { kind: "global", page: globalPage };
}

// Keep the original name for isolated callers; live route identity comes from route matches.
export const parseRoute = parseHistoryRoute;
