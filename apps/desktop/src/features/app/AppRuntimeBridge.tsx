import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { withAsyncCleanup } from "@/lib/utils";
import type { AppMenuCommandRequest, AppNavigationRequest, EffectiveTheme } from "@/core/types";
import type { DesktopRuntimeStatus } from "../../../electron/api";

function hasUnsavedWorkspaceDraft(workspace: ReturnType<typeof useWorkspaceStore.getState>) {
  const manifestChanged = Boolean(
    workspace.manifest &&
    workspace.baselineManifest &&
    JSON.stringify(workspace.manifest) !== workspace.baselineManifest,
  );
  return manifestChanged || Object.keys(workspace.workspaceDrafts).length > 0;
}

export function AppRuntimeBridge() {
  const { localizeMessage, tr } = useI18n();
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
    const handleQuitRequest = async () => {
      if (quitPromptOpen.current) return;
      quitPromptOpen.current = true;
      await withAsyncCleanup(
        async () => {
          // 只在退出时读取一次草稿状态：之前每次渲染都序列化整个 manifest 做比较。
          const workspace = useWorkspaceStore.getState();
          if (workspace.applyingChanges) {
            await dialogs.notify(tr("dialog.quit.changesApplying"));
            return;
          }
          if (
            hasUnsavedWorkspaceDraft(workspace) &&
            !(await dialogs.confirm({
              description: tr("dialog.quit.discardDraft"),
              tone: "destructive",
            }))
          )
            return;
          await api.quitApp();
        },
        () => {
          quitPromptOpen.current = false;
        },
      );
    };
    return desktopApi().events.onQuitRequested(() => void handleQuitRequest());
  }, [dialogs, tr]);

  if (runtimeStatus?.state !== "failed") return null;

  return (
    <div
      role="alert"
      className="fixed left-1/2 top-16 z-50 flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-destructive/30 bg-background/95 px-4 py-3 text-sm shadow-lg backdrop-blur"
    >
      <AlertTriangle className="shrink-0 text-destructive" size={18} aria-hidden="true" />
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
