import { managedText } from "./managed-copy";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { subscribeSessionInvalidation } from "./session-events";
import { ApiError, isLegacyPreparedReceipt } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import { codexReason } from "./codex-copy";
import { useSession } from "./session-context";
import {
  forgetPending,
  pendingScope,
  readPending,
  rememberPending,
  subscribePending,
  type PendingControl,
} from "./pending-controls";

/**
 * The outcome of this session's adopt, release or reconcile while it is unknown: the saved
 * request is checked until the host says whether it ran, and is never sent again. New sessions
 * start from the new-session composer, which checks its own creates.
 */
export function ManagedTasks({
  renderContent,
}: {
  renderContent: (content: ReactNode) => ReactNode;
}) {
  const session = useSession();
  const { client, origin, access, current, selected, refresh, locale, live, capabilities } =
    session;
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
  const checkScope = JSON.stringify([scope, selected, access?.bootId]);
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
          ),
        );
      }
    };
    readSaved();
    return subscribePending(readSaved);
  }, [scope, selected, locale]);
  useEffect(() => {
    if (
      !scope ||
      !pending ||
      checkingOutcome ||
      access?.status !== "approved" ||
      !access.device?.manage ||
      !access.experimentalEnabled
    )
      return;
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
            ? managedText(locale, "The request was not dispatched.", "该请求未发送到执行端。")
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
    access?.status,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
    client,
    refresh,
    locale,
  ]);
  const showOutcomeCheck =
    current?.agent === "claude-code" &&
    live?.sessionId === selected &&
    live.executionMode === "claude-managed" &&
    live.status === "outcome-unknown" &&
    capabilities?.sessionId === selected &&
    capabilities.features.reconcile?.available === true;
  async function checkOutcome() {
    if (!scope || !access || pending || checkFlight.current || !session.online || session.busy)
      return;
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
      const copy = codexReason(locale, reason);
      showCheckError(
        copy.technical || !reason
          ? managedText(locale, "The request was not dispatched.", "该请求未发送到执行端。") +
              (copy.technical ? ` (${copy.technical})` : "")
          : copy.text,
      );
    };
    try {
      rememberPending(scope, {
        requestId,
        sessionId: selected,
        kind: "reconcile",
        agent: "claude-code",
      });
    } catch {
      showCheckError(
        managedText(
          locale,
          "Cannot read the saved request identity.",
          "无法读取已保存的请求标识。",
        ),
      );
      return;
    }
    checkFlight.current = requestId;
    setOutcomeCheck({ scope: checkScope, status: "checking" });
    try {
      const result = await client.managedAction("reconcile", {
        agent: "claude-code",
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
  if (
    !access?.device?.manage ||
    !access.experimentalEnabled ||
    (current?.agent !== "codex" && current?.agent !== "claude-code") ||
    (!uncertain && !showOutcomeCheck)
  )
    return renderContent(null);
  return renderContent(
    <div className="space-y-4">
      {(outcomeCheck?.message || error) && (
        <div role="alert" className="break-words text-sm text-destructive-text">
          <p>{outcomeCheck?.message || error}</p>
        </div>
      )}
      {showOutcomeCheck && access.protocolVersion === 2 && (
        <Button
          variant="outline"
          className="min-h-11"
          disabled={!scope || !session.online || session.busy || !!pending || checkingOutcome}
          onClick={() => void checkOutcome()}
        >
          {managedText(locale, "Reconcile outcome", "核对执行结果")}
        </Button>
      )}
      {uncertain && (
        <div className="space-y-2 rounded border p-3 text-sm">
          <p>
            {managedText(
              locale,
              "The previous outcome is unconfirmed. Wait for the saved request's status before another operation.",
              "上次操作结果尚未确认。请等待系统确认已保存的请求，再执行新的操作。",
            )}
          </p>
          <p>
            {managedText(
              locale,
              "The saved request status is checked automatically. Refreshing does not run the operation again.",
              "正在自动查询已保存请求的处理状态；刷新不会重新执行操作。",
            )}
          </p>
        </div>
      )}
    </div>,
  );
}
