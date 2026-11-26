import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  isLegacyPreparedReceipt,
  sessionProviderCapabilities,
  type Access,
  type ControlReceipt,
  type ManagedAgent,
  type ManagedOptions,
} from "@agentkib/web-client";
import {
  DEFAULT_NEW_SESSION_AGENT,
  isNewSessionPermissionFailure,
  newSessionCopy,
  requiredNewSessionPolicyProof,
  type NewSessionCreateFields,
  forgetPending,
  pendingCreateMatches,
  pendingScope,
  readPending,
  rememberPending,
  startSessionOutcomeRetry,
  subscribePending,
  subscribeSessionForegroundRefresh,
  type PendingControl,
} from "@agentkib/session-ui";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import type { SupportedLocale } from "@/core/types";
import { sessionReason } from "../conversation/session-copy";
import { managedErrorCopy } from "@agentkib/session-ui";

export const newSessionOptionsKey = (agent: ManagedAgent, workspaceId?: string) =>
  workspaceId ? ["new-session-options", agent, workspaceId] : ["new-session-options", agent];

type OptionsSnapshot = ManagedOptions & { accessDenied?: true };

/** Why nothing was created, in the words the old new-task form used, with the code as detail. */
export type NewSessionFailure = { reason: string; detail?: string };

export function failureOf(error: unknown, locale: SupportedLocale): NewSessionFailure {
  if (!(error instanceof ApiError)) return { reason: managedErrorCopy[locale].connection };
  const code = error.code.replaceAll("_", "-");
  const copy = newSessionCopy(locale);
  if (isNewSessionPermissionFailure(code))
    return { reason: copy.startPermissionUnconfirmed, detail: code };
  if (code === "dsh-create-model-not-applied")
    return { reason: copy.startModelUnconfirmed, detail: code };
  if (code === "dsh-create-model-selection-unsupported")
    return { reason: copy.startModelUpgrade, detail: code };
  if (code === "dsh-models-unavailable")
    return { reason: copy.startModelUnavailable, detail: code };
  if (code === "claude-startup-models-unavailable")
    return { reason: copy.claudeStartupModelsUnavailable, detail: code };
  const reason = sessionReason(locale, code);
  return {
    reason: reason.technical ? managedErrorCopy[locale].failed : reason.text,
    detail: error.code,
  };
}

/**
 * Starts sessions from the new-session composer through the same managed create as the old
 * new-task form. A create whose outcome is unknown is never sent again: the host checks its
 * saved identity before another create for the same Agent and workspace.
 */
