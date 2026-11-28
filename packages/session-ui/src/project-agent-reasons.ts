import {
  ApiError,
  parseRemoteErrorCode,
  projectAgentRoleReason,
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CONTRACT,
  type RemoteErrorCode,
  type RemoteErrorRetry,
} from "@agentkib/web-client";

export type ProjectAgentLocale = "zh-CN" | "zh-Hant" | "ja-JP" | "en-US";

export function normalizeProjectAgentLocale(locale: string): ProjectAgentLocale {
  if (locale === "zh-Hant") return "zh-Hant";
  if (locale.startsWith("zh")) return "zh-CN";
  return locale.startsWith("ja") ? "ja-JP" : "en-US";
}

export type ProjectAgentRetryPolicy =
  | "never"
  | "after-user-action"
  | "after-refresh"
  | "after-backoff"
  | "reconcile-only";

export type ProjectAgentRecoveryKind =
  | "none"
  | "refresh"
  | "retry"
  | "reconcile"
  | "connect-terminal"
  | "integrations"
  | "workspaces"
  | "lead-panel"
  | "resume-delegation"
  | "devin-login";

export interface ProjectAgentFailure {
  code?: string;
  phrase: string;
  retry: ProjectAgentRetryPolicy;
  recovery: ProjectAgentRecoveryKind;
  outcomeUnknown: boolean;
}

const contractRetry = new Map<string, RemoteErrorRetry>(
  Object.values(REMOTE_ERROR_CONTRACT).map(({ code, retry }) => [code, retry]),
);

const plannedRetryOverrides: Record<string, ProjectAgentRetryPolicy> = {
  "session-is-a-worker": "after-user-action",
  "dsh-runtime-offline": "after-user-action",
  "codex-policy-mismatch": "after-user-action",
  "codex-sandbox-mismatch": "after-user-action",
  "codex-writable-roots-mismatch": "after-user-action",
  "codex-workspace-mismatch": "after-refresh",
  "remote-environment-not-supported": "after-user-action",
  "codex-app-server-unavailable": "after-backoff",
  "app-server-unavailable": "after-backoff",
  "session-busy": "after-backoff",
  invalid_input: "after-user-action",
  workspace_not_authorized: "after-user-action",
  permission_denied: "after-user-action",
  "invalid-lead-delegation": "after-user-action",
  "invalid-lead-turn-limit": "after-user-action",
  "invalid-lead-workspaces": "after-user-action",
  "lead-requires-managed-claude": "after-user-action",
  "lead-exists": "after-refresh",
  "lead-unavailable": "after-refresh",
  "worker-unavailable": "after-refresh",
  "worker-not-running": "after-refresh",
  "workspace-not-allowed": "after-user-action",
  "workspace-unavailable": "after-user-action",
  "worker-requires-codex-or-dsh-session": "never",
};

