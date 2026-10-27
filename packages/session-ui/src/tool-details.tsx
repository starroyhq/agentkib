import { useId, useState, type ReactNode } from "react";

/*
 * Views for `tool-summary` items that carry a typed `tool` detail. The types
 * mirror `ConversationToolDetail` in @agentkib/runtime-protocol structurally;
 * this package has no protocol dependency. Every value is rendered as text:
 * previews were bounded and redacted by the host, and nothing here uses HTML.
 */
export type ToolDetailKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
export type ToolDetailContentView =
  | { type: "text"; label?: "input" | "output"; text: string; truncated?: boolean }
  | {
      type: "terminal";
      command?: string;
      output?: string;
      exit_code?: number | null;
      truncated?: boolean;
    }
  | {
      type: "diff";
      path: string;
      change: "add" | "update" | "delete" | "move";
      move_path?: string;
      added: number;
      removed: number;
      preview?: string;
      truncated?: boolean;
    };
export interface ToolDetailView {
  kind: ToolDetailKind;
  title?: string;
  locations?: Array<{ path: string; line?: number }>;
  content?: ToolDetailContentView[];
  children?: number;
  mcp?: { server: string; tool: string };
  agent?: { action: string; name?: string };
  truncated?: boolean;
}
export interface ToolEventView {
  id: string;
  kind: string;
  tool_name?: string | null;
  tool_status?: string | null;
  duration_ms?: number | null;
  tool?: ToolDetailView;
  turn_meta?: { duration_ms?: number; outcome?: string };
}

type Copy = {
  kinds: Record<ToolDetailKind | "add" | "mcp" | "agent", string>;
  agentActions: Record<string, string>;
  exitCode: (code: number) => string;
  worked: (duration: string) => string;
  filesChanged: (count: number) => string;
  showDiff: string;
  hideDiff: string;
  showDetails: string;
  hideDetails: string;
  input: string;
  output: string;
  outputTruncated: string;
  previewTruncated: string;
  detailTrimmed: string;
  noDetail: string;
  added: (count: number) => string;
  removed: (count: number) => string;
  units: { hour: string; minute: string; second: string; separator: string };
  /** Punctuation for spoken names: `action: part, part`. */
  speech: { colon: string; separator: string };
};

