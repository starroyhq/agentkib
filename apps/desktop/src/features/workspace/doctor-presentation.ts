import { AGENT_LABELS } from "@/core/agents";
import type { DoctorAgentRow, DoctorIssue, SupportedLocale } from "@/core/types";
import { fileName } from "@/lib/path-display";

const messages = {
  "en-US": {
    refresh: "Run diagnostics again",
    details: "Details",
    revealFolder: "Open containing folder",
    warnings: "{{count}} warnings",
    errors: "{{count}} errors",
    repairable: "{{count}} auto-fixable",
    checked: "checked {{time}}",
    issues: "Issues",
    matrix: "Agents: {{agents}} · Normal: {{normal}}",
    matrixAttention: "{{attention}} requiring attention",
    justNow: "just now",
    expand: "Expand",
    collapse: "Collapse",
    review: "Review changes",
    reviewAdvice: "Review the files that will be written before applying the repair",
    fileTitle: "{{files}}: {{issue}}",
    duplicateTitle: "{{files}} contain identical instructions",
    duplicateSeparator: " and ",
    readOnlyTitle: "{{agent}} supports diagnostics only",
    unknownTitle: "A configuration issue needs inspection",
    duplicateImpact: "{{agents}} will read the same instructions twice",
    duplicateUnknownImpact: "The same instructions may be read more than once",
    unmanagedTitle: "{{files}} repeat shared instructions outside the managed block",
    unmanagedImpact:
      "{{agents}} will read duplicate content from the unmanaged text and shared instructions",
    literalImportTitle: "DeepSeek Harness does not expand the reference in CLAUDE.md",
    literalImportImpact:
      "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as text and does not import its instructions",
    manifestImpact: "Workspace configuration cannot be read reliably",
    nativeImpact: "The Agent may not be able to read its configuration",
    sourceImpact: "The configured skill source cannot be read",
    skillImpact: "Some configured skills are unavailable to the target Agent",
    managedMissingImpact: "The Agent cannot read a managed configuration file",
    managedDriftImpact: "The file differs from the reviewed workspace configuration",
    missingImpact: "The Agent may not receive the project's instructions",
    expectedImpact: "The Agent is not receiving all configured instructions",
    contextImpact: "The Agent's effective instruction context cannot be fully verified",
    mcpConfigImpact: "MCP connections cannot be read reliably",
    mcpTargetImpact: "The target Agent cannot use all configured MCP connections",
    readOnlyImpact: "AgentKib can inspect this Agent's configuration but cannot change it",
    unknownImpact: "Inspect the details and original files before making changes",
  },
  "zh-CN": {
    refresh: "重新诊断",
    details: "详情",
    revealFolder: "打开所在文件夹",
    warnings: "{{count}} 个警告",
    errors: "{{count}} 个错误",
    repairable: "{{count}} 个可自动修复",
    checked: "检查于 {{time}}",
    issues: "问题",
    matrix: "{{agents}} 个 Agent · {{normal}} 项正常",
    matrixAttention: "{{attention}} 项需处理",
    justNow: "刚刚",
    expand: "展开",
    collapse: "收起",
    review: "审查变更",
    reviewAdvice: "先审查将写入的文件，确认后再应用修复",
    fileTitle: "{{files}}：{{issue}}",
    duplicateTitle: "{{files}} 内容完全相同",
    duplicateSeparator: " 与 ",
    readOnlyTitle: "{{agent}} 只支持诊断，不能由 AgentKib 修改配置",
    unknownTitle: "有一项配置问题需要检查",
    duplicateImpact: "{{agents}} 会读到两份相同的指令",
    duplicateUnknownImpact: "同一段指令可能被重复读取",
    unmanagedTitle: "{{files}} 的区块外正文与共享指令重复",
    unmanagedImpact: "{{agents}} 会重复读取区块外正文与共享指令中的相同内容",
    literalImportTitle: "CLAUDE.md 的引用不会被 DeepSeek Harness 展开",
    literalImportImpact:
      "DeepSeek Harness 会把 CLAUDE.md 中的 @AGENTS.md 当作普通文字，不会导入其中的指令",
    manifestImpact: "无法可靠读取工作区配置",
    nativeImpact: "Agent 可能无法读取自己的配置",
    sourceImpact: "无法读取已配置的技能来源",
    skillImpact: "目标 Agent 无法使用部分已配置的技能",
    managedMissingImpact: "Agent 无法读取一个由 AgentKib 管理的配置文件",
    managedDriftImpact: "文件内容与已审查的工作区配置不一致",
    missingImpact: "Agent 可能无法读取项目指令",
    expectedImpact: "Agent 没有读到全部已配置的指令",
    contextImpact: "暂时无法完整核实 Agent 实际读取的指令上下文",
    mcpConfigImpact: "无法可靠读取 MCP 连接配置",
    mcpTargetImpact: "目标 Agent 无法使用全部已配置的 MCP 连接",
    readOnlyImpact: "AgentKib 可以检查此 Agent 的配置，但不能修改",
    unknownImpact: "修改前请先查看详情和原始文件",
  },
  "zh-TW": {
    refresh: "重新診斷",
    details: "詳細資料",
    revealFolder: "開啟所在資料夾",
    warnings: "{{count}} 個警告",
    errors: "{{count}} 個錯誤",
    repairable: "{{count}} 個可自動修復",
    checked: "檢查於 {{time}}",
    issues: "問題",
    matrix: "{{agents}} 個 Agent · {{normal}} 項正常",
    matrixAttention: "{{attention}} 項需處理",
    justNow: "剛剛",
    expand: "展開",
    collapse: "收合",
    review: "審查變更",
    reviewAdvice: "先審查將寫入的檔案，確認後再套用修復",
    fileTitle: "{{files}}：{{issue}}",
    duplicateTitle: "{{files}} 內容完全相同",
    duplicateSeparator: " 與 ",
    readOnlyTitle: "{{agent}} 只支援診斷，無法由 AgentKib 修改設定",
    unknownTitle: "有一項設定問題需要檢查",
    duplicateImpact: "{{agents}} 會讀到兩份相同的指令",
    duplicateUnknownImpact: "同一段指令可能被重複讀取",
    unmanagedTitle: "{{files}} 的區塊外正文與共用指令重複",
    unmanagedImpact: "{{agents}} 會重複讀取區塊外正文與共用指令中的相同內容",
    literalImportTitle: "CLAUDE.md 的引用不會被 DeepSeek Harness 展開",
    literalImportImpact:
      "DeepSeek Harness 會把 CLAUDE.md 中的 @AGENTS.md 當作一般文字，不會匯入其中的指令",
    manifestImpact: "無法可靠讀取工作區設定",
    nativeImpact: "Agent 可能無法讀取自己的設定",
    sourceImpact: "無法讀取已設定的技能來源",
    skillImpact: "目標 Agent 無法使用部分已設定的技能",
    managedMissingImpact: "Agent 無法讀取一個由 AgentKib 管理的設定檔",
    managedDriftImpact: "檔案內容與已審查的工作區設定不一致",
    missingImpact: "Agent 可能無法讀取專案指令",
    expectedImpact: "Agent 沒有讀到全部已設定的指令",
    contextImpact: "暫時無法完整核實 Agent 實際讀取的指令上下文",
    mcpConfigImpact: "無法可靠讀取 MCP 連線設定",
    mcpTargetImpact: "目標 Agent 無法使用全部已設定的 MCP 連線",
    readOnlyImpact: "AgentKib 可以檢查此 Agent 的設定，但無法修改",
    unknownImpact: "修改前請先查看詳細資料與原始檔案",
  },
  "ja-JP": {
    refresh: "再診断",
    details: "詳細",
    revealFolder: "ファイルのあるフォルダーを開く",
    warnings: "警告 {{count}} 件",
    errors: "エラー {{count}} 件",
    repairable: "自動修復可能 {{count}} 件",
    checked: "最終確認：{{time}}",
    issues: "問題",
    matrix: "Agent {{agents}} 件 · 正常 {{normal}} 件",
    matrixAttention: "要対応 {{attention}} 件",
    justNow: "たった今",
    expand: "展開",
    collapse: "折りたたむ",
    review: "変更を確認",
    reviewAdvice: "修復を適用する前に、書き込まれるファイルを確認してください",
    fileTitle: "{{files}}：{{issue}}",
    duplicateTitle: "{{files}} の内容が完全に同じです",
    duplicateSeparator: " と ",
    readOnlyTitle: "{{agent}} は診断のみに対応し、AgentKib では設定を変更できません",
    unknownTitle: "設定の問題を確認してください",
    duplicateImpact: "{{agents}} が同じ指示を 2 回読み込みます",
    duplicateUnknownImpact: "同じ指示が重複して読み込まれる可能性があります",
    unmanagedTitle: "{{files}} の管理ブロック外の本文が共通指示と重複しています",
    unmanagedImpact: "{{agents}} が管理外の本文と共通指示の同じ内容を重複して読み込みます",
    literalImportTitle: "DeepSeek Harness は CLAUDE.md の参照を展開しません",
    literalImportImpact:
      "DeepSeek Harness は CLAUDE.md の @AGENTS.md を文字列として読み取り、参照先の指示を読み込みません",
    manifestImpact: "ワークスペース設定を正しく読み取れません",
    nativeImpact: "Agent が自身の設定を読み取れない可能性があります",
    sourceImpact: "設定されたスキルの参照元を読み取れません",
    skillImpact: "対象 Agent が一部の設定済みスキルを利用できません",
    managedMissingImpact: "Agent が AgentKib 管理下の設定ファイルを読み取れません",
    managedDriftImpact: "ファイルの内容が確認済みのワークスペース設定と異なります",
    missingImpact: "Agent がプロジェクトの指示を読み取れない可能性があります",
    expectedImpact: "設定済みの指示がすべて Agent に読み込まれていません",
    contextImpact: "Agent が実際に読み取る指示のコンテキストを十分に確認できません",
    mcpConfigImpact: "MCP 接続設定を正しく読み取れません",
    mcpTargetImpact: "対象 Agent が一部の設定済み MCP 接続を利用できません",
    readOnlyImpact: "AgentKib ではこの Agent の設定を診断できますが、変更はできません",
    unknownImpact: "変更する前に詳細と元のファイルを確認してください",
  },
} satisfies Record<SupportedLocale, Record<string, string>>;

