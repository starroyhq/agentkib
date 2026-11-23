import type { RefObject } from "react";
import {
  ApiError,
  isClaudeCommandRefusal,
  isDshCommandRefusal,
  managedAgentOf,
  needsDurableReceipt,
  sessionProviderDeclaration,
  type Access,
  type Approval,
  type ConversationEventPage,
  type ConversationSessionSummary,
  type ClaudeCommandRefusal,
  type Decision,
  type DshCommandRefusal,
  type Live,
  type ResolvedHistoryReference,
  type SessionCapabilities,
  type UserQuestionRequest,
  type WebClient,
} from "@agentkib/web-client";
import { isValidMessage } from "@agentkib/conversation-state";
import { canSubmitGoalDraft } from "./session-composer-capabilities";
import { capabilityAccessBinding } from "./use-session-capabilities";
import { answerRequestBody } from "./interaction-model";
import { DEVIN_TURN_REASONS } from "./devin-terminal";
import { sessionStopCapabilityAllows } from "./agents/session-turn-controls";

export type ControlNotice = "accepted" | "uncertain" | "notDispatched";
/** The control call a notice came from; the interaction card shows its own outcomes. */
export type ControlKind = "send" | "stop" | "approve" | "answer";
type CodexSettingsRecoveryReason =
  | "unsupported-model"
  | "unsupported-effort"
  | "native-model-unconfirmed"
  | "native-effort-unconfirmed";
/** A model or effort Claude Code does not offer; worded apart from Codex's unsent message. */
type ClaudeSettingsReason = "claude-model-unsupported" | "claude-effort-unsupported";
/** An image the agent refused, explained the same way for every agent that takes images. */
type AttachmentRefusal =
  | "model-images-unsupported"
  | "attachment-invalid"
  | "attachment-changed"
  | "attachment-unavailable"
  | "invalid_attachment_image";
const attachmentRefusals: ReadonlySet<string> = new Set<AttachmentRefusal>([
  "model-images-unsupported",
  "attachment-invalid",
  "attachment-changed",
  "attachment-unavailable",
  "invalid_attachment_image",
]);
/** A slash command DeepSeek Harness did not run: refused here, or no longer in its registry. */
type DshCommandReason = DshCommandRefusal | "dsh-command-unavailable";
/** A reason a rejected request is explained with instead of the generic notice. */
export type NotDispatchedReason =
  | CodexSettingsRecoveryReason
  | ClaudeCommandRefusal
  | ClaudeSettingsReason
  | AttachmentRefusal
  | DshCommandReason
  | DevinRefusal;
/** Devin CLI's own refusals, explained under its composer (`DEVIN_TURN_REASONS`). */
type DevinRefusal =
  | "devin-login-required"
  | "devin-workspace-untrusted"
  | "devin-cli-unavailable"
  | "devin-cli-update-required"
  | "devin-run-failed"
  | "devin-session-not-found"
  | "session-open-elsewhere"
  | "attachments-unsupported";
export function sessionControlRefusalReason(
  agent: string | undefined,
  ...reasons: (string | undefined)[]
): NotDispatchedReason | undefined {
  const image = reasons.find(
    (reason): reason is AttachmentRefusal => !!reason && attachmentRefusals.has(reason),
  );
  if (image) return image;
  if (agent === "claude-code") {
    // A slash command Claude Code was not sent; the host names which rule refused it.
    const refusal = reasons.find(isClaudeCommandRefusal);
    if (refusal) return refusal;
    // The Service checks a settings request first and answers `unsupported_model`; the backend
    // checks again and names the same rejection `unsupported-model`.
    if (reasons.some((reason) => reason === "unsupported-model" || reason === "unsupported_model"))
      return "claude-model-unsupported";
    if (
      reasons.some((reason) => reason === "unsupported-effort" || reason === "unsupported_effort")
    )
      return "claude-effort-unsupported";
    return;
  }
  if (agent === "deepseek-harness")
    return reasons.find(
      (reason): reason is DshCommandReason =>
        isDshCommandRefusal(reason) || reason === "dsh-command-unavailable",
    );
  if (agent === "devin")
    return reasons.find(
      (reason): reason is DevinRefusal => !!reason && DEVIN_TURN_REASONS.includes(reason),
    );
  if (agent !== "codex") return;
  return reasons.find(
    (reason): reason is CodexSettingsRecoveryReason =>
      reason === "unsupported-model" ||
      reason === "unsupported-effort" ||
      reason === "native-model-unconfirmed" ||
      reason === "native-effort-unconfirmed",
  );
}
export function isWaitingForOwnerAcknowledgement(
  value: { status?: string; reason?: string } | null | undefined,
): boolean {
  return value?.status === "waiting-for-owner" || value?.reason === "codex-waiting-for-owner";
}

