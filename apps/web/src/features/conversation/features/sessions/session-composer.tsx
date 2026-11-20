import { continuationResources } from "./continuation-draft";
import { takeNewSessionDraft } from "./new-session-draft";
import {
  agentKibCommand,
  agentKibPanel,
  existingSessionComposerCapabilities,
  composerDraftUnavailableReason,
  sessionSlashOptions,
  composerPanelShortcut,
  codexCommandPrompt,
  ComposerPrimaryAction,
  SessionComposerToolbar,
  SessionComposerInput,
  useComposerAttachments,
  useNewSessionGoalDraft,
  planSlashOption,
  parseGoalDraft,
  slashCommandCopy,
  sessionContinuationCopy,
  claudeTerminalInteraction,
  unsupportedEffortReason,
  useSlashCommandMenu,
  type AgentKibPanel,
} from "@agentkib/session-ui";
import { SessionReadOnly } from "./session-read-only";
import { runningSendAction, useSendWhileRunning } from "../preferences/send-while-running";
import { claudeConnectionCopyForSurface } from "./claude-connection-copy";
import { DshQueue } from "./dsh-queue";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CornerDownRight, ListPlus, MoreHorizontal, X } from "lucide-react";
import { claudeCommandDecision, codexCommandDecision } from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Disclosure, DisclosureSummary } from "../../components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
import { ContextUsageGauge, type ContextUsageHandle } from "./context-usage";
import { contextUsageCopyForSurface } from "./context-usage-copy";
import { sessionDisplayState } from "./session-display-state";
import { composerLayoutCopy } from "./composer-layout-copy";
import { codexCopyForSurface, codexReason } from "./codex-copy";
import { MAX_MESSAGE_LENGTH } from "./session-model";
import {
  CodexComposerControls,
  type CodexResource,
  type ComposerControlsHandle,
  type ComposerPlanState,
} from "./codex-session-controls";
import { useSessionPanels } from "./session-panels";
import { PermissionModeNotice } from "./permission-mode-notice";
import { ManagedTurnNotice } from "./managed-turn-notice";
import { DevinTurnNotice } from "./devin-turn-notice";

// A paired browser is a remote device, which may run only some Claude Code commands.
const COMMAND_OWNER = false;
/** A notice floating above the composer. Opaque: the conversation scrolls behind it. */
const floatingNotice =
  "pointer-events-auto rounded-lg border px-3 py-2 text-xs leading-5 shadow-sm";
