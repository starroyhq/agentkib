import { emptyReadState, type ReadStateProvider } from "../../sessions/read-state-provider";
import { devinItemInTurn } from "./devin-managed-runner";
import { devinSessionHome } from "./devin-sessions";

export const devinReadStateProvider: ReadStateProvider = {
  agent: "devin",
  home: ({ environment }) => devinSessionHome(environment),
  // A Devin session keeps its native ID and folder between observer polls.
  reuseTarget: true,
  ledgerOnly(state) {
    if (state.status === "unknown" && !state.latestResult && !state.firstUnread)
      return emptyReadState("agentkib");
    const result = state.latestResult;
    if (result?.outcome === "completed" && !result.itemId && result.turnId)
      return { ...state, latestResult: { ...result, turnId: null } };
    return state;
  },
  async findLedgerReply({ sessions }, target, ledger, result) {
    if (result.outcome !== "completed" || result.itemId || !result.completedAt) return;
    const startedAt = Date.parse(ledger.resultStartedAt(target.key, result.id) ?? "");
    const endedAt = Date.parse(result.completedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt > endedAt) return;
    // The completion comes from ACP. Only the corresponding native history can supply its reply.
    const page = await sessions
      .eventsForNative("devin", target.nativeId, target.workspace, null, 100, undefined, false)
      .catch(() => null);
    if (!page || page.warnings.length) return;
    const inTurn = page.events.filter((event) =>
      devinItemInTurn(event.timestamp, startedAt, endedAt),
    );
    const prompts = inTurn.filter((event) => event.kind === "user-message");
    const replies = inTurn.filter(
      (event) => event.kind === "agent-message" && event.message_phase === "final_answer",
    );
    if (prompts.length !== 1 || replies.length !== 1) return;
    const prompt = prompts[0]!;
    const reply = replies[0]!;
    if (
      !prompt.turn_id ||
      (result.turnId && result.turnId !== prompt.turn_id) ||
      reply.turn_id !== prompt.turn_id ||
      !reply.content?.trim() ||
      Date.parse(prompt.timestamp ?? "") > Date.parse(reply.timestamp ?? "")
    )
      return;
    return { turnId: prompt.turn_id, itemId: reply.id };
  },
};
