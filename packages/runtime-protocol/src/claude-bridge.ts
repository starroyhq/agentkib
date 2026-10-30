/** Private local transport. These credentials never cross Renderer or Web RPC. */
export const CLAUDE_BRIDGE_PROTOCOL = 1 as const;
import { CLAUDE_BRIDGE_COMPATIBILITY } from "../../claude-bridge-plugin/hooks/compatibility.js";
export {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  missingClaudeBridgeCapabilities,
} from "../../claude-bridge-plugin/hooks/compatibility.js";
export const CLAUDE_BRIDGE_PLUGIN_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.pluginVersion;
/** Minimum supported stable CLI; actual observed versions travel in identities. */
export const CLAUDE_BRIDGE_CLI_VERSION = CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion;
export interface ClaudeBridgeNativeCapabilities {
  version: 1;
  available: string[];
}
export interface ClaudeBridgeCompatibilityStatus {
  cliVersion: string;
  status: "verified" | "unverified";
}
export interface ClaudeBridgeConnectionFailure {
  reason: string;
  cliVersion?: string;
  missingCapabilities?: string[];
}
export const CLAUDE_BRIDGE_PATHS = {
  pair: "/v1/pair",
  autoPair: "/v1/auto-pair",
  reconnect: "/v1/reconnect",
  events: "/v1/events",
  commands: "/v1/commands",
  results: "/v1/results",
} as const;

export interface ClaudeBridgeTicket {
  protocol: 1;
  socketPath: string;
  ticket: string;
}

export interface ClaudeBridgeIdentity {
  protocol: 1;
  nativeId: string;
  cwd: string;
  cliVersion: string;
  instanceId: string;
  pluginVersion: string;
  nativeCapabilities: ClaudeBridgeNativeCapabilities;
}

export interface ClaudeBridgePairRequest extends ClaudeBridgeIdentity {
  ticket: string;
}

/**
 * Per-user discovery file for automatic pairing, written by Backend with mode 0600.
 * The key rotates with every Runtime start and only pairs sessions of registered
 * workspaces whose automatic connection is enabled.
 */
export interface ClaudeBridgeDiscovery {
  protocol: 1;
  socketPath: string;
  autoKey: string;
}

export interface ClaudeBridgeAutoPairRequest extends ClaudeBridgeIdentity {
  autoKey: string;
}

export interface ClaudeBridgeConnection {
  protocol: 1;
  bindingId: string;
  token: string;
  leaseId: string;
  credentialPath: string;
}

/** Backend writes this file with mode 0600; the plugin only reads it using $.fs. */
export interface ClaudeBridgeCredential {
  protocol: 1;
  socketPath: string;
  bindingId: string;
  token: string;
  nativeId: string;
  cwd: string;
  cliVersion: string;
  pluginVersion: string;
}

export interface ClaudeBridgeReconnectRequest extends ClaudeBridgeIdentity {
  bindingId: string;
}

/** Every authenticated request also carries Authorization: Bearer <token>. */
export interface ClaudeBridgeLease {
  bindingId: string;
  leaseId: string;
  nativeId: string;
  cwd: string;
  instanceId: string;
}

export interface ClaudeBridgeCapabilities {
  read: boolean;
  /** A message that starts a turn now: the terminal is verified idle. */
  send: boolean;
  /** A message joining the running turn at its next tool call, or opening the next turn. */
  steer: boolean;
  /** A message that starts a turn of its own after the running one, in order. */
  queue: boolean;
  stop: boolean;
  approve: false;
  answer: false;
}

/** A message AgentKib sent that the terminal has not taken into a turn yet. */
export interface ClaudeBridgeOutboxItem {
  /** The command that sent it, which also withdraws it. */
  id: string;
  kind: "steer" | "queue";
  /** A bounded preview; the full text stays in the terminal. */
  text: string;
  /** `unknown` was handed over without confirmation and is never sent again. */
  status: "pending" | "dispatching" | "unknown";
  createdAt: number;
}

export interface ClaudeBridgeMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ClaudeBridgeTool {
  id: string;
  name: string;
  input: string;
  output?: string;
  status: "running" | "completed" | "failed";
}

export interface ClaudeBridgeUsage {
  tokens: number | null;
  window: number | null;
  percent: number | null;
  observedAt: number;
}

export interface ClaudeBridgeSnapshot extends ClaudeBridgeIdentity {
  revision: number;
  currentTurnId: string | null;
  status: "idle" | "running" | "waiting" | "disconnected";
  waiting: "permission" | "question" | "unknown" | null;
  messages: ClaudeBridgeMessage[];
  toolItems: ClaudeBridgeTool[];
  streamText: string;
  usage: ClaudeBridgeUsage | null;
  outbox: ClaudeBridgeOutboxItem[];
  capabilities: ClaudeBridgeCapabilities;
}

export type ClaudeBridgeEvent =
  | { type: "gap"; revision: number }
  | { type: "snapshot"; snapshot: ClaudeBridgeSnapshot }
  | { type: "turn-start"; turnId: string; revision: number }
  | { type: "text"; turnId: string; text: string; revision: number }
  | {
      type: "turn-complete";
      turnId: string;
      text: string;
      aborted: boolean;
      revision: number;
    }
  | { type: "tool-start" | "tool-complete"; tool: ClaudeBridgeTool; revision: number }
  | { type: "invalidated"; reason: string; revision: number };

export interface ClaudeBridgeSequencedEvent {
  seq: number;
  event: ClaudeBridgeEvent;
}

export interface ClaudeBridgeEventsRequest extends ClaudeBridgeLease {
  events: ClaudeBridgeSequencedEvent[];
}

export interface ClaudeBridgeEventsResponse {
  ackSeq: number;
}

export type ClaudeBridgeCommand =
  | {
      commandId: string;
      kind: "send";
      requestId: string;
      text: string;
      expectedRevision: number;
    }
  | {
      commandId: string;
      kind: "stop";
      turnId: string;
      expectedRevision: number;
    }
  | {
      commandId: string;
      kind: "steer";
      requestId: string;
      text: string;
      turnId: string;
      expectedRevision: number;
    }
  | {
      commandId: string;
      kind: "queue";
      requestId: string;
      text: string;
      expectedRevision: number;
    }
  | {
      commandId: string;
      kind: "cancel";
      /** The outbox item, which is the command ID that sent it. */
      itemId: string;
      expectedRevision: number;
    };

export interface ClaudeBridgeCommandsRequest extends ClaudeBridgeLease {
  afterCommandId: string | null;
  waitMs: number;
}

export interface ClaudeBridgeCommandsResponse {
  commands: ClaudeBridgeCommand[];
}

export interface ClaudeBridgeResultRequest extends ClaudeBridgeLease {
  commandId: string;
  status: "accepted" | "rejected" | "unknown";
  reason?: string;
  revision: number;
  turnId?: string;
}