const phrases: Record<ProjectAgentLocale, Record<string, string>> = {
  "zh-CN": {
    unknown: "操作未完成",
    "antigravity-acp-disabled": "已停用",
    "lead-not-controllable": "不可控制",
    "worker-not-controllable": "不可控制",
    "lead-requires-managed-claude": "不可控制",
    "lead-claude-terminal-disconnected": "未连接",
    "worker-terminal-disconnected": "未连接",
    "dsh-runtime-offline": "未连接",
    "lead-tools-unavailable": "工具不可用",
    "worker-not-assigned": "指派已变化",
    "worker-assignment-changed": "指派已变化",
    "worker-unavailable": "指派已变化",
    "lead-unavailable": "指派已变化",
    "worker-probe-failed": "状态未读到",
    "worker-agent-unsupported": "角色不可用",
    "worker-requires-codex-or-dsh-session": "角色不可用",
    "worker-limit-reached": "名额已满",
    "worker-outside-project": "不在项目内",
    "invalid-lead-request": "指派无效",
    "invalid-lead-delegation": "指派无效",
    "invalid-lead-turn-limit": "指派无效",
    "invalid-lead-workspaces": "指派无效",
    "orchestration-unavailable": "委派暂不可用",
    "session-is-a-project-agent": "已任负责人",
    "lead-exists": "已任负责人",
    "session-is-a-worker": "已指派",
    "session-workspace-unavailable": "工作区不可用",
    "workspace-not-allowed": "工作区不可用",
    "workspace-unavailable": "工作区不可用",
    workspace_not_authorized: "无权修改",
    permission_denied: "无权修改",
    invalid_input: "输入无效",
    "delegation-paused": "已暂停",
    "dsh-session-controller-unavailable": "控制不可用",
    "dsh-session-ambiguous": "占用中",
    "dsh-session-in-use": "占用中",
    "codex-owner-busy": "占用中",
    "session-open-elsewhere": "占用中",
    "devin-auth-probe-failed": "登录状态未知",
    "devin-login-required": "未登录",
    "antigravity-login-required": "未登录",
    "devin-cli-unavailable": "未安装",
    "codex-cli-unavailable": "未安装",
    "antigravity-cli-unavailable": "未安装",
    "codex-cli-version-too-old": "版本过低",
    "unsupported-codex-cli-version": "版本过低",
    "devin-cli-update-required": "版本过低",
    "dsh-version-unsupported": "版本过低",
    "codex-cli-version-unavailable": "版本未核实",
    "codex-owner-check-unavailable": "状态未核实",
    "dsh-native-status-unknown": "状态未核实",
    "native-model-unconfirmed": "模型未核实",
    "native-effort-unconfirmed": "模型未核实",
    "codex-workspace-mismatch": "工作区不匹配",
    "remote-environment-not-supported": "远程环境不支持",
    "native-policy-mismatch": "权限设置不匹配",
    "codex-policy-mismatch": "权限设置不匹配",
    "codex-sandbox-mismatch": "权限设置不匹配",
    "codex-writable-roots-mismatch": "权限设置不匹配",
    "control-outcome-unconfirmed": "结果待核对",
    "worker-not-running": "未在运行",
    "session-busy": "会话忙碌",
    "codex-app-server-unavailable": "服务暂不可用",
    "app-server-unavailable": "服务暂不可用",
  },
  "zh-Hant": {
    unknown: "操作未完成",
    "antigravity-acp-disabled": "已停用",
    "lead-not-controllable": "不可控制",
    "worker-not-controllable": "不可控制",
    "lead-requires-managed-claude": "不可控制",
    "lead-claude-terminal-disconnected": "未連線",
    "worker-terminal-disconnected": "未連線",
    "dsh-runtime-offline": "未連線",
    "lead-tools-unavailable": "工具不可用",
    "worker-not-assigned": "指派已變更",
    "worker-assignment-changed": "指派已變更",
    "worker-unavailable": "指派已變更",
    "lead-unavailable": "指派已變更",
    "worker-probe-failed": "狀態未讀到",
    "worker-agent-unsupported": "角色不可用",
    "worker-requires-codex-or-dsh-session": "角色不可用",
    "worker-limit-reached": "名額已滿",
    "worker-outside-project": "不在專案內",
    "invalid-lead-request": "指派無效",
    "invalid-lead-delegation": "指派無效",
    "invalid-lead-turn-limit": "指派無效",
    "invalid-lead-workspaces": "指派無效",
    "orchestration-unavailable": "委派暫不可用",
    "session-is-a-project-agent": "已任負責人",
    "lead-exists": "已任負責人",
    "session-is-a-worker": "已指派",
    "session-workspace-unavailable": "工作區不可用",
    "workspace-not-allowed": "工作區不可用",
    "workspace-unavailable": "工作區不可用",
    workspace_not_authorized: "無權修改",
    permission_denied: "無權修改",
    invalid_input: "輸入無效",
    "delegation-paused": "已暫停",
    "dsh-session-controller-unavailable": "控制不可用",
    "dsh-session-ambiguous": "佔用中",
    "dsh-session-in-use": "佔用中",
    "codex-owner-busy": "佔用中",
    "session-open-elsewhere": "佔用中",
    "devin-auth-probe-failed": "登入狀態未知",
    "devin-login-required": "未登入",
    "antigravity-login-required": "未登入",
    "devin-cli-unavailable": "未安裝",
    "codex-cli-unavailable": "未安裝",
    "antigravity-cli-unavailable": "未安裝",
    "codex-cli-version-too-old": "版本過低",
    "unsupported-codex-cli-version": "版本過低",
    "devin-cli-update-required": "版本過低",
    "dsh-version-unsupported": "版本過低",
    "codex-cli-version-unavailable": "版本未核實",
    "codex-owner-check-unavailable": "狀態未核實",
    "dsh-native-status-unknown": "狀態未核實",
    "native-model-unconfirmed": "模型未核實",
    "native-effort-unconfirmed": "模型未核實",
    "codex-workspace-mismatch": "工作區不符",
    "remote-environment-not-supported": "遠端環境不支援",
    "native-policy-mismatch": "權限設定不符",
    "codex-policy-mismatch": "權限設定不符",
    "codex-sandbox-mismatch": "權限設定不符",
    "codex-writable-roots-mismatch": "權限設定不符",
    "control-outcome-unconfirmed": "結果待核對",
    "worker-not-running": "未在執行",
    "session-busy": "對話忙碌",
    "codex-app-server-unavailable": "服務暫不可用",
    "app-server-unavailable": "服務暫不可用",
  },
  "en-US": {
    unknown: "Action did not complete",
    "antigravity-acp-disabled": "Disabled",
    "lead-not-controllable": "Not controllable",
    "worker-not-controllable": "Not controllable",
    "lead-requires-managed-claude": "Not controllable",
    "lead-claude-terminal-disconnected": "Disconnected",
    "worker-terminal-disconnected": "Disconnected",
    "dsh-runtime-offline": "Disconnected",
    "lead-tools-unavailable": "Tools unavailable",
    "worker-not-assigned": "Assignment changed",
    "worker-assignment-changed": "Assignment changed",
    "worker-unavailable": "Assignment changed",
    "lead-unavailable": "Assignment changed",
    "worker-probe-failed": "Status unavailable",
    "worker-agent-unsupported": "Role unavailable",
    "worker-requires-codex-or-dsh-session": "Role unavailable",
    "worker-limit-reached": "Limit reached",
    "worker-outside-project": "Outside project",
    "invalid-lead-request": "Invalid assignment",
    "invalid-lead-delegation": "Invalid assignment",
    "invalid-lead-turn-limit": "Invalid assignment",
    "invalid-lead-workspaces": "Invalid assignment",
    "orchestration-unavailable": "Delegation unavailable",
    "session-is-a-project-agent": "Already Project Agent",
    "lead-exists": "Already Project Agent",
    "session-is-a-worker": "Already assigned",
    "session-workspace-unavailable": "Workspace unavailable",
    "workspace-not-allowed": "Workspace unavailable",
    "workspace-unavailable": "Workspace unavailable",
    workspace_not_authorized: "Permission required",
    permission_denied: "Permission required",
    invalid_input: "Invalid input",
    "delegation-paused": "Paused",
    "dsh-session-controller-unavailable": "Control unavailable",
    "dsh-session-ambiguous": "In use",
    "dsh-session-in-use": "In use",
    "codex-owner-busy": "In use",
    "session-open-elsewhere": "In use",
    "devin-auth-probe-failed": "Login status unknown",
    "devin-login-required": "Not signed in",
    "antigravity-login-required": "Not signed in",
    "devin-cli-unavailable": "Not installed",
    "codex-cli-unavailable": "Not installed",
    "antigravity-cli-unavailable": "Not installed",
    "codex-cli-version-too-old": "Version too old",
    "unsupported-codex-cli-version": "Version too old",
    "devin-cli-update-required": "Version too old",
    "dsh-version-unsupported": "Version too old",
    "codex-cli-version-unavailable": "Version unverified",
    "codex-owner-check-unavailable": "Status unverified",
    "dsh-native-status-unknown": "Status unverified",
    "native-model-unconfirmed": "Model unverified",
    "native-effort-unconfirmed": "Model unverified",
    "codex-workspace-mismatch": "Workspace mismatch",
    "remote-environment-not-supported": "Unsupported remotely",
    "native-policy-mismatch": "Permission settings mismatch",
    "codex-policy-mismatch": "Permission settings mismatch",
    "codex-sandbox-mismatch": "Permission settings mismatch",
    "codex-writable-roots-mismatch": "Permission settings mismatch",
    "control-outcome-unconfirmed": "Outcome unconfirmed",
    "worker-not-running": "Not running",
    "session-busy": "Session busy",
    "codex-app-server-unavailable": "Service unavailable",
    "app-server-unavailable": "Service unavailable",
  },
  "ja-JP": {
    unknown: "操作を完了できませんでした",
    "antigravity-acp-disabled": "無効",
    "lead-not-controllable": "制御不可",
    "worker-not-controllable": "制御不可",
    "lead-requires-managed-claude": "制御不可",
    "lead-claude-terminal-disconnected": "未接続",
    "worker-terminal-disconnected": "未接続",
    "dsh-runtime-offline": "未接続",
    "lead-tools-unavailable": "ツール利用不可",
    "worker-not-assigned": "割り当て変更済み",
    "worker-assignment-changed": "割り当て変更済み",
    "worker-unavailable": "割り当て変更済み",
    "lead-unavailable": "割り当て変更済み",
    "worker-probe-failed": "状態取得不可",
    "worker-agent-unsupported": "役割利用不可",
    "worker-requires-codex-or-dsh-session": "役割利用不可",
    "worker-limit-reached": "上限に到達",
    "worker-outside-project": "プロジェクト外",
    "invalid-lead-request": "無効な割り当て",
    "invalid-lead-delegation": "無効な割り当て",
    "invalid-lead-turn-limit": "無効な割り当て",
    "invalid-lead-workspaces": "無効な割り当て",
    "orchestration-unavailable": "委任利用不可",
    "session-is-a-project-agent": "責任者設定済み",
    "lead-exists": "責任者設定済み",
    "session-is-a-worker": "割り当て済み",
    "session-workspace-unavailable": "ワークスペース不可",
    "workspace-not-allowed": "ワークスペース不可",
    "workspace-unavailable": "ワークスペース不可",
    workspace_not_authorized: "変更権限なし",
    permission_denied: "変更権限なし",
    invalid_input: "入力が無効",
    "delegation-paused": "一時停止中",
    "dsh-session-controller-unavailable": "制御不可",
    "dsh-session-ambiguous": "使用中",
    "dsh-session-in-use": "使用中",
    "codex-owner-busy": "使用中",
    "session-open-elsewhere": "使用中",
    "devin-auth-probe-failed": "ログイン状態不明",
    "devin-login-required": "未ログイン",
    "antigravity-login-required": "未ログイン",
    "devin-cli-unavailable": "未インストール",
    "codex-cli-unavailable": "未インストール",
    "antigravity-cli-unavailable": "未インストール",
    "codex-cli-version-too-old": "バージョンが古い",
    "unsupported-codex-cli-version": "バージョンが古い",
    "devin-cli-update-required": "バージョンが古い",
    "dsh-version-unsupported": "バージョンが古い",
    "codex-cli-version-unavailable": "バージョン未確認",
    "codex-owner-check-unavailable": "状態未確認",
    "dsh-native-status-unknown": "状態未確認",
    "native-model-unconfirmed": "モデル未確認",
    "native-effort-unconfirmed": "モデル未確認",
    "codex-workspace-mismatch": "ワークスペース不一致",
    "remote-environment-not-supported": "リモート非対応",
    "native-policy-mismatch": "権限設定が不一致",
    "codex-policy-mismatch": "権限設定が不一致",
    "codex-sandbox-mismatch": "権限設定が不一致",
    "codex-writable-roots-mismatch": "権限設定が不一致",
    "control-outcome-unconfirmed": "結果を確認中",
    "worker-not-running": "未実行",
    "session-busy": "処理中",
    "codex-app-server-unavailable": "サービス利用不可",
    "app-server-unavailable": "サービス利用不可",
  },
};

