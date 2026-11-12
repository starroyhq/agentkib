/** Private local transport between a DeepSeek Harness plugin and the Runtime. Never crosses Web RPC. */
import { DSH_BRIDGE_COMPATIBILITY } from "../../dsh-bridge-plugin/compatibility.js";
export {
  DSH_BRIDGE_COMPATIBILITY,
  dshBridgeCompatibility,
  dshBridgeLaunchable,
  dshBridgePluginCompatibility,
} from "../../dsh-bridge-plugin/compatibility.js";

export const DSH_BRIDGE_PROTOCOL = 1 as const;
export const DSH_BRIDGE_PLUGIN_VERSION: string = DSH_BRIDGE_COMPATIBILITY.pluginVersion;
export const DSH_BRIDGE_PATHS = {
  register: "/v1/register",
  report: "/v1/report",
  poll: "/v1/poll",
  result: "/v1/result",
} as const;

/** Written by the Runtime with mode 0600; the key rotates with every Runtime start. */
export interface DshBridgeDiscovery {
  protocol: 1;
  socketPath: string;
  key: string;
}

/**
 * What the connected plugin serves, by DSH service. Plugins of other releases connect too, so a
 * flag a plugin does not report is off, and nothing behind it is sent to that plugin.
 */
export interface DshBridgeServices {
  sessionController: boolean;
  sessionQuery: boolean;
  approvals: boolean;
  questions: boolean;
  /** Archive and unarchive. Plugins older than 0.2.0 do not report it. */
  workspaceController?: boolean;
  /** Model catalog and per-session model selection. Plugins older than 0.2.0 do not report it. */
  modelCatalog?: boolean;
  /** Read a model catalog before creating a session and apply its initial selection. */
  createModelSelection?: boolean;
  /** Images in prompts and reading a session's images. Plugins older than 0.3.0 do not report it. */
  images?: boolean;
  /** Reading and changing a session's goal. Plugins older than 0.4.0 do not report it. */
  goals?: boolean;
  /** Running DSH's slash commands. Plugins older than 0.4.0 do not report it. */
  commands?: boolean;
  /** Permission presets and a session's current one. Plugins older than 0.4.0 do not report it. */
  permissions?: boolean;
  /** A session's subagents. Plugins older than 0.4.0 do not report it. */
  subagents?: boolean;
  /** Reading a whole session for handoff and search. Plugins older than 0.5.0 do not report it. */
  documents?: boolean;
  /** DSH's Agent presets, chosen when a session starts. Plugins older than 0.5.0 do not report it. */
  agentPresets?: boolean;
}

/**
 * One of DSH's Agent presets. A preset DSH ships has no `name` or `description` of its own and
 * clients name it; `broken` is why DSH could not load one, which then cannot be chosen.
 */
export interface DshBridgeAgentPreset {
  id: string;
  name: string | null;
  description: string | null;
  isDefault: boolean;
  broken: string | null;
}

/**
 * One of DSH's slash commands. A report carries the ones every session has (`commands`) and each
 * running agent's own list (`sessionCommands`, null once the agent has gone).
 */
export interface DshBridgeCommandEntry {
  /** Lowercase, without the slash. */
  name: string;
  description: string;
  hint: string | null;
  /** DSH takes attachments with it. */
  attachments: boolean;
}

/**
 * A session's goal. A change names `id` and `revision`. `activation` says whether this DSH
 * continues the goal by itself; DSH resumes a session with its goal disarmed.
 */
export interface DshBridgeGoal {
  id: string;
  revision: number;
  objective: string;
  phase: "active" | "paused" | "blocked" | "complete";
  blockedReason: { code: string; message: string } | null;
  maxGoalRounds: number;
  roundsStarted: number;
  createdAt: number | null;
  updatedAt: number | null;
  activation: "armed" | "disarmed";
}

/** One permission preset: a sandbox mode with an approval policy. */
export interface DshBridgePermissionOption {
  value: string;
  name: string;
  description: string | null;
}

/** One direct child of a session. */
export interface DshBridgeSubagent {
  sessionId: string;
  createdAt: number | null;
  mode: "one-shot" | "external" | "continuable" | "unknown";
  label: string | null;
  status: "running" | "completed" | "stopped" | "unknown";
}

