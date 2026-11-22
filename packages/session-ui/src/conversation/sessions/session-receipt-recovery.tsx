import { subscribeSessionInvalidation } from "@agentkib/conversation-state";
import {
  ApiError,
  isLegacyPreparedReceipt,
  type Access,
  type ConversationSessionSummary,
  type Live,
  type SessionCapabilities,
  type WebClient,
} from "@agentkib/web-client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import { sessionCopyForSurface, sessionReason } from "./session-copy";
import { managedText } from "./managed-copy";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";
import { webLayoutCopy } from "./web-layout-copy";

export type SessionReceiptRecoveryProps = {
  session: {
    client: WebClient;
    origin: string;
    access?: Access;
    current?: Pick<ConversationSessionSummary, "id" | "agent">;
    selected: string;
    refresh(manual: boolean): Promise<void>;
    locale: InteractionLocale;
    live?: Live;
    capabilities?: SessionCapabilities;
    online: boolean;
    busy: boolean;
  };
  renderContent: (content: ReactNode) => ReactNode;
};

/**
 * Resolve saved lifecycle receipts, including requests recorded by older versions. Receipt
 * retries never dispatch the original command again. New-session creation keeps its receipt
 * owner in the new-session composer.
 */
export function SessionReceiptRecovery({ session, renderContent }: SessionReceiptRecoveryProps) {
  const {
    kind,
    components: { Button },
    copy: platformCopy,
  } = useSessionPlatform();
  const { client, origin, access, current, selected, refresh, locale, live, capabilities } =
    session;
  const copy = sessionCopyForSurface(locale, kind);
  const explain = (reason?: string) =>
    sessionReason(locale, reason, kind, platformCopy.unavailableReason);
  const mayManage = access?.status === "approved" && !!access.device?.manage;
  const maySend = access?.status === "approved" && access.device?.send === true;
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<PendingControl>();
  const [outcomeCheck, setOutcomeCheck] = useState<{
    scope: string;
    status: "checking" | "error";
    message?: string;
  }>();
  const checkFlight = useRef<string | undefined>(undefined);
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
  const checkScope = JSON.stringify([
    scope,
    selected,
    access?.bootId,
    mayManage,
    kind === "web" && maySend,
    access?.experimentalEnabled,
    access?.protocolVersion,
  ]);
  if (outcomeCheck && outcomeCheck.scope !== checkScope) setOutcomeCheck(undefined);
  const checkingOutcome = outcomeCheck?.status === "checking";
  useLayoutEffect(
    () => () => {
      checkFlight.current = undefined;
    },
    [checkScope],
  );
  useEffect(() => {
    const readSaved = () => {
      setPending(undefined);
      setUncertain(false);
      if (!scope) return;
      try {
        const entry = readPending(scope).find(
          (value) =>
            value.sessionId === selected && ["adopt", "release", "reconcile"].includes(value.kind),
        );
        setPending(entry);
        setUncertain(!!entry);
      } catch {
        setUncertain(true);
        setError(
          managedText(
            locale,
            "Cannot read the saved request identity.",
            "无法读取已保存的请求标识。",
            kind,
          ),
        );
      }
    };
    readSaved();
    return subscribePending(readSaved);
  }, [scope, selected, locale, kind]);
  useEffect(() => {
    if (!scope || !pending || checkingOutcome || !mayManage || !access?.experimentalEnabled) return;
    let cancelled = false;
    let checking = false;
    let dirty = false;
    const checkOnce = async () => {
      try {
        const result = await client.receipt(pending.requestId);
        if (
          cancelled ||
          !result.found ||
          result.requestId !== pending.requestId ||
          (!isLegacyPreparedReceipt(result, pending.requestId) &&
            (result.recovery !== undefined ||
              (pending.sessionId && result.sessionId !== pending.sessionId) ||
              result.operation !== pending.kind ||
              result.status === "unknown"))
        )
          return false;
        if (result.status !== "accepted" && result.status !== "not-dispatched") return false;
        forgetPending(scope, pending.requestId);
        setError(
          result.status === "not-dispatched"
            ? managedText(locale, "The request was not dispatched.", "该请求未发送到执行端。", kind)
            : "",
        );
        await refresh(true);
        return true;
      } catch {
        /* Keep the saved identity and never retry the command itself. */
        return false;
      }
    };
    const check = async () => {
      if (checking) {
        dirty = true;
        return;
      }
      checking = true;
      try {
        do {
          dirty = false;
          if (await checkOnce()) break;
        } while (dirty && !cancelled);
      } finally {
        checking = false;
      }
    };
    void check();
    const unsubscribe = subscribeSessionInvalidation(client, (id, domains) => {
      if (
        (!id || id === selected) &&
        domains.some((domain) => ["receipts", "ownership"].includes(domain))
      )
        void check();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    scope,
    pending,
    checkingOutcome,
    selected,
    access?.bootId,
    access?.experimentalEnabled,
    mayManage,
    client,
    refresh,
    locale,
    kind,
  ]);
  const reconcile =
    capabilities?.sessionId === selected ? capabilities.features.reconcile : undefined;
  const outcomeAgent = current?.agent === "claude-code" ? current.agent : undefined;
  const showOutcomeCheck =
    current?.id === selected &&
    live?.sessionId === selected &&
    live.executionMode === "claude-managed" &&
    live.status === "outcome-unknown" &&
    access?.experimentalEnabled &&
    access.protocolVersion === 2 &&
    (kind === "web" ? maySend : !!outcomeAgent && mayManage && reconcile?.available === true);
  // The host's /managed/reconcile grant is stricter than Web's send visibility policy.
  const canCheckOutcome =
    showOutcomeCheck &&
    !!outcomeAgent &&
    mayManage &&
    reconcile?.available === true &&
    !!scope &&
    session.online &&
    !session.busy &&
    !pending &&
    !checkingOutcome;
  const checkTitle = canCheckOutcome
    ? undefined
    : !mayManage
      ? explain("permission_denied").text
      : !outcomeAgent || reconcile?.available !== true
        ? reconcile?.reason
          ? explain(reconcile.reason).text
          : copy.unavailable
        : !session.online
          ? webLayoutCopy[locale].offline
          : pending
            ? copy.unknown
            : explain("session-busy").text;
  async function checkOutcome() {
    if (!canCheckOutcome || !outcomeAgent || !scope || !access || checkFlight.current) return;
    const requestId = crypto.randomUUID();
    const showCheckError = (message: string) =>
      setOutcomeCheck({ scope: checkScope, status: "error", message });
    const settleRejection = (reason?: string) => {
      try {
        forgetPending(scope, requestId);
      } catch {
        // Leave the request saved for the receipt reader if storage is unavailable.
      }
      if (checkFlight.current !== requestId) return;
      const explanation = explain(reason);
      showCheckError(
        explanation.technical || !reason
          ? managedText(locale, "The request was not dispatched.", "该请求未发送到执行端。", kind) +
              (explanation.technical ? ` (${explanation.technical})` : "")
          : explanation.text,
      );
    };
    try {
      rememberPending(scope, {
        requestId,
        sessionId: selected,
        kind: "reconcile",
        agent: outcomeAgent,
      });
    } catch {
      showCheckError(
        managedText(
          locale,
          "Cannot read the saved request identity.",
          "无法读取已保存的请求标识。",
          kind,
        ),
      );
      return;
    }
    checkFlight.current = requestId;
    setOutcomeCheck({ scope: checkScope, status: "checking" });
    try {
      const result = await client.managedAction("reconcile", {
        agent: outcomeAgent,
        sessionId: selected,
        bootId: access.bootId,
        requestId,
      });
      if (result.requestId !== requestId || result.sessionId !== selected) return;
      if (
        result.accepted === false &&
        result.completed === false &&
        result.controlOutcome === "not-dispatched"
      ) {
        settleRejection(result.reason);
        return;
      }
      if (result.accepted !== true) return;
      forgetPending(scope, requestId);
      if (checkFlight.current !== requestId) return;
      if (!result.reconciled)
        showCheckError(
          managedText(
            locale,
            "The previous outcome is still unknown. No command was sent again.",
            "仍无法确认上次执行结果，没有重新发送命令。",
            kind,
          ),
        );
      await refresh(true);
    } catch (error) {
      if (error instanceof ApiError && error.controlOutcome === "not-dispatched")
        settleRejection(error.code);
    } finally {
      if (checkFlight.current === requestId) {
        checkFlight.current = undefined;
        setOutcomeCheck((value) => (value?.status === "checking" ? undefined : value));
      }
    }
  }
  const showSavedReceipt =
    mayManage &&
    access?.experimentalEnabled &&
    (current?.agent === "codex" || !!outcomeAgent) &&
    uncertain;
  if (!showSavedReceipt && !showOutcomeCheck) return renderContent(null);
  return renderContent(
    <div className={kind === "desktop" ? "space-y-3" : "space-y-4"}>
      {(outcomeCheck?.message || error) && (
        <div role="alert" className="break-words text-sm text-destructive-text">
          <p>{outcomeCheck?.message || error}</p>
        </div>
      )}
      {showOutcomeCheck && (
        <Button
          variant="outline"
          className="disabled:pointer-events-auto"
          disabled={!canCheckOutcome}
          title={checkTitle}
          onClick={() => void checkOutcome()}
        >
          {managedText(locale, "Reconcile outcome", "核对执行结果", kind)}
        </Button>
      )}
      {showSavedReceipt && (
        <div
          className={
            kind === "desktop"
              ? "space-y-2 rounded-xl border border-border/70 bg-card px-4 py-3 text-sm"
              : "space-y-2 rounded border p-3 text-sm"
          }
        >
          <p>
            {managedText(
              locale,
              "The previous outcome is unconfirmed. Wait for the saved request's status before another operation.",
              "上次操作结果尚未确认。请等待系统确认已保存的请求，再执行新的操作。",
              kind,
            )}
          </p>
          <p>
            {managedText(
              locale,
              "The saved request status is checked automatically. Refreshing does not run the operation again.",
              "正在自动查询已保存请求的处理状态；刷新不会重新执行操作。",
              kind,
            )}
          </p>
        </div>
      )}
    </div>,
  );
}