type CopyKey = keyof (typeof messages)["en-US"];

export function doctorCopy(
  locale: SupportedLocale,
  key: CopyKey,
  values: Record<string, string | number> = {},
) {
  let template = messages[locale][key];
  if (locale === "en-US" && values.count === 1 && (key === "warnings" || key === "errors"))
    template = template.replace(/s$/, "");
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : placeholder,
  );
}

/** Keep sub-minute checks natural without changing global relative-time wording. */
export function doctorCheckedTime(
  locale: SupportedLocale,
  checkedAt: string,
  relativeTime: string,
  now = Date.now(),
) {
  return Math.abs(Date.parse(checkedAt) - now) < 60_000
    ? doctorCopy(locale, "justNow")
    : relativeTime;
}

/** Only the known duplicate diagnostic embeds a second source path in its evidence. */
export function doctorIssueFiles(issue: DoctorIssue) {
  return [
    ...new Set(
      issue.evidence.flatMap((item) =>
        [
          item.path,
          issue.code === "instruction.exact-duplicate" &&
          item.detail.startsWith("Exact duplicate of ")
            ? item.detail.slice("Exact duplicate of ".length)
            : undefined,
        ].filter((value): value is string => Boolean(value)),
      ),
    ),
  ];
}

/** UI eligibility only; the existing storage operation still validates and resolves the path. */
export function doctorWorkspaceRelativePath(workspacePath: string, evidencePath: string) {
  if (!evidencePath) return undefined;
  const windowsPath = /^[A-Za-z]:[\\/]|^\\\\/.test(workspacePath);
  if (!windowsPath && !workspacePath.startsWith("/")) return undefined;
  const normalize = (value: string) => (windowsPath ? value.replaceAll("\\", "/") : value);
  const workspace = normalize(workspacePath).replace(/\/+$/, "");
  const evidence = normalize(evidencePath);
  if (
    [workspace, evidence].some(
      (value) =>
        value.includes("\0") || value.split("/").some((part) => part === "." || part === ".."),
    )
  )
    return undefined;
  const root = windowsPath ? workspace.toLowerCase() : workspace;
  const candidate = windowsPath ? evidence.toLowerCase() : evidence;
  if (candidate === root) return "";
  return candidate.startsWith(`${root}/`) ? evidence.slice(workspace.length + 1) : undefined;
}

