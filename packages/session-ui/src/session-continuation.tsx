import { useEffect, useId, useMemo, useRef, useState } from "react";

export type SessionContinuationAgent = "Codex" | "Claude Code";
export type SessionContinuationAction = () => void | Promise<void>;

export type SessionContinuationCopy = {
  placeholder: string;
  starting: string;
  running: string;
  terminalConnected: string;
  terminalBadge: string;
  terminalHint: string;
  terminalWatch: string;
  busy: (agent: string) => string;
  choice: (agent: string) => string;
  fork: string;
  forkHint: (title: string) => string;
  returnTo: (agent: string) => string;
  returned: (agent: string) => string;
  installPlugin: string;
  codexQuit: string;
  backgroundEnded: string;
  draftPreserved: string;
  ownerOpenedElsewhere: string;
  claudeWindowsUnsupported: string;
  codexVersionTooOld: string;
  codexConnected: string;
  codexHint: string;
  codexHandleThere: string;
  viewOnly: string;
  queued: string;
  connectTerminal: string;
  continueInClient: string;
  copyCommand: string;
  commandLoading: string;
  commandLoadFailed: string;
  retryCommand: string;
  commandCopying: string;
  commandCopied: string;
  manualCopy: string;
  commandLabel: string;
  hostCommandHelp: string;
  localCommandHelp: string;
};

