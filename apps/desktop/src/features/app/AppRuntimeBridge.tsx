import { useI18n } from "@/core/useI18n";
import { agentName } from "@agentkib/agent-identity";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import { cacheEffectiveLocale, changeLocale } from "@/core/i18n";
import {
  accentThemePreference,
  applyAccentTheme,
  applyTheme,
  cacheAccentTheme,
  cacheEffectiveTheme,
} from "@/core/theme";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { useAppStore } from "@/stores/app-store";
import { synchronizeSidebarWidth, useSidebarWidthStore } from "./sidebar-width-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useHomeQueryEvents } from "@/features/home/home-query";
import { useInsightsQueryEvents } from "@/features/insights/insights-query";
import { useQuotaQueryEvents } from "@/features/quota/quota-query";
import { useSkillSyncEvents } from "@/features/skills/skills-query";
import { withAsyncCleanup } from "@/lib/utils";
import type { AppMenuCommandRequest, AppNavigationRequest, EffectiveTheme } from "@/core/types";
import type { DesktopRuntimeStatus, QuitRequest } from "../../../electron/api";

/** Up to three of the sessions a quit would stop, by title, in the locale's list style. */
export function quitWorkNames(work: QuitRequest["work"], locale: string): string {
  const cjk = locale.startsWith("zh") || locale.startsWith("ja");
  const names = work.slice(0, 3).map((item) => {
    const name = item.title.trim() || agentName(item.agent);
    return cjk ? `「${name}」` : `“${name}”`;
  });
  return names.join(cjk ? "、" : ", ") + (work.length > 3 ? "…" : "");
}

function hasUnsavedWorkspaceDraft(workspace: ReturnType<typeof useWorkspaceStore.getState>) {
  const manifestChanged = Boolean(
    workspace.manifest &&
    workspace.baselineManifest &&
    JSON.stringify(workspace.manifest) !== workspace.baselineManifest,
  );
  return manifestChanged || Object.keys(workspace.workspaceDrafts).length > 0;
}

