/** Private local transport between a DeepSeek Harness plugin and the Runtime. Never crosses Web RPC. */
import { DSH_BRIDGE_COMPATIBILITY } from "../../dsh-bridge-plugin/compatibility.js";
export {
  DSH_BRIDGE_COMPATIBILITY,
  dshBridgeCompatibility,
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

export interface DshBridgeServices {
  sessionController: boolean;
  sessionQuery: boolean;
  approvals: boolean;
  questions: boolean;
  /** Archive and unarchive. Plugins older than 0.2.0 do not report it. */
  workspaceController?: boolean;
  /** Model catalog and per-session model selection. Plugins older than 0.2.0 do not report it. */
  modelCatalog?: boolean;
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
  rpcId: string | null;
}

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
      images: number;
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
);

export interface DshBridgeHistoryPage {
  sessionId: string;
  cwd: string | null;
  createdAt: number | null;
  cursor: number;
  records: DshBridgeHistoryRecord[];
  nextBefore: number | null;
}

export type DshBridgeCommand = { commandId: string } & (
  | { type: "history"; sessionId: string; before?: number; limit: number }
  | { type: "verify"; sessionId: string; requestId: string }
  | { type: "prompt"; sessionId: string; requestId: string; mode: "queue" | "steer"; text: string }
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
  /** `sessionId` is the new session's ID, chosen by AgentKib so a lost reply can be settled. */
  | { type: "create"; cwd: string; sessionId: string }
  | { type: "models"; sessionId: string }
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
);
