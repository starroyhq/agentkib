import type { ReactNode } from "react";
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
  "en-US": { label: "Continue", reason: "Previous result unconfirmed" },
  "zh-CN": { label: "继续", reason: "上次结果不明" },
  "zh-Hant": { label: "繼續", reason: "上次結果不明" },
  "ja-JP": { label: "続ける", reason: "前回の結果は未確認" },
} satisfies Record<InteractionLocale, { label: string; reason: string }>;

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
