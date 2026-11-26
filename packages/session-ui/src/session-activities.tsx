import type {
  Live,
  SessionActivity,
  SessionActivityCapabilities,
  SessionActivityKind,
  WebClient,
} from "@agentkib/web-client";
import { ListTodo, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  setActivityPanelOpen,
  useActivityPanelOpen,
} from "./conversation/preferences/activity-panel";
import type { InteractionLocale } from "./interaction-model";
import { SessionActivityHistory } from "./session-activity-history";
import type { SessionPlatform } from "./session-platform";

type ActivityGroup = SessionActivityKind | "mixed";
type ActivityCopy = {
  label: string;
  empty: string;
  unavailable: string;
  close: string;
  active: string;
  history: string;
  stop: string;
  stopUnavailable: string;
  stopDenied: string;
  stopBusy: string;
  terminalAutoAdopted: string;
  kinds: Record<SessionActivityKind, string>;
  status: Record<SessionActivity["status"], string>;
  counts: Record<ActivityGroup, string>;
  singular?: Record<ActivityGroup, string>;
};

const activityCopy: Record<InteractionLocale, ActivityCopy> = {
  "zh-CN": {
    label: "会话活动",
    empty: "暂无会话活动",
    unavailable: "暂时无法查看会话活动",
    close: "关闭会话活动",
    active: "进行中",
    history: "查看记录",
    stop: "停止",
    stopUnavailable: "暂时无法停止此活动",
    stopDenied: "这次访问没有停止权限",
    stopBusy: "请等待当前操作完成",
    terminalAutoAdopted: "终端退出后由 AgentKib 接管",
    kinds: { "background-task": "后台任务", subagent: "子代理", terminal: "终端" },
    status: {
      starting: "启动中",
      running: "运行中",
      "waiting-input": "等待输入",
      "waiting-approval": "等待审批",
      completed: "已完成",
      failed: "失败",
      stopped: "已停止",
      unknown: "状态未知",
    },
    counts: {
      "background-task": "{count} 个后台任务",
      subagent: "{count} 个子代理",
      terminal: "{count} 个终端",
      mixed: "{count} 项活动",
    },
  },
  "zh-Hant": {
    label: "對話活動",
    empty: "暫無對話活動",
    unavailable: "暫時無法查看對話活動",
    close: "關閉對話活動",
    active: "進行中",
    history: "查看記錄",
    stop: "停止",
    stopUnavailable: "暫時無法停止此活動",
    stopDenied: "這次存取沒有停止權限",
    stopBusy: "請等待目前的操作完成",
    terminalAutoAdopted: "終端機結束後由 AgentKib 接管",
    kinds: { "background-task": "背景工作", subagent: "子代理", terminal: "終端機" },
    status: {
      starting: "啟動中",
      running: "執行中",
      "waiting-input": "等待輸入",
      "waiting-approval": "等待審批",
      completed: "已完成",
      failed: "失敗",
      stopped: "已停止",
      unknown: "狀態未知",
    },
    counts: {
      "background-task": "{count} 項背景工作",
      subagent: "{count} 個子代理",
      terminal: "{count} 個終端機",
      mixed: "{count} 項活動",
    },
  },
  "en-US": {
    label: "Session activities",
    empty: "No session activities",
    unavailable: "Session activities are unavailable",
    close: "Close session activities",
    active: "In progress",
    history: "View history",
    stop: "Stop",
    stopUnavailable: "This activity cannot be stopped right now",
    stopDenied: "This device does not have permission to stop the activity",
    stopBusy: "Wait for the current operation to finish",
    terminalAutoAdopted: "AgentKib took over after the terminal exited",
    kinds: { "background-task": "Background task", subagent: "Subagent", terminal: "Terminal" },
    status: {
      starting: "Starting",
      running: "Running",
      "waiting-input": "Waiting for input",
      "waiting-approval": "Waiting for approval",
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped",
      unknown: "Unknown",
    },
    counts: {
      "background-task": "{count} background tasks",
      subagent: "{count} subagents",
      terminal: "{count} terminals",
      mixed: "{count} activities",
    },
    singular: {
      "background-task": "{count} background task",
      subagent: "{count} subagent",
      terminal: "{count} terminal",
      mixed: "{count} activity",
    },
  },
  "ja-JP": {
    label: "セッションのアクティビティ",
    empty: "アクティビティはありません",
    unavailable: "今はアクティビティを表示できません",
    close: "セッションのアクティビティを閉じる",
    active: "進行中",
    history: "履歴を表示",
    stop: "停止",
    stopUnavailable: "今はこのアクティビティを停止できません",
    stopDenied: "このアクティビティを停止する権限がありません",
    stopBusy: "現在の操作が終わるまでお待ちください",
    terminalAutoAdopted: "ターミナルの終了後に AgentKib が引き継ぎました",
    kinds: {
      "background-task": "バックグラウンドタスク",
      subagent: "サブエージェント",
      terminal: "ターミナル",
    },
    status: {
      starting: "起動中",
      running: "実行中",
      "waiting-input": "入力待ち",
      "waiting-approval": "承認待ち",
      completed: "完了",
      failed: "失敗",
      stopped: "停止済み",
      unknown: "状態不明",
    },
    counts: {
      "background-task": "バックグラウンドタスク {count} 件",
      subagent: "サブエージェント {count} 件",
      terminal: "ターミナル {count} 件",
      mixed: "アクティビティ {count} 件",
    },
  },
};

