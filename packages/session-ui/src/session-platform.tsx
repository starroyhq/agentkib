import type { createTranscriptPageCache } from "@agentkib/conversation-state";
import type {
  Access,
  ConversationEventPage,
  ConversationSessionSummary,
  Live,
  WebClient,
} from "@agentkib/web-client";
import type { Collapsible } from "@base-ui/react/collapsible";
import type { Dialog } from "@base-ui/react/dialog";
import type { Menu } from "@base-ui/react/menu";
import type { Select } from "@base-ui/react/select";
import type { Switch } from "@base-ui/react/switch";
import {
  createContext,
  useContext,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import type { ArtifactBrowser } from "./artifact-browser";
import type { ArtifactPanelsUI } from "./artifact-panel";
import type { InteractionLocale } from "./interaction-model";
import type { WarmSessionStreamPool } from "./warm-session-stream";

type ButtonStyle = {
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link" | "bare";
  size?: "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg" | "content";
  className?: string;
};

type SessionDialogProps = {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
  description?: ReactNode;
  panel?: boolean;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  headerAdornment?: ReactNode;
};

type ArtifactComponents = ComponentProps<typeof ArtifactBrowser>["components"];
type ArtifactPanelComponents = ArtifactPanelsUI;

type SessionPlatformComponents = Omit<ArtifactComponents, "ArtifactPanel" | "Button"> &
  Omit<ArtifactPanelComponents, "ResizableHandle"> & {
    Button: ComponentType<ComponentProps<"button"> & ButtonStyle>;
    buttonClassName(style: ButtonStyle): string;
    touchTargetClassName?: string;
    mergeClassNames(base: string, override?: string): string;
    collapsible?: {
      Collapsible: ComponentType<Collapsible.Root.Props>;
      CollapsibleTrigger: ComponentType<Collapsible.Trigger.Props>;
      CollapsibleContent: ComponentType<Collapsible.Panel.Props>;
    };
    Textarea: ComponentType<ComponentProps<"textarea">>;
    NativeSelect: ComponentType<
      Omit<ComponentProps<"select">, "size"> & { size?: "sm" | "default" }
    >;
    NativeSelectOption: ComponentType<ComponentProps<"option">>;
    NativeSelectOptGroup: ComponentType<ComponentProps<"optgroup">>;
    NativeCheckbox: ComponentType<ComponentProps<"input">>;
    SelectGroup: ComponentType<Select.Group.Props>;
    SelectLabel: ComponentType<Select.GroupLabel.Props>;
    SessionDialog: ComponentType<SessionDialogProps>;
    Dialog: ComponentType<Dialog.Root.Props>;
    DialogClose: ComponentType<Dialog.Close.Props>;
    DialogContent: ComponentType<
      Dialog.Popup.Props &
        ({ showCloseButton?: true; closeLabel: string } | { showCloseButton: false })
    >;
    DialogHeader: ComponentType<ComponentProps<"div">>;
    DialogTitle: ComponentType<Dialog.Title.Props>;
    DropdownMenu: ComponentType<Menu.Root.Props>;
    DropdownMenuTrigger: ComponentType<Menu.Trigger.Props>;
    DropdownMenuContent: ComponentType<
      Menu.Popup.Props &
        Pick<Menu.Positioner.Props, "side" | "align" | "sideOffset" | "alignOffset">
    >;
    DropdownMenuGroup: ComponentType<Menu.Group.Props>;
    DropdownMenuLabel: ComponentType<Menu.GroupLabel.Props & { inset?: boolean }>;
    DropdownMenuSeparator: ComponentType<Menu.Separator.Props>;
    DropdownMenuItem: ComponentType<
      Menu.Item.Props & { inset?: boolean; variant?: "default" | "destructive" }
    >;
    Disclosure: ComponentType<ComponentProps<"details">>;
    DisclosureSummary: ComponentType<ComponentProps<"summary">>;
    ResizableHandle: ComponentType<
      ComponentProps<ArtifactPanelComponents["ResizableHandle"]> & { withHandle?: boolean }
    >;
  };

type RetainedSessionWindow = {
  pageCache: ReturnType<typeof createTranscriptPageCache<ConversationEventPage>>;
  streamEpoch: number;
  readonly revision: number;
  getDraft(sessionId: string): string;
  setDraft(sessionId: string, text: string): void;
  getDisplayLive(sessionId: string): Live | undefined;
  publishLive(live: Live | undefined): void;
  acceptAccess(access: Access): void;
  clearPresentation(): void;
  subscribe(listener: () => void): () => void;
};

type LocalBridgeRequest =
  | { operation: "bridge-status" | "bridge-challenge" | "bridge-disconnect"; sessionId: string }
  | { operation: "bridge-plugin-retry"; sessionId: string }
  | { operation: "bridge-auto-connect"; sessionId: string; enabled: boolean }
  | { operation: "background-tasks"; enabled?: boolean }
  | { operation: "dsh-bridge-status" }
  | { operation: "dsh-auto-start"; enabled: boolean };

type DesktopSessionOperations = {
  isMacOS: boolean;
  requestBridge(request: LocalBridgeRequest): Promise<unknown>;
  readClipboardFiles?(): Promise<File[] | undefined>;
  openExternal(url: string): Promise<void>;
  components: {
    DialogDescription: ComponentType<Dialog.Description.Props>;
    Switch: ComponentType<Switch.Root.Props & { size?: "sm" | "default" }>;
    Badge: ComponentType<
      ComponentProps<"span"> & { variant?: "default" | "outline" | "secondary" | "destructive" }
    >;
  };
};

type NoticeOptions = { id?: string | number };

type SharedSessionPlatform = {
  components: SessionPlatformComponents;
  copy: {
    words(locale: InteractionLocale): Readonly<Record<string, string>>;
    unavailableReason(reason: string, locale: InteractionLocale): string;
    formatDateTime(value: string | Date, locale: InteractionLocale): string;
  };
  navigation: {
    preferences: { placement: "global-settings"; open(): boolean } | { placement: "workspace" };
  };
  historySearch: {
    entry: "window" | "workspace";
    filter: "select" | "native-select";
    agentName(agent: string): string;
    isSessionVisible(session: ConversationSessionSummary): boolean;
    openIndexSettings?(): boolean;
  };
  preview: {
    canOpen(access: Access | null | undefined): boolean;
    Panel: ComponentType<{
      client: WebClient;
      locale: InteractionLocale;
      page?: ConversationEventPage;
      live?: Live;
    }>;
  };
  controls: {
    /** A presentation input. Current device and session grants still apply. */
    commandSurface: "local-owner" | "paired-device";
    restrictedComposer: "attachments" | "attachments-and-plan";
    restrictedModelControls: "hidden" | "operation-panel";
  };
  retention: {
    useSessionRetention(client: WebClient): {
      warmStreams: WarmSessionStreamPool;
      window?: RetainedSessionWindow;
    };
  };
  notifications: {
    connectionPlacement: "window-toolbar" | "inline";
    pendingCenter: {
      compactClassName: string;
      showTriggerTitle?: boolean;
      TriggerSlot?: ComponentType<{ children: (inWindow: boolean) => ReactNode }>;
    };
    Toolbar?: ComponentType<{
      filesOpen: boolean;
      onFilesOpenChange(open: boolean): void;
      onStatusInToolbarChange(shown: boolean): void;
    }>;
    Toaster?: ComponentType<{ locale: InteractionLocale }>;
    success(message: string, options?: NoticeOptions): void;
    error(message: string, options?: NoticeOptions): void;
    dismiss(id?: string | number): void;
  };
  readScope: {
    getSnapshot(access: Access | null | undefined): {
      key: string;
      ready: boolean;
      identityKey?: string;
      indexEnabled?: boolean;
    };
    subscribe(listener: () => void): () => void;
    getImageSnapshot(access?: Access): {
      ready: boolean;
      indexEnabled?: boolean;
      identityKey?: string;
    };
    imageInvalidationSource?(): object | undefined;
    subscribeImageInvalidation?(listener: () => void): () => void;
    refreshContext(client: WebClient): object | string;
  };
};

export type SessionPlatform = SharedSessionPlatform &
  (
    | {
        kind: "desktop";
        desktop?: DesktopSessionOperations;
        openTerminal?: WebClient["devinTerminal"];
      }
    | { kind: "web"; desktop?: never; openTerminal?: never }
  );

const SessionPlatformContext = createContext<SessionPlatform | null>(null);

export function SessionPlatformProvider({
  platform,
  children,
}: {
  platform: SessionPlatform;
  children: ReactNode;
}) {
  return <SessionPlatformContext value={platform}>{children}</SessionPlatformContext>;
}

export function useSessionPlatform(): SessionPlatform {
  const platform = useContext(SessionPlatformContext);
  if (!platform) throw new Error("useSessionPlatform requires a SessionPlatformProvider");
  return platform;
}
