import { agentName } from "@agentkib/agent-identity";
import {
  PreferencesDialog,
  SessionDetailDialogs,
  SessionDetailsDialog,
} from "@agentkib/session-ui";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";

export function SessionDialogs() {
  const session = useSession();
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