/** One row of DSH's own session list. */
export interface DshBridgeSessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: number | null;
  running: boolean;
  live: boolean;
  blank: boolean;
  parentSessionId: string | null;
  origin: "subagent" | null;
  /** In DSH's archive set. Plugins older than 0.2.0 do not report it. */
  archived?: boolean;
}

/** One model DSH can run, as `provider` and `model` for `selectModel`. */
export interface DshBridgeModel {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  efforts: { id: string; name: string }[];
  defaultEffort: string | null;
}

/** DSH's model catalog and what the session currently runs. */
export interface DshBridgeModels {
  models: DshBridgeModel[];
  default: { provider: string; model: string; reasoningEffort: string | null } | null;
  /** The session's selection when the plugin can read it; null otherwise. */
  selected: { provider: string; model: string; reasoningEffort: string | null } | null;
}

export interface DshBridgeQueueItem {
  id: string;
  placement: "queued" | "steering";
  text: string;
  /** Images in the message; DSH edits only text, so these items cannot be edited. */
  images: number;
  rpcId: string | null;
}

/** One image DSH stored for a message. `attachmentId` is `sha256:` and the digest of its bytes. */
export interface DshBridgeImage {
  attachmentId: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string | null;
}

/**
 * Prompt content. An image is an AgentKib attachment file the plugin reads and checks against
 * `sha256` before handing DSH its bytes, so large images never cross the bridge socket.
 */
export type DshBridgePromptPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      path: string;
      sha256: string;
      size: number;
      mediaType: DshBridgeImage["mediaType"];
      name: string;
    };

export interface DshBridgeSessionState {
  sessionId: string;
  live: boolean;
  status: "idle" | "running";
  turn: number | null;
  cursor: number;
  queue: DshBridgeQueueItem[];
  streamText: string;
  streamTruncated: boolean;
  pending: number;
  /** A compaction runs outside any turn, while the agent counts as idle. */
  activity: "compacting" | null;
  /** The goal a change must name, while the session runs in this DSH. */
  goal: Pick<DshBridgeGoal, "id" | "revision" | "phase" | "activation"> | null;
}

export interface DshBridgeQuestion {
  id: string;
  question: string;
  header: string | null;
  detail: string | null;
  multiSelect: boolean;
  options: { label: string; description: string | null }[];
  intent:
    | { kind: "plan-review"; approve: string }
    | { kind: "approval"; approve: string; reject: string; always?: string }
    | null;
}

export type DshBridgeInteraction = {
  id: string;
  sessionId: string;
  createdAt: number;
} & (
  | {
      kind: "approval";
      toolName: string;
      callId: string | null;
      reason: string | null;
      displayReason: Record<string, string> | null;
      arguments: string | null;
    }
  | { kind: "question"; questions: DshBridgeQuestion[] }
);

/** Displayable history records; everything else in the DSH log stays in DSH. */
export type DshBridgeHistoryRecord = { seq: number; time: number | null } & (
  | { kind: "turn-start"; turn: number }
  | { kind: "turn-end"; turn: number; reason: string | null }
  | {
      kind: "user";
      id: string | null;
      text: string;
      truncated: boolean;
      images: DshBridgeImage[];
      files: number;
      rpcId: string | null;
    }
  | { kind: "assistant"; turn: number; text: string; truncated: boolean; interrupted: boolean }
  | { kind: "tool-call"; turn: number; callId: string; name: string }
  | {
      kind: "tool-result";
      turn: number;
      callId: string;
      isError: boolean;
      preview: string;
      truncated: boolean;
    }
  /** A slash command DSH ran itself, and its answer; `args` is what followed the name. */
  | { kind: "command"; commandId: string; name: string; args: string | null }
  | { kind: "command-result"; commandId: string; ok: boolean; text: string | null }
);

export interface DshBridgeHistoryPage {
  sessionId: string;
  cwd: string | null;
  createdAt: number | null;
  cursor: number;
  records: DshBridgeHistoryRecord[];
  nextBefore: number | null;
}

