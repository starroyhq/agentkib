import { surfaceCopy, surfaceText, type SessionSurface } from "./session-surface-copy";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import { claudeConnectionReason } from "./claude-connection-copy";
import { localizedUnavailableReasonText } from "../../live-status";
type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";
const zh = {
  composerHint: "空闲时发送；运行中可停止，获授权后可追加或加入待发队列。队列消息将自动执行。",
  queueTooLarge: "待发队列超过 100 条，此处暂不允许编辑或排序。",
  queueAttachments: "含附件的待发消息暂不支持编辑正文，可删除后重新添加。",
  keep: "保持当前设置",
  pendingInfo: "汇总本页已查看会话的待处理事项及当前访问尚未确认的请求。",
  title: "Codex 控制",
  capabilities: "这台电脑能力",
  unavailable: "这台电脑未提供或尚未验证此能力",
  permission: "当前访问没有附件上传权限。",
  inspect: "检查会话状态",
  steer: "追加到当前轮次",
  queue: "待发队列",
  queueAdd: "加入队列（将自动执行）",
  queueUpdate: "修改",
  queueDelete: "移除",
  queueUp: "上移",
  queueStart: "开始队列",
  queueEmpty: "队列为空",
  rename: "重命名",
  archive: "归档",
  unarchive: "取消归档",
  fork: "分支会话",
  delete: "删除",
  deleteTitle: "永久删除这个会话？",
  deleteCodexDetail:
    "会话会从 Codex 中删除，Codex Desktop 和终端里也不再显示，不能恢复。AgentKib 里的记录和这个会话的上传文件一并删除。",
  deleteClaudeDetail:
    "会话记录会从 Claude Code 中删除，claude --resume 里也不再显示，不能恢复。AgentKib 里的记录和这个会话的上传文件一并删除。",
  deleteConfirm: "永久删除",
  deleteOwnerBusy: "Codex Desktop 或终端里的 Codex 正占用这个会话，退出那边后再删除。",
  deleteClaudeOwnerBusy: "终端里的 Claude Code 正在使用这个会话，退出后再删除。",
  cancel: "取消",
  name: "会话名称",
  settings: "下一轮设置",
  changeNextTurnModel: "更改下一轮模型",
  model: "模型",
  effort: "思考强度",
  mode: "协作模式",
  default: "这台电脑默认",
  plan: "计划",
  normal: "执行",
  apply: "应用到下一轮",
  attachment: "添加附件",
  attachmentNote: "选择文件或粘贴图片；上传只暂存，发送后才加入会话。",
  previewAttachment: "预览附件",
  uploading: "上传中",
  uploadFailed: "上传失败，请重新选择文件",
  remove: "移除附件",
  limit: "最多选择 10 个附件",
  pending: "待处理中心",
  pendingEmpty: "没有待处理事项",
  refresh: "刷新",
  advanced: "更多操作",
  native: "原客户端审批选项",
  mcpDeclineOnly:
    "这个 MCP 请求需要填写内容或打开链接，AgentKib 还不支持，只能拒绝。拒绝后 Codex 会继续本轮。",
  once: "仅本次",
  session: "本会话",
  persistent: "持久规则",
  unavailableQueue: "无法读取队列",
  accepted: "请求已接收，请以原客户端显示的状态为准",
  context: "原客户端上下文",
  secret: "敏感回答不会保存为草稿",
  unknown: "上次操作结果尚未确认，正在查询请求处理状态；不会自动重发",
  error: "读取失败，请刷新",
  confirmation: "确认操作",
  close: "关闭",
  text: "消息内容",
  conversationSettings: "会话设置",
  restoreDefaults: "恢复这台电脑默认",
  serviceTier: "服务档位",
  executionPolicy: "执行策略",
  contextUsage: "上下文用量",
  contextUnknown: "这台电脑尚未提供上下文窗口用量",
  settingUnavailable: "此会话暂不支持修改该设置",
  settingsWhileRunning: "当前轮次结束后才能修改设置",
  settingsSaved: "设置已由这台电脑确认",
  goals: "持续目标",
  goalObjective: "目标内容",
  goalBudget: "Token 预算（可选）",
  goalCreate: "开始目标",
  goalUpdate: "更新目标",
  goalPause: "暂停",
  goalResume: "恢复并继续执行",
  goalClear: "清除目标",
  goalUnavailable: "这台电脑尚未提供目标管理",
  goalStatus: "状态",
  goalUsage: "消耗",
  goalElapsed: "运行时间",
  addContext: "添加上下文",
  uploadFromPhone: "选择附件文件",
  computerFiles: "电脑文件与文件夹",
  skillsPlugins: "技能、插件与应用",
  resourceSearch: "搜索可用资源",
  resourceEmpty: "没有可用资源",
  resourceUnavailable: "这台电脑尚未提供受控上下文引用",
  resourceRemoved: "资源已失效，请重新选择",
  fullAccessRequired: "请使用新的完整授权码连接后操作",
  directoryReference: "文件夹仅作为引用，不会递归上传",
  defaultOption: "默认",
};
type Copy = { [K in keyof typeof zh]: string };
export const codexCopy: Record<Locale, Copy> = {
  "zh-CN": zh,
  "zh-TW": {
    previewAttachment: "預覽附件",
    composerHint: "閒置時傳送；執行中可停止，獲授權後可追加或加入待發佇列。佇列訊息將自動執行。",
    queueTooLarge: "待發佇列超過 100 條，此處暫不允許編輯或排序。",
    queueAttachments: "含附件的待傳送訊息暫不支援編輯內文，可刪除後重新新增。",
    keep: "保持目前設定",
    pendingInfo: "彙整此頁已查看對話的待處理事項及目前存取尚未確認的請求。",
    title: "Codex 控制",
    capabilities: "這台電腦能力",
    unavailable: "這台電腦未提供或尚未驗證此能力",
    permission: "目前存取沒有附件上傳權限。",
    inspect: "檢查對話狀態",
    steer: "追加到目前輪次",
    queue: "待發佇列",
    queueAdd: "加入佇列（將自動執行）",
    queueUpdate: "修改",
    queueDelete: "移除",
    queueUp: "上移",
    queueStart: "開始佇列",
    queueEmpty: "佇列為空",
    rename: "重新命名",
    archive: "封存",
    unarchive: "取消封存",
    fork: "分支對話",
    delete: "刪除",
    deleteTitle: "永久刪除這段對話？",
    deleteCodexDetail:
      "對話會從 Codex 中刪除，Codex Desktop 與終端機裡也不再顯示，無法復原。AgentKib 裡的紀錄和這段對話的上傳檔案一併刪除。",
    deleteClaudeDetail:
      "對話紀錄會從 Claude Code 中刪除，claude --resume 裡也不再顯示，無法復原。AgentKib 裡的紀錄和這段對話的上傳檔案一併刪除。",
    deleteConfirm: "永久刪除",
    deleteOwnerBusy: "Codex Desktop 或終端機裡的 Codex 正占用這段對話，結束那邊後再刪除。",
    deleteClaudeOwnerBusy: "終端機裡的 Claude Code 正在使用這段對話，結束後再刪除。",
    cancel: "取消",
    name: "對話名稱",
    settings: "下一輪設定",
    changeNextTurnModel: "變更下一輪模型",
    model: "模型",
    effort: "思考強度",
    mode: "協作模式",
    default: "這台電腦預設",
    plan: "計畫",
    normal: "執行",
    apply: "套用至下一輪",
    attachment: "新增附件",
    attachmentNote: "選取檔案或貼上圖片；上傳僅暫存，傳送後才加入對話。",
    uploading: "上傳中",
    uploadFailed: "上傳失敗，請重新選取檔案",
    remove: "移除附件",
    limit: "最多選取 10 個附件",
    pending: "待處理中心",
    pendingEmpty: "沒有待處理事項",
    refresh: "重新整理",
    advanced: "更多操作",
    native: "原客戶端審批選項",
    mcpDeclineOnly:
      "這個 MCP 請求需要填寫內容或開啟連結，AgentKib 尚不支援，只能拒絕。拒絕後 Codex 會繼續這一輪。",
    once: "僅本次",
    session: "本對話",
    persistent: "持久規則",
    unavailableQueue: "無法讀取佇列",
    accepted: "請求已接收，請以原客戶端顯示的狀態為準",
    context: "原客戶端上下文",
    secret: "敏感回答不會儲存為草稿",
    unknown: "上次操作結果尚未確認，正在查詢請求處理狀態；不會自動重傳",
    error: "讀取失敗，請重新整理",
    confirmation: "確認操作",
    close: "關閉",
    text: "訊息內容",
    conversationSettings: "對話設定",
    restoreDefaults: "恢復這台電腦預設",
    serviceTier: "服務等級",
    executionPolicy: "執行策略",
    contextUsage: "上下文用量",
    contextUnknown: "這台電腦尚未提供上下文視窗用量",
    settingUnavailable: "此對話暫不支援修改此設定",
    settingsWhileRunning: "目前輪次結束後才能修改設定",
    settingsSaved: "設定已由這台電腦確認",
    goals: "持續目標",
    goalObjective: "目標內容",
    goalBudget: "Token 預算（選填）",
    goalCreate: "開始目標",
    goalUpdate: "更新目標",
    goalPause: "暫停",
    goalResume: "恢復並繼續執行",
    goalClear: "清除目標",
    goalUnavailable: "這台電腦尚未提供目標管理",
    goalStatus: "狀態",
    goalUsage: "用量",
    goalElapsed: "執行時間",
    addContext: "新增上下文",
    uploadFromPhone: "選取附件檔案",
    computerFiles: "電腦檔案與資料夾",
    skillsPlugins: "技能、外掛與應用程式",
    resourceSearch: "搜尋可用資源",
    resourceEmpty: "沒有可用資源",
    resourceUnavailable: "這台電腦尚未提供受控上下文引用",
    resourceRemoved: "資源已失效，請重新選取",
    fullAccessRequired: "請使用新的完整授權碼連線後操作",
    directoryReference: "資料夾僅作為引用，不會遞迴上傳",
    defaultOption: "預設",
  },
  "en-US": {
    previewAttachment: "Preview attachment",
    composerHint:
      "Send when idle. While running, stop or—with permission—steer or queue messages. Queued messages execute automatically.",
    queueTooLarge: "The queue exceeds 100 items. Editing and reordering are disabled here.",
    queueAttachments:
      "Queued messages with attachments cannot be edited yet. Remove and add them again instead.",
    keep: "Keep current settings",
    pendingInfo:
      "Pending actions from sessions viewed on this page and unconfirmed requests from this access.",
    title: "Codex controls",
    capabilities: "Computer capabilities",
    unavailable: "The computer does not provide or has not verified this capability",
    permission: "This access does not include permission to upload attachments.",
    inspect: "Inspect session state",
    steer: "Add to current turn",
    queue: "Queued messages",
    queueAdd: "Queue for automatic execution",
    queueUpdate: "Edit",
    queueDelete: "Remove",
    queueUp: "Move up",
    queueStart: "Start queue",
    queueEmpty: "Queue is empty",
    rename: "Rename",
    archive: "Archive",
    unarchive: "Unarchive",
    fork: "Fork session",
    delete: "Delete",
    deleteTitle: "Delete this session permanently?",
    deleteCodexDetail:
      "The session is deleted in Codex, so Codex Desktop and the terminal no longer show it. This can't be undone. AgentKib's records and this session's uploads are deleted too.",
    deleteClaudeDetail:
      "The session's transcript is deleted from Claude Code, so claude --resume no longer lists it. This can't be undone. AgentKib's records and this session's uploads are deleted too.",
    deleteConfirm: "Delete permanently",
    deleteOwnerBusy:
      "Codex Desktop or Codex in a terminal is using this session. Quit it there, then delete.",
    deleteClaudeOwnerBusy: "Claude Code in a terminal is using this session. Quit it, then delete.",
    cancel: "Cancel",
    name: "Session name",
    settings: "Next-turn settings",
    changeNextTurnModel: "Change next-turn model",
    model: "Model",
    effort: "Reasoning effort",
    mode: "Collaboration mode",
    default: "Computer default",
    plan: "Plan",
    normal: "Execute",
    apply: "Apply to next turn",
    attachment: "Add attachments",
    attachmentNote:
      "Choose files or paste images. Uploads are staged and only join the session when sent.",
    uploading: "Uploading",
    uploadFailed: "Upload failed. Select the file again.",
    remove: "Remove attachment",
    limit: "Select up to 10 attachments",
    pending: "Pending actions",
    pendingEmpty: "No pending actions",
    refresh: "Refresh",
    advanced: "More actions",
    native: "Original-client approval options",
    mcpDeclineOnly:
      "This MCP request needs a form filled in or a link opened, which AgentKib does not support yet, so it can only be declined. Codex continues the turn after you decline.",
    once: "This time",
    session: "This session",
    persistent: "Persistent rule",
    unavailableQueue: "Cannot read the queue",
    accepted: "Request accepted; check the original client for its current state",
    context: "Original-client context",
    secret: "Sensitive answers are never saved as drafts",
    unknown:
      "The last outcome is unconfirmed. Checking the request status without sending it again.",
    error: "Could not load. Refresh to retry.",
    confirmation: "Confirm action",
    close: "Close",
    text: "Message text",
    conversationSettings: "Session settings",
    restoreDefaults: "Restore computer defaults",
    serviceTier: "Service tier",
    executionPolicy: "Execution policy",
    contextUsage: "Context usage",
    contextUnknown: "The computer has not reported context-window usage",
    settingUnavailable: "This session cannot change this setting",
    settingsWhileRunning: "Settings can be changed after the current turn finishes",
    settingsSaved: "The computer confirmed these settings",
    goals: "Persistent goal",
    goalObjective: "Objective",
    goalBudget: "Token budget (optional)",
    goalCreate: "Start goal",
    goalUpdate: "Update goal",
    goalPause: "Pause",
    goalResume: "Resume and continue",
    goalClear: "Clear goal",
    goalUnavailable: "The computer does not provide goal management",
    goalStatus: "Status",
    goalUsage: "Usage",
    goalElapsed: "Elapsed time",
    addContext: "Add context",
    uploadFromPhone: "Choose attachment files",
    computerFiles: "Computer files and folders",
    skillsPlugins: "Skills, plugins and apps",
    resourceSearch: "Search available resources",
    resourceEmpty: "No resources available",
    resourceUnavailable: "The computer does not provide controlled context references",
    resourceRemoved: "This resource is no longer valid. Select it again.",
    fullAccessRequired: "Reconnect with a new full-access code to use this control",
    directoryReference: "Folders are referenced without recursively uploading their contents",
    defaultOption: "Default",
  },
  "ja-JP": {
    previewAttachment: "添付ファイルをプレビュー",
    composerHint:
      "待機中は送信できます。実行中は停止、許可があれば追加入力やキュー登録ができます。キューは自動実行されます。",
    queueTooLarge: "送信待ちキューが 100 件を超えています。ここでの編集と並べ替えは無効です。",
    queueAttachments:
      "添付付きの送信待ちメッセージは編集できません。削除して追加し直してください。",
    keep: "現在の設定を保持",
    pendingInfo:
      "このページで閲覧した会話の対応待ち項目と、現在のアクセスで未確認のリクエストを表示します。",
    title: "Codex 操作",
    capabilities: "このコンピューターの機能",
    unavailable: "このコンピューターで未提供または未検証の機能です",
    permission: "現在のアクセスでは添付ファイルをアップロードできません。",
    inspect: "会話の状態を確認",
    steer: "現在のターンに追加",
    queue: "送信待ちキュー",
    queueAdd: "キューに追加（自動実行）",
    queueUpdate: "編集",
    queueDelete: "削除",
    queueUp: "上へ移動",
    queueStart: "キューを開始",
    queueEmpty: "キューは空です",
    rename: "名前を変更",
    archive: "アーカイブ",
    unarchive: "アーカイブ解除",
    fork: "会話を分岐",
    delete: "削除",
    deleteTitle: "この会話を完全に削除しますか？",
    deleteCodexDetail:
      "会話は Codex から削除され、Codex Desktop やターミナルにも表示されなくなります。元に戻せません。AgentKib の記録とこの会話のアップロードも削除されます。",
    deleteClaudeDetail:
      "会話の記録は Claude Code から削除され、claude --resume にも表示されなくなります。元に戻せません。AgentKib の記録とこの会話のアップロードも削除されます。",
    deleteConfirm: "完全に削除",
    deleteOwnerBusy:
      "Codex Desktop またはターミナルの Codex がこの会話を使用中です。そちらを終了してから削除してください。",
    deleteClaudeOwnerBusy:
      "ターミナルの Claude Code がこの会話を使用中です。終了してから削除してください。",
    cancel: "キャンセル",
    name: "会話名",
    settings: "次のターンの設定",
    changeNextTurnModel: "次のターンのモデルを変更",
    model: "モデル",
    effort: "推論の強度",
    mode: "協調モード",
    default: "このコンピューターの既定値",
    plan: "計画",
    normal: "実行",
    apply: "次のターンに適用",
    attachment: "添付ファイルを追加",
    attachmentNote:
      "ファイルを選択するか画像を貼り付けます。アップロードは一時保存で、送信後に会話に追加されます。",
    uploading: "アップロード中",
    uploadFailed: "アップロードに失敗しました。ファイルを再選択してください。",
    remove: "添付を削除",
    limit: "添付は 10 件までです",
    pending: "対応待ち",
    pendingEmpty: "対応待ちはありません",
    refresh: "更新",
    advanced: "その他の操作",
    native: "元のクライアントの承認の選択肢",
    mcpDeclineOnly:
      "この MCP リクエストはフォームの入力またはリンクを開く必要があり、AgentKib はまだ対応していないため拒否のみできます。拒否すると Codex はこのターンを続けます。",
    once: "今回のみ",
    session: "この会話",
    persistent: "永続ルール",
    unavailableQueue: "キューを読み込めません",
    accepted: "リクエストを受け付けました。元のクライアントで現在の状態を確認してください",
    context: "元のクライアントのコンテキスト",
    secret: "機密の回答は下書きとして保存されません",
    unknown: "前回の結果を確認中です。リクエストを再送しません",
    error: "読み込みに失敗しました。更新してください",
    confirmation: "操作を確認",
    close: "閉じる",
    text: "メッセージ内容",
    conversationSettings: "会話の設定",
    restoreDefaults: "このコンピューターの既定値に戻す",
    serviceTier: "サービス階層",
    executionPolicy: "実行ポリシー",
    contextUsage: "コンテキスト使用量",
    contextUnknown: "このコンピューターからコンテキストウィンドウの使用量が提供されていません",
    settingUnavailable: "この会話ではこの設定を変更できません",
    settingsWhileRunning: "現在のターンが終了してから設定を変更できます",
    settingsSaved: "このコンピューターが設定を確認しました",
    goals: "継続目標",
    goalObjective: "目標",
    goalBudget: "Token 予算（任意）",
    goalCreate: "目標を開始",
    goalUpdate: "目標を更新",
    goalPause: "一時停止",
    goalResume: "再開して続行",
    goalClear: "目標をクリア",
    goalUnavailable: "このコンピューターは目標管理を提供していません",
    goalStatus: "状態",
    goalUsage: "使用量",
    goalElapsed: "経過時間",
    addContext: "コンテキストを追加",
    uploadFromPhone: "添付ファイルを選択",
    computerFiles: "コンピューターのファイルとフォルダー",
    skillsPlugins: "スキル、プラグイン、アプリ",
    resourceSearch: "利用可能なリソースを検索",
    resourceEmpty: "利用可能なリソースはありません",
    resourceUnavailable: "このコンピューターは制御されたコンテキスト参照を提供していません",
    resourceRemoved: "リソースが無効になりました。選択し直してください。",
    fullAccessRequired: "新しいフルアクセスコードで再接続してください",
    directoryReference: "フォルダーは再帰アップロードせず参照として追加されます",
    defaultOption: "デフォルト",
  },
};

