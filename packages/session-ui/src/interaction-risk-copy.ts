import type { SessionPendingInteraction } from "@agentkib/web-client";
import type { InteractionLocale } from "./interaction-model";

type Risk = SessionPendingInteraction["risk"];
type Labels = Record<Risk["level"] | Risk["reason"], string>;

const labels: Record<InteractionLocale, Labels> = {
  "zh-CN": {
    high: "高风险",
    "file-modification": "修改文件",
    low: "低风险",
    deletion: "删除或移动数据",
    network: "访问网络",
    "dependency-install": "安装依赖",
    "outside-workspace": "访问工作区外的路径",
    "git-push": "推送 Git 提交",
    "unknown-operation": "操作影响未核实",
    "unknown-workspace": "工作目录未核实",
    "workspace-write": "写入工作区",
    "read-only": "只读操作",
    test: "运行测试",
    "static-check": "运行静态检查",
    question: "请求回答",
  },
  "zh-Hant": {
    high: "高風險",
    "file-modification": "修改檔案",
    low: "低風險",
    deletion: "刪除或移動資料",
    network: "存取網路",
    "dependency-install": "安裝相依套件",
    "outside-workspace": "存取工作區外的路徑",
    "git-push": "推送 Git 提交",
    "unknown-operation": "作業影響未確認",
    "unknown-workspace": "工作目錄未確認",
    "workspace-write": "寫入工作區",
    "read-only": "唯讀作業",
    test: "執行測試",
    "static-check": "執行靜態檢查",
    question: "要求回答",
  },
  "en-US": {
    high: "High risk",
    "file-modification": "File modification",
    low: "Low risk",
    deletion: "Deletes or moves data",
    network: "Accesses the network",
    "dependency-install": "Installs dependencies",
    "outside-workspace": "Accesses a path outside the workspace",
    "git-push": "Pushes Git commits",
    "unknown-operation": "Effects unverified",
    "unknown-workspace": "Working directory unverified",
    "workspace-write": "Writes to the workspace",
    "read-only": "Read-only operation",
    test: "Runs tests",
    "static-check": "Runs a static check",
    question: "Requests an answer",
  },
  "ja-JP": {
    high: "高リスク",
    "file-modification": "ファイル変更",
    low: "低リスク",
    deletion: "データの削除または移動",
    network: "ネットワークへのアクセス",
    "dependency-install": "依存関係のインストール",
    "outside-workspace": "ワークスペース外のパスへのアクセス",
    "git-push": "Git コミットのプッシュ",
    "unknown-operation": "操作の影響が未確認",
    "unknown-workspace": "作業ディレクトリが未確認",
    "workspace-write": "ワークスペースへの書き込み",
    "read-only": "読み取り専用の操作",
    test: "テストの実行",
    "static-check": "静的チェックの実行",
    question: "回答を要求",
  },
};

export function interactionRiskCopy(locale: InteractionLocale, risk: Risk) {
  const copy = labels[locale];
  return { label: copy[risk.level], text: copy[risk.reason] };
}
