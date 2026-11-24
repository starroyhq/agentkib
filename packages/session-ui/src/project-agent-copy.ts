/**
 * The Project Agent panel's words (docs/agents/project-agent.md), shared by the desktop and Web
 * panels. Terms follow docs/development/ui-terminology.md.
 */
export type ProjectAgentCopy = {
  title: string;
  hint: string;
  designate: string;
  designatePermission: string;
  /** What the Project Agent may decide for its workers; none unless ticked. */
  decides: string;
  approveFiles: string;
  approveCommands: string;
  answers: string;
  decidesNote: string;
  decided: (items: string[]) => string;
  maxAutoTurns: string;
  stallMinutes: string;
  confirm: string;
  cancel: string;
  summary: (workers: number, pending: number) => string;
  none: string;
  open: string;
  pause: string;
  resume: string;
  recovering: string;
  release: string;
  releaseConfirm: string;
  /** Changing what an existing Project Agent may do: the setup form again. */
  edit: string;
  save: string;
  /** One worker's row: stop its turn, or let it go. */
  stopWorker: string;
  removeWorker: string;
  removeConfirm: (name: string) => string;
  reported: (time: string) => string;
  status: Record<string, string>;
  paused: Record<string, string>;
  errors: Record<string, string>;
  failed: string;
};

