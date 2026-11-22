import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  Check,
  ChevronDown,
  CircleX,
  FileText,
  Folder,
  FolderPlus,
  Hourglass,
  ImageIcon,
  Layers,
  LoaderCircle,
  Plus,
  Search,
  Shield,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  newSessionProvider,
  sessionProviderCapabilities,
  type ManagedAgent,
} from "@agentkib/web-client";
import {
  composerGoalCopy,
  ComposerGoalFields,
  ComposerPrimaryAction,
  SessionComposerToolbar,
  dshAgentPresetText,
  fillCopy,
  NEW_SESSION_AGENTS,
  NewSessionAddDraftChips,
  newSessionCopy,
  newSessionCreateFields,
  useNewSessionModel,
  devinTerminalAction,
  devinTerminalCopy,
  newSessionPermissions,
  newSessionPresets,
  newSessionAddCapabilities,
  planSlashOption,
  SessionComposerInput,
  slashCommandCopy,
  useNewSessionAdd,
  useSlashCommandMenu,
  offerNewSessionDraft,
  readNewSessionTarget,
  rememberNewSessionTarget,
  type NewSessionDraft,
  type NewSessionTarget,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AGENT_LABELS } from "@/core/agents";
import type { WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { recentContinuationWorkspaces } from "@/features/home/home-continuations";
import { cn } from "cn";
import { sessionCopy, sessionReason } from "../conversation/session-copy";
import { composerLayoutCopy } from "@agentkib/session-ui";
import { Dialog } from "../conversation/components/dialog";
import { MAX_MESSAGE_LENGTH } from "@agentkib/conversation-state";
import { failureOf, useNewSession } from "./use-new-session";

const MAX_FILES = 10;
const NO_STARTUP_COMMANDS = [] as const;
const chip =
  "h-8 min-w-0 gap-1.5 rounded-full px-2.5 text-sm font-normal text-muted-foreground hover:text-foreground";

export interface NewSessionComposerProps {
  workspaces: Pick<WorkspaceSummary, "id" | "name" | "last_active_at">[];
  /** Agents this computer is known not to have; they stay listed, greyed, with the reason. */
  notInstalled?: ReadonlySet<string>;
  /** The workspace and Agent to start from; otherwise the ones the last new session used. */
  initial?: Partial<NewSessionTarget>;
  /** Where menus open: below the composer at the top of the home, above it on the sessions page. */
  placement: "home" | "page";
  onCreated: (sessionId: string) => Promise<void> | void;
  /** Adds a workspace without leaving this page; resolves to its id, or nothing when cancelled. */
  onAddWorkspace: () => Promise<string | undefined>;
  onOpenSettings: () => void;
}

/**
 * Starts a session: the workspace and Agent above, the first message with its files, permissions,
 * model and effort below. The session is created first; its own composer then sends the message,
 * so a message that cannot go out stays there as the draft.
 */
export function NewSessionComposer(props: NewSessionComposerProps) {
  const { workspaces, notInstalled, placement, onCreated, onAddWorkspace, onOpenSettings } = props;
  const { locale, localizeMessage } = useI18n();
  const copy = newSessionCopy(locale);
  const [target] = useState(() => ({ ...readNewSessionTarget(), ...props.initial }));
  const [agent, setAgent] = useState<ManagedAgent>(
    target.agent && !notInstalled?.has(target.agent) ? target.agent : "codex",
  );
  const isDevin = agent === "devin";
  const [workspaceId, setWorkspaceId] = useState(target.workspaceId ?? "");
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ??
    recentContinuationWorkspaces(workspaces as WorkspaceSummary[], 1)[0];
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [terminalNote, setTerminalNote] = useState<{ detail: string; text: string }>();
  const [permission, setPermission] = useState<string>();
  const [startupPlanning, setStartupPlanning] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [agentPreset, setAgentPreset] = useState<string>();
  const [sending, setSending] = useState(false);
  const draft = useRef<NewSessionDraft>({ text, files });
  const submittedWithPrompt = useRef(false);
  // The composer stays busy until the new session opens.
  const handOff = async (sessionId: string, promptWasSubmitted: boolean) => {
    setSending(true);
    if (!promptWasSubmitted) offerNewSessionDraft(sessionId, draft.current);
    setText("");
    setFiles([]);
    add.clearDraftAdditions();
    try {
      await onCreated(sessionId);
    } finally {
      setSending(false);
    }
  };
  const session = useNewSession({
    agent,
    workspaceId: workspace?.id,
    locale,
    // A create checked after its outcome was unknown opens the session it made, with this
    // composer's draft, only while that draft is still here.
    onReconciled: (sessionId, own) => {
      if (own) void handOff(sessionId, submittedWithPrompt.current);
    },
  });
  const options = session.optionsData;
  const provider = newSessionProvider(agent, options);
  const showPermission = provider?.create.permissionPicker === true;
  const showModel = provider?.create.modelPicker === true;
  const showPresets = provider?.create.agentPresets === true;
  const optionsStatus = session.optionsLoading ? copy.loadingOptions : copy.optionsUnavailable;
  const promptAtCreate = provider?.create.mode === "with-first-message";
  const locked = sending || session.busy;
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
    session.advancedAccess,
  );
  const goalCopy = composerGoalCopy(locale);
  const add = useNewSessionAdd({
    agent,
    workspaceId: workspace?.id,
    client: session.client,
    resourceAuthority: session.resourceAuthority,
    resourcesAllowed,
    resourcesOffered,
    resourcesDisabledReason: optionsStatus,
    locked,
    resourceError: (error) => failureOf(error, locale).reason,
    resourceReason: (code) => sessionReason(locale, code).text,
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
  // The create request can carry the first message's text. Attachments use the opened session.
  const acceptsAttachments = (provider?.create.attachments ?? true) && !promptAtCreate;
  const workspaceCatalog = provider?.create.catalogScope !== "host";
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileLimit, setFileLimit] = useState(false);
  const side = placement === "home" ? "bottom" : "top";

  const selectWorkspace = (id: string) => {
    if (id !== workspace?.id) {
      setAddMenuOpen(false);
      if (workspaceCatalog) {
        sessionModel.reset();
        setAgentPreset(undefined);
      }
    }
    setWorkspaceId(id);
  };

  const [addError, setAddError] = useState("");
  // A workspace added from the menu is chosen; until the list has it, the last one stays shown.
  const addWorkspace = async () => {
    setAddError("");
    try {
      const id = await onAddWorkspace();
      if (id) selectWorkspace(id);
    } catch (error) {
      setAddError(localizeMessage(error));
    }
  };

  const sessionModel = useNewSessionModel({
    agent,
    workspaceId: workspace?.id,
    authority: session.resourceAuthority,
    options,
    provider,
  });
  const { settings: modelSettings, modelId, shownEffort, shownTier } = sessionModel;
  const verifiedOptions = options?.available ? options : undefined;
  const permissions = newSessionPermissions(agent, verifiedOptions, locale, {
    fullAccess: session.fullAccess,
  });
  const permissionChoices = permissions?.choices ?? [];
  const shownPermission = permissionChoices.find(
    (item) => item.id === (permission ?? permissions?.initial),
  );
  const planning = startupPlanning;
  const planOption = useMemo(() => planSlashOption(locale), [locale]);
  const slash = useSlashCommandMenu({
    value: text,
    options: NO_STARTUP_COMMANDS,
    enabled: offersPlan && !locked,
    catalogKnown: true,
    locale,
    side,
    label: agent === "codex" ? slashCommandCopy(locale).codexLabel : undefined,
    plan: offersPlan
      ? {
          option: planOption,
          enter: () => {
            setStartupPlanning(true);
            return true;
          },
        }
      : undefined,
    onChoose: setText,
  });
  const { presets, defaultId: defaultPreset } = newSessionPresets(
    agent,
    verifiedOptions,
    provider?.create,
  );
  const preset = presets.find((item) => item.id === (agentPreset ?? defaultPreset));

  const unavailableReason =
    session.options.isError && !options
      ? failureOf(session.options.error, locale).reason
      : options && !options.available
        ? sessionReason(locale, options.reason).text
        : undefined;
  const hasMessage = !!text.trim() || (acceptsAttachments && files.length > 0);
  const resourceNeedsMessage = resources.length > 0 && !hasMessage;
  const resourceNeedsReselection = resources.some((item) => !item.available);
  const goalNeedsMessage = !!goal && !hasMessage && planning && planField === "mode";
  const sendDisabledReason = resourceNeedsReselection
    ? undefined
    : resourceNeedsMessage
      ? composerLayoutCopy[locale].resourceNeedsMessage
      : goalNeedsMessage
        ? goalCopy.planNeedsMessage
        : undefined;
  const sendLabel = goal && !hasMessage ? sessionCopy[locale].goalCreate : copy.send;
  const canSend =
    session.ready &&
    !!options?.available &&
    !!workspace &&
    !locked &&
    !session.unknown &&
    (!planning || offersPlan) &&
    (!resources.length ||
      (resourcesAllowed && !resourceNeedsMessage && !resourceNeedsReselection)) &&
    (!goal || goalsAllowed) &&
    !goalNeedsMessage &&
    (acceptsAttachments || files.length === 0) &&
    (hasMessage || !!goal);

  async function send() {
    if (!canSend || !workspace) return;
    setSending(true);
    const fields = newSessionCreateFields(
      {
        agent,
        workspaceId: workspace.id,
        model: sessionModel.model,
        effort: sessionModel.effort,
        serviceTierId: sessionModel.chosenTier,
        shownModel: modelId,
        permission,
        planning,
        preset: agentPreset,
        fullAccess: session.fullAccess,
      },
      options,
      provider?.create,
    );
    rememberNewSessionTarget({ workspaceId: workspace.id, agent });
    submittedWithPrompt.current = promptAtCreate;
    const sessionId = await session.create(promptAtCreate ? { ...fields, prompt: text } : fields);
    if (sessionId) await handOff(sessionId, promptAtCreate);
    else setSending(false);
  }

  function addFiles(list: File[]) {
    if (!acceptsAttachments) return;
    const room = MAX_FILES - files.length;
    setFileLimit(list.length > room);
    if (room > 0) setFiles((current) => [...current, ...list.slice(0, room)]);
  }

  // Devin CLI's own login or workspace trust stopped the session from starting: offer to open it.
  const terminalDetail = session.failure?.detail?.replaceAll("_", "-");
  const terminalAction = isDevin ? devinTerminalAction(terminalDetail) : undefined;
  const openDevinTerminal = async () => {
    if (!terminalAction || !terminalDetail || !workspace) return;
    const words = devinTerminalCopy(locale);
    try {
      const result = await session.devinTerminal({
        action: terminalAction,
        workspaceId: workspace.id,
      });
      setTerminalNote({
        detail: terminalDetail,
        text: words.opened.replace("{terminal}", result.terminal),
      });
    } catch {
      setTerminalNote({ detail: terminalDetail, text: words.failed });
    }
  };

  const notice = session.unknown ? (
    <Notice tone="warning" icon={<Hourglass className="size-3.5" />}>
      {copy.unknown}
    </Notice>
  ) : session.failure ? (
    <Notice
      tone="error"
      icon={<CircleX className="size-3.5" />}
      action={
        terminalAction ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void openDevinTerminal()}
          >
            {devinTerminalCopy(locale)[terminalAction]}
          </Button>
        ) : undefined
      }
    >
      {session.failure.detail === "dsh-create-model-not-applied"
        ? session.failure.reason
        : fillCopy(copy.notCreated, { reason: session.failure.reason })}
      {terminalNote && terminalNote.detail === terminalDetail && (
        <span className="mt-1 block">{terminalNote.text}</span>
      )}
      {session.failure.detail && (
        <Disclosure className="mt-1">
          <DisclosureSummary>{copy.details}</DisclosureSummary>
          <code className="break-all">{session.failure.detail}</code>
        </Disclosure>
      )}
    </Notice>
  ) : unavailableReason ? (
    <Notice
      tone="warning"
      icon={<TriangleAlert className="size-3.5" />}
      action={
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onOpenSettings}>
          {copy.openSettings}
        </Button>
      }
    >
      {fillCopy(copy.agentUnavailable, { reason: unavailableReason })}
    </Notice>
  ) : addError ? (
    <Notice tone="error" icon={<CircleX className="size-3.5" />}>
      {addError}
    </Notice>
  ) : fileLimit ? (
    <Notice tone="muted">{sessionCopy[locale].limit}</Notice>
  ) : null;

  if (!workspaces.length)
    return (
      <section className="grid justify-items-start gap-2 rounded-2xl border border-dashed border-border bg-card p-5">
        <FolderPlus className="size-5 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">{copy.noWorkspace}</h2>
        <p className="text-xs text-muted-foreground">{copy.noWorkspaceHint}</p>
        {addError && (
          <p role="alert" className="text-xs text-destructive-text">
            {addError}
          </p>
        )}
        <Button variant="outline" size="sm" onClick={() => void addWorkspace()}>
          <FolderPlus size={15} aria-hidden />
          {copy.addWorkspaceButton}
        </Button>
      </section>
    );

  return (
    <section aria-label={copy.newSession} className="@container grid w-full gap-2">
      {notice}
      <div className="flex min-w-0 items-center gap-1">
        <WorkspacePicker
          workspaces={workspaces}
          selected={workspace?.id}
          disabled={locked}
          side={side}
          onSelect={selectWorkspace}
          onAdd={() => void addWorkspace()}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" className={chip} disabled={locked} />}
            aria-label={`${copy.agent}: ${AGENT_LABELS[agent]}`}
          >
            <AgentIcon agent={agent} compact />
            <span className="truncate @max-[28rem]:sr-only">{AGENT_LABELS[agent]}</span>
            {unavailableReason && (
              <TriangleAlert className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            )}
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={side} className="w-60">
            {NEW_SESSION_AGENTS.map((item) => (
              <DropdownMenuItem
                key={item}
                disabled={notInstalled?.has(item)}
                onClick={() => {
                  if (item === agent) return;
                  setAgent(item);
                  sessionModel.reset();
                  setPermission(undefined);
                  setStartupPlanning(false);
                  setAgentPreset(undefined);
                  setAddMenuOpen(false);
                }}
              >
                <AgentIcon agent={item} compact />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate">{AGENT_LABELS[item]}</span>
                  {notInstalled?.has(item) && (
                    <span className="text-xs text-muted-foreground">{copy.notInstalled}</span>
                  )}
                </span>
                {item === agent && <Check className="size-4" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {showPresets && presets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" className={chip} disabled={locked} />}
            >
              <Layers className="size-3.5 shrink-0" aria-hidden />
              <span className="@max-[28rem]:sr-only">{copy.preset}</span>
              <span className="truncate text-foreground">
                {preset ? dshAgentPresetText(preset, locale).name : ""}
              </span>
              <ChevronDown className="size-3.5 shrink-0" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent side={side} className="w-64">
              {presets.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  disabled={!!item.broken}
                  onClick={() => setAgentPreset(item.id)}
                >
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate">{dshAgentPresetText(item, locale).name}</span>
                    {dshAgentPresetText(item, locale).description && (
                      <span className="text-xs text-muted-foreground">
                        {dshAgentPresetText(item, locale).description}
                      </span>
                    )}
                  </span>
                  {item.id === preset?.id && <Check className="size-4" aria-hidden />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {showPresets && presets.length === 0 && (
          <UnavailableOptionButton
            label={copy.preset}
            status={optionsStatus}
            loading={session.optionsLoading}
            className={chip}
            icon={<Layers className="size-3.5 shrink-0" aria-hidden />}
          />
        )}
      </div>
      <SessionComposerInput
        editor={{
          "aria-label": copy.message,
          value: text,
          maxLength: MAX_MESSAGE_LENGTH,
          placeholder: planning ? sessionCopy[locale].planPlaceholder : copy.placeholder,
          disabled: locked,
          onChange: (event) => setText(event.target.value),
          ...slash.inputProps,
        }}
        onSubmit={() => void send()}
        onEditorKeyDown={slash.onKeyDown}
        canSubmitFromKeyboard={() => canSend}
        attachments={{
          inputRef: fileInput,
          label: copy.attach,
          disabled: locked || !acceptsAttachments,
          onFiles: addFiles,
        }}
        afterEditor={slash.menu}
        beforeEditor={
          <>
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5 px-1 pt-1">
                {files.map((file, index) => (
                  <li
                    key={`${file.name}:${index}`}
                    className="flex max-w-56 items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-2 pr-1 text-xs"
                  >
                    {file.type.startsWith("image/") ? (
                      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <FileText className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="truncate">{file.name}</span>
                    <Button
                      variant="ghost"
                      size="content"
                      className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground"
                      aria-label={fillCopy(copy.removeFile, { name: file.name })}
                      disabled={locked}
                      onClick={() => {
                        setFileLimit(false);
                        setFiles((current) => current.filter((_, at) => at !== index));
                      }}
                    >
                      <X className="size-3" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
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
                {sessionCopy[locale].resourceRemoved}
              </p>
            )}
          </>
        }
        toolbar={
          <SessionComposerToolbar
            locale={locale}
            add={{
              scope: JSON.stringify([agent, workspace?.id, session.resourceAuthority]),
              label: sessionCopy[locale].addContext,
              disabled: locked,
              disabledReason: session.optionsLoading ? copy.loadingOptions : undefined,
              side: side,
              open: addMenuOpen && !locked,
              onOpenChange: setAddMenuOpen,
              attachment: acceptsAttachments
                ? {
                    disabled: files.length >= MAX_FILES,
                    reason: files.length >= MAX_FILES ? sessionCopy[locale].limit : undefined,
                    onPick: () => fileInput.current?.click(),
                  }
                : undefined,
              resources: add.resourceBrowser,
              goal: goalsOffered
                ? {
                    selected: !!goal,
                    disabled: !goalsAllowed,
                    reason: !goalsAllowed ? optionsStatus : undefined,
                    onOpen: add.openGoal,
                  }
                : undefined,
              plan:
                planOffered || planning
                  ? {
                      active: planning,
                      disabled: !planning && !offersPlan,
                      reason: !offersPlan ? optionsStatus : undefined,
                      onToggle: () => setStartupPlanning(!planning),
                    }
                  : undefined,
            }}
            permission={
              showPermission && permissions
                ? {
                    label: shownPermission?.name ?? permissions.title,
                    title: permissions.title,
                    risky: shownPermission?.risky,
                    disabled: locked,
                    side: side,
                    items:
                      planning && planField === "permissionMode"
                        ? permissionChoices.map((item) => ({ ...item, disabled: true }))
                        : permissionChoices,
                    selected: shownPermission?.id,
                    onSelect: setPermission,
                  }
                : undefined
            }
            permissionFallback={
              showPermission && !permissions ? (
                <UnavailableOptionButton
                  label={agent === "claude-code" ? copy.permissions[agent].title : copy.permission}
                  status={optionsStatus}
                  loading={session.optionsLoading}
                  className="h-11 min-w-0 rounded-full px-2.5 text-sm font-normal text-muted-foreground"
                  compact
                  icon={<Shield className="size-3.5 shrink-0" aria-hidden />}
                />
              ) : undefined
            }
            plan={
              planning
                ? {
                    disabled: locked,
                    onRemove: () => setStartupPlanning(false),
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
              showModel && modelSettings
                ? {
                    scope: sessionModel.scope,
                    settings: modelSettings,
                    selection: { modelId, effort: shownEffort, serviceTierId: shownTier },
                    disabled: locked,
                    saving: false,
                    side: side,
                    modelDefault: provider?.models.modelDefault ?? true,
                    clearEffort: sessionModel.canClearEffort,
                    onOpen: () => undefined,
                    onChange: sessionModel.change,
                  }
                : undefined
            }
            modelFallback={
              showModel && !modelSettings ? (
                <UnavailableOptionButton
                  label={copy.model}
                  status={optionsStatus}
                  loading={session.optionsLoading}
                  className="h-9 min-w-0 max-w-64 rounded-full px-2 text-sm font-normal"
                />
              ) : undefined
            }
            action={
              <ComposerPrimaryAction
                label={sendLabel}
                title={sendDisabledReason}
                showDisabledTitle={!!sendDisabledReason}
                disabled={!canSend}
                loading={locked}
              />
            }
          />
        }
      />
      {add.goalEditor && (
        <Dialog
          panel
          title={goalCopy.title}
          closeLabel={goalCopy.close}
          onClose={add.closeGoal}
          footer={
            <Button
              type="button"
              disabled={locked || !goalsAllowed || !add.goalValid}
              onClick={add.saveGoal}
            >
              {goalCopy.saveDraft}
            </Button>
          }
        >
          <ComposerGoalFields
            locale={locale}
            objective={add.goalEditor.objective}
            budget={add.goalEditor.budget}
            hideBudget={hideGoalBudget}
            disabled={locked || !goalsAllowed}
            onObjectiveChange={(objective) => add.editGoal({ objective })}
            onBudgetChange={(budget) => add.editGoal({ budget })}
          />
        </Dialog>
      )}
    </section>
  );
}

function UnavailableOptionButton({
  label,
  status,
  loading,
  className,
  icon,
  compact,
}: {
  label: string;
  status: string;
  loading: boolean;
  className: string;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={className}
      disabled
      aria-busy={loading || undefined}
      aria-label={`${label}: ${status}`}
      title={status}
    >
      {icon}
      <span className={cn("truncate", compact && "@max-[28rem]:sr-only")}>{label}</span>
      {loading ? (
        <LoaderCircle className="size-3.5 shrink-0 motion-safe:animate-spin" aria-hidden />
      ) : (
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      )}
    </Button>
  );
}

function Notice({
  tone,
  icon,
  action,
  children,
}: {
  tone: "warning" | "error" | "muted";
  icon?: ReactNode;
  action?: ReactNode;
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
      {action}
    </div>
  );
}

function WorkspacePicker({
  workspaces,
  selected,
  disabled,
  side,
  onSelect,
  onAdd,
}: {
  workspaces: NewSessionComposerProps["workspaces"];
  selected?: string;
  disabled: boolean;
  side: "top" | "bottom";
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const copy = newSessionCopy(useI18n().locale);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = workspaces.find((item) => item.id === selected)?.name ?? "";
  const recent = recentContinuationWorkspaces(workspaces as WorkspaceSummary[], 3);
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
        render={<Button variant="ghost" className={chip} disabled={disabled} />}
        aria-label={`${copy.workspace}: ${name}`}
      >
        <Folder className="size-3.5 shrink-0" aria-hidden />
        <span className="max-w-48 truncate text-foreground @max-[28rem]:max-w-24">{name}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={6} className="z-50">
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
            <Button
              variant="ghost"
              className="h-auto justify-start gap-2 rounded-none border-t border-border px-2 pt-2 pb-1.5 text-left text-sm font-normal text-muted-foreground"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              {copy.addWorkspace}
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
