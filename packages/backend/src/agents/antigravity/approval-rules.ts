import path from "node:path";
import {
  approvalRuleHome,
  listJsonAllowRules,
  readGlobalRules,
  type ApprovalRulesProvider,
} from "../../sessions/approval-rules";

export const antigravityApprovalRules: ApprovalRulesProvider = {
  async list(context) {
    if (!readGlobalRules(context)) return [];
    const filename = ".gemini/antigravity-cli/settings.json";
    return listJsonAllowRules([
      {
        file: path.join(approvalRuleHome(context), filename),
        label: "~/" + filename,
        scope: "global",
      },
    ]);
  },
};
