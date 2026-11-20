import { useCallback, useMemo, useRef, useState } from "react";
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
  authority?: unknown;
  value: NewSessionGoalDraft;
  stage: "first-message" | "ready" | "draft";
  afterRevision?: number;
};

export function useNewSessionGoalDraft(sessionId: string, authority?: unknown) {
  // Late callbacks from another host or visit cannot replace this visit's local goal.
  const scope = useMemo(() => ({ sessionId, authority }), [sessionId, authority]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [goal, setGoal] = useState<StartupGoal>();
  const current = goal?.sessionId === sessionId && goal.authority === authority ? goal : undefined;

  const stage = useCallback(
    (value: NewSessionGoalDraft) => {
      if (activeScope.current === scope)
        setGoal({ sessionId, authority, value, stage: "first-message" });
    },
    [sessionId, authority, scope],
  );

  const load = useCallback(
    (draft: NewSessionDraft, submit: boolean) => {
      if (!draft.goal || activeScope.current !== scope) return;
      const hasMessage = !!draft.text.trim() || draft.files.length > 0;
      setGoal({
        sessionId,
        authority,
        value: draft.goal,
        stage: !submit ? "draft" : hasMessage ? "first-message" : "ready",
      });
    },
    [sessionId, authority, scope],
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
        previous?.sessionId !== sessionId || previous.authority !== authority
          ? previous
          : applied
            ? undefined
            : { ...previous, stage: "draft" },
      ),
    [sessionId, authority],
  );
  const discard = useCallback(() => {
    setGoal((previous) =>
      previous?.sessionId === sessionId && previous.authority === authority ? undefined : previous,
    );
  }, [sessionId, authority]);

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