export interface SessionControlPending {
  requestId: string;
  sessionId?: string;
  kind: string;
}

interface ActiveControlReceipt {
  scope: string;
  generation: number;
  bootId?: string;
}

interface LastControlReceipt {
  sessionId: string;
  requestId: string;
  turnId?: string;
  observedActive: boolean;
}

interface SessionControlContext<Pending extends SessionControlPending> {
  client: WebClient;
  access?: Access;
  live?: Live;
  online: boolean;
  controlReady: boolean;
  selected: string;
  capabilities?: SessionCapabilities;
  message: string;
  sessions: ConversationSessionSummary[];
  page?: ConversationEventPage;
  accessRef: RefObject<Access | undefined>;
  liveValue: RefObject<Live | undefined>;
  historyReferencesValue: RefObject<ResolvedHistoryReference[]>;
  generation: RefObject<number>;
  selection: RefObject<string>;
  readinessEpoch: RefObject<number>;
  refreshRequired: RefObject<boolean>;
  manualRefreshRequired: RefObject<boolean>;
  streamReady: RefObject<boolean>;
  catalogSessions: RefObject<ConversationSessionSummary[]>;
  excludedIds: RefObject<ReadonlySet<string>>;
  uncertainOutcomes: RefObject<Set<string>>;
  mutating: RefObject<boolean>;
  activeReceipts: RefObject<Map<string, ActiveControlReceipt>>;
  durableScope: RefObject<string | undefined>;
  durablePending: RefObject<Pending[]>;
  receipt: RefObject<LastControlReceipt | undefined>;
  verifyCapabilities: () => Promise<SessionCapabilities | undefined>;
  hasDurablePending: (sessionId: string) => boolean;
  setBusy: (busy: boolean) => void;
  setNotice: (notice?: ControlNotice, reason?: NotDispatchedReason, source?: ControlKind) => void;
  setControlReady: (ready: boolean) => void;
  setPendingSend: (pending?: { sessionId: string; text: string; afterEventId?: string }) => void;
  setMessage: (message: string) => void;
  setHistoryReferences: (references: ResolvedHistoryReference[]) => void;
  setModal: (modal: undefined) => void;
  setOnline: (online: boolean) => void;
  refresh: () => Promise<void>;
  fail: (error: unknown, generation?: number) => void;
  historyMessageText: (message: string, references: readonly ResolvedHistoryReference[]) => string;
  forgetPending: (scope: string, requestId: string) => void;
  rememberPending: (
    scope: string,
    pending: { requestId: string; sessionId: string; kind: ControlKind },
  ) => void;
  readPending: (scope: string) => Pending[];
}

