import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { SessionContinuationStatus } from "@agentkib/session-ui";
import { Button } from "@/components/ui/button";
import { useSession } from "./conversation/features/sessions/session-context";
import { sessionDisplayState } from "./conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "./conversation/features/sessions/web-layout-copy";
import { useSessionViewStore } from "./session-view-store";
import { useSessionPanels } from "./conversation/features/sessions/session-panels";

type ToolbarSlots = { files: HTMLElement | null; status: HTMLElement | null };

/** Keep the controls in their session context while rendering in the window toolbar. */
export function ConversationWindowTools({
  filesOpen,
  onFilesOpenChange,
}: {
  filesOpen: boolean;
  onFilesOpenChange: (open: boolean) => void;
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
  if (!selected || current?.id !== selected) return null;
  const copy = webLayoutCopy[locale];
  const status = sessionDisplayState(session);
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
      {slots.status && ["codex", "claude-code"].includes(current.agent)
        ? createPortal(
            <SessionContinuationStatus
              label={status.label}
              active={status.tone === "active"}
              loading={status.loading}
              className="max-w-40 [&>span:last-child]:truncate [&>span:last-child]:whitespace-nowrap"
            />,
            slots.status,
          )
        : null}
    </>
  );
}
