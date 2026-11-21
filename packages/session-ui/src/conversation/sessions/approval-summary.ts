import type { Approval } from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";

const operations = {
  "zh-CN": { command: "执行命令", files: "文件变更", permissions: "权限请求" },
  "zh-Hant": { command: "執行命令", files: "檔案變更", permissions: "權限請求" },
  "en-US": {
    command: "Command execution",
    files: "File changes",
    permissions: "Permission request",
  },
  "ja-JP": { command: "コマンド実行", files: "ファイル変更", permissions: "権限リクエスト" },
};

export function approvalSummary(
  approval: Approval,
  locale: InteractionLocale,
  unknownTool: string,
) {
  if (typeof approval.toolName === "string" && approval.toolName.trim())
    return approval.toolName.trim();
  const call = approval.toolCall;
  if (
    call &&
    typeof call === "object" &&
    !Array.isArray(call) &&
    "title" in call &&
    typeof call.title === "string" &&
    call.title.trim()
  )
    return call.title.trim();
  // Codex approvals identify the operation by method rather than a tool name.
  const copy = operations[locale];
  switch (approval.method) {
    case "item/commandExecution/requestApproval":
      return copy.command;
    case "item/fileChange/requestApproval":
      return copy.files;
    case "item/permissions/requestApproval":
      return copy.permissions;
    default:
      return unknownTool;
  }
}
