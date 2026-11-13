import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "@/core/desktop";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { useSession } from "./session-context";
import type { SupportedLocale as Locale } from "@/core/types";

type Worker = {
  name: string;
  sessionId: string;
  status: string;
  title: string | null;
  lastReportAt: string | null;
};
type ProjectAgent = {
  sessionId: string;
  paused: boolean;
  reason: string | null;
  scope: { workspaceIds: string[]; policies: string[]; maxLanes: number; maxAutoTurns: number };
  pendingReports: number;
  workers: Worker[];
};

type Copy = {
  title: string;
  hint: string;
  designate: string;
  workspaces: string;
  autoReview: string;
  maxWorkers: string;
  maxAutoTurns: string;
  confirm: string;
  cancel: string;
  summary: (workers: number, pending: number) => string;
  none: string;
  open: string;
  pause: string;
  resume: string;
  release: string;
  releaseConfirm: string;
  reported: (time: string) => string;
  status: Record<string, string>;
  paused: Record<string, string>;
  errors: Record<string, string>;
  failed: string;
};

const copy: Record<Locale, Copy> = {
  "zh-CN": {
    title: "项目 Agent",
    hint: "让这个会话在你允许的工作区里开 Worker（Codex 会话）、派任务，Worker 的结果会作为汇报送回这里。Worker 的审批仍由你处理。",
    designate: "设为项目 Agent…",
    workspaces: "Worker 可以使用的工作区",
    autoReview: "允许 Worker 使用 Codex 自动审核",
    maxWorkers: "Worker 数量上限",
    maxAutoTurns: "连续自动轮次上限",
    confirm: "设为项目 Agent",
    cancel: "取消",
    summary: (workers, pending) =>
      `${workers} 个 Worker${pending ? ` · ${pending} 条汇报待送达` : ""}`,
    none: "还没有 Worker。在这个会话里让它开一个就行。",
    open: "打开",
    pause: "暂停委派",
    resume: "恢复委派",
    release: "不再作为项目 Agent",
    releaseConfirm: "确定不再作为项目 Agent？Worker 会话会保留为普通会话。",
    reported: (time) => `${time}汇报`,
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
      "restart-confirmation-required": "AgentKib 重启后暂停了委派，确认后继续。",
      "authorization-changed": "设定它的设备授权已变更，已暂停委派。",
      "auto-turn-limit": "达到连续自动轮次上限，已暂停委派。在这个会话里发一条消息就会继续。",
      "report-undelivered": "汇报没有送达，已暂停委派。",
    },
    errors: {
      "lead-requires-managed-claude": "只有由 AgentKib 运行的 Claude Code 会话可以设为项目 Agent。",
      "session-is-a-worker": "这个会话是另一个项目 Agent 的 Worker。",
      "invalid-lead-workspaces": "至少选择一个工作区。",
      "lead-exists": "这个会话已经是项目 Agent。",
    },
    failed: "没有完成，请重试。",
  },
  "zh-Hant": {
    title: "專案 Agent",
    hint: "讓這個對話在你允許的工作區裡開 Worker（Codex 對話）、派任務，Worker 的結果會作為回報送回這裡。Worker 的核准仍由你處理。",
    designate: "設為專案 Agent…",
    workspaces: "Worker 可以使用的工作區",
    autoReview: "允許 Worker 使用 Codex 自動審核",
    maxWorkers: "Worker 數量上限",
    maxAutoTurns: "連續自動輪次上限",
    confirm: "設為專案 Agent",
    cancel: "取消",
    summary: (workers, pending) =>
      `${workers} 個 Worker${pending ? ` · ${pending} 則回報待送達` : ""}`,
    none: "還沒有 Worker。在這個對話裡讓它開一個就行。",
    open: "開啟",
    pause: "暫停委派",
    resume: "恢復委派",
    release: "不再作為專案 Agent",
    releaseConfirm: "確定不再作為專案 Agent？Worker 對話會保留為一般對話。",
    reported: (time) => `${time}回報`,
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
      "restart-confirmation-required": "AgentKib 重新啟動後暫停了委派，確認後繼續。",
      "authorization-changed": "設定它的裝置授權已變更，已暫停委派。",
      "auto-turn-limit": "達到連續自動輪次上限，已暫停委派。在這個對話裡傳一則訊息就會繼續。",
      "report-undelivered": "回報沒有送達，已暫停委派。",
    },
    errors: {
      "lead-requires-managed-claude": "只有由 AgentKib 執行的 Claude Code 對話可以設為專案 Agent。",
      "session-is-a-worker": "這個對話是另一個專案 Agent 的 Worker。",
      "invalid-lead-workspaces": "至少選擇一個工作區。",
      "lead-exists": "這個對話已經是專案 Agent。",
    },
    failed: "沒有完成，請重試。",
  },
  "ja-JP": {
    title: "プロジェクト Agent",
    hint: "この会話が、許可したワークスペースでワーカー（Codex の会話）を開いてタスクを任せ、その結果を報告として受け取ります。ワーカーの承認はこれまでどおりあなたが行います。",
    designate: "プロジェクト Agent にする…",
    workspaces: "ワーカーが使えるワークスペース",
    autoReview: "ワーカーに Codex の自動レビューを許可",
    maxWorkers: "ワーカー数の上限",
    maxAutoTurns: "連続する自動ターンの上限",
    confirm: "プロジェクト Agent にする",
    cancel: "キャンセル",
    summary: (workers, pending) =>
      `ワーカー ${workers} 件${pending ? ` · 未送信の報告 ${pending} 件` : ""}`,
    none: "まだワーカーはありません。この会話で開くよう頼んでください。",
    open: "開く",
    pause: "委任を一時停止",
    resume: "委任を再開",
    release: "プロジェクト Agent をやめる",
    releaseConfirm: "プロジェクト Agent をやめますか？ワーカーの会話は通常の会話として残ります。",
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
        "AgentKib の再起動後、委任を一時停止しました。確認すると再開します。",
      "authorization-changed": "設定したデバイスの権限が変わったため、委任を一時停止しました。",
      "auto-turn-limit":
        "連続する自動ターンの上限に達したため、委任を一時停止しました。この会話にメッセージを送ると再開します。",
      "report-undelivered": "報告を届けられなかったため、委任を一時停止しました。",
    },
    errors: {
      "lead-requires-managed-claude":
        "AgentKib が実行する Claude Code の会話だけがプロジェクト Agent になれます。",
      "session-is-a-worker": "この会話は別のプロジェクト Agent のワーカーです。",
      "invalid-lead-workspaces": "ワークスペースを 1 つ以上選んでください。",
      "lead-exists": "この会話はすでにプロジェクト Agent です。",
    },
    failed: "完了できませんでした。もう一度お試しください。",
  },
  "en-US": {
    title: "Project Agent",
    hint: "Lets this session open workers (Codex sessions) in the workspaces you allow and give them tasks; their results come back here as reports. You still answer the workers' approvals.",
    designate: "Make Project Agent…",
    workspaces: "Workspaces workers may use",
    autoReview: "Let workers use Codex auto-review",
    maxWorkers: "Most workers",
    maxAutoTurns: "Most automatic turns in a row",
    confirm: "Make Project Agent",
    cancel: "Cancel",
    summary: (workers, pending) =>
      `${workers} ${workers === 1 ? "worker" : "workers"}${pending ? ` · ${pending} ${pending === 1 ? "report" : "reports"} waiting` : ""}`,
    none: "No workers yet. Ask this session to open one.",
    open: "Open",
    pause: "Pause delegation",
    resume: "Resume delegation",
    release: "Stop being a Project Agent",
    releaseConfirm: "Stop being a Project Agent? The workers stay as ordinary sessions.",
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
        "Delegation paused when AgentKib restarted. Resume it to go on.",
      "authorization-changed": "Delegation paused: the device that set it up has changed access.",
      "auto-turn-limit":
        "Delegation paused at the limit of automatic turns. Send this session a message to go on.",
      "report-undelivered": "Delegation paused: a report could not be delivered.",
    },
    errors: {
      "lead-requires-managed-claude":
        "Only a Claude Code session that AgentKib runs can be a Project Agent.",
      "session-is-a-worker": "This session is another Project Agent's worker.",
      "invalid-lead-workspaces": "Choose at least one workspace.",
      "lead-exists": "This session is already a Project Agent.",
    },
    failed: "That did not work. Try again.",
  },
};