const inProgress: ReadonlySet<SessionActivity["status"]> = new Set([
  "starting",
  "running",
  "waiting-input",
  "waiting-approval",
]);

function activityDuration(activity: SessionActivity, now: number, locale: InteractionLocale) {
  const start = Date.parse(activity.startedAt ?? "");
  const end =
    activity.endedAt == null
      ? inProgress.has(activity.status)
        ? now
        : NaN
      : Date.parse(activity.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  const seconds = Math.floor((end - start) / 1000);
  const format = (value: number, unit: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
  if (seconds < 60) return format(seconds, "second");
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours
    ? [format(hours, "hour"), minutes && format(minutes, "minute")].filter(Boolean).join(" ")
    : [format(minutes, "minute"), seconds % 60 && format(seconds % 60, "second")]
        .filter(Boolean)
        .join(" ");
}

function stopReason(copy: ActivityCopy, reason?: string) {
  if (reason === "permission_denied" || reason === "same_origin_required") return copy.stopDenied;
  if (reason === "operation_busy" || reason === "session-busy") return copy.stopBusy;
  return copy.stopUnavailable;
}

type ActivitySource = {
  sessionId: string;
  locale: InteractionLocale;
  capabilities?: SessionActivityCapabilities;
  live?: Pick<Live, "sessionId" | "activities">;
};

type SessionActivitiesProps = ActivitySource & {
  client: WebClient;
  onStop?: (activityId: string) => void;
};

const panelId = (id: string) => `session-activities-${encodeURIComponent(id)}`;
const triggerId = (id: string) => `${panelId(id)}-trigger`;

function activityProjection({ sessionId, live }: ActivitySource) {
  return live?.sessionId === sessionId ? live.activities : undefined;
}

function supportedActivities(
  projection: ReturnType<typeof activityProjection>,
  capabilities?: SessionActivityCapabilities,
) {
  return (projection ?? []).filter((activity) => capabilities?.kinds.includes(activity.kind));
}

export function SessionActivityButton({
  Button,
  className,
  variant = "outline",
  ...source
}: ActivitySource & {
  Button: SessionPlatform["components"]["Button"];
  className?: string;
  variant?: "outline" | "ghost";
}) {
  const { sessionId, locale, capabilities } = source;
  const copy = activityCopy[locale];
  const open = useActivityPanelOpen();
  const disabled = !capabilities?.kinds.length;
  const expanded = open && !disabled;
  const focusOnOpen = useRef(false);
  const active = supportedActivities(activityProjection(source), capabilities).filter(
    ({ status }) => inProgress.has(status),
  );
  const first = active[0];
  const group = first && active.every(({ kind }) => kind === first.kind) ? first.kind : "mixed";
  const count = active.length;
  const status = count
    ? ((count === 1 ? copy.singular?.[group] : undefined) ?? copy.counts[group]).replace(
        "{count}",
        count.toLocaleString(locale),
      )
    : undefined;
  useLayoutEffect(() => {
    if (expanded && focusOnOpen.current) {
      focusOnOpen.current = false;
      document.getElementById(panelId(sessionId))?.focus({ preventScroll: true });
    }
  }, [expanded, sessionId]);
  return (
    <Button
      id={triggerId(sessionId)}
      type="button"
      variant={expanded ? "secondary" : variant}
      size="icon"
      className={className}
      disabled={disabled}
      aria-label={copy.label}
      aria-description={status ? `${copy.active} · ${status}` : undefined}
      aria-expanded={expanded}
      aria-controls={expanded ? panelId(sessionId) : undefined}
      title={copy.label}
      onClick={(event) => {
        focusOnOpen.current = !expanded && event.detail === 0;
        setActivityPanelOpen(!expanded);
      }}
    >
      <span className="relative" aria-hidden="true">
        <ListTodo className="size-4" />
        {!!count && (
          <span className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-primary-text" />
        )}
      </span>
    </Button>
  );
}

export function SessionActivities({ capabilities, ...props }: SessionActivitiesProps) {
  const open = useActivityPanelOpen();
  if (!open || !capabilities?.kinds.length) return null;
  return <ActivityPanel key={props.sessionId} capabilities={capabilities} {...props} />;
}

function ActivityPanel({
  sessionId,
  locale,
  capabilities,
  live,
  client,
  onStop,
}: SessionActivitiesProps & { capabilities: SessionActivityCapabilities }) {
  const copy = activityCopy[locale];
  const projection = activityProjection({ sessionId, locale, live });
  const activities = supportedActivities(projection, capabilities);
  const [selection, setSelection] = useState<{ id: string; childId: string; client: WebClient }>();
  const [now, setNow] = useState(Date.now);
  const close = useRef<HTMLButtonElement>(null);
  const selectedActivity =
    capabilities.canOpenSubagentHistory && selection && selection.client === client
      ? activities.find(
          ({ id, kind, childId }) =>
            id === selection.id && kind === "subagent" && childId === selection.childId,
        )
      : undefined;

  useEffect(() => {
    if (!selectedActivity) setSelection(undefined);
  }, [selectedActivity]);

  const ticking =
    !selectedActivity &&
    activities.some(
      ({ startedAt, endedAt, status }) =>
        endedAt == null && inProgress.has(status) && Number.isFinite(Date.parse(startedAt ?? "")),
    );
  useEffect(() => {
    if (!ticking) return;
    const update = () => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  return (
    <section
      id={panelId(sessionId)}
      aria-label={copy.label}
      tabIndex={-1}
      className="pointer-events-auto flex max-h-full w-[26rem] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none"
    >
      <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <h2 className="text-xs font-medium">{copy.label}</h2>
        <button
          ref={close}
          type="button"
          aria-label={copy.close}
          title={copy.close}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
          onClick={() => {
            document.getElementById(triggerId(sessionId))?.focus({ preventScroll: true });
            setActivityPanelOpen(false);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 max-h-96 overflow-y-auto overscroll-contain">
        {selectedActivity && selection ? (
          <SessionActivityHistory
            key={selection.childId}
            client={client}
            sessionId={sessionId}
            childId={selection.childId}
            title={selectedActivity.title.trim() || copy.kinds[selectedActivity.kind]}
            locale={locale}
            onClose={() => {
              setSelection(undefined);
              close.current?.focus();
            }}
          />
        ) : activities.length ? (
          <ul className="divide-y divide-border">
            {activities.map((activity) => {
              const { childId } = activity;
              const title =
                activity.event === "terminal-auto-adopted"
                  ? copy.terminalAutoAdopted
                  : activity.title.trim() || copy.kinds[activity.kind];
              const elapsed = activityDuration(activity, now, locale);
              const stop = activity.actions?.stop;
              const stopEnabled = stop?.available === true && !!onStop;
              return (
                <li
                  key={activity.id}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 basis-32 truncate" title={title}>
                    {title}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {copy.status[activity.status] ?? copy.status.unknown}
                  </span>
                  {elapsed && (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{elapsed}</span>
                  )}
                  {capabilities.canOpenSubagentHistory &&
                    activity.kind === "subagent" &&
                    childId && (
                      <button
                        type="button"
                        aria-label={`${copy.history} · ${title}`}
                        className="min-h-7 shrink-0 rounded-md px-2 font-medium text-primary-text outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                        onClick={() => setSelection({ id: activity.id, childId, client })}
                      >
                        {copy.history}
                      </button>
                    )}
                  {capabilities.canStopIndividually && (
                    <button
                      type="button"
                      aria-label={`${copy.stop} · ${title}`}
                      disabled={!stopEnabled}
                      title={stopEnabled ? undefined : stopReason(copy, stop?.reason)}
                      className="min-h-7 shrink-0 rounded-md px-2 outline-none enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11"
                      onClick={() => onStop?.(activity.id)}
                    >
                      {copy.stop}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {projection ? copy.empty : copy.unavailable}
          </p>
        )}
      </div>
    </section>
  );
}
