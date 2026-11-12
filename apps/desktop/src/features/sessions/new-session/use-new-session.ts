import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ApiError,
  isLegacyPreparedReceipt,
  type Access,
  type ManagedAgent,
  type ManagedOptions,
} from "@agentkib/web-client";
import { newSessionCopy, type NewSessionCreateFields } from "@agentkib/session-ui";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import type { SupportedLocale } from "@/core/types";
import { codexReason } from "../conversation/features/sessions/codex-copy";
import { managedErrorCopy } from "../conversation/features/sessions/managed-error-copy";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "../conversation/features/sessions/pending-controls";

export const newSessionOptionsKey = (agent: ManagedAgent, workspaceId?: string) =>
  workspaceId ? ["new-session-options", agent, workspaceId] : ["new-session-options", agent];

/** Why nothing was created, in the words the old new-task form used, with the code as detail. */
export type NewSessionFailure = { reason: string; detail?: string };

export function failureOf(error: unknown, locale: SupportedLocale): NewSessionFailure {
  if (!(error instanceof ApiError)) return { reason: managedErrorCopy[locale].connection };
  const code = error.code.replaceAll("_", "-");
  const copy = newSessionCopy(locale);
  if (code === "dsh-create-model-not-applied")
    return { reason: copy.startModelUnconfirmed, detail: code };
  if (code === "dsh-create-model-selection-unsupported")
    return { reason: copy.startModelUpgrade, detail: code };
  if (code === "dsh-models-unavailable")
    return { reason: copy.startModelUnavailable, detail: code };
  if (code === "claude-startup-models-unavailable")
    return { reason: copy.claudeStartupModelsUnavailable, detail: code };
  const reason = codexReason(locale, code);
  return {
    reason: reason.technical ? managedErrorCopy[locale].failed : reason.text,
    detail: error.code,
  };
}

/**
 * Starts sessions from the new-session composer through the same managed create as the old
 * new-task form. A create whose outcome is unknown is never sent again: its saved identity is
 * checked until the host says whether it ran, and nothing else is sent meanwhile.
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
  const [access, setAccess] = useState<Omit<Access, "bearerToken">>();
  useEffect(() => {
    let cancelled = false;
    // Without access nothing can start here; the send button stays off.
    client.access().then(
      (value) => {
        if (!cancelled) setAccess(value);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  const controls = !!access?.device?.manage && !!access.experimentalEnabled;
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(client.origin, access.device.id)
      : undefined;
  // The host reads an Agent's options from its own cache: the first Codex read starts an
  // app-server once, later ones answer at once.
  const catalogWorkspace = agent === "codex" ? undefined : workspaceId;
  const options = useQuery({
    queryKey: newSessionOptionsKey(agent, catalogWorkspace),
    queryFn: ({ signal }): Promise<ManagedOptions> =>
      catalogWorkspace
        ? client.managedOptions(agent, signal, catalogWorkspace)
        : client.managedOptions(agent, signal),
    enabled: controls && readOptions,
    staleTime: 5 * 60_000,
    retry: false,
  });

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
          const reason = "ack" in result ? result.ack?.reason : undefined;
          setFailure(
            reason === "dsh-create-model-not-applied"
              ? { reason: newSessionCopy(locale).startModelUnconfirmed, detail: reason }
              : { reason: managedErrorCopy[locale].failed },
          );
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
    const unsubscribe = window.desktopConversation?.onControlChanged(() => void check());
    return () => {
      cancelled = true;
      unsubscribe?.();
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
          ...(fields.agent === "claude-code" && catalogWorkspace && (fields.model || fields.effort)
            ? { verifyStartupModel: true }
            : {}),
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
    [access, scope, pending, client, locale, catalogWorkspace],
  );

  return {
    /** False while access is read, and on a device that cannot start sessions. */
    ready: controls,
    options,
    busy,
    failure,
    /** A create whose outcome is not known yet. */
    unknown: !!pending,
    create,
  };
}
