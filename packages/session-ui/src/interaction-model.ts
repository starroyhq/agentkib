export type InteractionLocale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";

/** The fields of an approval the card reads; web-client's `Approval` satisfies it. */
export interface InteractionApproval {
  requestId: string | number;
  turnId: string;
  method: string;
  toolName?: string;
  input?: unknown;
  context?: { description?: unknown; decisionReason?: unknown };
  toolCall?: unknown;
  options?: { optionId: string; name: string; kind: string }[];
  command?: unknown;
  cwd?: string | null;
  changes?: unknown;
  availableDecisions: string[];
  supported: boolean;
  decisionOptions?: {
    id: string;
    label: string;
    decision: unknown;
    scope: "once" | "session" | "persistent";
  }[];
  requestContext?: Record<string, unknown>;
  proposedExecpolicyAmendment?: string[] | null;
}

/** The fields of a question request the card reads; web-client's `UserQuestionRequest` satisfies it. */
export interface InteractionQuestionRequest {
  requestId: string | number;
  turnId: string;
  supported: boolean;
  questions: {
    id: string;
    header?: string;
    question: string;
    options: { label: string; description?: string }[];
    isSecret?: boolean;
    secret?: boolean;
    multiSelect: boolean;
    allowCustom: boolean;
  }[];
}

