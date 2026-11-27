import type { ManagedRecord } from "./managed-records";
import {
  managedWritableRootsMatch,
  unconfirmedCodexNativePolicy,
  type CodexNativePolicy,
} from "./codex-native-policy";

export type CodexPolicyId = NonNullable<CodexNativePolicy["policyId"]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function managedPolicyCatalog() {
  return [
    {
      id: "workspace-write-on-request",
      name: "Workspace write · ask when needed",
      description: "Can edit the workspace; risky actions still require user approval.",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
    },
    {
      id: "full-access-on-request",
      name: "Full access · no approval prompts",
      description: "Can access the computer and network without prompting for approvals.",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      networkAccess: true,
    },
    {
      id: "workspace-write-auto-review",
      name: "Workspace write · agent review",
      description: "Can edit the workspace; the native agent reviews approval requests.",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      networkAccess: false,
    },
  ];
}

export function requireFullAccessForNativePolicy(policyId: unknown): void {
  if (policyId === "full-access-on-request" || policyId === "workspace-write-auto-review")
    throw new Error("native-policy-full-access-required");
}

export function codexPolicyOverride(record: ManagedRecord): boolean {
  // Older adopted records saved the default policy even without a choice. Older nondefault
  // selections, including a staged permission-only save, were explicit.
  return (
    record.policy_override ??
    (!!record.policy_id && record.policy_id !== "workspace-write-on-request")
  );
}

export function nativePolicySettings(
  record: ManagedRecord,
  settings: Record<string, unknown>,
  policy: CodexNativePolicy | undefined,
  following = false,
) {
  if (!policy) return {};
  const selected = isObject(settings.selected) ? settings.selected : {};
  const current = isObject(settings.current) ? settings.current : {};
  return {
    current: { ...current, policyId: policy.policyId },
    selected: {
      ...selected,
      policyId:
        !following && canReselectNativePolicy(policy) && reselectedCodexPolicy(record)
          ? record.policy_id
          : policy.policyId && !following && codexPolicyOverride(record)
            ? (record.policy_id ?? policy.policyId)
            : policy.policyId,
    },
  };
}

export function canReselectNativePolicy(
  policy: CodexNativePolicy | undefined,
): policy is { policyId: null; reason: typeof unconfirmedCodexNativePolicy.reason } {
  return policy?.policyId === null && policy.reason === unconfirmedCodexNativePolicy.reason;
}

export function reselectedCodexPolicy(record: ManagedRecord): CodexPolicyId | false {
  return (
    record.snapshot?.policyReselected === true &&
    record.snapshot?.settingsStaged === true &&
    record.policy_override === true &&
    isCodexPolicyId(record.policy_id) &&
    record.policy_id
  );
}

export function isCodexPolicyId(value: unknown): value is CodexPolicyId {
  return (
    value === "workspace-write-on-request" ||
    value === "workspace-write-auto-review" ||
    value === "full-access-on-request"
  );
}

export function nativePolicyWriteAccess(policy: CodexNativePolicy | undefined, blocked?: unknown) {
  if (policy?.policyId === null) return { available: false, reason: policy.reason };
  if (typeof blocked === "string") return { available: false, reason: blocked };
  return true;
}

export function managedResumeParams(
  record: ManagedRecord,
  workspace: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const params: Record<string, unknown> = { cwd: workspace, config };
  switch (record.policy_id ?? "workspace-write-on-request") {
    case "workspace-write-on-request":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    case "full-access-on-request":
      params.approvalPolicy = "never";
      params.approvalsReviewer = "user";
      params.sandboxPolicy = { type: "dangerFullAccess" };
      params.sandbox = "danger-full-access";
      break;
    case "workspace-write-auto-review":
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = "auto_review";
      params.sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      };
      params.sandbox = "workspace-write";
      config["sandbox_workspace_write.network_access"] = false;
      config["sandbox_workspace_write.writable_roots"] = [];
      config["sandbox_workspace_write.exclude_tmpdir_env_var"] = true;
      config["sandbox_workspace_write.exclude_slash_tmp"] = true;
      break;
    default:
      throw new Error("unsupported-policy");
  }
  return params;
}

export function managedTurnMode(record: ManagedRecord): string | null {
  if (record.mode) return record.mode;
  const native = record.native_settings;
  if (record.effort != null || !isObject(native) || typeof native.effort !== "string") return null;
  const mode = isObject(native.collaborationMode) ? native.collaborationMode.mode : null;
  // A null top-level effort inherits the previous native effort. The confirmed mode's
  // settings replace it, without choosing a different mode on the user's behalf.
  if (mode !== "default" && mode !== "plan")
    throw new Error("native-collaboration-modes-unavailable");
  return mode;
}

export function managedTurnSettings(
  record: ManagedRecord,
  workspace: string,
): Record<string, unknown> {
  const params = managedResumeParams(record, workspace);
  if (record.model) params.model = record.model;
  if (record.effort) params.effort = record.effort;
  // Omission inherits the native thread's previous tier; null explicitly clears Fast.
  params.serviceTier = record.service_tier ?? null;
  const mode = managedTurnMode(record);
  if (mode) {
    params.collaborationMode = {
      mode,
      settings: {
        model: record.model,
        reasoning_effort: record.effort,
        developer_instructions: null,
      },
    };
  }
  return params;
}

export function verifyManagedPolicy(
  record: ManagedRecord,
  response: Record<string, unknown>,
): void {
  const id = record.policy_id ?? "workspace-write-on-request";
  const full = id === "full-access-on-request";
  const expectedReviewer = id === "workspace-write-auto-review" ? "auto_review" : "user";
  const sandbox = isObject(response.sandbox) ? response.sandbox : {};
  if (
    response.approvalPolicy !== (full ? "never" : "on-request") ||
    response.approvalsReviewer !== expectedReviewer ||
    sandbox.type !== (full ? "dangerFullAccess" : "workspaceWrite")
  )
    throw new Error("codex-policy-mismatch");
  // Native WorkspaceWrite otherwise adds TMPDIR and /tmp outside writableRoots.
  if (
    !full &&
    (sandbox.networkAccess !== false ||
      sandbox.excludeTmpdirEnvVar !== true ||
      sandbox.excludeSlashTmp !== true ||
      !managedWritableRootsMatch(record.cwd, response.cwd, sandbox.writableRoots))
  )
    throw new Error("codex-sandbox-mismatch");
  if (record.service_tier && response.serviceTier !== record.service_tier)
    throw new Error("codex-service-tier-mismatch");
}

export function matchesConfirmedTurnPolicy(
  record: ManagedRecord,
  policyId: CodexPolicyId,
): boolean {
  const native = record.native_settings;
  if (!isObject(native)) return false;
  try {
    verifyManagedPolicy(
      { ...record, policy_id: policyId, service_tier: null },
      { ...native, cwd: record.cwd, sandbox: native.sandboxPolicy },
    );
    return true;
  } catch {
    return false;
  }
}
