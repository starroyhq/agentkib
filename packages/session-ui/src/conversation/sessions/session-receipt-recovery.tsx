import type { ReactNode } from "react";
import type { InteractionLocale } from "../../interaction-model";
import { SessionOutcomeAction, type SessionOutcomeControls } from "./session-outcome-action";

export type SessionReceiptRecoveryProps = {
  session: SessionOutcomeControls & {
    locale: InteractionLocale;
    busy: boolean;
  };
  renderContent: (content: ReactNode) => ReactNode;
};

/** Recovery for operations whose normal controls are in the session action panel. */
export function SessionReceiptRecovery({ session, renderContent }: SessionReceiptRecoveryProps) {
  const actions = session.selectedOutcomes
    ?.filter(
      (entry) =>
        session.canContinueOutcome?.(entry) &&
        !["send", "stop", "approve", "answer", "settings", "open-model-picker"].includes(
          entry.kind,
        ),
    )
    .map(({ kind }) => kind);
  return renderContent(
    actions?.length ? <SessionOutcomeAction session={session} actions={actions} /> : null,
  );
}