const copies: Record<"zh-CN" | "zh-TW" | "en-US" | "ja-JP", Copy> = {
  "zh-CN": {
    kinds: {
      read: "读取",
      edit: "修改",
      add: "新建",
      delete: "删除",
      move: "移动",
      search: "搜索",
      execute: "运行",
      think: "计划",
      fetch: "网页",
      switch_mode: "切换模式",
      other: "工具",
      mcp: "MCP",
      agent: "子代理",
    },
    agentActions: {
      spawn: "启动",
      message: "发送消息",
      wait: "等待",
      interrupt: "中断",
      complete: "已完成",
      other: "活动",
    },
    exitCode: (code) => `退出码 ${code}`,
    worked: (duration) => `用时 ${duration}`,
    filesChanged: (count) => `已修改 ${count} 个文件`,
    showDiff: "查看差异",
    hideDiff: "收起差异",
    showDetails: "展开详情",
    hideDetails: "收起详情",
    input: "输入",
    output: "输出",
    outputTruncated: "输出已截断，只显示末尾部分",
    previewTruncated: "预览已截断",
    detailTrimmed: "部分内容过长，未显示",
    noDetail: "这条记录没有可显示的详情。",
    added: (count) => `新增 ${count} 行`,
    removed: (count) => `删除 ${count} 行`,
    units: { hour: " 小时", minute: " 分", second: " 秒", separator: " " },
    speech: { colon: "：", separator: "，" },
  },
  "zh-TW": {
    kinds: {
      read: "讀取",
      edit: "修改",
      add: "新建",
      delete: "刪除",
      move: "移動",
      search: "搜尋",
      execute: "執行",
      think: "計畫",
      fetch: "網頁",
      switch_mode: "切換模式",
      other: "工具",
      mcp: "MCP",
      agent: "子代理",
    },
    agentActions: {
      spawn: "啟動",
      message: "傳送訊息",
      wait: "等待",
      interrupt: "中斷",
      complete: "已完成",
      other: "活動",
    },
    exitCode: (code) => `結束代碼 ${code}`,
    worked: (duration) => `用時 ${duration}`,
    filesChanged: (count) => `已修改 ${count} 個檔案`,
    showDiff: "查看差異",
    hideDiff: "收起差異",
    showDetails: "展開詳情",
    hideDetails: "收起詳情",
    input: "輸入",
    output: "輸出",
    outputTruncated: "輸出已截斷，只顯示結尾部分",
    previewTruncated: "預覽已截斷",
    detailTrimmed: "部分內容過長，未顯示",
    noDetail: "此記錄沒有可顯示的詳情。",
    added: (count) => `新增 ${count} 行`,
    removed: (count) => `刪除 ${count} 行`,
    units: { hour: " 小時", minute: " 分", second: " 秒", separator: " " },
    speech: { colon: "：", separator: "，" },
  },
  "en-US": {
    kinds: {
      read: "Read",
      edit: "Edit",
      add: "Create",
      delete: "Delete",
      move: "Move",
      search: "Search",
      execute: "Run",
      think: "Plan",
      fetch: "Web",
      switch_mode: "Mode",
      other: "Tool",
      mcp: "MCP",
      agent: "Agent",
    },
    agentActions: {
      spawn: "start",
      message: "message",
      wait: "wait",
      interrupt: "interrupt",
      complete: "done",
      other: "activity",
    },
    exitCode: (code) => `exit ${code}`,
    worked: (duration) => `Worked ${duration}`,
    filesChanged: (count) => (count === 1 ? "Edited 1 file" : `Edited ${count} files`),
    showDiff: "Show diff",
    hideDiff: "Hide diff",
    showDetails: "Show details",
    hideDetails: "Hide details",
    input: "Input",
    output: "Output",
    outputTruncated: "Output truncated; showing the end",
    previewTruncated: "Preview truncated",
    detailTrimmed: "Some content is too long to show",
    noDetail: "This record has no details to show.",
    added: (count) => (count === 1 ? "1 line added" : `${count} lines added`),
    removed: (count) => (count === 1 ? "1 line removed" : `${count} lines removed`),
    units: { hour: "h", minute: "m", second: "s", separator: " " },
    speech: { colon: ": ", separator: ", " },
  },
  "ja-JP": {
    kinds: {
      read: "読み取り",
      edit: "編集",
      add: "作成",
      delete: "削除",
      move: "移動",
      search: "検索",
      execute: "実行",
      think: "計画",
      fetch: "Web",
      switch_mode: "モード切替",
      other: "ツール",
      mcp: "MCP",
      agent: "サブエージェント",
    },
    agentActions: {
      spawn: "開始",
      message: "メッセージ",
      wait: "待機",
      interrupt: "中断",
      complete: "完了",
      other: "アクティビティ",
    },
    exitCode: (code) => `終了コード ${code}`,
    worked: (duration) => `所要時間 ${duration}`,
    filesChanged: (count) => `${count} 件のファイルを編集`,
    showDiff: "差分を表示",
    hideDiff: "差分を閉じる",
    showDetails: "詳細を表示",
    hideDetails: "詳細を閉じる",
    input: "入力",
    output: "出力",
    outputTruncated: "出力は切り詰められています（末尾のみ表示）",
    previewTruncated: "プレビューは切り詰められています",
    detailTrimmed: "一部の内容は長すぎるため表示していません",
    noDetail: "この記録には表示できる詳細がありません。",
    added: (count) => `${count} 行追加`,
    removed: (count) => `${count} 行削除`,
    units: { hour: "時間", minute: "分", second: "秒", separator: "" },
    speech: { colon: "：", separator: "、" },
  },
};

export function toolDetailCopy(locale: string): Copy {
  if (locale === "zh-TW") return copies["zh-TW"];
  if (locale.startsWith("zh")) return copies["zh-CN"];
  if (locale.startsWith("ja")) return copies["ja-JP"];
  return copies["en-US"];
}

