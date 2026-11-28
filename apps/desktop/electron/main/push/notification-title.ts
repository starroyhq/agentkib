import { knownAgentName } from "@agentkib/agent-identity/names";
import type { HomeSession } from "@agentkib/session-catalog";

const TITLE_LIMIT = 100;

export function notificationTitle(session: HomeSession, untitled = "Untitled session"): string {
  // A catalog title can be the first user message. Requiring matching naming evidence
  // also guards against a title-only catalog patch arriving before its metadata.
  const explicit =
    session.notificationTitle === session.title ? session.notificationTitle : undefined;
  const agent = knownAgentName(session.agent);
  const workspace = session.workspaceName?.trim();
  const title = explicit?.trim() || [agent, workspace].filter(Boolean).join(" · ") || untitled;
  const chars = [...(title.replace(/[\p{Cc}\s]+/gu, " ").trim() || untitled)];
  return chars.length > TITLE_LIMIT
    ? chars.slice(0, TITLE_LIMIT - 1).join("") + "…"
    : chars.join("");
}
