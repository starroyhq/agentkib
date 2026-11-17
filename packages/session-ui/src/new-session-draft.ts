import { useCallback, useState } from "react";
import type { CodexContextResource } from "@agentkib/web-client";

export type NewSessionGoalDraft = { objective: string; tokenBudget?: number };

export function parseGoalDraft(objective: string, budget: string): NewSessionGoalDraft | undefined {
  const text = objective.trim();
  const tokenBudget = budget ? Number(budget) : undefined;
  if (
    !text ||
    new TextEncoder().encode(text).length > 16 * 1024 ||
    (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
  )
    return undefined;
  return { objective: text, ...(tokenBudget === undefined ? {} : { tokenBudget }) };
}

export interface NewSessionDraft {
  text: string;
  files: File[];
  resources?: CodexContextResource[];
  goal?: NewSessionGoalDraft;
}

type StartupGoal = {
  sessionId: string;
  value: NewSessionGoalDraft;
  stage: "first-message" | "ready" | "draft";
  afterRevision?: number;
};

export function useNewSessionGoalDraft(sessionId: string) {
  const [goal, setGoal] = useState<StartupGoal>();
  const current = goal?.sessionId === sessionId ? goal : undefined;

  const stage = useCallback(
    (value: NewSessionGoalDraft) => setGoal({ sessionId, value, stage: "first-message" }),
    [sessionId],
  );

  const load = useCallback(
    (draft: NewSessionDraft, submit: boolean) => {
      if (!draft.goal) return;
      const hasMessage = !!draft.text.trim() || draft.files.length > 0;
      setGoal({
        sessionId,
        value: draft.goal,
        stage: !submit ? "draft" : hasMessage ? "first-message" : "ready",
      });
    },
    [sessionId],
  );
  const confirmFirstMessage = (revision?: number | null) => {
    if (current?.stage !== "first-message") return;
    setGoal((previous) =>
      previous === current
        ? { ...previous, stage: "ready", afterRevision: revision ?? undefined }
        : previous,
    );
  };
  const handled = useCallback(
    (applied: boolean) =>
      setGoal((previous) =>
        previous?.sessionId !== sessionId
          ? previous
          : applied
            ? undefined
            : { ...previous, stage: "draft" },
      ),
    [sessionId],
  );
  const discard = useCallback(() => {
    setGoal((previous) => (previous?.sessionId === sessionId ? undefined : previous));
  }, [sessionId]);

  return {
    value: current
      ? {
          value: current.value,
          apply: current.stage === "ready",
          afterRevision: current.afterRevision,
        }
      : undefined,
    load,
    stage,
    confirmFirstMessage,
    handled,
    discard,
  };
}
