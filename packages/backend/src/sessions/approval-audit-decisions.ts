import type {
  ManagedAgent,
  SessionApprovalAuditContext,
  SessionApprovalAuditDecision,
} from "@agentkib/runtime-protocol";
import { z } from "zod";
import type { SessionApprovalAuditStore } from "./approval-audit";
import { interactionEvidence } from "./interaction-evidence";
import { classifyInteractionRisk } from "./interaction-risk";

const sessionId = z.string().min(1).max(256);
const deviceId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_:-]+$/);
const requestId = z.string().uuid();
const decisionKind = z.enum(["allow", "deny", "cancel", "answer", "native"]);
const decisionScope = z.enum(["once", "session", "persistent", "unknown"]);

export const approvalAuditContextSchema = z.strictObject({
  source: z.strictObject({
    kind: z.enum(["desktop", "web", "phone"]),
    deviceId: deviceId.optional(),
    deviceName: z.string().max(80).optional(),
  }),
  risk: z
    .strictObject({
      level: z.enum(["high", "file-modification", "low"]),
      reason: z.string().min(1).max(64),
    })
    .optional(),
  decision: z.strictObject({ kind: decisionKind, scope: decisionScope }).optional(),
});

export const approvalAuditListSchema = z.strictObject({
  operation: z.literal("approval-audit-list"),
  before: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  workspaces: z
    .array(z.strictObject({ id: sessionId, path: z.string().min(1).max(4096) }))
    .max(10_000)
    .optional(),
});

export const expiredApprovalAuditSchema = z.strictObject({
  operation: z.literal("approval-audit-expired"),
  sessionId,
  requestId,
  deviceId,
  interactionKind: z.enum(["approval", "question"]),
  decision: z.string().min(1).max(256).optional(),
});

export const approvalAuditIdentitySchema = z.object({
  sessionId,
  requestId,
  deviceId: deviceId.optional(),
});

export type ApprovalAuditTarget = {
  agent: ManagedAgent;
  workspaceId?: string;
  workspacePath?: string;
};

export type ApprovalAuditOperation = "approve" | "answer";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ControlRequest = { sessionId: string; requestId: string; deviceId?: string };

export function isApprovalDecision(value: unknown): value is ApprovalAuditOperation {
  return value === "approve" || value === "answer";
}

function decisionOf(value: unknown): SessionApprovalAuditDecision {
  switch (value) {
    case "allow":
    case "accept":
    case "allow_once":
    case "grant-turn":
      return { kind: "allow", scope: "once" };
    case "acceptForSession":
    case "grant-session":
      return { kind: "allow", scope: "session" };
    case "allow_always":
    case "acceptWithExecpolicyAmendment":
      return { kind: "allow", scope: "persistent" };
    case "deny":
    case "decline":
    case "reject_once":
    case "deny-permissions":
      return { kind: "deny", scope: "once" };
    case "reject_always":
      return { kind: "deny", scope: "persistent" };
    case "cancel":
      return { kind: "cancel", scope: "once" };
  }
  const native = record(value);
  if (record(native?.acceptWithExecpolicyAmendment)) return { kind: "allow", scope: "persistent" };
  const network = record(record(native?.applyNetworkPolicyAmendment)?.network_policy_amendment);
  if (network?.action === "allow" || network?.action === "deny")
    return { kind: network.action, scope: "persistent" };
  return { kind: "native", scope: "unknown" };
}

function fixedApprovalAnswer(
  answers: unknown,
  interaction: Record<string, unknown> | undefined,
): SessionApprovalAuditDecision | undefined {
  if (
    interaction?.method !== "dsh/question" ||
    interaction.permissionIntent !== true ||
    !Array.isArray(interaction.questions)
  )
    return;
  const supplied = record(answers);
  let decision: SessionApprovalAuditDecision | undefined;
  for (const row of interaction.questions) {
    const question = record(row);
    if (typeof question?.id !== "string" || !Array.isArray(question.options)) continue;
    const options = question.options.map(record);
    if (!options.some((option) => option?.approvalKind !== undefined)) continue;
    const values =
      supplied && Object.hasOwn(supplied, question.id) ? supplied[question.id] : undefined;
    const matches =
      Array.isArray(values) && values.length === 1 && typeof values[0] === "string"
        ? options.filter((option) => option?.label === values[0])
        : [];
    const kind = matches[0]?.approvalKind;
    if (matches.some((option) => option?.approvalKind !== kind))
      return { kind: "native", scope: "unknown" };
    if (kind !== "allow_once" && kind !== "reject_once" && kind !== "allow_always")
      return { kind: "native", scope: "unknown" };
    const selected = decisionOf(kind);
    if (decision && (selected.kind !== decision.kind || selected.scope !== decision.scope))
      return { kind: "native", scope: "unknown" };
    decision = selected;
  }
  return decision;
}

