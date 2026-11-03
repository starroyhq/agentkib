import { isBusyRead } from "./conversation/features/sessions/session-read-retry";
import { codexReason } from "./conversation/features/sessions/codex-copy";
import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries } from "@tanstack/react-query";
import { api } from "@/core/api";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { homeKeys, useOptionalQueryClient } from "@/features/home/home-query";
import { sortSessions } from "./session-catalog";
import {
  isStaleCatalogRead,
  mergeCatalogSessions,
  queuedSessionRead,
  sessionListOptions,
  sessionStatusOptions,
  SESSION_CATALOG_RUNTIME_CHANGED,
  advanceSessionQueryGeneration,
  sessionQueryGeneration,
} from "./session-query";
import {
  desktopReadScope,
  subscribeDesktopReadScope,
  useDesktopReadScope,
} from "./read-state-scope";

const indexContexts = new WeakMap<
  object,
  {
    host: unknown;
    identityKey?: string;
    scanned: Map<string, number>;
  }
>();
const emptySessions: ConversationSessionSummary[] = [];

export function useSessionCatalog(
  workspaces: WorkspaceSummary[],
  enabled: boolean,
  afterRefresh?: () => Promise<unknown>,
  indexEnabled = enabled,
) {
  const { localizeMessage, locale } = useI18n();
  const client = useOptionalQueryClient();
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const scope = useDesktopReadScope();
  const host = globalThis.window?.desktopConversation ?? globalThis.window?.agentkibDesktop;
  const workspaceKey = JSON.stringify([...new Set(workspaces.map(({ id }) => id))].sort());
  const key = JSON.stringify([workspaceKey, scope.key, runtimeRevision]);
  const ids = useMemo(() => JSON.parse(workspaceKey) as string[], [workspaceKey]);
  const context = indexContexts.get(client);
  const sameHost = !context || context.host === host;
  const sameIdentity = context?.identityKey === scope.identityKey;
  const observedIds = enabled && indexEnabled && sameHost ? ids : [];
  const lists = useQueries(
    {
      queries: observedIds.map((id) => sessionListOptions(client, id)),
    },
    client,
  );
  const records = sortSessions(lists.flatMap((query) => query.data ?? []));
  const statuses = useQueries(
    { queries: observedIds.map((id) => sessionStatusOptions(client, id)) },
    client,
  );
  const controller = useRef<AbortController | undefined>(undefined);
  const operation = useRef<Promise<void> | undefined>(undefined);
  const [completed, setCompleted] = useState({ key: "", workspaces: new Set<string>() });
  useEffect(() => {
    if (!indexEnabled) {
      advanceSessionQueryGeneration(client);
      controller.current?.abort();
      void client.cancelQueries({ queryKey: homeKeys.continuationsRoot() });
      client.removeQueries({ queryKey: homeKeys.continuationsRoot() });
      indexContexts.delete(client);
      return;
    }
    const old = indexContexts.get(client);
    if (old && old.host !== host) {
      advanceSessionQueryGeneration(client);
      controller.current?.abort();
      void client.cancelQueries({ queryKey: homeKeys.continuationsRoot() });
      client.removeQueries({ queryKey: homeKeys.continuationsRoot() });
    }
    const current = {
      host,
      identityKey: desktopReadScope().identityKey,
      scanned: old && old.host === host ? old.scanned : new Map<string, number>(),
    };
    indexContexts.set(client, current);
    const scrub = (restartReads = true) => {
      if (restartReads) {
        advanceSessionQueryGeneration(client);
        controller.current?.abort();
        operation.current = undefined;
        void client.cancelQueries({ queryKey: homeKeys.continuationsRoot() });
      }
      current.identityKey = desktopReadScope().identityKey;
      for (const query of client
        .getQueryCache()
        .findAll({ queryKey: homeKeys.continuationsRoot() })) {
        const data = query.state.data;
        if (Array.isArray(data))
          query.setData(
            data.map((session: unknown) =>
              session && typeof session === "object" && "readState" in session
                ? { ...session, readState: undefined }
                : session,
            ),
            { updatedAt: query.state.dataUpdatedAt, manual: true },
          );
        query.setState({ error: null, status: data === undefined ? "pending" : "success" });
      }
    };
    if (!old) scrub(false);
    else if (old.identityKey !== current.identityKey) scrub();
    const stopScope = subscribeDesktopReadScope(scrub);
    const resetRuntime = () => {
      advanceSessionQueryGeneration(client);
      controller.current?.abort();
      operation.current = undefined;
      current.scanned.clear();
      void client.cancelQueries({ queryKey: homeKeys.continuationsRoot() });
      for (const query of client
        .getQueryCache()
        .findAll({ queryKey: homeKeys.continuationsRoot() }))
        query.reset();
      client.removeQueries({ queryKey: homeKeys.continuationsRoot() });
      setRuntimeRevision((value) => value + 1);
    };
    window.addEventListener(SESSION_CATALOG_RUNTIME_CHANGED, resetRuntime);
    return () => {
      stopScope();
      window.removeEventListener(SESSION_CATALOG_RUNTIME_CHANGED, resetRuntime);
    };
  }, [client, host, indexEnabled]);
  // Scanning updates the persistent index. Keep it a mutation, separate from
  // the read-only queries shared with search and the home page.
  const performSync = useCallback(
    async ({
      signal,
      force,
      initial,
      key,
    }: {
      signal: AbortSignal;
      force: boolean;
      initial: boolean;
      key: string;
    }) => {
      if (initial)
        await Promise.allSettled(
          ids.flatMap((id) => [
            client.fetchQuery({ ...sessionListOptions(client, id), staleTime: 0 }),
            client.fetchQuery({ ...sessionStatusOptions(client, id), staleTime: 0 }),
          ]),
        );
      signal.throwIfAborted();
      const errors: Record<string, unknown> = {};
      const completeWorkspace = (id: string) => {
        setCompleted((current) => ({
          key,
          workspaces: new Set([...(current.key === key ? current.workspaces : []), id]),
        }));
      };
      let notification: Promise<void> | undefined;
      let notifyAgain = false;
      const notify = () => {
        if (!afterRefresh || signal.aborted) return Promise.resolve();
        notifyAgain = true;
        if (notification) return notification;
        notification = (async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 40));
          while (notifyAgain && !signal.aborted) {
            notifyAgain = false;
            await afterRefresh();
          }
        })().finally(() => {
          notification = undefined;
        });
        return notification;
      };
      await Promise.all(
        ids.map(async (id) => {
          const lastScan = indexContexts.get(client)?.scanned.get(id);
          if (initial && lastScan && Date.now() - lastScan < 30_000) {
            completeWorkspace(id);
            return;
          }
          try {
            const sessions = await queuedSessionRead(
              client,
              `scan:${sessionQueryGeneration(client)}:${id}:${force}`,
              signal,
              () => {
                // Re-entering or changing account must not admit the same long
                // scan again; the explicit forced refresh remains available.
                indexContexts.get(client)?.scanned.set(id, Date.now());
                return api.refreshWorkspaceSessions(id, force);
              },
            );
            signal.throwIfAborted();
            await client.cancelQueries({ queryKey: homeKeys.continuations(id), exact: true });
            signal.throwIfAborted();
            completeWorkspace(id);
            client.setQueryData(
              homeKeys.continuations(id),
              (previous: typeof sessions | undefined) =>
                mergeCatalogSessions(previous ?? [], sessions),
            );
            indexContexts.get(client)?.scanned.set(id, Date.now());
            void notify().catch(() => {});
          } catch (error) {
            if (!signal.aborted && isStaleCatalogRead(error)) {
              try {
                await client.fetchQuery({ ...sessionListOptions(client, id), staleTime: 0 });
                signal.throwIfAborted();
                completeWorkspace(id);
                void notify().catch(() => {});
              } catch (readError) {
                if (!signal.aborted) errors[id] = readError;
              }
            } else if (!signal.aborted) errors[id] = error;
          }
          if (signal.aborted) return;
          try {
            await client.fetchQuery({ ...sessionStatusOptions(client, id), staleTime: 0 });
          } catch (error) {
            if (!signal.aborted) errors[id] = error;
          }
        }),
      );
      signal.throwIfAborted();
      await notify();
      signal.throwIfAborted();
      return errors;
    },
    [ids, client, afterRefresh],
  );
  const sync = useMutation(
    {
      networkMode: "always",
      mutationFn: ({
        request,
      }: {
        request: Promise<Record<string, unknown>>;
        signal: AbortSignal;
        key: string;
        initial: boolean;
      }) => request,
    },
    client,
  );
  const mutateAsync = sync.mutateAsync;
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    if (enabled && indexEnabled && ids.length) {
      const task = mutateAsync({
        signal: current.signal,
        key,
        initial: true,
        request: performSync({ signal: current.signal, force: false, initial: true, key }),
      }).then(
        () => {},
        () => {},
      );
      operation.current = task;
      void task.finally(() => {
        if (operation.current === task) operation.current = undefined;
      });
    }
    return () => {
      current.abort();
      operation.current = undefined;
    };
  }, [enabled, indexEnabled, ids, key, mutateAsync, performSync]);
  const errors: Record<string, string> = {};
  for (const [index, id] of observedIds.entries()) {
    const error =
      (sync.variables?.key === key && !sync.isPending ? sync.data?.[id] : undefined) ??
      (sameIdentity ? (statuses[index]?.error ?? lists[index]?.error) : undefined);
    if (error)
      errors[id] = isBusyRead(error)
        ? codexReason(locale, "session-state-unavailable").text
        : localizeMessage(error);
  }
  const refresh = useCallback((): Promise<void> => {
    if (
      !enabled ||
      !indexEnabled ||
      !ids.length ||
      !controller.current ||
      controller.current.signal.aborted
    )
      return Promise.resolve();
    if (operation.current) return operation.current;
    setCompleted({ key, workspaces: new Set() });
    const task = mutateAsync({
      signal: controller.current.signal,
      key,
      initial: false,
      request: performSync({ signal: controller.current.signal, force: true, initial: false, key }),
    }).then(
      () => {},
      () => {},
    );
    operation.current = task;
    void task.finally(() => {
      if (operation.current === task) operation.current = undefined;
    });
    return task;
  }, [enabled, indexEnabled, ids, key, mutateAsync, performSync]);
  const indexStatuses = statuses.flatMap((query) => query.data ?? []);
  const incompleteSources = indexStatuses
    .filter((status) => status.freshness !== "fresh")
    .map((status) => ({ workspaceId: status.workspace_id, agent: status.agent }));
  const [snapshot, setSnapshot] = useState(() => ({
    host,
    runtimeRevision,
    indexEnabled,
    sessions: records as ConversationSessionSummary[],
    usable: records.length > 0,
  }));
  const sameSnapshot =
    snapshot.host === host &&
    snapshot.runtimeRevision === runtimeRevision &&
    snapshot.indexEnabled &&
    indexEnabled;
  const retained = sameSnapshot
    ? snapshot.sessions.every((session) => ids.includes(session.workspace_id))
      ? snapshot.sessions
      : snapshot.sessions.filter((session) => ids.includes(session.workspace_id))
    : emptySessions;
  const pendingSources = retained
    .filter(
      (session) =>
        completed.key !== key ||
        !completed.workspaces.has(session.workspace_id) ||
        !!errors[session.workspace_id],
    )
    .map((session) => ({ workspaceId: session.workspace_id, agent: session.agent }));
  const projected =
    !enabled && sameSnapshot
      ? retained
      : indexEnabled && sameHost
        ? mergeCatalogSessions(retained, records, [...incompleteSources, ...pendingSources])
        : emptySessions;
  const safeSessions = mergeCatalogSessions(
    sameSnapshot ? snapshot.sessions : emptySessions,
    projected.map((session) =>
      (scope.ready && sameIdentity) || !session.readState
        ? session
        : { ...session, readState: undefined },
    ),
  );
  const trustedUsable =
    indexEnabled &&
    sameHost &&
    (safeSessions.length > 0 ||
      (lists.length === ids.length &&
        lists.every((query) => query.data !== undefined) &&
        statuses.length === ids.length &&
        statuses.every((query) => query.data !== undefined) &&
        Object.keys(errors).length === 0 &&
        incompleteSources.length === 0) ||
      (sameSnapshot && snapshot.usable));
  if (
    snapshot.host !== host ||
    snapshot.runtimeRevision !== runtimeRevision ||
    snapshot.indexEnabled !== indexEnabled ||
    snapshot.sessions !== safeSessions ||
    snapshot.usable !== trustedUsable
  )
    setSnapshot({
      host,
      runtimeRevision,
      indexEnabled,
      sessions: safeSessions,
      usable: trustedUsable,
    });
  const sessions = enabled && indexEnabled ? safeSessions : emptySessions;
  const usable = !enabled || !indexEnabled || !ids.length || trustedUsable;
  const ready =
    !enabled ||
    !indexEnabled ||
    !ids.length ||
    (usable &&
      sync.variables?.key === key &&
      !sync.variables.signal.aborted &&
      !sync.isPending &&
      (sync.isSuccess || sync.isError));
  return {
    sessions,
    statuses: indexStatuses,
    errors,
    errorUpdatedAt: Math.max(
      0,
      ...lists.map((query) => query.errorUpdatedAt),
      ...statuses.map((query) => query.errorUpdatedAt),
      sync.variables?.key === key && Object.keys(sync.data ?? {}).length ? sync.submittedAt : 0,
    ),
    loading: enabled && !usable && lists.some((query) => query.isPending && query.isFetching),
    refreshing: enabled && sync.variables?.key === key && sync.isPending,
    usable,
    ready,
    complete: ready && Object.keys(errors).length === 0 && incompleteSources.length === 0,
    incompleteSources,
    refresh,
  };
}
