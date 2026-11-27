import {
  REMOTE_ERROR_CODES,
  REMOTE_WORKER_ROLE_CONTRACT,
  type WorkerRole,
  type WorkerRoleInput,
} from "@agentkib/runtime-protocol";
import type { Lane, Lead } from "./orchestration-registry";

const { input } = REMOTE_WORKER_ROLE_CONTRACT;

function workerRoleInput(value: unknown): WorkerRoleInput | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(REMOTE_ERROR_CODES.invalidInput);
  const record = value as Record<string, unknown>;
  const { label, description } = record;
  if (
    Object.keys(record).some((key) => !Object.hasOwn(input.properties, key)) ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > input.properties.label.maxLength ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(label) ||
    typeof description !== "string" ||
    !description.trim() ||
    description.length > input.properties.description.maxLength ||
    description.includes("\0")
  )
    throw new Error(REMOTE_ERROR_CODES.invalidInput);
  return { label: label.trim(), description: description.trim() };
}

/** Role metadata is independent of the provider's model settings. */
export function assertWorkerRoleToolInput(value: Record<string, unknown>): void {
  if (Object.keys(value).some((key) => key !== "worker" && key !== "role"))
    throw new Error(REMOTE_ERROR_CODES.invalidInput);
}

export function applyWorkerRole(
  lead: Lead,
  lane: Lane,
  value: unknown,
  updatedBy: WorkerRole["updatedBy"],
): WorkerRole | null {
  const input = workerRoleInput(value);
  if (input === null && !lane.role) return null;
  if (input && input.label === lane.role?.label && input.description === lane.role.description)
    return lane.role;
  const updatedAt = new Date().toISOString();
  if (input) lane.role = { ...input, updatedBy, updatedAt };
  else delete lane.role;
  lead.records.push({
    at: updatedAt,
    kind: "worker-role",
    laneId: lane.id,
    requestId: null,
    outcome: input ? "updated" : "cleared",
    roleChange: {
      workerSessionId: lane.sessionId,
      roleLabel: input?.label ?? null,
      updatedBy,
      updatedAt,
    },
  });
  return lane.role ?? null;
}

export function workerTaskWithRole(body: string, role: WorkerRole | undefined): string {
  return role
    ? `Worker role: ${JSON.stringify(role.label)}\n${role.description}\n\nTask from your Project Agent:\n${body}`
    : body;
}
