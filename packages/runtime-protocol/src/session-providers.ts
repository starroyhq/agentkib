import type { ManagedAgent } from "./agents";
import type { SubagentStatus } from "./subagents";

export const SESSION_RESOURCE_LIMIT = 10;

export type SessionQueueAction =
  | "list"
  | "add"
  | "update"
  | "delete"
  | "reorder"
  | "start"
  | "pause"
  | "resume"
  | "steer";

export interface SessionExecution {
  owner: "agentkib" | "terminal" | "native-app" | "external" | null;
  observed: boolean;
  confidence: "live" | "inferred" | "unknown";
}

export interface SessionFeedback {
  code: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export type SessionApprovalKind =
  | "command"
  | "files"
  | "network"
  | "permissions"
  | "tool"
  | "mcp"
  | "unknown";

export interface SessionActionAvailability {
  available: boolean;
  reason?: string;
}

export type SessionQueueItemActions = Partial<
  Record<"update" | "delete" | "steer", SessionActionAvailability>
>;

export interface SessionCommandEntry {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: readonly string[];
  /** A client command names an existing resolver, which can use the arguments to choose an action. */
  run: { kind: "native" } | { kind: "client"; command: string };
}

export type SessionCommandMenu =
  | { state: "unverified" }
  | { state: "ready"; entries: readonly SessionCommandEntry[] };

export type SessionActivityKind = "background-task" | "subagent" | "terminal";

export interface SessionActivity {
  /** Opaque identity scoped to the parent session. */
  id: string;
  kind: SessionActivityKind;
  title: string;
  status: SubagentStatus;
  startedAt?: string | null;
  endedAt?: string | null;
  /** A readable subagent's ID in this parent's subagents API. */
  childId?: string;
  actions?: { stop?: SessionActionAvailability };
}

export interface SessionActivityCapabilities {
  kinds: readonly SessionActivityKind[];
  canStopIndividually: boolean;
  canOpenSubagentHistory: boolean;
}

export interface SessionProjectAgentCapabilities {
  readonly lead: boolean;
  readonly worker: boolean;
}

interface SessionProviderIntegrationCapabilities {
  commands?: { source: "built-in" | "reported" | "none" };
  queue?: { actions: readonly SessionQueueAction[] };
  projectAgent?: SessionProjectAgentCapabilities;
  /** A locally managed turn may be resumed after an explicit desktop quit. */
  resumeAfterQuit?: boolean;
  /** The provider's native integration, even when no session is connected to it. */
  connection?: { kind: "native-app" | "terminal-bridge" | "plugin-bridge" | "acp" };
  permissionField?: "policyId" | "permissionMode";
  /** Catalog organization goes to the provider when native support has been verified. */
  pinning?: "native" | "native-with-local-fallback";
  activities?: SessionActivityCapabilities & {
    /** Activity kinds a connected terminal can observe independently of the managed runner. */
    terminal?: SessionActivityCapabilities;
  };
}

/**
 * Stable provider capabilities. A session's live capabilities and the device's grants still
 * determine what can be used now. Model lists and writable fields come from the provider's
 * runtime response.
 */
export interface SessionProviderCapabilities extends SessionProviderIntegrationCapabilities {
  history: {
    readState: boolean;
    /** Native history can supply read-only question cards. */
    questionnaire?: true;
  };
  operations: { execution: boolean };
  /** Stable session toolbar slots; live grants determine whether each action can run. */
  composer?: {
    modelPicker: boolean;
    permissionPicker: boolean;
    attachments: boolean;
    workspaceResources: boolean;
    plan: boolean;
    goal: boolean;
  };
  create: {
    mode: "empty" | "with-first-message";
    catalogScope: "host" | "workspace";
    attachments: boolean;
    serviceTiers: boolean;
    /** Fixed toolbar slots. The host supplies the choices and grants separately. */
    modelPicker?: boolean;
    permissionPicker?: boolean;
    agentPresets?: boolean;
    verifyStartupModel?: boolean;
    planMode?: "mode" | "permissionMode";
    workspaceResources?: boolean;
    goal?: boolean;
    goalBudget?: "rounds";
  };
  models: {
    selection: "independent" | "variants";
    modelDefault: boolean;
    effortDefault: boolean;
    clearEffort: boolean;
    fastTierIds: readonly string[];
    prepare?: boolean;
    nativePicker?: boolean;
  };
  contextUsage: "live" | "last-request" | "unsupported";
}

export interface BasicSessionProviderCapabilities extends SessionProviderIntegrationCapabilities {
  composer: { surface: "basic" };
  history: SessionProviderCapabilities["history"] & { readState: false };
  operations: { execution: false };
  contextUsage: SessionProviderCapabilities["contextUsage"];
  controls: readonly ("send" | "stop" | "approve")[];
}

// The legacy options and settings responses serialize this declaration verbatim.
const MANAGED_CAPABILITIES = {
  codex: {
    history: { readState: true },
    operations: { execution: true },
    composer: {
      modelPicker: true,
      permissionPicker: true,
      attachments: true,
      workspaceResources: true,
      plan: true,
      goal: true,
    },
    create: {
      mode: "empty",
      catalogScope: "host",
      attachments: true,
      serviceTiers: true,
      modelPicker: true,
      permissionPicker: true,
      planMode: "mode",
      workspaceResources: true,
      goal: true,
    },
    models: {
      selection: "independent",
      modelDefault: false,
      effortDefault: false,
      clearEffort: false,
      fastTierIds: ["fast", "priority"],
    },
    contextUsage: "live",
  },
  "claude-code": {
    history: { readState: true },
    operations: { execution: true },
    composer: {
      modelPicker: true,
      permissionPicker: true,
      attachments: true,
      workspaceResources: true,
      plan: true,
      goal: true,
    },
    create: {
      mode: "empty",
      catalogScope: "workspace",
      attachments: true,
      serviceTiers: false,
      modelPicker: true,
      permissionPicker: true,
      verifyStartupModel: true,
      planMode: "permissionMode",
      workspaceResources: true,
      goal: true,
    },
    models: {
      selection: "independent",
      modelDefault: true,
      effortDefault: true,
      clearEffort: true,
      fastTierIds: [],
      prepare: true,
      nativePicker: true,
    },
    contextUsage: "live",
  },
  "deepseek-harness": {
    history: { readState: false },
    operations: { execution: true },
    composer: {
      modelPicker: true,
      permissionPicker: true,
      attachments: true,
      workspaceResources: true,
      plan: true,
      goal: true,
    },
    create: {
      mode: "empty",
      catalogScope: "workspace",
      attachments: true,
      serviceTiers: false,
      modelPicker: true,
      permissionPicker: false,
      agentPresets: true,
      goal: true,
      goalBudget: "rounds",
    },
    models: {
      selection: "independent",
      modelDefault: true,
      effortDefault: true,
      clearEffort: false,
      fastTierIds: [],
    },
    contextUsage: "live",
  },
  devin: {
    history: { readState: true },
    operations: { execution: false },
    composer: {
      modelPicker: true,
      permissionPicker: true,
      attachments: true,
      workspaceResources: true,
      plan: false,
      goal: false,
    },
    create: {
      mode: "with-first-message",
      catalogScope: "workspace",
      attachments: false,
      serviceTiers: true,
      modelPicker: true,
      permissionPicker: true,
    },
    models: {
      selection: "variants",
      modelDefault: true,
      effortDefault: true,
      clearEffort: false,
      fastTierIds: ["fast", "priority", "lightning"],
    },
    contextUsage: "last-request",
  },
  // Antigravity CLI's `agy acp` (1.5.14): a session's model, thought level and mode are its own
  // ACP options; a new session starts with its first message.
  antigravity: {
    history: { readState: false },
    operations: { execution: false },
    composer: {
      modelPicker: true,
      permissionPicker: true,
      attachments: true,
      workspaceResources: false,
      plan: false,
      goal: false,
    },
    create: {
      mode: "with-first-message",
      catalogScope: "workspace",
      attachments: false,
      serviceTiers: false,
      modelPicker: true,
      permissionPicker: true,
    },
    models: {
      selection: "independent",
      modelDefault: true,
      effortDefault: true,
      clearEffort: false,
      fastTierIds: [],
    },
    contextUsage: "live",
  },
} satisfies Record<ManagedAgent, SessionProviderCapabilities>;

const PROVIDERS = {
  codex: {
    ...MANAGED_CAPABILITIES.codex,
    resumeAfterQuit: true,
    history: { ...MANAGED_CAPABILITIES.codex.history, questionnaire: true },
    commands: { source: "built-in" },
    projectAgent: { lead: true, worker: true },
    queue: { actions: ["list", "add", "update", "delete", "reorder", "start"] },
    connection: { kind: "native-app" },
    pinning: "native-with-local-fallback",
    permissionField: "policyId",
    activities: {
      kinds: ["subagent"],
      canStopIndividually: false,
      canOpenSubagentHistory: true,
    },
  },
  "claude-code": {
    ...MANAGED_CAPABILITIES["claude-code"],
    resumeAfterQuit: true,
    history: { ...MANAGED_CAPABILITIES["claude-code"].history, questionnaire: true },
    commands: { source: "reported" },
    projectAgent: { lead: true, worker: true },
    queue: { actions: ["list", "add", "update", "delete", "reorder", "pause", "resume"] },
    connection: { kind: "terminal-bridge" },
    permissionField: "permissionMode",
    activities: {
      kinds: ["background-task", "subagent"],
      canStopIndividually: false,
      canOpenSubagentHistory: true,
      // The Mods getter lists retained subagents. Shell and Monitor tasks lack a complete API.
      terminal: {
        kinds: ["subagent"],
        canStopIndividually: false,
        canOpenSubagentHistory: false,
      },
    },
  },
  "deepseek-harness": {
    ...MANAGED_CAPABILITIES["deepseek-harness"],
    resumeAfterQuit: true,
    history: { ...MANAGED_CAPABILITIES["deepseek-harness"].history, questionnaire: true },
    commands: { source: "reported" },
    projectAgent: { lead: true, worker: true },
    queue: { actions: ["list", "add", "update", "delete", "steer"] },
    connection: { kind: "plugin-bridge" },
    pinning: "native",
    permissionField: "policyId",
    activities: { kinds: ["subagent"], canStopIndividually: false, canOpenSubagentHistory: true },
  },
  devin: {
    ...MANAGED_CAPABILITIES.devin,
    commands: { source: "none" },
    projectAgent: { lead: true, worker: true },
    queue: { actions: ["list", "add", "update", "delete", "pause", "resume"] },
    permissionField: "permissionMode",
    activities: { kinds: ["subagent"], canStopIndividually: false, canOpenSubagentHistory: true },
  },
  antigravity: {
    ...MANAGED_CAPABILITIES.antigravity,
    commands: { source: "none" },
    projectAgent: { lead: true, worker: true },
    queue: { actions: ["list", "add", "update", "delete", "pause", "resume"] },
    connection: { kind: "acp" },
    permissionField: "permissionMode",
    activities: { kinds: [], canStopIndividually: false, canOpenSubagentHistory: false },
  },
} satisfies Record<ManagedAgent, SessionProviderCapabilities>;

export type SessionProviderAgent = keyof typeof MANAGED_CAPABILITIES;
export type LiveSessionAgent = keyof typeof PROVIDERS;
export type SessionProviderDeclaration =
  | SessionProviderCapabilities
  | BasicSessionProviderCapabilities;

export type ReadStateProvider = {
  [Agent in SessionProviderAgent]: (typeof PROVIDERS)[Agent]["history"]["readState"] extends true
    ? Agent
    : never;
}[SessionProviderAgent];

export function isSessionProviderAgent(agent: unknown): agent is SessionProviderAgent {
  return typeof agent === "string" && Object.hasOwn(MANAGED_CAPABILITIES, agent);
}

/** The providers wired through the shared session registry. */
export function sessionProviderCapabilities(
  agent: unknown,
): SessionProviderCapabilities | undefined {
  return isSessionProviderAgent(agent) ? MANAGED_CAPABILITIES[agent] : undefined;
}

/** Includes the basic provider and integration capabilities for the typed session API. */
export function sessionProviderDeclaration(agent: unknown): SessionProviderDeclaration | undefined {
  if (agent === "antigravity") return PROVIDERS.antigravity;
  return isSessionProviderAgent(agent) ? PROVIDERS[agent] : undefined;
}

export function sessionDetailCapabilities(agent: unknown): {
  composer?: { surface: "managed" | "basic" };
  history: SessionProviderCapabilities["history"];
  operations: { execution: boolean };
} {
  const provider = sessionProviderCapabilities(agent);
  if (provider)
    return {
      composer: { surface: "managed" },
      history: provider.history,
      operations: provider.operations,
    };
  return {
    history: { readState: false },
    operations: { execution: false },
  };
}

export function isReadStateProvider(agent: unknown): agent is ReadStateProvider {
  return sessionDetailCapabilities(agent).history.readState;
}
