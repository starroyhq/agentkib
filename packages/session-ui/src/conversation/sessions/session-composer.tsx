import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import {
  sessionProviderDeclaration,
  type Live,
  type ResolvedHistoryReference,
  type SessionResource,
} from "@agentkib/web-client";
import { AlertTriangle, CornerDownRight, ListPlus, MoreHorizontal, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  composerPanelShortcut,
  planSlashOption,
  resolveSessionCommands,
  type AgentKibPanel,
} from "../../agents/session-commands";
import { sessionContinuationRegistration } from "../../agents/session-continuation";
import {
  queueAccessGranted,
  queueActionGranted,
  registeredRunningSteer,
  registeredSessionQueue,
} from "../../agents/session-queue";
import { sessionStopCapabilityAllows } from "../../agents/session-turn-controls";
import { sessionTurnNotice } from "../../agents/session-turn-notice";
import { sessionApprovalRuntime } from "../../agents/session-approvals";
import { commandPrompt } from "../../command-prompts";
import { contextUsageCopyForSurface } from "../../context-usage-copy";
import type { ContextUsageHandle } from "../../context-usage-indicator";
import type { InteractionLocale } from "../../interaction-model";
import { parseGoalDraft, useNewSessionGoalDraft } from "../../new-session-draft";
import { composerDraftUnavailableReason } from "../../session-composer-access";
import { existingSessionComposerCapabilities } from "../../session-composer-capabilities";
import { ComposerPrimaryAction, SessionComposerInput } from "../../session-composer-input";
import { SessionComposerToolbar } from "../../session-composer-toolbar";
import { SessionContextUsageGauge } from "../../session-context-usage-gauge";
import { sessionContinuationCopy } from "../../session-continuation";
import type { createSessionControl } from "../../session-control";
import { resolveSessionProvider } from "../../session-provider";
import { useSessionPlatform } from "../../session-platform";
import { slashPlanQuery, stripSlashPlan, useSlashCommandMenu } from "../../slash-commands";
import { useComposerAttachments } from "../../use-composer-attachments";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { runningSendAction, useSendWhileRunning } from "../preferences/send-while-running";
import { claudeConnectionCopyForSurface } from "../../agents/claude-code/connection-copy";
import type {
  SessionComposerControlsProps,
  ComposerControlsHandle,
  ComposerPlanState,
} from "./session-composer-controls";
import { sessionCopyForSurface, sessionReason } from "./session-copy";
import { composerLayoutCopy, composerSettingsStatus } from "./composer-layout-copy";
import { continuationResources, type ContinuationComposerDraft } from "./continuation-draft";
import { SessionSendQueue } from "./dsh-queue";
import { takeNewSessionDraft } from "./new-session-draft";
import { PermissionModeNotice } from "./permission-mode-notice";
import { SessionReadOnly } from "./session-read-only";
import type { SessionPanels } from "./session-panels";

type ComposerSession = SessionComposerControlsProps["session"] & {
  historyReferences?: ResolvedHistoryReference[];
  setHistoryReferences?: (references: ResolvedHistoryReference[]) => void;
  t: Readonly<Record<string, string>>;
  message: string;
  setMessage: (message: string) => void;
  control: ReturnType<typeof createSessionControl>;
  canSend: boolean;
  canStop: boolean;
  checkContinuation?: () => unknown;
  takeContinuationDraft?: (id: string) => ContinuationComposerDraft | undefined;
};

type ComposerDisplay = {
  label: string;
  reason: string;
  tone: "warning" | "active" | "muted";
  loading?: boolean;
  offline?: boolean;
  continuation?:
    | "idle"
    | "starting"
    | "running"
    | "terminal"
    | "terminal-watch"
    | "busy"
    | "codex"
    | "dsh"
    | "dsh-observed"
    | "status-unknown"
    | "view-only";
};

type ComposerPanels = Pick<
  SessionPanels,
  "statusOutsideComposer" | "setFilesOpen" | "setActionsOpen"
>;

export type SessionComposerProps = {
  session: ComposerSession;
  panels?: ComposerPanels | null;
  display: ComposerDisplay;
  connectionStatusInBanner?: boolean;
  connectionNoticeInToolbar?: boolean;
  Controls: ComponentType<SessionComposerControlsProps>;
  TurnNotice: ComponentType<{
    live?: Live;
    locale: InteractionLocale;
    surface?: "desktop" | "web";
    onUsageLimitCancel: () => void;
    onUsageLimitArm: () => void;
  }>;
  ContextUsage?: ComponentType<ComponentProps<typeof SessionContextUsageGauge>>;
};

/** A notice floating above the composer. Opaque: the conversation scrolls behind it. */
const floatingNotice =
  "pointer-events-auto rounded-lg border px-3 py-2 text-xs leading-5 shadow-sm";
