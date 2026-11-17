import type { ManagedAgent } from "./agents";

/**
 * Stable provider capabilities. A session's live capabilities and the device's grants still
 * determine what can be used now. Model lists and writable fields come from the provider's
 * runtime response.
 */
export interface SessionProviderCapabilities {
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
  };
  models: {
    selection: "independent" | "variants";
    modelDefault: boolean;
    effortDefault: boolean;
    clearEffort: boolean;
    fastTierIds: readonly string[];
    prepare?: boolean;
  };
  contextUsage: "live" | "last-request" | "unsupported";
}

const PROVIDERS = {
  codex: {
    create: {
      mode: "empty",
      catalogScope: "host",
      attachments: true,
      serviceTiers: true,
      modelPicker: true,
      permissionPicker: true,
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
    create: {
      mode: "empty",
      catalogScope: "workspace",
      attachments: true,
      serviceTiers: false,
      modelPicker: true,
      permissionPicker: true,
      verifyStartupModel: true,
    },
    models: {
      selection: "independent",
      modelDefault: true,
      effortDefault: true,
      clearEffort: true,
      fastTierIds: [],
      prepare: true,
    },
    contextUsage: "live",
  },
  "deepseek-harness": {
    create: {
      mode: "empty",
      catalogScope: "workspace",
      attachments: true,
      serviceTiers: false,
      modelPicker: true,
      permissionPicker: false,
      agentPresets: true,
    },
    models: {
      selection: "independent",
      modelDefault: true,
      effortDefault: true,
      clearEffort: false,
      fastTierIds: [],
    },
    contextUsage: "unsupported",
  },
  devin: {
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

export function isSessionProviderAgent(agent: unknown): agent is SessionProviderAgent {
  return typeof agent === "string" && Object.hasOwn(PROVIDERS, agent);
}

/** The providers wired through the shared session registry. */
export function sessionProviderCapabilities(
  agent: unknown,
): SessionProviderCapabilities | undefined {
  return isSessionProviderAgent(agent) ? PROVIDERS[agent] : undefined;
}
