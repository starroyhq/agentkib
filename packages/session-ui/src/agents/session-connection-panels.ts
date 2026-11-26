import type {
  Access,
  ConversationSessionSummary,
  Live,
  SessionCapabilities,
  SessionProviderDeclaration,
  WebClient,
} from "@agentkib/web-client";
import type { ComponentType } from "react";
import type { InteractionLocale } from "../interaction-model";
import type { ControlNotice } from "../session-control";
import type { SessionPlatform } from "../session-platform";
import { terminalBridgePanels } from "./claude-code/connection-panels";
import { pluginBridgePanels } from "./deepseek-harness/connection-panels";

type ConnectionKind = NonNullable<SessionProviderDeclaration["connection"]>["kind"];

type ConnectionPlatform = Pick<SessionPlatform, "desktop" | "components">;

type ConnectionSettingsProps = {
  locale: InteractionLocale;
  unavailableReason?: string;
};

export type SessionTerminalPanelProps = {
  active: boolean;
  onClose?: () => void;
  session: {
    selected: string;
    current?: Pick<ConversationSessionSummary, "id" | "agent" | "title">;
    currentTitle?: string;
    live?: Live;
    capabilities?: SessionCapabilities;
    access?: Access;
    online: boolean;
    controlReady: boolean;
    busy: boolean;
    loadingEarlier: boolean;
    locale: InteractionLocale;
    notice?: ControlNotice;
    t?: { close: string };
    client: Pick<WebClient, "claudeResumeCommand">;
    refresh(manual: boolean): Promise<void>;
    runSessionAction?(
      action: "adopt-terminal" | "handover-terminal",
      fields?: { handoffConfirmed?: true; turnId?: string },
    ): unknown;
  };
};

export type SessionConnectionPanels = {
  Settings: ComponentType<ConnectionSettingsProps>;
  terminal?: {
    Panel: ComponentType<SessionTerminalPanelProps>;
    title(locale: InteractionLocale): string;
    supports(platform: ConnectionPlatform): boolean;
  };
};

const connectionPanels: Partial<Record<ConnectionKind, SessionConnectionPanels>> = {
  "terminal-bridge": terminalBridgePanels,
  "plugin-bridge": pluginBridgePanels,
};

/** Desktop bridge availability is a platform registration, separate from session authorization. */
export function sessionConnectionPanels(
  kind: ConnectionKind | undefined,
  platform: ConnectionPlatform,
) {
  const registered = kind && platform.desktop ? connectionPanels[kind] : undefined;
  if (!registered) return undefined;
  const { Settings, terminal } = registered;
  return { Settings, terminal: terminal?.supports(platform) ? terminal : undefined };
}

const managementPermission = {
  "en-US": "This device does not have session management permission.",
  "zh-CN": "此设备没有会话管理权限。",
  "zh-Hant": "此裝置沒有會話管理權限。",
  "ja-JP": "この端末にはセッションを管理する権限がありません。",
} satisfies Record<InteractionLocale, string>;

export function connectionManagementUnavailableReason(
  access: Access | undefined,
  locale: InteractionLocale,
) {
  return access?.status === "approved" && access.device?.manage
    ? undefined
    : managementPermission[locale];
}