export function useNewSession({
  agent,
  workspaceId,
  locale,
  onReconciled,
  readOptions = true,
}: {
  agent: ManagedAgent;
  workspaceId?: string;
  locale: SupportedLocale;
  /** A create whose outcome was unknown turned out to have run. `own` is this composer's. */
  onReconciled: (sessionId: string, own: boolean) => void;
  /**
   * Whether to read the Agent's options now. The menu bar waits until the person starts typing:
   * the first Codex read starts an app-server.
   */
  readOptions?: boolean;
}) {
  const [client] = useState(createDesktopConversationClient);
  const [access, setAccess] = useState<Omit<Access, "bearerToken"> | null>();
  useEffect(() => {
    let cancelled = false;
    // Without access nothing can start here; the send button stays off.
    client.access().then(
      (value) => {
        if (!cancelled) setAccess(value);
      },
      () => {
        if (!cancelled) setAccess(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  const controls =
    access?.status === "approved" && !!access.device?.manage && !!access.experimentalEnabled;
  const disabledSessionProviders = access?.disabledSessionProviders;
  const providerDisabled = !!disabledSessionProviders?.[agent];
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(client.origin, access.device.id)
      : undefined;
  // The host reads an Agent's options from its own cache: the first Codex read starts an
  // app-server once, later ones answer at once.
  const workspaceCatalog = sessionProviderCapabilities(agent)?.create.catalogScope === "workspace";
  const catalogWorkspace = workspaceCatalog ? workspaceId : undefined;
  const canReadOptions =
    controls && !providerDisabled && readOptions && (!workspaceCatalog || !!catalogWorkspace);
  const options = useQuery({
    queryKey: [
      ...newSessionOptionsKey(agent, catalogWorkspace),
      client.origin,
      access?.bootId,
      access?.device?.id,
    ],
    queryFn: async ({ signal }): Promise<OptionsSnapshot> => {
      try {
        return await (catalogWorkspace
          ? client.managedOptions(agent, signal, catalogWorkspace)
          : client.managedOptions(agent, signal));
      } catch (error) {
        // Replace a usable cache entry on explicit denial, even if a subsequent read fails.
        if (error instanceof ApiError && [401, 403].includes(error.status))
          return { available: false, reason: error.code, workspaces: [], accessDenied: true };
        throw error;
      }
    },
    enabled: canReadOptions,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // A reply can settle the saved request after the composer has changed targets.
  const visit = useMemo(
    () => ({ client, scope, agent, workspaceId, bootId: access?.bootId }),
    [client, scope, agent, workspaceId, access?.bootId],
  );
  const currentVisit = useRef<typeof visit>(undefined);
  useLayoutEffect(() => {
    currentVisit.current = visit;
    return () => {
      currentVisit.current = undefined;
    };
  }, [visit]);

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ visit: typeof visit; value: NewSessionFailure }>();
  const flight = useRef(false);
  const ownRequest = useRef<{ requestId: string; visit: typeof visit; policyId?: string }>(
    undefined,
  );
  const getPendingRequest = useCallback(() => {
    if (!scope || !workspaceId) return undefined;
    try {
      return readPending(scope).find((entry) => pendingCreateMatches(entry, agent, workspaceId))
        ?.requestId;
    } catch {
      // Admission still checks the durable store before dispatching a create.
      return undefined;
    }
  }, [scope, agent, workspaceId]);
  const savedRequest = useSyncExternalStore(subscribePending, getPendingRequest);
  const pendingRequest = busy || flight.current ? undefined : savedRequest;
  const reconciled = useRef(onReconciled);
  useLayoutEffect(() => {
    reconciled.current = onReconciled;
  }, [onReconciled]);
  useEffect(() => {
    if (!scope || !pendingRequest) return;
    const abort = new AbortController();
    let checking = false;
    let checkAgain = false;
    let settled = false;
    const check = async () => {
      if (settled || abort.signal.aborted) return;
      if (checking) {
        checkAgain = true;
        return;
      }
      checking = true;
      try {
        do {
          checkAgain = false;
          const result: ControlReceipt | undefined = await client
            .receipt(pendingRequest, AbortSignal.any([abort.signal, AbortSignal.timeout(6_000)]))
            .catch(() => undefined);
          if (
            abort.signal.aborted ||
            currentVisit.current !== visit ||
            !result?.found ||
            result.requestId !== pendingRequest
          )
            continue;
          if (
            !isLegacyPreparedReceipt(result, pendingRequest) &&
            (result.recovery !== undefined ||
              result.operation !== "create" ||
              (result.workspaceId != null && result.workspaceId !== workspaceId) ||
              (result.status === "accepted" && !result.sessionId))
          )
            continue;
          if (result.status !== "accepted" && result.status !== "not-dispatched") continue;
          forgetPending(scope, pendingRequest);
          settled = true;
          const own =
            ownRequest.current?.visit === visit && ownRequest.current.requestId === pendingRequest
              ? ownRequest.current
              : undefined;
          if (own) ownRequest.current = undefined;
          const ack = "ack" in result ? result.ack : undefined;
          const permissionUnconfirmed =
            result.status === "accepted" && own?.policyId && ack?.policyId !== own.policyId;
          if (result.status === "not-dispatched" || permissionUnconfirmed) {
            const reason = permissionUnconfirmed ? "create-permission-unconfirmed" : ack?.reason;
            setFailure({
              visit,
              value:
                reason &&
                (reason === "dsh-create-model-not-applied" || isNewSessionPermissionFailure(reason))
                  ? failureOf(new ApiError(409, reason, "not-dispatched"), locale)
                  : { reason: managedErrorCopy[locale].failed },
            });
          } else if (result.sessionId) {
            reconciled.current(result.sessionId, !!own);
          }
        } while (!settled && !abort.signal.aborted && checkAgain);
      } catch {
        // Keep the saved identity for the next receipt check.
      } finally {
        checking = false;
      }
    };
    const stopRetry = startSessionOutcomeRetry(check);
    const stopForeground = subscribeSessionForegroundRefresh(() => void check());
    // The host wakes receipt checks when a managed request settles, even after its HTTP timeout.
    const unsubscribe = window.desktopConversation?.onControlChanged(() => void check());
    return () => {
      abort.abort();
      stopRetry();
      stopForeground();
      unsubscribe?.();
    };
  }, [scope, pendingRequest, client, locale, visit, workspaceId]);

  const create = useCallback(
    async (fields: NewSessionCreateFields): Promise<string | undefined> => {
      if (
        flight.current ||
        savedRequest ||
        !controls ||
        providerDisabled ||
        !access ||
        !scope ||
        currentVisit.current !== visit ||
        fields.workspaceId !== workspaceId ||
        (fields.agent ?? DEFAULT_NEW_SESSION_AGENT) !== agent
      )
        return;
      flight.current = true;
      setBusy(true);
      setFailure(undefined);
      const requestId = crypto.randomUUID();
      const entry: PendingControl = {
        requestId,
        kind: "create",
        agent,
        workspaceId,
      };
      const policyId = requiredNewSessionPolicyProof(agent, fields.policyId);
      ownRequest.current = { requestId, visit, policyId };
      try {
        try {
          rememberPending(scope, entry);
        } catch {
          throw new ApiError(409, "pending_storage_unavailable", "not-dispatched");
        }
        const result = await client.managedAction("create", {
          ...fields,
          bootId: access.bootId,
          requestId,
        });
        forgetPending(scope, requestId);
        ownRequest.current = undefined;
        if (currentVisit.current !== visit) return;
        if (policyId && result.policyId !== policyId) {
          setFailure({
            visit,
            value: {
              reason: newSessionCopy(locale).startPermissionUnconfirmed,
              detail: "create-permission-unconfirmed",
            },
          });
          return;
        }
        return result.sessionId;
      } catch (error) {
        if (error instanceof ApiError && error.controlOutcome === "not-dispatched") {
          try {
            forgetPending(scope, requestId);
            ownRequest.current = undefined;
          } catch {
            // Storage that cannot be written keeps the entry; the receipt check settles it.
          }
          if (currentVisit.current === visit)
            setFailure({ visit, value: failureOf(error, locale) });
        }
        return undefined;
      } finally {
        flight.current = false;
        setBusy(false);
      }
    },
    [
      access,
      agent,
      client,
      controls,
      locale,
      providerDisabled,
      savedRequest,
      scope,
      visit,
      workspaceId,
    ],
  );

  return {
    ready: controls && !providerDisabled,
    disabledSessionProviders,
    providerDisabled,
    client,
    resourceAuthority: JSON.stringify([access?.bootId, access?.device?.id]),
    fullAccess: controls && access.device?.accessMode === "full",
    advancedAccess:
      controls && access.device?.accessMode === "full" && access.device.advancedControl === true,
    options,
    optionsData: controls && !providerDisabled ? options.data : undefined,
    optionsAccessDenied: options.data?.accessDenied === true,
    optionsLoading: access === undefined || (canReadOptions && options.isPending),
    busy,
    failure: failure?.visit === visit ? failure.value : undefined,
    /** A create whose outcome is not known yet. */
    unknown: !!pendingRequest,
    create,
  };
}
