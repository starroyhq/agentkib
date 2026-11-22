import { CLAUDE_BRIDGE_CLI_VERSION } from "@agentkib/web-client";
import type {
  SessionConnectionPanels,
  SessionTerminalPanelProps,
} from "../session-connection-panels";
import { ClaudeBackgroundSetting } from "./claude-background-setting";
import { ClaudeBridgePanel } from "./claude-bridge-panel";
import { claudeConnectionCopy } from "./connection-copy";

function TerminalBridgeDialog(props: SessionTerminalPanelProps) {
  return <ClaudeBridgePanel {...props} bridgeVersion={CLAUDE_BRIDGE_CLI_VERSION} />;
}

export const terminalBridgePanels = {
  Settings: ClaudeBackgroundSetting,
  terminal: {
    Panel: TerminalBridgeDialog,
    title: (locale) => claudeConnectionCopy[locale].title,
    supports: (platform) => !!platform.desktop?.isMacOS && !!platform.components.collapsible,
  },
} satisfies SessionConnectionPanels;
