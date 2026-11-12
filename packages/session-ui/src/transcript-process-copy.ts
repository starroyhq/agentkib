import { formatToolDuration, toolDetailCopy } from "./tool-details";

const copies = {
  "zh-CN": {
    completed: "已完成",
    aborted: "已中断",
    failed: "执行失败",
    earlierDetails: "加载此轮更早的过程",
  },
  "zh-TW": {
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
  if (locale === "zh-TW") return copies["zh-TW"];
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
