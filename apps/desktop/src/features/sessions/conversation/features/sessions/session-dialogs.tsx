import { SessionDetailDialogs } from "@agentkib/session-ui";
import { PreferencesDialog } from "../preferences/preferences-dialog";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";

export function SessionDialogs() {
  const { modal, setModal, t, locale } = useSession();
  return (
    <SessionDetailDialogs
      modal={modal}
      labels={t}
      locale={locale}
      onClose={() => setModal(undefined)}
      preferences={<PreferencesDialog />}
      metadata={<SessionDetailsDialog />}
      Dialog={Dialog}
    />
  );
}