// Titles, labels and option names follow the Codex app's own approval and question cards
// (its zh-CN, zh-TW, en and ja language packs), with "conversation" written as AgentKib's "session".
const copy = {
  "zh-CN": {
    waitingApproval: "等待审批",
    waitingAnswer: "有问题待回答",
    question: "问题",
    details: "详情",
    collapse: "收起",
    expand: "展开",
    previous: "上一项",
    next: "下一项",
    nextQuestion: "下一步",
    back: "上一题",
    send: "发送",
    otherPlaceholder: "或自行撰写回复",
    replyPlaceholder: "回复…",
    showSecret: "显示内容",
    hideSecret: "隐藏内容",
    sending: "正在发送",
    commandTitle: "是否要让 {agent} 运行此命令？",
    filesTitle: "允许 {agent} 编辑以下文件吗？",
    networkTitle: "允许 {agent} 与 {host} 建立连接？",
    permissionsTitle: "{agent} 请求权限",
    toolTitle: "是否允许 {agent} 使用 {tool}？",
    mcpTitle: "{server} 需要你处理",
    mcpToolTitle: "是否允许 {server} 运行 {tool} 工具？",
    unknownTitle: "{agent} 有一个请求需要处理",
    unknownTool: "未知工具",
    terminal: "终端",
    fileEdits: "编辑文件",
    parameters: "参数",
    reason: "原因：",
    needs: "需要：",
    listSeparator: "、",
    runsIn: "在 {path} 中运行",
    moreFiles: "还有 {count} 个文件",
    needNetwork: "访问网络",
    needRead: "读取 {path}",
    needWrite: "写入 {path}",
    needDeny: "禁止访问 {path}",
    needRoot: "授权目录 {path}",
    allowOnce: "允许一次",
    allowSession: "允许此会话",
    alwaysAllow: "始终允许",
    alwaysDeny: "始终拒绝",
    deny: "拒绝",
    allow: "允许",
    moreOptions: "更多选项",
    accept: "接受",
    allowTurn: "允许本轮",
    allowAllEdits: "允许所有修改",
    denyAndStop: "拒绝并停止本轮",
    sessionCommandDetail: "本会话中这条命令不再询问",
    persistentCommandDetail: "以后以 {command} 开头的命令都不再询问",
    allEditsDetail: "本会话中这次及之后的文件编辑都不再询问",
    networkAllowDetail: "以后连接 {host} 不再询问",
    networkDenyDetail: "以后连接 {host} 直接拒绝",
    networkReason: "{host} 不在当前网络允许列表中",
    declineContinues: "拒绝后 {agent} 继续本轮",
    unsupportedOption: "这台电脑提供的这个选项暂不支持",
    sendFailed: "未能发送你的决定。请检查网络连接后重试。",
    uncertain: "上次的决定还没确认送达，正在查询，不会自动重发",
    answeredElsewhere: "已在 {agent} 中处理",
    noApprovePermission: "这次访问没有审批权限，请在电脑上处理",
    noSendPermission: "这次访问没有回答权限，请在电脑上处理",
    unsupported: "AgentKib 还不能处理这类请求，请在 {agent} 中处理",
    declineOnly: "需要填写表单或打开链接，AgentKib 还不支持",
    unavailableQuestion: "此问题已失效或暂时无法回答",
    tooLong: "每条回答最多 4096 个字符且不超过 8192 个 UTF-8 字节，请缩短回答。",
    duplicate: "自定义回答与已选选项重复，请修改或取消重复项。",
    tooLarge: "回答总量超过请求上限，请减少选项或缩短回答。",
  },
  "zh-TW": {
    waitingApproval: "等待審批",
    waitingAnswer: "有問題待回答",
    question: "問題",
    details: "詳細資料",
    collapse: "收合",
    expand: "展開",
    previous: "上一項",
    next: "下一項",
    nextQuestion: "下一步",
    back: "上一題",
    send: "傳送",
    otherPlaceholder: "或自行輸入回覆",
    replyPlaceholder: "回覆…",
    showSecret: "顯示內容",
    hideSecret: "隱藏內容",
    sending: "正在傳送",
    commandTitle: "你想要 {agent} 執行此命令嗎？",
    filesTitle: "是否允許 {agent} 編輯下列檔案？",
    networkTitle: "允許 {agent} 連線到 {host} 嗎？",
    permissionsTitle: "{agent} 請求權限",
    toolTitle: "是否允許 {agent} 使用 {tool}？",
    mcpTitle: "{server} 需要你處理",
    mcpToolTitle: "允許 {server} 執行 {tool} 工具嗎？",
    unknownTitle: "{agent} 有一個請求需要處理",
    unknownTool: "未知工具",
    terminal: "終端機",
    fileEdits: "編輯檔案",
    parameters: "參數",
    reason: "原因：",
    needs: "需要：",
    listSeparator: "、",
    runsIn: "在 {path} 中執行",
    moreFiles: "還有 {count} 個檔案",
    needNetwork: "存取網路",
    needRead: "讀取 {path}",
    needWrite: "寫入 {path}",
    needDeny: "禁止存取 {path}",
    needRoot: "授權目錄 {path}",
    allowOnce: "允許一次",
    allowSession: "允許此對話",
    alwaysAllow: "一律允許",
    alwaysDeny: "一律拒絕",
    deny: "拒絕",
    allow: "允許",
    moreOptions: "更多選項",
    accept: "接受",
    allowTurn: "允許本輪",
    allowAllEdits: "允許所有編輯",
    denyAndStop: "拒絕並停止本輪",
    sessionCommandDetail: "此對話中這條命令不再詢問",
    persistentCommandDetail: "以後以 {command} 開頭的命令都不再詢問",
    allEditsDetail: "允許本次及此對話日後的檔案編輯，不再詢問",
    networkAllowDetail: "以後連線到 {host} 不再詢問",
    networkDenyDetail: "以後連線到 {host} 直接拒絕",
    networkReason: "{host} 不在目前的網路允許清單中",
    declineContinues: "拒絕後 {agent} 會繼續本輪",
    unsupportedOption: "這台電腦提供的這個選項暫不支援",
    sendFailed: "無法傳送你的決定。請檢查連線後再試一次。",
    uncertain: "上次的決定尚未確認送達，正在查詢，不會自動重送",
    answeredElsewhere: "已在 {agent} 中處理",
    noApprovePermission: "這次存取沒有審批權限，請在電腦上處理",
    noSendPermission: "這次存取沒有回答權限，請在電腦上處理",
    unsupported: "AgentKib 尚無法處理這類請求，請在 {agent} 中處理",
    declineOnly: "需要填寫表單或開啟連結，AgentKib 尚不支援",
    unavailableQuestion: "此問題已失效或暫時無法回答",
    tooLong: "每條回答最多 4096 個字元且不超過 8192 個 UTF-8 位元組，請縮短回答。",
    duplicate: "自訂回答與已選選項重複，請修改或取消重複項。",
    tooLarge: "回答總量超過請求上限，請減少選項或縮短回答。",
  },
  "en-US": {
    waitingApproval: "Approval required",
    waitingAnswer: "Question waiting",
    question: "Question",
    details: "Details",
    collapse: "Collapse",
    expand: "Expand",
    previous: "Previous",
    next: "Next",
    nextQuestion: "Next",
    back: "Back",
    send: "Send",
    otherPlaceholder: "Or write your own response",
    replyPlaceholder: "Reply…",
    showSecret: "Show",
    hideSecret: "Hide",
    sending: "Sending",
    commandTitle: "Do you want {agent} to run this command?",
    filesTitle: "Allow {agent} to edit the following files?",
    networkTitle: "Allow {agent} to connect to {host}?",
    permissionsTitle: "{agent} is asking for permissions",
    toolTitle: "Allow {agent} to use {tool}?",
    mcpTitle: "{server} needs your input",
    mcpToolTitle: "Allow {server} to run {tool} tool?",
    unknownTitle: "{agent} has a request for you",
    unknownTool: "Unknown tool",
    terminal: "Terminal",
    fileEdits: "Edit files",
    parameters: "Parameters",
    reason: "Reason: ",
    needs: "Needs: ",
    listSeparator: ", ",
    runsIn: "Runs in {path}",
    moreFiles: "{count} more files",
    needNetwork: "network access",
    needRead: "read {path}",
    needWrite: "write {path}",
    needDeny: "no access to {path}",
    needRoot: "granted folder {path}",
    allowOnce: "Allow once",
    allowSession: "Allow for this session",
    alwaysAllow: "Always allow",
    alwaysDeny: "Always deny",
    deny: "Deny",
    allow: "Allow",
    moreOptions: "More options",
    accept: "Accept",
    allowTurn: "Allow for this turn",
    allowAllEdits: "Allow all edits",
    denyAndStop: "Deny and stop this turn",
    sessionCommandDetail: "Don't ask again for this command in this session",
    persistentCommandDetail: "Don't ask again for commands that start with {command}",
    allEditsDetail: "Allow this and future file edits in this session without asking again",
    networkAllowDetail: "Don't ask again before connecting to {host}",
    networkDenyDetail: "Always refuse connections to {host}",
    networkReason: "{host} isn't on the current network allowlist",
    declineContinues: "{agent} continues this turn after you deny",
    unsupportedOption: "This computer offered an option AgentKib doesn't support yet",
    sendFailed: "Couldn't send your decision. Check the connection and try again.",
    uncertain:
      "Your last decision isn't confirmed yet. Checking now; it won't be resent automatically.",
    answeredElsewhere: "Handled in {agent}",
    noApprovePermission: "This access can't approve requests. Handle it on the computer.",
    noSendPermission: "This access can't answer questions. Handle it on the computer.",
    unsupported: "AgentKib can't handle this request yet. Handle it in {agent}.",
    declineOnly: "This needs a form or a link, which AgentKib doesn't support yet",
    unavailableQuestion: "This question is no longer available or cannot be answered now",
    tooLong:
      "Each answer must fit within 4096 characters and 8192 UTF-8 bytes. Shorten your answer.",
    duplicate: "The custom answer duplicates a selected option. Change or deselect it.",
    tooLarge: "The answers exceed the request limit. Select fewer options or shorten your answers.",
  },
  "ja-JP": {
    waitingApproval: "承認待ち",
    waitingAnswer: "回答待ちの質問",
    question: "質問",
    details: "詳細",
    collapse: "折りたたむ",
    expand: "展開",
    previous: "前へ",
    next: "次へ",
    nextQuestion: "次へ",
    back: "戻る",
    send: "送信",
    otherPlaceholder: "または自分で回答を入力",
    replyPlaceholder: "返信…",
    showSecret: "表示",
    hideSecret: "非表示",
    sending: "送信中",
    commandTitle: "{agent} にこのコマンドを実行させますか？",
    filesTitle: "{agent} に次のファイルの編集を許可しますか？",
    networkTitle: "{agent} が {host} に接続することを許可しますか？",
    permissionsTitle: "{agent} が権限を求めています",
    toolTitle: "{agent} に {tool} の使用を許可しますか？",
    mcpTitle: "{server} からの入力依頼",
    mcpToolTitle: "{server} に {tool} ツールの実行を許可しますか？",
    unknownTitle: "{agent} から対応が必要なリクエストがあります",
    unknownTool: "不明なツール",
    terminal: "ターミナル",
    fileEdits: "ファイルを編集",
    parameters: "パラメーター",
    reason: "理由：",
    needs: "必要：",
    listSeparator: "、",
    runsIn: "{path} で実行",
    moreFiles: "ほか {count} 件のファイル",
    needNetwork: "ネットワークアクセス",
    needRead: "{path} の読み取り",
    needWrite: "{path} への書き込み",
    needDeny: "{path} へのアクセス禁止",
    needRoot: "許可するフォルダー {path}",
    allowOnce: "一度だけ許可",
    allowSession: "この会話で許可",
    alwaysAllow: "常に許可",
    alwaysDeny: "常に拒否",
    deny: "拒否",
    allow: "許可",
    moreOptions: "その他のオプション",
    accept: "承認",
    allowTurn: "このターンで許可",
    allowAllEdits: "すべての編集を許可",
    denyAndStop: "拒否してこのターンを停止",
    sessionCommandDetail: "この会話ではこのコマンドを確認しません",
    persistentCommandDetail: "今後 {command} で始まるコマンドは確認しません",
    allEditsDetail: "この会話で、今回および今後のファイル編集を確認なしで許可します",
    networkAllowDetail: "今後 {host} への接続は確認しません",
    networkDenyDetail: "今後 {host} への接続は常に拒否します",
    networkReason: "{host} は現在のネットワーク許可リストに含まれていません",
    declineContinues: "拒否すると {agent} はこのターンを続けます",
    unsupportedOption: "このコンピューターが提示した選択肢にはまだ対応していません",
    sendFailed: "選択内容を送信できませんでした。接続を確認して、もう一度試してください。",
    uncertain: "前回の決定が届いたかまだ確認できていません。確認中です。自動で再送はしません。",
    answeredElsewhere: "{agent} で対応済みです",
    noApprovePermission: "このアクセスでは承認できません。コンピューターで対応してください。",
    noSendPermission: "このアクセスでは回答できません。コンピューターで対応してください。",
    unsupported: "AgentKib ではまだこのリクエストを処理できません。{agent} で対応してください。",
    declineOnly: "フォームの入力やリンクを開く必要があり、AgentKib はまだ対応していません",
    unavailableQuestion: "この質問は無効か、現在回答できません",
    tooLong: "各回答は4096文字以内かつUTF-8で8192バイト以内にしてください。",
    duplicate: "自由回答が選択済みの項目と重複しています。変更または選択解除してください。",
    tooLarge: "回答の合計が上限を超えています。選択数を減らすか回答を短くしてください。",
  },
} satisfies Record<InteractionLocale, Record<string, string>>;
export type InteractionCardCopy = (typeof copy)["zh-CN"];

