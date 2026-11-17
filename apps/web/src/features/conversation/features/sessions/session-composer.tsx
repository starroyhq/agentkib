import { continuationResources } from "./continuation-draft";
import { takeNewSessionDraft } from "./new-session-draft";
import {
  agentKibCommand,
  agentKibPanel,
  claudeSlashOptions,
  codexCommandPrompt,
  codexSlashOptions,
  ComposerModeChip,
  ComposerPrimaryAction,
  ComposerToolbar,
  SessionComposerAddMenu,
  SessionComposerInput,
  useNewSessionGoalDraft,
  dshSlashOptions,
  planSlashOption,
  slashCommandCopy,
  sessionContinuationCopy,
  SessionContinuationReturned,
  SessionContinuationTerminal,
  unsupportedEffortReason,
  useSlashCommandMenu,
  type AgentKibPanel,
} from "@agentkib/session-ui";
import { SessionBusyChoice } from "./session-busy-choice";
import { SessionReadOnly } from "./session-read-only";
import { runningSendAction, useSendWhileRunning } from "../preferences/send-while-running";
import { claudeConnectionCopyForSurface } from "./claude-connection-copy";
import { DshQueue } from "./dsh-queue";
import { HistoryReferenceChips } from "../history/history-search-controls";
import { validHistoryMessage } from "../history/history-reference-model";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CornerDownRight, ListPlus, MoreHorizontal, X } from "lucide-react";
import {
  CODEX_MENU_COMMANDS,
  claudeCommandDecision,
  claudeMenuCommands,
  codexCommandDecision,
  dshMenuCommands,
  type UploadedAttachment,
} from "@agentkib/web-client";
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

