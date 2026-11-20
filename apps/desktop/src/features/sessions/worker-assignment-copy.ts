import type { SupportedLocale } from "@/core/types";

type WorkerAssignmentCopy = {
  menu: string;
  title: (lead: string) => string;
  assign: string;
  empty: string;
  firstAssignment: string;
  assigned: string;
  unavailable: string;
  cannotLead: string;
  remaining: (count: number) => string;
  reasons: Record<string, string>;
};

export const workerAssignmentCopy: Record<SupportedLocale, WorkerAssignmentCopy> = {
  "zh-CN": {
    menu: "指派 Worker",
    title: (lead) => `为「${lead}」指派 Worker`,
    assign: "确认指派",
    empty: "此项目中没有其他会话。",
    firstAssignment:
      "首次指派会将此会话设为项目 Agent，授权范围为它和所选 Worker 所在的工作区。审批和提问默认由你处理。",
    assigned: "已指派给此会话",
    unavailable: "此会话暂不可用",
    cannotLead: "此会话暂时无法协调 Worker。",
    remaining: (count) => `还可指派 ${count} 个 Worker`,
    reasons: {
      "session-is-a-project-agent": "此会话已是项目 Agent",
      "session-is-a-worker": "此会话已指派给另一个项目 Agent",
      "worker-requires-codex-or-dsh-session": "Worker 支持 Codex 和 DeepSeek Harness 会话",
      "workspace-not-allowed": "此工作区尚未获准用于委派",
      "worker-limit-reached": "已达到 Worker 数量上限",
      "delegation-paused": "委派已暂停",
      "worker-outside-project": "此会话已不在此项目中",
    },
  },
  "zh-Hant": {
    menu: "指派 Worker",
    title: (lead) => `為「${lead}」指派 Worker`,
    assign: "確認指派",
    empty: "此專案中沒有其他對話。",
    firstAssignment:
      "首次指派會將此對話設為專案 Agent，授權範圍為它和所選 Worker 所在的工作區。核准和提問預設由你處理。",
    assigned: "已指派給此對話",
    unavailable: "此對話暫時無法使用",
    cannotLead: "此對話暫時無法協調 Worker。",
    remaining: (count) => `還可指派 ${count} 個 Worker`,
    reasons: {
      "session-is-a-project-agent": "此對話已是專案 Agent",
      "session-is-a-worker": "此對話已指派給另一個專案 Agent",
      "worker-requires-codex-or-dsh-session": "Worker 支援 Codex 和 DeepSeek Harness 對話",
      "workspace-not-allowed": "此工作區尚未獲准用於委任",
      "worker-limit-reached": "已達 Worker 數量上限",
      "delegation-paused": "委任已暫停",
      "worker-outside-project": "此對話已不在此專案中",
    },
  },
  "ja-JP": {
    menu: "ワーカーを割り当てる",
    title: (lead) => `「${lead}」にワーカーを割り当てる`,
    assign: "割り当てる",
    empty: "このプロジェクトにほかのセッションがありません。",
    firstAssignment:
      "初回の割り当てで、このセッションがプロジェクト Agent になります。このセッションと選んだワーカーのワークスペースが許可されます。承認や質問は既定であなたが対応します。",
    assigned: "このセッションに割り当て済み",
    unavailable: "このセッションは現在利用できません",
    cannotLead: "現在このセッションはワーカーを管理できません。",
    remaining: (count) => `あと ${count} 件割り当て可能`,
    reasons: {
      "session-is-a-project-agent": "このセッションはすでにプロジェクト Agent です",
      "session-is-a-worker": "別のプロジェクト Agent に割り当て済み",
      "worker-requires-codex-or-dsh-session":
        "ワーカーは Codex と DeepSeek Harness に対応しています",
      "workspace-not-allowed": "このワークスペースは委任を許可されていません",
      "worker-limit-reached": "ワーカー数の上限に達しました",
      "delegation-paused": "委任が一時停止しています",
      "worker-outside-project": "このセッションはこのプロジェクトに属していません",
    },
  },
  "en-US": {
    menu: "Assign Workers",
    title: (lead) => `Assign Workers to “${lead}”`,
    assign: "Assign",
    empty: "There are no other sessions in this project.",
    firstAssignment:
      "The first assignment makes this session a Project Agent in its own workspace and the selected Workers’ workspaces. You handle approvals and questions by default.",
    assigned: "Already assigned to this session",
    unavailable: "This session is currently unavailable",
    cannotLead: "This session cannot coordinate Workers right now.",
    remaining: (count) => `${count} Worker ${count === 1 ? "slot" : "slots"} remaining`,
    reasons: {
      "session-is-a-project-agent": "This session is already a Project Agent",
      "session-is-a-worker": "Already assigned to another Project Agent",
      "worker-requires-codex-or-dsh-session": "Workers can be Codex or DeepSeek Harness sessions",
      "workspace-not-allowed": "This workspace is outside the delegation scope",
      "worker-limit-reached": "The Worker limit has been reached",
      "delegation-paused": "Delegation is paused",
      "worker-outside-project": "This session is no longer in the project",
    },
  },
};
