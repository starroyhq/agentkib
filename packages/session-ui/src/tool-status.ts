export function toolStatusLabel(status: string | null | undefined, locale: string): string {
  const names =
    locale === "zh-Hant"
      ? ["已完成", "失敗", "執行中", "等待中", "已取消", "已拒絕"]
      : locale.startsWith("zh")
        ? ["已完成", "失败", "执行中", "等待中", "已取消", "已拒绝"]
        : locale.startsWith("ja")
          ? ["完了", "失敗", "実行中", "待機中", "キャンセル済み", "拒否済み"]
          : ["Completed", "Failed", "Running", "Pending", "Cancelled", "Declined"];
  const value = status?.toLowerCase();
  if (["completed", "complete", "success", "succeeded"].includes(value ?? "")) return names[0];
  if (["failed", "failure", "error", "errored"].includes(value ?? "")) return names[1];
  if (["running", "in-progress", "inprogress"].includes(value ?? "")) return names[2];
  if (["pending", "queued"].includes(value ?? "")) return names[3];
  if (["cancelled", "canceled"].includes(value ?? "")) return names[4];
  if (["declined", "rejected", "denied"].includes(value ?? "")) return names[5];
  return status ?? "";
}