export function doctorIssueTitle(
  issue: DoctorIssue,
  locale: SupportedLocale,
  translate?: (key: string) => string,
) {
  if (hasLiteralImportWarning(issue)) return doctorCopy(locale, "literalImportTitle");
  const files = doctorIssueFiles(issue).map(fileName);
  if (issue.code === "instruction.exact-duplicate" && files.length > 1)
    return doctorCopy(locale, "duplicateTitle", {
      files: files.join(doctorCopy(locale, "duplicateSeparator")),
    });
  if (issue.code === "instruction.unmanaged-duplicate")
    return doctorCopy(locale, "unmanagedTitle", {
      files: files.join(doctorCopy(locale, "duplicateSeparator")),
    });
  const key = `doctor.issue.${issue.code}`;
  const title = translate?.(key);
  const issueTitle = title && title !== key ? title : doctorCopy(locale, "unknownTitle");
  return files.length
    ? doctorCopy(locale, "fileTitle", {
        files: files.join(doctorCopy(locale, "duplicateSeparator")),
        issue: issueTitle,
      })
    : issueTitle;
}

const impactKeys: Record<string, CopyKey> = {
  "instruction.exact-duplicate": "duplicateImpact",
  "manifest.invalid": "manifestImpact",
  "native.invalid": "nativeImpact",
  "skill.source-unavailable": "sourceImpact",
  "skill.target-missing": "skillImpact",
  "managed.missing": "managedMissingImpact",
  "managed.drift": "managedDriftImpact",
  "instruction.missing": "missingImpact",
  "instruction.expected-content-missing": "expectedImpact",
  "context.warning": "contextImpact",
  "context.unavailable": "contextImpact",
  "mcp.config-unavailable": "mcpConfigImpact",
  "mcp.target-missing": "mcpTargetImpact",
  "agent.read-only": "readOnlyImpact",
};

