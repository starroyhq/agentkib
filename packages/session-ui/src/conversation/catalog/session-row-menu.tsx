import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { MoreHorizontal, Pin } from "lucide-react";
import {
  ApiError,
  managedAgentOf,
  runSessionManagement,
  sessionManagementFeatures,
  type ConversationSessionSummary,
  type SessionManagementAction,
  type SessionManagementFeatures,
  type WebClient,
} from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import type { SessionPlatform } from "../../session-platform";

const pinCopy = {
  "zh-CN": {
    pin: "置顶会话",
    unpin: "取消置顶",
    pinned: "已置顶",
    failed: "无法更改会话的置顶状态。",
  },
  "zh-Hant": {
    pin: "釘選對話",
    unpin: "取消釘選",
    pinned: "已釘選",
    failed: "無法變更對話的釘選狀態。",
  },
  "en-US": {
    pin: "Pin session",
    unpin: "Unpin session",
    pinned: "Pinned",
    failed: "Couldn't change the session's pin status.",
  },
  "ja-JP": {
    pin: "セッションをピン留め",
    unpin: "ピン留めを解除",
    pinned: "ピン留め済み",
    failed: "セッションのピン留めを変更できませんでした。",
  },
};

export function hasSessionPinning(
  session: Pick<ConversationSessionSummary, "pinned" | "pinningAvailable">,
) {
  return session.pinned !== undefined || session.pinningAvailable !== undefined;
}

export function SessionPinnedMark({ locale }: { locale: InteractionLocale }) {
  return (
    <Pin
      size={12}
      className="shrink-0 text-muted-foreground"
      role="img"
      aria-label={pinCopy[locale].pinned}
    />
  );
}

export type SessionManagementRowMenuProps = {
  session: ConversationSessionSummary;
  client: WebClient;
  locale: InteractionLocale;
  canPin?: boolean;
  pinOnly?: boolean;
  copy: Record<
    | "rowMenu"
    | "rename"
    | "archive"
    | "unarchive"
    | "delete"
    | "deleteTitle"
    | "deleteConfirm"
    | "close"
    | "cancel"
    | "name",
    string
  >;
  sessionTitle: string;
  deleteDescription: string;
  components: Pick<
    SessionPlatform["components"],
    | "Button"
    | "Input"
    | "DropdownMenu"
    | "DropdownMenuTrigger"
    | "DropdownMenuContent"
    | "DropdownMenuItem"
    | "DropdownMenuSeparator"
    | "SessionDialog"
  >;
  triggerClassName: string;
  triggerSize?: "sm";
  iconSize: number;
  extraMenuItems?: (features: SessionManagementFeatures | undefined) => ReactNode;
  RenameDialog?: SessionPlatform["components"]["SessionDialog"];
  RenameFooter?: ComponentType<{ children: ReactNode }>;
  DeleteDialog?: SessionPlatform["components"]["SessionDialog"];
  errorMessage(action: SessionManagementAction, code: string): string;
  onArchiveError?(message: string): void | Promise<void>;
  onChanged?(): void;
  onDeleted?(): void;
};

