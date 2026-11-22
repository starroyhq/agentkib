import { CLAUDE_BRIDGE_CLI_VERSION } from "@agentkib/runtime-protocol";
import {
  ClaudeBackgroundSetting,
  ClaudeBridgePanel,
  DshBridgePanel,
  SessionOperations,
} from "@agentkib/session-ui";
import { useEffect, useState } from "react";
import { CodexTools } from "./codex-tools";
import { desktopProjectAgentClient } from "./project-agent-adapter";
import { useSession } from "./session-context";
import { useSessionPanels } from "./session-panels";
import { SessionReceiptRecovery } from "./session-receipt-recovery";

const hostPanels = new Map<
  string,
  { Background: typeof ClaudeBackgroundSetting; Terminal?: typeof ClaudeBridgePanel }
>([
  ["claude-code", { Background: ClaudeBackgroundSetting, Terminal: ClaudeBridgePanel }],
  ["deepseek-harness", { Background: DshBridgePanel }],
]);

export function DesktopSessionOperations({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const session = useSession();
  const { current, selected, locale, access } = session;
  const panels = useSessionPanels();
  const [localTerminalOpen, setLocalTerminalOpen] = useState(false);
  const terminalOpen = panels?.terminalOpen ?? localTerminalOpen;
  const setTerminalOpen = panels?.setTerminalOpen ?? setLocalTerminalOpen;
  const { Background, Terminal } = hostPanels.get(current?.agent ?? "") ?? {};
  const canConnectTerminal =
    !!Terminal && document.documentElement.dataset.platform === "macos" && !!access?.device?.manage;
  useEffect(() => {
    setTerminalOpen(false);
  }, [selected, canConnectTerminal, setTerminalOpen]);

  return (
    <>
      <SessionOperations
        open={open}
        onOpenChange={onOpenChange}
        session={session}
        projectAgentClient={desktopProjectAgentClient}
        ExecutionControls={CodexTools}
        ReceiptRecovery={SessionReceiptRecovery}
        hostPanels={Background && <Background locale={locale} />}
      />
      {Terminal && canConnectTerminal && terminalOpen && (
        <Terminal
          session={session}
          bridgeVersion={CLAUDE_BRIDGE_CLI_VERSION}
          active
          onClose={() => setTerminalOpen(false)}
        />
      )}
    </>
  );
}
