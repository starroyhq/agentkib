import type { ComponentProps } from "react";
import type { Approval, UserQuestionRequest } from "@agentkib/web-client";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { PreferencesDialog } from "../preferences/preferences-dialog";

type Preferences = ComponentProps<typeof PreferencesDialog>;
type Metadata = ComponentProps<typeof SessionDetailsDialog>;
type DialogSession = Metadata["session"] & {
  modal?: "preferences" | "metadata" | Approval | UserQuestionRequest;
  setModal: (modal: undefined) => void;
  t: Preferences["labels"];
  locale: Preferences["locale"];
  setLocale: Preferences["onLocaleChange"];
  theme: Preferences["theme"];
  setTheme: Preferences["onThemeChange"];
  accent: Preferences["accent"];
  setAccent: Preferences["onAccentChange"];
};

export function SessionDialogs({
  session,
  agentName,
}: {
  session: DialogSession;
  agentName: Metadata["agentName"];
}) {
  const { modal, setModal, t, locale, setLocale, theme, setTheme, accent, setAccent } = session;
  const close = () => setModal(undefined);
  if (modal === "metadata") {
    return <SessionDetailsDialog session={session} onClose={close} agentName={agentName} />;
  }
  if (modal === "preferences") {
    return (
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
    );
  }
  // Approvals and questions live in the interaction dock.
  return null;
}
