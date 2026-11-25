import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  PushApprovalAction,
  SessionInteractionQuestion,
  SessionPendingInteraction,
} from "@agentkib/runtime-protocol";

export const PUSH_APPROVAL_LIFETIME_MS = 10 * 60_000;
const INTERACTION_BUDGET = 2_000;

export interface PushInteractionProjection {
  interaction: SessionPendingInteraction;
  action?: PushApprovalAction;
}

type ApprovalBinding = SessionPendingInteraction["binding"];

function hasControlText(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function identifier(value: unknown, limit = 256): value is string {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    Buffer.byteLength(value) <= limit &&
    value.trim().length > 0 &&
    !hasControlText(value)
  );
}

function nativeId(value: unknown): value is ApprovalBinding["requestId"] {
  return identifier(value) || (typeof value === "number" && Number.isSafeInteger(value));
}

function validBinding(binding: ApprovalBinding): boolean {
  return (
    identifier(binding.sessionId) &&
    identifier(binding.runtimeBootId) &&
    identifier(binding.turnId) &&
    nativeId(binding.requestId) &&
    Number.isSafeInteger(binding.revision) &&
    binding.revision >= 0
  );
}

function receiptId(deviceId: string, binding: ApprovalBinding): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "agentkib-push-receipt-v1",
        deviceId,
        binding.sessionId,
        binding.runtimeBootId,
        binding.turnId,
        binding.requestId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  // A deterministic UUIDv8 uses application-defined bits and the RFC variant.
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function actionInput(
  deviceId: string,
  bootId: string,
  binding: ApprovalBinding,
  decisionId: string,
  requestId: string,
  expiresAt: number,
  subscriptionUpdatedAt: number | undefined,
): string {
  return JSON.stringify([
    "agentkib-push-approval-v1",
    deviceId,
    bootId,
    binding.sessionId,
    binding.runtimeBootId,
    binding.turnId,
    binding.requestId,
    binding.revision,
    decisionId,
    requestId,
    expiresAt,
    subscriptionUpdatedAt ?? null,
  ]);
}

function clipText(value: string | undefined, bytes: number): string | undefined {
  if (!value) return;
  let output = "";
  let used = 0;
  // Notification descriptions are shown as a single line of untrusted text.
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  if (Buffer.byteLength(clean) <= bytes) return clean || undefined;
  const limit = bytes - Buffer.byteLength("…");
  for (const point of clean) {
    const size = Buffer.byteLength(point);
    if (used + size > limit) break;
    output += point;
    used += size;
  }
  return output.trimEnd() + "…";
}

function displayCommand(
  command: SessionPendingInteraction["command"],
): SessionPendingInteraction["command"] {
  if (typeof command !== "string" && !Array.isArray(command)) return;
  const parts = typeof command === "string" ? [command] : command;
  if (!parts.length || parts.length > 16) return;
  if (parts.some((part) => typeof part !== "string" || hasControlText(part))) return;
  if (!parts[0]?.trim()) return;
  // A partial command can make a dangerous request appear to do something else.
  if (Buffer.byteLength(JSON.stringify(command)) <= 280) return command;
}

function pushQuestions(
  questions: SessionPendingInteraction["questions"],
): SessionPendingInteraction["questions"] {
  if (!questions?.length || questions.length > 3) return;
  const result: SessionInteractionQuestion[] = [];
  for (const question of questions) {
    if (
      !identifier(question.id, 96) ||
      !identifier(question.question, 256) ||
      question.options.length > 5 ||
      question.options.some(({ label }) => !identifier(label, 96))
    )
      return;
    const header = clipText(question.header, 80);
    result.push({
      id: question.id,
      question: question.question,
      options: question.options.map(({ label }) => ({ label })),
      multiSelect: question.multiSelect,
      allowCustom: question.allowCustom,
      ...(header ? { header } : {}),
      ...(question.isSecret ? { isSecret: true } : {}),
      ...(question.secret ? { secret: true } : {}),
    });
  }
  return result;
}

function withinBudget(value: PushInteractionProjection, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= maxBytes;
}

/** Mints notification choices without granting control or storing tokens on the host. */
export class PushApprovalActions {
  readonly #key = randomBytes(32);
  readonly #now: () => number;

  constructor({ now = Date.now }: { now?: () => number } = {}) {
    this.#now = now;
  }

