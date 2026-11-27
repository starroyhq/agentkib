import { useCallback, useEffect, useState } from "react";
import { sessionProviderDeclaration, type InteractionReply, type Live } from "@agentkib/web-client";
import { agentName } from "@agentkib/agent-identity";
import {
  answerRequestBody,
  homeSessionCopy,
  interactionCardCopy,
  InteractionDock,
  LoadingSkeleton,
  sessionInteractionItems,
} from "@agentkib/session-ui";
import { useI18n } from "@/core/useI18n";
import { sessionReason } from "@/features/sessions/conversation/session-copy";
import type { HomeReplies } from "./home-replies";

/**
 * A waiting approval or question opened in its home row: the session view's card, answered
 * through the same checks. Once nothing waits the row folds; a decision whose outcome is unknown
 * folds it too, and the row then asks the person to verify the result.
 */
export function HomeInteraction({
  session,
  workspacePath,
  replies,
  onClose,
}: {
  session: { id: string; agent: string };
  workspacePath?: string;
  replies: HomeReplies;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const copy = homeSessionCopy(locale);
  const t = interactionCardCopy(locale);
  const [live, setLive] = useState<Live>();
  const [state, setState] = useState<"loading" | "ready" | "gone" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const { client, access } = replies;
  // Read again after a decision, to see whether anything else waits.
  const load = useCallback(async () => {
    try {
      const value = await client.live(session.id);
      setLive(value);
      setState(value.approvals.length || value.questions?.length ? "ready" : "gone");
      return value;
    } catch {
      setState("failed");
      return undefined;
    }
  }, [client, session.id]);
  useEffect(() => {
    const controller = new AbortController();
    client.live(session.id, controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setLive(value);
        setState(value.approvals.length || value.questions?.length ? "ready" : "gone");
      },
      () => {
        if (!controller.signal.aborted) setState("failed");
      },
    );
    return () => controller.abort();
  }, [client, session.id]);

  if (state === "loading" || (state === "ready" && !access))
    return <LoadingSkeleton label={copy.loadingRequest} />;
  if (state !== "ready" || !live || !access)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {state === "failed" ? copy.readFailed : copy.requestGone}
      </p>
    );

  const { items, approvals, questions } = sessionInteractionItems(live, access, {
    locale,
    sessionId: session.id,
    agent: agentName(session.agent),
    workspacePath,
    connection: sessionProviderDeclaration(session.agent)?.connection?.kind,
    // Stopping the turn stays in the session view's composer.
    canStop: false,
    ready: !busy,
    uncertain: false,
  });
  const send = async (reply: InteractionReply) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await replies.reply(session, reply);
      if (result.status === "accepted") {
        const next = await load();
        if (!next?.approvals.length && !next?.questions?.length) {
          replies.markAnswered(session.id);
          onClose();
        }
        return true;
      }
      if (result.status === "unknown") {
        onClose();
        return false;
      }
      if (result.status === "gone") {
        await load();
        setFailure(copy.requestGone);
        return false;
      }
      const reason =
        result.status === "not-dispatched"
          ? sessionReason(locale, result.reason.replaceAll("_", "-"))
          : undefined;
      setFailure(reason && !reason.technical ? reason.text : t.sendFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <InteractionDock
      locale={locale}
      items={items}
      busy={busy}
      failure={failure}
      onDismiss={onClose}
      onChoose={(item, choice) => {
        const approval = approvals.get(item.key);
        if (!approval) return false;
        if (choice.nativeDecision !== undefined)
          return send({ kind: "approve", approval, nativeDecision: choice.nativeDecision });
        return choice.decision === undefined
          ? false
          : send({ kind: "approve", approval, decision: choice.decision });
      }}
      onAnswer={(item, answers, answerNotes) => {
        const question = questions.get(item.key);
        if (!question) return false;
        return send({
          kind: "answer",
          question,
          body: (context, requestId) =>
            answerRequestBody(question, answers, context, requestId, answerNotes),
        });
      }}
    />
  );
}
