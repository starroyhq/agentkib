import {
  sessionProviderDeclaration,
  type LiveSessionAgent,
  type SessionInteractionDecision,
  type SessionInteractionQuestion,
  type SessionPendingInteraction,
} from "@agentkib/runtime-protocol";
import { interactionEvidence } from "@agentkib/backend/session-interaction-evidence";
import { classifyInteractionRisk } from "@agentkib/backend/session-interaction-risk";

type Decision = SessionInteractionDecision;
type Candidate = Pick<Decision, "id" | "kind" | "scope" | "label"> & {
  nativeChoice?: string;
  nativeDecision?: unknown;
};
type Projection = {
  sessionId?: string;
  workspaceRoot?: string;
  approve: boolean;
  send: boolean;
  extendedApproval: boolean;
  enabled: boolean;
};
const agentByMode: Readonly<Record<string, LiveSessionAgent>> = {
  "codex-managed": "codex",
  "codex-follower": "codex",
  "claude-managed": "claude-code",
  "dsh-follower": "deepseek-harness",
  "devin-print": "devin",
  "acp-managed": "antigravity",
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decisionKind(action: unknown): Decision["kind"] | undefined {
  switch (action) {
    case "allow":
    case "accept":
    case "acceptForSession":
    case "grant-turn":
    case "grant-session":
    case "acceptWithExecpolicyAmendment":
    case "applyNetworkPolicyAmendment":
    case "allow_once":
    case "allow_always":
      return "allow";
    case "reject_once":
    case "reject_always":
    case "deny-permissions":
    case "deny":
    case "decline":
      return "deny";
    case "cancel":
      return "cancel";
    default:
      return undefined;
  }
}

function approvalCandidates(approval: unknown): Candidate[] {
  const value = record(approval);
  if (!value) return [];
  const options = Array.isArray(value.options) ? value.options : [];
  const extended = Array.isArray(value.decisionOptions) ? value.decisionOptions : [];
  const basic = Array.isArray(value.availableDecisions) ? value.availableDecisions : [];
  const candidates: Candidate[] = [];
  for (const choice of basic) {
    if (typeof choice !== "string") continue;
    const option = options.find((row) => row?.optionId === choice);
    const native = extended.find((row) => row?.decision === choice);
    const action = option?.kind ?? native?.label ?? choice;
    const kind = decisionKind(action) ?? "native";
    const label =
      typeof option?.name === "string" && option.name
        ? option.name
        : kind === "native"
          ? choice
          : undefined;
    const scope =
      native?.scope === "session" || action === "acceptForSession"
        ? "session"
        : native?.scope === "persistent" || action === "allow_always" || action === "reject_always"
          ? "persistent"
          : kind === "native" && native?.scope !== "once"
            ? "unknown"
            : "once";
    candidates.push({
      id: `choice:${choice}`,
      kind,
      scope,
      ...(label !== undefined ? { label } : {}),
      nativeChoice: choice,
    });
  }
  for (const option of extended) {
    if (!option || typeof option.id !== "string" || option.decision === undefined) continue;
    const kind = decisionKind(option.label) ?? "native";
    const scope = option.scope;
    if (scope !== "once" && scope !== "session" && scope !== "persistent") continue;
    candidates.push({
      id: `native:${option.id}`,
      kind,
      scope,
      ...(kind === "native"
        ? { label: typeof option.label === "string" ? option.label : option.id }
        : {}),
      nativeDecision: option.decision,
    });
  }
  // A duplicate native ID cannot safely name either candidate.
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
  return candidates.filter((candidate) => counts.get(candidate.id) === 1);
}

function projectDecisions(approval: Record<string, unknown>, options: Projection): Decision[] {
  if (
    !options.enabled ||
    !options.approve ||
    approval.supported !== true ||
    (approval.requiresExtendedApproval === true && !options.extendedApproval)
  )
    return [];
  const candidates = approvalCandidates(approval);
  return candidates.flatMap(({ id, kind, scope, label, nativeDecision }): Decision[] => {
    if (nativeDecision !== undefined && !options.extendedApproval) return [];
    if (
      nativeDecision !== undefined &&
      candidates.some(
        (candidate) => candidate.nativeChoice === nativeDecision && candidate.scope === scope,
      )
    )
      return [];
    return [
      {
        id,
        kind,
        scope,
        ...(label !== undefined ? { label } : {}),
        available: true,
        lockScreen: scope === "once" && (kind === "deny" || kind === "allow"),
      },
    ];
  });
}

function questionsOf(value: unknown): SessionInteractionQuestion[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const valid = value.every(
    (item) =>
      record(item) &&
      typeof item.id === "string" &&
      typeof item.question === "string" &&
      typeof item.multiSelect === "boolean" &&
      typeof item.allowCustom === "boolean" &&
      Array.isArray(item.options) &&
      item.options.every((option: unknown) => typeof record(option)?.label === "string"),
  );
  return valid ? (value as SessionInteractionQuestion[]) : undefined;
}

export async function describePendingInteractions(
  snapshot: unknown,
  options: Projection,
): Promise<SessionPendingInteraction[] | undefined> {
  const state = record(snapshot);
  const mode = state?.executionMode;
  const agent =
    typeof mode === "string" && Object.hasOwn(agentByMode, mode) ? agentByMode[mode] : undefined;
  const advertised = sessionProviderDeclaration(agent)?.pendingInteractions;
  const sessionId = options.sessionId ?? state?.sessionId;
  const revision = state?.revision;
  const runtimeBootId = state?.runtimeBootId;
  if (
    !state ||
    !agent ||
    !advertised ||
    typeof sessionId !== "string" ||
    typeof runtimeBootId !== "string" ||
    !runtimeBootId ||
    (state.sessionId !== undefined && state.sessionId !== sessionId) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return undefined;
  const describe = async (kind: SessionPendingInteraction["kind"], values: unknown) => {
    if (!advertised[kind] || !Array.isArray(values)) return [];
    const descriptions = new Map<string, SessionPendingInteraction | null>();
    for (const raw of values) {
      const value = record(raw);
      const requestId = value?.requestId;
      const turnId = value?.turnId;
      if (
        !value ||
        !(
          (typeof requestId === "string" && requestId.length > 0) ||
          (typeof requestId === "number" && Number.isSafeInteger(requestId))
        ) ||
        typeof turnId !== "string" ||
        !turnId ||
        (state.turnId !== undefined && state.turnId !== turnId)
      )
        continue;
      const key = JSON.stringify([turnId, requestId]);
      if (descriptions.has(key)) {
        descriptions.set(key, null);
        continue;
      }
      const { riskInput, policyRiskInput, ...evidence } = interactionEvidence(agent, kind, value);
      let risk = await classifyInteractionRisk(riskInput, options.workspaceRoot);
      if (policyRiskInput && risk.level !== "high") {
        const policyRisk = await classifyInteractionRisk(policyRiskInput, options.workspaceRoot);
        if (policyRisk.level !== "low") risk = policyRisk;
      }
      const questions = kind === "question" ? questionsOf(value.questions) : undefined;
      const decisions: Decision[] =
        kind === "approval"
          ? projectDecisions(value, options)
          : options.enabled && options.send && value.supported === true && questions
            ? [
                {
                  id: "answer",
                  kind: "answer",
                  scope: "once",
                  lockScreen: false,
                  available: true,
                },
              ]
            : [];
      descriptions.set(key, {
        version: 1,
        kind,
        binding: { sessionId, runtimeBootId, turnId, requestId, revision },
        ...evidence,
        risk,
        decisions,
        ...(questions ? { questions } : {}),
      });
    }
    return [...descriptions.values()].filter((item) => item !== null);
  };
  return [
    ...(await describe("approval", state.approvals)),
    ...(await describe("question", state.questions)),
  ];
}

export function resolvePendingInteractionDecision(
  interaction: SessionPendingInteraction,
  approval: unknown,
  interactionDecisionId: string,
): { decision: Decision; nativeChoice?: string; nativeDecision?: unknown } | undefined {
  const decision = interaction.decisions.find((item) => item.id === interactionDecisionId);
  if (!decision) return undefined;
  if (interaction.kind === "question") return { decision };
  const candidate = approvalCandidates(approval).find(({ id }) => id === interactionDecisionId);
  if (!candidate) return undefined;
  const { nativeChoice, nativeDecision } = candidate;
  return { decision, nativeChoice, nativeDecision };
}
