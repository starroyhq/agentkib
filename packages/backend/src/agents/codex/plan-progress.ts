import { projectSessionPlanProgress } from "../../session-plan-progress";

export function codexPlanProgress(turnId: unknown, steps: unknown) {
  if (!Array.isArray(steps)) return;
  return projectSessionPlanProgress(
    turnId,
    (function* () {
      for (const value of steps as unknown[]) {
        const step =
          value && typeof value === "object"
            ? (value as { step?: unknown; status?: unknown })
            : undefined;
        yield { text: step?.step, status: step?.status };
      }
    })(),
  );
}
