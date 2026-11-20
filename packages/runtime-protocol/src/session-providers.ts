import type { ManagedAgent } from "./agents";

export const SESSION_RESOURCE_LIMIT = 10;

/**
 * Stable provider capabilities. A session's live capabilities and the device's grants still
 * determine what can be used now. Model lists and writable fields come from the provider's
 * runtime response.
 */
export interface SessionProviderCapabilities {
  history: { readState: boolean };
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

const PROVIDERS = {
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
      attachments: false,
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
} satisfies Record<ManagedAgent, SessionProviderCapabilities>;

export type SessionProviderAgent = keyof typeof PROVIDERS;
export type LiveSessionAgent = SessionProviderAgent | "antigravity";

export type ReadStateProvider = {
  [Agent in SessionProviderAgent]: (typeof PROVIDERS)[Agent]["history"]["readState"] extends true
    ? Agent
    : never;
}[SessionProviderAgent];

export function isSessionProviderAgent(agent: unknown): agent is SessionProviderAgent {
  return typeof agent === "string" && Object.hasOwn(PROVIDERS, agent);
}

/** The providers wired through the shared session registry. */
export function sessionProviderCapabilities(
  agent: unknown,
): SessionProviderCapabilities | undefined {
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
    ...(agent === "antigravity" ? { composer: { surface: "basic" } } : {}),
    history: { readState: false },
    operations: { execution: false },
  };
}

export function isReadStateProvider(agent: unknown): agent is ReadStateProvider {
  return sessionDetailCapabilities(agent).history.readState;
}
