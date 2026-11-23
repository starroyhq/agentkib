import type { SessionApprovalKind } from "@agentkib/web-client";
import type {
  ApprovalChoice,
  InteractionApproval,
  InteractionCardCopy,
} from "../../interaction-model";
import { sessionContinuationCopy } from "../../session-continuation";
import { fillCopy, object, strings, text } from "../../interaction-text";
import type { ApprovalRuntime, LegacyApprovals } from "../session-approvals";

export const nativeAppApproval: ApprovalRuntime = {
  owner: "native-app",
  legacyMode: "codex-follower",
  handleThere: (locale) => sessionContinuationCopy(locale).codexHandleThere,
};

export const nativeAppApprovalMethods: LegacyApprovals = {
  "item/commandExecution/requestApproval": {
    kind: (approval) => (networkHost(object(approval.requestContext)) ? "network" : "command"),
  },
  "item/fileChange/requestApproval": { kind: "files" },
  "item/permissions/requestApproval": { kind: "permissions" },
  "mcpServer/elicitation/request": { kind: "mcp" },
};

export function networkHost(context: Record<string, unknown>): string | undefined {
  const network = object(context.networkApprovalContext);
  const host = text(network.host);
  return host && text(network.protocol) ? `${network.protocol}://${host}` : host;
}

function commandPrefix(decision: unknown): string | undefined {
  const parts = strings(
    object(object(decision).acceptWithExecpolicyAmendment).execpolicy_amendment,
  );
  return parts.length
    ? parts.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ")
    : undefined;
}

export function nativeApprovalChoices(
  approval: InteractionApproval,
  t: InteractionCardCopy,
  canStop: boolean,
  kind: SessionApprovalKind,
): ApprovalChoice[] {
  const files = kind === "files";
  return (approval.decisionOptions ?? []).flatMap((option): ApprovalChoice[] => {
    const base = { key: option.id, nativeDecision: option.decision };
    switch (option.label) {
      case "accept":
        return [{ ...base, label: t.allowOnce, quick: "allow" }];
      case "acceptForSession":
        return [
          files
            ? { ...base, label: t.allowAllEdits, detail: t.allEditsDetail }
            : { ...base, label: t.allowSession, detail: t.sessionCommandDetail },
        ];
      case "acceptWithExecpolicyAmendment": {
        const command = commandPrefix(option.decision);
        return [
          {
            ...base,
            label: t.alwaysAllow,
            detail: command ? fillCopy(t.persistentCommandDetail, { command }) : undefined,
          },
        ];
      }
      case "applyNetworkPolicyAmendment": {
        const rule = object(
          object(object(option.decision).applyNetworkPolicyAmendment).network_policy_amendment,
        );
        const host = text(rule.host);
        const deny = rule.action === "deny";
        return [
          {
            ...base,
            label: deny ? t.alwaysDeny : t.alwaysAllow,
            detail: host
              ? fillCopy(deny ? t.networkDenyDetail : t.networkAllowDetail, { host })
              : undefined,
          },
        ];
      }
      case "decline":
      case "deny-permissions":
        return [{ ...base, label: t.deny, quick: "deny" }];
      case "cancel":
        return canStop ? [] : [{ ...base, label: t.denyAndStop, quick: "stop" }];
      case "grant-turn":
        return [{ ...base, label: t.allowTurn, quick: "allow" }];
      case "grant-session":
        return [{ ...base, label: t.allowSession }];
      default:
        return [
          { ...base, label: option.label, disabled: true, disabledReason: t.unsupportedOption },
        ];
    }
  });
}
