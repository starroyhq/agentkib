import { useLayoutEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { managedAgentOf, sessionProviderDeclaration } from "@agentkib/web-client";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import {
  connectionManagementUnavailableReason,
  requestReadStateRefresh,
  resolveSessionProvider,
  SessionActivityButton,
  sessionConnectionPanels,
  useSessionPlatform,
} from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "./conversation/desktop-session-context";
import { sessionConnectionBanner } from "@agentkib/session-ui";
import { sessionDisplayState } from "./conversation/desktop-session-display";
import { webLayoutCopy } from "@agentkib/session-ui";
import { useSessionViewStore } from "./session-view-store";
import { useDelayedBusy, useSessionPanels } from "@agentkib/session-ui";

type ToolbarSlots = {
  files: HTMLElement | null;
  status: HTMLElement | null;
  activity: HTMLElement | null;
};

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
  const [slots, setSlots] = useState<ToolbarSlots>({ files: null, status: null, activity: null });
  const [openStatusFor, setOpenStatusFor] = useState<string>();
  const platform = useSessionPlatform();
  const provider = resolveSessionProvider(
    current?.id === selected ? current : undefined,
    session.capabilities,
  );
  const terminal = sessionConnectionPanels(provider?.connection?.kind, platform)?.terminal;
  const terminalTitle = terminal?.title(locale);
  const terminalUnavailable = connectionManagementUnavailableReason(access, locale);
  useLayoutEffect(() => {
    if (!selected || !terminalTitle || !setTerminalOpen) return;
    // The toolbar has catalog summaries only. Publish the session view's actual grant.
    const entry = {
      sessionId: selected,
      title: terminalTitle,
      disabledReason: terminalUnavailable,
      open: () => {
        if (!terminalUnavailable) setTerminalOpen(true);
      },
    };
    const view = useSessionViewStore.getState();
    view.registerTerminalEntry(entry);
    return () => view.unregisterTerminalEntry(entry);
  }, [selected, terminalTitle, terminalUnavailable, setTerminalOpen]);
  useLayoutEffect(() => {
    const sync = () => {
      const toolbar = document.querySelector<HTMLElement>("[data-session-window-session]");
      const host = toolbar?.dataset.sessionWindowSession === selected ? toolbar : null;
      const files = host?.querySelector<HTMLElement>("[data-session-window-files-slot]") ?? null;
      const status = host?.querySelector<HTMLElement>("[data-session-window-status-slot]") ?? null;
      const activity =
        host?.querySelector<HTMLElement>("[data-session-window-activity-slot]") ?? null;
      setSlots((previous) =>
        previous.files === files && previous.status === status && previous.activity === activity
          ? previous
          : { files, status, activity },
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
  const reconnecting = session.streamReconnecting && !session.error;
  const showReconnect = useDelayedBusy(reconnecting, 2000);
  const banner = sessionConnectionBanner(session);
  const connectionBanner = banner?.connection ? banner : null;
  const label =
    reconnecting && openStatusFor !== selected && status.label !== webLayoutCopy[locale].uncertain
      ? showReconnect
        ? webLayoutCopy[locale].streamReconnecting
        : ""
      : (session.online && connectionBanner?.title) || status.label;
  const requestFailed = !session.online && !session.incompatible && session.error;
  const description = connectionBanner?.body ?? (requestFailed ? session.t.error : status.reason);
  const statusInToolbar = !!(
    selected &&
    current?.id === selected &&
    managedAgentOf(current.agent) &&
    slots.status &&
    (label || reconnecting)
  );
  useLayoutEffect(() => {
    onStatusInToolbarChange(statusInToolbar);
  }, [onStatusInToolbarChange, statusInToolbar]);
  if (!selected || current?.id !== selected) return null;
  const copy = webLayoutCopy[locale];
  const canReconnect =
    !session.online && !session.incompatible && (!!session.live || session.error);
  const dotTone =
    !session.online || !!requestFailed || status.offline
      ? "error"
      : reconnecting || status.tone === "warning"
        ? "warning"
        : "healthy";
  const dotClass =
    dotTone === "error"
      ? "bg-destructive-icon"
      : dotTone === "warning"
        ? "bg-warning"
        : "bg-[var(--green)]";
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
      {slots.status && statusInToolbar && label
        ? createPortal(
            <Popover.Root
              key={selected}
              onOpenChange={(open) => setOpenStatusFor(open ? selected : undefined)}
            >
              <Popover.Trigger
                render={<Button variant="ghost" size="icon" />}
                aria-label={label}
                openOnHover
              >
                <span
                  aria-hidden="true"
                  data-connection-tone={dotTone}
                  className={`size-2 rounded-full ${dotClass} ${reconnecting || status.loading ? "motion-safe:animate-pulse" : ""}`}
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
      {slots.activity &&
        createPortal(
          <SessionActivityButton
            sessionId={selected}
            locale={locale}
            capabilities={sessionProviderDeclaration(current.agent)?.activities}
            live={session.live}
            Button={Button}
          />,
          slots.activity,
        )}
    </>
  );
}
