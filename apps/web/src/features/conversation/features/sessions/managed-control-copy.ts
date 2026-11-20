import type { Locale } from "../../i18n";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";

export type ManagedControlBlockReason =
  | "tool"
  | "access"
  | "protocol"
  | "experimental"
  | "management"
  | "send";

export const managedControlCopy: Record<Locale, Record<ManagedControlBlockReason, string>> = {
  "en-US": {
    tool: "The execution tool is unavailable. Check its installation and connection on this computer, then refresh the session.",
    access: "Access is not approved. Reconnect and approve access in AgentKib on this computer.",
    protocol:
      "The connection protocol is incompatible. Update AgentKib on this computer and reconnect.",
    experimental:
      "Execution management is not enabled. Enable it in Web settings in AgentKib on this computer, then refresh.",
    management:
      "This device lacks management permission. Authorize it in Web settings in AgentKib on this computer, then reconnect.",
    send: "This access does not include permission to send. Check its permissions on the computer running AgentKib.",
  },
  "zh-CN": {
    tool: "执行工具暂不可用。请在这台电脑检查安装和连接，再刷新会话。",
    access: "访问尚未获批。请重新连接，并在这台电脑上的 AgentKib 批准访问。",
    protocol: "连接协议不兼容。请更新这台电脑上的 AgentKib 并重新连接。",
    experimental: "尚未启用执行管理。请在这台电脑上的 AgentKib 的 Web 设置中启用，再刷新。",
    management: "此设备没有管理权限。请在这台电脑上的 AgentKib 的 Web 设置中授权，再重新连接。",
    send: "当前访问没有发送权限。请在运行 AgentKib 的电脑上检查此访问的权限。",
  },
  "zh-Hant": {
    tool: "執行工具暫不可用。請在這台電腦檢查安裝和連線，再重新整理對話。",
    access: "存取尚未獲准。請重新連線，並在這台電腦上的 AgentKib 批准存取。",
    protocol: "連線協定不相容。請更新這台電腦上的 AgentKib 並重新連線。",
    experimental: "尚未啟用執行管理。請在這台電腦上的 AgentKib 的 Web 設定中啟用，再重新整理。",
    management: "此裝置沒有管理權限。請在這台電腦上的 AgentKib 的 Web 設定中授權，再重新連線。",
    send: "目前存取沒有傳送權限。請在執行 AgentKib 的電腦上檢查此存取的權限。",
  },
  "ja-JP": {
    tool: "実行ツールは現在利用できません。このコンピューターでインストールと接続を確認し、会話を更新してください。",
    access: "アクセスが未承認です。再接続し、このコンピューター上の AgentKib で承認してください。",
    protocol:
      "接続プロトコルに互換性がありません。このコンピューター上の AgentKib を更新して再接続してください。",
    experimental:
      "実行管理が無効です。このコンピューター上の AgentKib の Web 設定で有効にし、更新してください。",
    management:
      "このデバイスには管理権限がありません。このコンピューター上の AgentKib の Web 設定で許可し、再接続してください。",
    send: "現在のアクセスでは送信できません。AgentKib を実行しているコンピューターで、このアクセスの権限を確認してください。",
  },
};

export function managedControlCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(managedControlCopy[locale], surface, locale);
}