export function approvalAuditDecision(
  operation: ApprovalAuditOperation,
  params: Record<string, unknown>,
  interaction?: Record<string, unknown>,
): SessionApprovalAuditDecision {
  if (operation === "answer")
    return fixedApprovalAnswer(params.answers, interaction) ?? { kind: "answer", scope: "once" };
  const choice = params.nativeDecision ?? params.decision;
  const acp = Array.isArray(interaction?.options)
    ? interaction.options.map(record).find((option) => option?.optionId === choice)
    : undefined;
  // An ACP option ID can be opaque. The kind in the snapshot is protocol-defined.
  const decision = decisionOf(acp?.kind ?? choice);
  if (decision.kind !== "native" || choice === undefined) return decision;
  const native = Array.isArray(interaction?.decisionOptions)
    ? interaction.decisionOptions
        .map(record)
        .find((option) =>
          option ? JSON.stringify(option.decision) === JSON.stringify(choice) : false,
        )
    : undefined;
  return native ? decisionOf(native.label) : decision;
}

const agentByMode: Readonly<Record<string, ManagedAgent>> = {
  "codex-managed": "codex",
  "codex-follower": "codex",
  "claude-managed": "claude-code",
  "claude-follower": "claude-code",
  "dsh-follower": "deepseek-harness",
  "devin-print": "devin",
  "acp-managed": "antigravity",
};

type AuditEvidence = Pick<SessionApprovalAuditContext, "risk" | "decision">;

/** Only the correlated native request, never the submitted answer or untrusted client fields. */
export async function approvalAuditEvidence(
  snapshot: unknown,
  request: Record<string, unknown>,
  workspaceRoot?: string,
): Promise<AuditEvidence> {
  const { operation } = request;
  if (!isApprovalDecision(operation)) return {};
  const state = record(snapshot);
  const mode = state?.executionMode;
  const agent =
    typeof mode === "string" && Object.hasOwn(agentByMode, mode) ? agentByMode[mode] : undefined;
  if (!state || !agent || (state.sessionId !== undefined && state.sessionId !== request.sessionId))
    return {};
  const nativeId = operation === "approve" ? request.approvalId : request.questionId;
  if (
    !(typeof nativeId === "string" && nativeId) &&
    !(typeof nativeId === "number" && Number.isSafeInteger(nativeId))
  )
    return {};
  const turnId = request.turnId;
  if (typeof turnId !== "string" || !turnId) return {};
  // DSH can publish a native approval without a numbered running turn.
  const dshUnnumberedTurn =
    agent === "deepseek-harness" && state.turnId === null && turnId === "dsh-turn-unknown";
  if (state.turnId !== undefined && state.turnId !== turnId && !dshUnnumberedTurn) return {};
  const items = operation === "approve" ? state.approvals : state.questions;
  const matching = Array.isArray(items)
    ? items
        .map(record)
        .filter((item) => item && item.requestId === nativeId && item.turnId === turnId)
    : [];
  if (matching.length !== 1 || !matching[0]) return {};
  return classifyAuditDecision(agent, operation, request, matching[0], workspaceRoot);
}

export async function classifyAuditDecision(
  agent: ManagedAgent,
  operation: ApprovalAuditOperation,
  request: Record<string, unknown>,
  interaction: Record<string, unknown>,
  workspaceRoot?: string,
): Promise<AuditEvidence> {
  const { riskInput, policyRiskInput } = interactionEvidence(
    agent,
    operation === "approve" ? "approval" : "question",
    interaction,
  );
  let risk = await classifyInteractionRisk(riskInput, workspaceRoot);
  if (policyRiskInput && risk.level !== "high") {
    const policyRisk = await classifyInteractionRisk(policyRiskInput, workspaceRoot);
    if (policyRisk.level !== "low") risk = policyRisk;
  }
  return { risk, decision: approvalAuditDecision(operation, request, interaction) };
}

