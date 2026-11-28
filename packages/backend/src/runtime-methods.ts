import path from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { z } from "zod";
import type { Doctor } from "./doctor";
import type { Git } from "./git";
import { userHome } from "./mcp-config-read";
import { parseQuotaPreferences, preferenceSnapshot, readPreferences } from "./preferences";
import type { QuotaOwner } from "./quota";
import type { RuntimeMethodRegistration } from "./runtime-method-scheduler";
import type { BackendStore } from "./store";

export type RuntimeMethodTracePolicy = Pick<
  RuntimeMethodRegistration,
  "trace" | "lane" | "timeoutMs"
>;

export function readMethod(
  handler: RuntimeMethodRegistration["handler"],
  coalesce?: RuntimeMethodRegistration["coalesce"],
): RuntimeMethodRegistration {
  return { lane: "read", timeoutMs: 30_000, concurrency: 8, trace: "method", handler, coalesce };
}

export function batchMethod(
  handler: RuntimeMethodRegistration["handler"],
  coalesce?: RuntimeMethodRegistration["coalesce"],
): RuntimeMethodRegistration {
  return { lane: "batch", timeoutMs: 120_000, concurrency: 1, trace: "method", handler, coalesce };
}

export const workspaceSessionsRequest = z.object({
  workspaceId: z.string(),
  readerScope: z.string().min(1).max(512).optional(),
});

export function workspaceSessionsReadKey(params: Record<string, unknown>) {
  const request = workspaceSessionsRequest.safeParse(params);
  if (request.success && request.data.workspaceId.length <= 256)
    return JSON.stringify([request.data.workspaceId, request.data.readerScope]);
}

export function ownerReadMethods({
  store,
  git,
  doctor,
  quota,
  dataDir,
}: {
  store(): BackendStore;
  git(): Git;
  doctor(): Doctor;
  quota(): QuotaOwner;
  dataDir(): string;
}) {
  const rpc = RUNTIME_METHODS;
  const insight = (method: string) =>
    readMethod((params) => store().insights.request(method, params));
  const gitRead = (method: string) => readMethod((params) => git().request(method, params));
  return {
    [rpc.listScanRoots]: readMethod(() => store().listScanRoots()),
    [rpc.listExcludedWorkspaces]: readMethod(() => store().listExcludedWorkspaces()),
    [rpc.discoveryReport]: readMethod(() => store().workspaces.discoveryReport()),
    [rpc.workspaceSessionStatus]: readMethod((params) =>
      store().sessions.request(rpc.workspaceSessionStatus, params),
    ),
    [rpc.insightsSummary]: insight(rpc.insightsSummary),
    [rpc.insightsStatus]: insight(rpc.insightsStatus),
    [rpc.insightsHeatmap]: insight(rpc.insightsHeatmap),
    [rpc.agentUsageBreakdown]: insight(rpc.agentUsageBreakdown),
    [rpc.modelUsageBreakdown]: insight(rpc.modelUsageBreakdown),
    [rpc.workspaceUsageBreakdown]: insight(rpc.workspaceUsageBreakdown),
    [rpc.repositoryCommitBreakdown]: insight(rpc.repositoryCommitBreakdown),
    [rpc.gitIdentities]: insight(rpc.gitIdentities),
    [rpc.workspaceGitSummary]: gitRead(rpc.workspaceGitSummary),
    [rpc.workspaceGitHistory]: gitRead(rpc.workspaceGitHistory),
    [rpc.gitCommitFiles]: gitRead(rpc.gitCommitFiles),
    [rpc.gitDiff]: gitRead(rpc.gitDiff),
    [rpc.workspaceDoctorSummaries]: readMethod((params) =>
      doctor().request(rpc.workspaceDoctorSummaries, params),
    ),
    [rpc.quotaSnapshot]: readMethod(() => quota().snapshot()),
    [rpc.quotaCollectorStatus]: readMethod(() => quota().status()),
    [rpc.quotaPreferences]: readMethod(
      () =>
        parseQuotaPreferences(readPreferences(dataDir()).quota_popover) ?? {
          hidden_providers: [],
          hidden_windows: [],
        },
    ),
  };
}

export function runtimePreferences(dataDir: string, environment: NodeJS.ProcessEnv) {
  return {
    ...preferenceSnapshot(dataDir, environment),
    mcp_network: readPreferences(dataDir).mcp_network ?? {
      port: environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? 47654 : 47653,
      lan_enabled: false,
      lan_risk_accepted: false,
    },
  };
}

export function runtimeInfo(
  dataDir: string,
  environment: NodeJS.ProcessEnv,
  preferences: object,
  mcpHub: unknown,
) {
  const home = userHome({ ...process.env, ...environment });
  const development = environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev";
  return {
    app_name: development ? "AgentKib Dev" : "AgentKib",
    app_version: environment.AGENTKIB_APP_VERSION ?? "0.13.0",
    app_channel: development ? "development" : "stable",
    updates_enabled: !development,
    data_dir: dataDir,
    database_path: path.join(dataDir, "agentkib.db"),
    mcp_package_root: path.join(dataDir, "mcp", "packages"),
    mcp_hub: mcpHub,
    openclaw_config: path.join(home, ".openclaw", "openclaw.json"),
    hermes_config: path.join(home, ".hermes", "config.yaml"),
    tray_available: false,
    ...preferences,
  };
}
