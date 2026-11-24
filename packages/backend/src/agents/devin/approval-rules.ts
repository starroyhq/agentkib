import path from "node:path";
import JSON5 from "json5";
import {
  approvalRuleEnvironment,
  approvalRuleHome,
  listJsonAllowRules,
  readGlobalRules,
  sameRulePath,
  type ApprovalRuleSource,
  type ApprovalRulesProvider,
} from "../../sessions/approval-rules";

export const devinApprovalRules: ApprovalRulesProvider = {
  async list(context) {
    const env = approvalRuleEnvironment(context);
    const userRoot =
      process.platform === "win32"
        ? (env.APPDATA ?? path.join(approvalRuleHome(context), "AppData/Roaming"))
        : path.join(approvalRuleHome(context), ".config");
    const userFile = path.join(userRoot, "devin/config.json");
    const sources: ApprovalRuleSource[] = [];
    if (readGlobalRules(context))
      sources.push({
        file: userFile,
        label:
          process.platform === "win32"
            ? "%APPDATA%/devin/config.json"
            : "~/.config/devin/config.json",
        scope: "global",
      });
    if (context.workspace) {
      for (const name of [".devin/config.json", ".devin/config.local.json"]) {
        const file = path.join(context.workspace, name);
        if (!sameRulePath(file, userFile)) sources.push({ file, label: name, scope: "project" });
      }
    }
    // The configuration accepts comments. The interactive CLI owns comment-preserving edits.
    return listJsonAllowRules(sources, JSON5.parse);
  },
};
