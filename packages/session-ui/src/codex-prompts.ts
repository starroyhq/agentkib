/**
 * The messages AgentKib sends for Codex's `/review` and `/init` (runtime-protocol's
 * `CodexCommandPrompt`), in the reader's language. They go out as ordinary turns, as in Codex
 * Desktop; the wording is AgentKib's own. The message shows in the conversation as written.
 */
export type CodexCommandPromptRequest = { kind: "review"; base: string | null } | { kind: "init" };

interface Prompts {
  reviewUncommitted: string;
  reviewBase: (base: string) => string;
  init: string;
}

const zhCnFindings =
  "只报告值得修改的问题，按严重程度排序：每条写明文件和行号、在什么情况下会出错以及原因，并给出建议的改法。遵守 AGENTS.md 等仓库说明里的约定。没有值得修改的问题就直接说明。";
const zhTwFindings =
  "只回報值得修改的問題，依嚴重程度排序：每項寫明檔案和行號、在什麼情況下會出錯以及原因，並提供建議的改法。遵守 AGENTS.md 等儲存庫說明中的慣例。沒有值得修改的問題就直接說明。";
const enFindings =
  "Report only issues worth fixing, most severe first: for each, give the file and line, when it goes wrong and why, and a suggested fix. Follow the conventions in the repository's instructions, such as AGENTS.md. If nothing is worth fixing, say so.";
const jaFindings =
  "修正すべき問題だけを、重大なものから順に挙げてください。各項目には、ファイルと行、どんな状況でなぜ問題になるか、修正案を書いてください。AGENTS.md などリポジトリの説明にある規約に従ってください。修正すべき問題がなければ、そうとだけ答えてください。";

const prompts: Record<"zh-CN" | "zh-TW" | "en-US" | "ja-JP", Prompts> = {
  "zh-CN": {
    reviewUncommitted: `审查当前未提交的改动（已暂存、未暂存和未跟踪的文件），只看不改。用 \`git status\` 和 \`git diff\`（包括 \`git diff --staged\`）查看改动，未跟踪的文件直接阅读，需要时再读相关代码。${zhCnFindings}`,
    reviewBase: (base) =>
      `审查当前分支相对 \`${base}\` 的改动，只看不改。先用 \`git merge-base HEAD ${base}\` 找到分叉点，再用 \`git diff <分叉点>\` 查看改动（其中包括未提交的部分；未跟踪的文件直接阅读），需要时再读相关代码。${zhCnFindings}`,
    init: "为这个目录写一份 AGENTS.md，供之后在这里工作的代理阅读。如果这里已经有 AGENTS.md，不要改动它，告诉我它已存在即可。先了解项目结构、构建和测试命令、代码风格与提交历史，再写这几部分：项目结构、常用命令（构建、测试、本地运行）、代码风格与命名、测试约定、提交与 PR 约定。只写这个仓库实际适用的内容，简短具体，给出实际的命令和路径。使用仓库现有文档的语言书写。",
  },
  "zh-TW": {
    reviewUncommitted: `審查目前尚未提交的變更（已暫存、未暫存和未追蹤的檔案），只看不改。用 \`git status\` 和 \`git diff\`（包括 \`git diff --staged\`）查看變更，未追蹤的檔案直接閱讀，需要時再讀相關程式碼。${zhTwFindings}`,
    reviewBase: (base) =>
      `審查目前分支相對於 \`${base}\` 的變更，只看不改。先用 \`git merge-base HEAD ${base}\` 找到分岔點，再用 \`git diff <分岔點>\` 查看變更（其中包括尚未提交的部分；未追蹤的檔案直接閱讀），需要時再讀相關程式碼。${zhTwFindings}`,
    init: "為這個目錄寫一份 AGENTS.md，供之後在這裡工作的代理閱讀。如果這裡已經有 AGENTS.md，不要變更它，告訴我它已存在即可。先了解專案結構、建置與測試指令、程式碼風格與提交歷史，再寫這幾個部分：專案結構、常用指令（建置、測試、在本機執行）、程式碼風格與命名、測試慣例、提交與 PR 慣例。只寫這個儲存庫實際適用的內容，簡短具體，提供實際的指令和路徑。使用儲存庫現有文件的語言撰寫。",
  },
  "en-US": {
    reviewUncommitted: `Review the uncommitted changes (staged, unstaged and untracked files) without changing anything. Use \`git status\` and \`git diff\` (including \`git diff --staged\`) to see them, read untracked files directly, and read the surrounding code where needed. ${enFindings}`,
    reviewBase: (base) =>
      `Review the changes on the current branch against \`${base}\` without changing anything. Find where the branch diverged with \`git merge-base HEAD ${base}\`, then inspect \`git diff <merge base>\`, which includes uncommitted changes (read untracked files directly), and read the surrounding code where needed. ${enFindings}`,
    init: "Write an AGENTS.md in this directory for agents that work here later. If an AGENTS.md already exists here, leave it unchanged and tell me so. First look at the project structure, build and test commands, code style and commit history, then cover: project structure, common commands (build, test, run locally), code style and naming, testing conventions, and commit and pull request conventions. Include only what applies to this repository, keep it short and specific, and give the actual commands and paths. Write it in the language of the repository's existing documentation.",
  },
  "ja-JP": {
    reviewUncommitted: `未コミットの変更（ステージ済み、未ステージ、未追跡のファイル）を、何も変更せずにレビューしてください。\`git status\` と \`git diff\`（\`git diff --staged\` を含む）で変更を確認し、未追跡のファイルは直接読み、必要に応じて関連するコードも読んでください。${jaFindings}`,
    reviewBase: (base) =>
      `現在のブランチの \`${base}\` に対する変更を、何も変更せずにレビューしてください。\`git merge-base HEAD ${base}\` で分岐点を求め、\`git diff <分岐点>\` で変更を確認してください（未コミットの変更も含まれます。未追跡のファイルは直接読んでください）。必要に応じて関連するコードも読んでください。${jaFindings}`,
    init: "このディレクトリに AGENTS.md を作成してください。今後ここで作業するエージェント向けです。すでに AGENTS.md がある場合は変更せず、その旨を伝えてください。まずプロジェクトの構成、ビルドとテストのコマンド、コードスタイル、コミット履歴を確認し、次の項目を書いてください：プロジェクトの構成、よく使うコマンド（ビルド、テスト、ローカルでの実行）、コードスタイルと命名、テストの規約、コミットとプルリクエストの規約。このリポジトリに実際に当てはまる内容だけを、短く具体的に、実際のコマンドとパスを添えて書いてください。リポジトリの既存のドキュメントと同じ言語で書いてください。",
  },
};

/** The message for a command, in the reader's language (English for others). */
export function codexCommandPrompt(locale: string, request: CodexCommandPromptRequest): string {
  const copy =
    prompts[
      locale === "zh-TW"
        ? "zh-TW"
        : locale.startsWith("zh")
          ? "zh-CN"
          : locale.startsWith("ja")
            ? "ja-JP"
            : "en-US"
    ];
  if (request.kind === "init") return copy.init;
  return request.base === null ? copy.reviewUncommitted : copy.reviewBase(request.base);
}
