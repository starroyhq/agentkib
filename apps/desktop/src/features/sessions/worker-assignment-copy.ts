import type { SupportedLocale } from "@/core/types";

type WorkerAssignmentCopy = {
  menu: string;
  title: (lead: string) => string;
  assign: string;
  empty: string;
  firstAssignment: string;
  assigned: string;
  remaining: (count: number) => string;
};

export const workerAssignmentCopy: Record<SupportedLocale, WorkerAssignmentCopy> = {
  "zh-CN": {
    menu: "指派 Worker",
    title: (lead) => `为「${lead}」指派 Worker`,
    assign: "确认指派",
    empty: "此项目中没有其他会话。",
    firstAssignment:
      "首次指派会将此会话设为项目 Agent，授权范围为它和所选 Worker 所在的工作区。审批和提问默认由你处理。",
    assigned: "已指派",
    remaining: (count) => `还可指派 ${count} 个 Worker`,
  },
  "zh-Hant": {
    menu: "指派 Worker",
    title: (lead) => `為「${lead}」指派 Worker`,
    assign: "確認指派",
    empty: "此專案中沒有其他對話。",
    firstAssignment:
      "首次指派會將此對話設為專案 Agent，授權範圍為它和所選 Worker 所在的工作區。核准和提問預設由你處理。",
    assigned: "已指派",
    remaining: (count) => `還可指派 ${count} 個 Worker`,
  },
  "ja-JP": {
    menu: "ワーカーを割り当てる",
    title: (lead) => `「${lead}」にワーカーを割り当てる`,
    assign: "割り当てる",
    empty: "このプロジェクトにほかのセッションがありません。",
    firstAssignment:
      "初回の割り当てで、このセッションがプロジェクト Agent になります。このセッションと選んだワーカーのワークスペースが許可されます。承認や質問は既定であなたが対応します。",
    assigned: "割り当て済み",
    remaining: (count) => `あと ${count} 件割り当て可能`,
  },
  "en-US": {
    menu: "Assign Workers",
    title: (lead) => `Assign Workers to “${lead}”`,
    assign: "Assign",
    empty: "There are no other sessions in this project.",
    firstAssignment:
      "The first assignment makes this session a Project Agent in its own workspace and the selected Workers’ workspaces. You handle approvals and questions by default.",
    assigned: "Assigned",
    remaining: (count) => `${count} Worker ${count === 1 ? "slot" : "slots"} remaining`,
  },
};
