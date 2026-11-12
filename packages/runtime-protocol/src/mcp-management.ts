/** Desktop-only MCP management DTOs. Secrets are accepted only in write requests. */
export interface McpDiagnosticMessage {
  key: string;
  params?: Record<string, string | number>;
}
export type McpAgent =
  | "codex"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "open-claw"
  | "hermes"
  | "grok-build"
  | "antigravity"
  | "deepseek-harness"
  | "devin";
export type ManagedMcpServer = {
  id: string;
  name: string;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  targets: McpAgent[];
  allow_tools: string[];
  lan_allow_tools: string[];
  supports_parallel_tool_calls: boolean;
  required_env?: string[];
  required_headers?: string[];
  package?: {
    kind: "npm" | "pypi" | "remote" | "local";
    identifier: string;
    version?: string | null;
  } | null;
} & (
  | { transport: "stdio"; command: string; args: string[]; cwd?: string | null }
  | { transport: "streamable-http" | "sse"; url: string }
);
export interface McpManagedEntry {
  config: ManagedMcpServer;
  scope: "global" | "workspace";
  inherited: boolean;
  required_env: string[];
  required_headers: string[];
  configured_env: string[];
  configured_headers: string[];
  oauth_configured: boolean;
}
export interface McpManagementState {
  revision: string;
  servers: McpManagedEntry[];
}
export type McpSecretOperation =
  | { action: "keep" }
  | { action: "replace"; value: string }
  | { action: "delete" };
export interface McpSaveRequest {
  project?: string;
  revision: string;
  server: ManagedMcpServer;
  secretOperations?: {
    env?: Record<string, McpSecretOperation>;
    headers?: Record<string, McpSecretOperation>;
  };
  overrideInherited?: boolean;
  originalId?: string;
}
export interface McpImportItem {
  key: string;
  config?: ManagedMcpServer;
  status: "new" | "identical" | "conflict" | "blocked";
  warnings: string[];
  warning_messages?: McpDiagnosticMessage[];
  required_env: string[];
  required_headers: string[];
}
export interface McpImportPreview {
  token: string;
  revision: string;
  items: McpImportItem[];
}
export interface McpImportRequest {
  project?: string;
  text?: string;
  candidateIds?: string[];
}
export interface McpImportSelection {
  key: string;
  action: "add" | "replace" | "skip";
  id?: string;
}
export interface McpImportApplyRequest {
  project?: string;
  token: string;
  revision: string;
  selections: McpImportSelection[];
}
export interface McpImportReport {
  revision: string;
  results: {
    key: string;
    id?: string;
    status: "saved" | "skipped" | "failed";
    error?: string;
    error_message?: McpDiagnosticMessage;
  }[];
}
export interface McpBatchConnectionRequest {
  workspaceId: string;
  targetAgents?: McpAgent[];
  all?: boolean;
  rebindAgents?: McpAgent[];
}
export interface McpBatchConnectionTarget {
  agent: McpAgent;
  status: "missing" | "correct" | "repair" | "other-workspace" | "blocked" | "uninstalled";
  reason?: string;
  reason_message?: McpDiagnosticMessage;
  target?: string;
  scope?: string;
  selected: boolean;
}
export interface McpBatchConnectionCheck {
  workspace_id: string;
  targets: McpBatchConnectionTarget[];
}
export interface McpBatchConnectionPlan extends McpBatchConnectionCheck {
  token: string;
  requires_home_approval: boolean;
  changes: { target: string; scope: string; before?: string | null; after: string }[];
}
export interface McpBatchConnectionReport {
  success?: boolean;
  message?: string;
  diagnostics?: McpDiagnosticMessage[];
  backup_dir?: string;
  recovery?: { target: string; status: "restored" | "unconfirmed"; backup?: string }[];
  targets: {
    agent: McpAgent;
    status: string;
    reason?: string;
    reason_message?: McpDiagnosticMessage;
  }[];
}
export interface McpToolPolicyRule {
  agent: McpAgent;
  server_id: string | null;
  mode: "inherit" | "all" | "selected";
  tools: string[];
}
export interface McpPolicyTool {
  server_id: string;
  name: string;
  description?: string;
  input_schema: unknown;
  read_only: boolean;
}
export interface McpToolPolicySnapshot {
  revision: string;
  rules: McpToolPolicyRule[];
  inherited_rules: McpToolPolicyRule[];
  effective_rules: McpToolPolicyRule[];
  catalog: { server_id: string | null; name: string; tools: McpPolicyTool[]; probed: boolean }[];
}

export interface McpMigrationPreview {
  token: string;
  revision: string;
  requires_home_approval: boolean;
  changes: { target: string; scope: string; before: string; after: string }[];
}
export interface McpMigrationResult {
  changeset_id: string;
  applied: string[];
  backup_dir: string;
}
