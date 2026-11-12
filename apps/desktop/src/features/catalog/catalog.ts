import type { AgentKind, AssetRecord, CatalogAsset } from "@/core/types";

export interface CatalogAssetGroup {
  id: string;
  scope: CatalogAsset["scope"];
  workspace_id?: string;
  kind: string;
  name: string;
  path: string;
  summary: string;
  summary_key?: string;
  summary_params?: Record<string, string>;
  size: number;
  modified_at?: string;
  agents: AgentKind[];
  shared: boolean;
  records: CatalogAsset[];
}

export interface WorkspaceAssetGroup {
  id: string;
  kind: string;
  path: string;
  size: number;
  agents: AgentKind[];
  records: AssetRecord[];
}

const agentOrder: AgentKind[] = [
  "codex",
  "claude-code",
  "antigravity",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "deepseek-harness",
  "devin",
];

export function groupCatalogAssets(assets: CatalogAsset[]): CatalogAssetGroup[] {
  const grouped = new Map<string, CatalogAssetGroup>();
  for (const asset of assets) {
    const key = [asset.scope, asset.workspace_id ?? "", asset.path, asset.kind].join("\u0000");
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        id: key,
        scope: asset.scope,
        workspace_id: asset.workspace_id,
        kind: asset.kind,
        name: asset.name,
        path: asset.path,
        summary: asset.summary,
        summary_key: asset.summary_key,
        summary_params: asset.summary_params,
        size: asset.size,
        modified_at: asset.modified_at,
        agents: asset.agent ? [asset.agent] : [],
        shared: !asset.agent,
        records: [asset],
      });
      continue;
    }
    current.records.push(asset);
    current.size = Math.max(current.size, asset.size);
    if (asset.modified_at && (!current.modified_at || asset.modified_at > current.modified_at))
      current.modified_at = asset.modified_at;
    if (asset.agent && !current.agents.includes(asset.agent)) current.agents.push(asset.agent);
    if (!asset.agent) current.shared = true;
  }
  for (const asset of grouped.values())
    asset.agents.sort((a, b) => agentOrder.indexOf(a) - agentOrder.indexOf(b));
  return [...grouped.values()];
}

export function groupWorkspaceAssets(assets: AssetRecord[]): WorkspaceAssetGroup[] {
  const grouped = new Map<string, WorkspaceAssetGroup>();
  for (const asset of assets) {
    const key = [asset.path, asset.kind].join("\u0000");
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        id: key,
        kind: asset.kind,
        path: asset.path,
        size: asset.size,
        agents: [asset.agent],
        records: [asset],
      });
      continue;
    }
    current.records.push(asset);
    current.size = Math.max(current.size, asset.size);
    if (!current.agents.includes(asset.agent)) current.agents.push(asset.agent);
  }
  for (const asset of grouped.values())
    asset.agents.sort((a, b) => agentOrder.indexOf(a) - agentOrder.indexOf(b));
  return [...grouped.values()];
}

export function workspaceAssetCounts(groups: CatalogAssetGroup[]) {
  const counts = new Map<string, number>();
  for (const asset of groups) {
    if (asset.workspace_id)
      counts.set(asset.workspace_id, (counts.get(asset.workspace_id) ?? 0) + 1);
  }
  return counts;
}
