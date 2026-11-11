import { useCallback, useEffect, useState } from "react";
import type { InteractionReply, Live } from "@agentkib/web-client";
import { agentName } from "@agentkib/agent-identity";
import {
  answerRequestBody,
  homeSessionCopy,
  interactionCardCopy,
  InteractionDock,
  sessionInteractionItems,
} from "@agentkib/session-ui";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";
import type { HomeReplies } from "./home-replies";

/**
 * A waiting approval or question opened in its home row: the session view's card, answered
 * through the same checks. Once nothing waits the row folds; a decision whose outcome is unknown
 * folds it too, and the row then asks the person to verify the result. While the connection is
 * lost the card only shows the request.
 */
export function HomeInteraction({
  session,
  workspacePath,
  replies,
  offline,
  onClose,
}: {
  session: { id: string; agent: string };
  workspacePath?: string;
  replies: HomeReplies;
  offline: boolean;
  onClose: () => void;
}) {
  const { locale, client, access } = useSession();
  const copy = homeSessionCopy(locale);
  const t = interactionCardCopy(locale);
  const [live, setLive] = useState<Live>();
  const [state, setState] = useState<"loading" | "ready" | "gone" | "failed">("loading");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await client.live(session.id, signal);
        if (signal?.aborted) return undefined;
        setLive(value);
        setState(value.approvals.length || value.questions?.length ? "ready" : "gone");
        return value;
      } catch {
        if (!signal?.aborted) setState("failed");
        return undefined;
      }
    },
    [client, session.id],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state === "loading" || (state === "ready" && !access))
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {copy.loadingRequest}
      </p>
    );
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
    // Stopping the turn stays in the session view's composer.
    canStop: false,
    ready: !busy && !offline,
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
          ? codexReason(locale, result.reason.replaceAll("_", "-"), "web")
          : undefined;
      setFailure(reason && !reason.technical ? reason.text : t.sendFailed);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {offline && (
        <p role="status" className="text-xs text-muted-foreground">
          {copy.disconnected}
        </p>
      )}
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
        onAnswer={(item, answers) => {
          const question = questions.get(item.key);
          if (!question) return false;
          return send({
            kind: "answer",
            question,
            body: (context, requestId) => answerRequestBody(question, answers, context, requestId),
          });
        }}
      />
    </>
  );
}
