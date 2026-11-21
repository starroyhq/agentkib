import { createHash } from "node:crypto";
import { z } from "zod";
import { DEVIN_PERMISSION_MODES } from "../agents/devin/devin-managed-runner";
import { historyReferenceSchema, validHistoryControl } from "../history-control-schema";
import { replayManagedCommand } from "../managed-ledger";

export const managedControlSchema = z
  .object({
    operation: z.enum([
      "send",
      "stop",
      "approve",
      "answer",
      "steer",
      "queue-add",
      "queue-update",
      "queue-delete",
      "queue-reorder",
      "rename",
      "archive",
      "settings",
      "goal-set",
      "goal-pause",
      "goal-resume",
      "goal-clear",
      "fork",
      "compact",
      "terminals-clean",
      "usage-limit-cancel",
      "usage-limit-continue",
    ]),
    sessionId: z.string().min(1).max(256),
    requestId: z.string().uuid(),
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .optional(),
    runtimeBootId: z.string().min(1).max(256),
    expectedRevision: z.number().int().nonnegative(),
    experimentalEnabled: z.boolean(),
    turnId: z.string().min(1).max(256).optional(),
    text: z
      .string()
      .max(128 * 1024)
      .optional(),
    input: z.array(z.unknown()).max(11).optional(),
    historyReferences: z.array(historyReferenceSchema).max(5).optional(),
    historyInputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    resourceRefs: z
      .array(
        z
          .object({
            kind: z.string(),
            id: z.string().optional(),
            relativePath: z.string().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    approvalId: z.union([z.string().min(1).max(256), z.number().safe().nonnegative()]).optional(),
    questionId: z.union([z.string().min(1).max(256), z.number().safe().nonnegative()]).optional(),
    decision: z.string().max(256).optional(),
    nativeDecision: z.unknown().optional(),
    answers: z.record(z.string(), z.array(z.string().max(8192))).optional(),
    name: z.string().max(256).optional(),
    queuedSubmissionId: z.string().min(1).max(256).optional(),
    queuedSubmissionIds: z.array(z.string().min(1).max(256)).max(100).optional(),
    model: z.string().min(1).max(256).optional(),
    /** Devin: the permission mode its next turns run with. */
    permissionMode: z.enum(DEVIN_PERMISSION_MODES).optional(),
    effort: z.string().min(1).max(64).nullable().optional(),
    serviceTier: z.string().min(1).max(128).nullable().optional(),
    mode: z.string().min(1).max(128).nullable().optional(),
    policyId: z
      .enum(["workspace-write-on-request", "full-access-on-request", "workspace-write-auto-review"])
      .optional(),
    resetDefaults: z.boolean().optional(),
    expectedSettingsScope: z.string().uuid().optional(),
    goal: z.unknown().optional(),
  })
  .strict()
  .refine(validHistoryControl)
  .refine(
    (request) => request.operation === "settings" || request.expectedSettingsScope === undefined,
  )
  .refine(
    (request) =>
      request.operation === "settings" || (request.effort !== null && request.serviceTier !== null),
  );

export type ApplyManagedControl = (
  request: z.infer<typeof managedControlSchema>,
  fingerprint: string,
) => Promise<unknown>;

type ControlAdmissionContext = {
  dataDir: string;
  controlSessions: Map<string, { count: number; observed: boolean }>;
  isSessionObserved(sessionId: string): boolean | undefined;
  runnerForSession(sessionId: string): { observed: boolean } | undefined;
};

export async function admitManagedControl(
  context: ControlAdmissionContext,
  value: unknown,
  execute: ApplyManagedControl,
): Promise<unknown> {
  const request = managedControlSchema.parse(value);
  const id = request.sessionId;
  const admission = context.controlSessions.get(id) ?? { count: 0, observed: false };
  admission.count += 1;
  admission.observed ||= context.isSessionObserved(id) === true;
  context.controlSessions.set(id, admission);
  const runner = context.runnerForSession(id);
  if (runner && admission.observed) runner.observed = true;
  try {
    const fingerprint = createHash("sha256").update(stableJson(value)).digest("hex");
    const previous = replayManagedCommand(context.dataDir, request.requestId, fingerprint);
    return previous ?? (await execute(request, fingerprint));
  } finally {
    const current = context.runnerForSession(id);
    if (current && admission.observed) current.observed = true;
    admission.count -= 1;
    if (admission.count === 0) context.controlSessions.delete(id);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
