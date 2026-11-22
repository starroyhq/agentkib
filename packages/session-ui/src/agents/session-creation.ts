import {
  MANAGED_AGENTS,
  sessionProviderCapabilities,
  type ManagedAgent,
  type ManagedOptions,
  type WebClient,
} from "@agentkib/web-client";
import type { InteractionLocale } from "../interaction-model";
import { dshCreation } from "./deepseek-harness/creation";
import { devinCreation } from "./devin/creation";

/** Hosts that predate other create providers default to this Agent when the field is absent. */
export const DEFAULT_NEW_SESSION_AGENT: ManagedAgent = "codex";

export const NEW_SESSION_AGENTS: readonly ManagedAgent[] = MANAGED_AGENTS.filter(
  (agent) => !!sessionProviderCapabilities(agent)?.create,
);

export const PROMPT_AT_CREATE_AGENTS: readonly ManagedAgent[] = NEW_SESSION_AGENTS.filter(
  (agent) => sessionProviderCapabilities(agent)?.create.mode === "with-first-message",
);

export function newSessionAgentOf(value: unknown): ManagedAgent | undefined {
  return NEW_SESSION_AGENTS.find((agent) => agent === value);
}

export type SessionCreationDescription = {
  preset?: {
    text(
      preset: NonNullable<ManagedOptions["agentPresets"]>[number],
      locale: string,
    ): { name: string; description: string | null };
    copy(locale: string): { broken: string };
  };
  terminalAction?(
    reason: string | undefined,
    locale: InteractionLocale,
  ):
    | {
        label: string;
        opened: string;
        failed: string;
        open(client: WebClient, workspaceId: string): Promise<{ terminal: string }>;
      }
    | undefined;
};

const descriptions: Partial<Record<ManagedAgent, SessionCreationDescription>> = {
  "deepseek-harness": dshCreation,
  devin: devinCreation,
};

export function sessionCreationDescription(agent: ManagedAgent) {
  return descriptions[agent];
}
