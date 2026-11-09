import { useCallback } from "react";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import { agentName } from "@agentkib/agent-identity";
import {
  approvalCardModel,
  fillCopy,
  interactionCardCopy,
  InteractionDock,
  sessionContinuationCopy,
  type InteractionDockItem,
  type InteractionNotice,
} from "@agentkib/session-ui";
import { codexReason } from "../sessions/codex-copy";
import { useSession } from "../sessions/session-context";

export function interactionKey(request: Approval | UserQuestionRequest) {
  return `${"questions" in request ? "question" : "approval"}:${request.turnId}:${String(request.requestId)}`;
}

function isInteraction(value: unknown): value is Approval | UserQuestionRequest {
  return (
    !!value &&
    typeof value === "object" &&
    "requestId" in value &&
    "turnId" in value &&
    !("kind" in value)
  );
}

/**
 * The open session's approvals and questions as cards above the composer. Every agent uses the
 * same card; this only decides what this device may do with each request and sends the decision.
 */
export function SessionInteractionDock() {
  const {
    live,
    access,
    online,
    controlReady,
    busy,
    notice,
    noticeReason,
    noticeSource,
    locale,
    control,
    modal,
    setModal,
    selected,
    current,
    currentWorkspace,
    canStop,
  } = useSession();
  const focused = useCallback(() => setModal(undefined), [setModal]);
  if (!live || !access) return null;
  const t = interactionCardCopy(locale);
  const agent = agentName(current?.agent);
  const continuation = sessionContinuationCopy(locale);
  const fromCard = noticeSource === "approve" || noticeSource === "answer";
  const uncertain =
    (fromCard && notice === "uncertain") ||
    live.status === "outcome-unknown" ||
    live.reason === "control-outcome-unconfirmed";
  // Requests the session follows from another client are answered there.
  const elsewhere = (supported: boolean): InteractionNotice | undefined =>
    supported
      ? undefined
      : live.executionMode === "codex-follower"
        ? { tone: "terminal", text: continuation.codexHandleThere }
        : live.executionMode === "dsh-follower"
          ? { tone: "terminal", text: continuation.dshHandleThere }
          : undefined;
  // DeepSeek Harness withdraws a request as soon as either side answers it, so one that leaves a
  // connected session without an answer from here was answered there.
  const vanished: InteractionNotice | undefined =
    !busy && live.executionMode === "dsh-follower" && live.executionLocation === "external"
      ? { tone: "done", text: codexReason(locale, "interaction-answered-elsewhere").text }
      : undefined;
  const approvals = new Map<string, Approval>();
  const questions = new Map<string, UserQuestionRequest>();
  const items: InteractionDockItem[] = [
    ...live.approvals.map((approval): InteractionDockItem => {
      const key = interactionKey(approval);
      approvals.set(key, approval);
      const model = approvalCardModel(approval, {
        locale,
        agent,
        workspacePath: currentWorkspace?.path,
        canStop,
      });
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
      return { kind: "approval", key, model, enabled: !notice && online && controlReady, notice };
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
        enabled: !notice && question.supported && online && controlReady,
        notice,
        answerContext: {
          sessionId: selected,
          bootId: access.bootId,
          expectedRevision: live.revision,
        },
      };
    }),
  ];
  return (
    <InteractionDock
      locale={locale}
      items={items}
      busy={busy}
      failure={
        fromCard && notice === "notDispatched"
          ? noticeReason
            ? codexReason(locale, noticeReason).text
            : t.sendFailed
          : undefined
      }
      vanished={vanished}
      focusKey={isInteraction(modal) ? interactionKey(modal) : undefined}
      onFocused={focused}
      onChoose={(item, choice) => {
        const approval = approvals.get(item.key);
        return choice.nativeDecision !== undefined
          ? control("approve", approval, undefined, undefined, undefined, {
              nativeDecision: choice.nativeDecision,
            })
          : control("approve", approval, choice.decision);
      }}
      onAnswer={(item, answers) =>
        control("answer", undefined, undefined, questions.get(item.key), answers)
      }
    />
  );
}
