import { CLAUDE_BRIDGE_CLI_VERSION, claudeBridgeCompatibility } from "@agentkib/web-client";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";
type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";

const zh = {
  flow: "在终端里继续这条会话，AgentKib 同步显示；发送、停止和审批都在终端里做。",
  platformVersion: "仅 macOS · 需要 Claude Code {version} 或更高版本",
  installStep: "安装插件（只需一次）",
  installedStep: "已安装插件",
  codeExpiresSafety: "{time} 前有效 · 只在你自己的终端使用，不要发给别人",
  disconnectConfirmInfo: "确定断开？终端照常运行，AgentKib 停止同步。",
  generateStep: "生成连接码",
  pasteStep: "在终端粘贴并回车",
  pasteHint: "粘贴后，这里会显示连接状态",
  waiting: "等待连接…",
  connectedBadge: "已连接",
  connectedTitle: "已连接终端",
  connectedInfo: "在终端中继续这条会话，这里会同步显示",
  expiredTitle: "连接码已过期",
  expiredInfo: "重新生成后，把新的连接命令粘贴到终端。",
  regenerate: "重新生成",
  reconnectingTitle: "等待终端重新连接",
  reconnectingInfo: "在终端继续这条会话后会自动连接，不需要新的连接码。",
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
  versionMismatch: "终端里的连接插件需要更新。按第 1 步重新安装后，重新生成连接码。",
  unknownVersion: "未知",
  cliUnsupported: "无法识别当前 Claude Code 版本。请更新 Claude Code 后重新连接。",
  cliTooOld: "当前是 Claude Code {version}，需要 {minimum} 或更高。更新 Claude Code 后重新连接。",
  pluginOutdated: "终端里的连接插件需要更新。按第 1 步重新安装后，重新生成连接码。",
  pluginOutdatedAuto:
    "终端里的连接插件需要更新。按第 1 步更新后，这条会话会自动连接，不需要新的连接码。",
  missingCapabilities:
    "Claude Code {version} 暂时不支持连接终端。可以继续在终端里使用，AgentKib 后续版本会适配。",
  unverifiedVersion: "Claude Code {version} 还没有验证过，同步显示可能不完整",
  identityMismatch: "目标终端与所选会话不匹配。请在所选会话的终端重新连接。",
  connectionUnconfirmed: "上次操作结果尚未确认。请先核对终端状态，再重新连接。",
  managedUnconfirmed:
    "上次操作及后台进程状态尚未确认，暂时无法在 AgentKib 中继续。你可以回到 Claude Code 继续这条会话；不会自动重发消息。",
  connectionLimit: "终端连接数量已达上限。请先断开不再使用的连接，再重试。",
  connectionRejected: "连接请求被拒绝。请检查终端与这台电脑状态后重新连接。",

  handoff: "可以继续",
  handoffInfo: "直接输入即可继续这条会话。",
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
  codeSafety: "只在你自己的终端使用，不要发给别人",
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
  approval: "正在等待工具审批，请在终端处理。",
  question: "正在等待问题回答，请在终端处理。",
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
  instructions: "先按以下指引安装插件，再在目标终端执行连接命令；连接本身不会发送消息。",
  autoConnect: "自动连接这个工作区的新对话",
  autoConnectInfo:
    "装好插件后，这个工作区里新开的 Claude Code 对话会自动连上，不需要连接码；手动断开过的对话不会自动重连。已授权的手机也能看到这些对话。",
  autoConnectHint: "装好最新插件后，直接在终端里继续这条会话也会自动连接。",
  autoConnectFailed: "无法更改自动连接，请稍后重试。",
  localOnly: "插件安装和连接管理仅在这台电脑上的 AgentKib 提供。",
};
type Copy = { [K in keyof typeof zh]: string };
export const claudeConnectionCopy: Record<Locale, Copy> = {
  "zh-CN": zh,
  "zh-TW": {
    flow: "在終端裡繼續這段對話，AgentKib 同步顯示；傳送、停止和審批都在終端裡進行。",
    platformVersion: "僅 macOS · 需要 Claude Code {version} 或以上版本",
    installStep: "安裝外掛（只需一次）",
    installedStep: "已安裝外掛",
    codeExpiresSafety: "{time} 前有效 · 只在你自己的終端使用，不要傳給別人",
    disconnectConfirmInfo: "確定中斷？終端照常執行，AgentKib 停止同步。",
    generateStep: "產生連線碼",
    pasteStep: "在終端貼上並按下 Enter",
    pasteHint: "貼上後，這裡會顯示連線狀態",
    waiting: "等待連線…",
    connectedBadge: "已連線",
    connectedTitle: "已連接終端",
    connectedInfo: "在終端中繼續這段對話，這裡會同步顯示",
    expiredTitle: "連線碼已過期",
    expiredInfo: "重新產生後，把新的連線命令貼到終端。",
    regenerate: "重新產生",
    reconnectingTitle: "等待終端重新連線",
    reconnectingInfo: "在終端繼續這段對話後會自動連線，不需要新的連線碼。",
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
    versionMismatch: "終端裡的連線外掛需要更新。依第 1 步重新安裝後，重新產生連線碼。",
    unknownVersion: "未知",
    cliUnsupported: "無法識別目前的 Claude Code 版本。請更新 Claude Code 後重新連接。",
    cliTooOld:
      "目前為 Claude Code {version}，需要 {minimum} 或以上版本。更新 Claude Code 後重新連接。",
    pluginOutdated: "終端裡的連線外掛需要更新。依第 1 步重新安裝後，重新產生連線碼。",
    pluginOutdatedAuto:
      "終端裡的連線外掛需要更新。依第 1 步更新後，這段對話會自動連接，不需要新的連線碼。",
    missingCapabilities:
      "Claude Code {version} 暫時不支援連接終端。可以繼續在終端裡使用，AgentKib 後續版本會適配。",
    unverifiedVersion: "Claude Code {version} 尚未驗證過，同步顯示可能不完整",
    identityMismatch: "目標終端與所選對話不符。請在所選對話的終端重新連接。",
    connectionUnconfirmed: "上次操作結果尚未確認。請先核對終端狀態，再重新連接。",
    managedUnconfirmed:
      "上次操作與背景程序狀態尚未確認，暫時無法在 AgentKib 中繼續。你可以回到 Claude Code 繼續這段對話；不會自動重送訊息。",
    connectionLimit: "終端連線數量已達上限。請先中斷不再使用的連線，再重試。",
    connectionRejected: "連線要求遭拒。請檢查終端與這台電腦狀態後重新連接。",

    handoff: "可以繼續",
    handoffInfo: "直接輸入即可繼續這段對話。",
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
    codeSafety: "只在你自己的終端使用，不要傳給別人",
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
    approval: "正在等待工具審批，請在終端處理。",
    question: "正在等待問題回答，請在終端處理。",
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
    instructions: "先依照以下指引安裝外掛，再於目標終端執行連線命令；連線本身不會傳送訊息。",
    autoConnect: "自動連接這個工作區的新對話",
    autoConnectInfo:
      "裝好外掛後，這個工作區裡新開的 Claude Code 對話會自動連上，不需要連線碼；手動斷開過的對話不會自動重連。已授權的手機也能看到這些對話。",
    autoConnectHint: "裝好最新外掛後，直接在終端裡繼續這段對話也會自動連接。",
    autoConnectFailed: "無法變更自動連接，請稍後重試。",
    localOnly: "外掛安裝與連線管理僅在這台電腦上的 AgentKib 提供。",
  },
  "en-US": {
    flow: "Continue this session in the terminal; AgentKib keeps it in sync. Send messages, stop turns, and handle approvals in the terminal.",
    platformVersion: "macOS only · Requires Claude Code {version} or later",
    installStep: "Install the plugin (once)",
    installedStep: "Plugin installed",
    codeExpiresSafety: "Valid until {time} · Use only in your own terminal. Do not share it.",
    disconnectConfirmInfo: "Disconnect? The terminal keeps running; AgentKib stops synchronizing.",
    generateStep: "Generate connection code",
    pasteStep: "Paste into the terminal and press Enter",
    pasteHint: "The connection status will appear here after you paste",
    waiting: "Waiting for connection…",
    connectedBadge: "Connected",
    connectedTitle: "Terminal connected",
    connectedInfo: "Continue this session in the terminal. It stays in sync here.",
    expiredTitle: "Connection code expired",
    expiredInfo: "Generate a new code and paste the new connection command into the terminal.",
    regenerate: "Generate again",
    reconnectingTitle: "Waiting for the terminal to reconnect",
    reconnectingInfo:
      "Continue this session in the terminal to reconnect automatically. No new connection code is needed.",
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
    versionMismatch:
      "The terminal connection plugin needs an update. Reinstall it using step 1, then generate a new connection code.",
    unknownVersion: "unknown",
    cliUnsupported:
      "The current Claude Code version could not be identified. Update Claude Code, then reconnect.",
    cliTooOld:
      "You are using Claude Code {version}; {minimum} or later is required. Update Claude Code, then reconnect.",
    pluginOutdated:
      "The terminal connection plugin needs an update. Reinstall it using step 1, then generate a new connection code.",
    pluginOutdatedAuto:
      "The terminal connection plugin needs an update. After you update it with step 1, this session connects automatically; no new code is needed.",
    missingCapabilities:
      "Claude Code {version} does not currently support connecting a terminal. You can keep using it in the terminal; a future AgentKib release will add support.",
    unverifiedVersion:
      "Claude Code {version} has not been verified yet. Synchronized content may be incomplete.",
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

    handoff: "Ready to continue",
    handoffInfo: "Type a message to continue this session.",
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
    codeSafety: "Use this code only in your own terminal. Do not share it with others.",
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
    approval: "Waiting for tool approval. Please handle it in the terminal.",
    question: "Waiting for an answer. Please respond in the terminal.",
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
    instructions:
      "Install the plugin using the guide below, then run its connection command in the target terminal. Connecting does not send a message.",
    autoConnect: "Connect new sessions in this workspace automatically",
    autoConnectInfo:
      "Once the plugin is installed, new Claude Code sessions in this workspace connect without a code. Sessions you disconnected stay disconnected. Authorized phones can also see these sessions.",
    autoConnectHint:
      "With the latest plugin installed, you can also just continue this session in the terminal; it connects automatically.",
    autoConnectFailed: "Could not change automatic connection. Try again later.",
    localOnly:
      "Plugin installation and connection management are only available in AgentKib on this computer.",
  },
  "ja-JP": {
    flow: "この会話はターミナルで続け、AgentKib に同期して表示します。送信、停止、承認はターミナルで行ってください。",
    platformVersion: "macOS のみ · Claude Code {version} 以降が必要です",
    installStep: "プラグインをインストール（初回のみ）",
    installedStep: "プラグインをインストール済み",
    codeExpiresSafety:
      "{time} まで有効 · 自分のターミナルでのみ使用し、他の人に共有しないでください。",
    disconnectConfirmInfo: "切断しますか？ターミナルは実行を続け、AgentKib は同期を停止します。",
    generateStep: "接続コードを生成",
    pasteStep: "ターミナルに貼り付けて Enter を押す",
    pasteHint: "貼り付けると、ここに接続状態が表示されます",
    waiting: "接続待ち…",
    connectedBadge: "接続済み",
    connectedTitle: "ターミナルに接続済み",
    connectedInfo: "この会話はターミナルで続けてください。ここにも同期して表示されます。",
    expiredTitle: "接続コードの期限切れ",
    expiredInfo: "再生成して、新しい接続コマンドをターミナルに貼り付けてください。",
    regenerate: "再生成",
    reconnectingTitle: "ターミナルの再接続を待っています",
    reconnectingInfo:
      "ターミナルでこの会話を再開すると、自動で再接続します。新しい接続コードは不要です。",
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
    versionMismatch:
      "ターミナルの接続プラグインを更新する必要があります。手順 1 に従って再インストールし、新しい接続コードを生成してください。",
    unknownVersion: "不明",
    cliUnsupported:
      "現在の Claude Code のバージョンを確認できません。Claude Code を更新してから再接続してください。",
    cliTooOld:
      "現在の Claude Code は {version} です。{minimum} 以降が必要です。Claude Code を更新してから再接続してください。",
    pluginOutdated:
      "ターミナルの接続プラグインを更新する必要があります。手順 1 に従って再インストールし、新しい接続コードを生成してください。",
    pluginOutdatedAuto:
      "ターミナルの接続プラグインを更新する必要があります。手順 1 で更新すると、この会話は自動で接続されます。新しい接続コードは不要です。",
    missingCapabilities:
      "Claude Code {version} は現在ターミナル接続に対応していません。ターミナルでは引き続き利用できます。AgentKib の今後のバージョンで対応します。",
    unverifiedVersion:
      "Claude Code {version} はまだ検証されていません。同期表示が不完全な場合があります。",
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

    handoff: "続行可能",
    handoffInfo: "メッセージを入力すると、この会話を続けられます。",
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
    codeSafety: "接続コードは自分のターミナルでのみ使用し、他の人に共有しないでください。",
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
    approval: "ツールの承認待ちです。ターミナルで処理してください。",
    question: "回答待ちです。ターミナルで回答してください。",
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
    instructions:
      "以下のガイドでプラグインをインストールし、対象ターミナルで接続コマンドを実行してください。接続自体はメッセージを送信しません。",
    autoConnect: "このワークスペースの新しい会話を自動で接続",
    autoConnectInfo:
      "プラグインをインストールすると、このワークスペースで新しく始めた Claude Code の会話は接続コードなしで接続されます。切断した会話は自動では再接続しません。許可したスマートフォンでもこれらの会話を表示できます。",
    autoConnectHint:
      "最新のプラグインを入れていれば、ターミナルでこの会話を続けるだけで自動で接続されます。",
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

const webDisconnected: Record<Locale, string> = {
  "zh-CN": "尚未连接终端。请在电脑上的 AgentKib 打开连接指引，并在目标 Claude Code 会话中连接。",
  "zh-TW": "尚未連接終端。請在電腦上的 AgentKib 開啟連線指引，並在目標 Claude Code 對話中連接。",
  "en-US":
    "The terminal is not connected. Open the connection guide in AgentKib on your computer and connect from the target Claude Code session.",
  "ja-JP":
    "ターミナルに未接続です。コンピューター上の AgentKib で接続ガイドを開き、対象の Claude Code 会話から接続してください。",
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
      disconnected: webDisconnected[locale],
    };
    webCopies.set(locale, copy);
  }
  return copy;
}