export function SessionComposer({
  connectionStatusInBanner = false,
}: {
  connectionStatusInBanner?: boolean;
}) {
  const session = useSession();
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
    codexAction,
    controlReady,
    capabilities,
    canSend,
    canStop,
    busy,
    online,
    notice,
  } = session;
  const isClaude = current?.agent === "claude-code";
  const isCodex = current?.agent === "codex";
  const continuation = sessionContinuationCopy(locale);
  const copy = codexCopyForSurface(locale, "web");
  const layout = composerLayoutCopy[locale];
  const display = sessionDisplayState(session, "web");
  const terminalInteraction =
    isClaude &&
    online &&
    (display.continuation === "terminal" || display.continuation === "terminal-watch")
      ? claudeTerminalInteraction(live, selected)
      : undefined;
  const composerValue = message;
  const setComposerText = setMessage;
  const [submitted, setSubmitted] = useState(false);
  const submitPending = useRef(false);
  // While the agent runs, Send queues the message or adds it to the running turn, as this
  // device chose in preferences; the menu beside Send offers both either way.
  const runningAction = runningSendAction(useSendWhileRunning());
  const [error, setError] = useState("");
  const [resources, setResources] = useState<CodexResource[]>([]);
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
  const isDsh = current?.agent === "deepseek-harness";
  const fullAccess = access?.device?.accessMode === "full";
  const addActionsScope = JSON.stringify([
    selected,
    access?.bootId,
    access?.device?.id,
    live?.connectionGeneration,
  ]);
  const compacting = live?.activity === "compacting";
  const limitedSettings =
    isCodex && !fullAccess && current.id === selected && capabilities?.sessionId === selected
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
    ? contextUsageCopyForSurface(locale, "web").compactingDetail
    : codexReason(locale, limitedSettings?.reason ?? capabilities?.reason, "web").text;
  const changeLimitedPlan = () => {
    if (canChangeLimitedPlan) void codexAction("settings", { mode: nextMode });
  };
  const settingsNotice =
    !fullAccess && isCodex && session.settingsNotice?.target === "permissions"
      ? session.settingsNotice
      : undefined;
  const planWriteStatus =
    settingsNotice?.status === "uncertain"
      ? layout.settingsUnknown
      : settingsNotice?.status === "notDispatched"
        ? settingsNotice.reason
          ? codexReason(locale, settingsNotice.reason, "web").text
          : t.notDispatched
        : undefined;
  const attachmentsReason =
    isClaude && live?.executionMode === "claude-follower"
      ? claudeConnectionCopyForSurface(locale, "web").attachments
      : capabilities?.sessionId === selected && capabilities?.features.attachments?.reason
        ? codexReason(locale, capabilities.features.attachments.reason, "web").text
        : copy.permission;
  const canChooseAttachments = uploadPermission && !busy && !submitted;
  const canOpenAddMenu = canChooseAttachments || canChangeLimitedPlan;
  const commandCatalog =
    (isClaude || isDsh) && capabilities?.sessionId === selected ? capabilities.commands : undefined;
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
  const commandOptions = useMemo(
    () =>
      sessionSlashOptions(current?.agent, commandCatalog, {
        canSend,
        claudeOwner: COMMAND_OWNER,
        dshOwner: fullAccess,
        model: localSettings,
        goal: localGoal,
        locale,
      }),
    [current?.agent, commandCatalog, canSend, localSettings, localGoal, locale, fullAccess],
  );
  // A refused command keeps its draft; the explanation goes once the draft changes.
  const [commandNotice, setCommandNotice] = useState<{ draft: string; reason: string }>();
  // A command typed without an argument opens AgentKib's control for it, as a button would.
  const controls = useRef<ComposerControlsHandle>(null);
  const limitedUsage = useRef<ContextUsageHandle>(null);
  // `/plan`, at the start or after a space, turns plan mode on as in Codex's composer. Only the
  // controls report it, and they show only with full access.
  const [reportedPlan, setPlanState] = useState<ComposerPlanState>({
    on: false,
    available: false,
  });
  const planState = fullAccess ? reportedPlan : { on: false, available: false };
  const planOption = useMemo(() => planSlashOption(locale), [locale]);
  const slash = useSlashCommandMenu({
    value: composerValue,
    options: commandOptions,
    enabled: (isClaude || isCodex || commandOptions.length > 0) && draftReady,
    // Codex's menu is AgentKib's own list; Claude Code's comes from the CLI, DSH's from DSH.
    catalogKnown: isCodex || commandOptions.length > 0 || !!commandCatalog?.length,
    locale,
    label: isCodex
      ? slashCommandCopy(locale).codexLabel
      : isDsh
        ? slashCommandCopy(locale).dshLabel
        : !isClaude && current?.agent
          ? current.agent
          : undefined,
    plan: planState.available
      ? { option: planOption, enter: () => controls.current?.plan() ?? false }
      : undefined,
    onChoose: setMessage,
  });
  const panels = useSessionPanels();
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
    setSubmitted(false);
    firstMessage.current = undefined;
    submitPending.current = false;
    setError("");
    setCommandNotice(undefined);
    return () => {
      generation.current++;
    };
  }, [selected, setComposerText, draftAuthority]);
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
      setError(codexReason(locale, capabilities.features.attachments?.reason, "web").text);
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
      setError(codexReason(locale, capabilities.features.attachments?.reason).text);
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
  const resourceNeedsMessage =
    resourceIds.length > 0 && !draft.trim() && !attachmentIds.length && !historyReferences.length;
  const panelShortcut = composerPanelShortcut(draft, localSettings, localGoal);
  const localCommand = isClaude
    ? claudeCommandDecision(draft, { owner: COMMAND_OWNER, commands: commandCatalog })
    : null;
  const localCommandReady =
    draftReady &&
    !attachmentIds.length &&
    !resourceIds.length &&
    !historyReferences.length &&
    (!!panelShortcut ||
      (!!localCommand &&
        ((localSettings &&
          composerCapabilities.settingsWritable &&
          ["model", "effort"].includes(localCommand.command) &&
          (!localCommand.args || controlReady)) ||
          (localGoal &&
            localCommand.command === "goal" &&
            (controlReady ||
              (composerCapabilities.goalDraftOffered &&
                composerCapabilities.feature("goal-set")?.available !== true))))));
  async function send(action: "send" | "steer" | "queue-add") {
    if (
      !valid ||
      (startupGoal && action !== "send") ||
      !online ||
      draftUnknown ||
      busy ||
      submitted ||
      submitPending.current ||
      (live?.activity === "compacting" && action !== "queue-add")
    )
      return;
    // The host refuses these too; deciding here keeps the draft and explains it without a
    // round trip, and runs or opens AgentKib's own control for the commands it has one for.
    const decision = localCommand;
    // Codex's own commands work only in its terminal UI; nothing is sent for them. Steering or
    // queueing one is refused like sending one with attachments: its action runs only on send.
    const codexCommand = isCodex ? codexCommandDecision(draft) : null;
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
        : decision
          ? agentKibPanel(decision)
          : (codexCommand?.panel ?? null)
      : null;
    if (panel && openPanel(panel, panelShortcut ?? decision?.command ?? codexCommand?.command)) {
      setCommandNotice(undefined);
      setMessage("");
      return;
    }
    if (plain && panelShortcut) return;
    const mapped = plain
      ? decision?.refusal
        ? agentKibCommand(decision)
        : (codexCommand?.action ?? null)
      : null;
    if (
      mapped?.action === "goal-set" &&
      draftReady &&
      localGoal &&
      composerCapabilities.goalDraftOffered &&
      composerCapabilities.feature("goal-set")?.available !== true
    ) {
      const goalDraft = parseGoalDraft(mapped.fields.objective, "");
      if (!goalDraft) {
        setCommandNotice({ draft, reason: "claude-command-goal" });
        return;
      }
      stageGoal(goalDraft);
      setCommandNotice(undefined);
      setMessage("");
      return;
    }
    if (!controlReady || (action === "send" && (!mapped || mapped.action === "send") && !canSend))
      return;
    const refusal = decision?.refusal ?? codexCommand?.refusal;
    if (refusal && !(mapped && capabilities?.features[mapped.action]?.available)) {
      setCommandNotice({
        draft,
        reason: (decision && unsupportedEffortReason(decision)) ?? refusal,
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
              prompt: codexCommandPrompt(locale, mapped.prompt),
            })
          : mapped
            ? await codexAction(mapped.action, "fields" in mapped ? mapped.fields : undefined)
            : action === "send"
              ? await control("send", undefined, undefined, undefined, undefined, {
                  attachmentIds,
                  ...(startupGoal ? { requiresGoal: true } : {}),
                  ...(resourceIds.length ? { resourceIds } : {}),
                })
              : await codexAction(action, {
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
    !canSend &&
    !running &&
    !compacting &&
    display.reason === codexReason(locale, "codex-connection-failed", "web").text;
  useEffect(() => {
    if (!connectionFailure) return;
    toast.error(display.reason, { id: connectionToastId });
    return () => {
      toast.dismiss(connectionToastId);
    };
  }, [connectionFailure, connectionToastId, display.reason, selected]);
  const canSubmit = online && controlReady && canSend;
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
  const canAdvanced = !!(access?.device?.advancedControl && controlReady && online && !busy);
  // Send, and Enter, take the device's running choice when a direct send cannot go now.
  const runningReady =
    (running || compacting) &&
    !(canSubmit && !compacting) &&
    canAdvanced &&
    !startupGoal &&
    !!capabilities?.features[runningAction]?.available &&
    !(compacting && runningAction === "steer") &&
    valid &&
    !submitted;
  const runningLabel = runningAction === "steer" ? copy.steer : copy.queueAdd;
  const primaryAction =
    canStop &&
    (live?.executionMode !== "claude-follower" ||
      composerCapabilities.feature("stop")?.available === true) ? (
      <ComposerPrimaryAction kind="stop" label={t.stop} onStop={() => void control("stop")} />
    ) : (
      <ComposerPrimaryAction
        label={runningReady ? runningLabel : t.send}
        title={
          draftReason
            ? codexReason(locale, draftReason, "web").text
            : runningReady
              ? runningLabel
              : undefined
        }
        disabled={
          ((!canSubmit || compacting) && !runningReady && !localCommandReady) || !valid || submitted
        }
      />
    );
  const advancedActions =
    (running || compacting) &&
    (live?.executionMode === "codex-follower"
      ? capabilities?.features.steer?.available === true ||
        capabilities?.features["queue-add"]?.available === true
      : !isClaude ||
        capabilities?.features.steer?.available ||
        capabilities?.features["queue-add"]?.available) ? (
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
            <DropdownMenuItem
              disabled={
                compacting ||
                !canAdvanced ||
                !!startupGoal ||
                !capabilities?.features.steer?.available ||
                !valid ||
                submitted
              }
              onClick={() => void send("steer")}
            >
              <CornerDownRight size={16} aria-hidden="true" />
              {copy.steer}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                !canAdvanced ||
                !!startupGoal ||
                !capabilities?.features["queue-add"]?.available ||
                !valid ||
                submitted
              }
              onClick={() => void send("queue-add")}
            >
              <ListPlus size={16} aria-hidden="true" />
              {copy.queueAdd}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <p className="px-1.5 py-1 text-xs leading-5 text-muted-foreground">{layout.queue}</p>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;
  if (
    (isCodex || isClaude) &&
    display.continuation === "view-only" &&
    !composerCapabilities.settingsReadable &&
    !composerCapabilities.resourcesReadable &&
    !localGoal &&
    !uploads.length &&
    !resources.length &&
    !startupGoal
  )
    return <SessionReadOnly reason={display.reason} />;
  return (
    <div className="relative w-full max-w-3xl shrink-0 self-center space-y-2">
      {display.continuation === "busy" && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {continuation.busyHint(isClaude ? "Claude Code" : "Codex")}
        </p>
      )}
      {!terminalInteraction && display.continuation === "terminal-watch" && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {continuation.terminalWatch}
        </p>
      )}
      {terminalInteraction && (
        <p role="status" className="px-3 text-xs leading-5 text-muted-foreground">
          {claudeConnectionCopyForSurface(locale, "web")[terminalInteraction]}
        </p>
      )}
      {isClaude &&
        live?.sessionId === selected &&
        (live.executionMode !== "claude-follower" ||
          (!composerCapabilities.reservesPermissionSlot &&
            !composerCapabilities.settingsAccessDenied)) && (
          <PermissionModeNotice permission={live.permission} locale={locale} compact />
        )}
      {(isClaude || isCodex || isDsh || current?.agent === "devin") && (
        <ManagedTurnNotice
          live={live}
          locale={locale}
          surface="web"
          onUsageLimitCancel={() => void codexAction("usage-limit-cancel")}
          onUsageLimitArm={() => void codexAction("usage-limit-continue")}
        />
      )}
      {current?.agent === "devin" && (
        <DevinTurnNotice
          // A refused send names its reason; a turn that ended without running leaves it on live.
          reason={
            notice === "notDispatched" && session.noticeReason
              ? session.noticeReason
              : live?.status === "idle"
                ? live.reason
                : undefined
          }
          locale={locale}
        />
      )}
      {current?.agent === "deepseek-harness" && <DshQueue key={selected} />}
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
            : isCodex || isClaude
              ? continuation.placeholder
              : t.message,
          onFocus: () => {
            if (isCodex || isClaude) void session.checkContinuation?.();
          },
          disabled: (busy && !session.settingsOnlyBlocked) || submitted,
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
            <HistoryReferenceChips />
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
              <Dialog
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
              </Dialog>
            )}
          </>
        }
        toolbar={
          <>
            {access?.device?.accessMode === "full" && (
              <CodexComposerControls
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
                usage={<ContextUsageGauge usageRef={limitedUsage} />}
                action={primaryAction}
              />
            )}
            {planWriteStatus && (
              <p role="status" className="px-3 text-xs text-muted-foreground">
                {planWriteStatus}
              </p>
            )}
          </>
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
            {codexReason(locale, commandNotice.reason, "web").text}
          </p>
        )}
        {(!canSend || display.continuation === "status-unknown") &&
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