export function SessionComposer({
  session,
  panels,
  display,
  connectionStatusInBanner = false,
  connectionNoticeInToolbar = false,
  Controls,
  TurnNotice,
  ContextUsage = SessionContextUsageGauge,
}: SessionComposerProps) {
  const {
    kind: surface,
    components,
    controls: platformControls,
    copy: platformCopy,
    notifications,
  } = useSessionPlatform();
  const {
    Button,
    Disclosure,
    DisclosureSummary,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    SessionDialog,
  } = components;
  const commandOwner = platformControls.commandSurface === "local-owner";
  const restrictedPlan = platformControls.restrictedComposer === "attachments-and-plan";
  const {
    historyReferences = [],
    setHistoryReferences,
    selected,
    current,
    live,
    client,
    access,
    locale,
    t,
    message,
    setMessage,
    control,
    runSessionAction,
    controlReady,
    capabilities,
    canSend,
    canStop,
    busy,
    online,
    notice,
    settingsOnlyBlocked,
  } = session;
  const reason = (code?: string | null) =>
    sessionReason(locale, code ?? undefined, surface, platformCopy.unavailableReason).text;
  const isClaude = current?.agent === "claude-code";
  const isCodex = current?.agent === "codex";
  const resume = sessionContinuationRegistration(
    current?.id === selected ? current.agent : undefined,
  );
  const continuation = sessionContinuationCopy(locale);
  const copy = sessionCopyForSurface(locale, surface);
  const layout = composerLayoutCopy[locale];
  const connectionReasonShown =
    connectionNoticeInToolbar || (display.offline && panels?.statusOutsideComposer);
  const provider = resolveSessionProvider(current, capabilities);
  const terminalInteraction =
    online &&
    current?.id === selected &&
    live?.sessionId === selected &&
    (display.continuation === "terminal" || display.continuation === "terminal-watch")
      ? sessionApprovalRuntime(live, provider?.connection?.kind)?.observedText?.(
          live,
          selected,
          locale,
          surface,
        )
      : undefined;
  const composerValue = message;
  const setComposerText = setMessage;
  const [submitted, setSubmitted] = useState(false);
  const submitPending = useRef(false);
  // While the agent runs, Send queues the message or adds it to the running turn, as this
  // device chose in preferences; the menu beside Send offers both either way.
  const runningAction = runningSendAction(useSendWhileRunning());
  const [error, setError] = useState("");
  const [resources, setResources] = useState<SessionResource[]>([]);
  const workspaceId = current?.workspace_id;
  const draftAuthority = useMemo(
    () => ({ client, bootId: access?.bootId, deviceId: access?.device?.id, workspaceId }),
    [client, access?.bootId, access?.device?.id, workspaceId],
  );
  const {
    value: startupGoal,
    load: loadStartupGoal,
    confirmFirstMessage,
    stage: stageGoal,
    handled: startupGoalHandled,
    discard: discardStartupGoal,
  } = useNewSessionGoalDraft(selected, draftAuthority);
  const fileInput = useRef<HTMLInputElement>(null);
  const [addMenuScope, setAddMenuScope] = useState<string>();
  const firstMessage = useRef<{ sessionId: string; text: string; shown?: boolean }>(undefined);
  const generation = useRef(0);
  const uploadPermission = !!(
    access?.device?.attachments &&
    capabilities?.sessionId === selected &&
    capabilities.features.attachments?.available
  );
  // DeepSeek Harness runs a message naming one of its commands itself; the host refuses the
  // ones that need full access to a device without it, so the menu leaves them out.
  const fullAccess = access?.device?.accessMode === "full";
  const addActionsScope = JSON.stringify([
    selected,
    access?.bootId,
    access?.device?.id,
    live?.connectionGeneration,
  ]);
  const compacting = live?.activity === "compacting";
  const limitedSettings =
    restrictedPlan &&
    isCodex &&
    !fullAccess &&
    current.id === selected &&
    capabilities?.sessionId === selected
      ? capabilities.features.settings
      : undefined;
  // Restricted devices can receive the native mode in a live snapshot without its own session ID.
  const observedSettings =
    live?.sessionId === selected &&
    (!live.settings?.sessionId || live.settings.sessionId === selected)
      ? live.settings
      : undefined;
  // Older restricted hosts do not expose a mode directory. The settings action verifies this on write.
  const offeredModes =
    observedSettings?.options?.collaborationModes?.map((item) => item.id) ??
    (["default", "plan"] as const);
  const showLimitedPlan = !!limitedSettings && offeredModes.includes("plan");
  const limitedPlanOn =
    (observedSettings?.selected?.mode ?? observedSettings?.current?.mode) === "plan";
  const nextMode = limitedPlanOn ? "default" : "plan";
  const canChangeLimitedPlan = !!(
    showLimitedPlan &&
    limitedSettings?.available &&
    access?.status === "approved" &&
    access.experimentalEnabled &&
    access.device &&
    access.device.settings !== false &&
    live?.sessionId === selected &&
    offeredModes.includes(nextMode) &&
    online &&
    controlReady &&
    !busy &&
    !submitted &&
    !compacting &&
    notice !== "uncertain" &&
    live.status !== "outcome-unknown" &&
    session.settingsNotice?.status !== "uncertain"
  );
  const limitedPlanReason = compacting
    ? contextUsageCopyForSurface(locale, surface).compactingDetail
    : reason(limitedSettings?.reason ?? capabilities?.reason);
  const changeLimitedPlan = () => {
    if (canChangeLimitedPlan) void runSessionAction("settings", { mode: nextMode });
  };
  const settingsNotice =
    restrictedPlan && !fullAccess && isCodex && session.settingsNotice?.target === "permissions"
      ? session.settingsNotice
      : undefined;
  const planWriteStatus = composerSettingsStatus(locale, settingsNotice, reason, t.notDispatched);
  const attachmentsReason =
    isClaude && live?.executionMode === "claude-follower"
      ? claudeConnectionCopyForSurface(locale, surface).attachments
      : capabilities?.sessionId === selected && capabilities?.features.attachments?.reason
        ? reason(capabilities.features.attachments.reason)
        : copy.permission;
  const canChooseAttachments = uploadPermission && !busy && !submitted;
  const canOpenAddMenu = canChooseAttachments || canChangeLimitedPlan;
  const commandProvider =
    current?.id === selected ? sessionProviderDeclaration(current.agent) : undefined;
  const slotsGranted = fullAccess && access?.device?.advancedControl === true;
  const composerCapabilities = existingSessionComposerCapabilities({
    access,
    agent: current?.agent,
    currentId: current?.id,
    capabilities,
    sessionId: selected,
    legacyReads: isCodex && typeof client.sessionCapabilities !== "function",
  });
  const {
    uploads,
    add,
    remove,
    keepUnavailable,
    clear: clearUploads,
    preview,
    setPreviewKey,
    unavailablePreview,
  } = useComposerAttachments({
    client,
    sessionId: selected,
    authority: draftAuthority,
    granted: access?.device?.attachments === true,
    canUpload: uploadPermission && !busy && !submitted,
    copy,
    onError: setError,
  });
  const draftUnknown =
    notice === "uncertain" ||
    live?.status === "outcome-unknown" ||
    live?.reason === "control-outcome-unconfirmed" ||
    capabilities?.reason === "control-outcome-unconfirmed";
  const draftReady =
    online &&
    !busy &&
    !submitted &&
    !draftUnknown &&
    current?.id === selected &&
    capabilities?.sessionId === selected;
  const localSettings = composerCapabilities.reservesModelSlot;
  const localGoal =
    slotsGranted && (composerCapabilities.goalReadable || composerCapabilities.goalDraftOffered);
  const feature = composerCapabilities.feature;
  const commands = resolveSessionCommands({
    provider: commandProvider,
    selected,
    capabilities,
    canSend: canSend && controlReady && !settingsOnlyBlocked,
    canReadNativeCommands:
      canSend || (access?.status === "approved" && access.device?.send === true),
    localOwner: commandOwner,
    fullAccess,
    model: localSettings,
    goal: localGoal,
    locale,
    fallbackLabel: current?.agent,
    modelDisabledReason: reason(composerCapabilities.settingsReadReason),
    goalDisabledReason: reason(feature("goal")?.reason ?? feature("goal-draft")?.reason),
    nativeDisabledReason: reason(feature("send")?.reason ?? capabilities?.reason),
    canRun: (action) =>
      !settingsOnlyBlocked &&
      ((action === "goal-set" && localGoal && composerCapabilities.goalDraftOffered) ||
        (controlReady && (action !== "send" || canSend) && feature(action)?.available === true)),
    actionDisabledReason: (action) => reason(feature(action)?.reason),
  });
  // A refused command keeps its draft; the explanation goes once the draft changes.
  const [commandNotice, setCommandNotice] = useState<{ draft: string; reason: string }>();
  // A command typed without an argument opens AgentKib's control for it, as a button would.
  const controls = useRef<ComposerControlsHandle>(null);
  const limitedUsage = useRef<ContextUsageHandle>(null);
  // Plan shortcuts use the same readiness as the visible plan control.
  const [reportedPlan, setPlanState] = useState<ComposerPlanState>({
    on: false,
    available: false,
  });
  const planState = fullAccess ? reportedPlan : { on: false, available: false };
  const planOption = useMemo(() => planSlashOption(locale), [locale]);
  const slash = useSlashCommandMenu({
    value: composerValue,
    options: commands.options,
    enabled: commands.enabled && draftReady,
    copy: { label: commands.label, empty: commands.empty },
    plan:
      commandProvider?.composer &&
      "plan" in commandProvider.composer &&
      commandProvider.composer.plan &&
      planState.available
        ? {
            option: planOption,
            query: slashPlanQuery,
            strip: stripSlashPlan,
            enter: () => controls.current?.plan() ?? false,
          }
        : undefined,
    onChoose: setMessage,
  });
  const openPanel = (panel: AgentKibPanel, command?: string) => {
    if (panel === "settings") {
      const target =
        command === "permissions"
          ? "permissions"
          : command === "status"
            ? "usage"
            : command === "effort"
              ? "effort"
              : "models";
      if (target === "usage" && limitedUsage.current) {
        limitedUsage.current.open();
        return true;
      }
      return controls.current?.open(target) ?? false;
    }
    if (panel === "goal") return controls.current?.open(panel) ?? false;
    if (!panels) return false;
    if (panel === "files") panels.setFilesOpen(true);
    else panels.setActionsOpen(true);
    return true;
  };
  useEffect(() => {
    setResources([]);
    if (!restrictedPlan) setAddMenuScope(undefined);
    setSubmitted(false);
    firstMessage.current = undefined;
    submitPending.current = false;
    setError("");
    setCommandNotice(undefined);
    return () => {
      generation.current++;
    };
  }, [selected, setComposerText, draftAuthority, restrictedPlan]);
  useEffect(() => {
    if (!restrictedPlan && (!canChooseAttachments || fullAccess)) setAddMenuScope(undefined);
  }, [restrictedPlan, canChooseAttachments, fullAccess]);
  useEffect(() => {
    if (!access?.device || slotsGranted) return;
    setResources((items) => (items.length ? [] : items));
    discardStartupGoal();
  }, [access?.device?.id, slotsGranted, discardStartupGoal]);
  useEffect(() => {
    if (!submitted) return;
    if (notice === "accepted") {
      clearUploads();
      setResources([]);
      setHistoryReferences?.([]);
      setMessage("");
      setSubmitted(false);
    } else if (notice === "notDispatched") setSubmitted(false);
  }, [notice, submitted, setMessage, setHistoryReferences, clearUploads]);
  useEffect(() => {
    if (!online || !controlReady || busy || submitted || capabilities?.sessionId !== selected)
      return;
    const draft = session.takeContinuationDraft?.(selected);
    if (!draft) return;
    setResources(continuationResources(draft.resources));
    if (!draft.files.length) return;
    if (uploadPermission) void add(draft.files);
    else {
      keepUnavailable(draft.files);
      setError(reason(capabilities.features.attachments?.reason));
    }
  }, [
    selected,
    online,
    controlReady,
    capabilities?.sessionId,
    uploadPermission,
    busy,
    submitted,
    session.takeContinuationDraft,
  ]);
  // A session just started from the new-session composer brings its first message. It goes out
  // once, as soon as this session can take it; a failed upload, a send that cannot go now or an
  // edit leaves it here as the draft.
  useEffect(() => {
    if (!online || !controlReady || busy || submitted || capabilities?.sessionId !== selected)
      return;
    const draft = takeNewSessionDraft(selected);
    if (!draft) return;
    setMessage(draft.text);
    setResources(draft.resources ?? []);
    loadStartupGoal(draft, draft.send);
    const hasMessage = !!draft.text.trim() || draft.files.length > 0;
    firstMessage.current =
      draft.send && hasMessage ? { sessionId: selected, text: draft.text } : undefined;
    if (!draft.files.length) return;
    if (uploadPermission) void add(draft.files);
    else {
      firstMessage.current = undefined;
      keepUnavailable(draft.files);
      setError(
        sessionReason(
          locale,
          capabilities.features.attachments?.reason,
          "desktop",
          platformCopy.unavailableReason,
        ).text,
      );
    }
  }, [
    loadStartupGoal,
    selected,
    online,
    controlReady,
    capabilities?.sessionId,
    uploadPermission,
    busy,
    submitted,
    setMessage,
  ]);
  const draftReason = composerDraftUnavailableReason(selected, capabilities, access?.device, {
    attachments: uploads.length > 0,
    references: resources.length > 0,
    goal: !!startupGoal,
  });
  const ready =
    !draftReason &&
    uploads.every((item) => !!item.result) &&
    resources.every((item) => item.available);
  const attachmentIds = uploads.flatMap((item) => (item.result ? [item.result.id] : []));
  const resourceIds = resources.filter((item) => item.available).map((item) => item.id);
  const draft = composerValue;
  const valid = ready && validHistoryMessage(draft, historyReferences, attachmentIds.length > 0);
  const queuePanel =
    current?.id === selected ? registeredSessionQueue(current.agent, provider) : undefined;
  const turnNotice = sessionTurnNotice({
    current,
    selected,
    live,
    refused: notice === "notDispatched" ? session.noticeReason : undefined,
  });
  const RegisteredTurnNotice = turnNotice?.Component;
  const serialQueue = queuePanel?.surface === "managed" && queuePanel.serial;
  const queueDraftAllowed =
    !serialQueue ||
    (!!draft.trim() && !historyReferences.length && !attachmentIds.length && !resourceIds.length);
  const queueAddOffered = queuePanel?.actions.includes("add") === true;
  const queueCapabilities = capabilities?.sessionId === selected ? capabilities : undefined;
  const queueAdd = queueCapabilities?.features["queue-add"];
  const steer = queueCapabilities?.features.steer;
  const steerOffered = current?.id === selected && registeredRunningSteer(provider);
  const steerReady = steerOffered && queueAccessGranted(access) && steer?.available === true;
  const queueAddReady =
    queueDraftAllowed &&
    queueActionGranted(queuePanel, "add", access) &&
    queueAdd?.available === true;
  const resourceNeedsMessage =
    resourceIds.length > 0 && !draft.trim() && !attachmentIds.length && !historyReferences.length;
  const panelShortcut = composerPanelShortcut(draft, localSettings, localGoal);
  const decision = commands.parse(draft);
  const localCommandReady =
    draftReady &&
    !attachmentIds.length &&
    !resourceIds.length &&
    !historyReferences.length &&
    (!!panelShortcut ||
      (!settingsOnlyBlocked &&
        !!decision &&
        ((localSettings &&
          composerCapabilities.settingsWritable &&
          (decision.localControl === "model" || decision.localControl === "effort") &&
          (!decision.args || controlReady)) ||
          (localGoal &&
            decision.localControl === "goal" &&
            (controlReady ||
              (composerCapabilities.goalDraftOffered &&
                composerCapabilities.feature("goal-set")?.available !== true))))));
  async function send(action: "send" | "steer" | "queue-add") {
    if (
      !valid ||
      (action === "queue-add" && !queueAddReady) ||
      (action === "steer" && !steerReady) ||
      (startupGoal && action !== "send") ||
      !online ||
      (settingsOnlyBlocked && !(action === "send" && panelShortcut && localCommandReady)) ||
      draftUnknown ||
      busy ||
      submitted ||
      submitPending.current ||
      (live?.activity === "compacting" && action !== "queue-add")
    )
      return;
    // Client command actions use a standalone send. Refusals keep the user's draft.
    const plain =
      action === "send" &&
      !attachmentIds.length &&
      !resourceIds.length &&
      !historyReferences.length;
    const panel = plain
      ? panelShortcut
        ? panelShortcut === "goal"
          ? "goal"
          : "settings"
        : decision?.panel
      : null;
    if (panel && openPanel(panel, panelShortcut ?? decision?.command)) {
      setCommandNotice(undefined);
      setMessage("");
      return;
    }
    if (plain && panelShortcut) return;
    const mapped = plain ? decision?.action : undefined;
    if (
      mapped?.action === "goal-set" &&
      draftReady &&
      localGoal &&
      composerCapabilities.goalDraftOffered &&
      composerCapabilities.feature("goal-set")?.available !== true
    ) {
      const goalDraft = parseGoalDraft(mapped.fields.objective, "");
      if (!goalDraft) {
        if (decision?.invalidGoalReason)
          setCommandNotice({ draft, reason: decision.invalidGoalReason });
        return;
      }
      stageGoal(goalDraft);
      setCommandNotice(undefined);
      setMessage("");
      return;
    }
    if (!controlReady || (action === "send" && (!mapped || mapped.action === "send") && !canSend))
      return;
    const refusal = decision?.refusal;
    if (refusal && !(mapped && feature(mapped.action)?.available)) {
      setCommandNotice({
        draft,
        reason: decision.refusalReason ?? refusal,
      });
      return;
    }
    // `/plan <message>` keeps the message for the turn that runs in Plan mode.
    const keptDraft = mapped && "draft" in mapped ? mapped.draft : undefined;
    setCommandNotice(undefined);
    const requestGeneration = generation.current;
    submitPending.current = true;
    setSubmitted(true);
    try {
      // `/review` and `/init` go out as a message AgentKib writes, in the reader's language.
      const result =
        mapped?.action === "send"
          ? await control("send", undefined, undefined, undefined, undefined, {
              prompt: commandPrompt(locale, mapped.prompt),
            })
          : mapped
            ? await runSessionAction(mapped.action, "fields" in mapped ? mapped.fields : undefined)
            : action === "send"
              ? await control("send", undefined, undefined, undefined, undefined, {
                  attachmentIds,
                  ...(startupGoal ? { requiresGoal: true } : {}),
                  ...(resourceIds.length ? { resourceIds } : {}),
                })
              : await runSessionAction(action, {
                  text: draft.trim(),
                  ...(historyReferences.length
                    ? { historyReferences: historyReferences.map((item) => item.reference) }
                    : {}),
                  ...(attachmentIds.length ? { attachmentIds } : {}),
                  ...(resourceIds.length ? { resourceIds } : {}),
                  ...(action === "steer" ? { turnId: live?.turnId } : {}),
                });
      if (result && requestGeneration === generation.current) {
        if (action === "send" && !mapped) confirmFirstMessage(live?.revision);
        clearUploads();
        setResources([]);
        setHistoryReferences?.([]);
        setComposerText("");
        setMessage(keptDraft ?? "");
        setSubmitted(false);
      }
    } finally {
      if (requestGeneration === generation.current) submitPending.current = false;
    }
  }
  const running = live?.status === "running" && display.continuation !== "dsh-observed";
  const connectionToastId = useId();
  const connectionFailure =
    !canSend && !running && !compacting && display.reason === reason("codex-connection-failed");
  useEffect(() => {
    if (!connectionFailure) return;
    notifications.error(display.reason, { id: connectionToastId });
    return () => {
      notifications.dismiss(connectionToastId);
    };
  }, [connectionFailure, connectionToastId, display.reason, notifications, selected]);
  const canSubmit = online && controlReady && canSend && !settingsOnlyBlocked;
  useEffect(() => {
    const first = firstMessage.current;
    if (!first) return;
    // The draft reaches the composer a render after it is taken; only a change after that is an edit.
    if (composerValue === first.text) first.shown = true;
    if (first.sessionId !== selected || (first.shown && composerValue !== first.text) || error) {
      firstMessage.current = undefined;
      return;
    }
    if (!first.shown) return;
    if (!ready || !valid || !canSubmit || compacting || submitted || submitPending.current) return;
    firstMessage.current = undefined;
    void send("send");
  });
  const canAdvanced = !!(
    access?.device?.advancedControl &&
    controlReady &&
    online &&
    !busy &&
    !settingsOnlyBlocked
  );
  // Send, and Enter, take the device's running choice when a direct send cannot go now.
  const runningReady =
    (running || compacting) &&
    !(canSubmit && !compacting) &&
    canAdvanced &&
    !startupGoal &&
    (runningAction === "queue-add" ? queueAddReady : steerReady) &&
    !(compacting && runningAction === "steer") &&
    valid &&
    !submitted;
  const runningLabel = runningAction === "steer" ? copy.steer : copy.queueAdd;
  const primaryAction =
    canStop &&
    sessionStopCapabilityAllows(
      live,
      capabilities,
      selected,
      sessionProviderDeclaration(current?.agent),
    ) ? (
      <ComposerPrimaryAction kind="stop" label={t.stop} onStop={() => void control("stop")} />
    ) : (
      <ComposerPrimaryAction
        label={runningReady ? runningLabel : t.send}
        title={draftReason ? reason(draftReason) : runningReady ? runningLabel : undefined}
        disabled={
          ((!canSubmit || compacting) && !runningReady && !localCommandReady) || !valid || submitted
        }
      />
    );
  const showQueueAdd = queueAddOffered && (serialQueue || running || compacting);
  const showSteer = steerOffered && (running || compacting);
  const canQueueNext = canAdvanced && !startupGoal && queueAddReady && valid && !submitted;
  const canSteerNext =
    !compacting && canAdvanced && !startupGoal && steerReady && valid && !submitted;
  const advancedActions =
    showQueueAdd || showSteer ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={copy.advanced}
          title={copy.advanced}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{copy.advanced}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {showSteer && (
              <DropdownMenuItem
                className="data-disabled:pointer-events-auto"
                disabled={!canSteerNext}
                title={
                  canSteerNext
                    ? undefined
                    : compacting
                      ? contextUsageCopyForSurface(locale, surface).compactingDetail
                      : reason(draftReason || steer?.reason || queueCapabilities?.reason)
                }
                onClick={() => canSteerNext && void send("steer")}
              >
                <CornerDownRight size={16} aria-hidden="true" />
                {copy.steer}
              </DropdownMenuItem>
            )}
            {showQueueAdd && (
              <DropdownMenuItem
                className="data-disabled:pointer-events-auto"
                disabled={!canQueueNext}
                title={
                  canQueueNext
                    ? undefined
                    : reason(draftReason || queueAdd?.reason || queueCapabilities?.reason)
                }
                onClick={() => canQueueNext && void send("queue-add")}
              >
                <ListPlus size={16} aria-hidden="true" />
                {copy.queueAdd}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
          {showQueueAdd && (
            <>
              <DropdownMenuSeparator />
              <p className="px-1.5 py-1 text-xs leading-5 text-muted-foreground">{layout.queue}</p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  if (
    resume?.loadResumeCommand &&
    display.continuation === "view-only" &&
    !composerCapabilities.settingsReadable &&
    !composerCapabilities.resourcesReadable &&
    !localGoal &&
    !uploads.length &&
    !resources.length &&
    !startupGoal
  ) {
    return (
      <SessionReadOnly
        session={session}
        reason={connectionReasonShown ? undefined : display.reason}
        local={surface === "desktop"}
        notify={notifications.success}
      />
    );
  }
  return (
    <div className="relative w-full max-w-3xl shrink-0 self-center space-y-2">
      {display.continuation === "busy" && resume && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {continuation.busyHint(resume.busyActor)}
        </p>
      )}
      {!terminalInteraction && display.continuation === "terminal-watch" && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {continuation.terminalWatch}
        </p>
      )}
      {terminalInteraction && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {terminalInteraction}
        </p>
      )}
      {isClaude &&
        live?.sessionId === selected &&
        (live.executionMode !== "claude-follower" ||
          (!composerCapabilities.reservesPermissionSlot &&
            !composerCapabilities.settingsAccessDenied)) && (
          <PermissionModeNotice permission={live.permission} locale={locale} compact />
        )}
      {provider && !("controls" in provider) && (
        <TurnNotice
          live={live}
          locale={locale}
          surface={surface}
          onUsageLimitCancel={() => void runSessionAction("usage-limit-cancel")}
          onUsageLimitArm={() => void runSessionAction("usage-limit-continue")}
        />
      )}
      {turnNotice && RegisteredTurnNotice && (
        <RegisteredTurnNotice
          key={selected}
          reason={turnNotice.reason}
          reasonCopy={(locale, code, surface) =>
            sessionReason(locale, code, surface, platformCopy.unavailableReason)
          }
          locale={locale}
          sessionId={surface === "desktop" ? selected : undefined}
        />
      )}
      {queuePanel?.surface === "managed" && (
        <SessionSendQueue
          session={session}
          key={JSON.stringify([selected, access?.bootId, access?.device?.id])}
          agent={queuePanel.agent}
        />
      )}
      <SessionComposerInput
        editorContextKey={selected}
        onSubmit={() => {
          if (localCommandReady || (canSubmit && !compacting)) void send("send");
          else if (runningReady) void send(runningAction);
        }}
        editor={{
          id: "message",
          "aria-label": t.message,
          value: composerValue,
          maxLength: MAX_MESSAGE_LENGTH,
          onChange: (event) => setMessage(event.currentTarget.value),
          placeholder: planState.on
            ? copy.planPlaceholder
            : resume
              ? continuation.placeholder
              : t.message,
          onFocus: () => {
            if (resume?.refreshOccupancy) void session.checkContinuation?.();
          },
          disabled: (busy && !settingsOnlyBlocked) || submitted,
          ...slash.inputProps,
        }}
        onEditorKeyDown={slash.onKeyDown}
        canSubmitFromKeyboard={() =>
          (localCommandReady || (canSubmit && !compacting) || runningReady) &&
          valid &&
          !submitPending.current
        }
        attachments={{
          inputRef: fileInput,
          label: copy.attachment,
          disabled: !uploadPermission || busy || submitted,
          onFiles: (files) => void add(files),
        }}
        afterEditor={
          <>
            {slash.menu}
            <HistoryReferenceChips
              access={access}
              locale={locale}
              references={historyReferences}
              message={message}
              disabled={busy || notice === "uncertain"}
              onRemove={(item) =>
                setHistoryReferences?.(historyReferences.filter((entry) => entry !== item))
              }
            />
            {uploads.length > 0 && (
              <ul className="space-y-2">
                {uploads.map((item) => (
                  <li key={item.key} className="flex items-center gap-2 text-xs">
                    {item.previewUrl && (
                      <Button
                        type="button"
                        variant="outline"
                        className="size-11 shrink-0 overflow-hidden p-0"
                        aria-label={`${copy.previewAttachment}: ${item.name}`}
                        onClick={() => setPreviewKey(item.key)}
                      >
                        <img
                          src={item.previewUrl}
                          alt=""
                          className="size-full object-cover"
                          onError={() => unavailablePreview(item.key)}
                        />
                      </Button>
                    )}
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span role="status">
                      {item.failed
                        ? copy.uploadFailed
                        : item.result
                          ? "100%"
                          : `${copy.uploading} ${item.percent}%`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="size-11 shrink-0 p-0"
                      aria-label={`${copy.remove}: ${item.name}`}
                      disabled={busy || submitted}
                      onClick={() => void remove(item)}
                    >
                      <X size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {preview?.previewUrl && (
              <SessionDialog
                title={`${copy.previewAttachment}: ${preview.name}`}
                closeLabel={copy.close}
                onClose={() => setPreviewKey(undefined)}
              >
                <img
                  src={preview.previewUrl}
                  alt={preview.name}
                  className="mx-auto max-h-[65dvh] max-w-full object-contain"
                  onError={() => unavailablePreview(preview.key)}
                />
              </SessionDialog>
            )}
          </>
        }
        toolbar={
          <ComposerToolbarContents spaced={surface === "desktop"}>
            {access?.device?.accessMode === "full" && (
              <Controls
                session={session}
                composerCapabilities={composerCapabilities}
                controlsRef={controls}
                onPlan={setPlanState}
                resources={resources}
                setResources={setResources}
                openPhoneFiles={() => fileInput.current?.click()}
                disabled={busy || submitted || !online}
                action={primaryAction}
                advancedActions={advancedActions}
                startupGoal={startupGoal}
                onStageGoal={stageGoal}
                onStartupGoalHandled={startupGoalHandled}
                onStartupGoalDiscarded={discardStartupGoal}
              />
            )}
            {access?.device?.accessMode !== "full" && (
              <SessionComposerToolbar
                locale={locale}
                add={{
                  label: copy.addContext,
                  disabled: !canOpenAddMenu,
                  disabledReason: canOpenAddMenu
                    ? undefined
                    : showLimitedPlan
                      ? limitedPlanReason
                      : uploadPermission
                        ? undefined
                        : attachmentsReason,
                  open: canOpenAddMenu && addMenuScope === addActionsScope,
                  onOpenChange: (open) => setAddMenuScope(open ? addActionsScope : undefined),
                  attachment: uploadPermission
                    ? {
                        disabled: !canChooseAttachments,
                        reason: copy.attachmentNote,
                        onPick: () => fileInput.current?.click(),
                      }
                    : undefined,
                  plan: showLimitedPlan
                    ? {
                        active: limitedPlanOn,
                        disabled: !canChangeLimitedPlan,
                        reason: canChangeLimitedPlan ? undefined : limitedPlanReason,
                        onToggle: changeLimitedPlan,
                      }
                    : undefined,
                }}
                plan={
                  showLimitedPlan && limitedPlanOn
                    ? {
                        disabled: !canChangeLimitedPlan,
                        onRemove: changeLimitedPlan,
                      }
                    : undefined
                }
                actions={advancedActions}
                usage={
                  <ContextUsage
                    session={session}
                    surface={surface}
                    usageRef={restrictedPlan ? limitedUsage : undefined}
                  />
                }
                action={primaryAction}
              />
            )}
            {planWriteStatus && (
              <p role="status" className="px-3 text-xs text-muted-foreground">
                {planWriteStatus}
              </p>
            )}
          </ComposerToolbarContents>
        }
      />
      {!isClaude && access?.device?.accessMode !== "full" && (
        <Disclosure className="px-3 text-xs text-muted-foreground">
          <DisclosureSummary className="min-h-11 cursor-pointer content-center">
            {layout.help}
          </DisclosureSummary>
          <p className="pb-2 leading-5">{copy.composerHint}</p>
        </Disclosure>
      )}
      {/* These come and go. Floating above the composer, they never move it. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 mb-2 flex flex-col gap-2">
        {resources.some((item) => !item.available) && (
          <p role="status" className={`${floatingNotice} bg-background text-muted-foreground`}>
            {copy.resourceRemoved}
          </p>
        )}
        {resourceNeedsMessage && (
          <p role="status" className={`${floatingNotice} bg-background text-muted-foreground`}>
            {layout.resourceNeedsMessage}
          </p>
        )}
        {error && (
          <p role="alert" className={`${floatingNotice} bg-background text-destructive-text`}>
            {error}
          </p>
        )}
        {commandNotice?.draft === draft && (
          <p role="status" className={`${floatingNotice} bg-background text-muted-foreground`}>
            {reason(commandNotice.reason)}
          </p>
        )}
        {(!canSend || display.continuation === "status-unknown") &&
          !connectionReasonShown &&
          !(connectionStatusInBanner && isClaude) &&
          (!running || (live?.executionMode === "claude-follower" && display.tone === "warning")) &&
          !compacting &&
          !connectionFailure &&
          display.reason &&
          !display.loading && (
            <div
              role="status"
              className={`${floatingNotice} flex min-w-0 items-start gap-2 ${
                display.tone === "warning"
                  ? "border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  : "bg-background text-muted-foreground"
              }`}
            >
              {display.tone === "warning" && (
                <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0">
                {display.continuation === "status-unknown" && `${display.label} · `}
                {display.reason}
              </span>
            </div>
          )}
      </div>
    </div>
  );
}

function ComposerToolbarContents({ spaced, children }: { spaced: boolean; children: ReactNode }) {
  return spaced ? <div className="space-y-2">{children}</div> : children;
}