const continuationCopy: Record<string, SessionContinuationCopy> = {
  "zh-CN": {
    placeholder: "继续这条会话…",
    starting: "正在启动…",
    running: "在 AgentKib 中运行",
    terminalConnected: "在终端中运行 · 已连接",
    terminalBadge: "终端",
    terminalHint: "审批和提问在终端中处理",
    terminalWatch: "在终端中继续这条会话，这里会同步显示",
    busy: (agent) => `正在 ${agent} 中使用`,
    choice: (agent) => `这条会话正在 ${agent} 中使用。为避免两边同时写入，请选择：`,
    fork: "分支会话并继续",
    forkHint: (title) => `原会话不受影响，新会话会标“分支自 ${title}”`,
    returnTo: (agent) => `回 ${agent} 继续`,
    returned: (agent) => `这条会话在 AgentKib 中只读，${agent} 那边关闭后会自动恢复`,
    installPlugin: "安装连接插件，以后自动连接",
    codexQuit: "只关掉 Codex 的窗口可能不够，完全退出应用后才能在这里继续",
    backgroundEnded: "后台进程已结束，下次发送时会自动继续",
    draftPreserved: "草稿已保留，回到这里后会恢复。",
    ownerOpenedElsewhere: "你在 Claude Code 里打开了这条会话，AgentKib 已停止，避免两边同时写入",
    claudeWindowsUnsupported: "Windows 上暂不支持在这里继续 Claude Code 会话",
    codexVersionTooOld: "Codex 版本过低，升级后可以在这里继续",
    codexConnected: "在 Codex 中运行 · 已连接",
    codexHint: "消息会交给 Codex 执行，模型和权限沿用 Codex 中的设置",
    codexHandleThere: "这项请求请在 Codex 中处理",
    viewOnly: "仅可查看",
    queued: "待发队列",
    connectTerminal: "连接终端",
    continueInClient: "在原客户端继续",
    copyCommand: "复制续接命令",
    commandLoading: "正在读取续接命令…",
    commandLoadFailed: "无法读取续接命令，请重试。",
    retryCommand: "重新读取命令",
    commandCopying: "正在复制…",
    commandCopied: "续接命令已复制",
    manualCopy: "无法自动复制，请手动复制下方命令。",
    commandLabel: "续接命令（手动复制）",
    hostCommandHelp:
      "在运行 AgentKib 的电脑上打开终端（Windows 请使用 PowerShell），粘贴并运行续接命令。如果原客户端仍占用这条会话，请先在原客户端继续。",
    localCommandHelp:
      "打开终端（Windows 请使用 PowerShell），粘贴并运行续接命令。如果原客户端仍占用这条会话，请先在原客户端继续。",
  },
  "zh-TW": {
    placeholder: "繼續這段對話…",
    starting: "正在啟動…",
    running: "在 AgentKib 中執行",
    terminalConnected: "在終端中執行 · 已連線",
    terminalBadge: "終端",
    terminalHint: "核准和提問在終端中處理",
    terminalWatch: "在終端中繼續這段對話，這裡會同步顯示",
    busy: (agent) => `正在 ${agent} 中使用`,
    choice: (agent) => `這段對話正在 ${agent} 中使用。為避免兩邊同時寫入，請選擇：`,
    fork: "分支對話並繼續",
    forkHint: (title) => `原對話不受影響，新對話會標「分支自 ${title}」`,
    returnTo: (agent) => `回 ${agent} 繼續`,
    returned: (agent) => `這段對話在 AgentKib 中為唯讀，${agent} 那邊關閉後會自動恢復`,
    installPlugin: "安裝連線外掛，以後自動連線",
    codexQuit: "只關閉 Codex 的視窗可能不夠，完全結束應用程式後才能在這裡繼續",
    backgroundEnded: "背景程序已結束，下次傳送訊息時會自動繼續",
    draftPreserved: "草稿已保留，回到這裡後會恢復。",
    ownerOpenedElsewhere: "你在 Claude Code 裡開啟了這段對話，AgentKib 已停止，避免兩邊同時寫入",
    claudeWindowsUnsupported: "Windows 上暫不支援在這裡繼續 Claude Code 對話",
    codexVersionTooOld: "Codex 版本過舊，升級後可以在這裡繼續",
    codexConnected: "在 Codex 中執行 · 已連線",
    codexHint: "訊息會交給 Codex 執行，模型和權限沿用 Codex 中的設定",
    codexHandleThere: "這項請求請在 Codex 中處理",
    viewOnly: "僅可查看",
    queued: "待發佇列",
    connectTerminal: "連接終端",
    continueInClient: "在原客戶端繼續",
    copyCommand: "複製續接命令",
    commandLoading: "正在讀取續接命令…",
    commandLoadFailed: "無法讀取續接命令，請重試。",
    retryCommand: "重新讀取命令",
    commandCopying: "正在複製…",
    commandCopied: "續接命令已複製",
    manualCopy: "無法自動複製，請手動複製下方命令。",
    commandLabel: "續接命令（手動複製）",
    hostCommandHelp:
      "在執行 AgentKib 的電腦上開啟終端（Windows 請使用 PowerShell），貼上並執行續接命令。如果原客戶端仍在使用這段對話，請先在原客戶端繼續。",
    localCommandHelp:
      "開啟終端（Windows 請使用 PowerShell），貼上並執行續接命令。如果原客戶端仍在使用這段對話，請先在原客戶端繼續。",
  },
  "ja-JP": {
    placeholder: "この会話を続ける…",
    starting: "起動中…",
    running: "AgentKib で実行中",
    terminalConnected: "ターミナルで実行中 · 接続済み",
    terminalBadge: "ターミナル",
    terminalHint: "承認と質問はターミナルで対応してください",
    terminalWatch: "この会話はターミナルで続けてください。ここにも同期して表示されます。",
    busy: (agent) => `${agent} で使用中`,
    choice: (agent) =>
      `この会話は ${agent} で使用中です。同時に書き込まれないよう、操作を選んでください：`,
    fork: "会話を分岐して続ける",
    forkHint: (title) =>
      `元の会話には影響しません。新しい会話には「${title} から分岐」と表示されます。`,
    returnTo: (agent) => `${agent} で続ける`,
    returned: (agent) =>
      `この会話は AgentKib では閲覧のみです。${agent} 側で閉じると、ここで続けられるようになります。`,
    installPlugin: "接続プラグインをインストールすると、次回から自動で接続されます",
    codexQuit:
      "Codex のウィンドウを閉じるだけでは不十分な場合があります。ここで続けるには、アプリを完全に終了してください。",
    backgroundEnded:
      "バックグラウンドプロセスを終了しました。次のメッセージ送信時に自動で続行します。",
    draftPreserved: "下書きを保存しています。ここに戻ると復元されます。",
    ownerOpenedElsewhere:
      "Claude Code でこの会話が開かれたため、同時に書き込まれないよう AgentKib を停止しました。",
    claudeWindowsUnsupported: "Windows では、ここで Claude Code の会話を続ける機能はまだ使えません",
    codexVersionTooOld: "Codex のバージョンが古いため、更新するとここで続けられます。",
    codexConnected: "Codex で実行中 · 接続済み",
    codexHint: "メッセージは Codex で実行され、モデルと権限は Codex 側の設定に従います",
    codexHandleThere: "このリクエストは Codex で対応してください",
    viewOnly: "閲覧のみ",
    queued: "送信待ちキュー",
    connectTerminal: "ターミナルに接続",
    continueInClient: "元のクライアントで続ける",
    copyCommand: "再開コマンドをコピー",
    commandLoading: "再開コマンドを読み込み中…",
    commandLoadFailed: "再開コマンドを読み込めませんでした。もう一度お試しください。",
    retryCommand: "コマンドを再読み込み",
    commandCopying: "コピー中…",
    commandCopied: "再開コマンドをコピーしました",
    manualCopy: "自動でコピーできませんでした。下のコマンドを手動でコピーしてください。",
    commandLabel: "再開コマンド（手動コピー）",
    hostCommandHelp:
      "AgentKib を実行しているコンピューターでターミナル（Windows では PowerShell）を開き、再開コマンドを貼り付けて実行してください。元のクライアントでこの会話を使用中の場合は、先にそちらで続けてください。",
    localCommandHelp:
      "ターミナル（Windows では PowerShell）を開き、再開コマンドを貼り付けて実行してください。元のクライアントでこの会話を使用中の場合は、先にそちらで続けてください。",
  },
  "en-US": {
    placeholder: "Continue this session…",
    starting: "Starting…",
    running: "Running in AgentKib",
    terminalConnected: "Running in terminal · Connected",
    terminalBadge: "Terminal",
    terminalHint: "Handle approvals and questions in the terminal",
    terminalWatch: "Continue this session in the terminal. It stays in sync here.",
    busy: (agent) => `In use in ${agent}`,
    choice: (agent) =>
      `This session is in use in ${agent}. To avoid both sides writing at once, choose:`,
    fork: "Fork and continue",
    forkHint: (title) =>
      `The original session stays as is. The new one is marked "Forked from ${title}".`,
    returnTo: (agent) => `Continue in ${agent}`,
    returned: (agent) =>
      `This session is view only in AgentKib. You can continue here once it's closed in ${agent}.`,
    installPlugin: "Install the connection plugin to connect automatically",
    codexQuit:
      "Closing the Codex window may not be enough. Quit the app completely to continue here.",
    backgroundEnded:
      "The background process ended. It will resume automatically when you send your next message.",
    draftPreserved: "Your draft is kept and will be restored when you return here.",
    ownerOpenedElsewhere:
      "You opened this session in Claude Code. AgentKib stopped to avoid both sides writing at once.",
    claudeWindowsUnsupported: "Continuing Claude Code sessions here isn't supported on Windows yet",
    codexVersionTooOld: "Your Codex version is too old. Update it to continue here.",
    codexConnected: "Running in Codex · Connected",
    codexHint: "Messages run in Codex, using the model and permissions set there",
    codexHandleThere: "Handle this request in Codex",
    viewOnly: "View only",
    queued: "Queued messages",
    connectTerminal: "Connect terminal",
    continueInClient: "Continue in the original client",
    copyCommand: "Copy resume command",
    commandLoading: "Loading resume command…",
    commandLoadFailed: "Could not load the resume command. Try again.",
    retryCommand: "Reload command",
    commandCopying: "Copying…",
    commandCopied: "Resume command copied",
    manualCopy: "Could not copy automatically. Copy the command below manually.",
    commandLabel: "Resume command (manual copy)",
    hostCommandHelp:
      "On the computer running AgentKib, open a terminal (use PowerShell on Windows), paste the resume command and run it. If this session is still in use in the original client, continue there first.",
    localCommandHelp:
      "Open a terminal (use PowerShell on Windows), paste the resume command and run it. If this session is still in use in the original client, continue there first.",
  },
};

