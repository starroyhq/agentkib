import { agentName } from "@agentkib/agent-identity";
import { Dialog } from "@/components/dialog";
import { useSession } from "@/features/sessions/session-context";
export function SessionDetailsDialog() {
  const {
    t,
    c,
    setModal,
    current,
    currentWorkspace,
    formatCatalogTime,
    sourceTitle,
    online,
    liveText,
  } = useSession();
  return (
    <Dialog closeLabel={t.close} title={t.metadata} onClose={() => setModal(undefined)}>
      <dl>
        <dt>{t.agent}</dt>
        <dd>{agentName(current?.agent)}</dd>
        <dt>{c.project}</dt>
        <dd>{currentWorkspace?.name || c.missing}</dd>
        <dt>{c.path}</dt>
        <dd>{currentWorkspace?.path || c.unknown}</dd>
        <dt>{c.updated}</dt>
        <dd>{formatCatalogTime(current?.updated_at)}</dd>
        <dt>{c.created}</dt>
        <dd>{formatCatalogTime(current?.created_at)}</dd>
        <dt>{c.branch}</dt>
        <dd>{current?.git_branch || c.unknown}</dd>
        <dt>{c.source}</dt>
        <dd>
          {current?.origin === "auxiliary"
            ? c.auxiliarySource
            : current?.origin === "interactive"
              ? c.interactive
              : c.unknown}
        </dd>
        {current?.forked_from_session_id && (
          <>
            <dt>{c.fork}</dt>
            <dd>{sourceTitle(current.forked_from_session_id)}</dd>
          </>
        )}
        {current?.spawned_by_session_id && (
          <>
            <dt>{c.spawned}</dt>
            <dd>{sourceTitle(current.spawned_by_session_id)}</dd>
          </>
        )}
        <dt>{t.workspaceId}</dt>
        <dd>{current?.workspace_id}</dd>
        <dt>{t.sessionId}</dt>
        <dd>{current?.id}</dd>
        <dt>{t.status}</dt>
        <dd>{online ? liveText : t.unknown}</dd>
      </dl>
      <p>{t.scope}</p>
    </Dialog>
  );
}
