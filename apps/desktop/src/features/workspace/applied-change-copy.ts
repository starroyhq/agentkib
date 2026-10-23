const copy = {
  "zh-CN": {
    unapplied: (count: number) => `有 ${count} 个未应用的修改`,
    applied: (count: number) => `已应用 ${count} 个文件的变更`,
    checking: "已备份原文件，正在重新诊断…",
    complete: (count: number) => `已备份原文件，重新诊断：解决 ${count} 项`,
    checked: "已备份原文件，已重新诊断",
    currentIssues: (count: number) => `当前有 ${count} 项需处理`,
    failed: "文件已应用，暂时无法重新诊断，请去诊断页重试",
    newIssues: (count: number) => `发现 ${count} 项新问题`,
    doctor: "去诊断",
  },
  "zh-TW": {
    unapplied: (count: number) => `有 ${count} 個未套用的修改`,
    applied: (count: number) => `已套用 ${count} 個檔案的變更`,
    checking: "已備份原檔案，正在重新診斷…",
    complete: (count: number) => `已備份原檔案，重新診斷：解決 ${count} 項`,
    checked: "已備份原檔案，已重新診斷",
    currentIssues: (count: number) => `目前有 ${count} 項需處理`,
    failed: "檔案已套用，暫時無法重新診斷，請前往診斷頁重試",
    newIssues: (count: number) => `發現 ${count} 項新問題`,
    doctor: "前往診斷",
  },
  "en-US": {
    unapplied: (count: number) => `${count} unapplied ${count === 1 ? "change" : "changes"}`,
    applied: (count: number) => `Changes applied to ${count} ${count === 1 ? "file" : "files"}`,
    checking: "Original files backed up, checking again…",
    complete: (count: number) => `Original files backed up, recheck: ${count} resolved`,
    checked: "Original files backed up, recheck complete",
    currentIssues: (count: number) => `${count} issues currently need attention`,
    failed: "Files applied, but the recheck failed — retry on the diagnosis page",
    newIssues: (count: number) => `${count} new ${count === 1 ? "issue" : "issues"} found`,
    doctor: "Go to diagnosis",
  },
  "ja-JP": {
    unapplied: (count: number) => `未適用の変更 ${count} 件`,
    applied: (count: number) => `${count} 個のファイルに変更を適用しました`,
    checking: "元のファイルをバックアップ済み、再診断中…",
    complete: (count: number) => `元のファイルをバックアップ済み、再診断：${count} 件解決`,
    checked: "元のファイルをバックアップ済み、再診断が完了しました",
    currentIssues: (count: number) => `現在 ${count} 件の対応が必要です`,
    failed: "ファイルは適用済みですが再診断できませんでした。診断ページで再試行してください",
    newIssues: (count: number) => `新しい問題が ${count} 件あります`,
    doctor: "診断へ",
  },
};

export function appliedChangeCopy(locale: string) {
  return copy[locale as keyof typeof copy] ?? copy["en-US"];
}
