import type { ChangeSet, FileChange, SupportedLocale } from "@/core/types";
import { fileName } from "@/lib/path-display";
import { diffLines } from "./diff";
import { doctorWorkspaceRelativePath } from "./doctor-presentation";

export type PlanFileGroup = "shared" | "agents" | "records";
export function changeGroup(change: FileChange): PlanFileGroup {
  if (change.scope === "application-data" || /(?:^|[\\/])\.agentkib[\\/]/.test(change.target))
    return "records";
  return change.scope === "project" && fileName(change.target) === "AGENTS.md"
    ? "shared"
    : "agents";
}

export function defaultPlanTarget(changeSet: ChangeSet): string | undefined {
  return (
    changeSet.changes.find(
      (change) => changeGroup(change) !== "records" && change.before !== change.after,
    ) ??
    changeSet.changes.find((change) => change.before !== change.after) ??
    changeSet.changes[0]
  )?.target;
}

/** Display-only label; file actions and tooltips continue using the full path. */
export function planFilePath(workspace: string, target: string): string | undefined {
  return doctorWorkspaceRelativePath(workspace, target);
}

interface PlanEdit {
  added: number;
  removed: number;
  addedPreview: string;
  otherSections: string[];
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function editableSection(key: string, value: unknown): unknown {
  const object = record(value);
  if (key === "instructions" && object) {
    const { shared: _shared, ...other } = object;
    return other;
  }
  if (key === "adapters" && object)
    return Object.fromEntries(
      Object.entries(object).map(([agent, state]) => {
        const { generated_hashes: _hashes, ...settings } = record(state) ?? {};
        return [agent, settings];
      }),
    );
  return value;
}

/** Summarize the reviewed draft, never the current, potentially newer editor state. */
export function summarizePlanEdit(planned?: string, baseline?: string): PlanEdit | undefined {
  if (!planned || !baseline) return;
  try {
    const next = record(JSON.parse(planned));
    const previous = record(JSON.parse(baseline));
    const nextShared = record(next?.instructions)?.shared;
    const previousShared = record(previous?.instructions)?.shared;
    if (!next || !previous || typeof nextShared !== "string" || typeof previousShared !== "string")
      return;
    const before = previousShared.replace(/\n$/, "");
    const after = nextShared.replace(/\n$/, "");
    const lines = diffLines(before, after);
    const added = lines.filter(
      (line) => line.type === "added" && (line.content !== "" || after !== ""),
    );
    const removed = lines.filter(
      (line) => line.type === "removed" && (line.content !== "" || before !== ""),
    );
    return {
      added: added.length,
      removed: removed.length,
      addedPreview:
        added.length === 1
          ? Array.from(added[0]!.content.replace(/^\s*[-*+]\s+/, ""))
              .slice(0, 120)
              .join("")
          : "",
      otherSections: [...new Set([...Object.keys(previous), ...Object.keys(next)])].filter(
        (key) =>
          key !== "schema_version" &&
          JSON.stringify(editableSection(key, next[key])) !==
            JSON.stringify(editableSection(key, previous[key])),
      ),
    };
  } catch {
    // Missing or malformed display snapshots must not invent an editing history.
    return;
  }
}

const managedStart = "<!-- agentkib:managed:start -->";
const managedEnd = "<!-- agentkib:managed:end -->";
function instructionBlock(content: string) {
  const start = content.indexOf(managedStart);
  const end = content.indexOf(managedEnd);
  if (
    start < 0 ||
    end < start ||
    content.indexOf(managedStart, start + managedStart.length) >= 0 ||
    content.indexOf(managedEnd, end + managedEnd.length) >= 0
  )
    return;
  return {
    managed: content.slice(start + managedStart.length, end).trim(),
    outside: `${content.slice(0, start)}\n${content.slice(end + managedEnd.length)}`.trim(),
  };
}

/** A display summary of the reviewed file bytes, never a permission to delete user text. */
export function instructionPlanNotes(changeSet: ChangeSet): {
  adopted: boolean;
  duplicateTargets: string[];
} {
  const files = changeSet.changes.filter(
    (file) =>
      file.scope === "project" && ["AGENTS.md", "CLAUDE.md"].includes(fileName(file.target)),
  );
  const sharedFile = files.find(
    (file) => planFilePath(changeSet.project_root, file.target) === "AGENTS.md",
  );
  const shared = sharedFile ? instructionBlock(sharedFile.after)?.managed : undefined;
  if (!shared) return { adopted: false, duplicateTargets: [] };
  const normalized = (content: string) => content.replace(/\r\n/g, "\n").trim();
  const adopted = files.some((file) => {
    const after = instructionBlock(file.after);
    const before = normalized(file.before);
    return (
      !!after &&
      !after.outside &&
      !!before &&
      !file.before.includes(managedStart) &&
      `\n${normalized(shared)}\n`.includes(`\n${before}\n`)
    );
  });
  // Match the backend's instruction-adoption evidence: whole nonempty instruction
  // lines, excluding comments, headings, imports and punctuation-only text.
  const instructions = (content: string) =>
    content
      .replace(/<!--[\s\S]*?-->/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(?:#{1,6}\s|```|~~~|@\S+$)/.test(line))
      .map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " "))
      .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const expected = new Set(instructions(shared));
  return {
    adopted,
    duplicateTargets: files
      .filter((file) => {
        const after = instructionBlock(file.after);
        return after && instructions(after.outside).some((line) => expected.has(line));
      })
      .map((file) => file.target),
  };
}

export function hasDeepSeekImportLimitation(changeSet: ChangeSet): boolean {
  return changeSet.changes.some((change) => {
    if (
      change.scope !== "project" ||
      fileName(change.target) !== "CLAUDE.md" ||
      !/^\s*@AGENTS\.md\s*$/m.test(change.after)
    )
      return false;
    const directory = change.target.slice(0, -"CLAUDE.md".length);
    const shared = changeSet.changes.find(
      (file) => file.scope === "project" && file.target === `${directory}AGENTS.md`,
    );
    // This is the conservative local fallback. The route can pass the actual
    // context result when existing, unchanged or filtered sources are involved.
    return !shared?.after.trim() || new TextEncoder().encode(shared.after).byteLength > 64 * 1024;
  });
}

const managedAgents = new Set([
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
]);
/** Hide only the generator's known, flat checksum maps; ambiguous YAML stays fully visible. */
export function generatedChecksumLines(text: string, target?: string): Set<number> {
  const hidden = new Set<number>();
  if (!target || !/(?:^|[\\/])\.agentkib[\\/]manifest\.yaml$/.test(target)) return hidden;
  const lines = text.split("\n");
  let adapters = false;
  let knownAgent = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\S/.test(line)) {
      adapters = line === "adapters:";
      knownAgent = false;
    }
    if (!adapters) continue;
    if (/^ {2}\S/.test(line))
      knownAgent = managedAgents.has(/^ {2}([\w-]+):\s*$/.exec(line)?.[1] ?? "");
    if (!knownAgent || !/^ {4}generated_hashes:(?: \{\})?$/.test(line)) continue;
    const end = lines.findIndex(
      (candidate, next) => next > index && candidate.trim() && !/^ {6}/.test(candidate),
    );
    const stop = end < 0 ? lines.length : end;
    const entries = lines.slice(index + 1, stop);
    if (
      line.endsWith("{}")
        ? entries.some((entry) => entry.trim())
        : entries.some((entry) => entry.trim() && !/^ {6}.+: [a-f\d]{64}\s*$/i.test(entry))
    )
      continue;
    hidden.add(index);
    for (let next = index + 1; next < stop; next++) if (lines[next]!.trim()) hidden.add(next);
  }
  return hidden;
}

