import { useRef, useState } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import { newSessionProvider, type ManagedAgent } from "@agentkib/web-client";
import {
  ComposerPermissionMenu,
  fillCopy,
  isNewSessionPermissionFailure,
  NEW_SESSION_AGENTS,
  newSessionCopy,
  newSessionCreateFields,
  newSessionPermissionFallbackTitle,
  readNewSessionTarget,
  rememberNewSessionTarget,
  useNewSessionPermission,
} from "@agentkib/session-ui";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { recentContinuationWorkspaces } from "@/features/home/home-continuations";
import { sessionReason } from "@/features/sessions/conversation/session-copy";
import { failureOf, useNewSession } from "@/features/sessions/new-session/use-new-session";

/** Workspaces the target menu lists, most recently active first. */
const MENU_WORKSPACES = 8;

/**
 * Starts a session from the menu bar in one line: Enter creates it in the last workspace and Agent
 * used, through the same create as the new-session composer, then opens it in the main window,
 * passing a draft when the provider hasn't already sent the first message during creation.
 */
export function MenuBarNewSession({
  workspaces,
  notInstalled,
  onCreated,
}: {
  workspaces: WorkspaceSummary[];
  notInstalled: ReadonlySet<string>;
  onCreated: (sessionId: string, draft?: string) => void;
}) {
  const { locale, tr } = useI18n();
  const copy = newSessionCopy(locale);
  const [target, setTarget] = useState(readNewSessionTarget);
  const agent: ManagedAgent =
    target.agent && !notInstalled.has(target.agent) ? target.agent : "codex";
  const workspace =
    workspaces.find((item) => item.id === target.workspaceId) ??
    recentContinuationWorkspaces(workspaces, 1)[0];
  const [text, setText] = useState("");
  // The Agent's options are read once the person starts here: the first Codex read starts an
  // app-server, which merely opening the menu bar should not do.
  const [engaged, setEngaged] = useState(false);
  const submittedDraft = useRef<string>(undefined);
  const composing = useRef(false);
  const session = useNewSession({
    agent,
    workspaceId: workspace?.id,
    locale,
    readOptions: engaged,
    // A create checked after its outcome was unknown opens the session it made.
    onReconciled: (sessionId, own) => {
      if (own) onCreated(sessionId, submittedDraft.current);
    },
  });
  const options = session.optionsData;
  const permission = useNewSessionPermission(agent, options, locale, session.fullAccess);
  const { permissions, selected: selectedPermission, shown: shownPermission } = permission;
  const permissionTitle =
    permissions?.title ?? newSessionPermissionFallbackTitle(agent, locale) ?? copy.permission;
  const optionsReason =
    options && !options.available ? sessionReason(locale, options.reason).text : undefined;
  const unavailable =
    !session.providerDisabled && session.options.isError && !options
      ? failureOf(session.options.error, locale).reason
      : optionsReason
        ? fillCopy(copy.agentUnavailableHere, { reason: optionsReason })
        : undefined;
  const busy = session.busy || (engaged && !!text.trim() && session.options.isFetching && !options);
  const canSend =
    session.ready &&
    !session.optionsAccessDenied &&
    !!workspace &&
    !session.busy &&
    !session.unknown &&
    !permission.unavailable &&
    !!text.trim();

  async function send() {
    if (!canSend || !workspace) return;
    const fresh = options ? undefined : await session.options.refetch();
    const read = options ?? (fresh?.isSuccess ? fresh.data : undefined);
    if (!read?.available) return;
    const value = text.trim();
    const promptAtCreate = newSessionProvider(agent, read)?.create.mode === "with-first-message";
    const fields = newSessionCreateFields(
      {
        agent,
        workspaceId: workspace.id,
        permission: permission.requested,
        fullAccess: session.fullAccess,
      },
      read,
    );
    if (
      permission.requested &&
      fields.policyId !== permission.requested &&
      fields.permissionMode !== permission.requested
    )
      return;
    const draft = promptAtCreate ? undefined : value;
    submittedDraft.current = draft;
    rememberNewSessionTarget({ workspaceId: workspace.id, agent });
    const sessionId = await session.create(promptAtCreate ? { ...fields, prompt: value } : fields);
    if (!sessionId) return;
    setText("");
    onCreated(sessionId, draft);
  }

  const notice = !workspaces.length
    ? copy.noWorkspaceHint
    : session.unknown
      ? copy.unknown
      : session.failure
        ? isNewSessionPermissionFailure(session.failure.detail)
          ? session.failure.reason
          : fillCopy(copy.notCreated, { reason: session.failure.reason })
        : unavailable;
  const recent = recentContinuationWorkspaces(workspaces, MENU_WORKSPACES);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5 px-3">
      <div className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card pl-3 pr-1 text-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        {busy ? (
          <Loader2
            aria-hidden="true"
            size={15}
            className="shrink-0 animate-spin text-muted-foreground"
          />
        ) : (
          <Plus aria-hidden="true" size={15} className="shrink-0 text-muted-foreground" />
        )}
        <Input
          value={text}
          aria-label={copy.newSession}
          placeholder={tr("menubar.newSession")}
          disabled={
            session.providerDisabled || session.busy || session.unknown || !workspaces.length
          }
          className="h-full min-w-0 flex-1 truncate rounded-none border-0 bg-transparent px-0 py-0 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          onFocus={() => setEngaged(true)}
          onChange={(event) => {
            setEngaged(true);
            setText(event.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.shiftKey ||
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            void send();
          }}
        />
        {workspace && (
          <ComposerPermissionMenu
            compact
            label={shownPermission?.name ?? permissionTitle}
            title={permissionTitle}
            risky={shownPermission?.risky}
            disabled={!permissions || session.busy || session.unknown}
            disabledReason={
              !permissions && !session.providerDisabled
                ? session.optionsLoading
                  ? copy.loadingOptions
                  : copy.optionsUnavailable
                : undefined
            }
            side="bottom"
            items={permissions?.choices ?? []}
            selected={selectedPermission?.id}
            onSelect={permission.select}
          />
        )}
        {workspace && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="bare"
                  size="content"
                  aria-label={tr("menubar.chooseTarget", {
                    workspace: workspace.name,
                    agent: agentName(agent),
                  })}
                  className="inline-flex h-7 max-w-[9.5rem] shrink-0 items-center gap-1.5 rounded-lg bg-muted px-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              }
            >
              <AgentMark agent={agent} size={13} />
              <span className="truncate text-xs">{workspace.name}</span>
              <ChevronDown aria-hidden="true" className="size-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuLabel>{copy.workspace}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={workspace.id}
                onValueChange={(value) =>
                  setTarget((current) => ({ ...current, workspaceId: String(value) }))
                }
              >
                {recent.map((item) => (
                  <DropdownMenuRadioItem key={item.id} value={item.id}>
                    <span className="truncate">{item.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{copy.agent}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={agent}
                onValueChange={(value) => {
                  permission.reset();
                  setTarget((current) => ({ ...current, agent: value as ManagedAgent }));
                }}
              >
                {NEW_SESSION_AGENTS.map((item) => (
                  <DropdownMenuRadioItem
                    key={item}
                    value={item}
                    disabled={notInstalled.has(item) || !!session.disabledSessionProviders?.[item]}
                  >
                    <AgentMark agent={item} size={14} />
                    <span className="truncate">{agentName(item)}</span>
                    {notInstalled.has(item) && !session.disabledSessionProviders?.[item] && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {copy.notInstalled}
                      </span>
                    )}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {notice && (
        <p
          role={session.failure ? "alert" : "status"}
          className={cn(
            "px-1 text-xs leading-5",
            session.failure ? "text-destructive-text" : "text-muted-foreground",
          )}
        >
          {notice}
        </p>
      )}
    </div>
  );
}
