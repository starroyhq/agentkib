import { useRef, useState } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { AgentMark, agentName } from "@agentkib/agent-identity";
import type { ManagedAgent } from "@agentkib/web-client";
import {
  fillCopy,
  NEW_SESSION_AGENTS,
  newSessionCopy,
  newSessionCreateFields,
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
import { codexReason } from "@/features/sessions/conversation/features/sessions/codex-copy";
import {
  readNewSessionTarget,
  rememberNewSessionTarget,
} from "@/features/sessions/conversation/features/sessions/new-session-draft";
import { failureOf, useNewSession } from "@/features/sessions/new-session/use-new-session";

/** Workspaces the target menu lists, most recently active first. */
const MENU_WORKSPACES = 8;

/**
 * Starts a session from the menu bar in one line: Enter creates it in the last workspace and Agent
 * used, through the same create as the new-session composer, then opens it in the main window,
 * whose composer sends this text as the first message.
 */
export function MenuBarNewSession({
  workspaces,
  notInstalled,
  onCreated,
}: {
  workspaces: WorkspaceSummary[];
  notInstalled: ReadonlySet<string>;
  onCreated: (sessionId: string, text: string) => void;
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
  const sent = useRef("");
  const composing = useRef(false);
  const session = useNewSession({
    agent,
    locale,
    readOptions: engaged,
    // A create checked after its outcome was unknown opens the session it made.
    onReconciled: (sessionId, own) => {
      if (own) onCreated(sessionId, sent.current);
    },
  });
  const options = session.options.data;
  const unavailable = session.options.isError
    ? failureOf(session.options.error, locale).reason
    : options && !options.available
      ? fillCopy(copy.agentUnavailableHere, { reason: codexReason(locale, options.reason).text })
      : undefined;
  const busy = session.busy || (engaged && !!text.trim() && session.options.isFetching && !options);
  const canSend =
    session.ready && !!workspace && !session.busy && !session.unknown && !!text.trim();

  async function send() {
    if (!canSend || !workspace) return;
    const read = options ?? (await session.options.refetch()).data;
    if (!read?.available) return;
    const value = text.trim();
    sent.current = value;
    rememberNewSessionTarget({ workspaceId: workspace.id, agent });
    const sessionId = await session.create(
      newSessionCreateFields({ agent, workspaceId: workspace.id }, read),
    );
    if (!sessionId) return;
    setText("");
    onCreated(sessionId, value);
  }

  const notice = !workspaces.length
    ? copy.noWorkspaceHint
    : session.unknown
      ? copy.unknown
      : session.failure
        ? fillCopy(copy.notCreated, { reason: session.failure.reason })
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
          disabled={session.busy || session.unknown || !workspaces.length}
          className="h-full min-w-0 flex-1 truncate rounded-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
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
                onValueChange={(value) =>
                  setTarget((current) => ({ ...current, agent: value as ManagedAgent }))
                }
              >
                {NEW_SESSION_AGENTS.map((item) => (
                  <DropdownMenuRadioItem key={item} value={item} disabled={notInstalled.has(item)}>
                    <AgentMark agent={item} size={14} />
                    <span className="truncate">{agentName(item)}</span>
                    {notInstalled.has(item) && (
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
