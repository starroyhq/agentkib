import type { ReactNode } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import type { PendingControl } from "./pending-controls";

export type SessionOutcomeControls = {
  selectedOutcomes?: readonly PendingControl[];
  blocksOutcome?(kind: PendingControl["kind"]): boolean;
  canContinueOutcome?(entry: PendingControl): boolean;
  continueOutcome?(requestId: string): void;
};

const copy = {
  "en-US": {
    label: "Continue",
    reason: "Previous result unconfirmed",
    checking: "Previous message result is unconfirmed (will not resend automatically). Checking…",
    unlockDetail:
      "Previous message result is unconfirmed (will not resend automatically). Check the transcript above before unlocking input.",
    unlockAction: "Verified, unlock input",
  },
  "zh-CN": {
    label: "继续",
    reason: "上次结果不明",
    checking: "上次发送结果尚未确认（不会自动重发），正在核对状态…",
    unlockDetail: "上次发送结果尚未确认（不会自动重发）。核对上方记录后可解除锁定。",
    unlockAction: "已核对，解锁输入",
  },
  "zh-Hant": {
    label: "繼續",
    reason: "上次結果不明",
    checking: "上次傳送結果尚未確認（不會自動重傳），正在核對狀態…",
    unlockDetail: "上次傳送結果尚未確認（不會自動重傳）。核對上方記錄後可解除鎖定。",
    unlockAction: "已核對，解鎖輸入",
  },
  "ja-JP": {
    label: "続ける",
    reason: "前回の結果は未確認",
    checking: "前回の送信結果が未確認です（自動再送はしません）。状態を確認しています…",
    unlockDetail:
      "前回の送信結果が未確認です（自動再送はしません）。上の履歴を確認してから入力ロックを解除してください。",
    unlockAction: "確認済み・入力を解除",
  },
} satisfies Record<
  InteractionLocale,
  {
    label: string;
    reason: string;
    checking: string;
    unlockDetail: string;
    unlockAction: string;
  }
>;

export function SessionSendOutcomeNotice({
  session,
  actions,
}: {
  session: SessionOutcomeControls & { locale: InteractionLocale; busy: boolean };
  actions: readonly PendingControl["kind"][];
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const entry = session.selectedOutcomes?.find((item) => actions.includes(item.kind));
  if (!entry) return null;
  const canUnlock = session.canContinueOutcome?.(entry) === true;
  const words = copy[session.locale];
  return (
    <div
      role="status"
      data-slot="send-outcome-notice"
      className="pointer-events-auto flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-amber-500/35 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 shadow-sm dark:bg-amber-950/90 dark:text-amber-200"
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {canUnlock ? (
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <LoaderCircle
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 motion-safe:animate-spin"
          />
        )}
        <span className="min-w-0">{canUnlock ? words.unlockDetail : words.checking}</span>
      </div>
      {canUnlock && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-amber-500/40 bg-background text-foreground hover:bg-amber-500/10"
          disabled={session.busy}
          onClick={() => session.continueOutcome?.(entry.requestId)}
        >
          {words.unlockAction}
        </Button>
      )}
    </div>
  );
}

export function SessionOutcomeAction({
  session,
  actions,
  fallback,
}: {
  session: SessionOutcomeControls & { locale: InteractionLocale; busy: boolean };
  actions: readonly PendingControl["kind"][];
  fallback?: ReactNode;
}) {
  const {
    components: { Button },
  } = useSessionPlatform();
  const entry = session.selectedOutcomes?.find(
    (entry) => actions.includes(entry.kind) && session.canContinueOutcome?.(entry),
  );
  if (!entry) return fallback ?? null;
  const words = copy[session.locale];
  return (
    <Button
      type="button"
      variant="outline"
      title={words.reason}
      disabled={session.busy}
      onClick={() => session.continueOutcome?.(entry.requestId)}
    >
      {words.label}
    </Button>
  );
}