const expiredReasons = new Set([
  "stale-boot",
  "stale-state",
  "stale-turn",
  "stale-revision",
  "interaction-answered-elsewhere",
  "interaction-expired",
]);

function isExpired(value: unknown): boolean {
  return typeof value === "string" && expiredReasons.has(value.replaceAll("_", "-"));
}

function controlOutcome(
  operation: ApprovalAuditOperation,
  request: ControlRequest,
  value: unknown,
): "accepted" | "denied" | "expired" | "unknown" {
  const response = record(value);
  const result = response?.operation === operation ? record(response.result) : response;
  if (
    !result ||
    result.requestId !== request.requestId ||
    (result.sessionId !== undefined && result.sessionId !== request.sessionId) ||
    result.controlOutcome === "unknown"
  )
    return "unknown";
  if (result.accepted === true) return "accepted";
  if (result.controlOutcome === "not-dispatched")
    return isExpired(result.reason ?? result.error) ? "expired" : "denied";
  return "unknown";
}

/** Record the person's decision, not the native tool's output or the text of an answer. */
export async function recordApprovalDecision<T>(
  audit: SessionApprovalAuditStore,
  operation: ApprovalAuditOperation,
  request: ControlRequest,
  target: ApprovalAuditTarget,
  metadata: SessionApprovalAuditContext,
  run: () => T,
): Promise<Awaited<T>> {
  const id = await beginDecision(audit, operation, request, target, metadata);
  try {
    const result = await run();
    if (id) {
      const outcome = controlOutcome(operation, request, result);
      if (outcome === "accepted")
        await audit
          .finishReceipt({
            agent: target.agent,
            ...request,
            deviceId: request.deviceId ?? metadata.source.deviceId,
            result: "accepted",
          })
          .catch(() => undefined);
      else if (outcome !== "unknown") await audit.finish(id, outcome).catch(() => undefined);
    }
    return result;
  } catch (error) {
    if (id && error instanceof Error && isExpired(error.message))
      await audit.finish(id, "expired").catch(() => undefined);
    throw error;
  }
}

/** A late bridge acknowledgement can settle a result left unknown by the original transport. */
export function approvalAuditReceipt(value: unknown) {
  const receipt = record(value);
  if (!receipt || receipt.found !== true || !isApprovalDecision(receipt.operation)) return;
  const identity = approvalAuditIdentitySchema.safeParse(receipt);
  if (!identity.success) return;
  if (receipt.status === "accepted") return { ...identity.data, result: "accepted" } as const;
  // A prepared receipt can look undispatched while a provider still owns the execution.
  const ack = record(receipt.ack);
  if (
    receipt.status === "not-dispatched" &&
    ack?.requestId === identity.data.requestId &&
    ack?.controlOutcome === "not-dispatched"
  )
    return {
      ...identity.data,
      result: isExpired(ack.reason ?? ack.error) ? "expired" : "denied",
    } as const;
}

export async function recordExpiredApproval(
  audit: SessionApprovalAuditStore,
  operation: ApprovalAuditOperation,
  request: ControlRequest,
  target: ApprovalAuditTarget,
  metadata: SessionApprovalAuditContext,
): Promise<void> {
  const id = await beginDecision(audit, operation, request, target, metadata);
  if (id) await audit.finish(id, "expired").catch(() => undefined);
}

function fallbackDecision(operation: ApprovalAuditOperation): SessionApprovalAuditDecision {
  return approvalAuditDecision(operation, {});
}

function beginDecision(
  audit: SessionApprovalAuditStore,
  operation: ApprovalAuditOperation,
  request: ControlRequest,
  target: ApprovalAuditTarget,
  metadata: SessionApprovalAuditContext,
) {
  const decision = metadata.decision ?? fallbackDecision(operation);
  const question = operation === "answer" && decision.kind === "answer";
  return audit
    .begin({
      ...target,
      sessionId: request.sessionId,
      requestId: request.requestId,
      kind: question ? "question" : "approval",
      risk:
        metadata.risk ??
        (question
          ? { level: "low", reason: "question" }
          : { level: "high", reason: "unknown-operation" }),
      decision,
      source: { ...metadata.source, deviceId: request.deviceId ?? metadata.source.deviceId },
    })
    .catch(() => undefined);
}
