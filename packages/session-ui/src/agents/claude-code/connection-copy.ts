import { CLAUDE_BRIDGE_CLI_VERSION, claudeBridgeCompatibility } from "@agentkib/web-client";
import { surfaceCopy, type SessionSurface } from "../../session-surface-copy";
type Locale = "zh-CN" | "zh-Hant" | "en-US" | "ja-JP";

const zh = {
  pluginInstalledVersion: "已安装 {version}",
  pluginNotInstalled: "用户范围未安装",
  pluginBundledVersion: "随包版本 {version}",
  pluginUpdating: "正在配置插件…",
  pluginUpdated: "插件已就绪。",
  pluginUpdateFailed: "插件更新失败。",
  pluginAutomatic: "自动安装终端插件",
  pluginAutomaticUnavailable: "暂时无法更改自动安装设置",
  pluginAutomaticOff: "自动安装已关闭",
  pluginScopes: "插件安装范围",
  pluginScopeUser: "所有项目（用户）",
  pluginScopeProject: "项目",
  pluginScopeLocal: "仅本地项目",
  pluginAutomaticFailed: "插件自动配置失败。",
  pluginInstallInstructions: "手动安装命令",
  pluginReload: "如果这个终端会话在插件安装或更新前已打开，请执行 /reload-plugins 或重开会话。",
  pluginRetry: "重试",
  codeExpiresSafety: "{time} 前有效 · 只在你自己的终端使用，不要发给别人",
  disconnectConfirmInfo: "确定断开？终端照常运行，AgentKib 停止同步。",
  pasteStep: "在终端粘贴并回车",
  waiting: "等待终端粘贴",
  connectedBadge: "已连接",
  expiredTitle: "连接码已过期",
  regenerate: "重新生成",
  reconnectingTitle: "等待终端重新连接",
  copyResumeCommand: "复制继续命令",
  regenerateConnection: "重新生成连接码",
  unsupportedTitle: "连接终端目前只支持 macOS",
  statusUnavailable: "暂时无法核实终端连接状态，请稍后检查连接。",
  copy: "复制",
  copyOptions: "更多复制选项",
  disconnectShort: "断开",
  expiresAt: "{time} 前有效",
  clearConnection: "清除连接…",
  confirmClearConnection: "确认清除连接",
  clearConnectionInfo: "清除后，这条会话在终端继续时不会再自动连接；以后要连接，需要新的连接码。",
  disconnectBeforeCode: "若要生成新的连接码，请先断开当前终端连接。",
  invalidCode: "连接码无效。请重新生成，并在目标终端使用完整的新连接码。",
  versionMismatch: "终端仍在使用旧版连接插件。",
  unknownVersion: "未知",
  cliUnsupported: "无法识别当前 Claude Code 版本。请更新 Claude Code 后重新连接。",
  cliTooOld: "当前是 Claude Code {version}，需要 {minimum} 或更高。更新 Claude Code 后重新连接。",
  pluginOutdated: "终端仍在使用旧版连接插件。",
  missingCapabilities:
    "Claude Code {version} 暂时不支持连接终端。可以继续在终端里使用，AgentKib 后续版本会适配。",
  identityMismatch: "目标终端与所选会话不匹配。请在所选会话的终端重新连接。",
  connectionUnconfirmed: "上次操作结果尚未确认。请先核对终端状态，再重新连接。",
  managedUnconfirmed:
    "上次操作及后台进程状态尚未确认，暂时无法在 AgentKib 中继续。你可以回到 Claude Code 继续这条会话；不会自动重发消息。",
  connectionLimit: "终端连接数量已达上限。请先断开不再使用的连接，再重试。",
  connectionRejected: "连接请求被拒绝。请检查终端与这台电脑状态后重新连接。",

  released: "后台进程已结束",
  releasedInfo: "后台进程已结束，下次发送时会自动继续",
  lostTitle: "终端连接已断开",
  hostDisconnected: "与这台电脑的连接已中断",
  hostDisconnectedInfo: "暂时无法核实终端状态。请检查与这台电脑的连接，恢复后再操作。",
  manage: "管理终端连接",
  platformUnsupported: "连接终端仅支持 macOS。请在 macOS 电脑上操作。",
  bridgeUnavailable: "终端连接服务无法启动。请检查这台电脑日志并重新启动 AgentKib 后重试。",
  requiredVersion: "需要 Claude Code",
  copyInstall: "复制安装命令",
  copyCommand: "复制连接命令",
  copyCode: "复制连接码",
  copied: "已复制",
  copyFailed: "复制失败，请手动选择并复制。",
  disconnectInfo: "断开后，终端照常运行，AgentKib 停止同步。",
  confirmDisconnect: "确认断开",
  cancel: "取消",
  disconnectFirst: "终端已连接，消息会发送到终端。",
  connectionFailed: "终端连接失败：",

  title: "连接终端",
  connected: "在终端中运行 · 已连接",
  managed: "在 AgentKib 中运行",
  history: "仅可查看",
  notConnected: "未连接",
  info: "审批和提问在终端中处理。关闭 AgentKib 不会停止终端。",
  disconnected: "尚未连接终端。请在所选 Claude Code 会话的终端中连接。",
  lost: "终端连接已断开，正在重新检查会话状态。",
  approval: "终端等待审批",
  question: "终端等待回答",
  gap: "事件同步出现缺口，正在重新读取快照和原生历史；恢复前暂停控制。",
  turnUnconfirmed: "终端正在执行，当前轮次身份尚未核实；暂不能取消，请在终端处理。",
  permissionUnconfirmed: "终端曾请求工具审批，当前授权或执行状态尚未核实，请查看终端。",
  attachments: "终端连接尚未验证附件输入，请在终端添加附件。",
  sendUnverified: "消息发送和停止请在终端处理，AgentKib 会同步显示。",
  generate: "生成连接码",
  disconnect: "断开终端连接",
  refresh: "检查连接",
  loading: "正在检查连接…",
  failed: "无法完成连接操作，请检查这台电脑状态后重试。",
  expires: "连接码有效至",
  expired: "连接码已过期，请重新生成。",
  autoConnect: "自动连接这个工作区的新对话",
  autoConnectFailed: "无法更改自动连接，请稍后重试。",
  localOnly: "插件安装和连接管理仅在这台电脑上的 AgentKib 提供。",
};
type Copy = { [K in keyof typeof zh]: string };
export const claudeConnectionCopy: Record<Locale, Copy> = {
  "zh-CN": zh,
  "zh-Hant": {
    pluginInstalledVersion: "已安裝 {version}",
    pluginNotInstalled: "使用者範圍未安裝",
    pluginBundledVersion: "隨附版本 {version}",
    pluginUpdating: "正在設定外掛…",
    pluginUpdated: "外掛已就緒。",
    pluginUpdateFailed: "外掛更新失敗。",
    pluginAutomatic: "自動安裝終端外掛",
    pluginAutomaticUnavailable: "暫時無法變更自動安裝設定",
    pluginAutomaticOff: "自動安裝已關閉",
    pluginScopes: "外掛安裝範圍",
    pluginScopeUser: "所有專案（使用者）",
    pluginScopeProject: "專案",
    pluginScopeLocal: "僅本機專案",
    pluginAutomaticFailed: "外掛自動設定失敗。",
    pluginInstallInstructions: "手動安裝命令",
    pluginReload: "如果這段終端對話在外掛安裝或更新前已開啟，請執行 /reload-plugins 或重開對話。",
    pluginRetry: "重試",
    codeExpiresSafety: "{time} 前有效 · 只在你自己的終端使用，不要傳給別人",
    disconnectConfirmInfo: "確定中斷？終端照常執行，AgentKib 停止同步。",
    pasteStep: "在終端貼上並按下 Enter",
    waiting: "等待在終端貼上",
    connectedBadge: "已連線",
    expiredTitle: "連線碼已過期",
    regenerate: "重新產生",
    reconnectingTitle: "等待終端重新連線",
    copyResumeCommand: "複製繼續命令",
    regenerateConnection: "重新產生連線碼",
    unsupportedTitle: "連接終端目前僅支援 macOS",
    statusUnavailable: "暫時無法核實終端連線狀態，請稍後檢查連線。",
    copy: "複製",
    copyOptions: "更多複製選項",
    disconnectShort: "中斷",
    expiresAt: "{time} 前有效",
    clearConnection: "清除連線…",
    confirmClearConnection: "確認清除連線",
    clearConnectionInfo:
      "清除後，這段對話在終端繼續時不會再自動連線；日後若要連線，需要新的連線碼。",
    disconnectBeforeCode: "若要產生新的連線碼，請先中斷目前終端連線。",
    invalidCode: "連線碼無效。請重新產生，並在目標終端使用完整的新連線碼。",
    versionMismatch: "終端仍在使用舊版連線外掛。",
    unknownVersion: "未知",
    cliUnsupported: "無法識別目前的 Claude Code 版本。請更新 Claude Code 後重新連接。",
    cliTooOld:
      "目前為 Claude Code {version}，需要 {minimum} 或以上版本。更新 Claude Code 後重新連接。",
    pluginOutdated: "終端仍在使用舊版連線外掛。",
    missingCapabilities:
      "Claude Code {version} 暫時不支援連接終端。可以繼續在終端裡使用，AgentKib 後續版本會適配。",
    identityMismatch: "目標終端與所選對話不符。請在所選對話的終端重新連接。",
    connectionUnconfirmed: "上次操作結果尚未確認。請先核對終端狀態，再重新連接。",
    managedUnconfirmed:
      "上次操作與背景程序狀態尚未確認，暫時無法在 AgentKib 中繼續。你可以回到 Claude Code 繼續這段對話；不會自動重送訊息。",
    connectionLimit: "終端連線數量已達上限。請先中斷不再使用的連線，再重試。",
    connectionRejected: "連線要求遭拒。請檢查終端與這台電腦狀態後重新連接。",

    released: "背景程序已結束",
    releasedInfo: "背景程序已結束，下次傳送訊息時會自動繼續",
    lostTitle: "終端連線已中斷",
    hostDisconnected: "與這台電腦的連線已中斷",
    hostDisconnectedInfo: "暫時無法核實終端狀態。請檢查與這台電腦的連線，恢復後再操作。",
    manage: "管理終端連線",
    platformUnsupported: "連接終端僅支援 macOS。請在 macOS 電腦上操作。",
    bridgeUnavailable: "終端連線服務無法啟動。請檢查這台電腦記錄並重新啟動 AgentKib 後重試。",
    requiredVersion: "需要 Claude Code",
    copyInstall: "複製安裝命令",
    copyCommand: "複製連線命令",
    copyCode: "複製連線碼",
    copied: "已複製",
    copyFailed: "複製失敗，請手動選取並複製。",
    disconnectInfo: "中斷後，終端照常執行，AgentKib 停止同步。",
    confirmDisconnect: "確認中斷",
    cancel: "取消",
    disconnectFirst: "終端已連線，訊息會傳送到終端。",
    connectionFailed: "終端連線失敗：",

    title: "連接終端",
    connected: "在終端中執行 · 已連線",
    managed: "在 AgentKib 中執行",
    history: "僅可查看",
    notConnected: "未連線",
    info: "核准和提問在終端中處理。關閉 AgentKib 不會停止終端。",
    disconnected: "尚未連接終端。請在所選 Claude Code 對話的終端中連接。",
    lost: "終端連線已中斷，正在重新檢查對話狀態。",
    approval: "終端等待核准",
    question: "終端等待回答",
    gap: "事件同步出現缺口，正在重新讀取快照與原生歷史；恢復前暫停控制。",
    turnUnconfirmed: "終端正在執行，目前輪次身分尚未核實；暫時無法取消，請在終端處理。",
    permissionUnconfirmed: "終端曾要求工具審批，目前授權或執行狀態尚未核實，請查看終端。",
    attachments: "終端連線尚未驗證附件輸入，請在終端新增附件。",
    sendUnverified: "訊息傳送和停止請在終端處理，AgentKib 會同步顯示。",
    generate: "產生連線碼",
    disconnect: "中斷終端連線",
    refresh: "檢查連線",
    loading: "正在檢查連線…",
    failed: "無法完成連線操作，請檢查這台電腦狀態後重試。",
    expires: "連線碼有效至",
    expired: "連線碼已過期，請重新產生。",
    autoConnect: "自動連接這個工作區的新對話",
    autoConnectFailed: "無法變更自動連接，請稍後重試。",
    localOnly: "外掛安裝與連線管理僅在這台電腦上的 AgentKib 提供。",
  },
  "en-US": {
    pluginInstalledVersion: "Installed {version}",
    pluginNotInstalled: "Not installed at user scope",
    pluginBundledVersion: "Bundled {version}",
    pluginUpdating: "Setting up the plugin…",
    pluginUpdated: "Plugin ready.",
    pluginUpdateFailed: "Plugin update failed.",
    pluginAutomatic: "Automatically install the terminal plugin",
    pluginAutomaticUnavailable: "The automatic installation setting is currently unavailable",
    pluginAutomaticOff: "Automatic installation is off",
    pluginScopes: "Plugin installation scopes",
    pluginScopeUser: "All projects (user)",
    pluginScopeProject: "Project",
    pluginScopeLocal: "Local project only",
    pluginAutomaticFailed: "Automatic plugin setup failed.",
    pluginInstallInstructions: "Manual installation commands",
    pluginReload:
      "If this terminal session was open before the plugin was installed or updated, run /reload-plugins or restart the session.",
    pluginRetry: "Retry",
    codeExpiresSafety: "Valid until {time} · Use only in your own terminal. Do not share it.",
    disconnectConfirmInfo: "Disconnect? The terminal keeps running; AgentKib stops synchronizing.",
    pasteStep: "Paste into the terminal and press Enter",
    waiting: "Waiting for terminal paste",
    connectedBadge: "Connected",
    expiredTitle: "Connection code expired",
    regenerate: "Generate again",
    reconnectingTitle: "Waiting for the terminal to reconnect",
    copyResumeCommand: "Copy resume command",
    regenerateConnection: "Generate a new connection code",
    unsupportedTitle: "Connecting a terminal is currently supported only on macOS",
    statusUnavailable:
      "The terminal connection status cannot be checked right now. Check the connection again shortly.",
    copy: "Copy",
    copyOptions: "More copy options",
    disconnectShort: "Disconnect",
    expiresAt: "Valid until {time}",
    clearConnection: "Clear connection…",
    confirmClearConnection: "Clear connection",
    clearConnectionInfo:
      "After clearing, resuming this session in the terminal will no longer connect automatically. You will need a new connection code to connect again.",
    disconnectBeforeCode:
      "Disconnect the current terminal before generating a new connection code.",
    invalidCode:
      "The connection code is invalid. Generate a new code and use it in full in the target terminal.",
    versionMismatch: "This terminal is still using an older connection plugin.",
    unknownVersion: "unknown",
    cliUnsupported:
      "The current Claude Code version could not be identified. Update Claude Code, then reconnect.",
    cliTooOld:
      "You are using Claude Code {version}; {minimum} or later is required. Update Claude Code, then reconnect.",
    pluginOutdated: "This terminal is still using an older connection plugin.",
    missingCapabilities:
      "Claude Code {version} does not currently support connecting a terminal. You can keep using it in the terminal; a future AgentKib release will add support.",
    identityMismatch:
      "The terminal does not match the selected session. Reconnect from that session’s terminal.",
    connectionUnconfirmed:
      "The previous outcome is unconfirmed. Check the terminal state before reconnecting.",
    managedUnconfirmed:
      "The previous operation and background process state are unconfirmed, so this session cannot continue in AgentKib yet. You can continue it in Claude Code. Messages will not be resent automatically.",
    connectionLimit:
      "The terminal connection limit was reached. Disconnect unused connections and retry.",
    connectionRejected:
      "The connection request was rejected. Check the terminal and computer, then reconnect.",

    released: "Background process ended",
    releasedInfo:
      "The background process ended. It will resume automatically when you send your next message.",
    lostTitle: "Terminal disconnected",
    hostDisconnected: "Computer connection lost",
    hostDisconnectedInfo:
      "The terminal's state cannot be checked. Restore the connection to this computer before continuing.",
    manage: "Manage terminal connection",
    platformUnsupported: "Connecting the terminal requires macOS. Use a macOS computer.",
    bridgeUnavailable:
      "The terminal bridge could not start. Check the logs on this computer and restart AgentKib before retrying.",
    requiredVersion: "Requires Claude Code",
    copyInstall: "Copy install command",
    copyCommand: "Copy connection command",
    copyCode: "Copy connection code",
    copied: "Copied",
    copyFailed: "Copy failed. Select and copy the text manually.",
    disconnectInfo: "The terminal keeps running after disconnection. AgentKib stops synchronizing.",
    confirmDisconnect: "Confirm disconnect",
    cancel: "Cancel",
    disconnectFirst: "The terminal is connected. Messages are sent to the terminal.",
    connectionFailed: "Terminal connection failed: ",

    title: "Connect terminal",
    connected: "Running in terminal · Connected",
    managed: "Running in AgentKib",
    history: "View only",
    notConnected: "Not connected",
    info: "Handle approvals and questions in the terminal. Closing AgentKib does not stop the terminal.",
    disconnected:
      "The terminal is not connected. Connect from the selected Claude Code session's terminal.",
    lost: "The terminal disconnected. Rechecking the session state.",
    approval: "Terminal awaiting approval",
    question: "Terminal awaiting an answer",
    gap: "Some live events were missed. Reloading the snapshot and native history; controls are paused until recovery.",
    turnUnconfirmed:
      "The terminal is running, but the current turn identity is unconfirmed. Cancel in the terminal for now.",
    permissionUnconfirmed:
      "The terminal requested tool approval. Its current approval or execution state is unconfirmed; check the terminal.",
    attachments:
      "Attachment input is not verified for terminal connections. Add attachments in the terminal.",
    sendUnverified:
      "Send messages and stop turns in the terminal. AgentKib keeps the session in sync.",
    generate: "Generate connection code",
    disconnect: "Disconnect terminal",
    refresh: "Check connection",
    loading: "Checking connection…",
    failed: "The connection operation failed. Check the state of this computer and try again.",
    expires: "Connection code expires at",
    expired: "The connection code expired. Generate a new one.",
    autoConnect: "Connect new sessions in this workspace automatically",
    autoConnectFailed: "Could not change automatic connection. Try again later.",
    localOnly:
      "Plugin installation and connection management are only available in AgentKib on this computer.",
  },
  "ja-JP": {
    pluginInstalledVersion: "インストール済み {version}",
    pluginNotInstalled: "ユーザースコープに未インストール",
    pluginBundledVersion: "同梱バージョン {version}",
    pluginUpdating: "プラグインを設定中…",
    pluginUpdated: "プラグインの準備ができました。",
    pluginUpdateFailed: "プラグインを更新できませんでした。",
    pluginAutomatic: "ターミナルプラグインを自動でインストール",
    pluginAutomaticUnavailable: "現在、自動インストール設定を変更できません",
    pluginAutomaticOff: "自動インストールはオフです",
    pluginScopes: "プラグインのインストール範囲",
    pluginScopeUser: "すべてのプロジェクト（ユーザー）",
    pluginScopeProject: "プロジェクト",
    pluginScopeLocal: "ローカルプロジェクトのみ",
    pluginAutomaticFailed: "プラグインの自動設定に失敗しました。",
    pluginInstallInstructions: "手動インストールのコマンド",
    pluginReload:
      "インストールや更新の前から開いているターミナルセッションでは、/reload-plugins を実行するか、セッションを開き直してください。",
    pluginRetry: "再試行",
    codeExpiresSafety:
      "{time} まで有効 · 自分のターミナルでのみ使用し、他の人に共有しないでください。",
    disconnectConfirmInfo: "切断しますか？ターミナルは実行を続け、AgentKib は同期を停止します。",
    pasteStep: "ターミナルに貼り付けて Enter を押す",
    waiting: "ターミナルへの貼り付け待ち",
    connectedBadge: "接続済み",
    expiredTitle: "接続コードの期限切れ",
    regenerate: "再生成",
    reconnectingTitle: "ターミナルの再接続を待っています",
    copyResumeCommand: "再開コマンドをコピー",
    regenerateConnection: "接続コードを再生成",
    unsupportedTitle: "ターミナル接続は現在 macOS のみ対応です",
    statusUnavailable:
      "ターミナルの接続状態を現在確認できません。しばらくしてから接続を確認してください。",
    copy: "コピー",
    copyOptions: "その他のコピー操作",
    disconnectShort: "切断",
    expiresAt: "{time} まで有効",
    clearConnection: "接続をクリア…",
    confirmClearConnection: "接続をクリア",
    clearConnectionInfo:
      "クリアすると、この会話をターミナルで再開しても自動接続しなくなります。再び接続するには、新しい接続コードが必要です。",
    disconnectBeforeCode:
      "新しい接続コードを生成するには、現在のターミナル接続を先に切断してください。",
    invalidCode:
      "接続コードが無効です。新しいコードを生成し、対象ターミナルで完全なコードを使用してください。",
    versionMismatch: "ターミナルは古い接続プラグインを使用しています。",
    unknownVersion: "不明",
    cliUnsupported:
      "現在の Claude Code のバージョンを確認できません。Claude Code を更新してから再接続してください。",
    cliTooOld:
      "現在の Claude Code は {version} です。{minimum} 以降が必要です。Claude Code を更新してから再接続してください。",
    pluginOutdated: "ターミナルは古い接続プラグインを使用しています。",
    missingCapabilities:
      "Claude Code {version} は現在ターミナル接続に対応していません。ターミナルでは引き続き利用できます。AgentKib の今後のバージョンで対応します。",
    identityMismatch:
      "ターミナルが選択した会話と一致しません。その会話のターミナルから再接続してください。",
    connectionUnconfirmed:
      "前回の操作結果が未確認です。ターミナルの状態を確認してから再接続してください。",
    managedUnconfirmed:
      "前の操作とバックグラウンドプロセスの状態を確認できないため、AgentKib ではまだ会話を続けられません。Claude Code に戻ってこの会話を続けられます。メッセージは自動で再送されません。",
    connectionLimit:
      "ターミナルの接続数が上限に達しました。未使用の接続を切断して再試行してください。",
    connectionRejected:
      "接続要求が拒否されました。ターミナルとこのコンピューターを確認して再接続してください。",

    released: "バックグラウンドプロセスを終了",
    releasedInfo:
      "バックグラウンドプロセスを終了しました。次のメッセージ送信時に自動で続行します。",
    lostTitle: "ターミナルとの接続が切断",
    hostDisconnected: "このコンピューターとの接続が切れました",
    hostDisconnectedInfo:
      "ターミナルの状態を確認できません。このコンピューターとの接続を復旧してから操作してください。",
    manage: "ターミナル接続を管理",
    platformUnsupported:
      "ターミナルへの接続は macOS のみ対応です。macOS のコンピューターで操作してください。",
    bridgeUnavailable:
      "ターミナルブリッジを起動できません。このコンピューターのログを確認し、AgentKib を再起動して再試行してください。",
    requiredVersion: "必要な Claude Code",
    copyInstall: "インストールコマンドをコピー",
    copyCommand: "接続コマンドをコピー",
    copyCode: "接続コードをコピー",
    copied: "コピーしました",
    copyFailed: "コピーに失敗しました。手動でテキストを選択してコピーしてください。",
    disconnectInfo: "切断後もターミナルは実行を続け、AgentKib は同期を停止します。",
    confirmDisconnect: "切断を確認",
    cancel: "キャンセル",
    disconnectFirst: "ターミナルに接続済みです。メッセージはターミナルに送信されます。",
    connectionFailed: "ターミナルへの接続に失敗しました：",

    title: "ターミナルに接続",
    connected: "ターミナルで実行中 · 接続済み",
    managed: "AgentKib で実行中",
    history: "閲覧のみ",
    notConnected: "未接続",
    info: "承認と質問はターミナルで対応してください。AgentKib を閉じてもターミナルは停止しません。",
    disconnected:
      "ターミナルに未接続です。選択した Claude Code 会話のターミナルから接続してください。",
    lost: "ターミナルとの接続が切れました。会話の状態を再確認しています。",
    approval: "ターミナルの承認待ち",
    question: "ターミナルの回答待ち",
    gap: "イベントの欠落を検出しました。スナップショットと元の履歴を再取得しています。復旧まで操作は停止します。",
    turnUnconfirmed:
      "ターミナルは実行中ですが、現在のターンIDは未確認です。キャンセルはターミナルで行ってください。",
    permissionUnconfirmed:
      "ターミナルでツール承認が要求されました。現在の承認・実行状態は未確認です。ターミナルを確認してください。",
    attachments: "ターミナル接続の添付入力は未検証です。ターミナルで追加してください。",
    sendUnverified:
      "メッセージの送信とターンの停止はターミナルで行ってください。AgentKib に同期して表示されます。",
    generate: "接続コードを生成",
    disconnect: "ターミナルとの接続を解除",
    refresh: "接続を確認",
    loading: "接続を確認中…",
    failed: "接続操作に失敗しました。このコンピューターの状態を確認して再試行してください。",
    expires: "接続コードの有効期限",
    expired: "接続コードの期限が切れました。再生成してください。",
    autoConnect: "このワークスペースの新しい会話を自動で接続",
    autoConnectFailed: "自動接続を変更できませんでした。しばらくしてからもう一度お試しください。",
    localOnly:
      "プラグインのインストールと接続管理は、このコンピューター上の AgentKib でのみ利用できます。",
  },
};

