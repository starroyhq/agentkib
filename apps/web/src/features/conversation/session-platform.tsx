import { agentName } from "@agentkib/agent-identity";
import { isSessionVisible } from "@agentkib/session-catalog";
import {
  capabilityAccessBinding,
  createWarmSessionStreamPool,
  TOUCH_TARGET,
  type SessionPlatform,
} from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import { useState, type CSSProperties } from "react";
import { Toaster, toast } from "sonner";
import { Dialog as SessionDialog } from "./components/dialog";
import { Button, buttonVariants } from "./components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Disclosure, DisclosureSummary } from "./components/ui/disclosure";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { Input } from "./components/ui/input";
import { NativeCheckbox } from "./components/ui/native-checkbox";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "./components/ui/native-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/ui/resizable";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { Sheet, SheetClose, SheetContent, SheetTitle } from "./components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { sessionCopyForSurface } from "./session-copy";
import { LivePreview } from "./web-live-preview";
import { cn } from "./lib/utils";
import { dictionaries, type Locale } from "./i18n";
import { localizedUnavailableReasonText } from "./live-status";

export { webSessionImages as sessionImages } from "./web-session-images";

function useWebSessionRetention(client: WebClient) {
  // Keep room for requests while the selected session and catalog streams are open.
  const [retention] = useState(() => ({ warmStreams: createWarmSessionStreamPool(client, 2) }));
  return retention;
}

function WebSessionToaster({ locale }: { locale: Locale }) {
  return (
    <Toaster
      position="top-right"
      offset={{ top: "calc(var(--window-toolbar-height, 0px) + 16px)" }}
      closeButton
      duration={5000}
      style={
        {
          "--normal-bg": "var(--card)",
          "--normal-text": "var(--card-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      toastOptions={{ closeButtonAriaLabel: sessionCopyForSurface(locale, "web").close }}
    />
  );
}

export const webSessionReadScope: SessionPlatform["readScope"] = {
  getSnapshot(access) {
    const account = access?.accountLogin;
    const ready =
      access?.status === "approved" &&
      !!access.bootId &&
      !!access.device?.id &&
      (!account || account.bound);
    return {
      key: JSON.stringify([
        capabilityAccessBinding(access ?? undefined),
        access?.historySearchScope,
        account?.bound,
        account?.accountId,
        account?.deviceId,
      ]),
      ready,
      identityKey: ready ? (account ? account.accountId : "paired-computer-owner") : undefined,
    };
  },
  // Web receives access changes and index status through the session controller.
  subscribe: () => () => {},
  getImageSnapshot(access) {
    const account = access?.accountLogin;
    return {
      ready: true,
      identityKey: account?.required
        ? account.bound
          ? account.accountId
          : undefined
        : "paired-computer-owner",
    };
  },
  refreshContext: (client) => client,
};

export const webSessionPlatform: SessionPlatform = {
  kind: "web",
  components: {
    Button,
    buttonClassName: ({ variant, size, className }) => buttonVariants({ variant, size, className }),
    touchTargetClassName: TOUCH_TARGET,
    mergeClassNames: cn,
    Input,
    Textarea,
    NativeCheckbox,
    NativeSelect,
    NativeSelectOptGroup,
    NativeSelectOption,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
    SessionDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Disclosure,
    DisclosureSummary,
    Sheet,
    SheetClose,
    SheetContent,
    SheetTitle,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
  },
  copy: {
    words: (locale) => dictionaries[locale],
    unavailableReason: localizedUnavailableReasonText,
    formatDateTime: (value, locale) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      ),
  },
  navigation: { preferences: { placement: "workspace" } },
  historySearch: { entry: "workspace", filter: "native-select", agentName, isSessionVisible },
  preview: {
    canOpen: (access) =>
      access?.device?.accessMode === "full" &&
      access.device.advancedControl === true &&
      access.experimentalEnabled,
    Panel: LivePreview,
  },
  controls: {
    commandSurface: "paired-device",
    restrictedComposer: "attachments-and-plan",
    restrictedModelControls: "operation-panel",
  },
  retention: { useSessionRetention: useWebSessionRetention },
  notifications: {
    connectionPlacement: "inline",
    pendingCenter: { compactClassName: "relative size-11 p-0" },
    Toaster: WebSessionToaster,
    success: toast.success,
    error: toast.error,
    dismiss: toast.dismiss,
  },
  readScope: webSessionReadScope,
};
