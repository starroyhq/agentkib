import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  ChevronDown,
  CircleX,
  Cpu,
  Folder,
  Hourglass,
  Layers,
  Search,
  Shield,
  TriangleAlert,
} from "lucide-react";
import {
  newSessionProvider,
  sessionProviderCapabilities,
  type ManagedAgent,
} from "@agentkib/web-client";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { sortSessions } from "@agentkib/session-catalog";
import {
  composerAttachmentCopy,
  ComposerAttachmentStrip,
  composerGoalCopy,
  ComposerGoalFields,
  ComposerPrimaryAction,
  SessionComposerToolbar,
  DEFAULT_NEW_SESSION_AGENT,
  fillCopy,
  IconAction,
  NEW_SESSION_AGENTS,
  NewSessionAddDraftChips,
  newSessionCopy,
  newSessionCreateFields,
  useLocalComposerAttachments,
  useNewSessionModel,
  isNewSessionPermissionFailure,
  useNewSessionPermission,
  newSessionPermissionFallbackTitle,
  newSessionAddCapabilities,
  newSessionPresetChoices,
  planSlashOption,
  SessionComposerInput,
  slashCommandCopy,
  useNewSessionAdd,
  useSlashCommandMenu,
  offerNewSessionDraft,
  type NewSessionOpenResult,
  readNewSessionTarget,
  rememberNewSessionTarget,
  type NewSessionDraft,
} from "@agentkib/session-ui";
import { Button, buttonVariants } from "@/features/conversation/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/features/conversation/components/ui/dialog";
import { Disclosure, DisclosureSummary } from "@/features/conversation/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/features/conversation/components/ui/dropdown-menu";
import { Input } from "@/features/conversation/components/ui/input";
import { cn } from "@/features/conversation/lib/utils";
import { useSession } from "@/features/conversation/web-session-context";
import { sessionCopyForSurface, sessionReason } from "@/features/conversation/session-copy";
import { composerLayoutCopy, DelayedSpinner } from "@agentkib/session-ui";
import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import type { Locale } from "@/features/conversation/i18n";
import { failureOf, useNewSession } from "./use-new-session";

const MAX_FILES = 10;
const startupSlashOptions = [] as const;
const chip =
  "h-8 min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-normal text-muted-foreground hover:text-foreground";

type Workspace = { id: string; name: string };

/** The workspaces of this browser's most recently changed sessions, newest first. */
function recentWorkspaces(
  workspaces: readonly Workspace[],
  sessions: readonly { workspace_id: string; updated_at?: string | null; id: string }[],
  limit: number,
) {
  const ids: string[] = [];
  for (const session of sortSessions(
    sessions as { id: string; workspace_id: string; agent: string; availability: string }[],
  ))
    if (!ids.includes(session.workspace_id)) ids.push(session.workspace_id);
  return ids.flatMap((id) => workspaces.filter((item) => item.id === id)).slice(0, limit);
}

/**
 * Starts a session from this browser, as the desktop composer does: the workspace and Agent above,
 * the first message with its files, permissions and model settings below. The provider chooses
 * whether the first message travels with create or through the new session's own composer.
 */