export function interactionCardCopy(locale: InteractionLocale): InteractionCardCopy {
  return copy[locale] ?? copy["en-US"];
}

export function fillCopy(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
const SHELL = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh$/;

/**
 * The command as the user would type it: Codex wraps commands in `<shell> -lc '<command>'`,
 * which says nothing about what will run, so the wrapper and its quoting are dropped.
 */
export function displayCommand(command: unknown): string | undefined {
  if (Array.isArray(command)) {
    const parts = strings(command);
    if (parts.length === 3 && SHELL.test(parts[0]) && /^-l?c$/.test(parts[1]))
      return text(parts[2]);
    return text(parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" "));
  }
  const value = text(command);
  if (!value) return undefined;
  const wrapped = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(value);
  if (!wrapped) return value;
  return wrapped[1] === "'"
    ? wrapped[2].replace(/'\\''/g, "'")
    : wrapped[2].replace(/\\(["\\$`])/g, "$1");
}

function diffCounts(diff: unknown) {
  let added = 0,
    removed = 0;
  if (typeof diff === "string")
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
  return { added, removed };
}

const MAX_FILES = 6;
/** One line per changed file, with its added and removed line counts when the diff is known. */
function fileLines(changes: unknown, t: InteractionCardCopy): string[] {
  // Codex sends either a list of `{path, kind, diff}` or a map keyed by path.
  const list: Record<string, unknown>[] = Array.isArray(changes)
    ? changes.map(object)
    : Object.entries(object(changes)).map(([path, value]) => ({ ...object(value), path }));
  const lines = list.flatMap((change) => {
    const path = text(change.path);
    if (!path) return [];
    const kind = object(change.kind);
    const moved = text(kind.move_path) ?? text(change.move_path);
    const { added, removed } = diffCounts(change.diff ?? change.unified_diff);
    return [
      `${path}${moved ? ` → ${moved}` : ""}${added || removed ? `   +${added} −${removed}` : ""}`,
    ];
  });
  return lines.length > MAX_FILES
    ? [...lines.slice(0, MAX_FILES), fillCopy(t.moreFiles, { count: lines.length - MAX_FILES })]
    : lines;
}

/** Tool parameters, one `key: value` per line, for tools the card has no special form for. */
function parameterLines(input: unknown): string[] {
  return Object.entries(object(input))
    .slice(0, 6)
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${rendered && rendered.length > 160 ? `${rendered.slice(0, 159)}…` : rendered}`;
    });
}

function networkHost(context: Record<string, unknown>): string | undefined {
  const network = object(context.networkApprovalContext);
  const host = text(network.host);
  return host && text(network.protocol) ? `${network.protocol}://${host}` : host;
}

/** What the request asks to be allowed, in plain words, one item per permission. */
function permissionNeeds(context: Record<string, unknown>, t: InteractionCardCopy): string[] {
  const needs: string[] = [];
  const root = text(context.grantRoot);
  if (root) needs.push(fillCopy(t.needRoot, { path: root }));
  for (const permissions of [object(context.permissions), object(context.additionalPermissions)]) {
    if (object(permissions.network).enabled === true) needs.push(t.needNetwork);
    const files = object(permissions.fileSystem);
    for (const path of strings(files.read)) needs.push(fillCopy(t.needRead, { path }));
    for (const path of strings(files.write)) needs.push(fillCopy(t.needWrite, { path }));
    if (Array.isArray(files.entries))
      for (const entry of files.entries) {
        const item = object(entry),
          location = object(item.path);
        const path = text(location.path) ?? text(location.pattern);
        if (!path) continue;
        needs.push(
          fillCopy(
            item.access === "write"
              ? t.needWrite
              : item.access === "read"
                ? t.needRead
                : t.needDeny,
            { path },
          ),
        );
      }
  }
  return [...new Set(needs)];
}

function trimSlash(path: string) {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}
/** The directory only when it is not the workspace itself, relative to the workspace if inside it. */
function locationLine(
  cwd: unknown,
  workspacePath: string | undefined,
  t: InteractionCardCopy,
): string | undefined {
  const path = text(cwd);
  if (!path) return undefined;
  const root = workspacePath ? trimSlash(workspacePath) : undefined;
  const current = trimSlash(path);
  if (root && current === root) return undefined;
  if (root && (current.startsWith(`${root}/`) || current.startsWith(`${root}\\`)))
    return fillCopy(t.runsIn, { path: current.slice(root.length + 1) });
  return fillCopy(t.runsIn, { path });
}

export type InteractionIcon = "command" | "files" | "network" | "permissions" | "tool" | "unknown";

export interface ApprovalChoice {
  key: string;
  label: string;
  detail?: string;
  /** An extended Codex decision, sent as `nativeDecision` exactly as offered. */
  nativeDecision?: unknown;
  /** A basic decision name, sent as `decision`. */
  decision?: string;
  disabled?: boolean;
  /**
   * The one-click answers a compact card offers, such as the menu bar's: allow this request once,
   * or deny it ("stop" denies it and stops the turn, for requests that offer no plain denial).
   * Everything else is chosen on the full card.
   */
  quick?: "allow" | "deny" | "stop";
}

export interface ApprovalCardModel {
  icon: InteractionIcon;
  title: string;
  block?: { label: string; lines: string[] };
  message?: string;
  reason?: { label: string; text: string };
  needs?: { label: string; text: string };
  location?: string;
  choices: ApprovalChoice[];
  /** Said under the options when the only possible answer is to decline. */
  declineOnly?: string;
  /** The request as received, for the "Details" disclosure. */
  details: string;
  /** One line for the collapsed card and the pending list. */
  summary: string;
}

export interface ApprovalCardContext {
  locale: InteractionLocale;
  /** Display name of the session's agent, such as "Codex" or "Claude Code". */
  agent: string;
  workspacePath?: string;
  /**
   * Whether the composer offers Stop for this turn. Cancelling a turn is the composer's job, so
   * the card only offers it as "deny and stop" when Stop is not available.
   */
  canStop: boolean;
}

function commandPrefix(decision: unknown): string | undefined {
  const parts = strings(
    object(object(decision).acceptWithExecpolicyAmendment).execpolicy_amendment,
  );
  return parts.length
    ? parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")
    : undefined;
}

function extendedChoices(
  approval: InteractionApproval,
  t: InteractionCardCopy,
  canStop: boolean,
): ApprovalChoice[] {
  const files = approval.method === "item/fileChange/requestApproval";
  return (approval.decisionOptions ?? []).flatMap((option): ApprovalChoice[] => {
    const base = { key: option.id, nativeDecision: option.decision };
    switch (option.label) {
      case "accept":
        return [{ ...base, label: t.allowOnce, quick: "allow" }];
      case "acceptForSession":
        return [
          files
            ? { ...base, label: t.allowAllEdits, detail: t.allEditsDetail }
            : { ...base, label: t.allowSession, detail: t.sessionCommandDetail },
        ];
      case "acceptWithExecpolicyAmendment": {
        const command = commandPrefix(option.decision);
        return [
          {
            ...base,
            label: t.alwaysAllow,
            detail: command ? fillCopy(t.persistentCommandDetail, { command }) : undefined,
          },
        ];
      }
      case "applyNetworkPolicyAmendment": {
        const rule = object(
          object(object(option.decision).applyNetworkPolicyAmendment).network_policy_amendment,
        );
        const host = text(rule.host);
        const deny = rule.action === "deny";
        return [
          {
            ...base,
            label: deny ? t.alwaysDeny : t.alwaysAllow,
            detail: host
              ? fillCopy(deny ? t.networkDenyDetail : t.networkAllowDetail, { host })
              : undefined,
          },
        ];
      }
      case "decline":
      case "deny-permissions":
        return [{ ...base, label: t.deny, quick: "deny" }];
      case "cancel":
        return canStop ? [] : [{ ...base, label: t.denyAndStop, quick: "stop" }];
      case "grant-turn":
        return [{ ...base, label: t.allowTurn, quick: "allow" }];
      case "grant-session":
        return [{ ...base, label: t.allowSession }];
      default:
        return [{ ...base, label: option.label, detail: t.unsupportedOption, disabled: true }];
    }
  });
}

function basicChoices(
  approval: InteractionApproval,
  t: InteractionCardCopy,
  canStop: boolean,
): ApprovalChoice[] {
  const method = approval.method;
  if (method === "session/request_permission") {
    // ACP agents name their own options; show those names, in the agent's order.
    const ids = new Set(approval.availableDecisions);
    return (approval.options ?? [])
      .filter((option) => ids.has(option.optionId))
      .map((option) => ({
        key: option.optionId,
        label: option.name,
        decision: option.optionId,
        ...(option.kind === "allow_once"
          ? { quick: "allow" as const }
          : option.kind === "reject_once"
            ? { quick: "deny" as const }
            : {}),
      }));
  }
  if (method === "claude/can_use_tool")
    return approval.availableDecisions
      .filter((decision) => decision === "allow" || decision === "deny")
      .map((decision) => ({
        key: decision,
        label: decision === "allow" ? t.allow : t.deny,
        decision,
        quick: decision === "allow" ? ("allow" as const) : ("deny" as const),
      }));
  // An MCP form or link is accepted as a whole; everything else is allowed for this call only.
  const mcpForm =
    method === "mcpServer/elicitation/request" && object(approval.input).kind !== "tool-approval";
  return approval.availableDecisions.flatMap((decision): ApprovalChoice[] => {
    // An MCP form is filled in on the full card, never accepted in one click.
    if (decision === "accept")
      return [
        mcpForm
          ? { key: decision, decision, label: t.accept }
          : { key: decision, decision, label: t.allowOnce, quick: "allow" },
      ];
    if (decision === "decline") return [{ key: decision, decision, label: t.deny, quick: "deny" }];
    if (decision === "cancel" && !canStop)
      return [{ key: decision, decision, label: t.denyAndStop, quick: "stop" }];
    return [];
  });
}

function compactJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).filter(([, item]) => item != null)),
    null,
    2,
  );
}

