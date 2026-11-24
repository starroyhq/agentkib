import {
  MANAGED_AGENTS,
  sessionProviderDeclaration,
  type ApprovalRuleCapability,
  type ApprovalRuleList,
  type ManagedAgent,
} from "@agentkib/runtime-protocol";
import { antigravityApprovalRules } from "../agents/antigravity/approval-rules";
import { claudeApprovalRules } from "../agents/claude/approval-rules";
import { codexApprovalRules } from "../agents/codex/approval-rules";
import { devinApprovalRules } from "../agents/devin/approval-rules";
import type { ApprovalRuleContext, ApprovalRulesProvider } from "./approval-rules";

export type { ApprovalRuleContext } from "./approval-rules";

const ruleProviders: Record<ManagedAgent, ApprovalRulesProvider | undefined> = {
  codex: codexApprovalRules,
  "claude-code": claudeApprovalRules,
  "deepseek-harness": undefined,
  devin: devinApprovalRules,
  antigravity: antigravityApprovalRules,
};

function capabilities(agent: ManagedAgent): ApprovalRuleCapability {
  return sessionProviderDeclaration(agent)?.approvalRules ?? { list: false, revoke: false };
}

export const nativeApprovalRules = {
  async list(context: ApprovalRuleContext): Promise<ApprovalRuleList> {
    const providers = {} as ApprovalRuleList["providers"];
    const groups = await Promise.all(
      MANAGED_AGENTS.map(async (agent) => {
        const declaration = capabilities(agent);
        const provider = ruleProviders[agent];
        providers[agent] = declaration;
        if (!declaration.list || !provider) return [];
        const rules = await provider.list(context);
        return rules.map((rule) => ({
          ...rule,
          agent,
          revocable: rule.revocable && declaration.revoke && provider.revoke !== undefined,
        }));
      }),
    );
    return { providers, rules: groups.flat() };
  },
  async revoke(context: ApprovalRuleContext, agent: ManagedAgent, ruleId: string): Promise<void> {
    const provider = ruleProviders[agent];
    if (!capabilities(agent).revoke || !provider?.revoke)
      throw new Error("approval-rule-read-only");
    await provider.revoke(context, ruleId);
  },
};
