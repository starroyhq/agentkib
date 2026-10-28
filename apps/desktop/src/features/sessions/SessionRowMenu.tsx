import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  ApiError,
  managedAgentOf,
  runSessionManagement,
  sessionManagementFeatures,
  type SessionManagementAction,
  type SessionManagementFeatures,
} from "@agentkib/web-client";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { createDesktopConversationClient } from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { codexCopy, codexReason } from "./conversation/features/sessions/codex-copy";

/**
 * Rename, archive (only where the agent archives natively, as Codex does) and permanent delete
 * for a session row, without opening the session. The host decides what each session offers.
 */
export function SessionRowMenu({
  session,
  onChanged,
  onDeleted,
}: {
  session: ConversationSessionSummary;
  onChanged?: () => void;
  onDeleted?: () => void;
}) {
  const { locale, tr } = useI18n();
  const copy = codexCopy[locale];
  const dialogs = useAppDialogs();
  const [client] = useState(createDesktopConversationClient);
  const [open, setOpen] = useState(false);
  const [features, setFeatures] = useState<SessionManagementFeatures>();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
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
  const reason = (action: SessionManagementAction) => {
    const value = features?.[action]?.reason;
    if (action === "delete" && value === "codex-owner-busy") return copy.deleteOwnerBusy;
    if (
      action === "delete" &&
      (value === "claude-owner-busy" || value === "claude-background-session-running")
    )
      return copy.deleteClaudeOwnerBusy;
    return codexReason(locale, value).text;
  };
  const available = (action: SessionManagementAction) =>
    !busy && features?.[action]?.available === true;
  async function run(action: SessionManagementAction, fields: { name?: string } = {}) {
    setBusy(true);
    try {
      await runSessionManagement(client, session, action, fields);
      if (action === "delete") onDeleted?.();
      else onChanged?.();
      return true;
    } catch (error) {
      await dialogs.notify({
        description: codexReason(
          locale,
          error instanceof ApiError ? error.code : "session-state-unavailable",
        ).text,
      });
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const confirmed = await dialogs.confirm({
      title: copy.deleteTitle,
      description: isClaude ? copy.deleteClaudeDetail : copy.deleteCodexDetail,
      tone: "destructive",
      confirmLabel: copy.deleteConfirm,
      cancelLabel: copy.cancel,
    });
    if (confirmed) await run("delete");
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
              size="sm"
              className="session-row-menu size-8 shrink-0 rounded-lg p-0 text-muted-foreground opacity-0 transition-opacity group-hover/session:opacity-100 group-focus-within/session:opacity-100 hover:text-foreground data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
            />
          }
          // Named for what it does; the title (its accessible description) names the session.
          aria-label={copy.rowMenu}
          // An untitled session is named as its row shows it.
          title={displaySessionTitle(session.title ?? undefined, tr)}
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {item("rename", copy.rename, () => {
            setName(session.title ?? "");
            setRenaming(true);
          })}
          {archive &&
            item(archiveAction, session.archived ? copy.unarchive : copy.archive, () => {
              void run(archiveAction);
            })}
          {features?.delete && (
            <>
              <DropdownMenuSeparator />
              {item("delete", copy.delete, () => void remove())}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.rename}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = name.trim();
              if (!value) return;
              void run("rename", { name: value }).then((done) => {
                if (done) setRenaming(false);
              });
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
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {copy.rename}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