/** Everything the approval card shows, derived from the request as the agent sent it. */
export function approvalCardModel(
  approval: InteractionApproval,
  context: ApprovalCardContext,
): ApprovalCardModel {
  const t = interactionCardCopy(context.locale);
  const agent = context.agent;
  const requestContext = object(approval.requestContext);
  const reasonText = text(requestContext.reason);
  const host = networkHost(requestContext);
  const input = object(approval.input);
  const choices = approval.decisionOptions?.length
    ? extendedChoices(approval, t, context.canStop)
    : basicChoices(approval, t, context.canStop);
  let icon: InteractionIcon = "unknown";
  let title = fillCopy(t.unknownTitle, { agent });
  let block: ApprovalCardModel["block"];
  let message: string | undefined;
  let reason = reasonText ? { label: t.reason, text: reasonText } : undefined;
  let summary: string | undefined;
  let declineOnly: string | undefined;
  const tool = text(approval.toolName);
  switch (approval.method) {
    case "item/commandExecution/requestApproval": {
      const command = displayCommand(approval.command);
      if (command) block = { label: t.terminal, lines: [command] };
      if (host) {
        icon = "network";
        title = fillCopy(t.networkTitle, { agent, host });
        reason ??= { label: t.reason, text: fillCopy(t.networkReason, { host }) };
      } else {
        icon = "command";
        title = fillCopy(t.commandTitle, { agent });
      }
      summary = command ?? host;
      break;
    }
    case "item/fileChange/requestApproval": {
      const lines = fileLines(approval.changes, t);
      icon = "files";
      title = fillCopy(t.filesTitle, { agent });
      if (lines.length) block = { label: t.fileEdits, lines };
      summary = lines[0]?.split("   ")[0];
      break;
    }
    case "item/permissions/requestApproval":
      icon = "permissions";
      title = fillCopy(t.permissionsTitle, { agent });
      break;
    case "claude/can_use_tool":
    case "dsh/approval": {
      const command = text(input.command);
      const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
      if (command) {
        icon = "command";
        title = fillCopy(t.commandTitle, { agent });
        block = { label: t.terminal, lines: [command] };
        summary = command;
      } else if (path && /edit|write/i.test(tool ?? "")) {
        icon = "files";
        title = fillCopy(t.filesTitle, { agent });
        block = { label: t.fileEdits, lines: [path] };
        summary = path;
      } else {
        icon = "tool";
        title = fillCopy(t.toolTitle, { agent, tool: tool ?? t.unknownTool });
        const lines = parameterLines(approval.input);
        if (lines.length) block = { label: t.parameters, lines };
        summary = tool;
      }
      const why = text(approval.context?.description) ?? text(approval.context?.decisionReason);
      if (why) reason = { label: t.reason, text: why };
      break;
    }
    case "session/request_permission": {
      const call = object(approval.toolCall);
      const name = text(call.title) ?? tool ?? t.unknownTool;
      icon = "tool";
      title = fillCopy(t.toolTitle, { agent, tool: name });
      const lines = parameterLines(call.rawInput);
      if (lines.length) block = { label: t.parameters, lines };
      summary = name;
      break;
    }
    case "mcpServer/elicitation/request": {
      const server = text(input.serverName) ?? text(input.server) ?? agent;
      const toolLabel = text(input.tool);
      icon = "tool";
      message = text(input.message);
      if (input.kind === "tool-approval" && toolLabel) {
        title = fillCopy(t.mcpToolTitle, { server, tool: toolLabel });
        const lines = parameterLines(input.params);
        if (lines.length) block = { label: t.parameters, lines };
        summary = toolLabel;
      } else {
        title = fillCopy(t.mcpTitle, { server });
        summary = message ?? server;
      }
      if (!approval.availableDecisions.includes("accept")) declineOnly = t.declineOnly;
      break;
    }
  }
  const needs = permissionNeeds(requestContext, t);
  if (declineOnly)
    for (const choice of choices)
      if (choice.decision === "decline") choice.detail = fillCopy(t.declineContinues, { agent });
  return {
    icon,
    title,
    block,
    message,
    reason,
    needs: needs.length ? { label: t.needs, text: needs.join(t.listSeparator) } : undefined,
    location: locationLine(approval.cwd ?? requestContext.cwd, context.workspacePath, t),
    choices,
    declineOnly,
    details: compactJson({
      method: approval.method,
      toolName: approval.toolName,
      command: approval.command,
      cwd: approval.cwd,
      changes: approval.changes,
      input: approval.input,
      toolCall: approval.toolCall,
      context: approval.context,
      requestContext: approval.requestContext,
      proposedExecpolicyAmendment: approval.proposedExecpolicyAmendment,
      decisionOptions: approval.decisionOptions?.map((option) => option.decision),
    }),
    summary: summary ?? title,
  };
}

