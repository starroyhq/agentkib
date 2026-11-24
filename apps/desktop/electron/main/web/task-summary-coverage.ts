import type {
  ConversationSessionSummary,
  ConversationTaskCoverage,
  ConversationTaskSource,
  ConversationTaskSourceReason,
} from "@agentkib/web-client";

const sourceReasons = new Set<ConversationTaskSourceReason>([
  "source-unavailable",
  "source-partial",
  "not-scanned",
  "refreshing",
  "classification-pending",
  "index-disabled",
  "coverage-unknown",
  "read-state-stale",
  "antigravity-database-record",
  "antigravity-summary-record",
  "antigravity-trajectory-record",
  "antigravity-database-source",
  "antigravity-summary-source",
  "antigravity-local-limit",
  "antigravity-acp-list",
  "antigravity-acp-record",
  "antigravity-native-list",
]);
const unobservedRuntimeStatuses = new Set([
  "disconnected",
  "outcome-unknown",
  "unavailable",
  "unsupported",
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function knownReason(value: unknown): value is ConversationTaskSourceReason {
  return typeof value === "string" && sourceReasons.has(value as ConversationTaskSourceReason);
}

/** Uses the directory's cached observations and publishes only authorized source identities. */
export function buildTaskSummaryCoverage(
  catalog: unknown,
  workspaces: ReadonlySet<string>,
  scopedSessions: readonly ConversationSessionSummary[],
  allWorkspaces: boolean,
): ConversationTaskCoverage {
  if (workspaces.size === 0) return { complete: true, sources: [] };
  const directory = record(catalog);
  const coverage = record(directory?.taskSummarySourceCoverage);
  const observedWorkspaces = new Set<string>();
  const bySource = new Map<string, ConversationTaskSource>();
  const update = (
    workspaceId: unknown,
    agent: unknown,
    reasons: ConversationTaskSourceReason[],
  ) => {
    if (
      typeof workspaceId !== "string" ||
      !workspaces.has(workspaceId) ||
      typeof agent !== "string" ||
      !agent
    )
      return;
    const key = JSON.stringify([workspaceId, agent]);
    const existing = bySource.get(key)?.reasons ?? [];
    if (bySource.has(key) && reasons.every((reason) => existing.includes(reason)))
      return workspaceId;
    const merged = [...new Set([...existing, ...reasons])].sort();
    bySource.set(key, {
      workspaceId,
      agent,
      complete: merged.length === 0,
      ...(merged.length ? { reasons: merged } : {}),
    });
    return workspaceId;
  };
  if (Array.isArray(coverage?.sources)) {
    for (const entry of coverage.sources) {
      const source = record(entry);
      if (!source) continue;
      const reasons = Array.isArray(source.reasons) ? source.reasons.filter(knownReason) : [];
      if (source.complete !== true && reasons.length === 0) reasons.push("source-partial");
      const workspaceId = update(source.workspaceId, source.agent, reasons);
      if (workspaceId !== undefined) observedWorkspaces.add(workspaceId);
    }
  } else if (Array.isArray(directory?.incompleteSources)) {
    for (const entry of directory.incompleteSources) {
      const source = record(entry);
      if (source) update(source.workspaceId, source.agent, ["source-partial"]);
    }
  }
  for (const session of scopedSessions) {
    if (!workspaces.has(session.workspace_id)) continue;
    const reasons: ConversationTaskSourceReason[] = [];
    const key = JSON.stringify([session.workspace_id, session.agent]);
    if (!bySource.has(key))
      reasons.push(coverage?.indexEnabled === false ? "index-disabled" : "coverage-unknown");
    if (session.readState?.freshness === "stale") reasons.push("read-state-stale");
    else if (!session.readState || session.readState.status === "unknown")
      reasons.push("coverage-unknown");
    const live = session.continuation;
    if (
      !live ||
      live.executionLocation === "external" ||
      unobservedRuntimeStatuses.has(live.status) ||
      live.reason === "dsh-native-status-unknown" ||
      live.ownershipReason === "dsh-native-status-unknown"
    )
      reasons.push("coverage-unknown");
    if (reasons.length) update(session.workspace_id, session.agent, reasons);
  }
  const sources = [...bySource.values()].sort(
    (a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.agent.localeCompare(b.agent),
  );
  const reasons: ConversationTaskSourceReason[] = [];
  if (coverage?.indexEnabled === false) reasons.push("index-disabled");
  // A limited reader cannot verify that the global managed registry reached all
  // of its workspaces. Do not reveal the status of that unscoped registry.
  if (
    !allWorkspaces ||
    typeof coverage?.indexEnabled !== "boolean" ||
    typeof coverage?.managedComplete !== "boolean" ||
    observedWorkspaces.size !== workspaces.size
  )
    reasons.push("coverage-unknown");
  if (allWorkspaces && coverage?.managedComplete === false) reasons.push("source-partial");
  return {
    complete: reasons.length === 0 && sources.every((source) => source.complete),
    sources,
    ...(reasons.length ? { reasons: reasons.sort() } : {}),
  };
}