export function NewSessionComposer({
  onCreated,
  autoFocus = false,
  disabled = false,
}: {
  /** Opens the new session, or reports why the wait ended. */
  onCreated: (sessionId: string) => Promise<NewSessionOpenResult | void> | void;
  autoFocus?: boolean;
  /** The connection is lost: the draft can be written but not sent. */
  disabled?: boolean;
}) {
  const { locale, sessions, workspaces: catalogWorkspaces, access, client } = useSession();
  const fullAccess = access?.device?.accessMode === "full";
  const workspaces = useMemo(
    () => (catalogWorkspaces ?? []).filter((item) => !("remote" in item && item.remote)),
    [catalogWorkspaces],
  );
  const copy = newSessionCopy(locale);
  const conversationCopy = sessionCopyForSurface(locale, "web");
  const [target] = useState(readNewSessionTarget);
  const [agent, setAgent] = useState<ManagedAgent>(target.agent ?? DEFAULT_NEW_SESSION_AGENT);
  const [workspaceId, setWorkspaceId] = useState(target.workspaceId ?? "");
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ??
    recentWorkspaces(workspaces, sessions, 1)[0] ??
    workspaces[0];
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [planning, setPlanning] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [agentPreset, setAgentPreset] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sessionNotListed, setSessionNotListed] = useState(false);
  const draft = useRef<NewSessionDraft>({ text, files });
  // Reconciliation can finish after options have refreshed; use the mode of the submitted request.
  const sentWithPrompt = useRef(false);
  // The composer stays busy until the new session opens.
  const handOff = async (sessionId: string) => {
    setSending(true);
    const reclaimDraft = sentWithPrompt.current
      ? undefined
      : offerNewSessionDraft(sessionId, draft.current);
    try {
      const timedOut = (await onCreated(sessionId)) === "timed-out";
      setSessionNotListed(timedOut);
      if (!timedOut || !reclaimDraft?.()) {
        setText("");
        setFiles([]);
        add.clearDraftAdditions();
      }
    } finally {
      setSending(false);
    }
  };
  const session = useNewSession({
    agent,
    workspaceId: workspace?.id,
    // A create checked after its outcome was unknown opens the session it made, with this
    // composer's draft, only while that draft is still here.
    onReconciled: (sessionId, own) => {
      if (own) void handOff(sessionId);
    },
  });
  const options = session.options;
  const provider = newSessionProvider(agent, options);
  const showsModelPicker = provider?.create.modelPicker === true;
  const promptAtCreate = provider?.create.mode === "with-first-message";
  const locked = sending || session.busy;
  const advancedAccess = fullAccess && access?.device?.advancedControl === true && session.ready;
  const resourceAuthority = JSON.stringify([access?.bootId, access?.device?.id]);
  const {
    resourcesOffered,
    resourcesAllowed,
    goalsOffered,
    goalsAllowed,
    hideGoalBudget,
    planField,
    planOffered,
    offersPlan,
  } = newSessionAddCapabilities(
    options,
    sessionProviderCapabilities(agent)?.create,
    advancedAccess,
  );
  const goalCopy = composerGoalCopy(locale);
  const add = useNewSessionAdd({
    agent,
    workspaceId: workspace?.id,
    client,
    resourceAuthority,
    resourcesAllowed,
    resourcesOffered,
    locked: locked || disabled,
    offline: disabled,
    resourceError: (error) => failureOf(error, locale).reason,
    resourceReason: (code) => sessionReason(locale, code, "web").text,
  });
  const { resources, goal } = add;
  useEffect(() => {
    draft.current = {
      text,
      files,
      ...(resources.length ? { resources } : {}),
      ...(goal ? { goal } : {}),
    };
  }, [text, files, resources, goal]);
  const attachments =
    access?.device?.attachments === true &&
    (provider?.create.attachments ?? true) &&
    !promptAtCreate;
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileLimit, setFileLimit] = useState(false);
  const localAttachments = useLocalComposerAttachments(files);

  const sessionModel = useNewSessionModel({
    agent,
    workspaceId: workspace?.id,
    authority: resourceAuthority,
    options,
    provider,
  });
  const { settings: modelSettings, modelId, shownEffort, shownTier } = sessionModel;
  const permission = useNewSessionPermission(agent, options, locale, fullAccess);
  const { permissions, selected: selectedPermission, shown: shownPermission } = permission;
  const permissionUnavailable =
    permission.unavailable && !(planning && planField === "permissionMode");
  const canPickFiles = attachments && files.length < MAX_FILES;
  const addActionsScope = JSON.stringify([agent, workspace?.id, resourceAuthority]);
  const hasAddActions = attachments || planOffered || planning || resourcesOffered || goalsOffered;
  const permissionChoices = permissions?.choices.map((item) =>
    planning && planField === "permissionMode" ? { ...item, disabled: true } : item,
  );
  const { presets, defaultId: defaultPreset } = newSessionPresetChoices(
    agent,
    options,
    locale,
    provider?.create,
  );
  const preset = presets.find((item) => item.id === (agentPreset ?? defaultPreset));

  const unavailableReason = session.optionsError
    ? failureOf(session.optionsError, locale).reason
    : options && !options.available
      ? sessionReason(locale, options.reason, "web").text
      : undefined;
  const optionsLocked = locked || !options?.available;
  const hasMessage = !!text.trim() || (attachments && files.length > 0);
  const goalNeedsMessage = !!goal && !hasMessage && planning && planField === "mode";
  const resourceNeedsMessage = resources.length > 0 && !hasMessage;
  const resourceNeedsReselection = resources.some((item) => !item.available);
  const sendLabel = goal && !hasMessage ? conversationCopy.goalCreate : copy.send;
  const canSend =
    !disabled &&
    session.ready &&
    !!options?.available &&
    !!workspace &&
    (!planning || offersPlan) &&
    !locked &&
    !session.unknown &&
    !permissionUnavailable &&
    (!resources.length ||
      (resourcesAllowed && !resourceNeedsMessage && !resourceNeedsReselection)) &&
    (!goal || goalsAllowed) &&
    !goalNeedsMessage &&
    (attachments || files.length === 0) &&
    (hasMessage || !!goal);
  const changePlan = (enabled: boolean) => {
    if (locked || (enabled && !offersPlan)) return false;
    setPlanning(enabled);
    return true;
  };
  const planOption = useMemo(() => planSlashOption(locale), [locale]);
  const slash = useSlashCommandMenu({
    value: text,
    options: startupSlashOptions,
    enabled: offersPlan && !locked,
    catalogKnown: true,
    side: "bottom",
    locale,
    label: agent === "codex" ? slashCommandCopy(locale).codexLabel : undefined,
    plan: offersPlan ? { option: planOption, enter: () => changePlan(true) } : undefined,
    onChoose: setText,
  });

  async function send() {
    if (!canSend || !workspace) return;
    setSending(true);
    setSessionNotListed(false);
    const fields = newSessionCreateFields(
      {
        agent,
        workspaceId: workspace.id,
        model: sessionModel.model,
        effort: sessionModel.effort,
        serviceTierId: sessionModel.chosenTier,
        shownModel: modelId,
        permission: permission.requested,
        planning,
        preset: agentPreset,
        fullAccess,
      },
      options,
      provider?.create,
    );
    rememberNewSessionTarget({ workspaceId: workspace.id, agent });
    sentWithPrompt.current = promptAtCreate;
    const sessionId = await session.create(promptAtCreate ? { ...fields, prompt: text } : fields);
    if (sessionId) await handOff(sessionId);
    else setSending(false);
  }

  function addFiles(list: File[]) {
    if (!attachments) return;
    const room = MAX_FILES - files.length;
    setFileLimit(list.length > room);
    if (room > 0) setFiles((current) => [...current, ...list.slice(0, room)]);
  }

  const notice = session.unknown ? (
    <Notice tone="warning" icon={<Hourglass className="size-3.5" />}>
      {copy.unknown}
    </Notice>
  ) : session.failure ? (
    <Notice tone="error" icon={<CircleX className="size-3.5" />}>
      {isNewSessionPermissionFailure(session.failure.detail)
        ? session.failure.reason
        : fillCopy(copy.notCreated, { reason: session.failure.reason })}
      {session.failure.detail && (
        <Disclosure className="mt-1">
          <DisclosureSummary>{copy.details}</DisclosureSummary>
          <code className="break-all">{session.failure.detail}</code>
        </Disclosure>
      )}
    </Notice>
  ) : sessionNotListed ? (
    <Notice tone="error" icon={<CircleX className="size-3.5" />}>
      {copy.notListed}
    </Notice>
  ) : unavailableReason ? (
    <Notice tone="warning" icon={<TriangleAlert className="size-3.5" />}>
      {fillCopy(copy.agentUnavailableHere, { reason: unavailableReason })}
    </Notice>
  ) : fileLimit ? (
    <Notice tone="muted">{conversationCopy.limit}</Notice>
  ) : null;

  if (!workspaces.length) return null;
  return (
    <section aria-label={copy.newSession} className="@container grid w-full gap-2">
      {notice}
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <WorkspacePicker
          locale={locale}
          workspaces={workspaces}
          recent={recentWorkspaces(workspaces, sessions, 3)}
          selected={workspace?.id}
          disabled={locked}
          onSelect={(id) => {
            if (workspace?.id === id) return;
            setAddMenuOpen(false);
            if (provider?.create.catalogScope === "workspace") {
              sessionModel.reset();
              setAgentPreset(undefined);
            }
            setWorkspaceId(id);
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button type="button" variant="ghost" className={chip} disabled={locked} />}
            aria-label={`${copy.agent}: ${agentName(agent)}`}
          >
            <AgentMark agent={agent} size={14} />
            <span className="truncate @max-[28rem]:sr-only">{agentName(agent)}</span>
            {unavailableReason && (
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            )}
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60">
            {NEW_SESSION_AGENTS.map((item) => (
              <DropdownMenuItem
                key={item}
                disabled={!!access?.disabledSessionProviders?.[item]}
                onClick={() => {
                  if (item === agent) return;
                  setAgent(item);
                  sessionModel.reset();
                  permission.reset();
                  setPlanning(false);
                  setAddMenuOpen(false);
                  setAgentPreset(undefined);
                }}
              >
                <AgentMark agent={item} size={14} />
                <span className="min-w-0 flex-1 truncate">{agentName(item)}</span>
                {item === agent && <Check className="size-4" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {presets.length > 0 ? (
          <DropdownMenu>
            <IconAction
              label={preset ? `${copy.preset}: ${preset.name}` : copy.preset}
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(chip, "min-w-9")}
                      disabled={optionsLocked}
                    />
                  }
                />
              }
            >
              <Layers className="size-3.5 shrink-0" aria-hidden />
              {preset && (
                <>
                  <span className="truncate text-foreground">{preset.name}</span>
                  <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                </>
              )}
            </IconAction>
            <DropdownMenuContent className="w-64">
              {presets.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={!!item.disabledReason}
                  onClick={() => setAgentPreset(item.id)}
                >
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate">{item.name}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground">{item.description}</span>
                    )}
                  </span>
                  {item.id === preset?.id && <Check className="size-4" aria-hidden />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : provider?.create.agentPresets === true ? (
          <OptionPlaceholder
            label={copy.preset}
            loading={session.optionsLoading}
            icon={<Layers className="size-3.5 shrink-0" aria-hidden />}
          />
        ) : null}
      </div>
      <SessionComposerInput
        onSubmit={() => void send()}
        editor={{
          "aria-label": copy.message,
          autoFocus,
          value: text,
          maxLength: MAX_MESSAGE_LENGTH,
          placeholder: planning ? conversationCopy.planPlaceholder : copy.placeholder,
          disabled: locked || session.providerDisabled,
          onChange: (event) => setText(event.currentTarget.value),
          ...slash.inputProps,
        }}
        onEditorKeyDown={slash.onKeyDown}
        afterEditor={slash.menu}
        attachments={{
          inputRef: fileInput,
          label: copy.attach,
          disabled: !attachments || locked,
          scope: addActionsScope,
          onFiles: addFiles,
        }}
        beforeEditor={
          <>
            <ComposerAttachmentStrip
              items={localAttachments.items}
              copy={{
                listLabel: composerAttachmentCopy(locale).listLabel,
                preview: conversationCopy.previewAttachment,
                uploading: conversationCopy.uploading,
                uploadFailed: conversationCopy.uploadFailed,
                retry: composerLayoutCopy[locale].retry,
                remove: (name) => fillCopy(copy.removeFile, { name }),
              }}
              removeDisabled={locked || session.unknown}
              onPreview={(item) => localAttachments.setPreviewKey(item.key)}
              onPreviewError={(item) => localAttachments.markPreviewUnavailable(item.key)}
              onRemove={(item) => {
                const index = localAttachments.items.findIndex((entry) => entry.key === item.key);
                if (index < 0) return;
                setFileLimit(false);
                setFiles((current) => current.filter((_, at) => at !== index));
              }}
            />
            <NewSessionAddDraftChips
              locale={locale}
              resources={resources}
              disabled={locked}
              onRemoveResource={(id) =>
                add.setResources(resources.filter((item) => item.id !== id))
              }
            />
            {resourceNeedsReselection && (
              <p className="px-2 text-xs text-muted-foreground">
                {conversationCopy.resourceRemoved}
              </p>
            )}
          </>
        }
        toolbar={
          <SessionComposerToolbar
            locale={locale}
            add={{
              scope: addActionsScope,
              label: conversationCopy.addContext,
              side: "bottom",
              disabled: locked,
              open: addMenuOpen && hasAddActions && !locked,
              onOpenChange: setAddMenuOpen,
              attachment: {
                disabled: !canPickFiles,
                onPick: () => fileInput.current?.click(),
              },
              resources: add.resourceBrowser,
              goal: goalsOffered
                ? {
                    selected: !!goal,
                    disabled: !goalsAllowed,
                    onOpen: add.openGoal,
                  }
                : undefined,
              plan:
                planOffered || planning
                  ? {
                      active: planning,
                      disabled: !planning && !offersPlan,
                      onToggle: () => changePlan(!planning),
                    }
                  : undefined,
            }}
            permission={
              permissions && permissionChoices
                ? {
                    label: shownPermission?.name,
                    title: permissions.title,
                    risky: shownPermission?.risky,
                    disabled: optionsLocked,
                    side: "bottom",
                    items: permissionChoices,
                    selected: selectedPermission?.id,
                    onSelect: permission.select,
                  }
                : undefined
            }
            permissionFallback={
              provider && !permissions ? (
                <OptionPlaceholder
                  label={
                    shownPermission?.name ??
                    newSessionPermissionFallbackTitle(agent, locale) ??
                    copy.permission
                  }
                  loading={session.optionsLoading}
                  icon={<Shield className="size-3.5 shrink-0" aria-hidden />}
                />
              ) : undefined
            }
            plan={
              planning
                ? {
                    disabled: locked,
                    onRemove: () => changePlan(false),
                  }
                : undefined
            }
            goal={
              goal
                ? {
                    detail: goal.objective,
                    disabled: locked,
                    onOpen: add.openGoal,
                    onRemove: add.clearGoal,
                  }
                : undefined
            }
            model={
              modelSettings
                ? {
                    scope: sessionModel.scope,
                    settings: modelSettings,
                    selection: {
                      modelId,
                      effort: shownEffort,
                      serviceTierId: shownTier || undefined,
                    },
                    disabled: optionsLocked,
                    saving: false,
                    side: "bottom",
                    clearEffort: sessionModel.canClearEffort,
                    onOpen: () => undefined,
                    onChange: sessionModel.change,
                  }
                : undefined
            }
            modelFallback={
              !modelSettings && showsModelPicker ? (
                <OptionPlaceholder
                  label={copy.model}
                  loading={session.optionsLoading}
                  icon={<Cpu className="size-3.5 shrink-0" aria-hidden />}
                />
              ) : undefined
            }
            action={
              <ComposerPrimaryAction label={sendLabel} disabled={!canSend} loading={locked} />
            }
          />
        }
      />
      {localAttachments.preview?.previewUrl && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) localAttachments.setPreviewKey(undefined);
          }}
        >
          <DialogContent closeLabel={conversationCopy.close}>
            <DialogTitle>
              {`${conversationCopy.previewAttachment}: ${localAttachments.preview.name}`}
            </DialogTitle>
            <img
              src={localAttachments.preview.previewUrl}
              alt={localAttachments.preview.name}
              className="mx-auto max-h-[65dvh] max-w-full object-contain"
              onError={() =>
                localAttachments.preview &&
                localAttachments.markPreviewUnavailable(localAttachments.preview.key)
              }
            />
          </DialogContent>
        </Dialog>
      )}
      {add.goalEditor && (
        <Dialog open onOpenChange={(open) => !open && add.closeGoal()}>
          <DialogContent closeLabel={goalCopy.close}>
            <DialogTitle>{goalCopy.title}</DialogTitle>
            <ComposerGoalFields
              locale={locale}
              objective={add.goalEditor.objective}
              budget={add.goalEditor.budget}
              hideBudget={hideGoalBudget}
              disabled={locked || !goalsAllowed}
              onObjectiveChange={(objective) => add.editGoal({ objective })}
              onBudgetChange={(budget) => add.editGoal({ budget })}
            />
            <Button
              type="button"
              disabled={locked || !goalsAllowed || !add.goalValid}
              onClick={add.saveGoal}
            >
              {goalCopy.saveDraft}
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function OptionPlaceholder({
  label,
  loading,
  icon,
}: {
  label: string;
  loading: boolean;
  icon: ReactNode;
}) {
  return (
    <IconAction
      label={label}
      render={
        <ButtonPrimitive
          type="button"
          className={cn(
            buttonVariants({ variant: "ghost" }),
            chip,
            "h-9 min-w-9 aria-disabled:opacity-50",
          )}
          disabled
          focusableWhenDisabled
          aria-busy={loading || undefined}
        />
      }
    >
      {icon}
      {loading && (
        <span className="grid size-3.5 shrink-0 place-items-center">
          <DelayedSpinner active={loading} />
        </span>
      )}
    </IconAction>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "error" | "muted";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
        tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive-text",
        tone === "warning" &&
          "border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
        tone === "muted" && "bg-card text-muted-foreground",
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function WorkspacePicker({
  locale,
  workspaces,
  recent,
  selected,
  disabled,
  onSelect,
}: {
  locale: Locale;
  workspaces: readonly Workspace[];
  recent: readonly Workspace[];
  selected?: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const copy = newSessionCopy(locale);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = workspaces.find((item) => item.id === selected)?.name ?? "";
  const search = query.trim().toLocaleLowerCase();
  const groups = search
    ? [
        {
          label: undefined,
          items: workspaces.filter((item) => item.name.toLocaleLowerCase().includes(search)),
        },
      ]
    : [
        { label: copy.recentWorkspaces, items: recent },
        {
          label: copy.allWorkspaces,
          items: workspaces
            .filter((item) => !recent.some((entry) => entry.id === item.id))
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
      ].filter((group) => group.items.length > 0);
  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <Popover.Trigger
        render={<Button type="button" variant="ghost" className={chip} disabled={disabled} />}
        aria-label={`${copy.workspace}: ${name}`}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden />
        <span className="max-w-48 truncate text-foreground @max-[28rem]:max-w-24">{name}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup className="grid w-64 gap-1 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none">
            <label className="flex items-center gap-2 rounded-md border border-border px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                autoFocus
                className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder={copy.searchWorkspaces}
                aria-label={copy.searchWorkspaces}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  const first = groups[0]?.items[0];
                  if (event.key === "Enter" && first) {
                    event.preventDefault();
                    choose(first.id);
                  }
                }}
              />
            </label>
            <div className="max-h-72 overflow-y-auto">
              {groups.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">{copy.noWorkspaceMatch}</p>
              )}
              {groups.map((group) => (
                <div key={group.label ?? "matches"} role="group" aria-label={group.label}>
                  {group.label && (
                    <p className="px-2 pt-2 pb-1 text-xs text-muted-foreground">{group.label}</p>
                  )}
                  {group.items.map((item) => (
                    <Button
                      type="button"
                      key={item.id}
                      variant="ghost"
                      className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal"
                      aria-pressed={item.id === selected}
                      onClick={() => choose(item.id)}
                    >
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      {item.id === selected && <Check className="size-4" aria-hidden />}
                    </Button>
                  ))}
                </div>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