export const MAX_ANSWER_LENGTH = 4096;
export const MAX_ANSWER_BYTES = 8192;
export type AnswerContext = { sessionId: string; bootId: string; expectedRevision: number };

export function answerRequestBody(
  request: InteractionQuestionRequest,
  answers: Record<string, string[]>,
  context: AnswerContext,
  requestId: string,
) {
  return { ...context, requestId, turnId: request.turnId, questionId: request.requestId, answers };
}

export function ownValue<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** Native requests outside the supported contract stay readable, never answerable. */
export function supportedQuestionRequest(request: InteractionQuestionRequest): boolean {
  if (!request.supported || !Array.isArray(request.questions) || !request.questions.length)
    return false;
  const ids = new Set<string>();
  return request.questions.every((q) => {
    if (
      !q ||
      typeof q.id !== "string" ||
      !q.id ||
      ids.has(q.id) ||
      typeof q.question !== "string" ||
      !q.question ||
      (q.header != null && typeof q.header !== "string") ||
      typeof q.multiSelect !== "boolean" ||
      typeof q.allowCustom !== "boolean" ||
      !Array.isArray(q.options) ||
      (!q.options.length && !q.allowCustom)
    )
      return false;
    ids.add(q.id);
    const labels = new Set<string>();
    return q.options.every((option) => {
      if (
        !option ||
        typeof option.label !== "string" ||
        !option.label ||
        labels.has(option.label) ||
        (option.description != null && typeof option.description !== "string")
      )
        return false;
      labels.add(option.label);
      return true;
    });
  });
}