export function doctorImpact(
  issue: DoctorIssue,
  locale: SupportedLocale,
  relatedIssues: DoctorIssue[] = [],
) {
  if (
    issue.code === "instruction.exact-duplicate" ||
    issue.code === "instruction.unmanaged-duplicate"
  ) {
    const sources = (candidate: DoctorIssue) => JSON.stringify(doctorIssueFiles(candidate).sort());
    const agents = [
      ...new Set(
        [issue, ...relatedIssues]
          .filter(
            (candidate) => candidate.code === issue.code && sources(candidate) === sources(issue),
          )
          .flatMap((candidate) => (candidate.agent ? [AGENT_LABELS[candidate.agent]] : [])),
      ),
    ];
    if (agents.length)
      return doctorCopy(
        locale,
        issue.code === "instruction.exact-duplicate" ? "duplicateImpact" : "unmanagedImpact",
        { agents: agents.join(locale === "en-US" ? ", " : "、") },
      );
    return doctorCopy(locale, "duplicateUnknownImpact");
  }
  if (hasLiteralImportWarning(issue)) return doctorCopy(locale, "literalImportImpact");
  return doctorCopy(
    locale,
    Object.hasOwn(impactKeys, issue.code) ? impactKeys[issue.code]! : "unknownImpact",
  );
}

function hasLiteralImportWarning(issue: DoctorIssue) {
  return (
    issue.code === "context.warning" &&
    issue.evidence.some(
      (evidence) =>
        evidence.detail ===
        "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
    )
  );
}

export function doctorMatrixCounts(rows: DoctorAgentRow[]) {
  const statuses = rows.flatMap((row) => [
    row.instructions.status,
    row.skills.status,
    row.mcp.status,
  ]);
  const attention = statuses.filter(
    (status) => status === "attention" || status === "unavailable",
  ).length;
  return { agents: rows.length, normal: statuses.length - attention, attention };
}
