import type { SessionPlanProgress, SessionPlanStep } from "@agentkib/runtime-protocol";

const MAX_STEPS = 64;
const MAX_STEP_TEXT = 512;

export function projectSessionPlanProgress(
  turnId: unknown,
  steps: Iterable<{ text: unknown; status: unknown; id?: unknown }>,
): SessionPlanProgress | undefined {
  if (typeof turnId !== "string" || !turnId.trim() || turnId.length > 256) return;
  const projected: SessionPlanStep[] = [];
  const seen = new Set<string>();
  let ordinal = 0;
  let truncated = false;
  for (const step of steps) {
    if (++ordinal > MAX_STEPS) {
      truncated = true;
      break;
    }
    const status = step.status === "inProgress" ? "in_progress" : step.status;
    if (
      (status !== "pending" && status !== "in_progress" && status !== "completed") ||
      typeof step.text !== "string" ||
      !step.text.trim()
    ) {
      truncated = true;
      continue;
    }
    const nativeId =
      typeof step.id === "string" && step.id.trim() && step.id.length <= 128
        ? `native:${step.id}`
        : undefined;
    const id = nativeId && !seen.has(nativeId) ? nativeId : `step:${ordinal}`;
    seen.add(id);
    if (step.text.length > MAX_STEP_TEXT) truncated = true;
    projected.push({ id, text: step.text.slice(0, MAX_STEP_TEXT), status });
  }
  if (!projected.length && truncated) return;
  const current = projected.filter((step) => step.status === "in_progress");
  return {
    turnId,
    steps: projected,
    currentStepId: !truncated && current.length === 1 ? current[0]!.id : null,
    ...(truncated ? { truncated: true } : {}),
  };
}
