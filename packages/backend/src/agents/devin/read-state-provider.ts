import { emptyReadState, type ReadStateProvider } from "../../sessions/read-state-provider";
import { devinSessionHome } from "./devin-sessions";

export const devinReadStateProvider: ReadStateProvider = {
  agent: "devin",
  home: ({ environment }) => devinSessionHome(environment),
  // A Devin session keeps its native ID and folder between observer polls.
  reuseTarget: true,
  ledgerOnly(state) {
    if (state.status === "unknown" && !state.latestResult && !state.firstUnread)
      return emptyReadState("agentkib");
    const { latestResult, firstUnread } = state;
    return {
      ...state,
      latestResult: latestResult ? { ...latestResult, turnId: null, itemId: null } : null,
      firstUnread: firstUnread?.type === "result" ? { ...firstUnread, turnId: null } : firstUnread,
    };
  },
  async verifyLedgerResult({ sessions }, target, ledger, result) {
    if (!result.completedAt) return;
    const startedAt = Date.parse(ledger.resultStartedAt(target.key, result.id) ?? "");
    const endedAt = Date.parse(result.completedAt);
    try {
      return await sessions.devinReadStateReply(
        target.nativeId,
        target.workspace,
        startedAt,
        endedAt,
      );
    } catch {
      // An unavailable native history cannot prove an automatic acknowledgment.
      return undefined;
    }
  },
};
