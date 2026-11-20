/** Private local transport. These credentials never cross Renderer or Web RPC. */
export const CLAUDE_BRIDGE_PROTOCOL = 1 as const;
import { CLAUDE_BRIDGE_COMPATIBILITY } from "../../claude-bridge-plugin/hooks/compatibility.js";
export {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
  claudeBridgeCompatibility,
  claudeBridgePluginCompatibility,
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
  /** A Project Agent's worker tool call (feature `lead-tools`). */
  leadCall: "/v1/lead-call",
} as const;

/**
 * What a Runtime takes beyond the 0.4.0 messages, named in its pairing and reconnect replies
 * (`features`). A plugin uses a feature only when the Runtime named it.
 * - `lead-tools`: the session may be a Project Agent (docs/agents/project-agent.md). The plugin
 *   says `leadTools: true` in its command polls when it can register tools; the poll reply then
 *   carries `lead` (its worker tools, the reports to queue and why delegation is paused), tool
 *   calls go to `leadCall`, and `turn-start` events say whether the terminal or AgentKib started
 *   the turn (`origin`; none for a turn no one typed, which counts as an automatic turn).
 * - `open-model-picker`: a plugin may advertise the terminal's built-in interactive model picker.
 * - `terminal-subagents`: a plugin may report a bounded list of observed subagents in snapshots.
 */
export const CLAUDE_BRIDGE_FEATURES = [
  "lead-tools",
  "open-model-picker",
  "terminal-subagents",
] as const;

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
  /** Absent from snapshots of plugins without the native model picker. */
  modelPicker?: boolean;
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

export interface ClaudeBridgeTerminalSubagent {
  /** Plugin-generated identity. The native task, agent and tool IDs stay in the terminal. */
  id: string;
  title: string;
  status: "starting" | "running" | "completed" | "failed" | "stopped" | "unknown";
}

export interface ClaudeBridgeSnapshot extends ClaudeBridgeIdentity {
  revision: number;
  currentTurnId: string | null;
  status: "idle" | "running" | "waiting" | "disconnected";
  waiting: "permission" | "question" | "unknown" | null;
  messages: ClaudeBridgeMessage[];
  toolItems: ClaudeBridgeTool[];
  streamText: string;
  /** Optional native getter; omitted by older plugins rather than inferred from defaults. */
  model?: string | null;
  /** The terminal's interactive model command is open. */
  modelPickerOpen?: boolean;
  compacting?: boolean;
  /** Local native clock, retained after the latest compaction so buffered snapshots keep its order. */
  compactStartedAt?: number;
  /** Feature `terminal-subagents`: present when the plugin can observe the current list. */
  terminalSubagents?: ClaudeBridgeTerminalSubagent[];
  usage: ClaudeBridgeUsage | null;
  outbox: ClaudeBridgeOutboxItem[];
  capabilities: ClaudeBridgeCapabilities;
}

export type ClaudeBridgeEvent =
  | { type: "gap"; revision: number }
  | { type: "snapshot"; snapshot: ClaudeBridgeSnapshot }
  | {
      type: "turn-start";
      turnId: string;
      revision: number;
      /** Feature `lead-tools`: who started the turn. */
      origin?: "terminal" | "agentkib";
    }
  | { type: "text"; turnId: string; text: string; revision: number }
  | {
      type: "turn-complete";
      turnId: string;
      text: string;
      aborted: boolean;
      revision: number;
      occurredAt?: number;
      startedAt?: number;
    }
  | {
      type: "tool-start" | "tool-complete";
      turnId?: string;
      tool: ClaudeBridgeTool;
      revision: number;
    }
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
      kind: "open-model-picker";
      expectedRevision: number;
    }
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
