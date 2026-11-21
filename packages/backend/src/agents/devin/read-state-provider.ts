import { emptyReadState, type ReadStateProvider } from "../../sessions/read-state-provider";
import { devinSessionHome } from "./devin-sessions";

export const devinReadStateProvider: ReadStateProvider = {
  agent: "devin",
  home: ({ environment }) => devinSessionHome(environment),
  // A Devin session keeps its native ID and folder between observer polls.
  reuseTarget: true,
  ledgerOnly: (state) =>
    state.status === "unknown" && !state.latestResult && !state.firstUnread
      ? emptyReadState("agentkib")
      : state,
};
