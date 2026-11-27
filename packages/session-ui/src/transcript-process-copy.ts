import type { ConversationEvent } from "@agentkib/web-client";
import { formatToolDuration, toolDetailCopy } from "./tool-details";

const copies = {
  "zh-CN": {
    completed: "已完成",
    aborted: "已中断",
    failed: "执行失败",
    earlierDetails: "加载此轮更早的过程",
  },
  "zh-Hant": {
    completed: "已完成",
    aborted: "已中斷",
    failed: "執行失敗",
    earlierDetails: "載入這一輪更早的過程",
  },
  "en-US": {
    completed: "Completed",
    aborted: "Interrupted",
    failed: "Failed",
    earlierDetails: "Load earlier activity for this turn",
  },
  "ja-JP": {
    completed: "完了",
    aborted: "中断",
    failed: "実行失敗",
    earlierDetails: "このターンの以前の処理を読み込む",
  },
};

export function transcriptProcessCopy(locale: string) {
  if (locale === "zh-Hant") return copies["zh-Hant"];
  if (locale.startsWith("zh")) return copies["zh-CN"];
  if (locale.startsWith("ja")) return copies["ja-JP"];
  return copies["en-US"];
}

export function transcriptProcessLabel(
  locale: string,
  fallback: string,
  outcome: "completed" | "aborted" | "failed" | undefined,
  durationMs: number | undefined,
  hasVisibleReply: boolean,
): string {
  const duration = durationMs === undefined ? undefined : formatToolDuration(durationMs, locale);
  if (outcome && (outcome !== "completed" || !hasVisibleReply)) {
    const status = transcriptProcessCopy(locale)[outcome];
    return duration ? `${status} · ${duration}` : status;
  }
  return duration ? toolDetailCopy(locale).worked(duration) : fallback;
}

function toolDisplayName(event: Pick<ConversationEvent, "kind" | "tool_name" | "tool">): string {
  if (event.kind !== "tool-summary") return "";
  const mcpTool = event.tool?.mcp?.tool?.trim();
  if (mcpTool) return mcpTool;
  return event.tool_name?.trim() ?? "";
}

export function processToolSummary(
  events: readonly Pick<ConversationEvent, "kind" | "tool_name" | "tool">[],
  locale: string,
  maxNames = 3,
): { summary: string; full: string } | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const name = toolDisplayName(event);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (!names.length) return undefined;
  const cjk = locale.startsWith("zh") || locale.startsWith("ja");
  const separator = cjk ? "、" : ", ";
  const full = names.join(separator);
  if (names.length <= maxNames) {
    return { summary: cjk ? `（${full}）` : `· ${full}`, full };
  }
  const head = names.slice(0, maxNames).join(separator);
  const rest = names.length - maxNames;
  const summary = locale.startsWith("zh")
    ? `（${head} 等）`
    : locale.startsWith("ja")
      ? `（${head} ほか）`
      : `· ${head} +${rest}`;
  return { summary, full };
}
