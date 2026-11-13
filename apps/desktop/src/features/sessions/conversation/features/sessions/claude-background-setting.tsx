import { useEffect, useState } from "react";
import { desktopApi } from "@/core/desktop";
import { Switch } from "@/components/ui/switch";
import { useSession } from "./session-context";
import type { SupportedLocale as Locale } from "@/core/types";

type BackgroundTasksStatus = {
  enabled: boolean;
  available: boolean;
  reason: "platform-unsupported" | "claude-cli-unavailable" | "claude-cli-too-old" | null;
  minimumVersion: string;
  cliVersion: string | null;
};

const copy: Record<
  Locale,
  {
    toggle: string;
    hint: string;
    tooOld: (minimum: string, version: string | null) => string;
    missing: string;
    platform: string;
  }
> = {
  "zh-CN": {
    toggle: "允许 Claude Code 在后台运行任务",
    hint: "命令和子代理可以在后台运行，结束后 Claude Code 会自己接着处理；退出 AgentKib 会停止它们。改动在 Claude Code 下次启动时生效。",
    tooOld: (minimum, version) =>
      `需要 Claude Code ${minimum} 或更新版本${version ? `（当前 ${version}）` : ""}。`,
    missing: "没有找到 Claude Code。",
    platform: "目前只支持 macOS。",
  },
  "zh-Hant": {
    toggle: "允許 Claude Code 在背景執行工作",
    hint: "命令和子代理可以在背景執行，結束後 Claude Code 會自己接著處理；結束 AgentKib 會停止它們。變更在 Claude Code 下次啟動時生效。",
    tooOld: (minimum, version) =>
      `需要 Claude Code ${minimum} 或更新版本${version ? `（目前 ${version}）` : ""}。`,
    missing: "找不到 Claude Code。",
    platform: "目前只支援 macOS。",
  },
  "ja-JP": {
    toggle: "Claude Code にバックグラウンドでの実行を許可",
    hint: "コマンドやサブエージェントをバックグラウンドで実行し、終わると Claude Code が自動で続けます。AgentKib を終了すると停止します。変更は Claude Code の次回起動時に反映されます。",
    tooOld: (minimum, version) =>
      `Claude Code ${minimum} 以降が必要です${version ? `（現在 ${version}）` : ""}。`,
    missing: "Claude Code が見つかりません。",
    platform: "現在は macOS のみ対応しています。",
  },
  "en-US": {
    toggle: "Let Claude Code run tasks in the background",
    hint: "Commands and subagents can run in the background, and Claude Code picks up their results by itself. Quitting AgentKib stops them. Changes apply the next time Claude Code starts.",
    tooOld: (minimum, version) =>
      `Requires Claude Code ${minimum} or later${version ? ` (this computer has ${version})` : ""}.`,
    missing: "Claude Code was not found.",
    platform: "Only macOS is supported for now.",
  },
};

function statusOf(value: unknown): BackgroundTasksStatus | undefined {
  const status =
    value && typeof value === "object" && "backgroundTasks" in value
      ? (value.backgroundTasks as Partial<BackgroundTasksStatus> | null)
      : null;
  if (
    !status ||
    typeof status.enabled !== "boolean" ||
    typeof status.available !== "boolean" ||
    typeof status.minimumVersion !== "string"
  )
    return undefined;
  return {
    enabled: status.enabled,
    available: status.available,
    reason: status.reason ?? null,
    minimumVersion: status.minimumVersion,
    cliVersion: typeof status.cliVersion === "string" ? status.cliVersion : null,
  };
}

/** An optional line of the dialog: a bridge that cannot answer, however it fails, hides it. */
const request = (params: Record<string, unknown>) =>
  Promise.resolve().then(() => desktopApi().claude.request(params));

/**
 * Whether Claude Code sessions AgentKib runs on this computer keep background tasks. On by
 * default; a change applies to the next Claude Code process AgentKib starts.
 */
export function ClaudeBackgroundSetting() {
  const { locale } = useSession();
  const text = copy[locale] ?? copy["en-US"];
  const [status, setStatus] = useState<BackgroundTasksStatus>();
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let current = true;
    void request({ operation: "background-tasks" }).then(
      (value) => current && setStatus(statusOf(value)),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  if (!status) return null;
  const toggle = (enabled: boolean) => {
    setSwitching(true);
    void request({ operation: "background-tasks", enabled })
      .then(
        (value) => setStatus((previous) => statusOf(value) ?? previous),
        () => undefined,
      )
      .finally(() => setSwitching(false));
  };
  const unavailable =
    status.reason === "claude-cli-too-old"
      ? text.tooOld(status.minimumVersion, status.cliVersion)
      : status.reason === "claude-cli-unavailable"
        ? text.missing
        : status.reason === "platform-unsupported"
          ? text.platform
          : null;
  return (
    <section className="flex items-start gap-3 border-t pt-4 text-sm" aria-label={text.toggle}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p>{text.toggle}</p>
        <p className="text-xs leading-5 text-muted-foreground">
          {status.available ? text.hint : (unavailable ?? text.hint)}
        </p>
      </div>
      <Switch
        checked={status.available && status.enabled}
        disabled={switching || !status.available}
        aria-label={text.toggle}
        onCheckedChange={toggle}
      />
    </section>
  );
}