export function sessionContinuationCopy(locale: string): SessionContinuationCopy {
  const key =
    locale === "zh-TW"
      ? "zh-TW"
      : locale.startsWith("zh")
        ? "zh-CN"
        : locale.startsWith("ja")
          ? "ja-JP"
          : "en-US";
  return continuationCopy[key];
}

export type SessionContinuationChoiceProps = {
  locale: string;
  agent: SessionContinuationAgent;
  title: string;
  onFork: SessionContinuationAction;
  onReturn: SessionContinuationAction;
  disabled?: boolean;
  forkDisabled?: boolean;
  hasDraft?: boolean;
  /** Offer only once a connected terminal accepts messages sent from AgentKib. */
  pluginAction?: SessionContinuationAction;
};

const continuationButtonClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium whitespace-normal transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 sm:w-auto";

export function SessionContinuationChoice({
  locale,
  agent,
  title,
  onFork,
  onReturn,
  disabled,
  forkDisabled,
  hasDraft,
  pluginAction,
}: SessionContinuationChoiceProps) {
  const copy = sessionContinuationCopy(locale);
  const choiceId = useId();
  const hintId = useId();
  return (
    <div
      role="group"
      aria-labelledby={choiceId}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-muted/30 p-4"
    >
      <p id={choiceId} className="text-sm leading-6 text-foreground">
        {copy.choice(agent)}
      </p>
      <div className="flex min-w-0 flex-wrap items-start gap-3">
        <div className="flex min-w-0 basis-full flex-col items-start gap-1.5 sm:basis-auto sm:flex-1">
          <button
            type="button"
            className={`${continuationButtonClass} bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]`}
            aria-describedby={hintId}
            disabled={disabled || forkDisabled}
            onClick={onFork}
          >
            {copy.fork}
          </button>
          <p id={hintId} className="text-xs leading-5 break-words text-muted-foreground">
            {copy.forkHint(title)}
          </p>
        </div>
        <button
          type="button"
          className={`${continuationButtonClass} border border-border bg-background text-foreground hover:bg-muted`}
          disabled={disabled}
          onClick={onReturn}
        >
          {copy.returnTo(agent)}
        </button>
        {agent === "Claude Code" && pluginAction ? (
          <button
            type="button"
            className={`${continuationButtonClass} text-muted-foreground underline underline-offset-4 hover:text-foreground`}
            disabled={disabled}
            onClick={pluginAction}
          >
            {copy.installPlugin}
          </button>
        ) : null}
      </div>
      {hasDraft ? (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {copy.draftPreserved}
        </p>
      ) : null}
      {agent === "Codex" ? (
        <p className="text-xs leading-5 text-muted-foreground">{copy.codexQuit}</p>
      ) : null}
    </div>
  );
}

