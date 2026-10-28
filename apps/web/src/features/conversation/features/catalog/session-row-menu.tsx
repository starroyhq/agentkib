import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  ApiError,
  managedAgentOf,
  runSessionManagement,
  sessionManagementFeatures,
  type ConversationSessionSummary,
  type SessionManagementAction,
  type SessionManagementFeatures,
} from "@agentkib/web-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Dialog } from "../../components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useSession } from "../sessions/session-context";
import { codexCopyForSurface, codexReason } from "../sessions/codex-copy";

/**
 * Rename, archive (only where the agent archives natively, as Codex does) and permanent delete
 * for a session row, without opening the session. The host decides what each session offers.
 */
export function SessionRowMenu({ session }: { session: ConversationSessionSummary }) {
  const { client, locale, refresh, dropDeletedSession } = useSession();
  const copy = codexCopyForSurface(locale, "web");
  const [open, setOpen] = useState(false);
  const [features, setFeatures] = useState<SessionManagementFeatures>();
  const [dialog, setDialog] = useState<"rename" | "delete" | "notice" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    sessionManagementFeatures(client, { id: session.id, agent: session.agent }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setFeatures(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFeatures({});
      });
    return () => abort.abort();
  }, [open, client, session.id, session.agent]);
  if (!managedAgentOf(session.agent)) return null;
  const isClaude = session.agent === "claude-code";
  const reason = (action: SessionManagementAction, value = features?.[action]?.reason) => {
    if (action === "delete" && value === "codex-owner-busy") return copy.deleteOwnerBusy;
    if (
      action === "delete" &&
      (value === "claude-owner-busy" || value === "claude-background-session-running")
    )
      return copy.deleteClaudeOwnerBusy;
    return codexReason(locale, value, "web").text;
  };
  const available = (action: SessionManagementAction) =>
    !busy && features?.[action]?.available === true;
  async function run(action: SessionManagementAction, fields: { name?: string } = {}) {
    setBusy(true);
    setFailure("");
    try {
      await runSessionManagement(client, session, action, fields);
      if (action === "delete") dropDeletedSession(session.id);
      void refresh(true);
      setDialog(null);
    } catch (error) {
      setFailure(
        reason(action, error instanceof ApiError ? error.code : "session-state-unavailable"),
      );
      // Rename and delete keep their dialog open with the reason; archive has none of its own.
      if (action !== "rename" && action !== "delete") setDialog("notice");
    } finally {
      setBusy(false);
    }
  }
  const archive = features?.archive ?? features?.unarchive;
  const archiveAction: SessionManagementAction = session.archived ? "unarchive" : "archive";
  const item = (action: SessionManagementAction, label: string, select: () => void) => (
    <DropdownMenuItem
      disabled={!available(action)}
      className="grid max-w-72 justify-items-start gap-0.5"
      onClick={select}
    >
      <span>{label}</span>
      {features && !available(action) && !busy && (
        <span className="text-xs whitespace-normal text-muted-foreground">{reason(action)}</span>
      )}
    </DropdownMenuItem>
  );
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(value) => {
          // Each opening reads the host again: what a session offers changes with its state.
          if (value) setFeatures(undefined);
          setOpen(value);
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="session-row-menu size-11 shrink-0 p-0 text-muted-foreground opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
            />
          }
          // Named for what it does; the title (its accessible description) names the session.
          aria-label={copy.rowMenu}
          title={session.title ?? undefined}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {item("rename", copy.rename, () => {
            setName(session.title ?? "");
            setFailure("");
            setDialog("rename");
          })}
          {archive &&
            item(archiveAction, session.archived ? copy.unarchive : copy.archive, () => {
              void run(archiveAction);
            })}
          {features?.delete && (
            <>
              <DropdownMenuSeparator />
              {item("delete", copy.delete, () => {
                setFailure("");
                setDialog("delete");
              })}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === "notice" && (
        <Dialog
          title={session.archived ? copy.unarchive : copy.archive}
          closeLabel={copy.close}
          onClose={() => setDialog(null)}
        >
          <p role="alert" className="text-sm">
            {failure}
          </p>
        </Dialog>
      )}
      {dialog === "rename" && (
        <Dialog title={copy.rename} closeLabel={copy.close} onClose={() => setDialog(null)}>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) void run("rename", { name: name.trim() });
            }}
          >
            <label className="grid gap-1.5 text-sm">
              {copy.name}
              <Input
                value={name}
                maxLength={200}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {copy.rename}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
      {dialog === "delete" && (
        <Dialog
          title={copy.deleteTitle}
          description={isClaude ? copy.deleteClaudeDetail : copy.deleteCodexDetail}
          closeLabel={copy.close}
          onClose={() => setDialog(null)}
        >
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setDialog(null)}>
              {copy.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void run("delete")}
            >
              {copy.deleteConfirm}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
