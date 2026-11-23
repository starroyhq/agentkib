import { sessionContinuationCopy } from "../../session-continuation";
import type { ApprovalRuntime, LegacyApprovals } from "../session-approvals";

export const pluginApprovalMethods: LegacyApprovals = {
  "dsh/approval": { kind: "tool", nativeToolCall: false },
};

export const pluginApprovalRuntime: ApprovalRuntime = {
  owner: "external",
  legacyMode: "dsh-follower",
  handleThere: (locale) => sessionContinuationCopy(locale).dshHandleThere,
  reportsWithdrawn: true,
};
