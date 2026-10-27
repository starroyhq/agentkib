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