/** Manage a visible row with the current host grant and revision, without selecting it. */
export function SessionManagementRowMenu({
  session,
  client,
  locale,
  canPin = false,
  pinOnly = false,
  copy,
  sessionTitle,
  deleteDescription,
  components,
  triggerClassName,
  triggerSize,
  iconSize,
  extraMenuItems,
  RenameDialog = components.SessionDialog,
  RenameFooter,
  DeleteDialog = components.SessionDialog,
  errorMessage,
  onArchiveError,
  onChanged,
  onDeleted,
}: SessionManagementRowMenuProps) {
  const {
    Button,
    Input,
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    SessionDialog,
  } = components;
  const [open, setOpen] = useState(false);
  const [features, setFeatures] = useState<SessionManagementFeatures>();
  const [dialog, setDialog] = useState<"rename" | "delete" | "notice" | "pin-notice" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const inFlight = useRef(false);
  const { id, agent, archived, title } = session;
  const showPin = hasSessionPinning(session);
  const canManage = !pinOnly && !!managedAgentOf(agent);
  const pin = pinCopy[locale];
  const pinLabel = session.pinned ? pin.unpin : pin.pin;
  const pinEnabled = canPin && session.pinningAvailable === true;
  useEffect(() => {
    if (!open || !canManage) return;
    const abort = new AbortController();
    sessionManagementFeatures(client, { id, agent }, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setFeatures(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFeatures(undefined);
      });
    return () => abort.abort();
  }, [open, canManage, client, id, agent]);
  if (!canManage && !showPin) return null;

  async function togglePin() {
    if (!pinEnabled || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await client.setSessionPinned(id, !session.pinned);
      onChanged?.();
    } catch {
      setFailure(pin.failed);
      setDialog("pin-notice");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function run(action: SessionManagementAction, fields: { name?: string } = {}) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure("");
    try {
      await runSessionManagement(client, session, action, fields);
      if (action === "delete") onDeleted?.();
      else onChanged?.();
      setDialog(null);
    } catch (error) {
      const message = errorMessage(
        action,
        error instanceof ApiError ? error.code : "session-state-unavailable",
      );
      if (action === "rename" || action === "delete") setFailure(message);
      else if (onArchiveError) await onArchiveError(message);
      else {
        setFailure(message);
        setDialog("notice");
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const close = () => setDialog(null);
  const archiveAction = archived ? "unarchive" : "archive";
  const archiveLabel = archived ? copy.unarchive : copy.archive;
  const unavailable = (action: SessionManagementAction) =>
    busy || features?.[action]?.available !== true;
  const error = failure && (
    <p role="alert" className="text-sm text-destructive-text">
      {failure}
    </p>
  );
  const cancel = (
    <Button type="button" variant="outline" onClick={close}>
      {copy.cancel}
    </Button>
  );
  const renameActions = (
    <>
      {cancel}
      <Button type="submit" disabled={busy || !name.trim()}>
        {copy.rename}
      </Button>
    </>
  );
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(value) => {
          // What the host offers can change between openings.
          if (value) setFeatures(undefined);
          setOpen(value);
        }}
      >
        <DropdownMenuTrigger
          render={<Button variant="ghost" size={triggerSize} className={triggerClassName} />}
          aria-label={copy.rowMenu}
          title={sessionTitle}
        >
          <MoreHorizontal size={iconSize} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canManage && (
            <DropdownMenuItem
              disabled={unavailable("rename")}
              onClick={() => {
                setName(title ?? "");
                setFailure("");
                setDialog("rename");
              }}
            >
              {copy.rename}
            </DropdownMenuItem>
          )}
          {showPin && (
            <DropdownMenuItem disabled={busy || !pinEnabled} onClick={() => void togglePin()}>
              {pinLabel}
            </DropdownMenuItem>
          )}
          {canManage && extraMenuItems?.(features)}
          {canManage && (features?.archive ?? features?.unarchive) && (
            <DropdownMenuItem
              disabled={unavailable(archiveAction)}
              onClick={() => void run(archiveAction)}
            >
              {archiveLabel}
            </DropdownMenuItem>
          )}
          {canManage && features?.delete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={unavailable("delete")}
                onClick={() => {
                  setFailure("");
                  setDialog("delete");
                }}
              >
                {copy.delete}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {(dialog === "notice" || dialog === "pin-notice") && (
        <SessionDialog
          title={dialog === "pin-notice" ? pinLabel : archiveLabel}
          closeLabel={copy.close}
          onClose={close}
        >
          <p role="alert" className="text-sm">
            {failure}
          </p>
        </SessionDialog>
      )}
      {dialog === "rename" && (
        <RenameDialog title={copy.rename} closeLabel={copy.close} onClose={close}>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const value = name.trim();
              if (value) void run("rename", { name: value });
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
            {error}
            {RenameFooter ? (
              <RenameFooter>{renameActions}</RenameFooter>
            ) : (
              <div className="flex justify-end gap-2">{renameActions}</div>
            )}
          </form>
        </RenameDialog>
      )}
      {dialog === "delete" && (
        <DeleteDialog
          title={copy.deleteTitle}
          description={deleteDescription}
          closeLabel={copy.close}
          onClose={close}
          footer={
            <>
              {cancel}
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void run("delete")}
              >
                {copy.deleteConfirm}
              </Button>
            </>
          }
        >
          {error}
        </DeleteDialog>
      )}
    </>
  );
}
