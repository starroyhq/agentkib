import { sessionProviderCapabilities, type LiveSessionAgent } from "@agentkib/runtime-protocol";
import type { AntigravitySessionProvider } from "../agents/antigravity/session-provider";
import type { CodexSessionProvider } from "../agents/codex/session-provider";
import type { DevinSessionProvider } from "../agents/devin/session-provider";
import { createAntigravityHistoryReader } from "../agents/antigravity/history-reader";
import { claudeHandoffProvider } from "../agents/claude/handoff-provider";
import { createClaudeHistoryReader } from "../agents/claude/history-reader";
import { claudeReadStateProvider } from "../agents/claude/read-state-provider";
import { codexHandoffProvider } from "../agents/codex/handoff-provider";
import { createCodexHistoryReader } from "../agents/codex/history-reader";
import { codexReadStateProvider } from "../agents/codex/read-state-provider";
import { devinHandoffProvider } from "../agents/devin/handoff-provider";
import { createDevinHistoryReader } from "../agents/devin/history-reader";
import { devinReadStateProvider } from "../agents/devin/read-state-provider";
import { dshHandoffProvider } from "../agents/dsh/handoff-provider";
import { createDshHistoryReader } from "../agents/dsh/history-reader";
import {
  SessionProviderRegistry,
  type SessionProvider,
  type SessionProviders,
} from "../session-provider";
import type { HandoffProvider } from "./handoff-provider";
import type { SessionHistoryContext, SessionHistoryProvider } from "./history-provider";
import type { ReadStateProvider } from "./read-state-provider";

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

type CatalogProviders = {
  codex: Pick<CodexSessionProvider, "catalogContinuation">;
  devin: Pick<DevinSessionProvider, "continuation">;
  antigravity: Pick<AntigravitySessionProvider, "continuation">;
  codexRuntime: ReturnType<CodexSessionProvider["catalogRuntime"]>;
  codexExternalTurns: Awaited<ReturnType<CodexSessionProvider["externalTurnsBySession"]>>;
};

type SessionProviderReader = {
  catalog?<Session extends { id: string }>(session: Session, providers: CatalogProviders): Session;
  history(context: SessionHistoryContext): SessionHistoryProvider;
  readState?: ReadStateProvider;
  handoff?: HandoffProvider;
};

// These readers are available to the index and handoff workers without a live executor.
const providerReaders: Readonly<Record<LiveSessionAgent, SessionProviderReader>> = {
  codex: {
    catalog: (session, { codex, codexRuntime, codexExternalTurns }) =>
      codex.catalogContinuation(session, codexRuntime, codexExternalTurns),
    history: createCodexHistoryReader,
    readState: codexReadStateProvider,
    handoff: codexHandoffProvider,
  },
  "claude-code": {
    history: createClaudeHistoryReader,
    readState: claudeReadStateProvider,
    handoff: claudeHandoffProvider,
  },
  "deepseek-harness": { history: createDshHistoryReader, handoff: dshHandoffProvider },
  devin: {
    catalog: (session, { devin }) => devin.continuation(session),
    history: createDevinHistoryReader,
    readState: devinReadStateProvider,
    handoff: devinHandoffProvider,
  },
  antigravity: {
    catalog: (session, { antigravity }) => antigravity.continuation(session),
    history: createAntigravityHistoryReader,
  },
};

export function getSessionProviderReader(agent: string): SessionProviderReader | undefined {
  return Object.hasOwn(providerReaders, agent)
    ? providerReaders[agent as LiveSessionAgent]
    : undefined;
}

export function sessionProviderReaders(): readonly SessionProviderReader[] {
  return Object.values(providerReaders);
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
