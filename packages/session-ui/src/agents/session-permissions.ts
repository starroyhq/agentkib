import type { ClaudePermissionMode, DevinPermissionMode } from "@agentkib/web-client";
import type { InteractionLocale } from "../interaction-model";
import { antigravityPermissionCopy, antigravityPermissions } from "./antigravity/permissions";
import { claudePermissionCopy, claudePermissions } from "./claude-code/permissions";
import { codexPermissionCopy, codexPermissions } from "./codex/permissions";
import { deepSeekHarnessPermissions } from "./deepseek-harness/permissions";
import { devinPermissionCopy, devinPermissions } from "./devin/permissions";

export type PermissionLabel = {
  name: string;
};

export type PermissionWords = {
  title: string;
  choices: Readonly<Record<string, PermissionLabel>>;
};

export type SessionPermissionDescriptor = {
  creation?: {
    field: "policyId" | "permissionMode";
    choices: readonly {
      id: string;
      risky?: boolean;
      fullAccessOnly?: boolean;
      separatePlan?: boolean;
    }[];
    sendShown: boolean;
    defaultId?: string;
    fullAccessOnly?: boolean;
    useNativeCatalog?: boolean;
    verifyPolicyId?: boolean;
    copy(locale: InteractionLocale): PermissionWords;
    fallbackTitle?: boolean;
  };
  settings: {
    label(id: string, locale: InteractionLocale): PermissionLabel | undefined;
    risky(id: string): boolean;
    modeIds?: readonly (ClaudePermissionMode | DevinPermissionMode)[];
  };
};

const permissions = {
  codex: codexPermissions,
  "claude-code": claudePermissions,
  "deepseek-harness": deepSeekHarnessPermissions,
  devin: devinPermissions,
  antigravity: antigravityPermissions,
};

export function sessionPermissionDescriptor(
  agent?: string,
): SessionPermissionDescriptor | undefined {
  return agent && Object.hasOwn(permissions, agent)
    ? permissions[agent as keyof typeof permissions]
    : undefined;
}

/** Preserves the shape of the existing localized creation copy API. */
export function newSessionPermissionCopy(locale: InteractionLocale) {
  return {
    codex: codexPermissionCopy(locale),
    devin: devinPermissionCopy(locale),
    antigravity: antigravityPermissionCopy(locale),
    "claude-code": claudePermissionCopy(locale),
  };
}
