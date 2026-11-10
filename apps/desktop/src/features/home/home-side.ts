import type {
  AgentKind,
  AgentToolSnapshot,
  ContextDoctorSummary,
  MemoryRecord,
  QuotaPopoverPreferences,
  QuotaSnapshot,
  QuotaWindow,
  WorkspaceSummary,
} from "@/core/types";
import {
  compareQuotaProviders,
  isQuotaProviderSupported,
  quotaSeverity,
  visibleQuotaWindows,
  type QuotaSeverity,
} from "@/features/quota/quota";
import type { WebAdminStatus } from "../../../electron/main/web/service";
import type { RelayUsage } from "../../../electron/main/account/relay-usage";

export interface HomeQuotaRow {
  providerId: string;
  name: string;
  window: QuotaWindow;
  usedPercent: number;
  severity: QuotaSeverity;
}

/** Each provider's first visible window with a known share, the one closest to its limit first. */
export function homeQuotaRows(
  snapshot: QuotaSnapshot | null | undefined,
  preferences: QuotaPopoverPreferences,
  limit = 3,
): HomeQuotaRow[] {
  if (!snapshot) return [];
  return [...snapshot.providers]
    .filter((provider) => provider.enabled && isQuotaProviderSupported(provider))
    .sort(compareQuotaProviders)
    .flatMap((provider) => {
      const item = visibleQuotaWindows(provider, preferences).find(
        ({ window }) =>
          window.usage_known !== false &&
          typeof window.used_percent === "number" &&
          Number.isFinite(window.used_percent),
      );
      if (!item) return [];
      const used = Math.min(100, Math.max(0, item.window.used_percent!));
      return [
        {
          providerId: provider.id,
          name: provider.name,
          window: item.window,
          usedPercent: Math.round(used),
          severity: quotaSeverity(item.window.remaining_percent ?? 100 - used),
        },
      ];
    })
    .slice(0, limit);
}

export interface HomeRemoteSummary {
  devices: number;
  /** This month's share of the relay allowance, once the account reports it. */
  relayPercent?: number;
  relayExhausted: boolean;
}

/** Remote access the way the remote settings report it; nothing while it is off. */
export function homeRemote(
  status: Pick<WebAdminStatus, "running" | "devices"> | undefined,
  relayUsage?: Pick<RelayUsage, "usedBytes" | "limitBytes" | "exhausted">,
): HomeRemoteSummary | undefined {
  if (!status?.running) return undefined;
  const relayPercent =
    relayUsage && relayUsage.limitBytes > 0
      ? Math.min(100, Math.round((relayUsage.usedBytes / relayUsage.limitBytes) * 100))
      : undefined;
  return {
    devices: status.devices.length,
    relayPercent,
    relayExhausted: relayUsage?.exhausted === true,
  };
}

export type HomeMaintenanceItem =
  | { kind: "config"; count: number }
  | { kind: "memories"; count: number }
  | { kind: "tools"; agents: AgentKind[] }
  | { kind: "undiagnosed"; count: number };

/**
 * Upkeep that waits on the user, from saved results only; nothing here runs a check. A source
 * that has not been read yet counts nothing rather than every workspace as undiagnosed.
 */
export function homeMaintenance({
  workspaces,
  doctorSummaries,
  memories,
  tools,
}: {
  workspaces: WorkspaceSummary[];
  doctorSummaries?: Record<string, ContextDoctorSummary>;
  memories?: MemoryRecord[];
  tools?: Pick<AgentToolSnapshot, "tools">;
}): HomeMaintenanceItem[] {
  let config = 0;
  let undiagnosed = 0;
  for (const workspace of doctorSummaries ? workspaces : []) {
    const summary = doctorSummaries![workspace.id];
    if (summary?.workspace_id !== workspace.id) undiagnosed += 1;
    else if (summary.error_count + summary.warning_count > 0) config += 1;
  }
  const pending = (memories ?? []).filter((memory) => memory.status === "pending").length;
  const updates = (tools?.tools ?? [])
    .filter((tool) => tool.installed && tool.state === "update-available")
    .map((tool) => tool.agent);
  return [
    ...(config ? [{ kind: "config" as const, count: config }] : []),
    ...(pending ? [{ kind: "memories" as const, count: pending }] : []),
    ...(updates.length ? [{ kind: "tools" as const, agents: updates }] : []),
    ...(undiagnosed ? [{ kind: "undiagnosed" as const, count: undiagnosed }] : []),
  ];
}
