import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  ArrowUp,
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
import type { CodexSessionSettings, ManagedAgent } from "@agentkib/web-client";
import {
  dshAgentPresetText,
  fillCopy,
  NEW_SESSION_AGENTS,
  newSessionCopy,
  newSessionCreateFields,
  newSessionPermissions,
  newSessionPresets,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AGENT_LABELS } from "@/core/agents";
import type { WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { recentContinuationWorkspaces } from "@/features/home/home-continuations";
import { cn } from "cn";
import { codexCopy, codexReason } from "../conversation/features/sessions/codex-copy";
import { ComposerModelPicker } from "../conversation/features/sessions/composer-model-picker";
import { isSendEnter, useEnterSends } from "../conversation/features/sessions/composer-shortcuts";
import { MAX_MESSAGE_LENGTH } from "../conversation/features/sessions/session-model";
import {
  offerNewSessionDraft,
  readNewSessionTarget,
  rememberNewSessionTarget,
  type NewSessionTarget,
} from "../conversation/features/sessions/new-session-draft";
import { failureOf, useNewSession } from "./use-new-session";

const MAX_FILES = 10;
const available = { available: true };
const unavailable = { available: false };
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
  const [workspaceId, setWorkspaceId] = useState(target.workspaceId ?? "");
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ??
    recentContinuationWorkspaces(workspaces as WorkspaceSummary[], 1)[0];
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [permission, setPermission] = useState<string>();
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [agentPreset, setAgentPreset] = useState<string>();
  const [sending, setSending] = useState(false);
  const draft = useRef({ text, files });
  useEffect(() => {
    draft.current = { text, files };
  }, [text, files]);
  // The composer stays busy until the new session opens.
  const handOff = async (sessionId: string) => {
    setSending(true);
    offerNewSessionDraft(sessionId, draft.current);
    setText("");
    setFiles([]);
    try {
      await onCreated(sessionId);
    } finally {
      setSending(false);
    }
  };
  const session = useNewSession({
    agent,
    locale,
    // A create checked after its outcome was unknown opens the session it made, with this
    // composer's draft, only while that draft is still here.
    onReconciled: (sessionId, own) => {
      if (own) void handOff(sessionId);
    },
  });
  const options = session.options.data;
  const enterSends = useEnterSends();
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileLimit, setFileLimit] = useState(false);
  const side = placement === "home" ? "bottom" : "top";

  const [addError, setAddError] = useState("");
  // A workspace added from the menu is chosen; until the list has it, the last one stays shown.
  const addWorkspace = async () => {
    setAddError("");
    try {
      const id = await onAddWorkspace();
      if (id) setWorkspaceId(id);
    } catch (error) {
      setAddError(localizeMessage(error));
    }
  };

  const modelSettings = useMemo((): CodexSessionSettings | undefined => {
    if (!options?.available || !options.models?.length) return undefined;
    const defaultModel =
      options.defaults?.model ?? options.models.find((item) => item.isDefault)?.id;
    const defaults = {
      modelId: defaultModel ?? undefined,
      effort: options.defaults?.effort ?? undefined,
    };
    return {
      sessionId: "",
      available: true,
      revision: 0,
      current: defaults,
      defaults,
      writable: {
        model: available,
        effort: available,
        mode: unavailable,
        policy: unavailable,
        serviceTier: unavailable,
        restoreDefaults: available,
      },
      options: {
        models: options.models.map((item) => ({
          id: item.id,
          name: item.name,
          efforts: item.efforts ?? [],
          defaultEffort: item.defaultEffort,
          serviceTierIds: [],
        })),
        policies: [],
        serviceTiers: [],
      },
    };
  }, [options]);
  const modelId = model || modelSettings?.defaults.modelId;
  const shownEffort =
    effort ||
    (model
      ? modelSettings?.options.models.find((item) => item.id === model)?.defaultEffort
      : (modelSettings?.defaults.effort ?? undefined));
  const permissions = newSessionPermissions(agent, options, locale);
  const shownPermission = permissions?.choices.find(
    (item) => item.id === (permission ?? permissions.initial),
  );
  const { presets, defaultId: defaultPreset } = newSessionPresets(agent, options);
  const preset = presets.find((item) => item.id === (agentPreset ?? defaultPreset));

  const unavailableReason = session.options.isError
    ? failureOf(session.options.error, locale).reason
    : options && !options.available
      ? codexReason(locale, options.reason).text
      : undefined;
  const locked = sending || session.busy;
  const canSend =
    session.ready &&
    !!options?.available &&
    !!workspace &&
    !locked &&
    !session.unknown &&
    (!!text.trim() || files.length > 0);

  async function send() {
    if (!canSend || !workspace) return;
    setSending(true);
    const fields = newSessionCreateFields(
      {
        agent,
        workspaceId: workspace.id,
        model,
        effort,
        shownModel: modelId,
        permission,
        preset: agentPreset,
      },
      options,
    );
    rememberNewSessionTarget({ workspaceId: workspace.id, agent });
    const sessionId = await session.create(fields);
    if (sessionId) await handOff(sessionId);
    else setSending(false);
  }

  function addFiles(list: File[]) {
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
      {fillCopy(copy.notCreated, { reason: session.failure.reason })}
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
    <Notice tone="muted">{codexCopy[locale].limit}</Notice>
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
          onSelect={setWorkspaceId}
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
                  setAgent(item);
                  setModel("");
                  setEffort("");
                  setPermission(undefined);
                  setAgentPreset(undefined);
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
        {presets.length > 0 && (
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
      </div>
      <form
        className="grid gap-2 rounded-2xl border border-border bg-card p-2.5 shadow-sm transition-colors focus-within:border-ring/40"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
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
        <Textarea
          aria-label={copy.message}
          className="max-h-48 min-h-12 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          rows={2}
          value={text}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={copy.placeholder}
          disabled={locked}
          onChange={(event) => setText(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (!enterSends || !isSendEnter(event, composing.current)) return;
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          }}
          onPaste={(event) => {
            const pasted = Array.from(event.clipboardData.files);
            if (!pasted.length) return;
            event.preventDefault();
            addFiles(pasted);
          }}
        />
        <Input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          aria-label={copy.attach}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <div className="flex min-w-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            className="size-8 shrink-0 rounded-full bg-muted/60 p-0"
            aria-label={copy.attach}
            title={copy.attach}
            disabled={locked || files.length >= MAX_FILES}
            onClick={() => fileInput.current?.click()}
          >
            <Plus className="size-4" aria-hidden />
          </Button>
          {permissions && shownPermission && (
            <PermissionMenu
              label={shownPermission.name}
              title={permissions.title}
              risky={shownPermission.risky}
              disabled={locked}
              side={side}
              items={permissions.choices}
              selected={shownPermission.id}
              onSelect={setPermission}
            />
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {modelSettings && (
              <ComposerModelPicker
                locale={locale}
                settings={modelSettings}
                selection={{ modelId, effort: shownEffort }}
                disabled={locked}
                saving={false}
                side={side}
                onOpen={() => undefined}
                onChange={async (change) => {
                  if (change.restoreDefaults) {
                    setModel("");
                    setEffort("");
                  } else if (change.model !== undefined) {
                    setModel(change.model);
                    setEffort(change.effort ?? "");
                  } else if (change.effort !== undefined) setEffort(change.effort ?? "");
                }}
              />
            )}
            <Button
              type="submit"
              className="size-8 shrink-0 rounded-full p-0"
              aria-label={copy.send}
              title={copy.send}
              disabled={!canSend}
            >
              {locked ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="size-4" aria-hidden />
              )}
            </Button>
          </div>
        </div>
      </form>
    </section>
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

function PermissionMenu({
  label,
  title,
  risky = false,
  disabled,
  side,
  items,
  selected,
  onSelect,
}: {
  label: string;
  title: string;
  risky?: boolean;
  disabled: boolean;
  side: "top" | "bottom";
  items: { id: string; name: string; description: string; risky?: boolean }[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn(chip, risky && "text-orange-600 hover:text-orange-700")}
            disabled={disabled}
          />
        }
        aria-label={`${title}: ${label}`}
      >
        <Shield className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate @max-[28rem]:sr-only">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{title}</DropdownMenuLabel>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              className={cn("items-start", item.risky && "text-orange-600")}
              onClick={() => onSelect(item.id)}
            >
              <span className="grid min-w-0 flex-1">
                <span>{item.name}</span>
                <span
                  className={cn(
                    "text-xs",
                    item.risky ? "text-orange-600/80" : "text-muted-foreground",
                  )}
                >
                  {item.description}
                </span>
              </span>
              {item.id === selected && <Check className="mt-0.5 size-4" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