/** `2 分 7 秒`, `2m 7s`, `2分7秒`; below a second rounds up to one. */
export function formatToolDuration(milliseconds: number, locale: string): string {
  const { units } = toolDetailCopy(locale);
  const total = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}${units.hour}`);
  if (minutes) parts.push(`${minutes}${units.minute}`);
  if (seconds && !hours) parts.push(`${seconds}${units.second}`);
  return parts.join(units.separator);
}

const failedStatuses = new Set(["failed", "failure", "error", "errored"]);
const isFailed = (status: string | null | undefined) =>
  failedStatuses.has(status?.trim().toLowerCase() ?? "");

/** A wrapper call whose recorded items are shown in its place; failures stay visible. */
export function isHiddenWrapperTool(event: ToolEventView): boolean {
  return (
    event.kind === "tool-summary" && (event.tool?.children ?? 0) > 0 && !isFailed(event.tool_status)
  );
}

/** The turn duration carried by any item of the turn. */
export function turnDurationOf(events: readonly ToolEventView[]): number | undefined {
  for (const event of events) {
    const duration = event.turn_meta?.duration_ms;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return duration;
  }
  return undefined;
}

export interface TurnFileChange {
  path: string;
  added: number;
  removed: number;
  previews: string[];
  truncated: boolean;
}
/** File edits of a run of items, merged by path in first-seen order. */
export function turnFileChanges(events: readonly ToolEventView[]): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>();
  for (const event of events) {
    if (event.kind !== "tool-summary" || isFailed(event.tool_status)) continue;
    for (const entry of event.tool?.content ?? []) {
      if (entry.type !== "diff") continue;
      const file = files.get(entry.path) ?? {
        path: entry.path,
        added: 0,
        removed: 0,
        previews: [],
        truncated: false,
      };
      file.added += entry.added;
      file.removed += entry.removed;
      if (entry.preview) file.previews.push(entry.preview);
      else file.truncated = true;
      if (entry.truncated) file.truncated = true;
      files.set(entry.path, file);
    }
  }
  return [...files.values()];
}

function diffs(tool: ToolDetailView | undefined) {
  return (tool?.content ?? []).filter(
    (entry): entry is Extract<ToolDetailContentView, { type: "diff" }> => entry.type === "diff",
  );
}
function terminalOf(tool: ToolDetailView | undefined) {
  return (tool?.content ?? []).find(
    (entry): entry is Extract<ToolDetailContentView, { type: "terminal" }> =>
      entry.type === "terminal",
  );
}
const counts = (tool: ToolDetailView | undefined) =>
  diffs(tool).reduce(
    (sum, entry) => ({ added: sum.added + entry.added, removed: sum.removed + entry.removed }),
    { added: 0, removed: 0 },
  );

function hasBody(tool: ToolDetailView): boolean {
  return (tool.content ?? []).some((entry) =>
    entry.type === "text"
      ? Boolean(entry.text.trim())
      : entry.type === "terminal"
        ? Boolean(entry.output?.trim() || entry.command?.trim())
        : Boolean(entry.preview),
  );
}

function label(tool: ToolDetailView, copy: Copy): string {
  if (tool.mcp) return copy.kinds.mcp;
  if (tool.agent) return copy.kinds.agent;
  const single = diffs(tool);
  if (tool.kind === "edit" && single.length === 1 && single[0]!.change === "add")
    return copy.kinds.add;
  return copy.kinds[tool.kind] ?? copy.kinds.other;
}
function title(event: ToolEventView, tool: ToolDetailView, copy: Copy): string {
  if (tool.agent) {
    const action = copy.agentActions[tool.agent.action] ?? copy.agentActions.other!;
    return [action, tool.agent.name].filter(Boolean).join(" · ");
  }
  if (tool.title) return tool.title;
  const files = diffs(tool);
  if (files.length > 1) return copy.filesChanged(files.length);
  return event.tool_name || copy.kinds.other;
}

/** Spoken form of `Counts`, for names that are composed explicitly. */
const countWords = (added: number, removed: number, copy: Copy) =>
  added || removed ? [copy.added(added), copy.removed(removed)] : [];

function Counts({ added, removed, copy }: { added: number; removed: number; copy: Copy }) {
  if (!added && !removed) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono tabular-nums">
      <span className="text-emerald-700 dark:text-emerald-300">
        <span aria-hidden="true">+{added}</span>
        <span className="sr-only">
          {copy.speech.separator}
          {copy.added(added)}
        </span>
      </span>
      <span className="text-destructive-text">
        <span aria-hidden="true">-{removed}</span>
        <span className="sr-only">
          {copy.speech.separator}
          {copy.removed(removed)}
        </span>
      </span>
    </span>
  );
}

/** Unified diff lines as plain text spans; `@@` lines separate hunks. */
export function DiffPreview({ text }: { text: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-muted/20 py-2 font-mono text-[11px] leading-5">
      {/* As wide as the longest line, so line tints still fill the row when scrolled. */}
      <span className="block w-max min-w-full">
        {text.split("\n").map((line, index) => {
          const tone = line.startsWith("@@")
            ? "text-muted-foreground"
            : line.startsWith("+")
              ? "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
              : line.startsWith("-")
                ? "bg-destructive/10 text-destructive-text"
                : "text-foreground";
          return (
            <span key={index} className={`block whitespace-pre px-3 ${tone}`}>
              {line || " "}
            </span>
          );
        })}
      </span>
    </pre>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[11px] leading-5 text-muted-foreground">{children}</p>;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`ml-auto size-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * The expandable part of a tool row; also used where a dialog shows one item.
 * A row already names a non-zero exit code in its summary and passes
 * `showExitCode={false}`.
 */
