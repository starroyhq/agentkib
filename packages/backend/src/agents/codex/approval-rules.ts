import path from "node:path";
import {
  approvalRuleEnvironment,
  approvalRuleHome,
  boundedRuleTexts,
  readGlobalRules,
  readRuleSource,
  ruleSourceNames,
  sameRulePath,
  toApprovalRule,
  type ApprovalRuleSource,
  type ApprovalRulesProvider,
} from "../../sessions/approval-rules";
import { literalCodexAllowRules } from "./approval-rules-parser";

export const codexApprovalRules: ApprovalRulesProvider = {
  async list(context) {
    const override = approvalRuleEnvironment(context).CODEX_HOME;
    const userRoot = path.join(override || path.join(approvalRuleHome(context), ".codex"), "rules");
    const roots: { directory: string; label: string; scope: ApprovalRuleSource["scope"] }[] = [];
    if (readGlobalRules(context))
      roots.push({
        directory: userRoot,
        label: override ? "CODEX_HOME/rules/" : "~/.codex/rules/",
        scope: "global",
      });
    if (context.workspace) {
      const directory = path.join(context.workspace, ".codex", "rules");
      if (!sameRulePath(directory, userRoot))
        roots.push({ directory, label: ".codex/rules/", scope: "project" });
    }
    return roots.flatMap(({ directory, scope, label }) =>
      ruleSourceNames(directory, ".rules").flatMap((name) => {
        const source = { file: path.join(directory, name), label: label + name, scope };
        const text = readRuleSource(source.file);
        if (text === undefined) return [];
        return boundedRuleTexts(literalCodexAllowRules(text)).map((rule) =>
          toApprovalRule(source, rule),
        );
      }),
    );
  },
};
