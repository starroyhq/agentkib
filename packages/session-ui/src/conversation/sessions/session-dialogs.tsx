import type { ComponentProps } from "react";
import { SessionDetailDialogs } from "../../session-detail-dialogs";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { PreferencesDialog } from "../preferences/preferences-dialog";

type DialogProps = ComponentProps<typeof SessionDetailDialogs>;
type Preferences = ComponentProps<typeof PreferencesDialog>;
type Metadata = ComponentProps<typeof SessionDetailsDialog>;
type DialogSession = Metadata["session"] & {
  modal?: DialogProps["modal"];
  setModal: (modal: undefined) => void;
  t: DialogProps["labels"] & Preferences["labels"];
  locale: Preferences["locale"];
  setLocale: Preferences["onLocaleChange"];
  theme: Preferences["theme"];
  setTheme: Preferences["onThemeChange"];
  accent: Preferences["accent"];
  setAccent: Preferences["onAccentChange"];
};

export function SessionDialogs({
  session,
  Dialog,
  agentName,
}: {
  session: DialogSession;
  Dialog: DialogProps["Dialog"];
  agentName: Metadata["agentName"];
}) {
  const { modal, setModal, t, locale, setLocale, theme, setTheme, accent, setAccent } = session;
  const close = () => setModal(undefined);
  return (
    <SessionDetailDialogs
      modal={modal}
      labels={t}
      locale={locale}
      onClose={close}
      preferences={
        <PreferencesDialog
          labels={t}
          locale={locale}
          theme={theme}
          accent={accent}
          onLocaleChange={setLocale}
          onThemeChange={setTheme}
          onAccentChange={setAccent}
          onClose={close}
        />
      }
      metadata={<SessionDetailsDialog session={session} onClose={close} agentName={agentName} />}
      Dialog={Dialog}
    />
  );
}
