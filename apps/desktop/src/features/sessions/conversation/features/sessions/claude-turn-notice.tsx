import { AlertTriangle } from "lucide-react";
import type { Live } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { codexReason } from "./codex-copy";
import type { SessionSurface } from "./session-surface-copy";

type Retry = NonNullable<Live["apiRetry"]>;
const authRejected = (retry: Retry) =>
  retry.error === "authentication_failed" || retry.status === 401;

/** What the CLI is retrying, from its own `system/api_retry` report. */
export function claudeRetryText(locale: Locale, retry: Retry): string {
  const max = retry.maxRetries;
  const status = retry.status;
  const auth = authRejected(retry);
  switch (locale) {
    case "en-US":
      return `Claude Code's request failed and is being retried (attempt ${retry.attempt}${max ? ` of ${max}` : ""}${status ? `, HTTP ${status}` : ""}).${auth ? " Authentication was rejected: check Claude Code's login or API key. You can stop this turn." : ""}`;
    case "zh-TW":
      return `Claude Code 的請求失敗，正在重試（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? "驗證遭拒：請檢查 Claude Code 的登入或 API key，可以先停止這一輪。" : ""}`;
    case "ja-JP":
      return `Claude Code のリクエストが失敗したため再試行しています（${retry.attempt}${max ? `/${max}` : ""} 回目${status ? `、HTTP ${status}` : ""}）。${auth ? "認証が拒否されました。Claude Code のログインまたは API キーを確認してください。このターンは停止できます。" : ""}`;
    default:
      return `Claude Code 的请求失败了，正在重试（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? "认证被拒绝：检查 Claude Code 的登录或 API key，可以先停止本轮。" : ""}`;
  }
}

/**
 * A managed Claude turn the CLI is retrying, or one it ended on a rejected login or key. Text and
 * an icon, never color alone; it only informs and never blocks sending or stopping.
 */
export function ClaudeTurnNotice({
  live,
  locale,
  surface = "desktop",
  retriesOnly = false,
}: {
  live?: Live | null;
  locale: Locale;
  surface?: SessionSurface;
  /** Where the session's reason is already shown elsewhere. */
  retriesOnly?: boolean;
}) {
  if (live?.executionMode !== "claude-managed") return null;
  let text: string | undefined;
  let technical: string | undefined;
  if (live.status !== "idle" && live.apiRetry) text = claudeRetryText(locale, live.apiRetry);
  else if (
    !retriesOnly &&
    live.status === "idle" &&
    live.reason?.startsWith("claude-auth-failed")
  ) {
    const explained = codexReason(locale, live.reason, surface);
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