const knownReasonTokens = [...new Set([...contractRetry.keys(), ...Object.keys(phrases["zh-CN"])])]
  .filter((code) => code !== "unknown")
  .sort((a, b) => b.length - a.length);

function normalizeReasonKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code.startsWith("native-policy-")) return "native-policy-mismatch";
  return code;
}

export function projectAgentReasonPhrase(
  locale: string,
  reason: string | null | undefined,
): string {
  const dict = phrases[normalizeProjectAgentLocale(locale)];
  if (!reason) return dict.unknown;
  const key = normalizeReasonKey(reason);
  return (key && dict[key]) ?? dict.unknown;
}

export function projectAgentReasonRetry(
  reason: string | null | undefined,
  outcomeUnknown = false,
): ProjectAgentRetryPolicy {
  if (outcomeUnknown || reason === "control-outcome-unconfirmed") return "reconcile-only";
  if (!reason) return "after-user-action";
  const fromContract = contractRetry.get(reason);
  if (fromContract && fromContract !== "unclassified") return fromContract;
  return plannedRetryOverrides[reason] ?? "after-user-action";
}

export function projectAgentRecoveryKind(
  reason: string | null | undefined,
  retry: ProjectAgentRetryPolicy,
  outcomeUnknown = false,
): ProjectAgentRecoveryKind {
  if (outcomeUnknown || retry === "reconcile-only") return "reconcile";
  if (retry === "never") return "none";
  switch (reason) {
    case "lead-claude-terminal-disconnected":
    case "worker-terminal-disconnected":
      return "connect-terminal";
    case "lead-tools-unavailable":
    case "dsh-session-controller-unavailable":
    case "dsh-session-ambiguous":
    case "dsh-runtime-offline":
      return "integrations";
    case "session-workspace-unavailable":
      return "workspaces";
    case "delegation-paused":
      return "resume-delegation";
    case "worker-limit-reached":
    case "session-is-a-project-agent":
    case "session-is-a-worker":
      return "lead-panel";
    case "devin-login-required":
      return "devin-login";
    default:
      break;
  }
  if (retry === "after-refresh") return "refresh";
  if (retry === "after-backoff") return "retry";
  return "none";
}

