export const SESSION_ALREADY_MANAGED = "session-already-managed";
export const SESSION_ALREADY_MANAGED_TEXT =
  'AgentKib manages this session. Continue in AgentKib, or select "Return to terminal" there to reconnect here.';

export function connectionStatusText(reason) {
  switch (reason) {
    case SESSION_ALREADY_MANAGED:
      return SESSION_ALREADY_MANAGED_TEXT;
    case "agentkib-not-found":
      return "AgentKib is not running or could not be found. Open AgentKib on this computer and wait for automatic connection.";
    case "agentkib-unreachable":
      return "AgentKib is not responding on this computer. Open AgentKib and wait for this terminal to connect.";
    case "saved-connection-unreadable":
      return "The saved AgentKib connection for this session could not be read. Generate a new connection code in AgentKib and run it in this terminal.";
    case "workspace-not-registered":
      return "This terminal's workspace is not registered in AgentKib. Add it in AgentKib, then wait for automatic connection.";
    case "session-not-indexed":
      return "AgentKib has not indexed this Claude Code session yet. Make sure session indexing is enabled in AgentKib, then start or continue the conversation in this terminal and wait for automatic connection.";
    case "auto-connect-disabled":
      return "Automatic connection is disabled for this workspace. Enable it in AgentKib or generate a new connection code.";
    case "session-disconnected":
      return "This session was disconnected or cleared in AgentKib. Generate a new connection code in AgentKib and run it in this terminal.";
    default:
      return "AgentKib bridge is not connected. Check the terminal connection in AgentKib or generate a new connection code.";
  }
}

export function describeConnectionFailure(reason, version, minimumCliVersion) {
  switch (reason) {
    case SESSION_ALREADY_MANAGED:
      return SESSION_ALREADY_MANAGED_TEXT;
    case "invalid-ticket":
    case "invalid-bridge-challenge":
      return "The connection code is invalid or already used. Generate a new connection code in AgentKib and copy the full command.";
    case "expired-bridge-challenge":
      return "The connection code has expired. Generate a new connection code in AgentKib and run the new command.";
    case "bridge-cli-too-old":
      return `This terminal uses Claude Code ${version}; AgentKib requires Claude Code ${minimumCliVersion} or later. Update Claude Code, then reconnect.`;
    case "bridge-cli-unsupported":
      return "AgentKib could not read a supported stable Claude Code version. Continue in the terminal; a future AgentKib release may support this version.";
    case "bridge-capabilities-missing":
      return `Claude Code ${version} does not currently support connecting to AgentKib. Continue in the terminal; a future AgentKib release will adapt to it.`;
    case "bridge-version-mismatch":
    case "bridge-plugin-update-required":
      return "The terminal connection plugin needs updating. Reinstall it using step 1 in AgentKib, then generate a new connection code.";
    case "bridge-identity-mismatch":
    case "unsupported-native-identity":
    case "native-identity-changed":
      return "This terminal does not match the selected session or workspace. Open the original Claude Code session in the registered workspace and use a new connection code.";
    case "already-connected":
      return "This terminal is already connected to AgentKib. Use /agentkib-status to check the connection.";
    case "control-outcome-unconfirmed":
      return "A previous operation still needs to be checked. Open session actions in AgentKib and check its outcome before connecting again.";
    default:
      return "AgentKib could not connect. Check that AgentKib is running on this computer, then generate a new connection code and retry.";
  }
}
