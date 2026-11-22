import { AlertTriangle } from "lucide-react";
import type { Live } from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import type { SessionPlatform } from "../../session-platform";
import type { SessionSurface } from "../../session-surface-copy";
import { usageLimitNotice } from "../../usage-limit-copy";
import { sessionReason } from "./session-copy";

type Retry = NonNullable<Live["apiRetry"]>;
type Agent = "Claude Code" | "Codex";
// Claude Code reports `authentication_failed`, Codex `unauthorized`; either may give only a status.
const authRejected = (retry: Retry) =>
  retry.error === "authentication_failed" || retry.error === "unauthorized" || retry.status === 401;

/** What the CLI is retrying, from its own report (`system/api_retry`, Codex `error`). */
export function retryText(locale: Locale, retry: Retry, agent: Agent = "Claude Code"): string {
  const max = retry.maxRetries;
  const status = retry.status;
  const auth = authRejected(retry);
  switch (locale) {
    case "en-US":
      return `${agent}'s request failed and is being retried (attempt ${retry.attempt}${max ? ` of ${max}` : ""}${status ? `, HTTP ${status}` : ""}).${auth ? ` Authentication was rejected: check ${agent}'s login or API key. You can stop this turn.` : ""}`;
    case "zh-Hant":
      return `${agent} 的請求失敗，正在重試（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? `驗證遭拒：請檢查 ${agent} 的登入或 API key，可以先停止這一輪。` : ""}`;
    case "ja-JP":
      return `${agent} のリクエストが失敗したため再試行しています（${retry.attempt}${max ? `/${max}` : ""} 回目${status ? `、HTTP ${status}` : ""}）。${auth ? `認証が拒否されました。${agent} のログインまたは API キーを確認してください。このターンは停止できます。` : ""}`;
    default:
      return `${agent} 的请求失败了，正在重试（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? `认证被拒绝：检查 ${agent} 的登录或 API key，可以先停止本轮。` : ""}`;
  }
}

/**
 * A managed Claude Code or Codex turn the CLI is retrying, a Claude turn it ended on a rejected
 * login or key, or a usage limit the session's agent met (any agent): when it resets and whether
 * AgentKib continues by itself. Text and an icon, never color alone; it only informs and never
 * blocks sending or stopping. A failed Codex turn shows its error in the conversation instead.
 */
export function ManagedTurnNotice({
  Button,
  unavailableReason,
  live,
  locale,
  surface = "desktop",
  retriesOnly = false,
  onUsageLimitCancel,
  onUsageLimitArm,
}: {
  Button: SessionPlatform["components"]["Button"];
  unavailableReason: SessionPlatform["copy"]["unavailableReason"];
  live?: Live | null;
  locale: Locale;
  surface?: SessionSurface;
  /** Where the session's reason is already shown elsewhere. */
  retriesOnly?: boolean;
  /** Turns off the continue armed after a usage limit; no button without it. */
  onUsageLimitCancel?: () => void;
  /** Arms the continue after the reset when none is armed; no button without it. */
  onUsageLimitArm?: () => void;
}) {
  const claude = live?.executionMode === "claude-managed";
  const limit = live?.usageLimit ? usageLimitNotice(locale, live.usageLimit) : null;
  if (live && limit && live.status === "idle")
    return (
      <div
        role="status"
        className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{limit.text}</span>
        {limit.cancel && onUsageLimitCancel && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onUsageLimitCancel}
            className="-my-0.5 shrink-0 font-medium text-current"
          >
            {limit.cancel}
          </Button>
        )}
        {limit.arm && onUsageLimitArm && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onUsageLimitArm}
            className="-my-0.5 shrink-0 font-medium text-current"
          >
            {limit.arm}
          </Button>
        )}
      </div>
    );
  if (!live || (!claude && live.executionMode !== "codex-managed")) return null;
  let text: string | undefined;
  let technical: string | undefined;
  if (live.status !== "idle" && live.apiRetry) {
    text = retryText(locale, live.apiRetry, claude ? "Claude Code" : "Codex");
    technical = live.apiRetry.detail ?? undefined;
  } else if (
    claude &&
    !retriesOnly &&
    live.status === "idle" &&
    live.reason?.startsWith("claude-auth-failed")
  ) {
    const explained = sessionReason(locale, live.reason, surface, unavailableReason);
    text = explained.text;
    technical = explained.technical;
  }
  if (!text) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        {text}
        {technical && (
          <span className="mt-1 block break-words font-mono opacity-80">{technical}</span>
        )}
      </span>
    </div>
  );
}
