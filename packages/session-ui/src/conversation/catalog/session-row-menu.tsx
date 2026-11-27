import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  Archive,
  ArchiveRestore,
  ClipboardCopy,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  ApiError,
  managedAgentOf,
  runSessionManagement,
  sessionManagementCapabilities,
  sessionManagementFeatures,
  sessionProviderDeclaration,
  type ConversationSessionSummary,
  type SessionManagementAction,
  type SessionManagementFeatures,
  type WebClient,
} from "@agentkib/web-client";
import { sessionContinuationRegistration } from "../../agents/session-continuation";
import type { InteractionLocale } from "../../interaction-model";
import type { SessionPlatform } from "../../session-platform";
import { retryBusyRead } from "../../session-read-retry";

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

const sidebarCopy = {
  "zh-CN": {
    id: "复制 AgentKib 会话 ID",
    resume: "复制恢复命令",
    workspace: "在访达中打开工作区",
    workspaceOther: "打开工作区文件夹",
    failed: "操作未能完成。",
  },
  "zh-Hant": {
    id: "複製 AgentKib 對話 ID",
    resume: "複製恢復命令",
    workspace: "在 Finder 中打開工作區",
    workspaceOther: "打開工作區資料夾",
    failed: "無法完成操作。",
  },
  "en-US": {
    id: "Copy AgentKib session ID",
    resume: "Copy resume command",
    workspace: "Open workspace in Finder",
    workspaceOther: "Open workspace folder",
    failed: "The action could not be completed.",
  },
  "ja-JP": {
    id: "AgentKib セッション ID をコピー",
    resume: "再開コマンドをコピー",
    workspace: "Finder でワークスペースを開く",
    workspaceOther: "ワークスペースフォルダーを開く",
    failed: "操作を完了できませんでした。",
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
  canManage?: boolean;
  sidebar?: {
    local?: boolean;
    isMacOS?: boolean;
    onOpenWorkspace?: () => Promise<void>;
    onOpenFork?: () => void;
  };
  copy: Record<
    | "rowMenu"
    | "rename"
    | "archive"
    | "unarchive"
    | "fork"
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
  canManage: managementAllowed = true,
  sidebar,
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
  const triggerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pointerAnchor, setPointerAnchor] = useState<{ x: number; y: number }>();
  const [features, setFeatures] = useState<SessionManagementFeatures>();
  const [resumeCommand, setResumeCommand] = useState<string>();
  const [dialog, setDialog] = useState<
    "rename" | "delete" | "notice" | "pin-notice" | "action-notice" | null
  >(null);
  const [noticeTitle, setNoticeTitle] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const inFlight = useRef(false);
  const { id, agent, archived, title } = session;
  const showPin =
    hasSessionPinning(session) || (!!sidebar && !!sessionProviderDeclaration(agent)?.pinning);
  const canManage = !pinOnly && !!managedAgentOf(agent);
  const registered = sessionManagementCapabilities(agent);
  const loadResume = sidebar?.local && sessionContinuationRegistration(agent)?.loadResumeCommand;
  const pin = pinCopy[locale];
  const rowCopy = sidebarCopy[locale];
  const pinLabel = session.pinned ? pin.unpin : pin.pin;
  const pinEnabled = canPin && session.pinningAvailable === true;
  const sidebarMenu = !!sidebar;
  useEffect(() => {
    if (!open || !canManage || !managementAllowed) return;
    const abort = new AbortController();
    retryBusyRead(
      () => sessionManagementFeatures(client, { id, agent }, abort.signal),
      abort.signal,
    )
      .then((value) => {
        if (!abort.signal.aborted) setFeatures(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFeatures(undefined);
      });
    return () => abort.abort();
  }, [open, canManage, managementAllowed, client, id, agent]);

  useEffect(() => {
    if (!open || !loadResume) return;
    const abort = new AbortController();
    loadResume(client, id, abort.signal).then(
      (result) => {
        if (!abort.signal.aborted && result.available && result.command.trim())
          setResumeCommand(result.command);
      },
      () => undefined,
    );
    return () => abort.abort();
  }, [open, loadResume, client, id]);

  useEffect(() => {
    const row = trigger.current?.closest<HTMLElement>("[data-session-menu-row]");
    if (!sidebarMenu || !row) return;
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      returnFocus.current = null;
      setPointerAnchor({ x: event.clientX, y: event.clientY });
      setOpen(true);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      event.preventDefault();
      returnFocus.current = event.target instanceof HTMLElement ? event.target : null;
      setPointerAnchor(undefined);
      setOpen(true);
    };
    row.addEventListener("contextmenu", onContextMenu);
    row.addEventListener("keydown", onKeyDown);
    return () => {
      row.removeEventListener("contextmenu", onContextMenu);
      row.removeEventListener("keydown", onKeyDown);
    };
  }, [sidebarMenu]);
  if (!canManage && !showPin && !sidebar) return null;

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

  async function run(
    action: Exclude<SessionManagementAction, "fork">,
    fields: { name?: string } = {},
  ) {
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
  const offers = (action: SessionManagementAction) => canManage && registered.includes(action);
  const unavailable = (action: SessionManagementAction) =>
    busy || !managementAllowed || features?.[action]?.available !== true;
  const shortcut = (key: string) => (
    <span aria-hidden="true" className="ms-auto ps-4 text-xs text-muted-foreground">
      {key.toUpperCase()}
    </span>
  );
  const action = async (label: string, perform: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await perform();
    } catch {
      setFailure(rowCopy.failed);
      setNoticeTitle(label);
      setDialog("action-notice");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
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
        triggerId={triggerId}
        onOpenChange={(value) => {
          if (value) {
            setPointerAnchor(undefined);
            returnFocus.current = null;
          } else {
            // What the host offers can change between openings.
            setFeatures(undefined);
            setResumeCommand(undefined);
          }
          setOpen(value);
        }}
      >
        <DropdownMenuTrigger
          id={triggerId}
          ref={trigger}
          render={<Button variant="ghost" size={triggerSize} className={triggerClassName} />}
          aria-label={copy.rowMenu}
          title={sessionTitle}
        >
          <MoreHorizontal size={iconSize} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label={copy.rowMenu}
          className="w-max min-w-48"
          anchor={
            pointerAnchor && {
              getBoundingClientRect: () => new DOMRect(pointerAnchor.x, pointerAnchor.y, 0, 0),
              contextElement: trigger.current ?? undefined,
            }
          }
          align={pointerAnchor ? "start" : "end"}
          sideOffset={pointerAnchor ? 0 : undefined}
          finalFocus={() => returnFocus.current ?? true}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.repeat ||
              event.nativeEvent.isComposing
            )
              return;
            const key = event.key.toLowerCase();
            if (!["r", "p", "a"].includes(key)) return;
            const item = event.currentTarget.querySelector<HTMLElement>(
              `[data-shortcut="${key}"]:not([aria-disabled="true"])`,
            );
            if (item) {
              event.preventDefault();
              item.click();
            }
          }}
        >
          {offers("rename") && (
            <DropdownMenuItem
              disabled={unavailable("rename")}
              data-shortcut="r"
              aria-keyshortcuts="R"
              onClick={() => {
                setName(title ?? "");
                setFailure("");
                setDialog("rename");
              }}
            >
              <Pencil aria-hidden="true" />
              {copy.rename}
              {shortcut("r")}
            </DropdownMenuItem>
          )}
          {showPin && (
            <DropdownMenuItem
              disabled={busy || !pinEnabled}
              data-shortcut="p"
              aria-keyshortcuts="P"
              onClick={() => void togglePin()}
            >
              {session.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {pinLabel}
              {shortcut("p")}
            </DropdownMenuItem>
          )}
          {canManage && extraMenuItems?.(features)}
          {sidebar && (
            <>
              {(offers("rename") || showPin || extraMenuItems) && <DropdownMenuSeparator />}
              {offers("fork") && (
                <DropdownMenuItem
                  disabled={unavailable("fork") || !sidebar.onOpenFork}
                  onClick={sidebar.onOpenFork}
                >
                  <GitBranch aria-hidden="true" />
                  {copy.fork}…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={busy || !navigator.clipboard?.writeText}
                onClick={() => void action(rowCopy.id, () => navigator.clipboard.writeText(id))}
              >
                <ClipboardCopy aria-hidden="true" />
                {rowCopy.id}
              </DropdownMenuItem>
              {loadResume && (
                <DropdownMenuItem
                  disabled={busy || !resumeCommand || !navigator.clipboard?.writeText}
                  onClick={() =>
                    resumeCommand &&
                    void action(rowCopy.resume, () => navigator.clipboard.writeText(resumeCommand))
                  }
                >
                  <Terminal aria-hidden="true" />
                  {rowCopy.resume}
                </DropdownMenuItem>
              )}
              {sidebar.onOpenWorkspace && (
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() =>
                    sidebar.onOpenWorkspace &&
                    void action(
                      sidebar.isMacOS ? rowCopy.workspace : rowCopy.workspaceOther,
                      sidebar.onOpenWorkspace,
                    )
                  }
                >
                  <FolderOpen aria-hidden="true" />
                  {sidebar.isMacOS ? rowCopy.workspace : rowCopy.workspaceOther}
                </DropdownMenuItem>
              )}
              {(offers(archiveAction) || offers("delete")) && <DropdownMenuSeparator />}
            </>
          )}
          {offers(archiveAction) && (
            <DropdownMenuItem
              disabled={unavailable(archiveAction)}
              data-shortcut="a"
              aria-keyshortcuts="A"
              onClick={() => void run(archiveAction)}
            >
              {archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {archiveLabel}
              {shortcut("a")}
            </DropdownMenuItem>
          )}
          {offers("delete") && (
            <>
              {(!sidebar || offers(archiveAction)) && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={unavailable("delete")}
                variant="destructive"
                onClick={() => {
                  setFailure("");
                  setDialog("delete");
                }}
              >
                <Trash2 aria-hidden="true" />
                {copy.delete}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {(dialog === "notice" || dialog === "pin-notice" || dialog === "action-notice") && (
        <SessionDialog
          title={
            dialog === "action-notice"
              ? noticeTitle
              : dialog === "pin-notice"
                ? pinLabel
                : archiveLabel
          }
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