const reasons: Record<Locale, Record<string, string>> = {
  "zh-CN": {
    "unsupported-model":
      "当前模型不在这台电脑已验证的模型列表中，本次消息尚未发送。请更改下一轮模型后再发送。",
    "native-model-unconfirmed":
      "无法确认源会话的模型，本次分支尚未创建。请先在 Codex 中明确源会话的模型和思考强度，再刷新重试。",
    "native-effort-unconfirmed":
      "无法确认源会话的思考强度，本次分支尚未创建。请先在 Codex 中明确源会话的模型和思考强度，再刷新重试。",
    "unsupported-effort":
      "当前模型不支持所选思考强度，本次消息尚未发送。请调整下一轮模型或思考强度后再发送。",
    "codex-session-directory-unsafe":
      "会话目录是文件系统根目录或用户主目录，为保护文件，目前仅可查看。请在具体项目目录中使用 Codex 新建会话。",
    "codex-session-directory-missing": "会话目录已不存在，目前仅可查看。请恢复该目录后刷新重试。",
    "codex-session-directory-not-directory":
      "会话路径不是目录，目前仅可查看。请在这台电脑上检查该路径。",
    "codex-session-directory-unavailable":
      "无法读取会话目录，目前仅可查看。请检查这台电脑上的目录权限后重试。",
    "codex-session-directory-unverified":
      "无法确认这条会话自己的目录，目前仅可查看。请在 Codex 中检查会话后刷新重试。",
    "codex-context-outside-workspace":
      "会话目录不在已登记的工作区内，目前仅可查看。请在这台电脑上检查工作区与会话目录。",
    "codex-workspace-mismatch":
      "Codex 返回的工作目录与会话目录不一致，已停止本次操作。请检查会话状态后重试。",
    "codex-sandbox-mismatch":
      "Codex 返回的可写范围与会话目录不一致，已停止本次操作。请检查会话状态后重试。",
    "codex-cli-version-unavailable":
      "无法确认 Codex 版本，目前仅可查看。请检查 Codex CLI 后刷新重试。",
    "codex-owner-check-unavailable":
      "无法确认这条会话是否正在 Codex 中使用，目前仅可查看。请刷新重试。",
    "codex-cli-unavailable": "未找到 Codex CLI，安装后可以在这里继续",
    "claude-owner-check-unavailable":
      "无法确认这条会话是否正在 Claude Code 中使用，目前仅可查看。请刷新重试。",
    "claude-cli-unavailable": "未找到 Claude Code，安装后可以在这里继续",
    "codex-protocol-incompatible": "当前 Codex 原生协议与会话快照不兼容，请更新客户端后重试。",
    "codex-connection-failed": "暂时无法连接 Codex，请检查这台电脑状态后重试。",
    "codex-owner-changed": "Codex 的运行状态已变化，正在重新检查。",
    "session-compacting": "上下文正在压缩，请等待上下文压缩完成后继续。",
    "settings-not-applied": "设置尚未由 Codex 确认，请先发送一轮应用设置，再开始或恢复目标。",
    "collaboration-modes-unavailable": "这台电脑尚未提供已验证的 Codex 协作模式列表。",
    "session-busy": "此操作需要会话空闲，请等待当前轮次结束。",
    "session-requires-running-turn": "此操作仅在轮次运行中可用。",
    "no-active-turn": "当前没有可停止的轮次。",
    "session-already-managed": "这条会话已可在 AgentKib 中继续，无需重复操作。",
    "session-not-archived": "此会话尚未归档，无需取消归档。",
    "session-archived": "此会话已归档，请先取消归档。",
    "claude-desktop-session":
      "Claude Desktop 里也有这个会话（可能在已归档里）。请在 Claude Desktop 中删除，AgentKib 不改动 Desktop 的会话记录。",
    "claude-desktop-check-unavailable":
      "无法读取 Claude Desktop 的会话记录，不能确认它没有在用这个会话，所以没有删除。",
    "claude-delete-failed":
      "没能删除 Claude Code 的会话文件，会话保持原样。检查这台电脑上 Claude 配置目录的权限后再试。",
    "session-released": "后台进程已结束，请刷新会话状态后重试。",
    "recovery-required": "暂时无法继续这条会话，请刷新状态后重试。",
    "native-session-unconfirmed": "无法确认这条会话的身份，请刷新状态后重试。",
    "follower-operation-unverified": "当前原客户端尚未验证此操作，请在原客户端完成。",
    "control-disabled": "这台电脑上的 AgentKib 尚未开启执行控制。",
    "session-state-unavailable": "暂时无法读取会话状态，请刷新后重试。",
    "unsupported-codex-cli-version": "当前 Codex 版本未经兼容验证，此能力保持只读。",
    "native-operation-not-integrated": "尚不支持通过远程访问执行此原客户端操作。",
    "control-outcome-unconfirmed":
      "上次操作结果尚未确认。请刷新核对已保存请求的处理状态，勿重复提交；不会自动重发。",
    "claude-background-task":
      "Claude 启动了后台任务。AgentKib 无法监管后台任务，所以 AgentKib 停止了该会话，避免进程无人看管。Claude Code 自己保存着此前的会话（最后几条消息可能缺失）。该会话在 AgentKib 中保持只读，请在 Claude Code 终端里继续。",
    "claude-unrequested-turn":
      "AgentKib 发起的这一轮结束后，Claude 仍在继续工作（例如后台子代理完成）。AgentKib 只跟踪自己发起的轮次，所以 AgentKib 停止了会话，以保持此处显示与已保存的会话一致。该会话在 AgentKib 中保持只读，请在 Claude Code 终端里继续。",
    "claude-protocol-violation":
      "AgentKib 无法解析 Claude Code 的输出，为安全起见已停止会话。Claude Code 自己保存着此前的会话（最后几条消息可能缺失）。该会话在 AgentKib 中保持只读，请在 Claude Code 终端里继续。若反复出现，请更新 AgentKib 并反馈 Claude Code 的版本。",
    "claude-auth-failed":
      "Claude Code 未通过认证：还没有登录，或 API key 被拒绝。请在这台电脑的终端里运行 claude，用 /login 登录；使用 API key 时，把它写进 ~/.claude/settings.json 的 env，或配置 apiKeyHelper。shell 配置文件里 export 的变量通常传不到 AgentKib（例如从程序坞打开时）。修好后直接重新发送，AgentKib 会用新的设置启动 Claude Code。",
    "claude-command-clear":
      "/clear 会让 Claude Code 改用一条新会话，AgentKib 无法跟随，本次消息尚未发送。需要空白上下文时请新建会话，这条会话会保留；只想腾出上下文可以用 /compact，或在上下文用量里压缩上下文。",
    "claude-command-background":
      "/loop 和 /batch 会启动 AgentKib 无法监管的后台任务，本次消息尚未发送。要接着执行的消息可以加入待发队列，或使用持续目标。",
    "claude-command-goal":
      "Claude Code 的 /goal 会在 AgentKib 不知情时继续运行，本次消息尚未发送。请使用 AgentKib 的持续目标。",
    "claude-command-rename":
      "/rename 只更改 Claude Code 中的名称，AgentKib 中的名称不会随之改变，本次消息尚未发送。请在 AgentKib 中重命名会话。",
    "claude-command-settings":
      "带参数的 /model 和 /effort 只影响当前进程，AgentKib 无法保留，本次消息尚未发送。请在下一轮设置中更改模型或思考强度。",
    "claude-command-owner-only":
      "这条命令可能更改这台电脑上的 Claude Code 设置或文件，只能在这台电脑上的 AgentKib 或终端中使用，本次消息尚未发送。",
    "claude-model-unsupported":
      "下一轮设置只支持其中列出的模型，这个模型不在列表里，下一轮模型没有改动。请改用列出的模型，名称或完整模型 ID 都可以。",
    "claude-effort-unsupported":
      "下一轮设置的思考强度只能是 low、medium、high、xhigh 或 max，而且要是所选模型支持的级别。下一轮设置没有改动，请在下一轮设置里选择。",
    "codex-command-agentkib":
      "AgentKib 用自己的操作代替这条 Codex 命令，但它现在不可用，本次消息尚未发送。请等当前轮次结束，或在这台电脑上检查这台设备的权限。",
    "codex-command-arguments":
      "这条命令在 AgentKib 中不带参数，本次消息尚未发送。去掉参数后再发送。",
    "codex-command-new":
      "/new 和 /clear 会让 Codex 终端改用新对话。需要空白上下文时请在 AgentKib 中新建会话，这条会话会保留。本次消息尚未发送。",
    "codex-command-review":
      "/review 后面只能跟一个分支、标签或提交，例如 /review main；不带参数时审查未提交的改动。本次消息尚未发送。",
    "codex-command-terminal": "这条命令只在 Codex 的终端界面里起作用，本次消息尚未发送。",
    permission_denied: "此浏览器尚未获得对应权限，请在这台电脑上的 AgentKib 授权。",
  },
  "zh-TW": {
    "unsupported-model":
      "目前模型不在這台電腦已驗證的模型清單中，本次訊息尚未傳送。請變更下一輪模型後再傳送。",
    "native-model-unconfirmed":
      "無法確認來源對話的模型，本次分支尚未建立。請先在 Codex 中明確設定來源對話的模型和思考強度，再重新整理後重試。",
    "native-effort-unconfirmed":
      "無法確認來源對話的思考強度，本次分支尚未建立。請先在 Codex 中明確設定來源對話的模型和思考強度，再重新整理後重試。",
    "unsupported-effort":
      "目前模型不支援所選思考強度，本次訊息尚未傳送。請調整下一輪模型或思考強度後再傳送。",
    "codex-session-directory-unsafe":
      "對話目錄是檔案系統根目錄或使用者主目錄，為保護檔案，目前僅可查看。請在具體專案目錄中使用 Codex 建立新對話。",
    "codex-session-directory-missing":
      "對話目錄已不存在，目前僅可查看。請還原該目錄後重新整理再試。",
    "codex-session-directory-not-directory":
      "對話路徑不是目錄，目前僅可查看。請在這台電腦上檢查該路徑。",
    "codex-session-directory-unavailable":
      "無法讀取對話目錄，目前僅可查看。請檢查這台電腦上的目錄權限後重試。",
    "codex-session-directory-unverified":
      "無法確認這段對話自己的目錄，目前僅可查看。請在 Codex 中檢查對話後重新整理再試。",
    "codex-context-outside-workspace":
      "對話目錄不在已登記的工作區內，目前僅可查看。請在這台電腦上檢查工作區與對話目錄。",
    "codex-workspace-mismatch":
      "Codex 傳回的工作目錄與對話目錄不一致，已停止本次操作。請檢查對話狀態後重試。",
    "codex-sandbox-mismatch":
      "Codex 傳回的可寫範圍與對話目錄不一致，已停止本次操作。請檢查對話狀態後重試。",
    "codex-cli-version-unavailable":
      "無法確認 Codex 版本，目前僅可查看。請檢查 Codex CLI 後重新整理再試。",
    "codex-owner-check-unavailable":
      "無法確認這段對話是否正在 Codex 中使用，目前僅可查看。請重新整理再試。",
    "codex-cli-unavailable": "找不到 Codex CLI，安裝後可以在這裡繼續",
    "claude-owner-check-unavailable":
      "無法確認這段對話是否正在 Claude Code 中使用，目前僅可查看。請重新整理再試。",
    "claude-cli-unavailable": "找不到 Claude Code，安裝後可以在這裡繼續",
    "codex-protocol-incompatible": "目前 Codex 原生協定與對話快照不相容，請更新客戶端後重試。",
    "codex-connection-failed": "暫時無法連線至 Codex，請檢查這台電腦狀態後重試。",
    "codex-owner-changed": "Codex 的執行狀態已變更，正在重新檢查。",
    "session-compacting": "上下文正在壓縮，請等待上下文壓縮完成後繼續。",
    "settings-not-applied": "設定尚未由 Codex 確認，請先傳送一回合套用設定，再開始或恢復目標。",
    "collaboration-modes-unavailable": "這台電腦尚未提供已驗證的 Codex 協作模式清單。",
    "session-busy": "此操作需要對話閒置，請等待目前輪次結束。",
    "session-requires-running-turn": "此操作僅在輪次執行中可用。",
    "no-active-turn": "目前沒有可停止的輪次。",
    "session-already-managed": "這段對話已可在 AgentKib 中繼續，無需重複操作。",
    "session-not-archived": "此對話尚未封存，無需取消封存。",
    "session-archived": "此對話已封存，請先取消封存。",
    "claude-desktop-session":
      "Claude Desktop 裡也有這段對話（可能在已封存中）。請在 Claude Desktop 中刪除，AgentKib 不改動 Desktop 的對話紀錄。",
    "claude-desktop-check-unavailable":
      "無法讀取 Claude Desktop 的對話紀錄，不能確認它沒有在使用這段對話，因此沒有刪除。",
    "claude-delete-failed":
      "未能刪除 Claude Code 的對話檔案，對話保持原狀。請檢查這台電腦上 Claude 設定目錄的權限後再試。",
    "session-released": "背景程序已結束，請重新整理對話狀態後重試。",
    "recovery-required": "暫時無法繼續這段對話，請重新整理狀態後重試。",
    "native-session-unconfirmed": "無法確認這段對話的身分，請重新整理狀態後重試。",
    "follower-operation-unverified": "目前原客戶端尚未驗證此操作，請在原客戶端完成。",
    "control-disabled": "這台電腦上的 AgentKib 尚未啟用執行控制。",
    "session-state-unavailable": "暫時無法讀取對話狀態，請重新整理後重試。",
    "unsupported-codex-cli-version": "目前 Codex 版本未經相容驗證，此能力保持唯讀。",
    "native-operation-not-integrated": "尚不支援透過遠端存取執行此原客戶端操作。",
    "control-outcome-unconfirmed":
      "上次操作結果尚未確認。請重新整理核對已儲存請求的處理狀態，勿重複提交；不會自動重傳。",
    "claude-background-task":
      "Claude 啟動了背景任務。AgentKib 無法監管背景任務，所以 AgentKib 停止了該對話，避免程序無人看管。Claude Code 自己保存著先前的對話（最後幾則訊息可能缺失）。該對話在 AgentKib 中保持唯讀，請在 Claude Code 終端機裡繼續。",
    "claude-unrequested-turn":
      "AgentKib 發起的這一輪結束後，Claude 仍在繼續工作（例如背景子代理完成）。AgentKib 只追蹤自己發起的回合，所以 AgentKib 停止了對話，以保持此處顯示與已儲存的對話一致。該對話在 AgentKib 中保持唯讀，請在 Claude Code 終端機裡繼續。",
    "claude-protocol-violation":
      "AgentKib 無法解析 Claude Code 的輸出，為安全起見已停止對話。Claude Code 自己保存著先前的對話（最後幾則訊息可能缺失）。該對話在 AgentKib 中保持唯讀，請在 Claude Code 終端機裡繼續。若反覆出現，請更新 AgentKib 並回報 Claude Code 的版本。",
    "claude-auth-failed":
      "Claude Code 未通過驗證：尚未登入，或 API key 遭到拒絕。請在這台電腦的終端機執行 claude，用 /login 登入；使用 API key 時，請寫進 ~/.claude/settings.json 的 env，或設定 apiKeyHelper。shell 設定檔中 export 的變數通常傳不到 AgentKib（例如從 Dock 開啟時）。修正後直接重新傳送，AgentKib 會用新的設定啟動 Claude Code。",
    "claude-command-clear":
      "/clear 會讓 Claude Code 改用一段新對話，AgentKib 無法跟隨，本次訊息尚未傳送。需要空白上下文時請建立新對話，這段對話會保留；只想騰出上下文可以使用 /compact，或在上下文用量裡壓縮上下文。",
    "claude-command-background":
      "/loop 和 /batch 會啟動 AgentKib 無法監管的背景任務，本次訊息尚未傳送。要接著執行的訊息可以加入待發佇列，或使用持續目標。",
    "claude-command-goal":
      "Claude Code 的 /goal 會在 AgentKib 不知情時繼續執行，本次訊息尚未傳送。請使用 AgentKib 的持續目標。",
    "claude-command-rename":
      "/rename 只變更 Claude Code 中的名稱，AgentKib 中的名稱不會隨之改變，本次訊息尚未傳送。請在 AgentKib 中重新命名對話。",
    "claude-command-settings":
      "帶參數的 /model 和 /effort 只影響目前的程序，AgentKib 無法保留，本次訊息尚未傳送。請在下一輪設定中變更模型或思考強度。",
    "claude-command-owner-only":
      "這個指令可能變更這台電腦上的 Claude Code 設定或檔案，只能在這台電腦上的 AgentKib 或終端機中使用，本次訊息尚未傳送。",
    "claude-model-unsupported":
      "下一輪設定只支援其中列出的模型，這個模型不在清單中，下一輪模型沒有變更。請改用列出的模型，名稱或完整模型 ID 都可以。",
    "claude-effort-unsupported":
      "下一輪設定的思考強度只能是 low、medium、high、xhigh 或 max，而且要是所選模型支援的等級。下一輪設定沒有變更，請在下一輪設定中選擇。",
    "codex-command-agentkib":
      "AgentKib 以自己的操作取代這個 Codex 指令，但它目前無法使用，本次訊息尚未傳送。請等目前輪次結束，或在這台電腦上檢查這台裝置的權限。",
    "codex-command-arguments":
      "這個指令在 AgentKib 中不帶參數，本次訊息尚未傳送。移除參數後再傳送。",
    "codex-command-new":
      "/new 和 /clear 會讓 Codex 終端機改用新對話。需要空白上下文時請在 AgentKib 中建立新對話，這段對話會保留。本次訊息尚未傳送。",
    "codex-command-review":
      "/review 後面只能接一個分支、標籤或提交，例如 /review main；不帶參數時審查尚未提交的變更。本次訊息尚未傳送。",
    "codex-command-terminal": "這個指令只在 Codex 的終端機介面中有作用，本次訊息尚未傳送。",
    permission_denied: "此瀏覽器尚未取得對應權限，請在這台電腦上的 AgentKib 授權。",
  },
  "en-US": {
    "unsupported-model":
      "The current model is not in the model list verified on this computer. This message was not sent. Change the next-turn model before sending again.",
    "native-model-unconfirmed":
      "The source session's model could not be confirmed. No branch was created. Set the source session's model and reasoning effort in Codex, then refresh to retry.",
    "native-effort-unconfirmed":
      "The source session's reasoning effort could not be confirmed. No branch was created. Set the source session's model and reasoning effort in Codex, then refresh to retry.",
    "unsupported-effort":
      "The current model does not support the selected reasoning effort. This message was not sent. Adjust the next-turn model or reasoning effort before sending again.",
    "codex-session-directory-unsafe":
      "The session directory is a filesystem root or your home directory. This session is view only to protect your files. Start a new Codex session from a specific project directory.",
    "codex-session-directory-missing":
      "The session directory no longer exists. This session is view only. Restore the directory, then refresh to retry.",
    "codex-session-directory-not-directory":
      "The session path is not a directory. This session is view only. Check that path on this computer.",
    "codex-session-directory-unavailable":
      "The session directory could not be read. This session is view only. Check its permissions on this computer, then retry.",
    "codex-session-directory-unverified":
      "The session's own directory could not be verified. This session is view only. Check the session in Codex, then refresh to retry.",
    "codex-context-outside-workspace":
      "The session directory is outside the registered workspace. This session is view only. Check the workspace and session directory on this computer.",
    "codex-workspace-mismatch":
      "Codex returned a working directory that differs from the session directory. The operation was stopped. Check the session state, then retry.",
    "codex-sandbox-mismatch":
      "Codex returned a writable scope that differs from the session directory. The operation was stopped. Check the session state, then retry.",
    "codex-cli-version-unavailable":
      "The Codex version could not be confirmed. This session is view only. Check Codex CLI, then refresh to retry.",
    "codex-owner-check-unavailable":
      "Could not confirm whether this session is in use in Codex. It remains view only. Refresh to retry.",
    "codex-cli-unavailable": "Codex CLI was not found. Install it to continue here.",
    "claude-owner-check-unavailable":
      "Could not confirm whether this session is in use in Claude Code. It remains view only. Refresh to retry.",
    "claude-cli-unavailable": "Claude Code was not found. Install it to continue here.",
    "codex-protocol-incompatible":
      "The Codex native protocol or session snapshot is incompatible. Update the client and retry.",
    "codex-connection-failed": "Codex could not be reached. Check this computer and retry.",
    "codex-owner-changed": "The Codex execution state changed. Checking it again.",
    "session-compacting":
      "Context is compacting. Wait for context compaction to finish before continuing.",
    "settings-not-applied":
      "Codex has not confirmed these settings. Send a turn to apply them before starting or resuming the goal.",
    "collaboration-modes-unavailable":
      "The computer has not provided a verified Codex collaboration mode list.",
    "session-busy": "This operation requires an idle session. Wait for the current turn to finish.",
    "session-requires-running-turn": "This operation is only available while a turn is running.",
    "no-active-turn": "There is no active turn to stop.",
    "session-already-managed":
      "This session is already available in AgentKib. No additional action is needed.",
    "session-not-archived": "This session is not archived, so there is nothing to unarchive.",
    "session-archived": "This session is archived. Unarchive it first.",
    "claude-desktop-session":
      "Claude Desktop also lists this session (perhaps among its archived ones). Delete it in Claude Desktop; AgentKib does not change Desktop's records.",
    "claude-desktop-check-unavailable":
      "Claude Desktop's session records could not be read, so AgentKib could not confirm Desktop does not use this session. Nothing was deleted.",
    "claude-delete-failed":
      "Claude Code's session file could not be deleted, so the session is unchanged. Check the permissions of the Claude config folder on this computer, then retry.",
    "session-released": "The background process ended. Refresh the session state and retry.",
    "recovery-required": "This session cannot continue yet. Refresh its state and retry.",
    "native-session-unconfirmed":
      "This session's identity could not be confirmed. Refresh its state and retry.",
    "follower-operation-unverified":
      "This operation has not been verified with the original client. Use that client instead.",
    "control-disabled": "Execution control is not enabled in AgentKib on this computer.",
    "session-state-unavailable": "Session state is unavailable. Refresh and retry.",
    "unsupported-codex-cli-version":
      "This Codex version has not passed compatibility verification. This capability remains read-only.",
    "native-operation-not-integrated":
      "This original-client operation is not available through remote access yet.",
    "control-outcome-unconfirmed":
      "The previous outcome is unconfirmed. Refresh to check the saved request; do not resubmit. It will not be sent again automatically.",
    "claude-background-task":
      "Claude started a background task. AgentKib cannot supervise background work, so AgentKib stopped it rather than leave processes running unattended. Claude Code keeps the session up to that point (the last messages may be missing). This session is read-only in AgentKib; continue it in the Claude Code terminal.",
    "claude-unrequested-turn":
      "Claude kept working after the turn AgentKib started had ended (for example a background sub-agent finished). AgentKib only follows turns it starts, so AgentKib stopped the session to keep this view consistent with the saved session. This session is read-only in AgentKib; continue it in the Claude Code terminal.",
    "claude-protocol-violation":
      "AgentKib could not follow Claude Code's output and stopped the session to stay safe. Claude Code keeps the session up to that point (the last messages may be missing). This session is read-only in AgentKib; continue it in the Claude Code terminal. If this keeps happening, update AgentKib and report the Claude Code version.",
    "claude-auth-failed":
      "Claude Code could not authenticate: it is not logged in, or the API key was rejected. Run claude in a terminal on this computer and log in with /login. For an API key, put it in the env block of ~/.claude/settings.json or configure apiKeyHelper. Variables exported in your shell profile usually do not reach AgentKib (for example when it is opened from the Dock). After fixing it, send again; AgentKib starts Claude Code with the new settings.",
    "claude-command-clear":
      "/clear moves Claude Code to a new session that AgentKib cannot follow. This message was not sent. For an empty context, start a new session; this one is kept. To free up context, use /compact or Compact context under Context usage.",
    "claude-command-background":
      "/loop and /batch start background work that AgentKib cannot supervise. This message was not sent. Add follow-up messages to Queued messages, or use a persistent goal.",
    "claude-command-goal":
      "Claude Code's /goal keeps working without AgentKib knowing. This message was not sent. Use AgentKib's persistent goal instead.",
    "claude-command-rename":
      "/rename changes only the name in Claude Code, not the one in AgentKib. This message was not sent. Rename the session in AgentKib instead.",
    "claude-command-settings":
      "/model and /effort with an argument change only the running process, which AgentKib cannot keep. This message was not sent. Change the model or reasoning effort in Next-turn settings.",
    "claude-command-owner-only":
      "This command can change Claude Code settings or files on this computer, so it only runs from AgentKib on this computer or a terminal. This message was not sent.",
    "claude-model-unsupported":
      "Next-turn settings support only the models they list, and this one is not listed. The next-turn model was not changed. Use a listed model, by its name or full model ID.",
    "claude-effort-unsupported":
      "Next-turn reasoning effort can be only low, medium, high, xhigh, or max, and only a level the selected model supports. Next-turn settings were not changed; choose a level in Next-turn settings.",
    "codex-command-agentkib":
      "AgentKib stands in for this Codex command with its own action, which is not available right now. This message was not sent. Wait for the current turn to end, or check this device's permissions on this computer.",
    "codex-command-arguments":
      "In AgentKib this command takes no argument. This message was not sent. Send it without the argument.",
    "codex-command-new":
      "/new and /clear move the Codex terminal to a new conversation. For an empty context, start a new session in AgentKib; this one is kept. This message was not sent.",
    "codex-command-review":
      "/review takes one branch, tag or commit, such as /review main, or nothing to review the uncommitted changes. This message was not sent.",
    "codex-command-terminal":
      "This command works only in Codex's terminal interface. This message was not sent.",
    permission_denied:
      "This browser needs the corresponding permission. Grant it in AgentKib on this computer.",
  },
  "ja-JP": {
    "unsupported-model":
      "現在のモデルはこのコンピューターで検証済みのモデル一覧にありません。このメッセージは送信されていません。次のターンのモデルを変更してから送信してください。",
    "native-model-unconfirmed":
      "元の会話のモデルを確認できないため、分岐は作成されていません。Codex で元の会話のモデルと思考強度を明示してから、再読み込みしてお試しください。",
    "native-effort-unconfirmed":
      "元の会話の思考強度を確認できないため、分岐は作成されていません。Codex で元の会話のモデルと思考強度を明示してから、再読み込みしてお試しください。",
    "unsupported-effort":
      "現在のモデルは選択した思考強度に対応していません。このメッセージは送信されていません。次のターンのモデルまたは思考強度を調整してから送信してください。",
    "codex-session-directory-unsafe":
      "会話のディレクトリがファイルシステムのルートまたはホームディレクトリのため、ファイルを保護するために閲覧のみになっています。個別のプロジェクトディレクトリで Codex の新しい会話を開始してください。",
    "codex-session-directory-missing":
      "会話のディレクトリが存在しないため、閲覧のみです。ディレクトリを復元してから再読み込みしてください。",
    "codex-session-directory-not-directory":
      "会話のパスがディレクトリではないため、閲覧のみです。このコンピューター上の該当パスを確認してください。",
    "codex-session-directory-unavailable":
      "会話のディレクトリを読み取れないため、閲覧のみです。このコンピューター上のアクセス権を確認してから再試行してください。",
    "codex-session-directory-unverified":
      "この会話自体のディレクトリを確認できないため、閲覧のみです。Codex で会話を確認してから再読み込みしてください。",
    "codex-context-outside-workspace":
      "会話のディレクトリが登録済みワークスペースの外にあるため、閲覧のみです。このコンピューター上のワークスペースと会話のディレクトリを確認してください。",
    "codex-workspace-mismatch":
      "Codex が返した作業ディレクトリが会話のディレクトリと一致しないため、操作を停止しました。会話の状態を確認してから再試行してください。",
    "codex-sandbox-mismatch":
      "Codex が返した書き込み可能範囲が会話のディレクトリと一致しないため、操作を停止しました。会話の状態を確認してから再試行してください。",
    "codex-cli-version-unavailable":
      "Codex のバージョンを確認できないため、この会話は閲覧のみです。Codex CLI を確認してから再読み込みしてください。",
    "codex-owner-check-unavailable":
      "この会話が Codex で使用中か確認できないため、閲覧のみです。再読み込みしてお試しください。",
    "codex-cli-unavailable": "Codex CLI が見つかりません。インストールすると、ここで続けられます。",
    "claude-owner-check-unavailable":
      "この会話が Claude Code で使用中か確認できないため、閲覧のみです。再読み込みしてお試しください。",
    "claude-cli-unavailable":
      "Claude Code が見つかりません。インストールすると、ここで続けられます。",
    "codex-protocol-incompatible":
      "Codex のネイティブプロトコルまたは会話スナップショットに互換性がありません。更新後に再試行してください。",
    "codex-connection-failed":
      "Codex に接続できません。このコンピューターの状態を確認して再試行してください。",
    "codex-owner-changed": "Codex の実行状態が変わりました。再確認しています。",
    "session-compacting": "コンテキストを圧縮中です。圧縮が完了するまでお待ちください。",
    "settings-not-applied":
      "設定は Codex で未確認です。ターンを送信して反映した後、目標を開始または再開してください。",
    "collaboration-modes-unavailable":
      "このコンピューターは検証済みの Codex 協調モード一覧を提供していません。",
    "session-busy": "この操作は待機中に利用できます。現在のターンの終了をお待ちください。",
    "session-requires-running-turn": "この操作はターンの実行中のみ利用できます。",
    "no-active-turn": "停止できるターンはありません。",
    "session-already-managed": "この会話はすでに AgentKib で続けられます。追加の操作は不要です。",
    "session-not-archived": "この会話はアーカイブされていないため、解除する必要はありません。",
    "session-archived": "この会話はアーカイブされています。先にアーカイブを解除してください。",
    "claude-desktop-session":
      "この会話は Claude Desktop にもあります（アーカイブ済みの可能性があります）。Claude Desktop で削除してください。AgentKib は Desktop の記録を変更しません。",
    "claude-desktop-check-unavailable":
      "Claude Desktop の会話記録を読み取れず、Desktop がこの会話を使っていないことを確認できないため、削除していません。",
    "claude-delete-failed":
      "Claude Code の会話ファイルを削除できなかったため、会話はそのままです。このコンピューターの Claude 設定フォルダーの権限を確認してから再試行してください。",
    "session-released":
      "バックグラウンドプロセスは終了しました。会話の状態を更新して再試行してください。",
    "recovery-required": "この会話はまだ続けられません。状態を更新して再試行してください。",
    "native-session-unconfirmed":
      "この会話の識別情報を確認できません。状態を更新して再試行してください。",
    "follower-operation-unverified":
      "元のクライアントでこの操作は未検証です。元のクライアントで操作してください。",
    "control-disabled": "このコンピューター上の AgentKib で実行操作が有効になっていません。",
    "session-state-unavailable": "会話の状態を取得できません。更新して再試行してください。",
    "unsupported-codex-cli-version":
      "この Codex バージョンは互換性が未検証のため、この機能は読み取り専用です。",
    "native-operation-not-integrated": "元のクライアントのこの操作はリモートアクセスに未対応です。",
    "control-outcome-unconfirmed":
      "前回の結果は未確認です。更新して保存済みリクエストの処理状況を確認し、再送しないでください。自動で再送しません。",
    "claude-background-task":
      "Claude がバックグラウンドタスクを開始しました。AgentKib はバックグラウンド作業を監督できないため、プロセスが放置されないよう AgentKib が会話を停止しました。Claude Code はそれまでの会話を保存しています（最後の数件は欠けている可能性があります）。この会話は AgentKib では読み取り専用です。続きは Claude Code のターミナルで行ってください。",
    "claude-unrequested-turn":
      "AgentKib が開始したターンが終わった後も Claude が作業を続けました（例: バックグラウンドのサブエージェントの完了）。AgentKib は自分で開始したターンだけを追うため、保存済みの会話と表示を一致させるために AgentKib が会話を停止しました。この会話は AgentKib では読み取り専用です。続きは Claude Code のターミナルで行ってください。",
    "claude-protocol-violation":
      "AgentKib は Claude Code の出力を解釈できなかったため、安全のため会話を停止しました。Claude Code はそれまでの会話を保存しています（最後の数件は欠けている可能性があります）。この会話は AgentKib では読み取り専用です。続きは Claude Code のターミナルで行ってください。繰り返し発生する場合は、AgentKib を更新し、Claude Code のバージョンを報告してください。",
    "claude-auth-failed":
      "Claude Code の認証に失敗しました。ログインしていないか、API キーが拒否されています。このコンピューターのターミナルで claude を実行し、/login でログインしてください。API キーを使う場合は ~/.claude/settings.json の env に書くか、apiKeyHelper を設定してください。シェルの設定ファイルで export した変数は、通常 AgentKib には届きません（Dock から開いた場合など）。修正したらそのまま再送信してください。AgentKib が新しい設定で Claude Code を起動します。",
    "claude-command-clear":
      "/clear を実行すると Claude Code は新しい会話に切り替わり、AgentKib は追従できません。このメッセージは送信されていません。空のコンテキストが必要な場合は新しい会話を開始してください（この会話は残ります）。コンテキストを空けるだけなら /compact か、コンテキスト使用量の「コンテキストを圧縮」を使えます。",
    "claude-command-background":
      "/loop と /batch は AgentKib が監督できないバックグラウンド作業を開始します。このメッセージは送信されていません。続けて実行したいメッセージは送信待ちキューに追加するか、継続目標を使ってください。",
    "claude-command-goal":
      "Claude Code の /goal は AgentKib の知らないところで作業を続けます。このメッセージは送信されていません。AgentKib の継続目標を使ってください。",
    "claude-command-rename":
      "/rename は Claude Code 内の名前だけを変更し、AgentKib の名前は変わりません。このメッセージは送信されていません。AgentKib で会話の名前を変更してください。",
    "claude-command-settings":
      "引数付きの /model と /effort は実行中のプロセスだけを変更し、AgentKib には保持されません。このメッセージは送信されていません。次のターンの設定でモデルまたは推論の強度を変更してください。",
    "claude-command-owner-only":
      "このコマンドはこのコンピューター上の Claude Code の設定やファイルを変更する可能性があるため、このコンピューター上の AgentKib またはターミナルからのみ実行できます。このメッセージは送信されていません。",
    "claude-model-unsupported":
      "次のターンの設定で使えるのは一覧にあるモデルだけで、このモデルは一覧にありません。次のターンのモデルは変更されていません。一覧にあるモデルを、名前か完全なモデル ID で指定してください。",
    "claude-effort-unsupported":
      "次のターンの推論の強度は low、medium、high、xhigh、max のいずれかで、選択したモデルが対応しているものに限られます。次のターンの設定は変更されていません。次のターンの設定で選んでください。",
    "codex-command-agentkib":
      "AgentKib はこの Codex のコマンドを独自の操作で代わりに行いますが、今は使えません。このメッセージは送信されていません。現在のターンが終わるのを待つか、このコンピューターでこのデバイスの権限を確認してください。",
    "codex-command-arguments":
      "AgentKib ではこのコマンドは引数を取りません。このメッセージは送信されていません。引数を外して送信してください。",
    "codex-command-new":
      "/new と /clear は Codex のターミナルを新しい会話に切り替えます。空のコンテキストが必要な場合は AgentKib で新しい会話を開始してください（この会話は残ります）。このメッセージは送信されていません。",
    "codex-command-review":
      "/review に指定できるのはブランチ、タグ、コミットのどれか 1 つです（例：/review main）。何も指定しなければ未コミットの変更をレビューします。このメッセージは送信されていません。",
    "codex-command-terminal":
      "このコマンドは Codex のターミナル画面でのみ機能します。このメッセージは送信されていません。",
    permission_denied:
      "このブラウザーには対応する権限が必要です。このコンピューター上の AgentKib で権限を付与してください。",
  },
};
// Reasons stored as `<code>: <detail>`. The first three stop the session; an authentication
// failure leaves it idle and usable.
const claudeStopCodes = [
  "claude-background-task",
  "claude-unrequested-turn",
  "claude-protocol-violation",
  "claude-auth-failed",
];
export function codexReason(
  locale: Locale,
  reason?: string,
  surface: SessionSurface = "desktop",
): { text: string; technical?: string } {
  const continuation = sessionContinuationCopy(locale);
  if (reason === "codex-owner-busy") return { text: continuation.busy("Codex") };
  if (reason === "codex-cli-version-too-old") return { text: continuation.codexVersionTooOld };
  const claudeReason = claudeConnectionReason(locale, reason, surface);
  if (claudeReason) return { text: claudeReason };
  if (
    reason === "unverified-installation" ||
    reason === "open-in-original-client" ||
    reason === "handoff-required"
  ) {
    return { text: surfaceText(localizedUnavailableReasonText(reason, locale), surface, locale) };
  }
  // A coded Claude reason is `<code>: <detail>`; the code is explained, the detail is shown as
  // the technical text.
  const separator = reason?.indexOf(": ") ?? -1;
  const code = reason && separator > 0 ? reason.slice(0, separator) : undefined;
  if (reason && code && claudeStopCodes.includes(code))
    return {
      text: surfaceText(reasons[locale][code]!, surface, locale),
      ...(reason.length > separator + 2 ? { technical: reason.slice(separator + 2) } : {}),
    };
  const text = reason ? reasons[locale][reason] : undefined;
  return text
    ? { text: surfaceText(text, surface, locale) }
    : {
        text: codexCopyForSurface(locale, surface).unavailable,
        ...(reason ? { technical: reason } : {}),
      };
}

export function codexCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(codexCopy[locale], surface, locale);
}
