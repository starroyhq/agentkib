import { AgentMark } from "@agentkib/agent-identity";
import { useDelayedBusy } from "@agentkib/session-ui";
import { ArrowRight, FolderGit2, Network, Smartphone, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import logoUrl from "@/assets/logo.svg";
import { Button } from "@agentkib/ui/button";
import { Card } from "@/components/ui/card";
import { AGENT_LABELS } from "@/core/agents";
import { api } from "@/core/api";
import type {
  AgentInstallation,
  AgentKind,
  ContextDoctorSummary,
  ConversationSessionSummary,
  MemoryRecord,
  OnboardingState,
  WorkspaceSummary,
} from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { withAsyncCleanup } from "@/lib/utils";
import {
  dismissActiveOnboarding,
  dismissOnboardingLocally,
  useOnboardingDismissedLocally,
} from "./onboarding-preference";

const RECENT_RESUME_LIMIT = 3;

function sortByRecent(sessions: readonly ConversationSessionSummary[]) {
  return [...sessions].sort((left, right) => {
    const leftMs = left.updated_at ? Date.parse(left.updated_at) : 0;
    const rightMs = right.updated_at ? Date.parse(right.updated_at) : 0;
    return rightMs - leftMs;
  });
}

export function GettingStartedCard({
  onboarding,
  workspaces,
  sessions = [],
  installations = [],
  installationsPending = false,
  remoteConnected = false,
  onRuntimeChanged,
  additionsBusy = false,
  onAddWorkspace,
  onAddRoot,
  onResumeSession,
  onNewSession,
  onOpenRemote,
  onOpenProjectAgent,
}: {
  onboarding?: OnboardingState;
  workspaces: WorkspaceSummary[];
  sessions?: ConversationSessionSummary[];
  doctorSummaries?: Record<string, ContextDoctorSummary>;
  memories?: MemoryRecord[];
  installations?: AgentInstallation[];
  installationsPending?: boolean;
  remoteConnected?: boolean;
  onRuntimeChanged: (runtime: Awaited<ReturnType<typeof api.updateOnboarding>>) => void;
  additionsBusy?: boolean;
  onAddWorkspace: () => Promise<void>;
  onAddRoot: () => Promise<void>;
  onOpenDoctor?: (workspace: WorkspaceSummary) => Promise<void>;
  onResumeSession?: (session: ConversationSessionSummary) => void;
  onNewSession?: () => void;
  onOpenRemote?: () => void;
  onOpenProjectAgent?: () => void;
}) {
  const { tr, formatRelativeTime, localizeMessage } = useI18n();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<{ reason: unknown }>();
  const errorMessage = error === undefined ? "" : localizeMessage(error.reason);
  const showInstallationLoading = useDelayedBusy(Boolean(installationsPending));
  const dismissedLocally = useOnboardingDismissedLocally(onboarding?.version);

  const visibleSessions = useMemo(
    () => sessions.filter((session) => !session.archived && !session.sidechain),
    [sessions],
  );
  const recentSessions = useMemo(
    () => sortByRecent(visibleSessions).slice(0, RECENT_RESUME_LIMIT),
    [visibleSessions],
  );
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const detectedAgents = useMemo(() => {
    const ordered: AgentKind[] = [];
    const seen = new Set<AgentKind>();
    for (const item of installations) {
      if (item.installed && !seen.has(item.agent)) {
        seen.add(item.agent);
        ordered.push(item.agent);
      }
    }
    for (const session of visibleSessions) {
      if (!seen.has(session.agent)) {
        seen.add(session.agent);
        ordered.push(session.agent);
      }
    }
    return ordered;
  }, [installations, visibleSessions]);

  if (!onboarding || onboarding.acknowledged_version >= onboarding.version || dismissedLocally) {
    return null;
  }

  const hasSessions = visibleSessions.length > 0;
  const hasWorkspaces = workspaces.length > 0;

  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current || additionsBusy) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    await withAsyncCleanup(
      async () => {
        try {
          await operation();
        } catch (reason) {
          setError({ reason });
        }
      },
      () => {
        busyRef.current = false;
        setBusy(false);
      },
    );
  };

  const dismiss = () =>
    run(async () => {
      const nextRuntime = await api.updateOnboarding({ event: "dismissed" });
      dismissOnboardingLocally(onboarding.version);
      onRuntimeChanged(nextRuntime);
    });

  const resumeSession = (session: ConversationSessionSummary) => {
    dismissActiveOnboarding(onRuntimeChanged, onboarding.version);
    onResumeSession?.(session);
  };

  const startNewSession = () => {
    dismissActiveOnboarding(onRuntimeChanged, onboarding.version);
    onNewSession?.();
  };

  return (
    <section
      aria-label={tr("onboarding.title")}
      className="mx-auto grid w-full max-w-3xl gap-5 py-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3.5">
          <img
            src={logoUrl}
            alt=""
            aria-hidden="true"
            className="size-9 shrink-0 rounded-xl dark:invert"
          />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-[-.025em] text-foreground">
              {hasSessions
                ? tr("onboarding.foundSessions", { count: visibleSessions.length })
                : tr("onboarding.title")}
            </h2>
            {hasWorkspaces && (
              <p className="mt-0.5 text-sm text-muted-foreground">
                {tr("onboarding.workspaceCount", { count: workspaces.length })}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {installationsPending && showInstallationLoading ? (
            <span
              className="inline-block h-7 w-24 animate-pulse rounded-full bg-muted motion-reduce:animate-none"
              role="status"
              aria-label={tr("common.loading")}
            />
          ) : (
            detectedAgents.map((agent) => (
              <span
                key={agent}
                className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card px-2.5 py-1 text-xs font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
              >
                <AgentMark agent={agent} size={14} />
                <span>{AGENT_LABELS[agent]}</span>
              </span>
            ))
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("onboarding.dismiss")}
            disabled={busy || additionsBusy}
            onClick={() => void dismiss()}
          >
            <X size={15} />
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl border-border/80 bg-card shadow-xs">
        {hasSessions ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-foreground">
                {tr("onboarding.resumeRecent")}
              </h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || additionsBusy}
                  onClick={() => void run(onAddRoot)}
                >
                  {tr("onboarding.addFolder")}
                </Button>
                {onNewSession && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || additionsBusy}
                    onClick={startNewSession}
                  >
                    {tr("sessions.newConversation")}
                  </Button>
                )}
              </div>
            </div>
            <ul className="divide-y divide-border/55">
              {recentSessions.map((session, index) => {
                const title = displaySessionTitle(session.title, tr);
                const meta = [
                  AGENT_LABELS[session.agent],
                  workspaceNames.get(session.workspace_id),
                  session.updated_at ? formatRelativeTime(session.updated_at) : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={session.id}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3.5">
                      <AgentIcon agent={session.agent} compact />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
                        {meta && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p>
                        )}
                      </div>
                    </div>
                    <Button
                      variant={index === 0 ? "default" : "outline"}
                      size="sm"
                      className="shrink-0"
                      disabled={busy || additionsBusy}
                      aria-label={`${tr("onboarding.resumeSession")}: ${title}`}
                      onClick={() => resumeSession(session)}
                    >
                      <span>{tr("onboarding.resumeSession")}</span>
                      {index === 0 && <ArrowRight size={14} aria-hidden="true" />}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-10 text-center">
            <span className="grid size-11 place-items-center rounded-xl border border-border/70 bg-muted text-muted-foreground">
              <FolderGit2 size={20} aria-hidden="true" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">
              {tr("onboarding.addFirstWorkspace")}
            </h3>
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              {!hasWorkspaces ? (
                <>
                  <Button
                    disabled={busy || additionsBusy}
                    aria-busy={busy || additionsBusy}
                    onClick={() => void run(onAddWorkspace)}
                  >
                    {tr("onboarding.addWorkspace")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || additionsBusy}
                    onClick={() => void run(onAddRoot)}
                  >
                    {tr("home.addScanRoot")}
                  </Button>
                </>
              ) : (
                <>
                  {onNewSession && (
                    <Button disabled={busy || additionsBusy} onClick={startNewSession}>
                      {tr("sessions.newConversation")}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    disabled={busy || additionsBusy}
                    onClick={() => void run(onAddRoot)}
                  >
                    {tr("onboarding.addFolder")}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="flex items-center justify-between gap-3 rounded-2xl border-border/80 bg-card px-4 py-3.5 shadow-xs">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Smartphone size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {tr("onboarding.connectPhone")}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {tr(
                  remoteConnected ? "onboarding.remoteConnected" : "onboarding.remoteDisconnected",
                )}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={busy || additionsBusy || !onOpenRemote}
            onClick={() => onOpenRemote?.()}
          >
            {tr("onboarding.scanToConnect")}
          </Button>
        </Card>

        <Card className="flex items-center justify-between gap-3 rounded-2xl border-border/80 bg-card px-4 py-3.5 shadow-xs">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/12 text-amber-700 dark:text-amber-300">
              <Network size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">
                {tr("sessions.projectAgent")}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {tr("onboarding.assignableSessions", { count: visibleSessions.length })}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={busy || additionsBusy || !onOpenProjectAgent}
            onClick={() => onOpenProjectAgent?.()}
          >
            {tr("onboarding.buildTeam")}
          </Button>
        </Card>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-2.5 text-xs text-destructive-text"
        >
          {errorMessage}
        </div>
      )}
    </section>
  );
}
