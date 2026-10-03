export interface NativeContext {
  agent_homes: string[];
  agentkib_home: string | null;
}

export interface DiscoveryCandidate {
  path: string;
  display_name?: string | null;
  source_agent: string | null;
  evidence: string;
  last_active_at: string | null;
  session_count: number;
  repository_group_id: string | null;
  session_cwds?: string[] | null;
  explicit_workspace?: boolean;
}

export interface CatalogAsset {
  id: string;
  scope: string;
  workspace_id: string | null;
  agent: string | null;
  kind: string;
  name: string;
  path: string;
  summary: string;
  size: number;
  modified_at: string | null;
  summary_key?: string | null;
  summary_params?: Record<string, string>;
}

export interface WorkspaceInspection {
  summary: {
    manifest_workspace_id: string | null;
    status: string;
    asset_count: number;
    warning_count: number;
    scanned_at: string;
  } | null;
  assets: CatalogAsset[];
  error: string | null;
}

export interface InspectedWorkspace {
  id: string;
  inspection: WorkspaceInspection;
}

export interface WorkspacePlan {
  id: string;
  path: string;
  stored_path: string;
  sources: DiscoveryCandidate[];
}

export interface DiscoverySnapshot {
  non_workspace_paths?: string[];
  candidates: DiscoveryCandidate[];
  installations: {
    agent: string;
    installed: boolean;
    configured: boolean;
    version: string | null;
    home: string | null;
    warnings: string[];
  }[];
  home_assets: CatalogAsset[];
  errors: string[];
  source_diagnostics: Record<string, unknown>[];
}

export interface DiscoveryPlan {
  workspaces: WorkspacePlan[];
  managed_homes: string[];
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.000Z$/, "Z");
}

/** SQLite keeps chrono's RFC3339 UTC offset spelling; RPC uses the Z spelling. */
export function storedTime(value: string | null): string | null {
  return value?.replace(/Z$/, "+00:00") ?? null;
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function compareTimes(left: string, right: string): number {
  const seconds = compareUtf8(left.slice(0, 19), right.slice(0, 19));
  if (seconds) return seconds;
  const fraction = (value: string) => (/\.(\d+)Z$/.exec(value)?.[1] ?? "").padEnd(9, "0");
  return compareUtf8(fraction(left), fraction(right));
}

export function refreshReceipt(queuedAt: string, startedAt: string) {
  const requestId = `${Date.parse(queuedAt)}-electron`;
  return {
    kind: "discovery",
    disposition: "queued",
    request_id: requestId,
    status: {
      kind: "discovery",
      state: "succeeded",
      request_id: requestId,
      queued_at: queuedAt,
      started_at: startedAt,
      finished_at: utcNow(),
      progress_current: 1,
      progress_total: 1,
      error: null,
      next_allowed_at: null,
    },
  };
}
