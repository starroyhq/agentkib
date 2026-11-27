import { useEffect, useState } from "react";
import { useDelayedBusy } from "../../delayed-busy";
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
  }
> = {
  "zh-CN": {
    toggle: "允许 Claude Code 在后台运行任务",
    hint: "命令、子代理和 /loop 这类定时任务可以在后台运行，结束或到点后 Claude Code 会自己接着处理；退出 AgentKib 会停止它们。改动在 Claude Code 下次启动时生效。",
  },
  "zh-Hant": {
    toggle: "允許 Claude Code 在背景執行工作",
    hint: "命令、子代理和 /loop 這類排程工作可以在背景執行，結束或到時間後 Claude Code 會自己接著處理；結束 AgentKib 會停止它們。變更在 Claude Code 下次啟動時生效。",
  },
  "ja-JP": {
    toggle: "Claude Code にバックグラウンドでの実行を許可",
    hint: "コマンドやサブエージェント、/loop などの定期実行をバックグラウンドで実行し、終わったり時間になったりすると Claude Code が自動で続けます。AgentKib を終了すると停止します。変更は Claude Code の次回起動時に反映されます。",
  },
  "en-US": {
    toggle: "Let Claude Code run tasks in the background",
    hint: "Commands, subagents and scheduled prompts such as /loop can run in the background, and Claude Code picks them up by itself when they finish or come due. Quitting AgentKib stops them. Changes apply the next time Claude Code starts.",
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
  const loading = !unavailableReason && status === undefined;
  const loadingSlowly = useDelayedBusy(loading || switching);
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
  const blocked = Boolean(
    unavailableReason || switching || status === undefined || !status?.available,
  );
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
          disabled={blocked}
          aria-busy={loading || switching || undefined}
          className={loadingSlowly ? "motion-safe:animate-pulse" : undefined}
          aria-label={text.toggle}
          onCheckedChange={toggle}
        />
      </OperationRow>
    </OperationGroup>
  );
}
