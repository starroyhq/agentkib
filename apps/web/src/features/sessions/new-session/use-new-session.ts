import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  newSessionProvider,
  type ControlReceipt,
  type ManagedAgent,
  type ManagedOptions,
} from "@agentkib/web-client";
import type { NewSessionCreateFields } from "@agentkib/session-ui";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";
import { managedErrorCopyForSurface } from "@/features/conversation/features/sessions/managed-error-copy";
import {
  forgetPending,
  pendingCreateMatches,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "@/features/conversation/features/sessions/pending-controls";
import { subscribeSessionInvalidation } from "@/features/conversation/features/sessions/session-events";
import type { Locale } from "@/features/conversation/i18n";

/** Why nothing was created, in the words the old new-task form used, with the code as detail. */
export type NewSessionFailure = { reason: string; detail?: string };

export function failureOf(error: unknown, locale: Locale): NewSessionFailure {
  const copy = managedErrorCopyForSurface(locale, "web");
  if (!(error instanceof ApiError)) return { reason: copy.connection };
  const reason = codexReason(locale, error.code.replaceAll("_", "-"), "web");
  return { reason: reason.technical ? copy.failed : reason.text, detail: error.code };
}

// The host reads an Agent's options from its own cache; this page keeps them a few minutes.
const OPTIONS_FRESH = 5 * 60_000;
const optionsCache = new Map<string, { at: number; value: ManagedOptions }>();
const optionsListeners = new Set<() => void>();

function subscribeOptions(listener: () => void) {
  optionsListeners.add(listener);
  return () => optionsListeners.delete(listener);
}

function notifyOptions() {
  for (const listener of optionsListeners) listener();
}

/**
 * Starts sessions from this browser's new-session composer through the host's managed create, as
 * the desktop does. A create whose outcome is unknown is never sent again: the host checks its
 * saved identity before another create for the same Agent and workspace.
 */
export function useNewSession({
  agent,
  workspaceId,
  onReconciled,
}: {
  agent: ManagedAgent;
  workspaceId?: string;
  /** A create whose outcome was unknown turned out to have run. `own` is this composer's. */
  onReconciled: (sessionId: string, own: boolean) => void;
}) {
  const { client, access, origin, locale } = useSession();
  const controls = !!access?.device?.manage && !!access.experimentalEnabled;
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
  const workspaceCatalog = newSessionProvider(agent)?.create.catalogScope === "workspace";
  const catalogWorkspaceId = workspaceCatalog ? workspaceId : undefined;
  const canReadOptions = !!scope && controls && (!workspaceCatalog || !!catalogWorkspaceId);
  const cacheKey = JSON.stringify([
    origin,
    access?.bootId,
    access?.device?.id,
    access?.device?.accessMode,
    agent,
    catalogWorkspaceId,
  ]);
  const [failedOptions, setFailedOptions] = useState<{ key: string; error: unknown }>();
  const readOptions = useCallback(
    () => (canReadOptions ? optionsCache.get(cacheKey) : undefined),
    [canReadOptions, cacheKey],
  );
  // Inspect the requested scope during render so a cache hit has no loading frame.
  const options = useSyncExternalStore(subscribeOptions, readOptions)?.value;
  const optionsError =
    canReadOptions && !options && failedOptions?.key === cacheKey ? failedOptions.error : undefined;
  useEffect(() => {
    if (!canReadOptions) return;
    const cached = optionsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPTIONS_FRESH) return;
    const controller = new AbortController();
    setFailedOptions(undefined);
    client.managedOptions(agent, controller.signal, catalogWorkspaceId).then(
      (value) => {
        if (controller.signal.aborted) return;
        optionsCache.set(cacheKey, { at: Date.now(), value });
        notifyOptions();
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          if (optionsCache.delete(cacheKey)) notifyOptions();
        }
        setFailedOptions({ key: cacheKey, error });
      },
    );
    return () => controller.abort();
  }, [client, agent, canReadOptions, cacheKey, catalogWorkspaceId]);

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
  const ownRequest = useRef<{ requestId: string; visit: typeof visit }>(undefined);
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
            .receipt(pendingRequest, abort.signal)
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
            ownRequest.current?.visit === visit && ownRequest.current.requestId === pendingRequest;
          if (own) ownRequest.current = undefined;
          if (result.status === "not-dispatched") {
            setFailure({
              visit,
              value: { reason: managedErrorCopyForSurface(locale, "web").failed },
            });
          } else if (result.sessionId) {
            reconciled.current(result.sessionId, own);
          }
        } while (!settled && !abort.signal.aborted && checkAgain);
      } catch {
        // Keep the saved identity for the next receipt check.
      } finally {
        checking = false;
      }
    };
    void check();
    // The host wakes receipt checks when a managed request settles, even after its HTTP timeout.
    const unsubscribe = subscribeSessionInvalidation(client, (_id, domains) => {
      if (domains.some((domain) => ["receipts", "ownership"].includes(domain))) void check();
    });
    return () => {
      abort.abort();
      unsubscribe?.();
    };
  }, [scope, pendingRequest, client, locale, visit, workspaceId]);

  const create = useCallback(
    async (fields: NewSessionCreateFields): Promise<string | undefined> => {
      if (
        flight.current ||
        savedRequest ||
        !controls ||
        !access ||
        !scope ||
        currentVisit.current !== visit ||
        fields.workspaceId !== workspaceId ||
        (fields.agent ?? "codex") !== agent
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
      ownRequest.current = { requestId, visit };
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
        return currentVisit.current === visit ? result.sessionId : undefined;
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
    [access, agent, client, controls, locale, savedRequest, scope, visit, workspaceId],
  );

  return {
    /** False while access is read, and on a device that cannot start sessions. */
    ready: controls,
    options,
    optionsError,
    optionsLoading: canReadOptions && !options && !optionsError,
    busy,
    failure: failure?.visit === visit ? failure.value : undefined,
    /** A create whose outcome is not known yet. */
    unknown: !!pendingRequest,
    create,
  };
}