  project(
    interaction: SessionPendingInteraction,
    deviceId: string,
    bootId: string,
    maxBytes = INTERACTION_BUDGET,
    subscriptionUpdatedAt?: number,
  ): PushInteractionProjection | undefined {
    const { binding, kind, risk } = interaction;
    if (
      !validBinding(binding) ||
      !identifier(deviceId) ||
      !identifier(bootId) ||
      (subscriptionUpdatedAt !== undefined && !Number.isSafeInteger(subscriptionUpdatedAt))
    )
      return;
    const decisions = interaction.decisions
      .filter(({ id }) => identifier(id, 512))
      .map((decision) => {
        const { id, kind, scope, available, lockScreen } = decision;
        const label = clipText(decision.label, 96);
        return { id, kind, scope, available, lockScreen, ...(label ? { label } : {}) };
      });
    const summary = clipText(interaction.summary, 240);
    const toolName = clipText(interaction.toolName, 96);
    const command = displayCommand(interaction.command);
    const questions = kind === "question" ? pushQuestions(interaction.questions) : undefined;
    const core: SessionPendingInteraction = {
      version: 1,
      kind,
      binding: {
        sessionId: binding.sessionId,
        runtimeBootId: binding.runtimeBootId,
        turnId: binding.turnId,
        requestId: binding.requestId,
        revision: binding.revision,
      },
      risk: { level: risk.level, reason: risk.reason },
      decisions,
    };
    const description = {
      ...(summary ? { summary } : {}),
      ...(toolName ? { toolName } : {}),
      ...(command ? { command } : {}),
      ...(questions ? { questions } : {}),
    };
    const described: PushInteractionProjection = { interaction: { ...core, ...description } };

    // The user must be able to see a reported command in full before acting from the notification.
    const canOfferAction =
      kind === "approval" && (interaction.command === undefined || command !== undefined);
    const available = canOfferAction ? decisions.filter((decision) => decision.available) : [];
    if (available.length) {
      const requestId = receiptId(deviceId, binding);
      const expiresAt = this.#now() + PUSH_APPROVAL_LIFETIME_MS;
      const choices = Object.fromEntries(
        available.map(({ id }) => {
          const signature = createHmac("sha256", this.#key)
            .update(
              actionInput(
                deviceId,
                bootId,
                binding,
                id,
                requestId,
                expiresAt,
                subscriptionUpdatedAt,
              ),
            )
            .digest("base64url");
          return [id, `${expiresAt.toString(36)}.${signature}`];
        }),
      );
      const offered = { ...described, action: { bootId, requestId, expiresAt, choices } };
      if (withinBudget(offered, maxBytes)) return offered;
      // Preserve exact command text when sent. If the alert cannot fit, open the live card instead.
    }
    if (withinBudget(described, maxBytes)) return described;
    const condensed = { interaction: { ...core, decisions: [], ...(summary ? { summary } : {}) } };
    return withinBudget(condensed, maxBytes) ? condensed : undefined;
  }

  /** Verify exact request binding before deciding whether it can dispatch or only reconcile. */
  verify(
    deviceId: string,
    body: Record<string, unknown>,
    subscriptionUpdatedAt?: number,
  ): { expiresAt: number } | undefined {
    const {
      bootId,
      sessionId,
      interactionRuntimeBootId,
      turnId,
      approvalId,
      expectedRevision,
      interactionDecisionId,
      requestId,
      pushActionToken,
    } = body;
    if (
      !identifier(deviceId) ||
      !identifier(bootId) ||
      !identifier(sessionId) ||
      !identifier(interactionRuntimeBootId) ||
      !identifier(turnId) ||
      !nativeId(approvalId) ||
      typeof expectedRevision !== "number" ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !identifier(interactionDecisionId, 512) ||
      !identifier(requestId, 36) ||
      (subscriptionUpdatedAt !== undefined && !Number.isSafeInteger(subscriptionUpdatedAt)) ||
      typeof pushActionToken !== "string" ||
      pushActionToken.length > 58
    )
      return;
    const token = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/.exec(pushActionToken);
    if (!token) return;
    const expiresAt = Number.parseInt(token[1]!, 36);
    if (expiresAt <= 0 || !Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== token[1])
      return;
    const signature = Buffer.from(token[2]!, "base64url");
    if (signature.toString("base64url") !== token[2]) return;
    const binding = {
      sessionId,
      runtimeBootId: interactionRuntimeBootId,
      turnId,
      requestId: approvalId,
      revision: expectedRevision,
    };
    if (requestId !== receiptId(deviceId, binding)) return;
    const expected = createHmac("sha256", this.#key)
      .update(
        actionInput(
          deviceId,
          bootId,
          binding,
          interactionDecisionId,
          requestId,
          expiresAt,
          subscriptionUpdatedAt,
        ),
      )
      .digest();
    return timingSafeEqual(expected, signature) ? { expiresAt } : undefined;
  }
}
