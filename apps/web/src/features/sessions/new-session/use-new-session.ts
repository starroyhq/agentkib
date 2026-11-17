import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  isLegacyPreparedReceipt,
  newSessionProvider,
  type ManagedAgent,
  type ManagedOptions,
} from "@agentkib/web-client";
import type { NewSessionCreateFields } from "@agentkib/session-ui";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { codexReason } from "@/features/conversation/features/sessions/codex-copy";
import { managedErrorCopyForSurface } from "@/features/conversation/features/sessions/managed-error-copy";
import {
  forgetPending,
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
 * the desktop does. A create whose outcome is unknown is never sent again: its saved identity is
 * checked until the host says whether it ran, and nothing else is sent meanwhile.
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

  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<NewSessionFailure>();
  const [pending, setPending] = useState<PendingControl>();
  const flight = useRef(false);
  const ownRequest = useRef<string>(undefined);
  useEffect(() => {
    if (!scope) return;
    const readSaved = () => {
      // A create in flight is checked only once its own outcome turns out unknown.
      if (flight.current) return;
      try {
        setPending(readPending(scope).find((entry) => entry.kind === "create"));
      } catch {
        setPending(undefined);
      }
    };
    readSaved();
    return subscribePending(readSaved);
  }, [scope]);
  const reconciled = useRef(onReconciled);
  useEffect(() => {
    reconciled.current = onReconciled;
  });
  useEffect(() => {
    if (!scope || !pending) return;
    let cancelled = false;
    const check = async () => {
      try {
        const result = await client.receipt(pending.requestId);
        if (
          cancelled ||
          !result.found ||
          result.requestId !== pending.requestId ||
          (!isLegacyPreparedReceipt(result, pending.requestId) &&
            (result.recovery !== undefined ||
              result.operation !== "create" ||
              result.status === "unknown"))
        )
          return;
        if (result.status !== "accepted" && result.status !== "not-dispatched") return;
        forgetPending(scope, pending.requestId);
        setPending(undefined);
        if (result.status === "not-dispatched") {
          setFailure({ reason: managedErrorCopyForSurface(locale, "web").failed });
          return;
        }
        if (result.sessionId)
          reconciled.current(result.sessionId, ownRequest.current === pending.requestId);
      } catch {
        // Keep the saved identity; the command itself is never sent again.
      }
    };
    void check();
    // The host wakes receipt checks when a managed request settles, even after its HTTP timeout.
    const unsubscribe = subscribeSessionInvalidation(client, (_id, domains) => {
      if (domains.some((domain) => ["receipts", "ownership"].includes(domain))) void check();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [scope, pending, client, locale]);

  const create = useCallback(
    async (fields: NewSessionCreateFields): Promise<string | undefined> => {
      if (flight.current || pending || !access || !scope) return;
      flight.current = true;
      setBusy(true);
      setFailure(undefined);
      const requestId = crypto.randomUUID();
      const entry: PendingControl = {
        requestId,
        kind: "create",
        agent: fields.agent ?? "codex",
        workspaceId: fields.workspaceId,
      };
      ownRequest.current = requestId;
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
        return result.sessionId;
      } catch (error) {
        if (error instanceof ApiError && error.controlOutcome === "not-dispatched") {
          try {
            forgetPending(scope, requestId);
          } catch {
            // Storage that cannot be written keeps the entry; the receipt check settles it.
          }
          setFailure(failureOf(error, locale));
        } else setPending(entry);
        return undefined;
      } finally {
        flight.current = false;
        setBusy(false);
      }
    },
    [access, scope, pending, client, locale],
  );

  return {
    /** False while access is read, and on a device that cannot start sessions. */
    ready: controls,
    options,
    optionsError,
    optionsLoading: canReadOptions && !options && !optionsError,
    busy,
    failure,
    /** A create whose outcome is not known yet. */
    unknown: !!pending,
    create,
  };
}