export function AppRuntimeBridge() {
  const { locale, localizeMessage, tr } = useI18n();
  const dialogs = useAppDialogs();
  const queryClient = useQueryClient();
  const appStore = useAppStore();
  const setMessage = useWorkspaceStore((state) => state.setMessage);
  const { setRuntime, setNavigationRequest, setMenuCommand } = appStore;
  const quitPromptOpen = useRef(false);
  const previousRuntimeState = useRef<DesktopRuntimeStatus["state"] | undefined>(undefined);
  const [runtimeStatus, setRuntimeStatus] = useState<DesktopRuntimeStatus>();
  const [retrying, setRetrying] = useState(false);
  const runtimeErrorMessage = useRef<string | undefined>(undefined);
  const clearRuntimeError = useCallback(() => {
    const previous = runtimeErrorMessage.current;
    runtimeErrorMessage.current = undefined;
    // A recovered Runtime must not dismiss a newer workspace/action error.
    if (previous !== undefined) setMessage((current) => (current === previous ? "" : current));
  }, [setMessage]);

  useQuotaQueryEvents();
  useHomeQueryEvents();
  useInsightsQueryEvents();
  useSkillSyncEvents();

  useEffect(() => {
    let disposed = false;
    let initialSyncPending = true;
    const desktop = desktopApi();
    const reportRuntimeError = (error: unknown) => {
      if (disposed) return;
      const message = localizeMessage(error);
      runtimeErrorMessage.current = message;
      setMessage(message);
    };
    const synchronizeRuntime = async () => {
      const widthRevision = useSidebarWidthStore.getState().revision;
      let nextRuntime = await api.runtime();
      if (disposed) return;
      clearRuntimeError();
      if (nextRuntime.accent_theme_preference == null) {
        try {
          nextRuntime = await api.setAccentThemePreference(accentThemePreference());
        } catch (error) {
          if (!disposed) setMessage(localizeMessage(error));
        }
      }
      if (disposed) return;
      nextRuntime = synchronizeSidebarWidth(nextRuntime, widthRevision);
      setRuntime(nextRuntime);
      applyTheme(nextRuntime.effective_theme);
      cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
      const accentTheme = nextRuntime.accent_theme_preference ?? accentThemePreference();
      applyAccentTheme(accentTheme);
      cacheAccentTheme(accentTheme);
      cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference);
      await changeLocale(nextRuntime.effective_locale);
    };
    const onThemeChanged = (theme: EffectiveTheme) => {
      setRuntime((current) => {
        if (!current || current.theme_preference !== "system") return current;
        applyTheme(theme);
        cacheEffectiveTheme(theme, "system");
        return { ...current, effective_theme: theme };
      });
    };
    const onRuntimeStatus = (status: DesktopRuntimeStatus) => {
      const previous = previousRuntimeState.current;
      previousRuntimeState.current = status.state;
      setRuntimeStatus(status);
      if (status.state === "ready" && previous && previous !== "ready" && !initialSyncPending) {
        void synchronizeRuntime()
          .then(() => queryClient.invalidateQueries())
          .catch(reportRuntimeError);
      }
    };
    const unsubscribers = [
      desktop.events.onNavigate((request: AppNavigationRequest) => setNavigationRequest(request)),
      desktop.events.onMenuCommand((request: AppMenuCommandRequest) => setMenuCommand(request)),
      desktop.events.onThemeChanged(onThemeChanged),
      desktop.events.onRuntimeStatus(onRuntimeStatus),
    ];
    void withAsyncCleanup(
      async () => {
        try {
          onRuntimeStatus(await desktop.runtime.status());
          const legacy = localStorage.getItem("agentkib.project");
          if (legacy) {
            try {
              await api.addWorkspace(legacy);
              localStorage.removeItem("agentkib.project");
            } catch (error) {
              if (!disposed) setMessage(localizeMessage(error));
            }
          }
          await synchronizeRuntime();
        } catch (error) {
          reportRuntimeError(error);
        }
      },
      () => {
        initialSyncPending = false;
      },
    );
    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [
    clearRuntimeError,
    queryClient,
    setMenuCommand,
    setMessage,
    setNavigationRequest,
    setRuntime,
  ]);

  useEffect(() => {
    const refreshRuntime = () => {
      const widthRevision = useSidebarWidthStore.getState().revision;
      void api
        .runtime()
        .then(async (runtime) => {
          clearRuntimeError();
          let nextRuntime =
            runtime.accent_theme_preference == null
              ? await api.setAccentThemePreference(accentThemePreference())
              : runtime;
          nextRuntime = synchronizeSidebarWidth(nextRuntime, widthRevision);
          setRuntime(nextRuntime);
          applyTheme(nextRuntime.effective_theme);
          cacheEffectiveTheme(nextRuntime.effective_theme, nextRuntime.theme_preference);
          const accentTheme = nextRuntime.accent_theme_preference ?? accentThemePreference();
          applyAccentTheme(accentTheme);
          cacheAccentTheme(accentTheme);
          cacheEffectiveLocale(nextRuntime.effective_locale, nextRuntime.locale_preference);
          await changeLocale(nextRuntime.effective_locale);
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshRuntime);
    return () => window.removeEventListener("focus", refreshRuntime);
  }, [clearRuntimeError, setRuntime]);

  useEffect(() => {
    const handleQuitRequest = async (request: QuitRequest) => {
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      const ticket = request.ticket;
      let quitting = false;
      try {
        // Read drafts only when a quit is requested.
        const workspace = useWorkspaceStore.getState();
        if (workspace.applyingChanges) {
          await dialogs.notify(tr("dialog.quit.changesApplying"));
          return;
        }
        const canResume = Boolean(ticket && request.work.some((item) => item.resumable));
        let resume = canResume && request.resumeByDefault !== false;
        if (request.work.length || request.reason) {
          const previewFailure = request.reason
            ? tr(
                request.reason === REMOTE_ERROR_CODES.deadlineExceeded
                  ? "dialog.quit.prepareTimeout"
                  : "dialog.quit.prepareFailed",
              )
            : undefined;
          const confirm = await dialogs.confirm({
            title: previewFailure ?? tr("dialog.quit.workTitle"),
            description: request.work.length
              ? ticket
                ? tr("dialog.quit.workCount", { count: request.work.length })
                : tr("dialog.quit.workRunning", {
                    count: request.work.length,
                    names: quitWorkNames(request.work, locale),
                  })
              : undefined,
            body: ticket ? (
              <div className="grid gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox
                    defaultChecked={resume}
                    disabled={!canResume}
                    onCheckedChange={(value) => {
                      resume = value;
                    }}
                  />
                  {tr("dialog.quit.resumeWork")}
                </label>
                <ul className="grid max-h-36 gap-1 overflow-y-auto pl-6">
                  {request.work.map((item, index) => {
                    const title = item.title.trim() || agentName(item.agent);
                    return (
                      <li key={index}>
                        {item.resumable ? (
                          title
                        ) : (
                          <label className="flex items-center gap-2 text-muted-foreground">
                            <Checkbox checked={false} disabled />
                            <span>{title}</span>
                          </label>
                        )}
                        {item.reason && (
                          <span>
                            {tr(
                              item.reason === REMOTE_ERROR_CODES.quitWorkQueueUnconfirmed
                                ? "home.quitWork.queueUnconfirmed"
                                : "dialog.quit.candidateUnavailable",
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : undefined,
            tone: "destructive",
            confirmLabel: tr("dialog.quit.quitAnyway"),
          });
          if (!confirm) return;
        }
        if (
          hasUnsavedWorkspaceDraft(workspace) &&
          !(await dialogs.confirm({
            description: tr("dialog.quit.discardDraft"),
            tone: "destructive",
          }))
        )
          return;
        if (ticket) await api.quitApp({ ticket, resume });
        else await api.quitApp();
        quitting = true;
      } catch (error) {
        setMessage(localizeMessage(error));
      } finally {
        if (ticket && !quitting) await api.cancelQuit(ticket).catch(() => undefined);
        quitPromptOpen.current = false;
      }
    };
    return desktopApi().events.onQuitRequested((request) => void handleQuitRequest(request));
  }, [dialogs, locale, localizeMessage, setMessage, tr]);

  if (runtimeStatus?.state !== "failed") return null;

  return (
    <div
      role="alert"
      className="fixed left-1/2 top-16 z-50 flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-destructive/30 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur"
    >
      <AlertTriangle className="shrink-0 text-destructive-icon" size={18} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{tr("runtime.startFailed")}</p>
        {runtimeStatus.error && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={runtimeStatus.error}>
            {runtimeStatus.error}
          </p>
        )}
      </div>
      <Button
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          void desktopApi()
            .runtime.retry()
            .catch((error: unknown) => {
              const message = localizeMessage(error);
              runtimeErrorMessage.current = message;
              setMessage(message);
            })
            .finally(() => setRetrying(false));
        }}
      >
        <RefreshCw className={retrying ? "animate-spin" : undefined} size={15} />
        {tr(retrying ? "runtime.retrying" : "runtime.retry")}
      </Button>
    </div>
  );
}
