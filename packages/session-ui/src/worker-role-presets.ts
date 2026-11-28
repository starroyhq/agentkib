import { REMOTE_WORKER_ROLE_CONTRACT, type WorkerRoleInput } from "@agentkib/web-client";
import { normalizeProjectAgentLocale, type ProjectAgentLocale } from "./project-agent-reasons";

export interface WorkerRolePreset {
  id: "architect" | "frontend" | "backend" | "qa" | "release";
  label: string;
  description: string;
}

export const WORKER_ROLE_LIMITS = {
  labelMin: REMOTE_WORKER_ROLE_CONTRACT.input.properties.label.minLength,
  labelMax: REMOTE_WORKER_ROLE_CONTRACT.input.properties.label.maxLength,
  descriptionMin: REMOTE_WORKER_ROLE_CONTRACT.input.properties.description.minLength,
  descriptionMax: REMOTE_WORKER_ROLE_CONTRACT.input.properties.description.maxLength,
} as const;

const presetsByLocale: Record<ProjectAgentLocale, readonly WorkerRolePreset[]> = {
  "zh-CN": [
    {
      id: "architect",
      label: "软件架构师",
      description:
        "负责整体架构和跨模块的设计决策，评审其他 Worker 的方案和 PR；不直接修改产品代码。",
    },
    {
      id: "frontend",
      label: "前端工程师",
      description: "负责界面和交互的实现；不修改后台接口和协议。",
    },
    {
      id: "backend",
      label: "后端工程师",
      description: "负责后台服务、协议和测试；不修改界面。",
    },
    {
      id: "qa",
      label: "测试工程师",
      description:
        "按用户可见的行为验收每项改动，维护验收用例；发现的问题转交对应的负责人，不自行修复。",
    },
    {
      id: "release",
      label: "发布工程师",
      description: "负责版本准备、打标签、跟进构建和核对安装包；不合并功能改动。",
    },
  ],
  "zh-Hant": [
    {
      id: "architect",
      label: "軟體架構師",
      description:
        "負責整體架構和跨模組的設計決策，評審其他 Worker 的方案和 PR；不直接修改產品程式碼。",
    },
    {
      id: "frontend",
      label: "前端工程師",
      description: "負責介面和互動的實作；不修改後台介面和協定。",
    },
    {
      id: "backend",
      label: "後端工程師",
      description: "負責後台服務、協定和測試；不修改介面。",
    },
    {
      id: "qa",
      label: "測試工程師",
      description:
        "按使用者可見的行為驗收每項改動，維護驗收案例；發現的問題轉交對應的負責人，不自行修復。",
    },
    {
      id: "release",
      label: "發布工程師",
      description: "負責版本準備、打標籤、跟進建置和核對安裝包；不合併功能改動。",
    },
  ],
  "en-US": [
    {
      id: "architect",
      label: "Software Architect",
      description:
        "Owns overall architecture and cross-module design decisions, and reviews other Workers' proposals and PRs; does not modify product code directly.",
    },
    {
      id: "frontend",
      label: "Frontend Engineer",
      description:
        "Implements user interfaces and interactions; does not modify backend APIs or protocols.",
    },
    {
      id: "backend",
      label: "Backend Engineer",
      description: "Owns backend services, protocols, and tests; does not modify the UI.",
    },
    {
      id: "qa",
      label: "QA Engineer",
      description:
        "Verifies every change against user-visible behavior and maintains acceptance cases; routes found issues to the owning engineer without fixing them directly.",
    },
    {
      id: "release",
      label: "Release Engineer",
      description:
        "Handles release preparation, tagging, build tracking, and installer verification; does not merge feature changes.",
    },
  ],
  "ja-JP": [
    {
      id: "architect",
      label: "ソフトウェアアーキテクト",
      description:
        "全体アーキテクチャとモジュール横断の設計判断を担い、他のワーカーの提案や PR をレビューします。製品コードの直接修正は行いません。",
    },
    {
      id: "frontend",
      label: "フロントエンドエンジニア",
      description:
        "ユーザーインターフェースとインタラクションの実装を担当します。バックエンド API やプロトコルは変更しません。",
    },
    {
      id: "backend",
      label: "バックエンドエンジニア",
      description: "バックエンドサービス、プロトコル、テストを担当します。UI は変更しません。",
    },
    {
      id: "qa",
      label: "QA エンジニア",
      description:
        "ユーザーから見える挙動に基づいて各変更を検証し、受け入れテストケースを維持します。見つかった不具合は担当者に引き継ぎ、自ら修正は行いません。",
    },
    {
      id: "release",
      label: "リリースエンジニア",
      description:
        "リリース準備、タグ付け、ビルドの追跡、インストーラーの確認を担当します。機能変更のマージは行いません。",
    },
  ],
};

export function workerRolePresets(locale: string): readonly WorkerRolePreset[] {
  return presetsByLocale[normalizeProjectAgentLocale(locale)];
}

export function sanitizeSingleLineRoleLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function validateWorkerRoleDraft(
  label: string,
  description: string,
): { valid: true; input: WorkerRoleInput } | { valid: false } {
  const cleanLabel = sanitizeSingleLineRoleLabel(label).trim();
  const cleanDescription = description.trim();
  if (
    cleanLabel.length < WORKER_ROLE_LIMITS.labelMin ||
    cleanLabel.length > WORKER_ROLE_LIMITS.labelMax ||
    cleanDescription.length < WORKER_ROLE_LIMITS.descriptionMin ||
    cleanDescription.length > WORKER_ROLE_LIMITS.descriptionMax
  ) {
    return { valid: false };
  }
  return { valid: true, input: { label: cleanLabel, description: cleanDescription } };
}
