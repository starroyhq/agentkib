import type { Live, SessionProviderDeclaration } from "@agentkib/web-client";
import { sessionApprovalRuntime } from "./agents/session-approvals";
import { interactionRiskCopy } from "./interaction-risk-copy";
import type { InteractionDockItem, InteractionNotice } from "./interaction-card";
import {
  approvalCardModel,
  fillCopy,
  interactionCardCopy,
  type InteractionApproval,
  type InteractionLocale,
  type InteractionQuestionRequest,
} from "./interaction-model";

/** The access fields that decide what this device may do with a request. */
export interface InteractionItemsAccess {
  bootId: string;
  experimentalEnabled: boolean;
  device?: { approve: boolean; send: boolean; extendedApproval?: boolean };
}

/** The session state fields the cards are built from. */
export interface InteractionItemsLive<
  A extends InteractionApproval = InteractionApproval,
  Q extends InteractionQuestionRequest = InteractionQuestionRequest,
> {
  revision: number;
  approvals: A[];
  questions?: Q[];
  executionMode?: string | null;
  execution?: Live["execution"];
  pendingInteractions?: Live["pendingInteractions"];
}

export interface InteractionItemsContext {
  locale: InteractionLocale;
  sessionId: string;
  /** Display name of the session's Agent, such as "Codex". */
  agent: string;
  workspacePath?: string;
  connection?: NonNullable<SessionProviderDeclaration["connection"]>["kind"];
  /** Whether the composer offers Stop for this turn; outside the session view it does not. */
  canStop: boolean;
  /** Connected and ready for controls; otherwise the cards only show the requests. */
  ready: boolean;
  blocked?: (kind: "approve" | "answer") => boolean;
  /** The last decision's outcome is unknown; nothing is sent again until it is known. */
  uncertain: boolean;
}

/** Stable key of one request in the session's queue of approvals and questions. */
export function interactionKey(request: InteractionApproval | InteractionQuestionRequest) {
  return `${"questions" in request ? "question" : "approval"}:${request.turnId}:${String(request.requestId)}`;
}

/**
 * A session's waiting approvals and questions as cards, in the order they arrived. Every Agent
 * uses the same cards; this decides what this device may do with each request and says why when
 * it cannot. The maps give back the exact request each card shows, which is what gets decided.
 */
export function sessionInteractionItems<
  A extends InteractionApproval,
  Q extends InteractionQuestionRequest,
>(
  live: InteractionItemsLive<A, Q>,
  access: InteractionItemsAccess,
  context: InteractionItemsContext,
): { items: InteractionDockItem[]; approvals: Map<string, A>; questions: Map<string, Q> } {
  const { locale, agent, ready, uncertain } = context;
  const t = interactionCardCopy(locale);
  const native = sessionApprovalRuntime(live, context.connection);
  const handleThere = native?.handleThere?.(locale);
  const elsewhere = (supported: boolean): InteractionNotice | undefined =>
    !supported && handleThere ? { tone: "terminal", text: handleThere } : undefined;
  const approvals = new Map<string, A>();
  const questions = new Map<string, Q>();
  const items: InteractionDockItem[] = [
    ...live.approvals.map((approval): InteractionDockItem => {
      const key = interactionKey(approval);
      const model = approvalCardModel(approval, {
        locale,
        agent,
        workspacePath: context.workspacePath,
        canStop: context.canStop,
      });
      if (native?.owner === "terminal" && approval.method === "claude/can_use_tool") {
        const description = live.pendingInteractions?.find(
          ({ kind, binding }) =>
            kind === "approval" &&
            binding.sessionId === context.sessionId &&
            binding.turnId === approval.turnId &&
            binding.requestId === approval.requestId &&
            binding.revision === live.revision,
        );
        return {
          kind: "approval",
          key,
          model,
          enabled: false,
          ...(description ? { risk: interactionRiskCopy(locale, description.risk) } : {}),
        };
      }
      approvals.set(key, approval);
      const permitted =
        !!access.experimentalEnabled &&
        !!access.device?.approve &&
        (!approval.decisionOptions?.length || !!access.device.extendedApproval);
      const notice =
        elsewhere(approval.supported) ??
        (!approval.supported || !model.choices.length
          ? { tone: "neutral" as const, text: fillCopy(t.unsupported, { agent }) }
          : !permitted
            ? { tone: "lock" as const, text: t.noApprovePermission }
            : uncertain
              ? { tone: "pending" as const, text: t.uncertain }
              : undefined);
      return {
        kind: "approval",
        key,
        model,
        enabled: !notice && ready && !context.blocked?.("approve"),
        notice,
      };
    }),
    ...(live.questions ?? []).map((question): InteractionDockItem => {
      const key = interactionKey(question);
      questions.set(key, question);
      const permitted = !!access.experimentalEnabled && !!access.device?.send;
      const notice =
        elsewhere(question.supported) ??
        (!question.supported
          ? undefined
          : !permitted
            ? { tone: "lock" as const, text: t.noSendPermission }
            : uncertain
              ? { tone: "pending" as const, text: t.uncertain }
              : undefined);
      return {
        kind: "question",
        key,
        request: question,
        enabled: !notice && question.supported && ready && !context.blocked?.("answer"),
        notice,
        answerContext: {
          sessionId: context.sessionId,
          bootId: access.bootId,
          expectedRevision: live.revision,
        },
      };
    }),
  ];
  return { items, approvals, questions };
}