const en = {
  files: "Files to write",
  filesApplied: "Files in this change",
  applied: "This change has been applied",
  repaired: "The listed configuration repairs have been applied",
  appliedReadOnly: "These changes have been applied; the file differences below are read-only",
  shared: "Shared project instructions",
  agents: "Agent configuration sync",
  records: "AgentKib records",
  edited: "You changed: ",
  added: "added {count} shared instruction lines",
  removed: "removed {count} shared instruction lines",
  other: "updated {count} configuration sections",
  synchronizing: "Synchronize workspace configuration",
  repairing: "Repair the listed configuration files",
  writes: "{count} files will be written when you apply",
  separator: "; ",
  low: "Low",
  medium: "Medium",
  high: "High",
  lowRecordTip: "Low: updates AgentKib's own workspace records",
  lowFileTip: "Low: writes a file used by an Agent; review its content",
  mediumTip: "Medium: rewrites files that Agents read",
  highTip:
    "High: changes global configuration or sensitive Agent files and may affect other workspaces",
  includeHome: "Include global configuration",
  includedHome: "Global configuration included",
  homeHint: "Required by OpenClaw and Hermes",
  homeApproval: "I authorize changes to the Agent Home files listed above",
  adoption: "Existing content will move into the AgentKib-managed block",
  overlap: "This retained text will duplicate shared instructions",
  compatibility:
    "DeepSeek Harness does not resolve @AGENTS.md imports in CLAUDE.md; complete independent reading of AGENTS.md could not be confirmed, so a warning may remain after applying",
  generating: "Generating change plan…",
  stale: "The draft has changed since this plan was generated",
  regenerate: "Regenerate",
  conflict: "The manifest on disk has changed outside AgentKib",
  useDisk: "Use disk version",
  keepDraft: "Keep my draft",
  backup: "Original files are backed up automatically before applying",
  hashes: "All file hashes are validated again before applying",
  reject: "Reject",
  apply: "Apply {count} changes",
  applying: "Applying…",
  empty: "No file changes",
  checksums: "Automatically generated checksums: {count} lines (collapsed)",
};
type PlanCopy = Record<keyof typeof en, string>;
const copy: Record<SupportedLocale, PlanCopy> = {
  "en-US": en,
  "zh-CN": {
    files: "将写入的文件",
    filesApplied: "本次变更的文件",
    applied: "本次变更已应用",
    repaired: "本次配置修复已应用",
    appliedReadOnly: "本次变更已应用，下方文件差异仅供查看",
    shared: "共享项目指令",
    agents: "各 Agent 配置同步",
    records: "AgentKib 记录",
    edited: "你改了：",
    added: "共享项目指令新增 {count} 行",
    removed: "共享项目指令删除 {count} 行",
    other: "修改 {count} 项配置",
    synchronizing: "同步工作区配置",
    repairing: "修复所列配置文件",
    writes: "应用后会写入 {count} 个文件",
    separator: "；",
    low: "低",
    medium: "中",
    high: "高",
    lowRecordTip: "低：更新 AgentKib 自己的工作区记录",
    lowFileTip: "低：写入 Agent 读取的文件，请核对具体内容",
    mediumTip: "中：会改写 Agent 读取的文件",
    highTip: "高：会修改全局配置或敏感的 Agent 文件，可能影响其他工作区",
    includeHome: "包含全局配置",
    includedHome: "已包含全局配置",
    homeHint: "OpenClaw、Hermes 需要",
    homeApproval: "我允许修改以上 Agent Home 文件",
    adoption: "原有内容会移进 AgentKib 托管的区块",
    overlap: "这段会和共享指令重复",
    compatibility:
      "DeepSeek Harness 不解析 CLAUDE.md 中的 @AGENTS.md 引用，尚未确认它会独立读完 AGENTS.md，应用后可能仍有警告",
    generating: "正在生成变更计划…",
    stale: "生成计划后，草稿又有修改",
    regenerate: "重新生成",
    conflict: "manifest 已被外部修改，与草稿存在冲突",
    useDisk: "使用磁盘版本",
    keepDraft: "保留我的草稿",
    backup: "应用前会自动备份原文件",
    hashes: "应用前会再次校验所有文件的指纹",
    reject: "拒绝",
    apply: "应用 {count} 个变更",
    applying: "正在应用…",
    empty: "没有文件变更",
    checksums: "自动生成的校验信息 {count} 行（已折叠）",
  },
  "zh-TW": {
    files: "將寫入的檔案",
    filesApplied: "本次變更的檔案",
    applied: "本次變更已套用",
    repaired: "本次設定修復已套用",
    appliedReadOnly: "本次變更已套用，下方檔案差異僅供檢視",
    shared: "共用專案指令",
    agents: "各 Agent 設定同步",
    records: "AgentKib 記錄",
    edited: "你修改了：",
    added: "共用專案指令新增 {count} 行",
    removed: "共用專案指令刪除 {count} 行",
    other: "修改 {count} 項設定",
    synchronizing: "同步工作區設定",
    repairing: "修復所列設定檔",
    writes: "套用後會寫入 {count} 個檔案",
    separator: "；",
    low: "低",
    medium: "中",
    high: "高",
    lowRecordTip: "低：更新 AgentKib 自己的工作區記錄",
    lowFileTip: "低：寫入 Agent 讀取的檔案，請核對具體內容",
    mediumTip: "中：會改寫 Agent 讀取的檔案",
    highTip: "高：會修改全域設定或敏感的 Agent 檔案，可能影響其他工作區",
    includeHome: "包含全域設定",
    includedHome: "已包含全域設定",
    homeHint: "OpenClaw、Hermes 需要",
    homeApproval: "我允許修改以上 Agent Home 檔案",
    adoption: "原有內容會移進 AgentKib 託管的區塊",
    overlap: "這段會和共用指令重複",
    compatibility:
      "DeepSeek Harness 不解析 CLAUDE.md 中的 @AGENTS.md 引用，尚未確認它會獨立讀完整份 AGENTS.md，套用後可能仍有警告",
    generating: "正在產生變更計畫…",
    stale: "產生計畫後，草稿又有修改",
    regenerate: "重新產生",
    conflict: "manifest 已被外部修改，與草稿存在衝突",
    useDisk: "使用磁碟版本",
    keepDraft: "保留我的草稿",
    backup: "套用前會自動備份原檔案",
    hashes: "套用前會再次驗證所有檔案的指紋",
    reject: "拒絕",
    apply: "套用 {count} 項變更",
    applying: "正在套用…",
    empty: "沒有檔案變更",
    checksums: "自動產生的校驗資訊 {count} 行（已摺疊）",
  },
  "ja-JP": {
    files: "書き込み対象のファイル",
    filesApplied: "今回変更したファイル",
    applied: "今回の変更は適用済みです",
    repaired: "一覧の設定修復は適用済みです",
    appliedReadOnly: "今回の変更は適用済みです。以下のファイル差分は閲覧専用です",
    shared: "共通のプロジェクト指示",
    agents: "各 Agent の設定同期",
    records: "AgentKib の記録",
    edited: "変更内容：",
    added: "共通のプロジェクト指示を {count} 行追加",
    removed: "共通のプロジェクト指示を {count} 行削除",
    other: "設定を {count} 項目変更",
    synchronizing: "ワークスペースの設定を同期",
    repairing: "一覧の設定ファイルを修復",
    writes: "適用すると {count} 個のファイルに書き込みます",
    separator: "、",
    low: "低",
    medium: "中",
    high: "高",
    lowRecordTip: "低：AgentKib 自身のワークスペース記録を更新します",
    lowFileTip: "低：Agent が読むファイルに書き込むため、内容を確認してください",
    mediumTip: "中：Agent が読み込むファイルを書き換えます",
    highTip:
      "高：グローバル設定や機密性の高い Agent ファイルを変更し、他のワークスペースに影響する場合があります",
    includeHome: "グローバル設定を含める",
    includedHome: "グローバル設定を含む",
    homeHint: "OpenClaw と Hermes に必要",
    homeApproval: "上記の Agent Home ファイルの変更を許可します",
    adoption: "既存の内容を AgentKib の管理ブロック内へ移動します",
    overlap: "保持するこの本文は共通指示と重複します",
    compatibility:
      "DeepSeek Harness は CLAUDE.md 内の @AGENTS.md 参照を展開しません。AGENTS.md を単独で最後まで読めることを確認できないため、適用後も警告が残る可能性があります",
    generating: "変更プランを生成中…",
    stale: "変更プランの生成後に下書きが変更されました",
    regenerate: "再生成",
    conflict: "ディスク上の manifest が外部で変更され、下書きと競合しています",
    useDisk: "ディスクの内容を使う",
    keepDraft: "下書きを保持",
    backup: "適用前に元のファイルを自動でバックアップします",
    hashes: "適用前にすべてのファイルのフィンガープリントを再検証します",
    reject: "却下",
    apply: "{count} 件の変更を適用",
    applying: "適用中…",
    empty: "ファイルの変更はありません",
    checksums: "自動生成されたチェックサム {count} 行（折りたたみ）",
  },
};
export function planText(locale: SupportedLocale, key: keyof PlanCopy, count?: number): string {
  let template = copy[locale][key];
  // Apply agreement to these fixed UI templates before interpolating any values.
  if (locale === "en-US" && count === 1 && template.includes("{count}"))
    template = template.replace(/\b(lines|files|sections|changes)\b/g, (noun) => noun.slice(0, -1));
  return template.replace("{count}", String(count ?? ""));
}