type Upload = {
  key: string;
  name: string;
  file?: File;
  percent: number;
  result?: UploadedAttachment;
  failed?: boolean;
  previewUrl?: string;
};
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
  const returnKey = JSON.stringify([selected, live?.ownershipReason, live?.reason]);
  const [returnedFor, setReturnedFor] = useState<string | null>(null);
  useEffect(() => setReturnedFor(null), [returnKey]);
  const copy = codexCopyForSurface(locale, "web");
  const layout = composerLayoutCopy[locale];
  const display = sessionDisplayState(session, "web");
  const composerValue = message;
  const setComposerText = setMessage;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const submitPending = useRef(false);
  // While the agent runs, Send queues the message or adds it to the running turn, as this
  // device chose in preferences; the menu beside Send offers both either way.
  const runningAction = runningSendAction(useSendWhileRunning());
  const [error, setError] = useState("");
  const [resources, setResources] = useState<CodexResource[]>([]);
  const {
    value: startupGoal,
    load: loadStartupGoal,
    confirmFirstMessage,
    stage: stageGoal,
    handled: startupGoalHandled,
    discard: discardStartupGoal,
  } = useNewSessionGoalDraft(selected);
  const [previewKey, setPreviewKey] = useState<string>();
  const previewUrls = useRef(new Map<string, string>());
  const active = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);
  const [addMenuScope, setAddMenuScope] = useState<string>();
  const count = useRef(0);
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
  const commandOptions = useMemo(
    () =>
      isCodex
        ? codexSlashOptions(CODEX_MENU_COMMANDS, locale)
        : !commandCatalog
          ? []
          : isDsh
            ? dshSlashOptions(dshMenuCommands(commandCatalog, fullAccess))
            : claudeSlashOptions(claudeMenuCommands(commandCatalog, COMMAND_OWNER), locale),
    [isCodex, isDsh, commandCatalog, fullAccess, locale],
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
    enabled:
      (isClaude || isCodex || (isDsh && commandOptions.length > 0)) &&
      online &&
      controlReady &&
      !busy &&
      !submitted,
    // Codex's menu is AgentKib's own list; Claude Code's comes from the CLI, DSH's from DSH.
    catalogKnown: isCodex || !!commandCatalog?.length,
    locale,
    label: isCodex
      ? slashCommandCopy(locale).codexLabel
      : isDsh
        ? slashCommandCopy(locale).dshLabel
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
    const controllers = active.current;
    const urls = previewUrls.current;
    setUploads([]);
    setResources([]);
    setSubmitted(false);
    submitPending.current = false;
    setError("");
    setCommandNotice(undefined);
    setPreviewKey(undefined);
    count.current = 0;
    return () => {
      generation.current++;
      for (const abort of controllers.values()) abort.abort();
      controllers.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [selected, setComposerText]);
  useEffect(() => {
    if (access?.device?.attachments && live?.executionMode !== "claude-follower") return;
    for (const abort of active.current.values()) abort.abort();
    active.current.clear();
    for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setPreviewKey(undefined);
    count.current = 0;
    setUploads([]);
  }, [access?.device?.attachments, live?.executionMode, live?.connectionGeneration]);
  useEffect(() => {
    if (!submitted) return;
    if (notice === "accepted") {
      for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
      previewUrls.current.clear();
      setPreviewKey(undefined);
      setUploads([]);
      setResources([]);
      setHistoryReferences?.([]);
      count.current = 0;
      setMessage("");
      setSubmitted(false);
    } else if (notice === "notDispatched") setSubmitted(false);
  }, [notice, submitted, setMessage, setHistoryReferences]);
  function releasePreview(key: string) {
    const url = previewUrls.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previewUrls.current.delete(key);
    setPreviewKey((current) => (current === key ? undefined : current));
  }
  function unavailablePreview(key: string) {
    releasePreview(key);
    setUploads((items) =>
      items.map((item) => (item.key === key ? { ...item, previewUrl: undefined } : item)),
    );
  }
  async function add(files: File[]) {
    if (!uploadPermission || busy || submitted) return;
    setError("");
    for (const file of files) {
      if (count.current >= 10) {
        setError(copy.limit);
        break;
      }
      count.current++;
      const key = crypto.randomUUID();
      const abort = new AbortController();
      // Only local raster files are rendered, through <img>. Documents and SVG
      // remain ordinary attachments; no remote URL or executable preview is opened.
      const previewUrl =
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) &&
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : undefined;
      if (previewUrl) previewUrls.current.set(key, previewUrl);
      active.current.set(key, abort);
      setUploads((items) => [...items, { key, name: file.name, file, percent: 0, previewUrl }]);
      void client
        .uploadAttachment(
          selected,
          file,
          (percent) =>
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent } : item)),
            ),
          abort.signal,
        )
        .then((result) => {
          if (!abort.signal.aborted)
            setUploads((items) =>
              items.map((item) => (item.key === key ? { ...item, percent: 100, result } : item)),
            );
        })
        .catch(() => {
          if (!abort.signal.aborted) {
            releasePreview(key);
            setUploads((items) =>
              items.map((item) =>
                item.key === key ? { ...item, failed: true, previewUrl: undefined } : item,
              ),
            );
            setError(copy.uploadFailed);
          }
        })
        .finally(() => active.current.delete(key));
    }
  }
  useEffect(() => {
    if (!online || !controlReady || busy || submitted || capabilities?.sessionId !== selected)
      return;
    const draft = session.takeContinuationDraft?.(selected);
    if (!draft) return;
    setResources(continuationResources(draft.resources));
    if (!draft.files.length) return;
    if (uploadPermission) void add(draft.files);
    else {
      count.current = draft.files.length;
      setUploads(
        draft.files.map((file) => ({
          key: crypto.randomUUID(),
          name: file.name,
          file,
          percent: 0,
          failed: true,
        })),
      );
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
  const firstMessage = useRef<{ sessionId: string; text: string; shown?: boolean }>(undefined);
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
      count.current = draft.files.length;
      setUploads(
        draft.files.map((file) => ({
          key: crypto.randomUUID(),
          name: file.name,
          file,
          percent: 0,
          failed: true,
        })),
      );
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
  async function remove(item: Upload) {
    const requestGeneration = generation.current;
    active.current.get(item.key)?.abort();
    active.current.delete(item.key);
    releasePreview(item.key);
    count.current = Math.max(0, count.current - 1);
    setUploads((items) => items.filter((entry) => entry.key !== item.key));
    if (item.result) {
      try {
        await client.request("attachments/delete", {
          sessionId: selected,
          attachmentId: item.result.id,
          version: item.result.version,
        });
      } catch {
        if (requestGeneration === generation.current) setError(copy.error);
      }
    }
  }
  const ready = uploads.every((item) => !!item.result) && resources.every((item) => item.available);
  const attachmentIds = uploads.flatMap((item) => (item.result ? [item.result.id] : []));
  const resourceIds = resources.filter((item) => item.available).map((item) => item.id);
  const draft = composerValue;
  const valid = ready && validHistoryMessage(draft, historyReferences, attachmentIds.length > 0);
  const resourceNeedsMessage =
    resourceIds.length > 0 && !draft.trim() && !attachmentIds.length && !historyReferences.length;
  async function send(action: "send" | "steer" | "queue-add") {
    if (
      !valid ||
      !online ||
      !controlReady ||
      busy ||
      submitted ||
      submitPending.current ||
      (live?.activity === "compacting" && action !== "queue-add")
    )
      return;
    // The host refuses these too; deciding here keeps the draft and explains it without a
    // round trip, and runs or opens AgentKib's own control for the commands it has one for.
    const decision = isClaude
      ? claudeCommandDecision(draft, { owner: COMMAND_OWNER, commands: commandCatalog })
      : null;
    // Codex's own commands work only in its terminal UI; nothing is sent for them. Steering or
    // queueing one is refused like sending one with attachments: its action runs only on send.
    const codexCommand = isCodex ? codexCommandDecision(draft) : null;
    const plain =
      action === "send" &&
      !attachmentIds.length &&
      !resourceIds.length &&
      !historyReferences.length;
    const panel = plain
      ? decision
        ? agentKibPanel(decision)
        : (codexCommand?.panel ?? null)
      : null;
    if (panel && openPanel(panel, decision?.command ?? codexCommand?.command)) {
      setCommandNotice(undefined);
      setMessage("");
      return;
    }
    const mapped = plain
      ? decision?.refusal
        ? agentKibCommand(decision)
        : (codexCommand?.action ?? null)
      : null;
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
        for (const url of previewUrls.current.values()) URL.revokeObjectURL(url);
        previewUrls.current.clear();
        setPreviewKey(undefined);
        setUploads([]);
        setResources([]);
        setHistoryReferences?.([]);
        count.current = 0;
        setComposerText("");
        setMessage(keptDraft ?? "");
        setSubmitted(false);
      }
    } finally {
      if (requestGeneration === generation.current) submitPending.current = false;
    }
  }
  const preview = uploads.find((item) => item.key === previewKey && item.previewUrl);
  const running = live?.status === "running";
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
    !!capabilities?.features[runningAction]?.available &&
    !(compacting && runningAction === "steer") &&
    valid &&
    !submitted;
  const runningLabel = runningAction === "steer" ? copy.steer : copy.queueAdd;
  const primaryAction =
    canStop && live?.executionMode !== "claude-follower" ? (
      <ComposerPrimaryAction kind="stop" label={t.stop} onStop={() => void control("stop")} />
    ) : (
      <ComposerPrimaryAction
        label={runningReady ? runningLabel : t.send}
        title={runningReady ? runningLabel : undefined}
        disabled={((!canSubmit || compacting) && !runningReady) || !valid || submitted}
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
  if ((isCodex || isClaude) && display.continuation === "busy")
    return returnedFor === returnKey ? (
      <div className="w-full max-w-3xl self-center">
        <SessionContinuationReturned
          locale={locale}
          agent={isClaude ? "Claude Code" : "Codex"}
          hasDraft={Boolean(
            message.trim() || uploads.length || resources.length || historyReferences.length,
          )}
        />
      </div>
    ) : (
      <SessionBusyChoice
        onReturn={() => setReturnedFor(returnKey)}
        composerDraft={() => ({
          files: uploads.flatMap((item) => (item.file ? [item.file] : [])),
          resources,
        })}
      />
    );
  if ((isCodex || isClaude) && display.continuation === "view-only")
    return <SessionReadOnly reason={display.reason} />;
  if (isClaude && display.continuation === "terminal-watch")
    return (
      <div className="w-full max-w-3xl shrink-0 self-center">
        <SessionContinuationTerminal locale={locale} />
      </div>
    );
  return (
    <div className="relative w-full max-w-3xl shrink-0 self-center space-y-2">
      {isClaude && display.continuation === "terminal" && (
        <p className="px-3 text-xs leading-5 text-muted-foreground">{continuation.terminalHint}</p>
      )}
      {isClaude && <PermissionModeNotice permission={live?.permission} locale={locale} compact />}
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
          if (canSubmit && !compacting) void send("send");
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
          ((canSubmit && !compacting) || runningReady) && valid && !submitPending.current
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
              <ComposerToolbar
                leading={
                  <>
                    <SessionComposerAddMenu
                      locale={locale}
                      label={copy.addContext}
                      disabled={!canOpenAddMenu}
                      disabledReason={
                        canOpenAddMenu
                          ? undefined
                          : showLimitedPlan
                            ? limitedPlanReason
                            : uploadPermission
                              ? undefined
                              : attachmentsReason
                      }
                      open={canOpenAddMenu && addMenuScope === addActionsScope}
                      onOpenChange={(open) => setAddMenuScope(open ? addActionsScope : undefined)}
                      attachment={
                        uploadPermission
                          ? {
                              disabled: !canChooseAttachments,
                              reason: copy.attachmentNote,
                              onPick: () => fileInput.current?.click(),
                            }
                          : undefined
                      }
                      plan={
                        showLimitedPlan
                          ? {
                              active: limitedPlanOn,
                              disabled: !canChangeLimitedPlan,
                              reason: canChangeLimitedPlan ? undefined : limitedPlanReason,
                              onToggle: changeLimitedPlan,
                            }
                          : undefined
                      }
                    />
                    {showLimitedPlan && limitedPlanOn && (
                      <ComposerModeChip
                        mode="plan"
                        locale={locale}
                        disabled={!canChangeLimitedPlan}
                        onRemove={changeLimitedPlan}
                      />
                    )}
                  </>
                }
                trailing={
                  <>
                    {advancedActions}
                    <ContextUsageGauge usageRef={limitedUsage} />
                    {primaryAction}
                  </>
                }
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
        {compacting && (
          <p role="status" className={`${floatingNotice} bg-background text-muted-foreground`}>
            {contextUsageCopyForSurface(locale, "web").compactingDetail}
          </p>
        )}
        {!canSend &&
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
              <span className="min-w-0">{display.reason}</span>
            </div>
          )}
      </div>
    </div>
  );
}
