import type { ManagedAgent } from "@agentkib/web-client";

/**
 * The first message of a session started from the new-session composer. The composer creates the
 * session; the session's own composer sends this, so a message that cannot go out yet stays there
 * as its draft. Held in memory only, like any unsent draft.
 */
export interface NewSessionDraft {
  text: string;
  files: File[];
}

/** A first message goes out by itself only this soon after it was written. */
const SEND_WINDOW_MS = 60_000;
const drafts = new Map<string, { draft: NewSessionDraft; at: number }>();

export function offerNewSessionDraft(sessionId: string, draft: NewSessionDraft, now = Date.now()) {
  drafts.set(sessionId, { draft, at: now });
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
  return offer && { ...offer.draft, send: now - offer.at < SEND_WINDOW_MS };
}

/** The workspace and Agent the last new session used, the composer's next default. */
export type NewSessionTarget = { workspaceId: string; agent: ManagedAgent };

const TARGET_KEY = "agentkib.newSession.target";

export function readNewSessionTarget(): Partial<NewSessionTarget> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(TARGET_KEY) ?? "null");
    if (!value || typeof value !== "object") return {};
    const { workspaceId, agent } = value as Record<string, unknown>;
    return {
      ...(typeof workspaceId === "string" ? { workspaceId } : {}),
      ...(agent === "codex" || agent === "claude-code" || agent === "deepseek-harness"
        ? { agent }
        : {}),
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
