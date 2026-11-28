import { agentName } from "@agentkib/agent-identity";
import { isSessionVisible } from "@agentkib/session-catalog";
import {
  capabilityAccessBinding,
  createWarmSessionStreamPool,
  TOUCH_TARGET,
  type SessionPlatform,
} from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import { useState, type ComponentProps, type CSSProperties } from "react";
import { Toaster, toast } from "sonner";
import { Dialog as SessionDialog } from "./components/dialog";
import { Button, buttonVariants } from "@agentkib/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@agentkib/ui/dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@agentkib/ui/tabs";
import { Textarea } from "@agentkib/ui/textarea";
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

function WebButton(props: ComponentProps<typeof Button>) {
  return <Button surface="web" {...props} />;
}

function WebInput(props: ComponentProps<typeof Input>) {
  return <Input surface="web" {...props} />;
}

function WebTextarea(props: ComponentProps<typeof Textarea>) {
  return <Textarea surface="web" {...props} />;
}

function WebDialogContent(props: ComponentProps<typeof DialogContent>) {
  return <DialogContent surface="web" {...props} />;
}

function WebDialogHeader(props: ComponentProps<typeof DialogHeader>) {
  return <DialogHeader surface="web" {...props} />;
}

function WebDialogTitle(props: ComponentProps<typeof DialogTitle>) {
  return <DialogTitle surface="web" {...props} />;
}

function WebDropdownMenuContent(props: ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent surface="web" {...props} />;
}

export const webSessionPlatform: SessionPlatform = {
  kind: "web",
  components: {
    Button: WebButton,
    buttonClassName: ({ variant, size, className }) =>
      buttonVariants({ variant, size, surface: "web", className }),
    touchTargetClassName: TOUCH_TARGET,
    mergeClassNames: cn,
    Input: WebInput,
    Textarea: WebTextarea,
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
    DialogContent: WebDialogContent,
    DialogHeader: WebDialogHeader,
    DialogTitle: WebDialogTitle,
    DropdownMenu,
    DropdownMenuContent: WebDropdownMenuContent,
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
