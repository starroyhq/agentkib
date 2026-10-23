import { useI18n } from "@/core/useI18n";
import { useRef, useState } from "react";
import { Database, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RemoteErrorDetails } from "@/features/remote/RemoteErrorDetails";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import { useSessionHistory } from "./useSessionHistory";
import { withAsyncCleanup } from "@/lib/utils";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { DesktopConversationPane } from "./DesktopConversationPane";
import { SessionNotice as Notice } from "./SessionNotice";
import { SessionOverview } from "./SessionOverview";
import { SessionHistoryContent } from "./SessionHistoryContent";
import { SessionHistoryContinuationDialog } from "./SessionHistoryContinuationDialog";
import { useSessionHistoryScroll } from "./useSessionHistoryScroll";

export function SessionHubPage() {
  const { localizeMessage, tr } = useI18n();
  const hub = useSessionHub();
  const continuation = useSessionViewStore((state) => state.historyContinuation);
  const continuationDialog = continuation ? (
    <SessionHistoryContinuationDialog request={continuation} />
  ) : null;
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const interactive =
    hasDesktopConversation() &&
    !hub.selected?.remote &&
    (creating ||
      (hub.selected?.availability === "readable" &&
        ["codex", "claude-code", "antigravity"].includes(hub.selected.agent)));
  const history = useSessionHistory(hub.selected, hub.enabled && !interactive, hub.historyRevision);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");
  const enableLock = useRef(false);
  const sessionKey = JSON.stringify([
    hub.selected?.remote?.host_id,
    hub.selected?.workspace_id,
    hub.selected?.id,
  ]);
  const { historyRef, loadEarlier } = useSessionHistoryScroll(sessionKey, history);

  const enable = async () => {
    if (enableLock.current) return;
    enableLock.current = true;
    setEnabling(true);
    setEnableError("");
    await withAsyncCleanup(
      async () => {
        try {
          useAppStore.getState().setRuntime(await api.setSessionIndexEnabled(true));
        } catch (error) {
          setEnableError(localizeMessage(error));
        }
      },
      () => {
        enableLock.current = false;
        setEnabling(false);
      },
    );
  };

  if (!hub.runtimeReady || hub.workspacesLoading)
    return (
      <div
        className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
        role="status"
      >
        <RefreshCw className="animate-spin" size={24} />
        <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
          {tr("sessions.loading")}
        </p>
      </div>
    );
  if (!hub.enabled)
    return (
      <div className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Database size={32} />
        <h1 className="text-xl font-semibold">{tr("conversations.indexDisabled")}</h1>
        <p className="max-w-[520px] leading-[1.7] text-muted-foreground">
          {tr("sessions.enableDescription")}
        </p>
        {enableError && <Notice error>{enableError}</Notice>}
        <Button disabled={enabling} onClick={() => void enable()}>
          {tr(enabling ? "sessions.enabling" : "conversations.enable")}
        </Button>
      </div>
    );
  if (hub.workspacesError && !hub.workspaces.length)
    return (
      <div className="session-state flex min-w-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <Notice error>{hub.workspacesError}</Notice>
        <Button onClick={hub.retryWorkspaces}>{tr("sessions.retry")}</Button>
      </div>
    );

  const selected = hub.selected;
  const remoteNotices = hub.remoteHosts?.filter(
    (host) => host.status !== "online" || hub.remoteErrors?.[host.id],
  );
  const scanErrorCount = Object.keys(hub.errors).length;
  const hasCatalogNotices =
    !!hub.catalogError || !!remoteNotices?.length || !!hub.workspacesError || scanErrorCount > 0;

  const catalogNotices = (
    <>
      {hub.catalogError && (
        <Notice error>
          {hub.catalogError}
          <Button variant="ghost" disabled={hub.refreshing} onClick={() => void hub.refresh()}>
            {tr("sessions.retry")}
          </Button>
        </Notice>
      )}
      {!interactive && hub.hiddenSessionNotice && <Notice>{tr("sessions.hiddenRecord")}</Notice>}
      {remoteNotices?.map((host) => (
        <Notice key={host.id} error={!!hub.remoteErrors?.[host.id]}>
          {host.name} · {tr(`remote.state.${host.status}`)}
          {hub.remoteErrors?.[host.id] && <RemoteErrorDetails error={hub.remoteErrors[host.id]} />}
        </Notice>
      ))}
      {hub.workspacesError && (
        <Notice error>
          {hub.workspacesError}
          <Button variant="ghost" onClick={hub.retryWorkspaces}>
            {tr("sessions.retry")}
          </Button>
        </Notice>
      )}
      {scanErrorCount > 0 && (
        <Notice error>{tr("sessions.partialFailure", { count: scanErrorCount })}</Notice>
      )}
    </>
  );

  if (interactive)
    return (
      <div className="session-hub-page flex min-w-0 min-h-0 flex-1 flex-col text-sm">
        {hasCatalogNotices && (
          <div
            className="max-h-[40%] shrink-0 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            role="region"
            aria-label={tr("sessions.directory")}
            tabIndex={0}
          >
            {catalogNotices}
          </div>
        )}
        {continuationDialog}
        <DesktopConversationPane
          sessionId={creating ? undefined : selected?.id}
          create={creating}
        />
      </div>
    );

  return (
    <div className="session-hub-page flex min-w-0 min-h-0 flex-1 flex-col text-sm">
      {continuationDialog}
      <div
        className="session-hub-body min-h-0 flex-1 overflow-auto overscroll-contain p-6 px-7 pb-8 [overflow-anchor:none] max-[600px]:p-4"
        ref={historyRef}
      >
        {catalogNotices}
        {selected ? (
          <SessionHistoryContent
            selected={selected}
            history={history}
            sessionKey={sessionKey}
            loadEarlier={loadEarlier}
          />
        ) : (
          <SessionOverview />
        )}
      </div>
    </div>
  );
}
