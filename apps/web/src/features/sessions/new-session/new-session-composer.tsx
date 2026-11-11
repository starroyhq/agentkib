import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleX,
  FileText,
  Folder,
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
import type { ManagedAgent, ManagedOptions } from "@agentkib/web-client";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { sortSessions } from "@agentkib/session-catalog";
import {
  dshAgentPresetText,
  fillCopy,
  NEW_SESSION_AGENTS,
  newSessionCopy,
  newSessionCreateFields,
  newSessionPermissions,
  newSessionPresets,
  type NewSessionPermissionChoice,
} from "@agentkib/session-ui";
import { Button } from "@/features/conversation/components/ui/button";
import { Disclosure, DisclosureSummary } from "@/features/conversation/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/features/conversation/components/ui/dropdown-menu";
import { Input } from "@/features/conversation/components/ui/input";
import { Textarea } from "@/features/conversation/components/ui/textarea";
import { cn } from "@/features/conversation/lib/utils";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import {
  codexCopyForSurface,
  codexReason,
} from "@/features/conversation/features/sessions/codex-copy";
import { composerTerm } from "@/features/conversation/features/sessions/composer-layout-copy";
import {
  isSendEnter,
  useEnterSends,
} from "@/features/conversation/features/sessions/composer-shortcuts";
import { MAX_MESSAGE_LENGTH } from "@/features/conversation/features/sessions/session-model";
import {
  offerNewSessionDraft,
  readNewSessionTarget,
  rememberNewSessionTarget,
} from "@/features/conversation/features/sessions/new-session-draft";
import type { Locale } from "@/features/conversation/i18n";
import { failureOf, useNewSession } from "./use-new-session";

const MAX_FILES = 10;
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
 * the first message with its files, permissions, model and effort below. The session is created
 * first; its own composer then sends the message, so a message that cannot go out stays there as
 * the draft.
 */