export function ToolDetailBody({
  tool,
  locale,
  showExitCode = true,
}: {
  tool: ToolDetailView;
  locale: string;
  showExitCode?: boolean;
}) {
  const copy = toolDetailCopy(locale);
  const blocks: ReactNode[] = [];
  (tool.content ?? []).forEach((entry, index) => {
    if (entry.type === "terminal") {
      if (!entry.command && !entry.output) return;
      blocks.push(
        <div key={index} className="space-y-1">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-[11px] leading-5 text-foreground">
            {entry.command ? `$ ${entry.command}\n` : ""}
            {entry.output ?? ""}
          </pre>
          {showExitCode && typeof entry.exit_code === "number" && entry.exit_code !== 0 && (
            <Note>{copy.exitCode(entry.exit_code)}</Note>
          )}
          {entry.truncated && <Note>{copy.outputTruncated}</Note>}
        </div>,
      );
    } else if (entry.type === "diff") {
      blocks.push(
        <div key={index} className="space-y-1">
          <p className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate font-mono text-foreground">
              {entry.move_path ? `${entry.path} → ${entry.move_path}` : entry.path}
            </span>
            <Counts added={entry.added} removed={entry.removed} copy={copy} />
          </p>
          {entry.preview ? <DiffPreview text={entry.preview} /> : null}
          {entry.truncated && <Note>{copy.previewTruncated}</Note>}
        </div>,
      );
    } else if (entry.text.trim()) {
      blocks.push(
        <div key={index} className="space-y-1">
          {entry.label && (
            <p className="text-[11px] text-muted-foreground">
              {entry.label === "input" ? copy.input : copy.output}
            </p>
          )}
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-muted/20 p-3 font-mono text-[11px] leading-5 text-foreground">
            {entry.text}
          </pre>
          {entry.truncated && <Note>{copy.previewTruncated}</Note>}
        </div>,
      );
    }
  });
  if (tool.truncated) blocks.push(<Note key="trimmed">{copy.detailTrimmed}</Note>);
  if (!blocks.length) return <Note>{copy.noDetail}</Note>;
  return <div className="space-y-2">{blocks}</div>;
}

/**
 * One tool row with a typed detail: what ran, how it ended, and an inline
 * expandable body. Failed rows start expanded, like failed processes.
 */