const copy: Record<"zh-CN" | "zh-Hant" | "ja-JP" | "en-US", ProjectAgentCopy> = {
  "zh-CN": {
    title: "项目 Agent",
    hint: "这个会话可以给你指派的 Worker 派任务，并接收它们的汇报。",
    designate: "设为项目 Agent…",
    designatePermission: "设为项目 Agent 需要此设备具备完全访问、发送、会话管理和高级控制权限。",
    decides: "项目 Agent 可以替你决定",
    approveFiles: "Worker 修改文件的审批",
    approveCommands: "Worker 在沙箱外运行命令的审批",
    answers: "Worker 的提问",
    decidesNote: "只限普通审批：接受一次或拒绝。要联网、要更多权限或要改规则的审批仍由你处理。",
    decided: (items) => `替你决定：${items.join("、")}`,
    maxAutoTurns: "连续自动轮次上限",
    stallMinutes: "模型静默阈值（分钟）",
    confirm: "设为项目 Agent",
    cancel: "取消",
    summary: (workers, pending) =>
      `${workers} 个 Worker${pending ? ` · ${pending} 条汇报待送达` : ""}`,
    none: "在桌面会话目录中指派 Worker。",
    open: "打开",
    pause: "暂停委派",
    resume: "恢复委派",
    recovering: "正在恢复委派",
    release: "不再作为项目 Agent",
    releaseConfirm: "确定不再作为项目 Agent？Worker 会话会保留为普通会话。",
    edit: "修改设定…",
    save: "保存",
    stopWorker: "停止",
    removeWorker: "移出",
    removeConfirm: (name) =>
      `移出 ${name}？它的会话保留为普通会话，不再向项目 Agent 汇报，也不再占名额。`,
    reported: (time) => `${time} 汇报`,
    status: {
      idle: "空闲",
      running: "运行中",
      starting: "启动中",
      "awaiting-approval": "等你审批",
      "waiting-input": "等你回答",
      unavailable: "状态未知",
    },
    paused: {
      "user-paused": "已暂停委派。",
      "restart-confirmation-required":
        "AgentKib 重启后暂停了委派。恢复委派，或在这个会话里发一条消息就会继续。",
      "authorization-changed": "设定它的设备授权已变更，已暂停委派。",
      "auto-turn-limit": "达到连续自动轮次上限，已暂停委派。在这个会话里发一条消息就会继续。",
      "usage-limit":
        "项目 Agent 达到使用上限，汇报会在它重置后继续送达。在这个会话里发一条消息也会继续。",
      "report-undelivered": "汇报没有送达，已暂停委派。",
    },
    errors: {
      "lead-requires-managed-claude": "AgentKib 能控制此会话后，才能将它设为项目 Agent。",
      "session-is-a-worker": "这个会话是另一个项目 Agent 的 Worker。",
      "lead-exists": "这个会话已经是项目 Agent。",
      "worker-unavailable": "这个 Worker 已经不在项目 Agent 名下。",
      "worker-not-running": "这个 Worker 现在没有在运行。",
    },
    failed: "没有完成，请重试。",
  },
  "zh-Hant": {
    title: "專案 Agent",
    hint: "這個對話可以給你指派的 Worker 派任務，並接收它們的回報。",
    designate: "設為專案 Agent…",
    designatePermission: "設為專案 Agent 需要此裝置具備完全存取、傳送、會話管理和進階控制權限。",
    decides: "專案 Agent 可以替你決定",
    approveFiles: "Worker 修改檔案的核准",
    approveCommands: "Worker 在沙箱外執行指令的核准",
    answers: "Worker 的提問",
    decidesNote: "只限一般核准：允許一次或拒絕。要連網、要更多權限或要改規則的核准仍由你處理。",
    decided: (items) => `替你決定：${items.join("、")}`,
    maxAutoTurns: "連續自動輪次上限",
    stallMinutes: "模型靜默閾值（分鐘）",
    confirm: "設為專案 Agent",
    cancel: "取消",
    summary: (workers, pending) =>
      `${workers} 個 Worker${pending ? ` · ${pending} 則回報待送達` : ""}`,
    none: "在桌面對話目錄中指派 Worker。",
    open: "開啟",
    pause: "暫停委派",
    resume: "恢復委派",
    recovering: "正在恢復委派",
    release: "不再作為專案 Agent",
    releaseConfirm: "確定不再作為專案 Agent？Worker 對話會保留為一般對話。",
    edit: "修改設定…",
    save: "儲存",
    stopWorker: "停止",
    removeWorker: "移出",
    removeConfirm: (name) =>
      `移出 ${name}？它的對話保留為一般對話，不再向專案 Agent 回報，也不再佔名額。`,
    reported: (time) => `${time} 回報`,
    status: {
      idle: "閒置",
      running: "執行中",
      starting: "啟動中",
      "awaiting-approval": "等你核准",
      "waiting-input": "等你回答",
      unavailable: "狀態未知",
    },
    paused: {
      "user-paused": "已暫停委派。",
      "restart-confirmation-required":
        "AgentKib 重新啟動後暫停了委派。恢復委派，或在這個對話裡傳一則訊息就會繼續。",
      "authorization-changed": "設定它的裝置授權已變更，已暫停委派。",
      "auto-turn-limit": "達到連續自動輪次上限，已暫停委派。在這個對話裡傳一則訊息就會繼續。",
      "usage-limit":
        "專案 Agent 達到使用上限，回報會在重置後繼續送達。在這個對話裡傳一則訊息也會繼續。",
      "report-undelivered": "回報沒有送達，已暫停委派。",
    },
    errors: {
      "lead-requires-managed-claude": "AgentKib 能控制此對話後，才能將它設為專案 Agent。",
      "session-is-a-worker": "這個對話是另一個專案 Agent 的 Worker。",
      "lead-exists": "這個對話已經是專案 Agent。",
      "worker-unavailable": "這個 Worker 已經不在專案 Agent 名下。",
      "worker-not-running": "這個 Worker 現在沒有在執行。",
    },
    failed: "沒有完成，請重試。",
  },
  "ja-JP": {
    title: "プロジェクト Agent",
    hint: "この会話は、あなたが割り当てたワーカーにタスクを任せ、結果の報告を受け取れます。",
    designate: "プロジェクト Agent にする…",
    designatePermission:
      "プロジェクト Agent に設定するには、この端末にフルアクセス、送信、会話管理、高度な操作の権限が必要です。",
    decides: "プロジェクト Agent に任せること",
    approveFiles: "ワーカーのファイル変更の承認",
    approveCommands: "ワーカーがサンドボックス外で実行するコマンドの承認",
    answers: "ワーカーからの質問",
    decidesNote:
      "通常の承認（1 回だけ許可、または拒否）に限ります。ネットワーク接続、追加の権限、ルールの変更を求める承認は引き続きあなたが行います。",
    decided: (items) => `任せていること：${items.join("、")}`,
    maxAutoTurns: "連続する自動ターンの上限",
    stallMinutes: "モデルの無応答しきい値（分）",
    confirm: "プロジェクト Agent にする",
    cancel: "キャンセル",
    summary: (workers, pending) =>
      `ワーカー ${workers} 件${pending ? ` · 未送信の報告 ${pending} 件` : ""}`,
    none: "デスクトップの会話一覧でワーカーを割り当ててください。",
    open: "開く",
    pause: "委任を一時停止",
    resume: "委任を再開",
    recovering: "委任を再開中",
    release: "プロジェクト Agent をやめる",
    releaseConfirm: "プロジェクト Agent をやめますか？ワーカーの会話は通常の会話として残ります。",
    edit: "設定を変更…",
    save: "保存",
    stopWorker: "停止",
    removeWorker: "外す",
    removeConfirm: (name) =>
      `${name} を外しますか？会話は通常の会話として残り、プロジェクト Agent に報告しなくなります。枠も空きます。`,
    reported: (time) => `${time}に報告`,
    status: {
      idle: "待機中",
      running: "実行中",
      starting: "起動中",
      "awaiting-approval": "承認待ち",
      "waiting-input": "回答待ち",
      unavailable: "状態不明",
    },
    paused: {
      "user-paused": "委任を一時停止しています。",
      "restart-confirmation-required":
        "AgentKib の再起動後、委任を一時停止しました。委任を再開するか、この会話にメッセージを送ると再開します。",
      "authorization-changed": "設定したデバイスの権限が変わったため、委任を一時停止しました。",
      "auto-turn-limit":
        "連続する自動ターンの上限に達したため、委任を一時停止しました。この会話にメッセージを送ると再開します。",
      "usage-limit":
        "プロジェクト Agent が利用制限に達しました。報告はリセット後に届けられます。この会話でメッセージを送っても続行します。",
      "report-undelivered": "報告を届けられなかったため、委任を一時停止しました。",
    },
    errors: {
      "lead-requires-managed-claude":
        "AgentKib がこの会話を制御できるようになると、プロジェクト Agent に設定できます。",
      "session-is-a-worker": "この会話は別のプロジェクト Agent のワーカーです。",
      "lead-exists": "この会話はすでにプロジェクト Agent です。",
      "worker-unavailable": "このワーカーはもうプロジェクト Agent の下にありません。",
      "worker-not-running": "このワーカーはいま実行中ではありません。",
    },
    failed: "完了できませんでした。もう一度お試しください。",
  },
  "en-US": {
    title: "Project Agent",
    hint: "This session can give tasks to the workers you assign and receive their reports.",
    designate: "Make Project Agent…",
    designatePermission:
      "Making a Project Agent requires full access and permission to send, manage sessions, and use advanced controls.",
    decides: "The Project Agent may decide",
    approveFiles: "Workers' file change approvals",
    approveCommands: "Workers' approvals to run commands outside the sandbox",
    answers: "Workers' questions",
    decidesNote:
      "Only plain approvals: allow once, or decline. Approvals that ask for network access, more permissions or a rule change still come to you.",
    decided: (items) => `Decides for you: ${items.join(", ")}`,
    maxAutoTurns: "Most automatic turns in a row",
    stallMinutes: "Model inactivity threshold (minutes)",
    confirm: "Make Project Agent",
    cancel: "Cancel",
    summary: (workers, pending) =>
      `${workers} ${workers === 1 ? "worker" : "workers"}${pending ? ` · ${pending} ${pending === 1 ? "report" : "reports"} waiting` : ""}`,
    none: "Assign workers from the desktop session directory.",
    open: "Open",
    pause: "Pause delegation",
    resume: "Resume delegation",
    recovering: "Resuming delegation…",
    release: "Stop being a Project Agent",
    releaseConfirm: "Stop being a Project Agent? The workers stay as ordinary sessions.",
    edit: "Change settings…",
    save: "Save",
    stopWorker: "Stop",
    removeWorker: "Remove",
    removeConfirm: (name) =>
      `Remove ${name} from this Project Agent? Its session stays as an ordinary session, it no longer reports here, and its place is free.`,
    reported: (time) => `reported ${time}`,
    status: {
      idle: "Idle",
      running: "Running",
      starting: "Starting",
      "awaiting-approval": "Waiting for your approval",
      "waiting-input": "Waiting for your answer",
      unavailable: "Status unknown",
    },
    paused: {
      "user-paused": "Delegation is paused.",
      "restart-confirmation-required":
        "Delegation paused when AgentKib restarted. Resume it, or send this session a message, to go on.",
      "authorization-changed": "Delegation paused: the device that set it up has changed access.",
      "auto-turn-limit":
        "Delegation paused at the limit of automatic turns. Send this session a message to go on.",
      "usage-limit":
        "The Project Agent hit its usage limit. Reports go on once it resets, or when you send a message in this session.",
      "report-undelivered": "Delegation paused: a report could not be delivered.",
    },
    errors: {
      "lead-requires-managed-claude":
        "AgentKib needs control of this session before it can become a Project Agent.",
      "session-is-a-worker": "This session is another Project Agent's worker.",
      "lead-exists": "This session is already a Project Agent.",
      "worker-unavailable": "This worker no longer belongs to the Project Agent.",
      "worker-not-running": "This worker is not running now.",
    },
    failed: "That did not work. Try again.",
  },
};

export function projectAgentCopy(locale: string): ProjectAgentCopy {
  return copy[
    locale === "zh-Hant"
      ? "zh-Hant"
      : locale.startsWith("zh")
        ? "zh-CN"
        : locale.startsWith("ja")
          ? "ja-JP"
          : "en-US"
  ];
}
