import { agentName } from "@agentkib/agent-identity";
import { isSessionVisible } from "@agentkib/session-catalog";
import { createWarmSessionStreamPool, type SessionPlatform } from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import { useMemo, useState, type ComponentProps } from "react";
import { cn } from "cn";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Disclosure, DisclosureSummary } from "@/components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/core/api";
import { conversationWords, formatDateTime } from "@/core/i18n";
import { useOptionalAppNavigationContext } from "@/features/app/AppNavigationContext";
import { useAppStore } from "@/stores/app-store";
import { ConversationWindowTools } from "../conversation-window-tools";
import { useDesktopConversationWindow } from "../DesktopConversationWindow";
import { desktopReadScope, subscribeDesktopReadScope } from "../read-state-scope";
import { Dialog as SessionDialog } from "./components/dialog";
import { LivePreview } from "./desktop-live-preview";

export { desktopSessionImages as sessionImages } from "./desktop-session-images";

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
  const [warmStreams] = useState(() => window?.warmStreams ?? createWarmSessionStreamPool(client));
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

export function useDesktopSessionPlatform(client: WebClient): SessionPlatform {
  const openSettings = useOptionalAppNavigationContext()?.app.openSettings;
  const hasDesktopBridge = !!globalThis.window?.agentkibDesktop;
  const isMacOS = globalThis.document?.documentElement.dataset.platform === "macos";
  return useMemo<SessionPlatform>(
    () => ({
      kind: "desktop",
      components,
      copy: { words: conversationWords, formatDateTime },
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
            openExternal: api.openExternal,
            components: desktopComponents,
          }
        : undefined,
    }),
    [client, hasDesktopBridge, isMacOS, openSettings],
  );
}