/**
 * A session's conversation for handoff and search: what the user and the model wrote, with tool
 * arguments and output, in log order. `current` says whether the record is on DSH's current model
 * surface and `position` where: a compaction takes what it summarized off the surface and puts its
 * summary in their place, ahead of any later message it left there.
 */
export type DshBridgeDocumentRecord = {
  seq: number;
  time: number | null;
  current: boolean;
  position: number | null;
} & (
  | { kind: "user"; text: string; truncated: boolean; images: DshBridgeImage[]; files: number }
  | {
      kind: "assistant";
      text: string;
      truncated: boolean;
      calls: { id: string; name: string; arguments: string; truncated: boolean }[];
      /** The message also had reasoning, which never leaves DSH. */
      reasoning: boolean;
    }
  | {
      kind: "tool-result";
      callId: string;
      isError: boolean;
      text: string;
      truncated: boolean;
      images: number;
    }
  /** DSH's summary of the history a compaction replaced. */
  | { kind: "summary"; text: string; truncated: boolean }
);

export interface DshBridgeDocumentPage {
  sessionId: string;
  /** The last sequence number the page was read up to; later pages stop there too. */
  revision: number | null;
  records: DshBridgeDocumentRecord[];
  /** Read on from after this sequence number; null at the end. */
  nextAfter: number | null;
}

export type DshBridgeCommand = { commandId: string } & (
  | { type: "history"; sessionId: string; before?: number; limit: number }
  /** One page of the session's conversation after `after`, read up to `through` when given. */
  | { type: "document"; sessionId: string; after?: number; through?: number }
  | { type: "verify"; sessionId: string; requestId: string }
  /**
   * A message. One that names a command of the session's agent runs as that command, as in DSH's
   * own window; the reply then carries `command` and the command's outcome. `fullAccess` says
   * whether the sending device may run commands that need it (`dsh-bridge-plugin/commands.js`).
   */
  | {
      type: "prompt";
      sessionId: string;
      requestId: string;
      mode: "queue" | "steer";
      content: DshBridgePromptPart[];
      fullAccess?: boolean;
    }
  /** One image the session's log references, as `{ mediaType, data }` with base64 data. */
  | { type: "image"; sessionId: string; attachmentId: string }
  | {
      type: "queue";
      sessionId: string;
      itemId: string;
      action: { kind: "remove" } | { kind: "steer" } | { kind: "edit"; text: string };
    }
  | { type: "cancel"; sessionId: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "archive"; sessionId: string; archived: boolean }
  | { type: "fork"; sessionId: string }
  /**
   * `sessionId` is the new session's ID, chosen by AgentKib so a lost reply can be settled.
   * Without `agentPreset` the session runs DSH's default preset.
   */
  | {
      type: "create";
      cwd: string;
      sessionId: string;
      agentPreset?: string;
      modelSelection?: { provider: string; model: string; reasoningEffort?: string };
    }
  /** `{ presets }`: DSH's Agent presets, in the order DSH lists them. */
  | { type: "presets" }
  | { type: "models"; sessionId?: string; recordedOnly?: boolean }
  | {
      type: "selectModel";
      sessionId: string;
      provider: string;
      model: string;
      reasoningEffort?: string;
    }
  | {
      type: "answer";
      interactionId: string;
      value:
        | { outcome: "allowed-once" | "rejected" }
        | { answers: { id: string; selected: string[]; custom?: string }[] };
    }
  | { type: "refresh" }
  /** `{ goal, live }`; a session that is not running is read without resuming it. */
  | { type: "goal"; sessionId: string }
  /** `set` creates a goal or edits the current one; the others need `goalId` and `goalRevision`. */
  | {
      type: "goal-control";
      sessionId: string;
      action: "set" | "pause" | "resume" | "clear";
      objective?: string;
      goalId?: string;
      goalRevision?: number;
    }
  /**
   * One slash command line, run by DSH's command registry as its own window runs it. The reply
   * is `{ matched, running, ok, text }`; a command still running after a few seconds goes on.
   */
  | { type: "command"; sessionId: string; requestId: string; line: string }
  /** `{ options, current }`: DSH's permission presets and the session's current one. */
  | { type: "permissions"; sessionId: string }
  /** `{ agents, truncated }`: the session's direct children, newest last. */
  | { type: "subagents"; sessionId: string }
);