export function ToolDetailRow({
  event,
  locale,
  statusLabel,
}: {
  event: ToolEventView & { tool: ToolDetailView };
  locale: string;
  statusLabel: string;
}) {
  const copy = toolDetailCopy(locale);
  const tool = event.tool;
  const failed = isFailed(event.tool_status);
  const expandable = hasBody(tool) || tool.truncated === true;
  const [open, setOpen] = useState(failed && expandable);
  const bodyId = useId();
  const terminal = terminalOf(tool);
  const exitCode =
    typeof terminal?.exit_code === "number" && terminal.exit_code !== 0
      ? terminal.exit_code
      : undefined;
  const changed = counts(tool);
  const text = title(event, tool, copy);
  const status = (event.tool_status ?? "").toLowerCase();
  const showStatus = status !== "" && status !== "completed";
  const monospace = tool.kind === "execute" || (!tool.mcp && !tool.agent && Boolean(tool.title));
  const duration =
    typeof event.duration_ms === "number" && event.duration_ms >= 1000
      ? formatToolDuration(event.duration_ms, locale)
      : undefined;
  // Composed explicitly so the parts stay separated whatever the layout does.
  const name = [
    `${label(tool, copy)} ${text}`,
    ...countWords(changed.added, changed.removed, copy),
    showStatus ? statusLabel : "",
    exitCode !== undefined ? copy.exitCode(exitCode) : "",
    duration ?? "",
  ]
    .filter(Boolean)
    .join(copy.speech.separator);
  const summary = (
    <>
      <span className="shrink-0 text-muted-foreground">{label(tool, copy)}</span>
      <span
        className={`min-w-0 truncate text-foreground ${monospace ? "font-mono text-[11px]" : ""}`}
        title={text}
      >
        {text}
      </span>
      <Counts added={changed.added} removed={changed.removed} copy={copy} />
      {showStatus && (
        <span className={`shrink-0 ${failed ? "text-destructive-text" : ""}`}>{statusLabel}</span>
      )}
      {exitCode !== undefined && (
        <span className="shrink-0 text-destructive-text">{copy.exitCode(exitCode)}</span>
      )}
      {duration && <span className="shrink-0 tabular-nums">{duration}</span>}
    </>
  );
  const rowClass =
    "flex h-auto min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-normal text-muted-foreground";
  return (
    <div data-event-id={event.id} data-tool-kind={tool.kind} className="min-w-0">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={`${open ? copy.hideDetails : copy.showDetails}${copy.speech.colon}${name}`}
          className={`${rowClass} transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          onClick={() => setOpen((value) => !value)}
        >
          {summary}
          <Chevron open={open} />
        </button>
      ) : (
        <div className={rowClass}>{summary}</div>
      )}
      {expandable && open && (
        <div id={bodyId} className="mb-1 ml-2 mt-1 border-l border-border/60 pl-3">
          <ToolDetailBody tool={tool} locale={locale} showExitCode={exitCode === undefined} />
        </div>
      )}
    </div>
  );
}

/** Files edited in a turn, shown after its final reply; each opens its diff preview. */
export function TurnFileChanges({
  events,
  locale,
}: {
  events: readonly ToolEventView[];
  locale: string;
}) {
  const copy = toolDetailCopy(locale);
  const files = turnFileChanges(events);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const prefix = useId();
  if (!files.length) return null;
  const total = files.reduce(
    (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
    { added: 0, removed: 0 },
  );
  return (
    <section
      data-turn-file-changes=""
      className="mt-3 overflow-hidden rounded-xl border border-border/70 bg-background text-xs"
    >
      <h4 className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-medium text-foreground">
        <span>{copy.filesChanged(files.length)}</span>
        <Counts added={total.added} removed={total.removed} copy={copy} />
      </h4>
      <ul className="divide-y divide-border/60">
        {files.map((file, index) => {
          const expanded = open[file.path] === true;
          const id = `${prefix}-${index}`;
          const viewable = file.previews.length > 0;
          const content = (
            <>
              <span className="min-w-0 truncate font-mono text-[11px] text-foreground">
                {file.path}
              </span>
              <Counts added={file.added} removed={file.removed} copy={copy} />
            </>
          );
          const rowClass = "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left";
          return (
            <li key={file.path}>
              {viewable ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={id}
                  aria-label={`${expanded ? copy.hideDiff : copy.showDiff}${copy.speech.colon}${[
                    file.path,
                    ...countWords(file.added, file.removed, copy),
                  ].join(copy.speech.separator)}`}
                  className={`${rowClass} text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
                  onClick={() => setOpen((value) => ({ ...value, [file.path]: !expanded }))}
                >
                  {content}
                  <Chevron open={expanded} />
                </button>
              ) : (
                <div className={`${rowClass} text-muted-foreground`}>{content}</div>
              )}
              {viewable && expanded && (
                <div id={id} className="space-y-1 px-3 pb-3">
                  <DiffPreview text={file.previews.join("\n")} />
                  {file.truncated && <Note>{copy.previewTruncated}</Note>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
