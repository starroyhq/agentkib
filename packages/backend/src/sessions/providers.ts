import { sessionProviderCapabilities } from "@agentkib/runtime-protocol";
import {
  SessionProviderRegistry,
  type SessionProvider,
  type SessionProviders,
} from "../session-provider";

type LegacyProviders = {
  codexSessionProvider(): SessionProviders["codex"];
  claudeSessionProvider(): SessionProviders["claude-code"];
  devinSessionProvider(): SessionProviders["devin"];
  antigravitySessionProvider(): SessionProviders["antigravity"];
};

export function createSessionProviders(
  owner: LegacyProviders,
  dsh: SessionProviders["deepseek-harness"],
) {
  return new SessionProviderRegistry({
    codex: owner.codexSessionProvider(),
    "claude-code": owner.claudeSessionProvider(),
    "deepseek-harness": dsh,
    devin: owner.devinSessionProvider(),
    antigravity: owner.antigravitySessionProvider(),
  });
}

/** Keep the original options and settings shape on the legacy channels. */
export function withProviderCapabilities(
  provider: SessionProvider,
  value: unknown,
  creating = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-provider-response");
  const optionsValue = value as Record<string, unknown>;
  const declared = sessionProviderCapabilities(provider.agent)!;
  if (!creating) return { ...optionsValue, provider: declared };
  const { nativePlan, nativeGoals, ...options } = optionsValue;
  const { planMode, goal, goalBudget, workspaceResources, ...create } = declared.create;
  const available = optionsValue.available === true;
  const claudePlan =
    provider.agent === "claude-code" &&
    Array.isArray(optionsValue.permissionModes) &&
    optionsValue.permissionModes.some(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        "id" in item &&
        item.id === "plan",
    );
  return {
    ...options,
    provider: {
      ...declared,
      create: {
        ...create,
        ...(available && planMode && (nativePlan === true || claudePlan) ? { planMode } : {}),
        ...(available && workspaceResources ? { workspaceResources } : {}),
        ...(available && goal && (nativeGoals === true || claudePlan)
          ? { goal, ...(goalBudget ? { goalBudget } : {}) }
          : {}),
      },
    },
  };
}