export function claudeConnectionReason(
  locale: Locale,
  reason?: string,
  surface: SessionSurface = "desktop",
  details?: { cliVersion?: string },
) {
  const copy = claudeConnectionCopyForSurface(locale, surface);
  const observed = details?.cliVersion;
  const version =
    typeof observed === "string" && claudeBridgeCompatibility(observed) !== "invalid"
      ? observed
      : copy.unknownVersion;
  switch (reason) {
    case "expired-bridge-challenge":
      return copy.expired;
    case "invalid-bridge-challenge":
      return copy.invalidCode;
    case "bridge-version-mismatch":
      return copy.versionMismatch;
    case "bridge-cli-too-old":
      return copy.cliTooOld
        .replace("{version}", version)
        .replace("{minimum}", CLAUDE_BRIDGE_CLI_VERSION);
    case "bridge-cli-unsupported":
      return copy.cliUnsupported;
    case "bridge-plugin-update-required":
      return copy.pluginOutdated;
    case "bridge-capabilities-missing":
      return copy.missingCapabilities.replace("{version}", version);
    case "bridge-identity-mismatch":
    case "unsupported-native-identity":
    case "native-identity-changed":
      return copy.identityMismatch;

    case "claude-bridge-binding-limit":
      return copy.connectionLimit;
    case "bridge-request-rejected":
      return copy.connectionRejected;
    case "platform-unsupported":
      return copy.platformUnsupported;
    case "claude-bridge-unavailable":
      return copy.bridgeUnavailable;
    case "claude-bridge-not-connected":
      return copy.disconnected;
    case "claude-bridge-disconnected":
      return copy.lost;
    case "claude-terminal-approval":
      return copy.approval;
    case "claude-bridge-event-gap":
      return copy.gap;
    case "claude-follower-turn-unconfirmed":
      return copy.turnUnconfirmed;
    case "claude-terminal-permission-unconfirmed":
      return copy.permissionUnconfirmed;
    case "claude-terminal-question":
      return copy.question;
    case "claude-follower-send-unverified":
      return copy.sendUnverified;
    case "claude-follower-attachments-unavailable":
      return copy.attachments;
    default:
      return undefined;
  }
}

