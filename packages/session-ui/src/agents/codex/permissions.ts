import type { InteractionLocale } from "../../interaction-model";
import type {
  PermissionLabel,
  PermissionWords,
  SessionPermissionDescriptor,
} from "../session-permissions";

const copy = {
  "zh-CN": {
    title: "应如何批准 Codex 操作？",
    choices: {
      "workspace-write-on-request": {
        name: "请求批准",
        description: "编辑外部文件和使用互联网时始终询问",
      },
      "workspace-write-auto-review": {
        name: "帮我批准",
        description: "仅对检测到的风险操作请求批准",
      },
      "full-access-on-request": {
        name: "完全访问权限",
        description: "可不受限制地访问互联网和你电脑上的任何文件",
      },
    },
  },
  "zh-Hant": {
    title: "應如何核准 Codex 操作？",
    choices: {
      "workspace-write-on-request": {
        name: "要求核准",
        description: "一律先詢問是否要編輯外部檔案及使用網際網路",
      },
      "workspace-write-auto-review": {
        name: "代我核准",
        description: "僅對偵測為可能不安全的操作要求核准",
      },
      "full-access-on-request": {
        name: "完整存取權",
        description: "可無限制存取網際網路和您電腦上的任何檔案",
      },
    },
  },
  "en-US": {
    title: "How should Codex actions be approved?",
    choices: {
      "workspace-write-on-request": {
        name: "Ask for approval",
        description: "Always ask to edit external files and use the internet",
      },
      "workspace-write-auto-review": {
        name: "Approve for me",
        description: "Only ask for actions detected as potentially unsafe",
      },
      "full-access-on-request": {
        name: "Full access",
        description: "Unrestricted access to the internet and any file on your computer",
      },
    },
  },
  "ja-JP": {
    title: "Codex の操作をどのように承認しますか？",
    choices: {
      "workspace-write-on-request": {
        name: "承認を求める",
        description: "外部ファイルの編集やインターネットの利用について、常に確認を求めます",
      },
      "workspace-write-auto-review": {
        name: "代わりに承認",
        description: "安全でない可能性があると検出された操作についてのみ確認を求めます",
      },
      "full-access-on-request": {
        name: "フルアクセス",
        description: "インターネットとコンピューター上のすべてのファイルに無制限でアクセスします",
      },
    },
  },
} satisfies Record<InteractionLocale, PermissionWords>;

export function codexPermissionCopy(locale: InteractionLocale) {
  return copy[locale] ?? copy["en-US"];
}

export function codexPolicyLabel(
  id: string,
  locale: InteractionLocale,
): PermissionLabel | undefined {
  const choices = codexPermissionCopy(locale).choices as Readonly<Record<string, PermissionLabel>>;
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}

const choices = [
  { id: "workspace-write-on-request" },
  { id: "workspace-write-auto-review", fullAccessOnly: true },
  { id: "full-access-on-request", fullAccessOnly: true, risky: true },
] as const;

export const codexPermissions = {
  creation: { field: "policyId", choices, sendShown: true, copy: codexPermissionCopy },
  settings: {
    label: codexPolicyLabel,
    risky: (id) => id === "full-access-on-request" || id === "danger-full-access",
  },
} satisfies SessionPermissionDescriptor;
