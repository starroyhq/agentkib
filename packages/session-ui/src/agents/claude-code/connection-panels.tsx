import type { SessionConnectionPanels } from "../session-connection-panels";
import { ClaudeBackgroundSetting } from "./claude-background-setting";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { claudeConnectionCopy } from "./connection-copy";

export const terminalBridgePanels = {
  Settings: ClaudeBackgroundSetting,
  terminal: {
    Panel: ClaudeBridgePanel,
    title: (locale) => claudeConnectionCopy[locale].title,
    supports: (platform) => !!platform.desktop?.isMacOS && !!platform.components.collapsible,
  },
} satisfies SessionConnectionPanels;
