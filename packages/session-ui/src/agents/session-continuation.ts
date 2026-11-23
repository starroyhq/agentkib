import {
  sessionProviderDeclaration,
  type SessionProviderDeclaration,
  type SessionResumeCommand,
  type WebClient,
} from "@agentkib/web-client";
import { claudeContinuation } from "./claude-code/continuation";
import { codexContinuation } from "./codex/continuation";

type ConnectionKind = NonNullable<SessionProviderDeclaration["connection"]>["kind"];

export interface SessionContinuationRegistration {
  busyActor: string;
  refreshOccupancy: boolean;
  forkEntry: boolean;
  loadResumeCommand?: (
    client: WebClient,
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<SessionResumeCommand>;
}

const continuations: Partial<Record<ConnectionKind, SessionContinuationRegistration>> = {
  "native-app": codexContinuation,
  "terminal-bridge": claudeContinuation,
};

export function sessionContinuationRegistration(agent: string | undefined) {
  const kind = sessionProviderDeclaration(agent)?.connection?.kind;
  return kind ? continuations[kind] : undefined;
}
