import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Power, Settings } from "lucide-react";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { homeSessionCopy } from "@agentkib/session-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { desktopApi } from "@/core/desktop";
import type { AppNavigationRequest, ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { continuationIndexingEnabled } from "@/features/home/home-continuations";
import {
  homeKeys,
  useHomeInstallations,
  useHomeRemoteStatus,
  useHomeWorkspaces,
} from "@/features/home/home-query";
import { useHomeReplies } from "@/features/home/home-replies";
import { homeSessionGroups } from "@/features/home/home-sessions";
import {
  DEFAULT_QUOTA_PREFERENCES,
  useQuotaPreferences,
  useQuotaQueryEvents,
  useQuotaRefreshJob,
  useQuotaRefreshMutation,
  useQuotaSnapshot,
} from "@/features/quota/quota-query";
import { useConversationCatalog } from "@/features/sessions/conversation-catalog";
import { sessionGroupLabels } from "@/features/sessions/session-catalog";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { MenuBarNewSession } from "./menubar-new-session";
import { QuotaPanel, QuotaRing, quotaRingProviders } from "./menubar-quota";
import { MenuBarRemote } from "./menubar-remote";
import { MenuBarSessions } from "./menubar-sessions";
import { useNow, usePopoverHeight, usePopoverOpen, usePopoverRuntime } from "./use-popover";

type Session = ConversationSessionSummary;

const openMain = (request?: AppNavigationRequest) =>
  void desktopApi()
    .shell.openMain(request)
    .catch(() => undefined);

/**
 * The menu bar popover: what waits for the person, running turns and unread results on one page,
 * with the first approval answered in place, a one-line new session, each Agent's quota as a ring
 * and remote access. Everything else opens the main window.
 */
export function MenuBarPopover() {
  const { locale, tr, formatRelativeTime, localizeMessage } = useI18n();
  const t = homeSessionCopy(locale);
  const { open, opened } = usePopoverOpen();
  const runtime = usePopoverRuntime(open);
  const indexEnabled = continuationIndexingEnabled(runtime);
  const controlled = hasDesktopConversation();
  const catalog = useConversationCatalog(open && indexEnabled, indexEnabled);
  const replies = useHomeReplies(catalog.sessions);
  const queryClient = useQueryClient();
  const workspacesQuery = useHomeWorkspaces();
  const workspaces = useMemo(() => workspacesQuery.data ?? [], [workspacesQuery.data]);
  const installations = useHomeInstallations();
  const notInstalled = useMemo(
    () =>
      new Set<string>(
        (installations.data ?? []).filter((item) => !item.installed).map((item) => item.agent),
      ),
    [installations.data],
  );
  const remote = useHomeRemoteStatus();
  const snapshot = useQuotaSnapshot().data;
  const preferences = useQuotaPreferences().data ?? DEFAULT_QUOTA_PREFERENCES;
  const refreshJob = useQuotaRefreshJob().data;
  const refreshQuota = useQuotaRefreshMutation();
  const [quotaError, setQuotaError] = useState<string>();
  useQuotaQueryEvents();

  // Each opening reads the quick things again; sessions follow the catalog while open.
  useEffect(() => {
    if (!open) return;
    void queryClient.invalidateQueries({ queryKey: homeKeys.workspaces() });
    void queryClient.invalidateQueries({ queryKey: homeKeys.remoteStatus() });
  }, [open, queryClient]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) void desktopApi().shell.hideWindow();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo(() => {
    const value = homeSessionGroups(catalog.sessions, {
      recent: 0,
      unconfirmed: replies.unconfirmed,
    });
    // An answered request stays off the list until the catalog reports the session again.
    return replies.answered.size
      ? {
          ...value,
          needsYou: value.needsYou.filter(
            ({ session, need }) => need === "verify" || !replies.answered.has(session.id),
          ),
        }
      : value;
  }, [catalog.sessions, replies.unconfirmed, replies.answered]);
  const labels = useMemo(
    () =>
      sessionGroupLabels(catalog.sessions, [
        ...workspaces,
        ...Object.entries(SESSION_COLLECTIONS).map(([kind, id]) => ({
          id,
          name: tr(kind === "projectless" ? "sessions.projectless" : "sessions.unclassified"),
          path: "",
        })),
      ]),
    [catalog.sessions, workspaces, tr],
  );
  const describe = (session: Session) => ({
    title: displaySessionTitle(session.title, tr),
    workspace:
      labels.get(session.id) ?? workspaces.find(({ id }) => id === session.workspace_id)?.name,
    time: session.updated_at ? formatRelativeTime(session.updated_at) : undefined,
  });

  // The first approval opens as a card each time the popover opens, until the person folds it or
  // opens another; a choice holds for the opening it was made in.
  const [expanded, setExpanded] = useState<{ opened: number; id: string | undefined }>();
  const firstApproval = groups.needsYou.find(({ need }) => need === "approval")?.session.id;
  const shownExpanded = expanded?.opened === opened ? expanded.id : firstApproval;
  const now = useNow(open && groups.running.some(({ startedAt }) => !!startedAt));

  const providers = quotaRingProviders(snapshot, preferences);
  const [quotaOpen, setQuotaOpen] = useState<string>();
  const quotaProvider = providers.find((provider) => provider.id === quotaOpen);
  const quotaBusy = refreshJob?.state === "queued" || refreshJob?.state === "running";

  const top = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLElement>(null);
  usePopoverHeight(top, list, bottom);

  const openSession = (session: Session) =>
    openMain({ page: "sessions", session_id: session.id, configure_popover: false });
  const attention = groups.needsYou.length + groups.running.length + groups.review.length;
  let content: ReactNode;
  if (!runtime) content = <Placeholder />;
  else if (!indexEnabled)
    content = (
      <Notice text={tr("menubar.indexOff")}>
        <LinkButton onClick={() => openMain({ page: "home", configure_popover: false })}>
          {tr("menubar.openApp")}
        </LinkButton>
      </Notice>
    );
  else if (!catalog.usable)
    content =
      catalog.error !== undefined && !catalog.refreshing ? (
        <Notice text={localizeMessage(catalog.error) || tr("home.continuationsError")} />
      ) : (
        <Placeholder />
      );
  else if (!attention)
    content = (
      <div className="grid justify-items-center gap-1.5 px-6 py-8 text-center">
        <span className="mb-1 grid size-10 place-items-center rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
          <Check aria-hidden="true" size={20} />
        </span>
        <h2 className="text-sm font-semibold">{t.allClear}</h2>
        <p className="text-xs text-muted-foreground">{t.allClearHint}</p>
      </div>
    );
  else
    content = (
      <MenuBarSessions
        groups={groups}
        describe={describe}
        replies={controlled ? replies : undefined}
        workspacePath={(session) => workspaces.find(({ id }) => id === session.workspace_id)?.path}
        now={now}
        expanded={shownExpanded}
        onExpand={(id) => setExpanded({ opened, id })}
        onOpen={openSession}
      />
    );

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div ref={top} className="flex flex-col gap-2.5 pb-1 pt-2.5">
        <header className="flex items-center gap-0.5 pl-4 pr-2">
          <h1 className="mr-auto text-[15px] font-semibold">AgentKib</h1>
          {providers.map((provider) => (
            <QuotaRing
              key={provider.id}
              provider={provider}
              selected={provider.id === quotaOpen}
              onClick={() => {
                setQuotaError(undefined);
                setQuotaOpen((current) => (current === provider.id ? undefined : provider.id));
              }}
            />
          ))}
          <Button
            variant="bare"
            size="content"
            aria-label={tr("nav.settings")}
            className="grid size-9 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() =>
              openMain({ page: "settings", settings_section: "general", configure_popover: false })
            }
          >
            <Settings aria-hidden="true" className="size-[17px]" />
          </Button>
        </header>
        {quotaProvider && snapshot && (
          <QuotaPanel
            provider={quotaProvider}
            snapshot={snapshot}
            preferences={preferences}
            refreshing={quotaBusy || refreshQuota.isPending}
            error={quotaError}
            onRefresh={() => {
              setQuotaError(undefined);
              void refreshQuota
                .mutateAsync()
                .catch((reason: unknown) => setQuotaError(localizeMessage(reason)));
            }}
            onOpen={() =>
              openMain({ page: "quota", provider: quotaProvider.id, configure_popover: false })
            }
          />
        )}
        {indexEnabled && controlled && (
          <MenuBarNewSession
            workspaces={workspaces}
            notInstalled={notInstalled}
            onCreated={(sessionId, text) =>
              openMain({
                page: "sessions",
                session_id: sessionId,
                draft: text,
                configure_popover: false,
              })
            }
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div ref={list}>{content}</div>
      </div>
      <footer ref={bottom} className="border-t border-border">
        {remote.data && (
          <MenuBarRemote
            status={remote.data}
            onChanged={() =>
              void queryClient.invalidateQueries({ queryKey: homeKeys.remoteStatus() })
            }
            onOpenSettings={() =>
              openMain({ page: "settings", settings_section: "remote", configure_popover: false })
            }
          />
        )}
        <div className="flex items-center justify-between px-2 pb-2 pt-1 text-sm">
          <FooterButton onClick={() => openMain()}>
            <ExternalLink aria-hidden="true" className="size-[15px]" />
            {tr("menubar.openApp")}
          </FooterButton>
          <FooterButton onClick={() => void desktopApi().shell.quit()}>
            <Power aria-hidden="true" className="size-[15px]" />
            {tr("menubar.quit")}
          </FooterButton>
        </div>
      </footer>
    </main>
  );
}

function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="bare"
      size="content"
      className="inline-flex h-8 items-center gap-2 rounded-lg px-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="bare"
      size="content"
      className="rounded-md font-medium text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function Notice({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 px-6 py-8 text-center text-xs">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  );
}

/** Rows standing in while the first catalog read is on its way; never a "loading" card. */
function Placeholder() {
  return (
    <div aria-busy="true" className="grid gap-1 px-4 py-3">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-3 py-2">
          <Skeleton className="size-9 rounded-[10px]" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
