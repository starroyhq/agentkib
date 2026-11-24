import { z } from "zod";
import { DEVIN_PERMISSION_MODES } from "../agents/devin/devin-managed-runner";
import { historyReferenceSchema, validHistoryControl } from "../history-control-schema";
import { admitControlReceipt } from "./control-receipts";
import { ANTIGRAVITY_PERMISSION_MODES } from "./validate/antigravity";

const managedControlFields = z
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
    ownerWaitOnly: z.literal(true).optional(),
    allowOwnerWait: z.literal(true).optional(),
    model: z.string().min(1).max(256).optional(),
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
  .strict();

function controlSchemaFor<Mode extends string>(modes: readonly [Mode, ...Mode[]]) {
  return managedControlFields
    .extend({ permissionMode: z.enum(modes).optional() })
    .refine(validHistoryControl)
    .refine((request) => !request.ownerWaitOnly || request.operation === "queue-delete")
    .refine((request) => !request.allowOwnerWait || request.operation === "send")
    .refine(
      (request) => request.operation === "settings" || request.expectedSettingsScope === undefined,
    )
    .refine(
      (request) =>
        request.operation === "settings" ||
        (request.effort !== null && request.serviceTier !== null),
    );
}

export const managedControlSchema = controlSchemaFor(DEVIN_PERMISSION_MODES);
export const antigravityManagedControlSchema = controlSchemaFor(ANTIGRAVITY_PERMISSION_MODES);

export type ManagedControlRequest = z.infer<typeof managedControlFields>;

export type ApplyManagedControl<Request = z.infer<typeof managedControlSchema>> = (
  request: Request,
  fingerprint: string,
) => Promise<unknown>;

type ControlAdmissionContext = {
  dataDir: string;
  controlSessions: Map<string, { count: number; observed: boolean }>;
  isSessionObserved(sessionId: string): boolean | undefined;
  runnerForSession(sessionId: string): { observed: boolean } | undefined;
};

export async function admitManagedControl<Request extends ManagedControlRequest>(
  context: ControlAdmissionContext,
  value: unknown,
  schema: { parse(value: unknown): Request },
  execute: ApplyManagedControl<Request>,
): Promise<unknown> {
  const request = schema.parse(value);
  const id = request.sessionId;
  const admission = context.controlSessions.get(id) ?? { count: 0, observed: false };
  admission.count += 1;
  admission.observed ||= context.isSessionObserved(id) === true;
  context.controlSessions.set(id, admission);
  const runner = context.runnerForSession(id);
  if (runner && admission.observed) runner.observed = true;
  try {
    const { previous, fingerprint } = admitControlReceipt(
      context.dataDir,
      request.requestId,
      stableJson(value),
    );
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
