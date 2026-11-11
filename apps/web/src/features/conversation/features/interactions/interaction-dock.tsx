import { useCallback } from "react";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import { agentName } from "@agentkib/agent-identity";
import {
  interactionCardCopy,
  InteractionDock,
  interactionKey,
  sessionInteractionItems,
  type InteractionNotice,
} from "@agentkib/session-ui";
import { codexReason } from "../sessions/codex-copy";
import { useSession } from "../sessions/session-context";

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
  const fromCard = noticeSource === "approve" || noticeSource === "answer";
  const uncertain =
    (fromCard && notice === "uncertain") ||
    live.status === "outcome-unknown" ||
    live.reason === "control-outcome-unconfirmed";
  // DeepSeek Harness withdraws a request as soon as either side answers it, so one that leaves a
  // connected session without an answer from here was answered there.
  const vanished: InteractionNotice | undefined =
    !busy && live.executionMode === "dsh-follower" && live.executionLocation === "external"
      ? { tone: "done", text: codexReason(locale, "interaction-answered-elsewhere", "web").text }
      : undefined;
  const { items, approvals, questions } = sessionInteractionItems(live, access, {
    locale,
    sessionId: selected,
    agent,
    workspacePath: currentWorkspace?.path,
    canStop,
    ready: online && controlReady,
    uncertain,
  });
  return (
    <InteractionDock
      locale={locale}
      items={items}
      busy={busy}
      failure={
        fromCard && notice === "notDispatched"
          ? noticeReason
            ? codexReason(locale, noticeReason, "web").text
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
