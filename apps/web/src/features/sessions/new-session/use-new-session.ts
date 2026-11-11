import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  isLegacyPreparedReceipt,
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

/**
 * Starts sessions from this browser's new-session composer through the host's managed create, as
 * the desktop does. A create whose outcome is unknown is never sent again: its saved identity is
 * checked until the host says whether it ran, and nothing else is sent meanwhile.
 */
export function useNewSession({
  agent,
  onReconciled,
}: {
  agent: ManagedAgent;
  /** A create whose outcome was unknown turned out to have run. `own` is this composer's. */
  onReconciled: (sessionId: string, own: boolean) => void;
}) {
  const { client, access, origin, locale } = useSession();
  const controls = !!access?.device?.manage && !!access.experimentalEnabled;
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
  const cacheKey = `${origin}:${access?.bootId ?? ""}:${agent}`;
  const [options, setOptions] = useState<{
    key: string;
    data?: ManagedOptions;
    error?: unknown;
  }>();
  useEffect(() => {
    if (!controls) return;
    const cached = optionsCache.get(cacheKey);
    if (cached && Date.now() - cached.at < OPTIONS_FRESH) {
      setOptions({ key: cacheKey, data: cached.value });
      return;
    }
    const controller = new AbortController();
    setOptions({ key: cacheKey });
    client.managedOptions(agent, controller.signal).then(
      (value) => {
        optionsCache.set(cacheKey, { at: Date.now(), value });
        setOptions({ key: cacheKey, data: value });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setOptions({ key: cacheKey, error });
      },
    );
    return () => controller.abort();
  }, [client, agent, controls, cacheKey]);
  const current = options?.key === cacheKey ? options : undefined;

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
    options: current?.data,
    optionsError: current?.error,
    busy,
    failure,
    /** A create whose outcome is not known yet. */
    unknown: !!pending,
    create,
  };
}
