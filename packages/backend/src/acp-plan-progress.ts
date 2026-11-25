import type { SessionPlanProgress } from "@agentkib/runtime-protocol";
import { projectSessionPlanProgress } from "./session-plan-progress";

function* acpPlanEntries(entries: unknown[]) {
  for (const entry of entries) {
    const record =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
    yield { text: record?.content, status: record?.status };
  }
}

/** ACP reports a replacement list for the currently active prompt. */
export function acpPlanUpdate(
  update: Record<string, unknown>,
  turnId: string,
  previous: SessionPlanProgress | null,
): SessionPlanProgress | undefined {
  if (update.sessionUpdate !== "plan" || !Array.isArray(update.entries)) return;
  const plan = projectSessionPlanProgress(turnId, acpPlanEntries(update.entries));
  if (plan && JSON.stringify(plan) !== JSON.stringify(previous)) return plan;
}
