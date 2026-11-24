import type { NewSessionDraft } from "../../new-session-draft";
import { newSessionAgentOf } from "../../agents/session-creation";
import type { NewSessionAgent } from "../../new-session";

/**
 * The first message of a session started from the new-session composer. The composer creates the
 * session; the session's own composer sends this, so a message that cannot go out yet stays there
 * as its draft. Held in memory only, like any unsent draft.
 */
/** A first message goes out by itself only this soon after it was written. */
const SEND_WINDOW_MS = 60_000;
const drafts = new Map<string, { draft: NewSessionDraft; at: number; manual?: boolean }>();

export function offerNewSessionDraft(sessionId: string, draft: NewSessionDraft, now = Date.now()) {
  const offer = { draft, at: now };
  drafts.set(sessionId, offer);
  // If nobody took this offer, the creating composer can still keep the draft.
  return () => {
    if (drafts.get(sessionId) !== offer) return false;
    return drafts.delete(sessionId);
  };
}

/** Leaving the creating composer keeps its handoff available for manual sending. */
export function keepNewSessionDraftUnsent(sessionId: string) {
  const offer = drafts.get(sessionId);
  if (offer) offer.manual = true;
}

/**
 * The draft for this session, once: whoever takes it is the one that sends it. Opened much later,
 * the session gets it back as an unsent draft instead.
 */
export function takeNewSessionDraft(
  sessionId: string,
  now = Date.now(),
): (NewSessionDraft & { send: boolean }) | undefined {
  const offer = drafts.get(sessionId);
  drafts.delete(sessionId);
  return offer && { ...offer.draft, send: !offer.manual && now - offer.at < SEND_WINDOW_MS };
}

/** The workspace and Agent the last new session used, the composer's next default. */
export type NewSessionTarget = { workspaceId: string; agent: NewSessionAgent };

const TARGET_KEY = "agentkib.newSession.target";

export function readNewSessionTarget(): Partial<NewSessionTarget> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TARGET_KEY) ?? "null");
    if (!value || typeof value !== "object") return {};
    const { workspaceId, agent } = value as Record<string, unknown>;
    const supported = newSessionAgentOf(agent);
    return {
      ...(typeof workspaceId === "string" ? { workspaceId } : {}),
      ...(supported ? { agent: supported } : {}),
    };
  } catch {
    return {};
  }
}

export function rememberNewSessionTarget(target: NewSessionTarget) {
  try {
    localStorage.setItem(TARGET_KEY, JSON.stringify(target));
  } catch {
    // Without storage the composer falls back to the first workspace and Codex.
  }
}
