import { homedir } from "node:os";
import { observeReadHistory } from "../../read-state-history";
import type { ReadStateProvider } from "../../sessions/read-state-provider";
import { resolveClaudeConfig } from "./claude-config";

export const claudeReadStateProvider: ReadStateProvider = {
  agent: "claude-code",
  home: ({ environment }) => resolveClaudeConfig(environment, environment.HOME ?? homedir()).dir,
  managed: {
    priority: 0,
    resolve: (context, id) => context.claudeManagedTarget(id),
  },
  observeTranscript: (ledger, key, file) => observeReadHistory(ledger, key, "claude-code", file),
};
