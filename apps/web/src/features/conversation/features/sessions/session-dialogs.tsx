import { PreferencesDialog } from "../preferences/preferences-dialog";
import { SessionDetailsDialog } from "../catalog/session-details-dialog";
import { ToolDetailBody, toolStatusLabel } from "@agentkib/session-ui";
import { Dialog } from "../../components/dialog";
import { useSession } from "./session-context";
// Approvals and questions are not dialogs: they wait above the composer (`SessionInteractionDock`).
export function SessionDialogs() {
  const { modal, setModal, t, locale } = useSession();
  return (
    <>
      {" "}
      {modal === "preferences" && <PreferencesDialog />}
      {modal === "metadata" && <SessionDetailsDialog />}
      {typeof modal === "object" && "kind" in modal && (
        <Dialog closeLabel={t.close} title={t.tool} onClose={() => setModal(undefined)}>
          <h3>{modal.tool_name || t.unknownTool}</h3>
          <p>{toolStatusLabel(modal.tool_status, locale)}</p>
          {modal.timestamp && <time>{new Date(modal.timestamp).toLocaleString(locale)}</time>}
          {modal.tool ? (
            <ToolDetailBody tool={modal.tool} locale={locale} />
          ) : (
            <pre>{modal.content?.trim() ? modal.content : t.toolSummaryUnavailable}</pre>
          )}
          {modal.truncated && <p>{t.truncated}</p>}
        </Dialog>
      )}
    </>
  );
}
