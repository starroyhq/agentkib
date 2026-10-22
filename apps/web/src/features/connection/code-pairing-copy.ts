import type { Locale } from "@/features/conversation/i18n";

export const codePairingCopy: Record<
  Locale,
  { title: string; info: string; code: string; connect: string; scope: string; safety: string }
> = {
  "zh-CN": {
    title: "输入授权码，连接电脑",
    info: "输入电脑上的 AgentKib 显示的授权码，即可直接连接，无需再次确认。",
    code: "授权码",
    connect: "连接并开始使用",
    scope:
      "授权后可访问 AgentKib 的全部工作区（包括以后新增的工作区），控制任务、处理审批及查看文件和产物。",
    safety:
      "授权码 5 分钟内有效，使用一次即失效。仅分享给可信设备；电脑可随时撤销访问。Codex 的执行审批仍由你决定。",
  },
  "zh-TW": {
    title: "輸入授權碼，連接電腦",
    info: "輸入電腦上的 AgentKib 顯示的授權碼，即可直接連線，無需再次確認。",
    code: "授權碼",
    connect: "連線並開始使用",
    scope:
      "授權後可存取 AgentKib 的全部工作區（包括之後新增的工作區），控制任務、處理審批及查看檔案和產物。",
    safety:
      "授權碼 5 分鐘內有效，使用一次即失效。僅分享給可信裝置；電腦可隨時撤銷存取。Codex 的執行審批仍由你決定。",
  },
  "en-US": {
    title: "Enter an access code to connect",
    info: "Enter the access code shown in AgentKib on your computer. No second confirmation is needed.",
    code: "Access code",
    connect: "Connect and start using",
    scope:
      "Access includes all current and future AgentKib workspaces, task control, approvals, files and artifacts.",
    safety:
      "The code expires in 5 minutes and can be used once. Share it only with trusted devices; revoke access from your computer at any time. Codex execution approvals still require your decision.",
  },
  "ja-JP": {
    title: "認証コードでパソコンに接続",
    info: "コンピューター上の AgentKib に表示された認証コードを入力すると、追加の確認なしで接続できます。",
    code: "認証コード",
    connect: "接続して利用する",
    scope:
      "現在および今後追加されるすべての AgentKib ワークスペースにアクセスし、タスクの操作、承認、ファイルと成果物の閲覧ができます。",
    safety:
      "コードは 5 分間有効で、1 回のみ利用できます。信頼できるデバイスにだけ共有してください。パソコンからいつでもアクセスを取り消せます。Codex の実行承認は引き続き利用者が判断します。",
  },
};
