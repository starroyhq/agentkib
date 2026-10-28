import { AlertTriangle } from "lucide-react";
import type { Live } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { codexReason } from "./codex-copy";
import type { SessionSurface } from "./session-surface-copy";

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
    case "zh-TW":
      return `${agent} 的請求失敗，正在重試（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? `驗證遭拒：請檢查 ${agent} 的登入或 API key，可以先停止這一輪。` : ""}`;
    case "ja-JP":
      return `${agent} のリクエストが失敗したため再試行しています（${retry.attempt}${max ? `/${max}` : ""} 回目${status ? `、HTTP ${status}` : ""}）。${auth ? `認証が拒否されました。${agent} のログインまたは API キーを確認してください。このターンは停止できます。` : ""}`;
    default:
      return `${agent} 的请求失败了，正在重试（第 ${retry.attempt}${max ? `/${max}` : ""} 次${status ? `，HTTP ${status}` : ""}）。${auth ? `认证被拒绝：检查 ${agent} 的登录或 API key，可以先停止本轮。` : ""}`;
  }
}

/**
 * A managed Claude Code or Codex turn the CLI is retrying, or a Claude turn it ended on a
 * rejected login or key. Text and an icon, never color alone; it only informs and never blocks
 * sending or stopping. A failed Codex turn shows its error in the conversation instead.
 */
export function ManagedTurnNotice({
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
  const claude = live?.executionMode === "claude-managed";
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