/**
 * Why these answers cannot be sent, checked against the host's limits. The body size counts the
 * complete wire shape, including a 36-character request ID, because the HTTP limit counts UTF-8
 * JSON bytes rather than characters.
 */
export function answerProblem(
  request: InteractionQuestionRequest,
  answers: Record<string, string[]>,
  context: AnswerContext | undefined,
  locale: InteractionLocale,
): string | undefined {
  const t = interactionCardCopy(locale);
  const values = Object.values(answers);
  const body = answerRequestBody(
    request,
    answers,
    context ?? { sessionId: "", bootId: "", expectedRevision: 0 },
    "0".repeat(36),
  );
  if (
    values.some((items) =>
      items.some(
        (value) =>
          value.length > MAX_ANSWER_LENGTH ||
          new TextEncoder().encode(value).byteLength > MAX_ANSWER_BYTES,
      ),
    )
  )
    return t.tooLong;
  if (values.some((items) => new Set(items).size !== items.length)) return t.duplicate;
  if (
    Object.keys(answers).length > 32 ||
    Object.keys(answers).some((id) => id.length > 4096) ||
    values.some((items) => items.length > 64) ||
    new TextEncoder().encode(JSON.stringify(body)).byteLength > 64 * 1024
  )
    return t.tooLarge;
  return undefined;
}
