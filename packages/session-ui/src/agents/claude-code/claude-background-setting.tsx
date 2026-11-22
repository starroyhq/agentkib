import { useEffect, useState } from "react";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { useSessionPlatform, type SessionPlatform } from "../../session-platform";
import {
  OperationCopy,
  OperationGroup,
  OperationRow,
} from "../../conversation/sessions/operation-layout";

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
    loading: string;
    unavailable: string;
  }
> = {
  "zh-CN": {
    toggle: "允许 Claude Code 在后台运行任务",
    hint: "命令、子代理和 /loop 这类定时任务可以在后台运行，结束或到点后 Claude Code 会自己接着处理；退出 AgentKib 会停止它们。改动在 Claude Code 下次启动时生效。",
    tooOld: (minimum, version) =>
      `需要 Claude Code ${minimum} 或更新版本${version ? `（当前 ${version}）` : ""}。`,
    missing: "没有找到 Claude Code。",
    platform: "目前只支持 macOS。",
    loading: "正在读取设置。",
    unavailable: "当前运行环境未提供后台任务设置。",
  },
  "zh-Hant": {
    toggle: "允許 Claude Code 在背景執行工作",
    hint: "命令、子代理和 /loop 這類排程工作可以在背景執行，結束或到時間後 Claude Code 會自己接著處理；結束 AgentKib 會停止它們。變更在 Claude Code 下次啟動時生效。",
    tooOld: (minimum, version) =>
      `需要 Claude Code ${minimum} 或更新版本${version ? `（目前 ${version}）` : ""}。`,
    missing: "找不到 Claude Code。",
    platform: "目前只支援 macOS。",
    loading: "正在讀取設定。",
    unavailable: "目前的執行環境未提供背景工作設定。",
  },
  "ja-JP": {
    toggle: "Claude Code にバックグラウンドでの実行を許可",
    hint: "コマンドやサブエージェント、/loop などの定期実行をバックグラウンドで実行し、終わったり時間になったりすると Claude Code が自動で続けます。AgentKib を終了すると停止します。変更は Claude Code の次回起動時に反映されます。",
    tooOld: (minimum, version) =>
      `Claude Code ${minimum} 以降が必要です${version ? `（現在 ${version}）` : ""}。`,
    missing: "Claude Code が見つかりません。",
    platform: "現在は macOS のみ対応しています。",
    loading: "設定を読み込み中です。",
    unavailable: "現在のランタイムではバックグラウンドの設定を取得できません。",
  },
  "en-US": {
    toggle: "Let Claude Code run tasks in the background",
    hint: "Commands, subagents and scheduled prompts such as /loop can run in the background, and Claude Code picks them up by itself when they finish or come due. Quitting AgentKib stops them. Changes apply the next time Claude Code starts.",
    tooOld: (minimum, version) =>
      `Requires Claude Code ${minimum} or later${version ? ` (this computer has ${version})` : ""}.`,
    missing: "Claude Code was not found.",
    platform: "Only macOS is supported for now.",
    loading: "Reading settings.",
    unavailable: "The current runtime does not provide a background task setting.",
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

/**
 * Whether Claude Code sessions AgentKib runs on this computer keep background tasks. On by
 * default; a change applies to the next Claude Code process AgentKib starts.
 */
export function ClaudeBackgroundSetting({
  locale,
  unavailableReason,
}: {
  locale: Locale;
  unavailableReason?: string;
}) {
  const { desktop } = useSessionPlatform();
  return desktop ? (
    <ClaudeBackgroundTasks
      locale={locale}
      desktop={desktop}
      unavailableReason={unavailableReason}
    />
  ) : null;
}

function ClaudeBackgroundTasks({
  desktop,
  locale,
  unavailableReason,
}: {
  desktop: NonNullable<SessionPlatform["desktop"]>;
  locale: Locale;
  unavailableReason?: string;
}) {
  const {
    components: { Switch },
    requestBridge,
  } = desktop;
  const text = copy[locale] ?? copy["en-US"];
  const [status, setStatus] = useState<BackgroundTasksStatus | null>();
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (unavailableReason) return;
    let current = true;
    // Legacy runtimes can omit this optional host setting or fail synchronously.
    void Promise.resolve()
      .then(() => requestBridge({ operation: "background-tasks" }))
      .then(
        (value) => current && setStatus(statusOf(value) ?? null),
        () => current && setStatus(null),
      );
    return () => {
      current = false;
    };
  }, [requestBridge, unavailableReason]);
  const blocked =
    unavailableReason ??
    (switching || status === undefined
      ? text.loading
      : status?.available
        ? undefined
        : status?.reason === "claude-cli-too-old"
          ? text.tooOld(status.minimumVersion, status.cliVersion)
          : status?.reason === "claude-cli-unavailable"
            ? text.missing
            : status?.reason === "platform-unsupported"
              ? text.platform
              : text.unavailable);
  const toggle = (enabled: boolean) => {
    if (blocked) return;
    setSwitching(true);
    void Promise.resolve()
      .then(() => requestBridge({ operation: "background-tasks", enabled }))
      .then(
        (value) => setStatus((previous) => statusOf(value) ?? previous),
        () => undefined,
      )
      .finally(() => setSwitching(false));
  };
  return (
    <OperationGroup title="Claude Code">
      <OperationRow>
        <OperationCopy title={text.toggle}>
          {!unavailableReason && status?.available && text.hint}
        </OperationCopy>
        <Switch
          checked={!unavailableReason && status?.available === true && status.enabled}
          disabled={!!blocked}
          title={blocked}
          aria-label={text.toggle}
          onCheckedChange={toggle}
        />
      </OperationRow>
    </OperationGroup>
  );
}
