import type {
  Access,
  ConversationSessionSummary,
  ConversationWorkspaceSummary,
  Live,
  WebClient,
} from "@agentkib/web-client";
import { useEffect, useState } from "react";
import type { catalogCopy } from "../../catalog-copy";
import { useDelayedBusy } from "../../delayed-busy";
import { useSessionPlatform } from "../../session-platform";

type NativeContext = {
  available: boolean;
  cwd?: string;
  projectId?: string | null;
  branchAtCreation?: string | null;
  sourceFile?: string | null;
};
type SessionDetails = {
  t: Readonly<
    Record<
      "close" | "metadata" | "agent" | "workspaceId" | "sessionId" | "status" | "unknown" | "scope",
      string
    >
  >;
  c: (typeof catalogCopy)[keyof typeof catalogCopy];
  current?: ConversationSessionSummary;
  currentWorkspace?: ConversationWorkspaceSummary;
  formatCatalogTime(value?: string | null): string;
  sourceTitle(id: string): string;
  online: boolean;
  liveText: string;
  live?: Live;
  client: WebClient;
  access?: Access | null;
};

export function SessionDetailsDialog({
  session,
  onClose,
  agentName,
}: {
  session: SessionDetails;
  onClose(): void;
  agentName(agent?: string): string;
}) {
  const {
    components: { SessionDialog },
    kind,
  } = useSessionPlatform();
  const {
    t,
    c,
    current,
    currentWorkspace,
    formatCatalogTime,
    sourceTitle,
    online,
    liveText,
    live,
    client,
    access,
  } = session;
  const currentLive = current?.id && live?.sessionId === current.id ? live : undefined;
  const [context, setContext] = useState<{ key: string; value?: NativeContext }>();
  const isCodex = current?.agent === "codex";
  const hasNativeContext = isCodex || current?.agent === "claude-code";
  const contextKey = `${access?.device?.id ?? ""}:${current?.id ?? ""}`;
  useEffect(() => {
    if (!hasNativeContext || !current?.id || access?.status !== "approved") return;
    const abort = new AbortController();
    const key = `${access.device?.id ?? ""}:${current.id}`;
    setContext({ key });
    void client
      .request<NativeContext>(
        `managed/context?sessionId=${encodeURIComponent(current.id)}`,
        undefined,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setContext({ key, value });
      })
      .catch(() => {
        if (!abort.signal.aborted) setContext({ key, value: { available: false } });
      });
    return () => abort.abort();
  }, [client, current?.id, hasNativeContext, access?.status, access?.device?.id]);
  const nativeContext =
    access?.status === "approved" && context?.key === contextKey ? context.value : undefined;
  const loadingContext = hasNativeContext && access?.status === "approved" && !nativeContext;
  const showContextSkeleton = useDelayedBusy(loadingContext);
  const nativeValue = (value?: string | null, unavailable: string = c.contextUnavailable) =>
    loadingContext ? (
      <span aria-busy className="inline-flex h-4 items-center">
        {showContextSkeleton && (
          <span
            role="status"
            aria-label={c.contextLoading}
            className="h-2.5 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none"
          />
        )}
      </span>
    ) : nativeContext ? (
      nativeContext.available ? (
        value || c.unknown
      ) : (
        unavailable
      )
    ) : (
      c.unknown
    );
  return (
    <SessionDialog
      closeLabel={t.close}
      title={t.metadata}
      onClose={onClose}
      panel={kind === "desktop"}
    >
      <dl>
        <dt>{t.agent}</dt>
        <dd>{agentName(current?.agent)}</dd>
        <dt>{c.clientVersion}</dt>
        <dd className="break-all">{currentLive?.cliVersion?.trim() || c.unknown}</dd>
        <dt>{c.model}</dt>
        <dd className="break-all">{currentLive?.model?.trim() || c.unknown}</dd>
        <dt>{c.sourceFile}</dt>
        <dd className="break-all">
          {hasNativeContext ? nativeValue(nativeContext?.sourceFile?.trim(), c.unknown) : c.unknown}
        </dd>
        <dt>{c.project}</dt>
        <dd>{currentWorkspace?.name || c.missing}</dd>
        <dt>{c.path}</dt>
        <dd>{currentWorkspace?.path || c.unknown}</dd>
        <dt>{c.updated}</dt>
        <dd>{formatCatalogTime(current?.updated_at)}</dd>
        <dt>{c.created}</dt>
        <dd>{formatCatalogTime(current?.created_at)}</dd>
        {isCodex ? (
          <>
            <dt>{c.executionDirectory}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.cwd)}</dd>
            <dt>{c.codexProjectId}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.projectId)}</dd>
            <dt>{c.branchAtCreation}</dt>
            <dd className="break-all">{nativeValue(nativeContext?.branchAtCreation)}</dd>
          </>
        ) : (
          <>
            <dt>{c.branch}</dt>
            <dd>{current?.git_branch || c.unknown}</dd>
          </>
        )}
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
      {isCodex && <p>{c.codexContextNote}</p>}
      <p>{t.scope}</p>
    </SessionDialog>
  );
}
