/** One of DeepSeek Harness's Agent presets, as the Host lists them for a new session. */
export interface DshAgentPreset {
  id: string;
  /** Null for a preset DSH ships, which clients name as DSH's own window does. */
  name: string | null;
  description: string | null;
  isDefault: boolean;
  /** Why DSH could not load the preset; it cannot be chosen. */
  broken: string | null;
}

type Locale = "zh-CN" | "zh-TW" | "en-US" | "ja-JP";
const locales: Locale[] = ["zh-CN", "zh-TW", "en-US", "ja-JP"];
const localeOf = (locale: string): Locale =>
  locales.includes(locale as Locale) ? (locale as Locale) : "en-US";

// The names DSH gives the presets it ships (`dsh-agent-preset-registry/display`). A preset a
// user wrote keeps its own name and description, which are never translated.
const BUILT_IN: Record<string, Record<Locale, [name: string, description: string]>> = {
  standard: {
    "zh-CN": [
      "标准模式",
      "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
    ],
    "zh-TW": [
      "標準模式",
      "處理程式碼、檔案和資料，適合大多數任務。Agent 會依需要使用檢索、編輯和終端機等工具。",
    ],
    "en-US": [
      "Standard mode",
      "Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.",
    ],
    "ja-JP": [
      "標準モード",
      "コード、ファイル、資料を扱い、ほとんどのタスクに適しています。Agent は必要に応じて検索、編集、ターミナルなどのツールを使います。",
    ],
  },
  ptc: {
    "zh-CN": [
      "PTC 模式",
      "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
    ],
    "zh-TW": [
      "PTC 模式",
      "包含標準模式的所有能力，更適合批次呼叫工具，並對結果進行篩選、整理、去重、統計或彙總的任務。",
    ],
    "en-US": [
      "PTC mode",
      "Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.",
    ],
    "ja-JP": [
      "PTC モード",
      "標準モードのすべての機能を含み、ツールをまとめて呼び出して結果の絞り込み、整理、重複除去、集計、要約を行うタスクに向いています。",
    ],
  },
  minimal: {
    "zh-CN": [
      "极简模式",
      "Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。",
    ],
    "zh-TW": [
      "極簡模式",
      "Agent 使用終端機和圖片讀取工具，並支援上下文壓縮，適合測試和比較其基礎表現。",
    ],
    "en-US": [
      "Minimal mode",
      "The agent uses a terminal and image reading, with context compaction. Useful for testing and comparing its basic performance.",
    ],
    "ja-JP": [
      "ミニマルモード",
      "Agent はターミナルと画像読み取りツールを使い、コンテキスト圧縮に対応します。基本的な性能のテストや比較に役立ちます。",
    ],
  },
  cordis: {
    "zh-CN": [
      "创造模式",
      "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
    ],
    "zh-TW": [
      "創造模式",
      "用對話自訂 DSH：讓 Agent 撰寫外掛，加入新功能或介面；也能組合工具和提示詞，建立自己的模式。",
    ],
    "en-US": [
      "Creator mode",
      "Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.",
    ],
    "ja-JP": [
      "クリエイターモード",
      "会話で DSH をカスタマイズします。Agent にプラグインを書かせて機能や画面を追加したり、ツールとプロンプトを組み合わせて独自のモードを作ったりできます。",
    ],
  },
};

/** A preset's name and description as DSH's own new-session screen shows them. */
export function dshAgentPresetText(
  preset: DshAgentPreset,
  locale: string,
): { name: string; description: string | null } {
  const shipped = preset.name === null ? BUILT_IN[preset.id] : undefined;
  if (shipped) {
    const [name, description] = shipped[localeOf(locale)];
    return { name, description };
  }
  return { name: preset.name ?? preset.id, description: preset.description };
}

const COPY: Record<Locale, { label: string; broken: string }> = {
  "zh-CN": { label: "Agent 预设", broken: "加载失败" },
  "zh-TW": { label: "Agent 預設", broken: "載入失敗" },
  "en-US": { label: "Agent preset", broken: "Failed to load" },
  "ja-JP": { label: "Agent プリセット", broken: "読み込みに失敗" },
};

export function dshAgentPresetCopy(locale: string): { label: string; broken: string } {
  return COPY[localeOf(locale)];
}
