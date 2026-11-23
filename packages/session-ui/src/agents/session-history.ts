import { antigravityHistory } from "./antigravity/history";
import { claudeHistory } from "./claude-code/history";
import { codexHistory } from "./codex/history";

type SessionHistoryEntry = { references?: true; embeddedSearch?: true };

const entries = new Map<string, SessionHistoryEntry>([
  ["antigravity", antigravityHistory],
  ["claude-code", claudeHistory],
  ["codex", codexHistory],
]);

/** Client history entry points are independent of the provider's history read-state support. */
export function sessionHistoryEntry(agent: string | undefined): SessionHistoryEntry | undefined {
  return agent ? entries.get(agent) : undefined;
}