export type SessionContinuationStatusProps = {
  label: string | null | undefined;
  active?: boolean;
  loading?: boolean;
  className?: string;
};

export function SessionContinuationStatus({
  label,
  active,
  loading,
  className,
}: SessionContinuationStatusProps) {
  if (!label?.trim()) return null;
  return (
    <span
      role="status"
      aria-busy={loading || undefined}
      className={`inline-flex max-w-full items-center gap-1.5 text-xs ${active || loading ? "text-primary-text" : "text-muted-foreground"} ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className={
          loading
            ? "size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
            : "size-1.5 shrink-0 rounded-full bg-current"
        }
      />
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
}

/** Shown after the user chooses to continue in the other client instead of forking. */
export function SessionContinuationReturned({
  locale,
  agent,
  hasDraft,
}: {
  locale: string;
  agent: SessionContinuationAgent;
  hasDraft?: boolean;
}) {
  const copy = sessionContinuationCopy(locale);
  return (
    <div
      role="status"
      className="min-w-0 space-y-1.5 rounded-xl border border-border bg-muted/30 p-4"
    >
      <p className="text-sm leading-6 text-foreground">{copy.returned(agent)}</p>
      {hasDraft ? (
        <p className="text-xs leading-5 text-muted-foreground">{copy.draftPreserved}</p>
      ) : null}
      {agent === "Codex" ? (
        <p className="text-xs leading-5 text-muted-foreground">{copy.codexQuit}</p>
      ) : null}
    </div>
  );
}

export type SessionContinuationTerminalProps = {
  locale: string;
  stop?: { label: string; onStop: SessionContinuationAction; disabled?: boolean };
};

/** A connected terminal that cannot take messages from AgentKib is followed, not typed into. */
export function SessionContinuationTerminal({ locale, stop }: SessionContinuationTerminalProps) {
  const copy = sessionContinuationCopy(locale);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-border bg-muted/30 p-4">
      <p className="min-w-0 flex-1 basis-60 text-sm leading-6 text-foreground">
        {copy.terminalWatch}
      </p>
      {stop ? (
        <button
          type="button"
          className={`${continuationButtonClass} border border-border bg-background text-foreground hover:bg-muted`}
          disabled={stop.disabled}
          onClick={stop.onStop}
        >
          {stop.label}
        </button>
      ) : null}
    </div>
  );
}

export type SessionContinuationReadOnlyProps = {
  locale: string;
  reason?: string | null;
  loadCommand: (signal: AbortSignal) => Promise<string>;
  onCopied?: () => void;
  /** The viewer is on the computer that runs AgentKib, so the help need not name it. */
  local?: boolean;
};

type CommandSource = {
  loadCommand: SessionContinuationReadOnlyProps["loadCommand"];
  attempt: number;
};
type LoadedCommand = { source: CommandSource; command?: string; failed?: true };
type CommandCopy = { source: CommandSource; status: "copying" | "copied" | "manual" };

export function SessionContinuationReadOnly({
  locale,
  reason,
  loadCommand,
  onCopied,
  local,
}: SessionContinuationReadOnlyProps) {
  const copy = sessionContinuationCopy(locale);
  const helpId = useId();
  const commandId = useId();
  const [attempt, setAttempt] = useState(0);
  // A fresh identity also fences A → B → A selections that reuse the same loader.
  const source = useMemo(() => ({ loadCommand, attempt }), [loadCommand, attempt]);
  const [loaded, setLoaded] = useState<LoadedCommand>();
  const [feedback, setFeedback] = useState<CommandCopy>();
  const active = useRef<{ source: CommandSource; controller: AbortController } | null>(null);
  const copyFlight = useRef<{ source: CommandSource } | null>(null);
  useEffect(() => {
    const request = { source, controller: new AbortController() };
    active.current = request;
    void (async () => {
      try {
        const command = await source.loadCommand(request.controller.signal);
        if (active.current !== request || request.controller.signal.aborted) return;
        setLoaded(command.trim() ? { source, command } : { source, failed: true });
      } catch {
        if (active.current === request && !request.controller.signal.aborted)
          setLoaded({ source, failed: true });
      }
    })();
    return () => {
      request.controller.abort();
      if (active.current === request) active.current = null;
    };
  }, [source]);
  const state = loaded?.source === source ? loaded : undefined;
  const outcome = feedback?.source === source ? feedback.status : undefined;
  const loading = !state;
  const copying = outcome === "copying";
  async function copyCommand() {
    const request = active.current;
    if (
      !state?.command ||
      copying ||
      copyFlight.current?.source === source ||
      !request ||
      request.source !== source
    )
      return;
    const command = state.command;
    const flight = { source };
    copyFlight.current = flight;
    setFeedback({ source, status: "copying" });
    const current = () =>
      active.current === request &&
      !request.controller.signal.aborted &&
      copyFlight.current === flight;
    try {
      if (!navigator.clipboard?.writeText) {
        if (current()) setFeedback({ source, status: "manual" });
        return;
      }
      await navigator.clipboard.writeText(command);
      if (current()) {
        setFeedback({ source, status: "copied" });
        onCopied?.();
      }
    } catch {
      if (current()) setFeedback({ source, status: "manual" });
    } finally {
      if (copyFlight.current === flight) copyFlight.current = null;
    }
  }
  const status = loading
    ? copy.commandLoading
    : state.failed
      ? copy.commandLoadFailed
      : copying
        ? copy.commandCopying
        : outcome === "copied"
          ? onCopied
            ? undefined
            : copy.commandCopied
          : outcome === "manual"
            ? copy.manualCopy
            : undefined;
  return (
    <div
      role="group"
      aria-label={copy.continueInClient}
      aria-describedby={helpId}
      className="min-w-0 space-y-3 rounded-xl border border-border bg-muted/30 p-4"
    >
      {reason?.trim() ? <p className="text-sm leading-6 text-foreground">{reason}</p> : null}
      <p id={helpId} className="text-xs leading-5 text-muted-foreground">
        {local ? copy.localCommandHelp : copy.hostCommandHelp}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`${continuationButtonClass} border border-border bg-background text-foreground hover:bg-muted`}
          disabled={loading || copying || !state?.command}
          aria-busy={loading || copying || undefined}
          onClick={() => void copyCommand()}
        >
          {copy.copyCommand}
        </button>
        {state?.failed ? (
          <button
            type="button"
            className={`${continuationButtonClass} border border-border bg-background text-foreground hover:bg-muted`}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {copy.retryCommand}
          </button>
        ) : null}
      </div>
      {status ? (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {status}
        </p>
      ) : null}
      {outcome === "manual" && state?.command ? (
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={commandId} className="block text-xs text-muted-foreground">
            {copy.commandLabel}
          </label>
          <textarea
            id={commandId}
            readOnly
            rows={3}
            value={state.command}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-24 w-full min-w-0 rounded-md border border-border bg-background p-3 font-mono text-sm break-all text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      ) : null}
    </div>
  );
}

/** List presentation uses observed runtime ownership and never grants controls. */
export function sessionContinuationListState(
  session: {
    agent: string;
    availability?: string;
    remote?: unknown;
    continuation?: {
      status: string;
      executionLocation?: string | null;
      ownershipReason?: string | null;
      reason?: string | null;
    };
  },
  locale: string,
): { label: string; active?: boolean; dot?: boolean } | undefined {
  const copy = sessionContinuationCopy(locale);
  if (session.remote) return undefined;
  if (session.availability === "metadata-only") return { label: copy.viewOnly };
  const state = session.continuation;
  if (!state || !["codex", "claude-code"].includes(session.agent)) return undefined;
  if (state.status === "outcome-unknown" || state.reason === "control-outcome-unconfirmed")
    return undefined;
  // Lists show only what is known without probing other clients. Use elsewhere is confirmed when
  // the session is opened; a short-lived observation here would flicker in and out.
  if (
    state.executionLocation === "external" ||
    [
      "codex-owner-busy",
      "claude-owner-busy",
      "claude-background-session-running",
      "owner-opened-elsewhere",
    ].includes(state.ownershipReason ?? "")
  )
    return undefined;
  if (state.executionLocation === "terminal" && session.agent === "claude-code")
    return { label: copy.terminalBadge, dot: true };
  if (state.executionLocation === "agentkib" || state.status === "starting")
    return { label: copy.running, active: true, dot: true };
  if (
    [
      "platform-unsupported",
      "claude-cli-unavailable",
      "unsupported-codex-cli-version",
      "codex-cli-version-too-old",
    ].includes(state.reason ?? "") ||
    state.status === "unsupported" ||
    !!state.reason
  )
    return { label: copy.viewOnly };
  return undefined;
}

export function SessionContinuationDot({ label, active }: { label: string; active?: boolean }) {
  return (
    <>
      <i
        aria-hidden="true"
        title={label}
        className={`inline-block size-1.5 shrink-0 rounded-full ${active ? "bg-primary" : "bg-muted-foreground"}`}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}
