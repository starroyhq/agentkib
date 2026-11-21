import { PreferencesDialog, SessionDetailDialogs } from "@agentkib/session-ui";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";

export function SessionDialogs() {
  const { modal, setModal, t, locale, setLocale, theme, setTheme, accent, setAccent } =
    useSession();
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
      metadata={<SessionDetailsDialog />}
      Dialog={Dialog}
    />
  );
}