function extractReasonFromRecord(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  for (const candidate of [data?.reason, record.reason, data?.detail, record.detail, record.code]) {
    if (typeof candidate !== "string" || !candidate) continue;
    const known = projectAgentRoleReason(candidate) ?? parseRemoteErrorCode(candidate);
    if (known) return known;
    if (candidate in phrases["zh-CN"]) return candidate;
  }
  return undefined;
}

function extractReasonFromMessage(message: string): string | undefined {
  const tagged = /\[reason=([a-z0-9_-]+)\]/i.exec(message);
  if (tagged?.[1]) {
    const known = projectAgentRoleReason(tagged[1]) ?? parseRemoteErrorCode(tagged[1]);
    if (known) return known;
    if (tagged[1] in phrases["zh-CN"]) return tagged[1];
  }
  const direct = projectAgentRoleReason(message.trim()) ?? parseRemoteErrorCode(message.trim());
  if (direct) return direct;
  return knownReasonTokens.find((token) => message.includes(token));
}

export function extractProjectAgentFailure(error: unknown, locale: string): ProjectAgentFailure {
  let code: string | undefined;
  let outcomeUnknown = false;
  if (error instanceof ApiError) {
    outcomeUnknown = error.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown;
    code =
      error.reason ??
      (error.code !== "project_agent_failed" && error.code !== "request_failed"
        ? error.code
        : undefined);
  } else {
    code = extractReasonFromRecord(error);
    if (!code && error instanceof Error && error.message) {
      code = extractReasonFromMessage(error.message);
    } else if (!code && typeof error === "string") {
      code = extractReasonFromMessage(error);
    }
    if (error && typeof error === "object" && "controlOutcome" in error) {
      outcomeUnknown =
        (error as { controlOutcome?: unknown }).controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown;
    }
  }
  if (code === "project_agent_failed" || code === "request_failed") code = undefined;
  const effectiveCode: RemoteErrorCode | string | undefined = outcomeUnknown
    ? "control-outcome-unconfirmed"
    : code;
  const retry = projectAgentReasonRetry(effectiveCode, outcomeUnknown);
  const recovery = projectAgentRecoveryKind(effectiveCode, retry, outcomeUnknown);
  return {
    code: effectiveCode,
    phrase: projectAgentReasonPhrase(locale, effectiveCode),
    retry,
    recovery,
    outcomeUnknown: outcomeUnknown || effectiveCode === "control-outcome-unconfirmed",
  };
}
