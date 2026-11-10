import { managedText } from "./managed-copy";
import { useEffect, useState, type ReactNode } from "react";
import { subscribeSessionInvalidation } from "./session-events";
import { isLegacyPreparedReceipt } from "@agentkib/web-client";
import { useSession } from "./session-context";
import {
  forgetPending,
  pendingScope,
  readPending,
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
  const { client, origin, access, current, selected, refresh, locale } = session;
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<PendingControl>();
  const scope =
    access?.status === "approved" && access.device?.id
      ? pendingScope(origin, access.device.id)
      : undefined;
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
    selected,
    access?.status,
    access?.bootId,
    access?.device?.manage,
    access?.experimentalEnabled,
    client,
    refresh,
    locale,
  ]);
  if (
    !access?.device?.manage ||
    !access.experimentalEnabled ||
    (current?.agent !== "codex" && current?.agent !== "claude-code") ||
    !uncertain
  )
    return renderContent(null);
  return renderContent(
    <div className="space-y-4">
      {error && (
        <div role="alert" className="break-words text-sm text-destructive-text">
          <p>{error}</p>
        </div>
      )}
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
    </div>,
  );
}
