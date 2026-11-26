import { useCallback } from "react";
import type { Access, Approval, Decision, Live, UserQuestionRequest } from "@agentkib/web-client";
import { sessionApprovalRuntime } from "./agents/session-approvals";
import { resolveSessionProvider, sessionProviderControlsDisabled } from "./session-provider";
import { InteractionDock, type InteractionNotice } from "./interaction-card";
import { interactionKey, sessionInteractionItems } from "./interaction-items";
import { interactionCardCopy, type InteractionLocale } from "./interaction-model";
import type { SessionOutcomeControls } from "./conversation/sessions/session-outcome-action";

interface SessionInteractionState extends SessionOutcomeControls {
  current?: Parameters<typeof resolveSessionProvider>[0];
  capabilities?: Parameters<typeof resolveSessionProvider>[1];
  live?: Live | null;
  access?: Access | null;
  online: boolean;
  controlReady: boolean;
  busy: boolean;
  notice?: string;
  noticeReason?: string;
  noticeSource?: string;
  locale: InteractionLocale;
  selected: string;
  currentWorkspace?: { path?: string };
  modal?: unknown;
  setModal: (modal: undefined) => void;
  canStop: boolean;
  control: (
    kind: "approve" | "answer",
    approval?: Approval,
    decision?: Decision,
    question?: UserQuestionRequest,
    answers?: Record<string, string[]>,
    extra?: { nativeDecision?: unknown },
  ) => unknown;
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
export function SessionInteractionDock({
  session,
  agent,
  explainReason,
}: {
  session: SessionInteractionState;
  agent: string;
  explainReason: (reason: string) => string;
}) {
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
    currentWorkspace,
    canStop,
  } = session;
  const focused = useCallback(() => setModal(undefined), [setModal]);
  if (!live || live.sessionId !== selected || !access) return null;
  const t = interactionCardCopy(locale);
  const providerDisabled = sessionProviderControlsDisabled(
    access,
    session.current?.id === selected ? session.current.agent : undefined,
    live.reason,
  );
  const fromCard = noticeSource === "approve" || noticeSource === "answer";
  const uncertain =
    (fromCard && notice === "uncertain" && !session.blocksOutcome) ||
    live.status === "outcome-unknown" ||
    live.reason === "control-outcome-unconfirmed";
  const connection = resolveSessionProvider(session.current, session.capabilities)?.connection
    ?.kind;
  const native = sessionApprovalRuntime(live, connection);
  const external =
    live.executionLocation === "external" ||
    (live.executionLocation === undefined &&
      live.execution?.owner === "external" &&
      live.execution.observed &&
      live.execution.confidence === "live");
  const vanished: InteractionNotice | undefined =
    !busy && native?.reportsWithdrawn && external
      ? { tone: "done", text: explainReason("interaction-answered-elsewhere") }
      : undefined;
  const { items, approvals, questions } = sessionInteractionItems(live, access, {
    locale,
    sessionId: selected,
    agent,
    workspacePath: currentWorkspace?.path,
    connection,
    canStop: canStop && !providerDisabled,
    ready: online && controlReady && !providerDisabled,
    blocked: session.blocksOutcome,
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
            ? explainReason(noticeReason)
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
