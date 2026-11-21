import { useLayoutEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { managedAgentOf } from "@agentkib/web-client";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { requestReadStateRefresh } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "./conversation/features/sessions/session-context";
import { claudeSessionBanner } from "./conversation/features/sessions/claude-session-banner";
import { sessionDisplayState } from "./conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "@agentkib/session-ui";
import { useSessionViewStore } from "./session-view-store";
import { useSessionPanels } from "./conversation/features/sessions/session-panels";

type ToolbarSlots = { files: HTMLElement | null; status: HTMLElement | null };

/** Keep the controls in their session context while rendering in the window toolbar. */
export function ConversationWindowTools({
  filesOpen,
  onFilesOpenChange,
  onStatusInToolbarChange,
}: {
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
  onStatusInToolbarChange: (shown: boolean) => void;
}) {
  const session = useSession();
  const { selected, current, access, locale } = session;
  const setTerminalOpen = useSessionPanels()?.setTerminalOpen;
  const [slots, setSlots] = useState<ToolbarSlots>({ files: null, status: null });
  const canConnectTerminal =
    !!selected &&
    current?.id === selected &&
    current.agent === "claude-code" &&
    document.documentElement.dataset.platform === "macos" &&
    access?.status === "approved" &&
    !!access.device?.manage &&
    !!setTerminalOpen;
  useLayoutEffect(() => {
    if (!selected || !canConnectTerminal || !setTerminalOpen) return;
    // The toolbar has catalog summaries only. Publish the actual view's grant,
    // and keep older view cleanup from removing a newer session's registration.
    // Opening this view's guide preserves explicit revocation during an unknown
    // outcome. The panel still applies its separate generation/revocation gates.
    const entry = { sessionId: selected, open: () => setTerminalOpen(true) };
    const view = useSessionViewStore.getState();
    view.registerTerminalEntry(entry);
    return () => view.unregisterTerminalEntry(entry);
  }, [selected, canConnectTerminal, setTerminalOpen]);
  useLayoutEffect(() => {
    const sync = () => {
      const toolbar = document.querySelector<HTMLElement>("[data-session-window-session]");
      const host = toolbar?.dataset.sessionWindowSession === selected ? toolbar : null;
      const files = host?.querySelector<HTMLElement>("[data-session-window-files-slot]") ?? null;
      const status = host?.querySelector<HTMLElement>("[data-session-window-status-slot]") ?? null;
      setSlots((previous) =>
        previous.files === files && previous.status === status ? previous : { files, status },
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-session-window-session"],
    });
    return () => observer.disconnect();
  }, [selected]);
  const status = sessionDisplayState(session);
  const banner = current?.agent === "claude-code" ? claudeSessionBanner(session) : null;
  const connectionBanner = banner?.connection ? banner : null;
  const label = (session.online && connectionBanner?.title) || status.label;
  const requestFailed = !session.online && !session.incompatible && session.error;
  const description = connectionBanner?.body ?? (requestFailed ? session.t.error : status.reason);
  const statusInToolbar = !!(
    selected &&
    current?.id === selected &&
    managedAgentOf(current.agent) &&
    slots.status &&
    label
  );
  useLayoutEffect(() => {
    onStatusInToolbarChange(statusInToolbar);
  }, [onStatusInToolbarChange, statusInToolbar]);
  if (!selected || current?.id !== selected) return null;
  const copy = webLayoutCopy[locale];
  const canReconnect =
    !session.online && !session.incompatible && (!!session.live || session.error);
  return (
    <>
      {slots.files && access?.status === "approved" && access.device?.files
        ? createPortal(
            <Button
              variant={filesOpen ? "secondary" : "outline"}
              size="icon"
              aria-label={copy.files}
              title={copy.files}
              aria-expanded={filesOpen}
              onClick={() => onFilesOpenChange(!filesOpen)}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
            </Button>,
            slots.files,
          )
        : null}
      {slots.status && statusInToolbar
        ? createPortal(
            <Popover.Root key={selected}>
              <Popover.Trigger
                render={<Button variant="ghost" size="icon" />}
                aria-label={label}
                openOnHover
              >
                <span
                  aria-hidden="true"
                  className={`size-1.5 rounded-full ${status.tone === "active" ? "bg-primary-text" : "bg-muted-foreground"} ${status.loading ? "motion-safe:animate-pulse" : ""}`}
                />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
                  <Popover.Popup
                    initialFocus={(interaction) => interaction === "keyboard"}
                    className="grid min-w-32 max-w-72 gap-2 rounded-lg border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-md outline-none"
                  >
                    <Popover.Title className="font-medium">{label}</Popover.Title>
                    {!!description && description !== label && (
                      <Popover.Description className="text-xs text-muted-foreground">
                        {description}
                      </Popover.Description>
                    )}
                    {canReconnect && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="justify-self-start"
                        onClick={() => {
                          requestReadStateRefresh("desktop-local", selected);
                          void session.refresh(true, true);
                        }}
                      >
                        {session.t.retry}
                      </Button>
                    )}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>,
            slots.status,
          )
        : null}
    </>
  );
}
