import type { WorkerReportPart, WorkerReportWaitingItem } from "@agentkib/runtime-protocol";
import type { Lane, LeadApproval, LeadScope } from "./orchestration-registry";
import { sanitizeSessionText } from "./session-handoff";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function bounded(value: string, max: number): string {
  return value.length <= max
    ? value
    : `${value.slice(0, max)}… [truncated: ${value.length} characters]`;
}

/** Worker output shown to the lead: redacted as reports are, and cut. */
const shown = (value: unknown, max: number) =>
  bounded(
    sanitizeSessionText(typeof value === "string" ? value : JSON.stringify(value), { value: 0 }),
    max,
  );

/** Codex approvals a lead may decide; any other kind, a DeepSeek Harness one too, is the person's. */
const APPROVAL_KINDS: Record<string, LeadApproval> = {
  "item/fileChange/requestApproval": "file-change",
  "item/commandExecution/requestApproval": "command",
};

/**
 * A question card a lead may answer. A DeepSeek Harness card with a fixed set of choices is a
 * tool approval in DSH (one of its choices may allow the tool from then on), so it is the
 * person's, as DSH's other approvals are.
 */
function delegableQuestion(question: Record<string, unknown>): boolean {
  if (question.supported !== true) return false;
  if (question.method !== "dsh/question") return true;
  const items = Array.isArray(question.questions) ? question.questions : [];
  return items.every((item) => isObject(item) && item.allowCustom === true);
}

/** Something a lane waits for, as `worker_read` and a waiting report show it. */
type WaitingItem = {
  kind: "approval" | "question";
  id: string;
  /** An approval's kind: "file-change", "command", or "other" (always the person's). */
  approval?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  changes?: Array<{ path: string; kind?: string; diff?: string }>;
  questions?: Array<{ id: string; question: string; options: string[]; allowCustom: boolean }>;
  youMayDecide: boolean;
};

type DelegatedApproval = { kind: LeadApproval; accept: string; decline: string };

/** Select only the provider's explicit one-time choices for a recognizable task. */
export function delegatedApproval(
  live: Record<string, unknown>,
  approval: Record<string, unknown>,
): DelegatedApproval | undefined {
  if (approval.supported !== true || approval.requiresExtendedApproval === true) return;
  const decisions = Array.isArray(approval.availableDecisions) ? approval.availableDecisions : [];
  const kind = APPROVAL_KINDS[String(approval.method)];
  if (kind && decisions.includes("accept") && decisions.includes("decline"))
    return { kind, accept: "accept", decline: "decline" };
  if (approval.method === "claude/can_use_tool" && isObject(approval.context)) {
    const context = approval.context;
    if (
      context.blockedPath != null ||
      context.decisionReason != null ||
      context.decision_reason_type != null ||
      context.mcp_server != null ||
      context.matched_ask_rule != null ||
      context.default_to_no === true ||
      context.server_policy_ask_only ||
      context.requires_user_interaction ||
      (context.permissionSuggestions != null &&
        (!Array.isArray(context.permissionSuggestions) || context.permissionSuggestions.length > 0))
    )
      return;
    if (!decisions.includes("allow") || !decisions.includes("deny") || !isObject(approval.input))
      return;
    const tool = approval.toolName;
    if (tool === "Bash" && typeof approval.input.command === "string")
      return { kind: "command", accept: "allow", decline: "deny" };
    if ((tool === "Write" || tool === "Edit") && typeof approval.input.file_path === "string")
      return { kind: "file-change", accept: "allow", decline: "deny" };
    return;
  }
  if (live.executionMode !== "acp-managed" || !isObject(approval.toolCall)) return;
  const tool = approval.toolCall.kind;
  const options = (Array.isArray(approval.options) ? approval.options : []).filter(isObject);
  const allow = options.filter((option) => option.kind === "allow_once");
  const reject = options.filter((option) => option.kind === "reject_once");
  if (allow.length !== 1 || reject.length !== 1) return;
  const accept = allow[0]?.optionId;
  const decline = reject[0]?.optionId;
  if (
    typeof accept !== "string" ||
    typeof decline !== "string" ||
    !decisions.includes(accept) ||
    !decisions.includes(decline)
  )
    return;
  if (tool === "execute") return { kind: "command", accept, decline };
  if (tool === "edit") return { kind: "file-change", accept, decline };
}

function fileChanges(value: unknown): WaitingItem["changes"] {
  const entries: Array<Record<string, unknown>> = Array.isArray(value)
    ? value.filter(isObject)
    : isObject(value)
      ? Object.entries(value).map(([path, change]) => ({
          ...(isObject(change) ? change : {}),
          path,
        }))
      : [];
  return entries.slice(0, 10).flatMap((change) =>
    typeof change.path === "string"
      ? [
          {
            path: shown(change.path, 1024),
            ...(isObject(change.kind) && typeof change.kind.type === "string"
              ? { kind: change.kind.type }
              : typeof change.kind === "string"
                ? { kind: change.kind }
                : {}),
            ...(typeof change.diff === "string" ? { diff: shown(change.diff, 1500) } : {}),
          },
        ]
      : [],
  );
}

