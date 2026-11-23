import type { ApprovalChoice, InteractionApproval } from "../../interaction-model";
import type { LegacyApprovals } from "../session-approvals";

export function namedApprovalChoices(approval: InteractionApproval): ApprovalChoice[] {
  const ids = new Set(approval.availableDecisions);
  return (approval.options ?? [])
    .filter((option) => ids.has(option.optionId))
    .map((option) => ({
      key: option.optionId,
      label: option.name,
      decision: option.optionId,
      ...(option.kind === "allow_once"
        ? { quick: "allow" as const }
        : option.kind === "reject_once"
          ? { quick: "deny" as const }
          : {}),
    }));
}

export const acpApprovalMethods: LegacyApprovals = {
  "session/request_permission": {
    kind: "tool",
    nativeToolCall: true,
    choices: namedApprovalChoices,
  },
};
