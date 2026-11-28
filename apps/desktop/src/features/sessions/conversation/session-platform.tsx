import { agentName } from "@agentkib/agent-identity";
import { isSessionVisible } from "@agentkib/session-catalog";
import type { SessionPlatform } from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "cn";
import { toast } from "sonner";
import { Badge } from "@agentkib/ui/badge";
import { Button, buttonVariants } from "@agentkib/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@agentkib/ui/dialog";
import { Disclosure, DisclosureSummary } from "@agentkib/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@agentkib/ui/dropdown-menu";
import { Input } from "@agentkib/ui/input";
import { NativeCheckbox } from "@agentkib/ui/native-checkbox";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@agentkib/ui/native-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@agentkib/ui/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@agentkib/ui/select";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@agentkib/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@agentkib/ui/tabs";
import { Textarea } from "@agentkib/ui/textarea";
import { api } from "@/core/api";
import { conversationWords, formatDateTime } from "@/core/i18n";
import { useOptionalAppNavigationContext } from "@/features/app/AppNavigationContext";
import { useAppStore } from "@/stores/app-store";
import { ConversationWindowTools } from "../conversation-window-tools";
import {
  createDesktopWarmSessionStreamPool,
  useDesktopConversationWindow,
} from "../DesktopConversationWindow";
import { desktopReadScope, subscribeDesktopReadScope } from "../read-state-scope";
import { Dialog as SessionDialog } from "./components/dialog";
import { LivePreview } from "./desktop-live-preview";
import { localizedUnavailableReasonText } from "./live-status";

export { desktopSessionImages as sessionImages } from "./desktop-session-images";

export async function readDesktopClipboardFiles(): Promise<File[] | undefined> {
  const files = await api.readClipboardAttachmentFiles();
  return files?.map(
    ({ bytes, mime, name }) => new File([new Uint8Array(bytes)], name, { type: mime }),
  );
}

function DesktopDialogContent({
  closeLabel: _closeLabel,
  ...props
}: ComponentProps<typeof DialogContent> & { closeLabel?: string }) {
  return <DialogContent {...props} />;
}

const components: SessionPlatform["components"] = {
  Button,
  buttonClassName: ({ className, ...style }) => cn(buttonVariants(style), className),
  mergeClassNames: cn,
  collapsible: { Collapsible, CollapsibleContent, CollapsibleTrigger },
  Dialog,
  DialogClose,
  DialogContent: DesktopDialogContent,
  DialogHeader,
  DialogTitle,
  Disclosure,
  DisclosureSummary,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  NativeCheckbox,
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  SessionDialog,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
};

const desktopComponents = {
  Badge,
  DialogDescription,
  Switch,
};

function useDesktopSessionRetention(client: WebClient) {
  const conversationWindow = useDesktopConversationWindow();
  const window = conversationWindow?.client === client ? conversationWindow : undefined;
  const [warmStreams] = useState(
    () => window?.warmStreams ?? createDesktopWarmSessionStreamPool(client),
  );
  return { warmStreams, window };
}

type ReadSnapshot = ReturnType<SessionPlatform["readScope"]["getSnapshot"]>;
let readSnapshot: ReadSnapshot | undefined;
function getReadSnapshot(): ReadSnapshot {
  const scope = desktopReadScope();
  const indexEnabled = useAppStore.getState().runtime?.session_index_enabled;
  if (!readSnapshot || readSnapshot.key !== scope.key || readSnapshot.indexEnabled !== indexEnabled)
    readSnapshot = { ...scope, indexEnabled };
  return readSnapshot;
}

function subscribeReadScope(listener: () => void) {
  const stopScope = subscribeDesktopReadScope(listener);
  const stopIndex = useAppStore.subscribe((next, previous) => {
    if (next.runtime?.session_index_enabled !== previous.runtime?.session_index_enabled) listener();
  });
  return () => {
    stopScope();
    stopIndex();
  };
}

function subscribeImageInvalidation(invalidate: () => void) {
  const desktop = globalThis.window?.agentkibDesktop;
  if (!desktop) return () => {};
  const stopScope = subscribeDesktopReadScope(invalidate);
  const stopIndex = useAppStore.subscribe((next, previous) => {
    if (
      (next.runtime?.session_index_enabled === false &&
        previous.runtime?.session_index_enabled !== false) ||
      (previous.runtime && (!next.runtime || next.runtime.data_dir !== previous.runtime.data_dir))
    )
      invalidate();
  });
  let restarts: number | undefined;
  const stopRuntime = desktop.events?.onRuntimeStatus?.((status) => {
    if (status.state !== "ready" || (restarts !== undefined && restarts !== status.restartCount))
      invalidate();
    restarts = status.restartCount;
  });
  return () => {
    stopScope();
    stopIndex();
    stopRuntime?.();
  };
}

export const desktopSessionReadScope: SessionPlatform["readScope"] = {
  getSnapshot: getReadSnapshot,
  subscribe: subscribeReadScope,
  getImageSnapshot: getReadSnapshot,
  imageInvalidationSource: () => globalThis.window?.agentkibDesktop,
  subscribeImageInvalidation,
  refreshContext: () => "desktop-local",
};

function PendingCenterTriggerSlot({ children }: { children: (inWindow: boolean) => ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const findSlot = () =>
      setTarget(document.querySelector<HTMLElement>("[data-session-window-pending-slot]"));
    findSlot();
    const observer = new MutationObserver(findSlot);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return target ? createPortal(children(true), target) : children(false);
}

export function useDesktopSessionPlatform(client: WebClient): SessionPlatform {
  const openSettings = useOptionalAppNavigationContext()?.app.openSettings;
  const hasDesktopBridge = !!globalThis.window?.agentkibDesktop;
  const isMacOS = globalThis.document?.documentElement.dataset.platform === "macos";
  return useMemo<SessionPlatform>(
    () => ({
      kind: "desktop",
      components,
      copy: {
        words: conversationWords,
        formatDateTime,
        unavailableReason: localizedUnavailableReasonText,
      },
      navigation: {
        preferences: {
          placement: "global-settings",
          open: () => openSettings?.() === true,
        },
      },
      historySearch: {
        entry: "window",
        filter: "select",
        agentName,
        isSessionVisible,
        openIndexSettings: openSettings ? () => openSettings("privacy") === true : undefined,
      },
      preview: { canOpen: (access) => access?.device?.files === true, Panel: LivePreview },
      controls: {
        commandSurface: "local-owner",
        restrictedComposer: "attachments",
        restrictedModelControls: "hidden",
      },
      retention: { useSessionRetention: useDesktopSessionRetention },
      notifications: {
        connectionPlacement: "window-toolbar",
        pendingCenter: {
          compactClassName: "relative !size-9 !min-w-0 !p-0",
          showTriggerTitle: true,
          TriggerSlot: PendingCenterTriggerSlot,
        },
        Toolbar: ConversationWindowTools,
        // The application root hosts the desktop Toaster.
        success: toast.success,
        error: toast.error,
        dismiss: toast.dismiss,
      },
      readScope: desktopSessionReadScope,
      openTerminal: (request) => client.devinTerminal(request),
      desktop: hasDesktopBridge
        ? {
            isMacOS,
            requestBridge: api.claudeRequest,
            readClipboardFiles: isMacOS ? readDesktopClipboardFiles : undefined,
            openExternal: api.openExternal,
            components: desktopComponents,
          }
        : undefined,
    }),
    [client, hasDesktopBridge, isMacOS, openSettings],
  );
}