/** What a lane waits for from the person, and which of it its lead may decide. */
export function waitingItems(live: Record<string, unknown>, scope: LeadScope): WaitingItem[] {
  const approvals = (Array.isArray(live.approvals) ? live.approvals : []).filter(isObject);
  const questions = (Array.isArray(live.questions) ? live.questions : []).filter(isObject);
  return [
    ...approvals.map((approval): WaitingItem => {
      const delegated = delegatedApproval(live, approval);
      const kind = delegated?.kind ?? APPROVAL_KINDS[String(approval.method)];
      const context = isObject(approval.requestContext) ? approval.requestContext : {};
      const native = isObject(approval.toolCall) ? approval.toolCall.rawInput : approval.input;
      const input = isObject(native) ? native : {};
      const command = approval.command ?? input.command ?? input.cmd ?? input.script;
      const path = input.file_path ?? input.path ?? input.filePath;
      const changes = approval.changes ?? (typeof path === "string" ? [{ path }] : null);
      return {
        kind: "approval",
        id: String(approval.requestId),
        approval: kind ?? "other",
        ...(command != null ? { command: shown(command, 2000) } : {}),
        ...(typeof approval.cwd === "string" ? { cwd: shown(approval.cwd, 1024) } : {}),
        ...(typeof context.reason === "string" ? { reason: shown(context.reason, 1000) } : {}),
        ...(changes != null ? { changes: fileChanges(changes) } : {}),
        youMayDecide: !!delegated && (scope.approvals ?? []).includes(delegated.kind),
      };
    }),
    ...questions.map((question): WaitingItem => ({
      kind: "question",
      id: String(question.requestId),
      questions: (Array.isArray(question.questions) ? question.questions : [])
        .filter(isObject)
        .slice(0, 32)
        .map((item) => ({
          id: String(item.id),
          question: shown(item.question ?? item.header ?? "", 1000),
          options: (Array.isArray(item.options) ? item.options : [])
            .filter(isObject)
            .slice(0, 16)
            .map((option) => shown(option.label ?? "", 200)),
          allowCustom: item.allowCustom === true,
        })),
      youMayDecide: scope.answers === true && delegableQuestion(question),
    })),
  ];
}

export type WorkerReportDetails = Omit<
  WorkerReportPart,
  "workerSessionId" | "workerName" | "workerRoleLabel" | "agent" | "occurredAt" | "requiresUser"
> & { requiresUser?: boolean };

export function workerReportPart(
  lane: Pick<Lane, "sessionId" | "name" | "agent" | "role">,
  occurredAt: number,
  detail: WorkerReportDetails,
): WorkerReportPart {
  const { durationMs, ...rest } = detail;
  const milliseconds = Math.round(durationMs ?? -1);
  return {
    workerSessionId: lane.sessionId,
    workerName: lane.name,
    ...(lane.role && { workerRoleLabel: lane.role.label }),
    agent: lane.agent ?? "codex",
    occurredAt: new Date(occurredAt).toISOString(),
    ...rest,
    requiresUser: rest.requiresUser === true,
    ...(Number.isSafeInteger(milliseconds) && milliseconds >= 0
      ? { durationMs: milliseconds }
      : {}),
  };
}

/** Keep the model's existing wrapper and present the same redacted Markdown separately. */
export function projectReportReply(value: string, max: number) {
  const reply = sanitizeSessionText(value, { value: 0 });
  return {
    model: bounded(reply, max),
    human: {
      reply: reply.slice(0, max),
      ...(reply.length > max ? { replyTruncated: true } : {}),
    },
  };
}

function approvalPreview(item: WaitingItem): WorkerReportWaitingItem {
  if (item.approval === "command" || item.command)
    return {
      kind: "command",
      summary: item.command ?? "",
      ...(item.reason ? { detail: item.reason } : {}),
    };
  if (item.approval === "file-change" || item.changes?.length)
    return { kind: "file-change", summary: item.changes?.map(({ path }) => path).join("\n") ?? "" };
  return { kind: "other", summary: item.reason ?? "" };
}

/** Publish only a bounded preview, leaving native request IDs and tool instructions in model text. */
export function waitingReportDetails(
  items: readonly WaitingItem[],
  question: boolean,
): WorkerReportDetails {
  const waitingItems: WorkerReportWaitingItem[] = [];
  let remaining = 4_000;
  for (const item of items) {
    const previews =
      item.kind === "question"
        ? (item.questions ?? []).map(({ question, options }): WorkerReportWaitingItem => ({
            kind: "question",
            summary: question,
            ...(options.length ? { detail: options.join("\n") } : {}),
          }))
        : [approvalPreview(item)];
    for (const preview of previews) {
      if (waitingItems.length === 10 || remaining <= 0) break;
      const summary = preview.summary.slice(0, Math.min(2_000, remaining));
      remaining -= summary.length;
      const detail = preview.detail?.slice(0, Math.min(1_000, remaining));
      remaining -= detail?.length ?? 0;
      waitingItems.push({ kind: preview.kind, summary, ...(detail ? { detail } : {}) });
    }
    if (waitingItems.length === 10 || remaining <= 0) break;
  }
  return {
    kind: question ? "waiting-question" : "waiting-approval",
    requiresUser: !items.length || items.some((item) => !item.youMayDecide),
    delegable: items.some((item) => item.youMayDecide),
    ...(waitingItems.length ? { waitingItems } : {}),
  };
}