const webStatus: Record<
  Locale,
  Pick<
    Copy,
    | "approval"
    | "question"
    | "disconnected"
    | "lost"
    | "turnUnconfirmed"
    | "permissionUnconfirmed"
    | "sendUnverified"
    | "attachments"
    | "connectionUnconfirmed"
    | "cliTooOld"
    | "pluginOutdated"
  >
> = {
  "zh-CN": {
    approval: "等待工具审批",
    question: "等待回答",
    disconnected: "终端未连接。",
    lost: "终端连接已断开。",
    turnUnconfirmed: "当前轮次尚未核实。",
    permissionUnconfirmed: "当前审批状态尚未核实。",
    sendUnverified: "当前会话仅供查看。",
    attachments: "当前会话无法发送附件。",
    connectionUnconfirmed: "上次操作结果尚未确认。",
    cliTooOld: "Claude Code {version} 低于连接所需版本 {minimum}。",
    pluginOutdated: "终端插件版本低于连接要求。",
  },
  "zh-Hant": {
    approval: "等待工具核准",
    question: "等待回答",
    disconnected: "終端未連線。",
    lost: "終端連線已中斷。",
    turnUnconfirmed: "目前輪次尚未確認。",
    permissionUnconfirmed: "目前核准狀態尚未確認。",
    sendUnverified: "目前的對話僅供查看。",
    attachments: "目前的對話無法傳送附件。",
    connectionUnconfirmed: "上次操作結果尚未確認。",
    cliTooOld: "Claude Code {version} 低於連線所需版本 {minimum}。",
    pluginOutdated: "終端外掛版本低於連線要求。",
  },
  "en-US": {
    approval: "Tool approval pending",
    question: "Answer pending",
    disconnected: "The terminal is disconnected.",
    lost: "The terminal connection ended.",
    turnUnconfirmed: "The current turn is unconfirmed.",
    permissionUnconfirmed: "The current approval status is unconfirmed.",
    sendUnverified: "This session is read-only.",
    attachments: "Attachments are unavailable in this session.",
    connectionUnconfirmed: "The last operation's outcome is unconfirmed.",
    cliTooOld: "Claude Code {version} is below the minimum supported version {minimum}.",
    pluginOutdated: "The terminal plugin is below the supported version.",
  },
  "ja-JP": {
    approval: "ツールの承認待ち",
    question: "回答待ち",
    disconnected: "ターミナルに未接続です。",
    lost: "ターミナルとの接続が切れました。",
    turnUnconfirmed: "現在のターンは未確認です。",
    permissionUnconfirmed: "現在の承認状況は未確認です。",
    sendUnverified: "この会話は読み取り専用です。",
    attachments: "この会話では添付ファイルを送信できません。",
    connectionUnconfirmed: "前回の操作結果は未確認です。",
    cliTooOld: "Claude Code {version} は接続に必要な最小バージョン {minimum} より古いです。",
    pluginOutdated: "ターミナルのプラグインは接続に必要なバージョンより古いです。",
  },
};
const webCopies = new Map<Locale, Copy>();

export function claudeConnectionCopyForSurface(
  locale: Locale,
  surface: SessionSurface = "desktop",
) {
  if (surface === "desktop") return claudeConnectionCopy[locale];
  let copy = webCopies.get(locale);
  if (!copy) {
    copy = {
      ...surfaceCopy(claudeConnectionCopy[locale], surface, locale),
      ...webStatus[locale],
    };
    webCopies.set(locale, copy);
  }
  return copy;
}