export function createSessionControl<Pending extends SessionControlPending>({
  client,
  access,
  live,
  online,
  controlReady,
  selected,
  capabilities,
  message,
  sessions,
  page,
  accessRef,
  liveValue,
  historyReferencesValue,
  generation,
  selection,
  readinessEpoch,
  refreshRequired,
  manualRefreshRequired,
  streamReady,
  catalogSessions,
  excludedIds,
  uncertainOutcomes,
  mutating,
  activeReceipts,
  durableScope,
  durablePending,
  receipt,
  verifyCapabilities,
  hasDurablePending,
  setBusy,
  setNotice,
  setControlReady,
  setPendingSend,
  setMessage,
  setHistoryReferences,
  setModal,
  setOnline,
  refresh,
  fail,
  historyMessageText,
  forgetPending,
  rememberPending,
  readPending,
}: SessionControlContext<Pending>) {
  return async function control(
    kind: "send" | "stop" | "approve" | "answer",
    approval?: Approval,
    decision?: Decision,
    question?: UserQuestionRequest,
    answers?: Record<string, string[]>,
    extra?: {
      attachmentIds?: string[];
      resourceIds?: string[];
      requiresGoal?: boolean;
      nativeDecision?: unknown;
      /**
       * A slash command sent as a message of its own. The draft, its
       * attachments and history quotes stay as they are.
       */
      command?: string;
      /**
       * A message AgentKib wrote in place of the draft (Codex `/review`, `/init`). It is sent
       * without attachments or history quotes, and clears the draft like any send.
       */
      prompt?: string;
    },
  ) {
    if (
      mutating.current ||
      !access ||
      !live ||
      !online ||
      !controlReady ||
      excludedIds.current.has(selected) ||
      selection.current !== selected ||
      hasDurablePending(selected)
    )
      return;
    const command = kind === "send" ? extra?.command : undefined;
    const prompt = kind === "send" && command === undefined ? extra?.prompt : undefined;
    const text = command ?? prompt ?? message.trim();
    if (
      kind === "send" &&
      (live.activity === "compacting" ||
        (command !== undefined
          ? !command.startsWith("/") ||
            !isValidMessage(command, false) ||
            !!extra?.attachmentIds?.length ||
            !!extra?.resourceIds?.length
          : prompt !== undefined
            ? !isValidMessage(prompt, false) ||
              !!extra?.attachmentIds?.length ||
              !!extra?.resourceIds?.length
            : !isValidMessage(
                historyMessageText(message, historyReferencesValue.current),
                !!extra?.attachmentIds?.length,
              )))
    )
      return;
    if (
      extra?.attachmentIds?.length &&
      (!access.device?.attachments || !capabilities?.features.attachments?.available)
    )
      return;
    if (
      extra?.resourceIds?.length &&
      (access.device?.accessMode !== "full" ||
        !(capabilities?.features as Record<string, { available?: boolean } | undefined> | undefined)
          ?.context?.available)
    )
      return;
    if (extra?.requiresGoal && !canSubmitGoalDraft(capabilities)) return;
    if (
      extra?.nativeDecision !== undefined &&
      (!access.device?.extendedApproval ||
        !approval?.decisionOptions?.some(
          (option) => JSON.stringify(option.decision) === JSON.stringify(extra.nativeDecision),
        ))
    )
      return;
    if (
      kind === "stop" &&
      (!access.experimentalEnabled ||
        !access.device?.send ||
        live.stopEnabled !== true ||
        !sessionStopCapabilityAllows(
          live,
          capabilities,
          selected,
          sessionProviderDeclaration(
            catalogSessions.current.find((item) => item.id === selected)?.agent,
          ),
        ) ||
        !live.turnId)
    )
      return;
    if (
      kind === "answer" &&
      (!question ||
        !access.experimentalEnabled ||
        !access.device?.send ||
        !question.supported ||
        !live.questions?.some((current) => JSON.stringify(current) === JSON.stringify(question)))
    )
      return;
    // A stable request ID does not mean the command/scope shown on the card
    // is still current. Require the exact reviewed projection.
    if (
      kind === "approve" &&
      (!approval ||
        !live.approvals.some((current) => JSON.stringify(current) === JSON.stringify(approval)))
    )
      return;
    mutating.current = true;
    setBusy(true);
    setNotice(undefined);
    readinessEpoch.current++;
    manualRefreshRequired.current = false;
    const g = generation.current,
      id = selected;
    const requestId = crypto.randomUUID();
    if (
      kind === "send" &&
      managedAgentOf(catalogSessions.current.find((item) => item.id === id)?.agent ?? "")
    )
      setPendingSend({ sessionId: id, text, afterEventId: page?.events.at(-1)?.id });
    const durableReceipt = needsDurableReceipt(
      sessions.find((session) => session.id === id)?.agent,
      live.executionMode,
    );
    const scope = durableReceipt ? durableScope.current : undefined;
    try {
      if (extra?.attachmentIds?.length || extra?.resourceIds?.length || extra?.requiresGoal) {
        const accessBinding = capabilityAccessBinding(access);
        const checked = await verifyCapabilities();
        if (
          g !== generation.current ||
          selection.current !== id ||
          capabilityAccessBinding(accessRef.current) !== accessBinding ||
          refreshRequired.current ||
          !streamReady.current ||
          hasDurablePending(id) ||
          uncertainOutcomes.current.has(id) ||
          (extra.attachmentIds?.length && !checked?.features.attachments?.available) ||
          (extra.resourceIds?.length && !checked?.features.context?.available) ||
          (extra.requiresGoal && !canSubmitGoalDraft(checked))
        ) {
          if (
            hasDurablePending(id) ||
            uncertainOutcomes.current.has(id) ||
            liveValue.current?.status === "outcome-unknown" ||
            liveValue.current?.reason === "control-outcome-unconfirmed" ||
            checked?.reason === "control-outcome-unconfirmed"
          ) {
            if (g === generation.current && selection.current === id) {
              refreshRequired.current = true;
              setControlReady(false);
              setNotice("uncertain", undefined, kind);
            }
            return;
          }
          throw new ApiError(409, "session-state-unavailable", "not-dispatched");
        }
      }
      if (durableReceipt) {
        try {
          if (!scope) throw new Error("missing_device_scope");
          if (kind === "send")
            activeReceipts.current.set(requestId, { scope, generation: g, bootId: access.bootId });
          rememberPending(scope, { requestId, sessionId: id, kind });
          durablePending.current = readPending(scope);
        } catch {
          throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
        }
      }
      const result = await client.request<{ status?: string; reason?: string }>(kind, {
        sessionId: id,
        requestId,
        bootId: access.bootId,
        expectedRevision: live.revision,
        ...(kind === "send"
          ? {
              text,
              ...(command === undefined &&
              prompt === undefined &&
              historyReferencesValue.current.length
                ? {
                    historyReferences: historyReferencesValue.current.map((item) => item.reference),
                  }
                : {}),
              ...(extra?.attachmentIds?.length ? { attachmentIds: extra.attachmentIds } : {}),
              ...(extra?.resourceIds?.length ? { resourceIds: extra.resourceIds } : {}),
            }
          : kind === "stop"
            ? { turnId: live.turnId }
            : kind === "approve"
              ? {
                  turnId: approval!.turnId,
                  approvalId: approval!.requestId,
                  ...(extra?.nativeDecision !== undefined
                    ? { nativeDecision: extra.nativeDecision }
                    : { decision }),
                }
              : answerRequestBody(
                  question!,
                  answers!,
                  { sessionId: id, bootId: access.bootId, expectedRevision: live.revision },
                  requestId,
                )),
      });
      if (scope) {
        forgetPending(scope, requestId);
        if (durableScope.current === scope) durablePending.current = readPending(scope);
      }
      if (g !== generation.current) return;
      // An accepted queue entry owns no native turn yet. The current owner may run its own turns.
      receipt.current =
        kind === "send" && isWaitingForOwnerAcknowledgement(result)
          ? undefined
          : {
              sessionId: id,
              requestId,
              turnId:
                kind === "send"
                  ? undefined
                  : kind === "stop"
                    ? live.turnId
                    : kind === "answer"
                      ? question!.turnId
                      : approval!.turnId,
              // A current native interaction already establishes an active turn,
              // even if the owner uses an unfamiliar waiting-status label.
              observedActive: kind !== "send",
            };
      setNotice("accepted", undefined, kind);
      if (kind === "send" && command === undefined) {
        setMessage("");
        setHistoryReferences([]);
      }
      setModal(undefined);
      await refresh();
      return true;
    } catch (e) {
      if (scope && e instanceof ApiError && e.controlOutcome === "not-dispatched") {
        try {
          forgetPending(scope, requestId);
          if (durableScope.current === scope) durablePending.current = readPending(scope);
        } catch {
          /* Keep the durable fence if browser storage could not be updated. */
        }
      }
      if (g === generation.current) {
        if (e instanceof ApiError && e.code === "access_ended") {
          fail(e, g);
        } else {
          setControlReady(false);
          refreshRequired.current = true;
          if (e instanceof ApiError && e.controlOutcome === "not-dispatched") {
            setNotice(
              "notDispatched",
              sessionControlRefusalReason(
                catalogSessions.current.find((session) => session.id === id)?.agent,
                e.code,
              ),
              kind,
            );
            await refresh();
          } else {
            // A refresh clicked while this request was pending cannot acknowledge
            // an uncertain outcome that has only just arrived.
            manualRefreshRequired.current = false;
            uncertainOutcomes.current.add(id);
            setNotice("uncertain", undefined, kind);
            setOnline(false);
            fail(e, g);
          }
        }
      }
    } finally {
      activeReceipts.current.delete(requestId);
      if (g === generation.current) setPendingSend(undefined);
      mutating.current = false;
      setBusy(false);
    }
  };
}
