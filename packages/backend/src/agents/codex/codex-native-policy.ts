import { statSync } from "node:fs";
import path from "node:path";
import { canonicalize, pathIdentity } from "../../paths";

export type CodexNativePolicy =
  | {
      policyId:
        | "workspace-write-on-request"
        | "workspace-write-auto-review"
        | "full-access-on-request";
    }
  | { policyId: null; reason: string };

export const unconfirmedCodexNativePolicy = {
  policyId: null,
  reason: "native-policy-unconfirmed",
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** WorkspaceWrite includes cwd, even if it reports no additional roots. */
export function managedWritableRootsMatch(
  cwd: unknown,
  responseCwd: unknown,
  extraRoots: unknown,
): boolean {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !Array.isArray(extraRoots)) return false;
  try {
    const expected = pathIdentity(canonicalize(cwd));
    for (const root of [responseCwd, ...extraRoots]) {
      if (
        typeof root !== "string" ||
        !path.isAbsolute(root) ||
        !statSync(root).isDirectory() ||
        pathIdentity(canonicalize(root)) !== expected
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

const workspaceFields = new Set([
  "type",
  "writable_roots",
  "network_access",
  "exclude_tmpdir_env_var",
  "exclude_slash_tmp",
  "read_only_access",
]);

/** Map only known native permission combinations. Raw paths stay in the reader. */
export function readCodexNativeTurnPolicy(
  payload: Record<string, unknown>,
  indexedCwd: string,
): CodexNativePolicy | undefined {
  if (
    !Object.hasOwn(payload, "approval_policy") &&
    !Object.hasOwn(payload, "approvals_reviewer") &&
    !Object.hasOwn(payload, "sandbox_policy")
  )
    return;

  const sandbox = record(payload.sandbox_policy);
  const approval = payload.approval_policy;
  const reviewer = payload.approvals_reviewer;
  if (approval === undefined || typeof sandbox?.type !== "string")
    return unconfirmedCodexNativePolicy;

  const cwd = payload.cwd ?? indexedCwd;
  if (payload.cwd !== undefined && !managedWritableRootsMatch(indexedCwd, payload.cwd, []))
    return { policyId: null, reason: "native-policy-cwd-mismatch" };

  if (sandbox.type === "danger-full-access") {
    if (approval !== "never")
      return { policyId: null, reason: "native-policy-approval-policy-mismatch" };
    if (reviewer !== undefined && reviewer !== "user")
      return { policyId: null, reason: "native-policy-approvals-reviewer-mismatch" };
    if (Object.keys(sandbox).length !== 1)
      return { policyId: null, reason: "native-policy-sandbox-type-mismatch" };
    return { policyId: "full-access-on-request" };
  }

  if (
    sandbox.type !== "workspace-write" ||
    Object.keys(sandbox).some((key) => !workspaceFields.has(key))
  )
    return { policyId: null, reason: "native-policy-sandbox-type-mismatch" };
  if (approval !== "on-request")
    return { policyId: null, reason: "native-policy-approval-policy-mismatch" };
  if (reviewer !== "user" && reviewer !== "auto_review" && reviewer !== "agent")
    return { policyId: null, reason: "native-policy-approvals-reviewer-mismatch" };
  const { network_access: networkAccess = false, writable_roots: writableRoots = [] } = sandbox;
  if (networkAccess !== false)
    return { policyId: null, reason: "native-policy-sandbox-network-mismatch" };
  if (!managedWritableRootsMatch(indexedCwd, cwd, writableRoots))
    return { policyId: null, reason: "native-policy-sandbox-writable-roots-mismatch" };
  // Codex defaults both exclusions to false, so omission can add writable roots outside cwd.
  if (sandbox.exclude_tmpdir_env_var !== true)
    return { policyId: null, reason: "native-policy-sandbox-tmpdir-mismatch" };
  if (sandbox.exclude_slash_tmp !== true)
    return { policyId: null, reason: "native-policy-sandbox-slash-tmp-mismatch" };
  if (sandbox.read_only_access !== undefined) {
    const readAccess = record(sandbox.read_only_access);
    if (readAccess?.type !== "full-access" || Object.keys(readAccess).length !== 1)
      return { policyId: null, reason: "native-policy-sandbox-read-access-mismatch" };
  }
  return {
    policyId: reviewer === "user" ? "workspace-write-on-request" : "workspace-write-auto-review",
  };
}