function projectAgentOf(value: unknown): ProjectAgent | null | undefined {
  if (!value || typeof value !== "object" || !("lead" in value)) return undefined;
  const lead = value.lead as Partial<ProjectAgent> | null;
  if (lead === null) return null;
  if (!lead || typeof lead.paused !== "boolean" || !Array.isArray(lead.workers) || !lead.scope)
    return undefined;
  return lead as ProjectAgent;
}

/** Optional, like the other computer settings: a bridge that cannot answer hides it. */
const request = (params: Record<string, unknown>) =>
  Promise.resolve().then(() => desktopApi().claude.request(params));

/**
 * Whether this managed Claude Code session is a Project Agent: it opens workers (Codex
 * sessions) and hears from them as reports. Its scope is set here, on this computer.
 */
export function ProjectAgentPanel() {
  const { locale, selected, current, workspaces, choose, formatCatalogTime } = useSession();
  const text = copy[locale] ?? copy["en-US"];
  const [agent, setAgent] = useState<ProjectAgent | null>();
  const [form, setForm] = useState<null | {
    workspaceIds: string[];
    autoReview: boolean;
    maxLanes: number;
    maxAutoTurns: number;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves to whether the host did it; a refusal stays on screen with its reason. */
  const run = useCallback(
    (params: Record<string, unknown>): Promise<boolean> => {
      if (!selected) return Promise.resolve(false);
      setBusy(true);
      setError(null);
      return request({ ...params, sessionId: selected })
        .then(
          (value) => {
            const next = projectAgentOf(value);
            if (next !== undefined) setAgent(next);
            return true;
          },
          (failure: unknown) => {
            const code = failure instanceof Error ? failure.message : "";
            setError(Object.keys(text.errors).find((key) => code.includes(key)) ?? "failed");
            return false;
          },
        )
        .finally(() => setBusy(false));
    },
    [selected, text.errors],
  );

  useEffect(() => {
    if (!selected) return;
    let live = true;
    const read = () =>
      void request({ operation: "lead-status", sessionId: selected }).then(
        (value) => live && setAgent(projectAgentOf(value)),
        () => undefined,
      );
    read();
    // Workers change on their own; the panel is open only for a while.
    const timer = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected]);

  if (agent === undefined || !selected) return null;
  const errorText = error ? (text.errors[error] ?? text.failed) : null;

  if (agent === null) {
    if (!form)
      return (
        <section className="space-y-2 border-t pt-4 text-sm" aria-label={text.title}>
          <p>{text.title}</p>
          <p className="text-xs leading-5 text-muted-foreground">{text.hint}</p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() =>
              setForm({
                workspaceIds: current?.workspace_id ? [current.workspace_id] : [],
                autoReview: false,
                maxLanes: 4,
                maxAutoTurns: 25,
              })
            }
          >
            {text.designate}
          </Button>
        </section>
      );
    const toggleWorkspace = (id: string, on: boolean) =>
      setForm({
        ...form,
        workspaceIds: on
          ? [...form.workspaceIds, id]
          : form.workspaceIds.filter((value) => value !== id),
      });
    const bounded = (value: string, max: number) =>
      Math.min(max, Math.max(1, Math.trunc(Number(value)) || 1));
    return (
      <section className="space-y-3 border-t pt-4 text-sm" aria-label={text.title}>
        <p>{text.title}</p>
        <fieldset className="space-y-1">
          <legend className="text-xs text-muted-foreground">{text.workspaces}</legend>
          {(workspaces ?? []).map((workspace) => (
            <label key={workspace.id} className="flex items-center gap-2">
              <NativeCheckbox
                checked={form.workspaceIds.includes(workspace.id)}
                onChange={(event) => toggleWorkspace(workspace.id, event.target.checked)}
              />
              <span className="truncate">{workspace.name}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-2">
          <NativeCheckbox
            checked={form.autoReview}
            onChange={(event) => setForm({ ...form, autoReview: event.target.checked })}
          />
          <span>{text.autoReview}</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">{text.maxWorkers}</span>
            <Input
              type="number"
              min={1}
              max={8}
              value={form.maxLanes}
              onChange={(event) => setForm({ ...form, maxLanes: bounded(event.target.value, 8) })}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">{text.maxAutoTurns}</span>
            <Input
              type="number"
              min={1}
              max={100}
              value={form.maxAutoTurns}
              onChange={(event) =>
                setForm({ ...form, maxAutoTurns: bounded(event.target.value, 100) })
              }
            />
          </label>
        </div>
        {errorText && <p className="text-xs text-destructive">{errorText}</p>}
        <div className="flex gap-2">
          <Button
            className="min-h-11"
            disabled={busy || !form.workspaceIds.length}
            onClick={() =>
              void run({
                operation: "lead-designate",
                scope: {
                  workspaceIds: form.workspaceIds,
                  policies: form.autoReview
                    ? ["workspace-write-on-request", "workspace-write-auto-review"]
                    : ["workspace-write-on-request"],
                  maxLanes: form.maxLanes,
                  maxAutoTurns: form.maxAutoTurns,
                },
              }).then((done) => done && setForm(null))
            }
          >
            {text.confirm}
          </Button>
          <Button variant="outline" className="min-h-11" onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3 border-t pt-4 text-sm" aria-label={text.title}>
      <div className="space-y-0.5">
        <p>{text.title}</p>
        <p className="text-xs text-muted-foreground">
          {text.summary(agent.workers.length, agent.pendingReports)}
        </p>
        {agent.paused && (
          <p className="text-xs leading-5 text-muted-foreground">
            {text.paused[agent.reason ?? "user-paused"] ?? text.paused["user-paused"]}
          </p>
        )}
      </div>
      {agent.workers.length ? (
        <ul className="space-y-2">
          {agent.workers.map((worker) => (
            <li key={worker.sessionId} className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate">
                  {worker.name} · {text.status[worker.status] ?? text.status.unavailable}
                </p>
                {(worker.title || worker.lastReportAt) && (
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      worker.title,
                      worker.lastReportAt
                        ? text.reported(formatCatalogTime(worker.lastReportAt))
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => void choose(worker.sessionId)}>
                {text.open}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{text.none}</p>
      )}
      {errorText && <p className="text-xs text-destructive">{errorText}</p>}
      {releasing ? (
        <div className="space-y-2">
          <p className="text-xs leading-5">{text.releaseConfirm}</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={busy}
              onClick={() =>
                void run({ operation: "lead-release" }).then((done) => done && setReleasing(false))
              }
            >
              {text.release}
            </Button>
            <Button variant="outline" className="min-h-11" onClick={() => setReleasing(false)}>
              {text.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => void run({ operation: agent.paused ? "lead-resume" : "lead-pause" })}
          >
            {agent.paused ? text.resume : text.pause}
          </Button>
          <Button variant="outline" className="min-h-11" onClick={() => setReleasing(true)}>
            {text.release}
          </Button>
        </div>
      )}
    </section>
  );
}