export function NewSessionComposer({
  onCreated,
  autoFocus = false,
  disabled = false,
}: {
  /** Opens the new session; resolves once it is open. */
  onCreated: (sessionId: string) => Promise<void> | void;
  autoFocus?: boolean;
  /** The connection is lost: the draft can be written but not sent. */
  disabled?: boolean;
}) {
  const { locale, sessions, workspaces: catalogWorkspaces, access } = useSession();
  const fullAccess = access?.device?.accessMode === "full";
  const workspaces = useMemo(
    () => (catalogWorkspaces ?? []).filter((item) => !("remote" in item && item.remote)),
    [catalogWorkspaces],
  );
  const copy = newSessionCopy(locale);
  const [target] = useState(readNewSessionTarget);
  const [agent, setAgent] = useState<ManagedAgent>(target.agent ?? "codex");
  const [workspaceId, setWorkspaceId] = useState(target.workspaceId ?? "");
  const workspace =
    workspaces.find((item) => item.id === workspaceId) ??
    recentWorkspaces(workspaces, sessions, 1)[0] ??
    workspaces[0];
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
    // A create checked after its outcome was unknown opens the session it made, with this
    // composer's draft, only while that draft is still here.
    onReconciled: (sessionId, own) => {
      if (own) void handOff(sessionId);
    },
  });
  const options = session.options;
  const enterSends = useEnterSends();
  const composing = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileLimit, setFileLimit] = useState(false);

  const models = options?.available ? (options.models ?? []) : [];
  const defaultModel = options?.defaults?.model ?? models.find((item) => item.isDefault)?.id;
  const modelId = model || defaultModel || undefined;
  const shownEffort =
    effort ||
    (model
      ? models.find((item) => item.id === model)?.defaultEffort
      : (options?.defaults?.effort ?? undefined));
  const permissions = newSessionPermissions(agent, options, locale, { fullAccess });
  const shownPermission = permissions?.choices.find(
    (item) => item.id === (permission ?? permissions.initial),
  );
  const { presets, defaultId: defaultPreset } = newSessionPresets(agent, options);
  const preset = presets.find((item) => item.id === (agentPreset ?? defaultPreset));

  const unavailableReason = session.optionsError
    ? failureOf(session.optionsError, locale).reason
    : options && !options.available
      ? codexReason(locale, options.reason, "web").text
      : undefined;
  const locked = sending || session.busy;
  const canSend =
    !disabled &&
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
        fullAccess,
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
    <Notice tone="warning" icon={<TriangleAlert className="size-3.5" />}>
      {fillCopy(copy.agentUnavailableHere, { reason: unavailableReason })}
    </Notice>
  ) : fileLimit ? (
    <Notice tone="muted">{codexCopyForSurface(locale, "web").limit}</Notice>
  ) : null;

  if (!workspaces.length) return null;
  return (
    <section aria-label={copy.newSession} className="@container grid w-full gap-2">
      {notice}
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
                  type="button"
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
          // The home and the "+" panel open with the person about to type.
          autoFocus={autoFocus}
          className="max-h-48 min-h-12 resize-none border-0 bg-transparent px-2 py-1.5 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent sm:text-sm dark:bg-transparent dark:disabled:bg-transparent"
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
        <div className="flex min-w-0 flex-wrap items-center gap-1">
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
          <WorkspacePicker
            locale={locale}
            workspaces={workspaces}
            recent={recentWorkspaces(workspaces, sessions, 3)}
            selected={workspace?.id}
            disabled={locked}
            onSelect={setWorkspaceId}
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
                  onClick={() => {
                    setAgent(item);
                    setModel("");
                    setEffort("");
                    setPermission(undefined);
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
          {presets.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button type="button" variant="ghost" className={chip} disabled={locked} />}
              >
                <Layers className="size-3.5 shrink-0" aria-hidden />
                <span className="@max-[28rem]:sr-only">{copy.preset}</span>
                <span className="truncate text-foreground">
                  {preset ? dshAgentPresetText(preset, locale).name : ""}
                </span>
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
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
          {permissions && shownPermission && (
            <PermissionMenu
              label={shownPermission.name}
              title={permissions.title}
              risky={shownPermission.risky}
              disabled={locked}
              items={permissions.choices}
              selected={shownPermission.id}
              onSelect={setPermission}
            />
          )}
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {models.length > 0 && (
              <ModelMenu
                locale={locale}
                models={models}
                modelId={modelId}
                effort={shownEffort}
                disabled={locked}
                onModel={(id) => {
                  setModel(id);
                  setEffort("");
                }}
                onEffort={setEffort}
              />
            )}
            <Button
              type="submit"
              className="h-8 shrink-0 gap-1 rounded-full px-3"
              aria-label={copy.send}
              title={copy.send}
              disabled={!canSend}
            >
              {locked ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden />
              ) : (
                <ArrowUp className="size-4" aria-hidden />
              )}
              <span className="@max-[28rem]:sr-only">{copy.send}</span>
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

function PermissionMenu({
  label,
  title,
  risky,
  disabled,
  items,
  selected,
  onSelect,
}: {
  label: string;
  title: string;
  risky: boolean;
  disabled: boolean;
  items: NewSessionPermissionChoice[];
  selected?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
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
      <DropdownMenuContent className="w-72">
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

/** The model and its effort, as the session's own composer names them. */
function ModelMenu({
  locale,
  models,
  modelId,
  effort,
  disabled,
  onModel,
  onEffort,
}: {
  locale: Locale;
  models: NonNullable<ManagedOptions["models"]>;
  modelId?: string;
  effort?: string;
  disabled: boolean;
  onModel: (id: string) => void;
  onEffort: (effort: string) => void;
}) {
  const copy = codexCopyForSurface(locale, "web");
  const current = models.find((item) => item.id === modelId);
  const name = current?.name ?? modelId ?? "";
  const efforts = current?.efforts ?? [];
  const label = [name, effort ? composerTerm(locale, effort) : ""].filter(Boolean).join(" · ");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" className={chip} disabled={disabled} />}
        aria-label={`${copy.model}: ${label}`}
      >
        <span className="max-w-40 truncate @max-[28rem]:max-w-24">{label}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{copy.model}</DropdownMenuLabel>
          {models.map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => onModel(item.id)}>
              <span className="min-w-0 flex-1 truncate">{item.name ?? item.id}</span>
              {item.id === current?.id && <Check className="size-4" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{copy.effort}</DropdownMenuLabel>
              {efforts.map((item) => (
                <DropdownMenuItem key={item} onClick={() => onEffort(item)}>
                  <span className="min-w-0 flex-1">{composerTerm(locale, item)}</span>
                  {item === effort && <Check className="size-4" aria-hidden />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
